import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DurableTaskStore } from "../../src/core/store.js";
import { Coordinator } from "../../src/daemon/coordinator.js";
import { git } from "../../src/daemon/workspace.js";
import { presentMcpResult } from "../../src/shared/presentation.js";
import { advanceWorkSchema } from "../../src/shared/work-contract.js";
import type {
  OpenSessionInput,
  RuntimeConnection,
  RuntimeInfo,
  RuntimeEvent,
  SessionRef,
  SessionSnapshot,
  TurnInput,
  TurnRef,
} from "../../src/runtime/types.js";

class Executor implements RuntimeConnection {
  readonly info: RuntimeInfo = {
    adapterId: "fixture",
    version: "3.16.3",
    protocolVersion: 1,
    authRequired: false,
    authenticated: true,
    supported: true,
  };
  private command = "";
  private text = "";
  private workspace = "";
  private state = "completedSuccess";
  private at = 1;
  private release?: () => void;
  constructor(
    private readonly action: (
      session: SessionRef,
      input: TurnInput,
    ) => Promise<"busy" | "success" | "running">,
    private readonly fresh: (snapshot: SessionSnapshot) => void = () => {},
  ) {}
  async openSession(input: OpenSessionInput) {
    return {
      sessionId: input.sessionId ?? "session_zcode_pool_v1_fixture",
      workspacePath: input.workspacePath,
    };
  }
  async sendTurn(session: SessionRef, input: TurnInput) {
    this.command = input.requestId!;
    this.workspace = session.workspacePath;
    this.at = Date.now();
    const outcome = await this.action(session, input);
    this.state =
      outcome === "busy"
        ? "failed"
        : outcome === "running"
          ? "running"
          : "completedSuccess";
    this.text =
      this.state === "completedSuccess"
        ? "Saved implementation and checks"
        : "";
    return { ...session, turnId: this.command, commandId: this.command };
  }
  async syncHistory(session: SessionRef): Promise<SessionSnapshot> {
    const header = {
      kind: "turnHeader",
      rowId: 1,
      turnId: "native-turn",
      sourceCommandId: this.command,
      state: this.state,
      startedAt: this.at,
      endedAt: this.at + 1,
    };
    return {
      ...session,
      phase: this.state,
      revision: 1,
      cursor: "3",
      summary: this.text,
      pendingApprovals: [],
      modelSelection: {
        providerId: "account:zai-start-plan",
        modelId: "GLM-5.3-Flash",
      },
      raw: {
        sessionId: session.sessionId,
        queue: { items: [] },
        pendingCommands: [],
        backgroundWorks: [],
        control: {
          activeWorks:
            this.state === "running"
              ? [{ sourceCommandId: this.command, turnId: "native-turn" }]
              : [],
          ...(this.state === "failed"
            ? { lastError: { at: this.at + 1, message: "model is busy" } }
            : {}),
        },
        rows: {
          window: [
            header,
            ...(this.text
              ? [
                  {
                    kind: "assistantText",
                    rowId: 2,
                    turnId: "native-turn",
                    text: this.text,
                  },
                ]
              : []),
          ],
        },
      },
    };
  }
  async freshReadSession(session: SessionRef) {
    const snapshot = await this.syncHistory(session);
    if (this.state === "running")
      (snapshot.raw.control as any).activeWorks = [
        { sourceCommandId: this.command, turnId: "native-turn" },
      ];
    this.fresh(snapshot);
    return snapshot;
  }
  async *events(session: SessionRef): AsyncIterable<RuntimeEvent> {
    const event = (
      type: RuntimeEvent["type"],
      data: Record<string, unknown> = {},
    ): RuntimeEvent => ({
      id: `${this.command}:${type}`,
      cursor: "1",
      type,
      sessionId: session.sessionId,
      turnId: this.command,
      timestamp: Date.now(),
      data,
    });
    yield event("turn_started");
    if (this.state === "running") {
      await new Promise<void>((r) => {
        this.release = r;
      });
      if (this.state === "running") return;
    }
    if (this.text) yield event("assistant_message", { text: this.text });
    if (this.state === "failed") {
      yield event("error", {
        category: "model_busy",
        errorAttribution: "turn",
        busyRetryEligible: true,
        message: "model is busy",
      });
      yield event("turn_failed", {
        category: "model_busy",
        errorAttribution: "turn",
        busyRetryEligible: true,
      });
    } else yield event("turn_completed");
  }
  finish(): void {
    this.state = "completedSuccess";
    this.text = "Saved implementation and checks";
    this.release?.();
  }
  async queryCommand(): Promise<"unknown"> {
    return "unknown";
  }
  async quota() {
    return {};
  }
  async respondApproval() {}
  async cancel() {}
  async close() {
    this.release?.();
  }
}
async function until(predicate: () => boolean, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Work fixture did not settle");
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function fixture(t: TestContext, accountCount = 1) {
  const root = await mkdtemp(join(tmpdir(), "zcode-work-")),
    repo = join(root, "project");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "code.txt"), "baseline\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
  const store = new DurableTaskStore(
    join(root, "pool", "scheduler", "state.db"),
  );
  store.setPoolPolicy({ defaultCommanderQuota: 1 });
  const coordinator = new Coordinator(join(root, "pool"), store);
  const accounts = Array.from({ length: accountCount }, (_, i) => ({
    alias: `account-${i}`,
    provider: "zai" as const,
    health: "available" as const,
    authMode: "oauth" as const,
  }));
  const workers = accounts.map((a) => ({
    workerId: `worker-${a.alias}`,
    accountAlias: a.alias,
    state: "ready",
    endpoint: { baseUrl: `http://${a.alias}` },
  }));
  let fresh = (snapshot: SessionSnapshot) => {};
  let sends = 0;
  let action = async (
    session: SessionRef,
    input: TurnInput,
  ): Promise<"busy" | "success" | "running"> => {
    if (input.prompt.includes("fixed acceptance"))
      assert.equal(
        await readFile(join(session.workspacePath, "code.txt"), "utf8"),
        "implemented\n",
      );
    else if (input.prompt.includes("implement code"))
      await writeFile(join(session.workspacePath, "code.txt"), "implemented\n");
    return "success";
  };
  Object.defineProperty(coordinator.vault, "list", {
    value: async () => accounts,
  });
  Object.defineProperty(coordinator.vault, "load", {
    value: async (alias: string) => ({
      ...accounts.find((a) => a.alias === alias),
      provider: "zai",
      health: "available",
    }),
  });
  Object.defineProperty(coordinator.supervisor, "list", {
    value: async () => workers,
  });
  Object.defineProperty(coordinator.supervisor, "status", {
    value: async (id: string) => workers.find((w) => w.workerId === id),
  });
  let quota: Record<string, unknown> = {
    authenticated: true,
    remaining: { count: 100, percentage: 1 },
  };
  Object.defineProperty(coordinator, "probeAccount", {
    value: async () => ({ providerId: "account:zai-start-plan", quota }),
  });
  const executors: Executor[] = [];
  const createExecutor = () => {
    const executor = new Executor(
      (s, i) => {
        sends++;
        return action(s, i);
      },
      (s) => fresh(s),
    );
    executors.push(executor);
    return executor;
  };
  let connect: () => Promise<RuntimeConnection> = async () => createExecutor();
  Object.defineProperty(coordinator.adapter, "connect", {
    value: () => connect(),
  });
  t.after(async () => {
    await coordinator.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const submit = async (extra: Record<string, unknown> = {}) =>
    (await coordinator.call("submit_work", {
      request_id: "submit",
      commander_id: "commander",
      repository: repo,
      goal: "Deliver the code change",
      criteria: ["code is implemented"],
      stages: [
        { stageId: "build", title: "Build", criteria: ["code is implemented"] },
      ],
      items: [
        {
          itemId: "implementation",
          stageId: "build",
          title: "Implement",
          prompt: "implement code",
        },
      ],
      ...extra,
    })) as any;
  const advance = async (
    workId: string,
    requestId: string,
    extra: Record<string, unknown> = {},
  ) =>
    coordinator.call("advance_work", {
      request_id: requestId,
      work_id: workId,
      commander_id: store.work.get(workId).commanderId,
      control_version: store.work.get(workId).controlVersion,
      ...extra,
    }) as Promise<any>;
  return {
    root,
    repo,
    store,
    coordinator,
    submit,
    advance,
    accounts,
    createExecutor,
    executors,
    setConnect: (next: typeof connect) => {
      connect = next;
    },
    setQuota: (next: typeof quota) => {
      quota = next;
    },
    setAction: (next: typeof action) => {
      action = next;
    },
    setFresh: (next: typeof fresh) => {
      fresh = next;
    },
    get sends() {
      return sends;
    },
    async delivered(workId: string, count = 1) {
      await until(() => store.work.get(workId).deliveries.length >= count);
      return store.work.get(workId);
    },
  };
}

test("real git work closes through a fixed acceptance copy and preserves the dirty user index and branch", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "code.txt"), "staged user content\n");
  await git(f.repo, ["add", "code.txt"]);
  await writeFile(join(f.repo, "code.txt"), "unstaged user content\n");
  await writeFile(join(f.repo, "notes.txt"), "user notes\n");
  const index = await git(f.repo, ["write-tree"]),
    branch = await git(f.repo, ["symbolic-ref", "HEAD"]);
  const submitted = await f.submit();
  const workId = submitted.work.workId;
  const delivered = await f.delivered(workId);
  assert.equal(delivered.stages[0].confirmation, null);
  assert.equal(f.store.getPoolPolicy().occupiedSlots, 0);
  const delivery = delivered.deliveries[0];
  assert.equal(await git(f.repo, ["write-tree"]), index);
  assert.equal(await git(f.repo, ["symbolic-ref", "HEAD"]), branch);
  assert.equal(
    await readFile(join(f.repo, "code.txt"), "utf8"),
    "unstaged user content\n",
  );
  const source = f.store.getWorkspace(delivery.workspaceId);
  await writeFile(
    join(source.worktreePath, "code.txt"),
    "later unrelated implementation\n",
  );
  const external = await f.advance(workId, "external-start", {
    start_acceptance: [
      {
        acceptance_id: "external",
        delivery_id: delivery.deliveryId,
        executor: "external",
        name: "Independent reviewer",
      },
    ],
  });
  const copy = external.work.acceptances.find(
    (a: any) => a.acceptanceId === "external",
  );
  assert.equal(
    await readFile(join(copy.workspacePath, "code.txt"), "utf8"),
    "implemented\n",
  );
  assert.equal(f.store.getPoolPolicy().occupiedSlots, 0);
  await f.advance(workId, "accept-start", {
    start_acceptance: [
      {
        acceptance_id: "acceptance",
        delivery_id: delivery.deliveryId,
        executor: "zcode",
        name: "original account",
        item: {
          itemId: "review",
          stageId: "build",
          title: "Review",
          prompt: "fixed acceptance",
        },
      },
    ],
  });
  await f.delivered(workId, 2);
  await assert.rejects(
    f.advance(workId, "premature", {
      confirm_stages: [
        {
          stage_id: "build",
          summary: "done",
          delivery_ids: [delivery.deliveryId],
          acceptance_ids: ["acceptance"],
        },
      ],
    }),
    /unfinished or failed|must pass/,
  );
  const integrated = await f.advance(workId, "integrate", {
    acceptance_results: [
      {
        acceptance_id: "acceptance",
        status: "passed",
        summary: "Fixed copy passed",
        evidence: ["Read saved bytes"],
      },
      {
        acceptance_id: "external",
        status: "passed",
        summary: "Independent fixed copy passed",
        evidence: ["Saved bytes match"],
      },
    ],
    confirm_stages: [
      {
        stage_id: "build",
        summary: "Build accepted",
        delivery_ids: [delivery.deliveryId],
        acceptance_ids: ["acceptance", "external"],
      },
    ],
    integrate_delivery_ids: [delivery.deliveryId],
  });
  assert.equal(
    await readFile(join(f.repo, "code.txt"), "utf8"),
    "implemented\n",
  );
  assert.equal(
    await readFile(join(f.repo, "notes.txt"), "utf8"),
    "user notes\n",
  );
  assert.equal(await git(f.repo, ["write-tree"]), index);
  assert.equal(await git(f.repo, ["symbolic-ref", "HEAD"]), branch);
  const finished = await f.advance(workId, "complete", {
    final_acceptance: {
      revision: integrated.work.integrationRevision,
      summary: "Checked actual project",
      evidence: ["code.txt and notes.txt checked"],
    },
    complete: true,
  });
  assert.equal(finished.work.status, "completed");
  await until(
    () => f.store.getWorkspace(delivery.workspaceId).state === "merged",
  );
  await assert.rejects(readFile(join(source.worktreePath, "code.txt")), {
    code: "ENOENT",
  });
  await git(f.repo, ["gc", "--prune=now"]);
  assert.equal(
    (await git(f.repo, ["cat-file", "-t", source.baseCommit])).trim(),
    "commit",
  );
  const unchanged = await f.coordinator.call("wait_work", {
    work_id: workId,
    commander_id: "commander",
    after_revision: finished.work.revision,
    timeout_sec: 0,
  });
  const text = presentMcpResult("wait_work", unchanged).text;
  assert.ok(Buffer.byteLength(text) < 250);
  t.diagnostic(
    `MCP bytes: submit=${Buffer.byteLength(presentMcpResult("submit_work", submitted).text)}, unchanged=${Buffer.byteLength(text)}, advance=${Buffer.byteLength(presentMcpResult("advance_work", finished).text)}`,
  );
});

test("zero resources and partial resource use are explicit decisions; takeover rejects the old commander", async (t) => {
  const f = await fixture(t, 0);
  const submitted = await f.submit({ accounts: 2 });
  const id = submitted.work.workId;
  await until(() =>
    f.store.work.get(id).todos.some((t) => t.kind === "resource_shortage"),
  );
  assert.equal(f.store.listTasks().length, 0);
  assert.equal(f.store.work.get(id).todos[0].availableAccounts, 0);
  const f2 = await fixture(t, 1);
  const second = await f2.submit({ accounts: 2 });
  const workId = second.work.workId;
  await until(() =>
    f2.store.work.get(workId).todos.some((t) => t.kind === "resource_shortage"),
  );
  assert.equal(f2.store.listTasks().length, 0);
  await assert.rejects(
    f2.advance(workId, "no-user", { allow_partial_accounts: 1 }),
    /user confirmation/,
  );
  await f2.advance(workId, "partial", {
    allow_partial_accounts: 1,
    user_confirmed_partial: true,
  });
  await f2.delivered(workId);
  await f2.advance(workId, "takeover", {
    commander_id: "new-commander",
    takeover: true,
    user_requested_takeover: true,
  });
  await assert.rejects(
    f2.coordinator.call("advance_work", {
      request_id: "old-owner",
      work_id: workId,
      commander_id: "commander",
      control_version: 1,
      next: "should be rejected",
    }),
    (error: any) => error.code === "CONTROL_TRANSFERRED",
  );
});

test("a dependent isolated item receives actual saved predecessor files before execution", async (t) => {
  const f = await fixture(t);
  let sawDependency = false;
  f.setAction(async (session, input) => {
    if (input.prompt.includes("read predecessor")) {
      assert.equal(
        await readFile(join(session.workspacePath, "code.txt"), "utf8"),
        "implemented\n",
      );
      sawDependency = true;
      await writeFile(
        join(session.workspacePath, "second.txt"),
        "second result\n",
      );
    } else
      await writeFile(join(session.workspacePath, "code.txt"), "implemented\n");
    return "success";
  });
  const result = await f.submit({
    items: [
      {
        itemId: "a",
        stageId: "build",
        title: "First",
        prompt: "implement code",
      },
      {
        itemId: "b",
        stageId: "build",
        title: "Second",
        prompt: "read predecessor",
        dependsOn: ["a"],
      },
    ],
  });
  await f.delivered(result.work.workId, 2);
  assert.equal(sawDependency, true);
  const deliveries = f.store.work.get(result.work.workId).deliveries;
  await f.advance(result.work.workId, "integrate-dependencies", {
    integrate_delivery_ids: deliveries.map((d) => d.deliveryId),
  });
  assert.equal(
    await readFile(join(f.repo, "second.txt"), "utf8"),
    "second result\n",
  );
  assert.equal(
    await readFile(join(f.repo, "code.txt"), "utf8"),
    "implemented\n",
  );
});

test("a shared workspace delivery can be integrated without applying the same change twice", async (t) => {
  const f = await fixture(t);
  const result = await f.submit({
    items: [
      {
        itemId: "shared",
        stageId: "build",
        title: "Shared",
        prompt: "implement code",
        workspace: "shared",
      },
    ],
  });
  const work = await f.delivered(result.work.workId);
  await f.advance(work.workId, "integrate-shared", {
    integrate_delivery_ids: [work.deliveries[0].deliveryId],
  });
  assert.equal(
    await readFile(join(f.repo, "code.txt"), "utf8"),
    "implemented\n",
  );
});

test("inspect pages retain every old delivery reference and large plan under the MCP budget", async (t) => {
  const f = await fixture(t);
  const result = await f.submit({ items: [] });
  const id = result.work.workId;
  f.store.work.update(id, (w) => {
    for (let n = 1; n < 90; n++)
      w.stages.push({
        stageId: `stage-${n}`,
        title: `Stage ${n}`,
        dependsOn: [],
        criteria: ["observable"],
        confirmation: null,
        rework: false,
        blockedReason: null,
      });
    for (let n = 0; n < 18; n++)
      w.deliveries.push({
        deliveryId: `delivery-${n}`,
        itemId: "item",
        taskId: `task-${n}`,
        workspaceId: "workspace",
        manifestSha256: "a".repeat(64),
        summary: "saved",
        changedFiles: [],
        createdAt: n,
      });
  });
  for (const [section, expected] of [
    ["deliveries", 18],
    ["stages", 90],
  ] as const) {
    let cursor = 0;
    const ids: string[] = [];
    do {
      const args = { kind: "work", section, work_id: id, cursor, limit: 7 };
      const page = JSON.parse(
        presentMcpResult(
          "inspect",
          await f.coordinator.call("inspect", args),
          args,
        ).text,
      );
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 16 * 1024);
      for (const entry of page.entries)
        ids.push(entry.deliveryId ?? entry.stageId);
      if (page.nextCursor === null) break;
      assert.ok(page.nextCursor > cursor);
      cursor = page.nextCursor;
    } while (true);
    assert.equal(new Set(ids).size, expected);
  }
});

test("pending actions cannot write after takeover and batch decisions cannot confirm new queued work", async (t) => {
  const f = await fixture(t);
  const result = await f.submit({
    items: [],
    stages: [
      { stageId: "build", title: "Build" },
      { stageId: "later", title: "Later", dependsOn: ["build"] },
    ],
  });
  const id = result.work.workId;
  const pending = advanceWorkSchema.parse({
    request_id: "pending",
    work_id: id,
    commander_id: "commander",
    control_version: 1,
    next: "stale decision",
  });
  f.store.work.beginAction(pending);
  await f.advance(id, "takeover", {
    commander_id: "new-owner",
    takeover: true,
    user_requested_takeover: true,
  });
  await assert.rejects(
    f.coordinator.call("advance_work", pending),
    (error: any) => error.code === "CONTROL_TRANSFERRED",
  );
  assert.throws(
    () =>
      f.store.work.finishAction(pending, (w) => {
        w.next = "stale";
      }),
    (error: any) => error.code === "CONTROL_TRANSFERRED",
  );
  await assert.rejects(
    f.advance(id, "conflict", {
      add_items: [
        { itemId: "new", stageId: "build", title: "New", prompt: "new work" },
      ],
      confirm_stages: [
        { stage_id: "build", summary: "premature", delivery_ids: [] },
      ],
    }),
    /same decision/,
  );
  assert.equal(f.store.work.get(id).items.length, 0);
  await f.advance(id, "confirm", {
    confirm_stages: [
      { stage_id: "build", summary: "Planning done", delivery_ids: [] },
    ],
  });
  await f.advance(id, "rework", {
    rework_stages: [{ stage_id: "build", reason: "Change the plan" }],
  });
  assert.equal(
    f.store.work.view(id).stages.find((s) => s.stageId === "later")!.status,
    "not_started",
  );
});

test("a full work quota waits for the next item without reporting a false resource shortage", async (t) => {
  const f = await fixture(t, 2);
  f.setAction(async () => "running");
  const result = await f.submit({
    accounts: 2,
    items: [1, 2, 3].map((n) => ({
      itemId: `item-${n}`,
      stageId: "build",
      title: `Item ${n}`,
      prompt: "hold execution",
    })),
  });
  await until(() => f.store.getPoolPolicy().occupiedSlots === 2);
  await f.coordinator.workService.pump();
  const work = f.store.work.get(result.work.workId);
  assert.equal(work.items.filter((i) => i.queueAt !== null).length, 1);
  assert.equal(
    work.todos.some((t) => t.kind === "resource_shortage"),
    false,
  );
});

test("safe waiting yields fairly to another commander and the original item resumes with historical errors retained", async (t) => {
  const f = await fixture(t);
  f.store.setPoolPolicy({ retryIntervalMs: 1000, recoveryWaitMs: 1000 });
  let busy = true;
  const order: string[] = [];
  f.setAction(async (_session, input) => {
    const title = input.prompt.split("\n")[0]!;
    order.push(title);
    if (input.prompt.includes("busy once") && busy) {
      busy = false;
      return "busy";
    }
    return "success";
  });
  const first = await f.submit({
    items: [
      {
        itemId: "first",
        stageId: "build",
        title: "First",
        prompt: "busy once",
      },
    ],
  });
  await until(() =>
    f.store
      .listTasks()
      .some(
        (task) => f.store.work.execution(task.taskId).waitingSince !== null,
      ),
  );
  const original = f.store.listTasks()[0]!;
  const second = await f.submit({
    request_id: "second",
    commander_id: "other",
    items: [
      {
        itemId: "other",
        stageId: "build",
        title: "Other",
        prompt: "independent work",
      },
    ],
  });
  await f.delivered(second.work.workId);
  await f.delivered(first.work.workId);
  assert.deepEqual(order.slice(0, 3), [
    "任务：First",
    "任务：Other",
    "任务：First",
  ]);
  const item = f.store.work.get(first.work.workId).items[0]!;
  assert.equal(item.runIndex, 1);
  assert.notEqual(item.taskId, original.taskId);
  assert.equal(f.store.getTask(original.taskId).leaseHeld, false);
  assert.equal(f.store.work.execution(item.taskId!).waitingSince, null);
  const errors = f.store.work.errorStats({ workId: first.work.workId });
  assert.equal(errors.total, 1);
  assert.ok(errors.events.every((e) => e.recoveredAt !== null));
});

test("silence uses only fresh reads, observes new tool output and retains occupancy for an unknown queue", async (t) => {
  const f = await fixture(t);
  f.store.setPoolPolicy({ silenceCheckMs: 1000 });
  f.setAction(async () => "running");
  const result = await f.submit();
  await until(() => f.store.listTasks().length === 1);
  const task = f.store.listTasks()[0]!;
  await until(
    () => f.store.work.execution(task.taskId).observation === "silent",
  );
  const before = f.store.work.execution(task.taskId).lastVisibleActivityAt;
  f.setFresh((snapshot) => {
    (snapshot.raw.rows as any).window.push({
      rowId: 2,
      kind: "toolCall",
      turnId: "native-turn",
      toolName: "Bash",
      status: "running",
      progress: { output: "new" },
      outputPreview: "new visible output",
    });
  });
  await until(
    () => f.store.work.execution(task.taskId).lastVisibleActivityAt > before,
  );
  const observed = f.store.work.execution(task.taskId).lastVisibleActivityAt;
  f.setFresh((snapshot) => {
    (snapshot.raw.queue as any).items = [
      { state: "queued", commandId: "pending" },
    ];
  });
  await until(
    () => f.store.work.execution(task.taskId).observation === "unknown",
  );
  assert.equal(
    f.store.work.execution(task.taskId).lastVisibleActivityAt,
    observed,
  );
  assert.equal(f.store.getTask(task.taskId).leaseHeld, true);
  assert.equal(f.sends, 1);
  const revision = f.store.work.get(result.work.workId).revision;
  await f.coordinator.workService.pump();
  const attention = f.store.work.events(result.work.workId, revision);
  assert.ok(attention.some((e) => e.type === "execution_needs_verification"));
  const after = f.store.work.get(result.work.workId).revision;
  await f.coordinator.workService.pump();
  assert.equal(f.store.work.get(result.work.workId).revision, after);
  assert.equal(
    f.store.work.get(result.work.workId).items[0]!.attentionKey,
    task.taskId,
  );
  f.setFresh(() => {});
  f.setConnect(async () => f.executors[0]!);
  await until(() => !f.coordinator.jobs.has(task.taskId));
  await f.coordinator.call("resume_task", { task_id: task.taskId });
  await f.coordinator.workService.pump();
  assert.equal(
    f.store.work.get(result.work.workId).items[0]!.attentionKey,
    null,
  );
  assert.equal(
    f.store.work
      .events(result.work.workId, after)
      .filter((e) => e.type === "execution_observation_restored").length,
    1,
  );
  assert.equal(f.store.getTask(task.taskId).leaseHeld, true);
  assert.equal(f.sends, 1);
  const restored = f.store.work.get(result.work.workId).revision;
  await f.coordinator.workService.pump();
  assert.equal(f.store.work.get(result.work.workId).revision, restored);
});

test("completion rejects a failed acceptance in the same batch before mutating confirmed work", async (t) => {
  const f = await fixture(t);
  const submitted = await f.submit();
  const work = await f.delivered(submitted.work.workId);
  const delivery = work.deliveries[0]!;
  const integrated = await f.advance(work.workId, "confirm-integrate", {
    confirm_stages: [
      {
        stage_id: "build",
        summary: "checked",
        delivery_ids: [delivery.deliveryId],
        acceptance_ids: [],
      },
    ],
    integrate_delivery_ids: [delivery.deliveryId],
  });
  await f.advance(work.workId, "late-review", {
    start_acceptance: [
      {
        acceptance_id: "late",
        delivery_id: delivery.deliveryId,
        executor: "external",
        name: "Independent review",
      },
    ],
  });
  await assert.rejects(
    f.advance(work.workId, "fail-complete", {
      acceptance_results: [
        {
          acceptance_id: "late",
          status: "failed",
          summary: "Missing behavior",
          evidence: ["regression"],
        },
      ],
      final_acceptance: {
        revision: integrated.work.integrationRevision,
        summary: "actual tree checked",
        evidence: [],
      },
      complete: true,
    }),
    /confirmed stages and passed acceptance/,
  );
  const unchanged = f.store.work.get(work.workId);
  assert.equal(unchanged.status, "active");
  assert.ok(unchanged.stages[0]!.confirmation);
  assert.equal(unchanged.acceptances[0]!.status, "running");
  await f.advance(work.workId, "fail-only", {
    acceptance_results: [
      {
        acceptance_id: "late",
        status: "failed",
        summary: "Missing behavior",
        evidence: [],
      },
    ],
  });
  assert.equal(f.store.work.get(work.workId).stages[0]!.confirmation, null);
});

test("completion rechecks the actual Git tree when reusing saved final acceptance", async (t) => {
  const f = await fixture(t);
  const submitted = await f.submit();
  const work = await f.delivered(submitted.work.workId);
  const integrated = await f.advance(work.workId, "integrate", {
    confirm_stages: [
      {
        stage_id: "build",
        summary: "checked",
        delivery_ids: [work.deliveries[0]!.deliveryId],
        acceptance_ids: [],
      },
    ],
    integrate_delivery_ids: [work.deliveries[0]!.deliveryId],
  });
  await f.advance(work.workId, "final-check", {
    final_acceptance: {
      revision: integrated.work.integrationRevision,
      summary: "actual bytes checked",
      evidence: [],
    },
  });
  const index = await git(f.repo, ["write-tree"]);
  const branch = await git(f.repo, ["symbolic-ref", "HEAD"]);
  await writeFile(join(f.repo, "code.txt"), "changed after acceptance\n");
  await assert.rejects(
    f.advance(work.workId, "stale-completion", { complete: true }),
    /Project changed after integration/,
  );
  assert.equal(f.store.work.get(work.workId).status, "active");
  assert.equal(await git(f.repo, ["write-tree"]), index);
  assert.equal(await git(f.repo, ["symbolic-ref", "HEAD"]), branch);
  await writeFile(join(f.repo, "code.txt"), "implemented\n");
  f.setAction(async () => "running");
  const shared = await f.submit({
    request_id: "other-shared",
    commander_id: "other",
    items: [
      {
        itemId: "other",
        stageId: "build",
        title: "Shared",
        prompt: "hold project",
        workspace: "shared",
      },
    ],
  });
  await until(
    () => f.store.getPoolPolicy().occupiedSlots === 1 && f.sends === 2,
  );
  await assert.rejects(
    f.advance(work.workId, "busy-completion", { complete: true }),
    /project directory is still in use/,
  );
  f.executors.at(-1)!.finish();
  await f.delivered(shared.work.workId);
  assert.equal(
    (await f.advance(work.workId, "unchanged-completion", { complete: true }))
      .work.status,
    "completed",
  );
});

test("shared execution waits for isolated dependency integration and preserves the dirty index", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.repo, "code.txt"), "staged user bytes\n");
  await git(f.repo, ["add", "code.txt"]);
  await writeFile(join(f.repo, "code.txt"), "unstaged user bytes\n");
  const index = await git(f.repo, ["write-tree"]);
  const branch = await git(f.repo, ["symbolic-ref", "HEAD"]);
  let sharedSawFile = false;
  f.setAction(async (session, input) => {
    if (input.prompt.includes("produce predecessor"))
      await writeFile(
        join(session.workspacePath, "predecessor.txt"),
        "saved prerequisite\n",
      );
    else {
      assert.equal(session.workspacePath, f.repo);
      assert.equal(
        await readFile(join(session.workspacePath, "predecessor.txt"), "utf8"),
        "saved prerequisite\n",
      );
      assert.equal(
        await readFile(join(session.workspacePath, "code.txt"), "utf8"),
        "unstaged user bytes\n",
      );
      sharedSawFile = true;
    }
    return "success";
  });
  const submitted = await f.submit({
    items: [
      {
        itemId: "a",
        stageId: "build",
        title: "Producer",
        prompt: "produce predecessor",
        workspace: "isolated",
      },
      {
        itemId: "b",
        stageId: "build",
        title: "Consumer",
        prompt: "consume prerequisite",
        workspace: "shared",
        dependsOn: ["a"],
      },
    ],
  });
  const work = await f.delivered(submitted.work.workId);
  await f.coordinator.workService.pump();
  assert.equal(f.store.work.get(work.workId).items[1]!.taskId, null);
  assert.equal(f.sends, 1);
  assert.ok(
    f.store.work
      .get(work.workId)
      .todos.some((todo) =>
        /dependency deliveries to be integrated/.test(todo.summary),
      ),
  );
  await assert.rejects(readFile(join(f.repo, "predecessor.txt")), {
    code: "ENOENT",
  });
  await f.advance(work.workId, "integrate-prerequisite", {
    integrate_delivery_ids: [work.deliveries[0]!.deliveryId],
  });
  await f.delivered(work.workId, 2);
  assert.equal(sharedSawFile, true);
  assert.equal(
    f.store.work
      .get(work.workId)
      .todos.some((todo) =>
        /dependency deliveries to be integrated/.test(todo.summary),
      ),
    false,
  );
  assert.equal(await git(f.repo, ["write-tree"]), index);
  assert.equal(await git(f.repo, ["symbolic-ref", "HEAD"]), branch);
});

test("a zero low-quota threshold still excludes confirmed exhaustion without inventing unknown quota", async (t) => {
  for (const [remaining, available, allLow] of [
    [{ count: 0, percentage: 0 }, 0, true],
    [{ count: 0, percentage: 0.5 }, 0, true],
    [{ count: 1, percentage: 0.001 }, 1, false],
    [{}, 0, false],
  ] as const) {
    const f = await fixture(t);
    f.store.setPoolPolicy({ lowQuotaThresholdPercent: 0 });
    f.setQuota({ authenticated: true, remaining });
    const capacity = await (f.coordinator.workService as any).accountCapacity();
    assert.equal(capacity.available.length, available);
    assert.equal(capacity.allLow, allLow);
  }
});

test("pre-send setup waiting yields safely and resumes the original Work after another commander", async (t) => {
  const f = await fixture(t);
  f.store.setPoolPolicy({ retryIntervalMs: 1000, recoveryWaitMs: 1000 });
  let failed = false;
  f.setConnect(async () => {
    if (!failed) {
      failed = true;
      throw Object.assign(new Error("connect refused"), {
        code: "ECONNREFUSED",
      });
    }
    return f.createExecutor();
  });
  const order: string[] = [];
  f.setAction(async (_session, input) => {
    order.push(input.prompt.split("\n")[0]!);
    return "success";
  });
  const first = await f.submit();
  await until(() =>
    f.store
      .listTasks()
      .some(
        (task) => f.store.work.execution(task.taskId).waitingSince !== null,
      ),
  );
  const original = f.store.listTasks()[0]!;
  assert.equal(original.dispatchAttemptedAt, null);
  assert.equal(original.leaseHeld, true);
  const second = await f.submit({
    request_id: "other",
    commander_id: "other",
    items: [
      {
        itemId: "other",
        stageId: "build",
        title: "Other",
        prompt: "independent work",
      },
    ],
  });
  await f.delivered(second.work.workId);
  await f.delivered(first.work.workId);
  assert.deepEqual(order, ["任务：Other", "任务：Implement"]);
  const stopped = f.store.getTask(original.taskId);
  assert.equal(stopped.stopProof!.kind, "not_dispatched");
  assert.equal(stopped.dispatchAttemptedAt, null);
  assert.equal(stopped.leaseHeld, false);
  assert.ok(
    f.store
      .getResult(original.taskId)
      ?.artifacts.some((a) => a.kind === "file_manifest"),
  );
  const resumed = f.store.work.get(first.work.workId).items[0]!;
  assert.equal(resumed.runIndex, 1);
  assert.notEqual(resumed.taskId, original.taskId);
  assert.equal(f.store.work.execution(resumed.taskId!).waitingSince, null);
  const errors = f.store.work.errorStats({ workId: first.work.workId });
  assert.equal(errors.total, 1);
  assert.ok(errors.events[0]!.recoveredAt);
  assert.equal(f.sends, 2);
});

test("restart recovery saves and requeues a Work item with no durable dispatch intent", async (t) => {
  const f = await fixture(t);
  f.store.setPoolPolicy({ maxConcurrentTasks: 0 });
  const submitted = await f.submit();
  const workId = submitted.work.workId;
  const workspace = (await f.coordinator.call("create_workspace", {
    repository: f.repo,
    base_ref: "HEAD",
  })) as any;
  await f.coordinator.workService.pump();
  f.store.setPoolPolicy({ maxConcurrentTasks: 1 });
  const original = f.store.dispatch({
    workspaceId: workspace.workspaceId,
    workerId: "worker-account-0",
    requestId: `${workId}:implementation:0`,
    prompt: "implement code",
    workItem: { workId, itemId: "implementation" },
  }).task;
  f.store.setPoolPolicy({ maxConcurrentTasks: 0 });
  const retryAt = Date.now() + 1000;
  f.store.work.updateExecution(original.taskId, {
    waitingSince: Date.now(),
    retryAt,
  });
  let connects = 0;
  f.setConnect(async () => {
    connects++;
    return f.createExecutor();
  });
  await f.coordinator.recoverTasks();
  assert.equal(connects, 0);
  assert.equal(
    f.store.getTask(original.taskId).stopProof!.kind,
    "not_dispatched",
  );
  assert.equal(f.store.getTask(original.taskId).leaseHeld, false);
  assert.equal(f.store.work.get(workId).items[0]!.runIndex, 1);
  assert.ok(f.store.work.get(workId).items[0]!.queueAt! >= retryAt);
  f.store.setPoolPolicy({ maxConcurrentTasks: 1 });
  await f.coordinator.workService.pump();
  assert.equal(f.sends, 0);
  await f.delivered(workId);
  assert.equal(f.sends, 1);
  assert.notEqual(f.store.work.get(workId).items[0]!.taskId, original.taskId);
});

test("multi-account fairness grants complete feasible batches and never invents partial approval", async (t) => {
  const items = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      itemId: `${prefix}${i}`,
      stageId: "build",
      title: `${prefix}${i}`,
      prompt: "hold execution",
    }));
  await t.test(
    "two occupied accounts drain for a waiting commander before the prior commander refills",
    async (t) => {
      const f = await fixture(t, 2);
      f.setAction(async () => "running");
      f.store.setPoolPolicy({ maxConcurrentTasks: 0 });
      const a = await f.submit({ accounts: 2, items: items("a", 3) });
      const b = await f.submit({
        request_id: "b",
        commander_id: "b",
        accounts: 2,
        items: items("b", 2),
      });
      f.store.setPoolPolicy({ maxConcurrentTasks: 2 });
      await f.coordinator.workService.pump();
      await until(() => f.sends === 2);
      assert.equal(
        f.store.work.get(b.work.workId).items.some((i) => i.taskId !== null),
        false,
      );
      f.executors[0]!.finish();
      await until(() => f.store.getPoolPolicy().occupiedSlots === 1);
      await f.coordinator.workService.pump();
      assert.equal(f.sends, 2);
      assert.equal(f.store.work.get(a.work.workId).items[2]!.taskId, null);
      f.executors[1]!.finish();
      await until(() => f.sends === 4);
      assert.equal(
        f.store.work.get(b.work.workId).items.filter((i) => i.taskId !== null)
          .length,
        2,
      );
      assert.equal(f.store.work.get(a.work.workId).items[2]!.taskId, null);
    },
  );
  await t.test(
    "three accounts and two requests for two leave the remaining slot pending",
    async (t) => {
      const f = await fixture(t, 3);
      f.setAction(async () => "running");
      f.store.setPoolPolicy({ maxConcurrentTasks: 0 });
      const a = await f.submit({ accounts: 2, items: items("a", 2) });
      const b = await f.submit({
        request_id: "b",
        commander_id: "b",
        accounts: 2,
        items: items("b", 2),
      });
      f.store.setPoolPolicy({ maxConcurrentTasks: 3 });
      await f.coordinator.workService.pump();
      await until(() => f.sends === 2);
      await f.coordinator.workService.pump();
      assert.equal(
        f.store.work.get(a.work.workId).items.filter((i) => i.taskId !== null)
          .length,
        2,
      );
      assert.equal(
        f.store.work.get(b.work.workId).items.filter((i) => i.taskId !== null)
          .length,
        0,
      );
      assert.equal(f.store.work.get(b.work.workId).partialApproval, null);
      assert.equal(f.store.getPoolPolicy().occupiedSlots, 2);
      f.store.setPoolPolicy({ maxConcurrentTasks: 0 });
      await f.coordinator.workService.pump();
      assert.equal(f.store.getPoolPolicy().occupiedSlots, 2);
    },
  );
  await t.test(
    "an impossible larger request leaves independently authorized work runnable",
    async (t) => {
      const f = await fixture(t, 2);
      f.setAction(async () => "running");
      f.store.setPoolPolicy({ maxConcurrentTasks: 0 });
      const a = await f.submit({ accounts: 3, items: items("a", 3) });
      const b = await f.submit({
        request_id: "b",
        commander_id: "b",
        accounts: 1,
        items: items("b", 1),
      });
      f.store.setPoolPolicy({ maxConcurrentTasks: 2 });
      await f.coordinator.workService.pump();
      await until(() => f.sends === 1);
      assert.equal(
        f.store.work.get(a.work.workId).items.some((i) => i.taskId !== null),
        false,
      );
      assert.equal(f.store.work.get(a.work.workId).partialApproval, null);
      assert.equal(
        f.store.work.get(b.work.workId).items[0]!.taskId !== null,
        true,
      );
    },
  );
});

test("a failed historical acceptance remains recorded while a reworked delivery can complete", async (t) => {
  const f = await fixture(t);
  const submitted = await f.submit();
  const work = await f.delivered(submitted.work.workId);
  const old = work.deliveries[0]!;
  await f.advance(work.workId, "old-review", {
    start_acceptance: [
      {
        acceptance_id: "old",
        delivery_id: old.deliveryId,
        executor: "external",
        name: "Reviewer",
      },
    ],
  });
  await f.advance(work.workId, "old-failed", {
    acceptance_results: [
      {
        acceptance_id: "old",
        status: "failed",
        summary: "Needs rework",
        evidence: [],
      },
    ],
  });
  await f.advance(work.workId, "late-old-review", {
    start_acceptance: [
      {
        acceptance_id: "old-late",
        delivery_id: old.deliveryId,
        executor: "external",
        name: "Delayed reviewer",
      },
    ],
  });
  await f.advance(work.workId, "rework", {
    rework_stages: [{ stage_id: "build", reason: "Fix failed acceptance" }],
    cancel_items: ["implementation"],
    add_items: [
      {
        itemId: "revised",
        stageId: "build",
        title: "Rework",
        prompt: "implement code",
      },
    ],
  });
  const revised = (await f.delivered(work.workId, 2)).deliveries.at(-1)!;
  await f.advance(work.workId, "new-review", {
    start_acceptance: [
      {
        acceptance_id: "new",
        delivery_id: revised.deliveryId,
        executor: "external",
        name: "Reviewer",
      },
    ],
  });
  const integrated = await f.advance(work.workId, "accept-rework", {
    acceptance_results: [
      {
        acceptance_id: "new",
        status: "passed",
        summary: "Rework passed",
        evidence: [],
      },
    ],
    confirm_stages: [
      {
        stage_id: "build",
        summary: "Rework complete",
        delivery_ids: [revised.deliveryId],
        acceptance_ids: ["new"],
      },
    ],
    integrate_delivery_ids: [revised.deliveryId],
  });
  await f.advance(work.workId, "final-rework-check", {
    final_acceptance: {
      revision: integrated.work.integrationRevision,
      summary: "Actual integrated rework checked",
      evidence: [],
    },
  });
  const finished = await f.advance(work.workId, "finish-rework", {
    acceptance_results: [
      {
        acceptance_id: "old-late",
        status: "failed",
        summary: "Delayed failure of the superseded version",
        evidence: [],
      },
    ],
    complete: true,
  });
  assert.equal(finished.work.status, "completed");
  const final = f.store.work.get(work.workId);
  assert.deepEqual(final.stages[0]!.confirmation!.deliveryIds, [
    revised.deliveryId,
  ]);
  assert.equal(
    final.acceptances.find((a) => a.acceptanceId === "old")!.status,
    "failed",
  );
  assert.equal(
    final.acceptances.find((a) => a.acceptanceId === "old-late")!.status,
    "failed",
  );
});
