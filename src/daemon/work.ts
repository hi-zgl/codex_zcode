import { join, resolve } from "node:path";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { AccountSummary } from "../accounts/index.js";
import type { DurableTaskStore } from "../core/store.js";
import type {
  Work,
  WorkItem,
  WorkView,
  AdvanceWorkInput,
  SubmitWorkInput,
  Delivery,
} from "../core/work-types.js";
import {
  createWorkspace,
  git,
  materializeDelivery,
  saveWorkingTree,
  deliveryCommit,
  treeCommit,
  cleanupWorkspace,
} from "./workspace.js";
import { resolveQuotaSnapshot } from "./quota-resolver.js";
import { record } from "../runtime/zcode-server/events.js";
import type { Task } from "../core/types.js";

interface WorkContext {
  root: string;
  store: DurableTaskStore;
  closing: boolean;
  vault: { list(): Promise<AccountSummary[]> };
  supervisor: { list(): Promise<any[]> };
  call(method: string, input: Record<string, unknown>): Promise<unknown>;
  probeAccount(
    accountAlias: string,
  ): Promise<{ quota: Record<string, unknown>; providerId: string }>;
  dispatchWorkItem(
    workId: string,
    itemId: string,
    params: Record<string, unknown>,
  ): Promise<Task>;
}
/** One daemon owns scheduling; persisted requests and native leases survive a commander disconnect. */
export class WorkService {
  private pumping: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval>;
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly integrations = new Map<string, Promise<unknown>>();
  private readonly quota = new Map<
    string,
    {
      remaining: number | null;
      at: number;
      usable: boolean;
      exhausted: boolean;
    }
  >();
  private readonly cleanupAttempts = new Map<string, number>();
  private closed = false;
  markQuotaUnavailable(accountAlias: string): void {
    this.quota.set(accountAlias, {
      remaining: 0,
      usable: false,
      exhausted: true,
      at: Date.now(),
    });
  }
  isProjectLocked(repository: string): boolean {
    return this.integrations.has(resolve(repository));
  }
  constructor(private readonly ctx: WorkContext) {
    this.timer = setInterval(() => {
      void this.pump();
    }, 1000);
    this.timer.unref();
  }
  overview(filter: { repositoryPath?: string; workId?: string } = {}) {
    return this.ctx.store.work.overview(filter);
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const prior = this.operations.get(id) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(action)
      .finally(() => {
        if (this.operations.get(id) === next) this.operations.delete(id);
      });
    this.operations.set(id, next);
    return next;
  }
  async submit(input: SubmitWorkInput) {
    const repository = (
      await git(resolve(input.repository), ["rev-parse", "--show-toplevel"])
    ).trim();
    const result = this.ctx.store.work.create({ ...input, repository });
    void this.pump();
    return {
      work: this.ctx.store.work.briefView(result.work.workId),
      created: result.created,
    };
  }
  async advance(input: AdvanceWorkInput) {
    return this.serial(input.work_id, async () => {
      const decide = async () => {
        const store = this.ctx.store.work;
        const state = store.beginAction(input);
        if (state === "done")
          return { work: store.briefView(input.work_id), applied: false };
        let integration: { ids: string[]; revision: string } | undefined;
        try {
          const current = store.get(input.work_id);
          if (state === "pending") {
            const intent = store.integrationIntent(input.request_id);
            if (!intent)
              throw new Error(
                "The previous native decision has an uncertain response; inspect current work before a new decision",
              );
            const actual = await saveWorkingTree(current.repositoryPath);
            const actualTree = (
              await git(current.repositoryPath, [
                "rev-parse",
                `${actual}^{tree}`,
              ])
            ).trim();
            const afterTree = (
                await git(current.repositoryPath, [
                  "rev-parse",
                  `${intent.after}^{tree}`,
                ])
              ).trim(),
              beforeTree = (
                await git(current.repositoryPath, [
                  "rev-parse",
                  `${intent.before}^{tree}`,
                ])
              ).trim();
            if (actualTree === afterTree)
              integration = {
                ids: input.integrate_delivery_ids,
                revision: actual,
              };
            else if (actualTree !== beforeTree)
              throw new Error(
                "Project differs from both saved integration versions; inspect the pending item or explicitly retry with a new decision ID",
              );
          }
          this.validateDecision(current, input);
          const accepted =
            input.final_acceptance ??
            (input.complete ? current.finalAcceptance : null);
          if (accepted) {
            this.assertProjectIdle(current.repositoryPath);
            const actual = await saveWorkingTree(current.repositoryPath);
            if (
              (
                await git(current.repositoryPath, [
                  "rev-parse",
                  `${actual}^{tree}`,
                ])
              ).trim() !==
              (
                await git(current.repositoryPath, [
                  "rev-parse",
                  `${accepted.revision}^{tree}`,
                ])
              ).trim()
            )
              throw new Error(
                "Project changed after integration; inspect and accept the current integrated version",
              );
          }
          if (state === "new") {
            for (const response of input.approval_responses)
              await this.ctx.call("respond_approval", response);
            for (const itemId of input.cancel_items) {
              const item = current.items.find((i) => i.itemId === itemId)!;
              if (item.taskId && this.ctx.store.getTask(item.taskId).leaseHeld)
                await this.ctx.call("cancel_task", { task_id: item.taskId });
            }
          }
          if (input.integrate_delivery_ids.length && !integration)
            integration = await this.serialIntegration(
              current.repositoryPath,
              () =>
                this.integrate(
                  current,
                  input.integrate_delivery_ids,
                  input.request_id,
                ),
            );
          const externalCopies = new Map<
            string,
            { workspaceId: string; workspacePath: string }
          >();
          for (const acceptance of input.start_acceptance.filter(
            (a) => a.executor === "external",
          )) {
            const delivery = current.deliveries.find(
              (d) => d.deliveryId === acceptance.delivery_id,
            )!;
            const result = this.ctx.store.getResult(delivery.taskId)!;
            const prepared = await materializeDelivery(
              this.ctx.root,
              current.repositoryPath,
              delivery.taskId,
              result,
            );
            const ws = this.ctx.store.registerWorkspace(prepared);
            externalCopies.set(acceptance.acceptance_id, {
              workspaceId: ws.workspaceId,
              workspacePath: ws.worktreePath,
            });
          }
          const work = store.finishAction(input, (w) =>
            this.applyDecision(w, input, integration, externalCopies),
          );
          if (input.cancel)
            for (const item of work.items)
              if (item.taskId && this.ctx.store.getTask(item.taskId).leaseHeld)
                await this.ctx
                  .call("cancel_task", { task_id: item.taskId })
                  .catch(() => {});
          void this.pump();
          return { work: store.briefView(work.workId), applied: true };
        } catch (error) {
          if (input.integrate_delivery_ids.length)
            store.todo(
              input.work_id,
              "integration_conflict",
              "Integration needs inspection; saved deliveries are intact. " +
                (error instanceof Error
                  ? error.message
                  : "Git could not apply delivery"),
            );
          if (!(error as any)?.integrationMayHaveApplied && state !== "pending")
            store.abandonAction(input.request_id);
          throw error;
        }
      };
      return input.final_acceptance || input.complete
        ? this.serialIntegration(
            this.ctx.store.work.get(input.work_id).repositoryPath,
            decide,
          )
        : decide();
    });
  }
  private applyDecision(
    w: Work,
    input: AdvanceWorkInput,
    integration?: { ids: string[]; revision: string },
    externalCopies = new Map<
      string,
      { workspaceId: string; workspacePath: string }
    >(),
  ): void {
    const store = this.ctx.store.work;
    if (input.takeover) {
      w.commanderId = input.commander_id;
      w.controlVersion++;
    }
    const at = Date.now();
    for (const stage of input.add_stages)
      w.stages.push({
        ...stage,
        confirmation: null,
        rework: false,
        blockedReason: null,
      });
    for (const rework of input.rework_stages) {
      this.reopen(w, rework.stage_id, rework.reason);
      w.status = "active";
    }
    for (const item of input.add_items) {
      if (w.stages.find((s) => s.stageId === item.stageId)?.confirmation)
        this.reopen(w, item.stageId, "Additional work was assigned");
      w.items.push(store.newItem(item, at));
    }
    for (const entry of input.block_items) {
      const item = w.items.find((i) => i.itemId === entry.item_id)!;
      item.blockedReason = entry.reason;
    }
    for (const itemId of input.cancel_items) {
      const item = w.items.find((i) => i.itemId === itemId)!;
      item.cancelled = true;
      if (!item.taskId) item.queueAt = null;
    }
    if (input.allow_partial_accounts !== undefined) {
      if (!input.user_confirmed_partial)
        throw new Error("Partial resources require the user confirmation");
      w.partialApproval = input.allow_partial_accounts;
      w.todos = w.todos.filter((t) => t.kind !== "resource_shortage");
    }
    for (const start of input.start_acceptance) {
      const item =
        start.executor === "zcode" ? store.newItem(start.item!, at) : null;
      if (item) {
        item.kind = "acceptance";
        item.targetDeliveryId = start.delivery_id;
        item.acceptanceId = start.acceptance_id;
        item.workspace = "isolated";
        w.items.push(item);
      }
      w.acceptances.push({
        acceptanceId: start.acceptance_id,
        deliveryId: start.delivery_id,
        executor: { kind: start.executor, name: start.name },
        status: "running",
        itemId: item?.itemId ?? null,
        workspaceId:
          externalCopies.get(start.acceptance_id)?.workspaceId ?? null,
        workspacePath:
          externalCopies.get(start.acceptance_id)?.workspacePath ?? null,
        summary: "",
        evidence: [],
        startedAt: at,
        completedAt: null,
      });
    }
    for (const result of input.acceptance_results) {
      const a = w.acceptances.find(
        (a) => a.acceptanceId === result.acceptance_id,
      )!;
      Object.assign(a, {
        status: result.status,
        summary: result.summary,
        evidence: result.evidence,
        completedAt: at,
      });
      if (result.status === "failed") {
        const delivery = w.deliveries.find(
          (d) => d.deliveryId === a.deliveryId,
        )!;
        const item = w.items.find((i) => i.itemId === delivery.itemId)!;
        const stage = w.stages.find((s) => s.stageId === item.stageId)!;
        const currentDelivery =
          !item.cancelled &&
          item.kind === "implementation" &&
          w.deliveries.filter((d) => d.itemId === item.itemId).at(-1)
            ?.deliveryId === delivery.deliveryId;
        if (
          currentDelivery ||
          stage.confirmation?.deliveryIds.includes(delivery.deliveryId) ||
          stage.confirmation?.acceptanceIds.includes(a.acceptanceId)
        )
          this.reopen(w, item.stageId, result.summary);
      }
    }
    for (const confirmation of input.confirm_stages) {
      const stage = w.stages.find((s) => s.stageId === confirmation.stage_id)!;
      stage.confirmation = {
        summary: confirmation.summary,
        deliveryIds: confirmation.delivery_ids,
        acceptanceIds: confirmation.acceptance_ids,
        confirmedAt: at,
      };
      stage.rework = false;
      stage.blockedReason = null;
    }
    w.todos = w.todos.filter((t) => !input.resolve_todos.includes(t.todoId));
    if (integration) {
      w.integratedDeliveryIds = [
        ...new Set([...w.integratedDeliveryIds, ...integration.ids]),
      ];
      w.integrationRevision = integration.revision;
      w.finalAcceptance = null;
    }
    if (input.final_acceptance)
      w.finalAcceptance = { ...input.final_acceptance, acceptedAt: at };
    if (input.next !== undefined) w.next = input.next;
    if (input.complete) w.status = "completed";
    if (input.cancel) {
      w.status = "cancelled";
      for (const item of w.items)
        if (item.queueAt !== null) {
          item.cancelled = true;
          item.queueAt = null;
        }
    }
  }
  private validateDecision(work: Work, input: AdvanceWorkInput): void {
    const itemIds = new Set(work.items.map((i) => i.itemId)),
      stageIds = new Set(work.stages.map((s) => s.stageId));
    if (work.status === "completed" && !input.rework_stages.length)
      throw new Error(
        "Completed work must be explicitly reopened before assigning new work",
      );
    if (input.final_acceptance && input.integrate_delivery_ids.length)
      throw new Error(
        "Read and check the new integrated revision before accepting it",
      );
    if (
      input.complete &&
      (input.add_items.length ||
        input.add_stages.length ||
        input.start_acceptance.length ||
        input.rework_stages.length ||
        input.cancel)
    )
      throw new Error(
        "Completion cannot be combined with new or reopened work",
      );
    const reopened = new Set(input.rework_stages.map((s) => s.stage_id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const stage of work.stages)
        if (
          !reopened.has(stage.stageId) &&
          stage.dependsOn.some((id) => reopened.has(id))
        ) {
          reopened.add(stage.stageId);
          grew = true;
        }
    }
    for (const confirmation of input.confirm_stages) {
      const newStageWork =
        input.add_items.some((i) => i.stageId === confirmation.stage_id) ||
        input.start_acceptance.some(
          (a) =>
            a.item?.stageId === confirmation.stage_id ||
            work.deliveries.some(
              (d) =>
                d.deliveryId === a.delivery_id &&
                work.items.some(
                  (i) =>
                    i.itemId === d.itemId &&
                    i.stageId === confirmation.stage_id,
                ),
            ),
        );
      if (
        newStageWork ||
        reopened.has(confirmation.stage_id) ||
        input.block_items.some(
          (b) =>
            b.reason !== null &&
            work.items.some(
              (i) =>
                i.itemId === b.item_id && i.stageId === confirmation.stage_id,
            ),
        )
      )
        throw new Error(
          "A stage cannot be confirmed in the same decision that assigns, blocks or reopens its work",
        );
    }
    for (const s of input.add_stages) {
      if (stageIds.has(s.stageId)) throw new Error("Stage ID already exists");
      stageIds.add(s.stageId);
    }
    for (const i of input.add_items) {
      if (itemIds.has(i.itemId)) throw new Error("Item ID already exists");
      if (!stageIds.has(i.stageId)) throw new Error("Item stage is unknown");
      itemIds.add(i.itemId);
    }
    for (const change of [...input.rework_stages, ...input.confirm_stages])
      if (!stageIds.has(change.stage_id)) throw new Error("Stage is unknown");
    for (const change of input.block_items)
      if (!work.items.some((i) => i.itemId === change.item_id))
        throw new Error("Item is unknown");
    for (const id of input.cancel_items)
      if (!work.items.some((i) => i.itemId === id))
        throw new Error("Item is unknown");
    for (const response of input.approval_responses)
      if (!work.items.some((i) => i.taskId === response.task_id))
        throw new Error("Approval task does not belong to this work");
    for (const start of input.start_acceptance) {
      if (
        !work.deliveries.some((d) => d.deliveryId === start.delivery_id) ||
        work.acceptances.some((a) => a.acceptanceId === start.acceptance_id)
      )
        throw new Error("Acceptance requires a saved delivery and a unique ID");
      if (
        start.executor === "zcode" &&
        (!start.item || itemIds.has(start.item.itemId))
      )
        throw new Error("ZCode acceptance requires a unique work item");
    }
    for (const a of input.acceptance_results) {
      const acceptance = work.acceptances.find(
        (v) => v.acceptanceId === a.acceptance_id,
      );
      if (!acceptance || acceptance.status !== "running")
        throw new Error("Acceptance is not running");
      if (acceptance.itemId) {
        const item = work.items.find((i) => i.itemId === acceptance.itemId)!;
        if (
          item.queueAt !== null ||
          (item.taskId && this.ctx.store.getTask(item.taskId).leaseHeld)
        )
          throw new Error(
            "Wait for the ZCode acceptance executor to stop before recording its conclusion",
          );
      }
    }
    for (const confirmation of input.confirm_stages) {
      const stage = work.stages.find(
        (s) => s.stageId === confirmation.stage_id,
      );
      if (!stage) throw new Error("Confirm a stage after registering it");
      if (
        work.items
          .filter((i) => i.stageId === stage.stageId)
          .some(
            (i) =>
              (i.taskId && this.ctx.store.getTask(i.taskId).leaseHeld) ||
              (!i.cancelled && (i.queueAt !== null || !i.taskId)),
          )
      )
        throw new Error(
          "Stage still has unfinished implementation or acceptance work",
        );
      if (
        stage.dependsOn.some(
          (id) =>
            !work.stages.find((s) => s.stageId === id)?.confirmation &&
            !input.confirm_stages.some((s) => s.stage_id === id),
        )
      )
        throw new Error("Confirm the stage dependencies first");
      for (const item of work.items.filter(
        (i) =>
          i.stageId === stage.stageId &&
          i.kind === "implementation" &&
          !i.cancelled,
      )) {
        const latest = work.deliveries
          .filter((d) => d.itemId === item.itemId)
          .at(-1);
        if (!latest || !confirmation.delivery_ids.includes(latest.deliveryId))
          throw new Error(
            "Stage confirmation must reference the latest saved delivery for every implementation item",
          );
      }
      for (const id of confirmation.delivery_ids)
        if (
          !work.deliveries.some(
            (d) =>
              d.deliveryId === id &&
              work.items.some(
                (i) => i.itemId === d.itemId && i.stageId === stage.stageId,
              ),
          )
        )
          throw new Error(
            "Stage confirmation references an unrelated delivery",
          );
      for (const acceptance of work.acceptances.filter((a) =>
        confirmation.delivery_ids.includes(a.deliveryId),
      )) {
        const result = input.acceptance_results.find(
          (r) => r.acceptance_id === acceptance.acceptanceId,
        );
        if (acceptance.status !== "passed" && result?.status !== "passed")
          throw new Error(
            "Acceptance of a confirmed delivery is unfinished or failed",
          );
        if (!confirmation.acceptance_ids.includes(acceptance.acceptanceId))
          throw new Error(
            "Reference the acceptance result used for this stage confirmation",
          );
      }
      for (const id of confirmation.acceptance_ids) {
        const a = work.acceptances.find((a) => a.acceptanceId === id);
        const result = input.acceptance_results.find(
          (r) => r.acceptance_id === id,
        );
        if (
          !a ||
          !(a.status === "passed" || result?.status === "passed") ||
          !confirmation.delivery_ids.includes(a.deliveryId)
        )
          throw new Error("Stage acceptance must pass for this exact delivery");
      }
    }
    if (
      input.final_acceptance &&
      input.final_acceptance.revision !== work.integrationRevision
    )
      throw new Error(
        "Final acceptance must reference the current integrated revision",
      );
    const proposed = structuredClone(work);
    this.applyDecision(proposed, input);
    this.ctx.store.work.validate(proposed);
    for (const confirmation of input.confirm_stages) {
      const stage = proposed.stages.find(
        (s) => s.stageId === confirmation.stage_id,
      )!;
      if (
        stage.dependsOn.some(
          (id) => !proposed.stages.find((s) => s.stageId === id)?.confirmation,
        )
      )
        throw new Error(
          "Confirm the stage dependencies after applying this decision",
        );
    }
    if (input.complete) {
      const confirmedDeliveries = new Set(
        proposed.stages.flatMap((s) => s.confirmation?.deliveryIds ?? []),
      );
      if (
        proposed.stages.some(
          (s) => !s.confirmation || s.rework || s.blockedReason,
        ) ||
        proposed.items.some((i) => !i.cancelled && i.blockedReason) ||
        proposed.acceptances.some(
          (a) =>
            a.status === "running" ||
            (confirmedDeliveries.has(a.deliveryId) && a.status !== "passed"),
        )
      )
        throw new Error(
          "Completion requires confirmed stages and passed acceptance after applying this decision",
        );
      if (
        proposed.items.some(
          (i) =>
            (i.taskId && this.ctx.store.getTask(i.taskId).leaseHeld) ||
            (!i.cancelled && (i.queueAt !== null || !i.taskId)),
        )
      )
        throw new Error("Work still has unfinished execution or acceptance");
      if (
        input.integrate_delivery_ids.length ||
        !proposed.integrationRevision ||
        proposed.finalAcceptance?.revision !== proposed.integrationRevision
      )
        throw new Error(
          "Completion requires acceptance of the actual integrated result",
        );
      const expected = proposed.stages.flatMap(
        (s) => s.confirmation?.deliveryIds ?? [],
      );
      if (expected.some((id) => !proposed.integratedDeliveryIds.includes(id)))
        throw new Error(
          "Confirmed deliveries must be integrated before completion",
        );
    }
  }
  private reopen(work: Work, stageId: string, reason: string): void {
    const changed = new Set([stageId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const stage of work.stages)
        if (
          !changed.has(stage.stageId) &&
          stage.dependsOn.some((id) => changed.has(id))
        ) {
          changed.add(stage.stageId);
          grew = true;
        }
    }
    for (const stage of work.stages)
      if (changed.has(stage.stageId)) {
        const started =
          stage.stageId === stageId ||
          stage.confirmation !== null ||
          stage.rework ||
          work.items.some(
            (i) => i.stageId === stage.stageId && i.taskId !== null,
          );
        stage.confirmation = null;
        stage.rework = started;
        stage.blockedReason = stage.stageId === stageId ? reason : null;
      }
    work.finalAcceptance = null;
  }
  async wait(input: {
    work_id: string;
    commander_id: string;
    after_revision?: number;
    timeout_sec: number;
  }) {
    const end = Date.now() + input.timeout_sec * 1000;
    const store = this.ctx.store.work;
    let work = store.get(input.work_id);
    if (work.commanderId !== input.commander_id)
      return {
        controlTransferred: true,
        work: store.briefView(work.workId),
        events: [],
        timedOut: false,
      };
    const after = input.after_revision ?? 0;
    while (
      work.revision <= after &&
      work.status === "active" &&
      !this.closed &&
      Date.now() < end
    ) {
      await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
      work = store.get(work.workId);
      if (work.commanderId !== input.commander_id) break;
    }
    const events = store.events(work.workId, after);
    if (!events.length && work.commanderId === input.commander_id)
      return {
        workId: work.workId,
        revision: work.revision,
        status: work.status,
        timedOut: true,
      };
    return {
      work: store.briefView(work.workId),
      events,
      timedOut: events.length === 0,
      controlTransferred: work.commanderId !== input.commander_id,
    };
  }
  async resolveTodo(input: {
    work_id: string;
    todo_id: string;
    action: "approve_partial" | "retry" | "resolve";
    available_accounts?: number;
    user_confirmed: true;
  }) {
    if (input.user_confirmed !== true)
      throw new Error("A user action is required");
    this.ctx.store.work.update(
      input.work_id,
      (w) => {
        const todo = w.todos.find((t) => t.todoId === input.todo_id);
        if (!todo) throw new Error("Todo is no longer pending");
        if (input.action === "approve_partial") {
          if (
            todo.kind !== "resource_shortage" ||
            !input.available_accounts ||
            input.available_accounts > this.ctx.store.work.requestedAccounts(w)
          )
            throw new Error("Invalid partial resource confirmation");
          w.partialApproval = input.available_accounts;
        }
        if (input.action === "retry")
          for (const item of w.items)
            if (todo.itemIds.includes(item.itemId)) item.blockedReason = null;
        w.todos = w.todos.filter((t) => t.todoId !== input.todo_id);
      },
      "user_decision",
    );
    await this.pump();
    return this.ctx.store.work.view(input.work_id);
  }
  pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    const operation = (async () => {
      if (this.closed || this.ctx.closing) return;
      await this.collect();
      await this.schedule();
    })()
      .catch(() => {
        if (this.closed || this.ctx.closing) return;
        console.error(
          "ZCode scheduling failed; pending work requires inspection",
        );
        for (const work of this.ctx.store.work
          .list()
          .filter((w) => w.status === "active"))
          this.ctx.store.work.todo(
            work.workId,
            "blocked",
            "Scheduling could not be verified. Inspect daemon diagnostics and retry; saved work and account leases are retained",
          );
      })
      .finally(() => {
        if (this.pumping === operation) this.pumping = null;
      });
    this.pumping = operation;
    return operation;
  }
  private async collect(): Promise<void> {
    const store = this.ctx.store;
    for (const work of store.work.list())
      for (const item of work.items) {
        const dependencyWait =
          "Shared execution waits for saved dependency deliveries to be integrated into the project";
        const missing =
          !item.cancelled &&
          item.queueAt !== null &&
          this.missingSharedDependencies(work, item).length > 0;
        if (missing)
          store.work.todo(work.workId, "decision", dependencyWait, [
            item.itemId,
          ]);
        else if (
          work.todos.some(
            (t) =>
              t.summary === dependencyWait && t.itemIds.includes(item.itemId),
          )
        )
          store.work.update(
            work.workId,
            (w) => {
              w.todos = w.todos.filter(
                (t) =>
                  !(
                    t.summary === dependencyWait &&
                    t.itemIds.includes(item.itemId)
                  ),
              );
            },
            "dependency_materials_ready",
          );
        if (!item.taskId || item.queueAt !== null) continue;
        const task = store.getTask(item.taskId);
        if (task.leaseHeld) {
          if (
            ["waiting_approval", "blocked"].includes(task.status) ||
            (task.status === "interrupted" &&
              store.hasEnteredVerification(task.taskId))
          )
            store.work.todo(
              work.workId,
              "decision",
              task.status === "waiting_approval"
                ? "A native approval needs the commander decision"
                : "Execution needs inspection; the original account remains occupied",
              [item.itemId],
            );
          const needsAttention =
            task.status === "interrupted" &&
            (record(task.detail).requiresInspection === true ||
              record(task.detail).silent === true);
          if (needsAttention && !item.attentionKey)
            store.work.update(
              work.workId,
              (w) => {
                w.items.find((i) => i.itemId === item.itemId)!.attentionKey =
                  task.taskId;
              },
              "execution_needs_verification",
              {
                itemId: item.itemId,
                taskId: task.taskId,
                summary:
                  "Execution is unverified; read-only recovery continues and the account remains occupied",
              },
            );
          if (!needsAttention && item.attentionKey)
            store.work.update(
              work.workId,
              (w) => {
                w.items.find((i) => i.itemId === item.itemId)!.attentionKey =
                  null;
              },
              "execution_observation_restored",
              { itemId: item.itemId, taskId: task.taskId },
            );
          continue;
        }
        const result = store.getResult(task.taskId),
          manifest = result?.artifacts.find((a) => a.kind === "file_manifest");
        if (manifest && !work.deliveries.some((d) => d.taskId === task.taskId))
          store.work.update(
            work.workId,
            (w) =>
              w.deliveries.push({
                deliveryId: `delivery_${task.taskId}`,
                itemId: item.itemId,
                taskId: task.taskId,
                workspaceId: task.workspaceId,
                manifestSha256: manifest.sha256,
                summary: result!.summary,
                changedFiles: result!.changedFiles,
                createdAt: result!.createdAt,
              }),
            "delivery_saved",
            {
              itemId: item.itemId,
              taskId: task.taskId,
              summary: result!.summary,
            },
          );
        if (
          task.status === "failed" &&
          !work.todos.some((t) => t.itemIds.includes(item.itemId))
        )
          store.work.todo(
            work.workId,
            "blocked",
            result?.blockers.join("; ") ||
              "Execution failed; the commander must decide rework",
            [item.itemId],
          );
      }
    for (const work of store.work.list().filter((w) => w.status !== "active"))
      for (const workspaceId of new Set(
        [
          ...work.items.map((i) => i.workspaceId),
          ...work.acceptances.map((a) => a.workspaceId),
        ].filter((id): id is string => !!id),
      )) {
        const ws = store.getWorkspace(workspaceId);
        if (
          ws.state !== "active" ||
          ws.activeTaskId ||
          Date.now() - (this.cleanupAttempts.get(workspaceId) ?? 0) < 60_000
        )
          continue;
        if (
          store.work
            .list()
            .some(
              (w) =>
                w.workId !== work.workId &&
                w.status === "active" &&
                w.items.some((i) => i.workspaceId === workspaceId),
            )
        )
          continue;
        this.cleanupAttempts.set(workspaceId, Date.now());
        try {
          if (await cleanupWorkspace(this.ctx.root, ws))
            store.setWorkspaceState(
              workspaceId,
              work.status === "completed" ? "merged" : "abandoned",
            );
        } catch {
          store.work.todo(
            work.workId,
            "blocked",
            "Saved results are safe; temporary workspace cleanup needs inspection",
          );
        }
      }
  }
  private async accountCapacity(): Promise<{
    accounts: AccountSummary[];
    workers: any[];
    available: AccountSummary[];
    usableAccounts: number;
    allLow: boolean;
  }> {
    const accounts = (await this.ctx.vault.list()).filter(
      (a) =>
        this.ctx.store.work.enabled(a.alias) &&
        !["blocked", "invalid", "cooling"].includes(a.health),
    );
    const workers = await this.ctx.supervisor.list();
    for (const account of accounts) {
      const cache = this.quota.get(account.alias);
      if (!cache || Date.now() - cache.at > 120_000) {
        try {
          const probe = await this.ctx.probeAccount(account.alias);
          const snapshot = resolveQuotaSnapshot({
            source: "live_probe",
            accountAlias: account.alias,
            providerId: probe.providerId,
            rawQuota: probe.quota,
            observedAtMs: Date.now(),
            freshness: "fresh",
          });
          const percentage = snapshot.percentage;
          const remaining =
            percentage?.scale === "0_to_100" ? percentage.value : null;
          const exhausted = snapshot.remaining === 0 || remaining === 0;
          this.quota.set(account.alias, {
            remaining,
            exhausted,
            at: Date.now(),
            usable:
              probe.quota.authenticated !== false &&
              !["no_plan", "not_configured"].includes(
                String(probe.quota.unavailableReason),
              ) &&
              remaining !== null &&
              !exhausted,
          });
        } catch {
          this.quota.set(account.alias, {
            remaining: null,
            exhausted: false,
            at: Date.now(),
            usable: false,
          });
        }
      }
    }
    const threshold = this.ctx.store.getPoolPolicy().lowQuotaThresholdPercent;
    const eligible = accounts.filter((a) => {
      const value = this.quota.get(a.alias);
      return (
        value?.usable === true &&
        value.remaining !== null &&
        value.remaining >= threshold
      );
    });
    const held = new Set(
      this.ctx.store
        .listTasks()
        .filter((t) => t.leaseHeld)
        .map(
          (t) =>
            record(t.runtimeBinding).accountAlias ??
            workers.find((w) => w.workerId === t.workerId)?.accountAlias,
        ),
    );
    return {
      accounts,
      workers,
      available: eligible.filter((a) => !held.has(a.alias)),
      usableAccounts: eligible.length,
      allLow:
        accounts.length > 0 &&
        accounts.every((a) => {
          const value = this.quota.get(a.alias);
          return (
            value?.exhausted === true ||
            (value?.remaining !== null &&
              value?.remaining !== undefined &&
              value.remaining < threshold)
          );
        }),
    };
  }
  private missingSharedDependencies(work: Work, item: WorkItem): Delivery[] {
    if (item.workspace !== "shared" || item.targetDeliveryId) return [];
    return item.dependsOn.flatMap((id) => {
      const prior = work.items.find((i) => i.itemId === id);
      if (prior?.workspace !== "isolated") return [];
      const latest = work.deliveries.filter((d) => d.itemId === id).at(-1);
      return latest && !work.integratedDeliveryIds.includes(latest.deliveryId)
        ? [latest]
        : [];
    });
  }
  private runnable(work: Work, item: WorkItem): boolean {
    if (
      item.cancelled ||
      item.blockedReason ||
      item.queueAt === null ||
      item.queueAt > Date.now() ||
      this.missingSharedDependencies(work, item).length > 0
    )
      return false;
    const stage = work.stages.find((s) => s.stageId === item.stageId)!;
    if (
      stage.dependsOn.some(
        (id) => !work.stages.find((s) => s.stageId === id)?.confirmation,
      )
    )
      return false;
    return item.dependsOn.every((id) => {
      const other = work.items.find((i) => i.itemId === id)!;
      return (
        other.taskId !== null &&
        other.queueAt === null &&
        this.ctx.store.getTask(other.taskId).status === "succeeded"
      );
    });
  }
  private async schedule(): Promise<void> {
    const store = this.ctx.store;
    let works = store.work
      .list()
      .filter(
        (w) =>
          w.status === "active" && w.items.some((i) => this.runnable(w, i)),
      );
    if (!works.length || store.getPoolPolicy().availableSlots === 0) return;
    const capacity = await this.accountCapacity();
    if (capacity.allLow) {
      for (const work of works)
        store.work.todo(
          work.workId,
          "all_accounts_low",
          "All enabled accounts are exhausted or below the configured remaining quota threshold; new dispatch is paused",
        );
      return;
    }
    for (const work of works)
      store.work.clearTodos(work.workId, "all_accounts_low");
    if (!capacity.available.length) {
      const held = store.listTasks().filter((t) => t.leaseHeld);
      for (const work of works) {
        const quota = store.work.effectiveAccounts(work);
        const owned = store.work
          .list()
          .filter((w) => w.commanderId === work.commanderId)
          .flatMap((w) => w.items)
          .filter(
            (i) => i.taskId && held.some((t) => t.taskId === i.taskId),
          ).length;
        if (quota === 0 || owned >= quota) continue;
        const usable = work.items.filter(
          (i) => i.taskId && held.some((t) => t.taskId === i.taskId),
        ).length;
        store.work.todo(
          work.workId,
          "resource_shortage",
          `Requested ${store.work.requestedAccounts(work)} accounts; ${usable} are currently usable with fresh confirmed quota. Wait for resources or change pool settings.`,
          [],
          usable,
        );
      }
      return;
    }
    const commanderOrder = () =>
      works.sort(
        (a, b) =>
          store.work.commander(a.commanderId).lastGrantedAt -
            store.work.commander(b.commanderId).lastGrantedAt ||
          Math.min(
            ...a.items
              .filter((i) => this.runnable(a, i))
              .map((i) => i.queueAt!),
          ) -
            Math.min(
              ...b.items
                .filter((i) => this.runnable(b, i))
                .map((i) => i.queueAt!),
            ),
      );
    commanderOrder();
    while (
      capacity.available.length &&
      store.getPoolPolicy().availableSlots !== 0 &&
      !this.ctx.closing
    ) {
      let dispatched = false;
      for (const stale of works) {
        const work = store.work.get(stale.workId);
        const quota = store.work.effectiveAccounts(work);
        const held = store.listTasks().filter((t) => t.leaseHeld);
        const owned = store.work
          .list()
          .filter((w) => w.commanderId === work.commanderId)
          .flatMap((w) => w.items)
          .filter(
            (i) => i.taskId && held.some((t) => t.taskId === i.taskId),
          ).length;
        if (quota === 0 || owned >= quota) continue;
        const activeForWork = work.items.filter(
          (i) => i.taskId && held.some((t) => t.taskId === i.taskId),
        ).length;
        const usable =
          Math.min(
            capacity.available.length,
            store.getPoolPolicy().availableSlots ?? 64,
          ) + activeForWork;
        if (usable < quota) {
          store.work.todo(
            work.workId,
            "resource_shortage",
            `Requested ${store.work.requestedAccounts(work)} accounts; ${usable} are currently usable. Confirm partial resources before dispatching fewer.`,
            [],
            usable,
          );
          const poolLimit = store.getPoolPolicy().maxConcurrentTasks;
          if (quota <= Math.min(capacity.usableAccounts, poolLimit ?? Infinity))
            return;
          continue;
        }
        store.work.clearTodos(work.workId, "resource_shortage");
        const item = work.items.find((i) => this.runnable(work, i));
        if (!item) continue;
        if (
          item.workspace === "shared" &&
          this.integrations.has(work.repositoryPath)
        )
          continue;
        const account = capacity.available.shift()!;
        try {
          let worker =
            capacity.workers.find(
              (w) => w.accountAlias === account.alias && w.state !== "stopped",
            ) ?? capacity.workers.find((w) => w.accountAlias === account.alias);
          const workerId = worker?.workerId ?? `worker-${account.alias}`;
          if (worker?.state !== "ready") {
            await this.ctx.call("start_worker", {
              worker_id: workerId,
              account_id: account.alias,
            });
            worker = { workerId, accountAlias: account.alias, state: "ready" };
            capacity.workers.push(worker);
          }
          const dispatch = async () => {
            const workspaceId = await this.prepare(work, item);
            if (store.getWorkspace(workspaceId).activeTaskId) return null;
            const requestId = `${work.workId}:${item.itemId}:${item.runIndex}`;
            return (
              store.findTaskByRequestId(requestId) ??
              (await this.ctx.dispatchWorkItem(work.workId, item.itemId, {
                workspace_id: workspaceId,
                worker_id: workerId,
                request_id: requestId,
                prompt: this.prompt(work, item),
                mode: item.mode,
                model_id: item.modelId,
                verify_commands: item.verifyCommands,
              }))
            );
          };
          const existing =
            item.workspace === "shared"
              ? await this.serialIntegration(work.repositoryPath, dispatch)
              : await dispatch();
          if (!existing) {
            capacity.available.push(account);
            continue;
          }
          store.work.granted(work.commanderId);
          dispatched = true;
          break;
        } catch (error) {
          store.work.update(
            work.workId,
            (w) => {
              w.items.find((i) => i.itemId === item.itemId)!.blockedReason =
                error instanceof Error
                  ? error.message
                  : "Dispatch preparation failed";
            },
            "work_blocked",
          );
          store.work.todo(
            work.workId,
            "blocked",
            "Execution could not be prepared; inspect the item and retry",
            [item.itemId],
          );
        }
      }
      if (!dispatched) break;
      works = works
        .map((w) => store.work.get(w.workId))
        .filter(
          (w) =>
            w.status === "active" && w.items.some((i) => this.runnable(w, i)),
        );
      if (!works.length) break;
    }
  }
  private async prepare(work: Work, item: WorkItem): Promise<string> {
    if (
      this.missingSharedDependencies(this.ctx.store.work.get(work.workId), item)
        .length
    )
      throw new Error(
        "Integrate the saved dependency deliveries before starting shared execution",
      );
    if (item.workspaceId) return item.workspaceId;
    const store = this.ctx.store;
    let ws;
    if (item.targetDeliveryId) {
      const delivery = work.deliveries.find(
        (d) => d.deliveryId === item.targetDeliveryId,
      )!;
      const result = store.getResult(delivery.taskId);
      if (!result) throw new Error("Acceptance delivery is unavailable");
      ws = await materializeDelivery(
        this.ctx.root,
        work.repositoryPath,
        delivery.taskId,
        result,
      );
    } else if (item.workspace === "shared") {
      const found = store
        .listWorkspaces()
        .find(
          (w) => w.worktreePath === work.repositoryPath && w.state === "active",
        );
      if (found) return found.workspaceId;
      const head = (
        await git(work.repositoryPath, ["rev-parse", "HEAD"])
      ).trim();
      const base = await saveWorkingTree(work.repositoryPath, head);
      ws = {
        repositoryPath: work.repositoryPath,
        worktreePath: work.repositoryPath,
        branch:
          (
            await git(work.repositoryPath, ["branch", "--show-current"])
          ).trim() || "detached",
        baseCommit: base,
      };
    } else {
      ws = await createWorkspace(this.ctx.root, work.repositoryPath, "HEAD");
      let version = ws.baseCommit;
      for (const dependency of item.dependsOn) {
        const prior = work.deliveries
          .filter((d) => d.itemId === dependency)
          .at(-1);
        if (!prior) throw new Error("Dependency has no saved delivery");
        const result = store.getResult(prior.taskId)!;
        const fixed = await deliveryCommit(
          this.ctx.root,
          work.repositoryPath,
          prior.taskId,
          result,
        );
        const base = store.getWorkspace(prior.workspaceId).baseCommit;
        const tree = (
          await git(work.repositoryPath, [
            "merge-tree",
            "--write-tree",
            "--merge-base",
            base,
            version,
            fixed,
          ])
        )
          .trim()
          .split("\n")[0]!;
        version = await treeCommit(work.repositoryPath, tree, version);
      }
      if (version !== ws.baseCommit)
        await git(ws.worktreePath, ["reset", "--hard", version]);
    }
    const created = store.registerWorkspace(ws);
    await git(work.repositoryPath, [
      "update-ref",
      `refs/zcode-pool/workspaces/${created.workspaceId}/base`,
      created.baseCommit,
    ]);
    store.work.update(
      work.workId,
      (w) => {
        w.items.find((i) => i.itemId === item.itemId)!.workspaceId =
          created.workspaceId;
        if (item.acceptanceId) {
          const acceptance = w.acceptances.find(
            (a) => a.acceptanceId === item.acceptanceId,
          )!;
          acceptance.workspaceId = created.workspaceId;
          acceptance.workspacePath = created.worktreePath;
        }
      },
      "environment_prepared",
    );
    return created.workspaceId;
  }
  private prompt(work: Work, item: WorkItem): string {
    const prior = work.deliveries
      .filter(
        (d) => item.dependsOn.includes(d.itemId) || d.itemId === item.itemId,
      )
      .slice(-8)
      .map((d) => ({
        taskId: d.taskId,
        summary: d.summary,
        manifest: d.manifestSha256,
      }));
    if (item.handoffTaskId) {
      const result = this.ctx.store.getResult(item.handoffTaskId);
      if (result)
        prior.push({
          taskId: item.handoffTaskId,
          summary: result.summary,
          manifest:
            result.artifacts.find((a) => a.kind === "file_manifest")?.sha256 ??
            "",
        });
    }
    return `任务：${item.title}\n${item.prompt}\n完成依据：${work.stages.find((s) => s.stageId === item.stageId)!.criteria.join("；") || work.criteria.join("；")}\n约束：只在当前工作目录实施，不启动或派发子 agent。完成时简报修改、检查和未解决事项。${item.kind === "acceptance" ? "这是对固定交付快照的验收；保留原成果，报告证据和结论。" : ""}${prior.length ? "\n已保存成果与交接：" + JSON.stringify(prior) : ""}`;
  }
  private serialIntegration<T>(
    repository: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const prior = this.integrations.get(repository) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(action)
      .finally(() => {
        if (this.integrations.get(repository) === next)
          this.integrations.delete(repository);
      });
    this.integrations.set(repository, next);
    return next;
  }
  private assertProjectIdle(repository: string): void {
    if (
      this.ctx.store
        .listTasks()
        .some(
          (task) =>
            task.leaseHeld &&
            resolve(
              this.ctx.store.getWorkspace(task.workspaceId).worktreePath,
            ) === resolve(repository),
        )
    )
      throw new Error("The project directory is still in use");
  }
  private async integrate(
    work: Work,
    ids: string[],
    requestId: string,
  ): Promise<{ ids: string[]; revision: string }> {
    this.assertProjectIdle(work.repositoryPath);
    const deliveries = ids.map(
      (id) =>
        work.deliveries.find((d) => d.deliveryId === id) ??
        (() => {
          throw new Error("Unknown delivery");
        })(),
    );
    const scratch = await mkdtemp(join(tmpdir(), "zcode-integration-"));
    const before = await saveWorkingTree(work.repositoryPath);
    let mutationStarted = false;
    try {
      let after = before;
      for (const delivery of deliveries) {
        const result = this.ctx.store.getResult(delivery.taskId)!;
        const fixed = await deliveryCommit(
          this.ctx.root,
          work.repositoryPath,
          delivery.taskId,
          result,
        );
        const base = this.ctx.store.getWorkspace(
          delivery.workspaceId,
        ).baseCommit;
        const tree = (
          await git(work.repositoryPath, [
            "merge-tree",
            "--write-tree",
            "--merge-base",
            base,
            after,
            fixed,
          ])
        )
          .trim()
          .split("\n")[0]!;
        after = await treeCommit(work.repositoryPath, tree, after);
      }
      const actual = await saveWorkingTree(work.repositoryPath);
      if (
        (
          await git(work.repositoryPath, ["rev-parse", `${actual}^{tree}`])
        ).trim() !==
        (
          await git(work.repositoryPath, ["rev-parse", `${before}^{tree}`])
        ).trim()
      )
        throw new Error(
          "Project changed during integration preparation; retry the decision",
        );
      const patch = await git(work.repositoryPath, [
        "diff",
        "--binary",
        before,
        after,
        "--",
      ]);
      const patchFile = join(scratch, "integration.patch");
      await writeFile(patchFile, patch);
      if (patch.trim())
        await git(work.repositoryPath, ["apply", "--check", patchFile]);
      this.ctx.store.work.saveIntegrationIntent(requestId, before, after);
      await git(work.repositoryPath, [
        "update-ref",
        `refs/zcode-pool/work/${work.workId}/pending-before`,
        before,
      ]);
      await git(work.repositoryPath, [
        "update-ref",
        `refs/zcode-pool/work/${work.workId}/pending-after`,
        after,
      ]);
      if (patch.trim()) {
        mutationStarted = true;
        await git(work.repositoryPath, ["apply", patchFile]);
      }
      const revision = await saveWorkingTree(work.repositoryPath);
      await git(work.repositoryPath, [
        "update-ref",
        `refs/zcode-pool/work/${work.workId}/integrated`,
        revision,
      ]);
      return { ids, revision };
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error("Integration failed"),
        { integrationMayHaveApplied: mutationStarted },
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.pumping;
    await Promise.allSettled([...this.operations.values()]);
  }
}
