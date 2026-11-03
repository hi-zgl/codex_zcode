import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { DurableTaskStore } from "../../src/core/store.js";
import { submitWorkSchema, workSchema } from "../../src/core/work-types.js";
import { WorkService } from "../../src/daemon/work.js";
import { createWorkspace, git } from "../../src/daemon/workspace.js";

function service(root: string, store: DurableTaskStore) {
  return new WorkService({
    root, store, closing: false,
    vault: { list: async () => [] },
    supervisor: { list: async () => [] },
    call: async () => { throw new Error("No runtime calls in this fixture"); },
    probeAccount: async () => { throw new Error("No account probes in this fixture"); },
    dispatchWorkItem: async () => { throw new Error("No native dispatch in this fixture"); },
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "zcode-work-efficiency-"));
  const databasePath = join(root, "state.db");
  const store = new DurableTaskStore(databasePath);
  const workService = service(root, store);
  t.after(async () => {
    await workService.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, databasePath, store, workService };
}

function createWork(store: DurableTaskStore, requestId: string, repository = "/fixture", withItem = false) {
  return store.work.create(submitWorkSchema.parse({
    request_id: requestId, commander_id: "commander", repository,
    goal: "Fixture goal", criteria: ["Fixture criterion"],
    stages: [{ stageId: "build", title: "Build" }],
    items: withItem ? [{ itemId: "item", stageId: "build", title: "Item", prompt: "Fixture task" }] : [],
  })).work;
}

function completeItem(store: DurableTaskStore, workId: string, workspaceId: string) {
  const task = store.dispatch({
    requestId: `${workId}:item:0`, workspaceId, prompt: "Fixture task",
    workItem: { workId, itemId: "item" },
  }).task;
  store.completeTask(task.taskId, {
    summary: "Saved fixture result",
    artifacts: [{ kind: "file_manifest", path: "fixture-manifest.json", sha256: "a".repeat(64), sizeBytes: 0 }],
  }, { status: "cancelled" });
  return task;
}

test("pump reconstructs only active work and does not reread settled history or saved results", async (t) => {
  const { store, workService } = await fixture(t);
  const historical: string[] = [];
  for (let i = 0; i < 24; i++) {
    const work = createWork(store, `history-${i}`, "/fixture", true);
    const ws = store.registerWorkspace({
      workspaceId: `history-${i}`, repositoryPath: "/fixture", worktreePath: `/fixture/${i}`,
      branch: "fixture", baseCommit: "fixture",
    });
    completeItem(store, work.workId, ws.workspaceId);
    historical.push(work.workId);
  }
  const current = createWork(store, "current", "/fixture", true);
  store.registerWorkspace({
    workspaceId: "current", repositoryPath: "/fixture", worktreePath: "/fixture/current",
    branch: "fixture", baseCommit: "fixture",
  });
  completeItem(store, current.workId, "current");
  await workService.pump();
  for (let i = 0; i < historical.length; i++) {
    store.work.update(historical[i]!, (work) => { work.status = "completed"; });
    store.setWorkspaceState(`history-${i}`, "merged");
  }
  const parses = t.mock.method(workSchema, "parse");
  const fullTasks = t.mock.method(store, "getTask");
  const results = t.mock.method(store, "getResult");
  const allWork = t.mock.method(store.work, "list");
  await workService.pump();
  await workService.pump();
  assert.deepEqual(parses.mock.calls.map((call) => (call.arguments[0] as {workId:string}).workId),
    [current.workId, current.workId]);
  assert.equal(fullTasks.mock.callCount(), 0);
  assert.equal(results.mock.callCount(), 0);
  assert.equal(allWork.mock.callCount(), 0);
  t.diagnostic("24 historical Work/Task/Result records, 2 pumps: 2 active Work parses, 0 full Task/Result/history-list reads");
});

test("cancelled work retains leases, collects a late delivery after restart, and protects active acceptance workspaces", async (t) => {
  const f = await fixture(t);
  const repo = join(f.root, "project");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "code.txt"), "fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Fixture baseline"]);
  const ws = f.store.registerWorkspace(await createWorkspace(f.root, repo, "HEAD"));
  const work = createWork(f.store, "cancelled", repo, true);
  const task = f.store.dispatch({
    requestId: `${work.workId}:item:0`, workspaceId: ws.workspaceId, prompt: "Fixture task",
    workItem: { workId: work.workId, itemId: "item" },
  }).task;
  f.store.work.update(work.workId, (current) => { current.status = "cancelled"; });
  await f.workService.pump();
  assert.equal(f.store.getTask(task.taskId).leaseHeld, true);
  assert.deepEqual(f.store.work.heldItems().map((held) => ({ ...held })),
    [{workId:work.workId,commanderId:"commander",count:1}]);
  assert.equal(f.store.getWorkspace(ws.workspaceId).state, "active");
  f.store.completeTask(task.taskId, {
    summary: "Late saved fixture result",
    artifacts: [{ kind: "file_manifest", path: "fixture-manifest.json", sha256: "b".repeat(64), sizeBytes: 0 }],
  }, { status: "cancelled" });
  const guard = createWork(f.store, "acceptance-guard", repo);
  f.store.work.update(guard.workId, (current) => {
    current.acceptances.push({
      acceptanceId: "review", deliveryId: `delivery_${task.taskId}`,
      executor: { kind: "external", name: "Fixture reviewer" }, status: "running", itemId: null,
      workspaceId: ws.workspaceId, workspacePath: ws.worktreePath, summary: "", evidence: [],
      startedAt: Date.now(), completedAt: null,
    });
  });
  await f.workService.close();
  f.store.close();
  const reopened = new DurableTaskStore(f.databasePath);
  const resumed = service(f.root, reopened);
  try {
    await resumed.pump();
    assert.equal(reopened.work.get(work.workId).deliveries[0]!.taskId, task.taskId);
    assert.equal(reopened.getWorkspace(ws.workspaceId).state, "active");
    assert.equal(await readFile(join(ws.worktreePath, "code.txt"), "utf8"), "fixture\n");
    assert.deepEqual(reopened.work.heldItems(), []);
    reopened.work.update(guard.workId, (current) => { current.status = "cancelled"; });
    await resumed.pump();
    assert.equal(reopened.getWorkspace(ws.workspaceId).state, "abandoned");
    await assert.rejects(readFile(join(ws.worktreePath, "code.txt")), { code: "ENOENT" });
    assert.deepEqual(reopened.work.forCollection(), []);
    assert.deepEqual(reopened.work.cleanupCandidates(), []);
  } finally {
    await resumed.close();
    reopened.close();
  }
});

test("unchanged work waits use only lightweight heads across polls and unrelated local changes", async (t) => {
  const { store, workService } = await fixture(t);
  const watched = createWork(store, "watched");
  const unrelated = createWork(store, "unrelated");
  const fullReads = t.mock.method(store.work, "get");
  const heads = t.mock.method(store.work, "head");
  const pending = workService.wait({
    work_id: watched.workId, commander_id: "commander", after_revision: watched.revision, timeout_sec: 0.6,
  });
  store.work.update(unrelated.workId, (work) => { work.next = "Unrelated change"; });
  const response = await pending;
  assert.deepEqual(response, {workId:watched.workId,revision:watched.revision,status:"active",timedOut:true});
  assert.ok(heads.mock.callCount() >= 4);
  assert.equal(fullReads.mock.calls.filter((call) => call.arguments[0] === watched.workId).length, 0);
});

test("work waits wake on local commits and daemon shutdown", async (t) => {
  const { store, workService } = await fixture(t);
  const watched = createWork(store, "watched");
  const pending = workService.wait({
    work_id: watched.workId, commander_id: "commander", after_revision: watched.revision, timeout_sec: 30,
  });
  store.work.update(watched.workId, (work) => { work.next = "Committed change"; });
  const settled = t.mock.fn();
  void pending.then(settled);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled.mock.callCount(), 1);
  const changed = await pending;
  assert.ok("work" in changed);
  assert.equal(changed.timedOut, false);
  assert.equal(changed.work.next, "Committed change");
  const closing = workService.wait({
    work_id: watched.workId, commander_id: "commander", after_revision: changed.work.revision, timeout_sec: 30,
  });
  await workService.close();
  assert.equal((await closing).timedOut, true);
});

test("work waits observe external takeover even with a future cursor and no work event", async (t) => {
  const { store, databasePath, workService } = await fixture(t);
  const watched = createWork(store, "watched");
  const other = new DurableTaskStore(databasePath);
  t.after(() => other.close());
  const pending = workService.wait({
    work_id: watched.workId, commander_id: "commander", after_revision: Number.MAX_SAFE_INTEGER, timeout_sec: 2,
  });
  other.work.updateQuiet(watched.workId, (work) => {
    work.commanderId = "new-commander";
    work.controlVersion++;
  });
  const transferred = await pending;
  assert.ok("work" in transferred);
  assert.equal(transferred.controlTransferred, true);
  assert.equal(transferred.work.commanderId, "new-commander");
  assert.equal(transferred.work.controlVersion, watched.controlVersion + 1);
  assert.deepEqual(transferred.events, []);
  const stale = await workService.wait({
    work_id: watched.workId, commander_id: "commander", after_revision: Number.MAX_SAFE_INTEGER, timeout_sec: 0,
  });
  assert.ok("work" in stale);
  assert.equal(stale.controlTransferred, true);
  assert.equal(stale.timedOut, false);
});
