import type { DurableTaskStore } from "../core/store.js";
import type { SessionSnapshot } from "../runtime/types.js";
import {
  record,
  classifyTurnFailure,
  classifyError,
} from "../runtime/zcode-server/events.js";
import { extractRetryAfterMs } from "../runtime/zcode-server/events.js";
import type {
  Active,
  CoordinatorRecoveryContext,
} from "./coordinator-helpers.js";
import {
  observeSnapshot,
  taskSummary,
  captureDelivery,
} from "./coordinator-helpers.js";
import { snapshotWorkspace } from "./workspace.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

interface RecoveryContext extends CoordinatorRecoveryContext {
  sendRecoveryAttempt(taskId: string, active: Active): Promise<void>;
  recoverTasks(): Promise<unknown>;
  workService: { markQuotaUnavailable(accountAlias: string): void };
}
function quotaExhausted(value: unknown): boolean {
  return /quota[ _-]?(?:exceeded|exhausted)|insufficient[ _-]?(?:quota|balance|credit)|额度.{0,12}(?:不足|耗尽|用尽)|余额不足|配额.{0,12}(?:不足|耗尽|用尽)/i.test(
    JSON.stringify(
      value instanceof Error
        ? { message: value.message, cause: value.cause }
        : value,
    ),
  );
}
export function retryableFailure(data: {
  category?: unknown;
  errorAttribution?: unknown;
  error?: unknown;
}): boolean {
  return (
    data.errorAttribution === "turn" &&
    ["model_busy", "rate_limited", "server_error"].includes(
      String(data.category),
    ) &&
    !quotaExhausted(data.error ?? data)
  );
}
/** Only transport/service setup faults are transient; policy and identity failures need a decision. */
function retryableSetupFailure(error: unknown): boolean {
  const category = classifyError(error);
  if (
    quotaExhausted(error) ||
    ["auth_invalid", "risk_blocked"].includes(category)
  )
    return false;
  if (["model_busy", "rate_limited"].includes(category)) return true;
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth++) {
    const value = record(current);
    if (
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "EPIPE",
        "ETIMEDOUT",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "EAI_AGAIN",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
      ].includes(value.code) ||
      value.name === "TimeoutError"
    )
      return true;
    if ([429, 500, 502, 503, 504].includes(value.status ?? value.statusCode))
      return true;
    if (
      /^Official (?:RPC .*timed out|conversation snapshot timed out|server WebSocket closed|RPC connection is closed|server-info HTTP (?:429|500|502|503|504))/.test(
        String(value.message ?? ""),
      )
    )
      return true;
    current = value.cause;
  }
  return false;
}
/** Recovery uses the original session and only advances after a checked stop proof. */
export class ExecutionRecovery {
  private readonly timer: ReturnType<typeof setInterval>;
  private running = false;
  private closed = false;
  private readonly fingerprints = new Map<string, string>();
  constructor(private readonly ctx: RecoveryContext) {
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
  }
  async saveUndispatched(
    taskId: string,
    evidence: string,
    notBefore = Date.now(),
  ): Promise<boolean> {
    const store = this.ctx.store;
    const task = store.getTask(taskId);
    if (task.dispatchAttemptedAt !== null)
      throw new Error(
        "Dispatch intent exists; execution cannot be assumed stopped",
      );
    notBefore = Math.max(notBefore, store.work.execution(taskId).retryAt ?? 0);
    const captured = await captureDelivery(
      this.ctx.root,
      taskId,
      store.getWorkspace(task.workspaceId),
    );
    const owner = store.work
      .list()
      .find(
        (w) =>
          w.status === "active" &&
          w.items.some((i) => i.taskId === taskId && !i.cancelled),
      );
    store.completeTask(
      taskId,
      {
        summary:
          "Native setup stopped before any model command; saved for safe continuation",
        ...captured,
      },
      {
        status: "failed",
        executionStopped: { kind: "not_dispatched", evidence },
        ...(owner ? { requeueWork: { workId: owner.workId, notBefore } } : {}),
      },
    );
    store.work.updateExecution(taskId, {
      observation: "stopped",
      waitingSince: null,
      retryAt: null,
      nativeErrorsComplete: true,
      nativeErrorsReason: "not_dispatched",
      lastObservedAt: Date.now(),
    });
    return !!owner;
  }
  async retrySetup(
    taskId: string,
    error: unknown,
    accountAlias: string,
  ): Promise<boolean> {
    const store = this.ctx.store;
    let task = store.getTask(taskId);
    if (task.dispatchAttemptedAt !== null) throw error;
    if (
      this.closed ||
      this.ctx.closing ||
      task.cancelRequestedAt !== null ||
      !task.leaseHeld
    )
      return false;
    if (!retryableSetupFailure(error)) throw error;
    const facts = store.work.execution(taskId);
    const at = Date.now();
    const retryAt =
      at +
      Math.max(
        store.getPoolPolicy().retryIntervalMs,
        extractRetryAfterMs(error, at) ?? 0,
      );
    store.work.recordError(
      taskId,
      task.currentCommandId,
      classifyError(error) === "unknown"
        ? "server_error"
        : classifyError(error),
      "Transient native setup failure before model dispatch",
      `setup:${facts.errorCount + 1}`,
      { accountAlias, occurredAt: at },
    );
    store.work.updateExecution(taskId, {
      waitingSince: facts.waitingSince ?? at,
      retryAt,
      observation: "recovering",
      lastObservedAt: at,
    });
    store.appendEvent(taskId, "retry_wait", {
      phase: "native_setup",
      retryAt,
      waitingSince: facts.waitingSince ?? at,
    });
    while (!this.closed && !this.ctx.closing) {
      task = store.getTask(taskId);
      if (
        task.cancelRequestedAt !== null ||
        !task.leaseHeld ||
        task.status !== "queued"
      )
        return false;
      const waiting = store.work.execution(taskId);
      if (
        waiting.waitingSince !== null &&
        Date.now() - waiting.waitingSince >=
          store.getPoolPolicy().recoveryWaitMs &&
        store.work
          .list()
          .some(
            (w) =>
              w.status === "active" && w.items.some((i) => i.taskId === taskId),
          )
      ) {
        await this.saveUndispatched(
          taskId,
          "Only native setup was attempted; no durable model dispatch intent exists",
          Math.max(Date.now(), retryAt),
        );
        return false;
      }
      if (Date.now() >= retryAt) return true;
      await new Promise((r) =>
        setTimeout(r, Math.min(250, retryAt - Date.now())),
      );
    }
    return false;
  }
  private async fresh(active: Active): Promise<SessionSnapshot> {
    if (!active.session || !active.connection.freshReadSession)
      throw new Error("Fresh native read is unavailable");
    return active.connection.freshReadSession(active.session);
  }
  async retry(taskId: string, active: Active): Promise<boolean> {
    const store = this.ctx.store;
    let task = store.getTask(taskId);
    let attempt = store.getCurrentAttempt(taskId);
    if (!attempt?.busyRetryEligible || attempt.continuationBlocked)
      return false;
    let snapshot = await this.fresh(active);
    let observation = observeSnapshot(task, active.session!, snapshot);
    if (
      observation.kind !== "terminal" ||
      observation.header!.state !== "failed"
    )
      throw new Error(
        "Retry requires the exact failed command with no native active, queued, pending or background work",
      );
    const failure = classifyTurnFailure(
      record(snapshot.raw),
      observation.header!,
    );
    if (!retryableFailure(failure)) return false;
    const binding = record(task.runtimeBinding);
    const account =
      typeof binding.accountAlias === "string"
        ? await this.ctx.vault.load(binding.accountAlias)
        : null;
    if (
      !account ||
      ["blocked", "invalid", "cooling"].includes(account.health) ||
      active.accountAlias !== binding.accountAlias
    )
      return false;
    if (
      !snapshot.modelSelection ||
      snapshot.modelSelection.providerId !== binding.providerId ||
      snapshot.modelSelection.modelId !== binding.modelId
    )
      throw new Error(
        "The original native model binding changed; recovery send refused",
      );
    const rows = record(snapshot.raw).rows?.window ?? [];
    if (
      rows.some(
        (row: any) =>
          row.turnId === observation.header!.turnId &&
          (row.kind === "toolCall" ||
            (row.kind === "assistantText" &&
              typeof row.text === "string" &&
              row.text.trim())),
      )
    ) {
      store.work.noteActivity(taskId);
      return false;
    }
    // A transport failure after any visible execution belongs to the commander; never blindly replay it.
    const facts = store.work.execution(taskId);
    if (facts.executionCommandId === task.currentCommandId) return false;
    const at = Date.now();
    const retryAt =
      at +
      Math.max(
        store.getPoolPolicy().retryIntervalMs,
        extractRetryAfterMs(failure.error ?? {}, at) ?? 0,
      );
    store.work.updateExecution(taskId, {
      waitingSince: facts.waitingSince ?? at,
      retryAt,
      observation: "recovering",
      lastObservedAt: at,
    });
    store.appendEvent(taskId, "retry_wait", {
      category: failure.category,
      retryAt,
      waitingSince: facts.waitingSince ?? at,
    });
    while (!this.closed && !this.ctx.closing) {
      task = store.getTask(taskId);
      if (task.cancelRequestedAt !== null) return false;
      const current = store.work.execution(taskId);
      const waitingSince = current.waitingSince;
      const owner = store.work
        .list()
        .find(
          (w) =>
            w.status === "active" && w.items.some((i) => i.taskId === taskId),
        );
      if (
        owner &&
        waitingSince !== null &&
        Date.now() - waitingSince >= store.getPoolPolicy().recoveryWaitMs
      ) {
        snapshot = await this.fresh(active);
        observation = observeSnapshot(task, active.session!, snapshot);
        if (
          observation.kind !== "terminal" ||
          observation.header!.state !== "failed"
        )
          throw new Error(
            "Waiting expired but original execution is not confirmed stopped; occupancy retained",
          );
        await this.yield(
          taskId,
          active,
          snapshot,
          observation.header!,
          owner.workId,
          Math.max(Date.now(), current.retryAt ?? 0),
        );
        return true;
      }
      if (Date.now() >= (current.retryAt ?? retryAt)) break;
      await new Promise((r) =>
        setTimeout(r, Math.min(250, (current.retryAt ?? retryAt) - Date.now())),
      );
    }
    if (this.closed || this.ctx.closing)
      throw new Error("Recovery observation closed; retry intent was not sent");
    task = store.getTask(taskId);
    snapshot = await this.fresh(active);
    observation = observeSnapshot(task, active.session!, snapshot);
    if (
      observation.kind !== "terminal" ||
      observation.header!.state !== "failed"
    )
      throw new Error(
        "Native command changed during retry waiting; occupancy retained",
      );
    this.ctx.recordFailure(
      taskId,
      task.currentCommandId,
      classifyTurnFailure(record(snapshot.raw), observation.header!),
    );
    attempt = store.getCurrentAttempt(taskId);
    if (
      !attempt?.busyRetryEligible ||
      attempt.continuationBlocked ||
      task.cancelRequestedAt !== null
    )
      return false;
    const proof = {
      kind: "history_stopped" as const,
      evidence: `Fresh snapshot: command ${task.currentCommandId} failed with no native work`,
    };
    store.recordAttemptTerminal(taskId, task.currentCommandId, "failed", proof);
    store.beginBusyContinuation(taskId, task.currentCommandId);
    await this.ctx.sendRecoveryAttempt(taskId, active);
    return true;
  }
  async yield(
    taskId: string,
    active: Active,
    snapshot: SessionSnapshot,
    header: Record<string, any>,
    workId: string,
    notBefore = Date.now(),
  ): Promise<void> {
    const store = this.ctx.store;
    const task = store.getTask(taskId);
    const captured = await captureDelivery(
      this.ctx.root,
      taskId,
      store.getWorkspace(task.workspaceId),
    );
    const proof = {
      kind: "history_stopped" as const,
      evidence: `Fresh snapshot command ${task.currentCommandId}: ${header.state}; no active, queued, pending or background work`,
    };
    // Result and context are durable before freeing either lease.
    store.completeTask(
      taskId,
      {
        summary: taskSummary(task, snapshot, header),
        ...captured,
        blockers: [
          "Saved for safe account handoff; the original goal remains queued",
        ],
      },
      {
        status: "failed",
        executionStopped: proof,
        requeueWork: { workId, notBefore },
      },
    );
    store.work.updateExecution(taskId, {
      observation: "stopped",
      lastObservedAt: Date.now(),
      waitingSince: null,
      retryAt: null,
    });
  }
  async admissionRejected(taskId: string, evidence: string): Promise<boolean> {
    const store = this.ctx.store;
    const task = store.getTask(taskId);
    const owner = store.work
      .list()
      .find(
        (w) =>
          w.status === "active" && w.items.some((i) => i.taskId === taskId),
      );
    const captured = await captureDelivery(
      this.ctx.root,
      taskId,
      store.getWorkspace(task.workspaceId),
    );
    store.work.recordError(
      taskId,
      task.currentCommandId,
      "server_error",
      "Native admission rejected before execution",
    );
    store.completeTask(
      taskId,
      {
        summary:
          "The original command was rejected before execution; saved for a new session",
        ...captured,
      },
      {
        status: "failed",
        executionStopped: { kind: "admission_rejected", evidence },
        ...(owner
          ? { requeueWork: { workId: owner.workId, notBefore: Date.now() } }
          : {}),
      },
    );
    store.work.updateExecution(taskId, {
      observation: "stopped",
      nativeErrorsComplete: true,
      nativeErrorsReason: "admission_rejected_before_execution",
      lastObservedAt: Date.now(),
    });
    return !!owner;
  }
  async handoffQuota(
    taskId: string,
    active: Active,
    snapshot: SessionSnapshot,
    header: Record<string, any>,
  ): Promise<boolean> {
    if (
      !quotaExhausted(classifyTurnFailure(record(snapshot.raw), header).error)
    )
      return false;
    const alias = record(
      this.ctx.store.getTask(taskId).runtimeBinding,
    ).accountAlias;
    if (typeof alias === "string")
      this.ctx.workService.markQuotaUnavailable(alias);
    const owner = this.ctx.store.work
      .list()
      .find(
        (w) =>
          w.status === "active" && w.items.some((i) => i.taskId === taskId),
      );
    if (!owner) return false;
    await this.yield(taskId, active, snapshot, header, owner.workId);
    return true;
  }
  private signature(taskId: string, snapshot: SessionSnapshot): string {
    const task = this.ctx.store.getTask(taskId);
    const rows = record(snapshot.raw).rows?.window ?? [];
    const headers = rows.filter(
      (r: any) =>
        r.kind === "turnHeader" && r.sourceCommandId === task.currentCommandId,
    );
    const nativeId = headers.length === 1 ? headers[0].turnId : null;
    return JSON.stringify(
      rows
        .filter(
          (r: any) =>
            (r.sourceCommandId === task.currentCommandId ||
              r.turnId === nativeId) &&
            ["assistantText", "toolCall"].includes(r.kind),
        )
        .map((r: any) => [
          r.rowId,
          r.kind,
          r.text,
          r.inputText,
          r.status,
          r.output,
          r.progress,
          r.outputPreview,
        ]),
    );
  }
  private async tick(): Promise<void> {
    if (this.running || this.closed || this.ctx.closing) return;
    this.running = true;
    try {
      for (const task of this.ctx.store
        .listTasks()
        .filter((t) => t.leaseHeld && !t.executionStopped)) {
        const facts = this.ctx.store.work.execution(task.taskId);
        const interval = this.ctx.store.getPoolPolicy().silenceCheckMs;
        if (
          Date.now() - facts.lastVisibleActivityAt < interval ||
          (facts.lastObservedAt !== null &&
            Date.now() - facts.lastObservedAt < interval)
        )
          continue;
        const active = this.ctx.active.get(task.taskId);
        if (!active?.session) continue;
        try {
          const snapshot = await this.fresh(active);
          const observation = observeSnapshot(task, active.session, snapshot);
          const signature = this.signature(task.taskId, snapshot);
          const previous = this.fingerprints.get(task.taskId);
          this.fingerprints.set(task.taskId, signature);
          const newActivity =
            signature !== "[]" &&
            (facts.executionCommandId !== task.currentCommandId ||
              (previous !== undefined && signature !== previous));
          if (newActivity) this.ctx.store.work.noteActivity(task.taskId);
          this.ctx.store.work.updateExecution(task.taskId, {
            lastObservedAt: Date.now(),
            observation:
              observation.kind === "active"
                ? newActivity
                  ? "executing"
                  : "silent"
                : observation.kind === "terminal"
                  ? "stopped"
                  : "unknown",
          });
          this.ctx.store.appendEvent(task.taskId, "silence_checked", {
            observation: observation.kind,
            newVisibleActivity: newActivity,
          });
          if (observation.kind === "unknown")
            this.ctx.store.markInterrupted(task.taskId, {
              reason: observation.reason ?? "Execution requires verification",
              silent: true,
            });
          if (observation.kind !== "active") await active.connection.close();
        } catch {
          this.ctx.store.work.updateExecution(task.taskId, {
            lastObservedAt: Date.now(),
            observation: "unknown",
          });
        }
      }
      const waiting = this.ctx.store
        .listTasks()
        .filter(
          (t) =>
            t.leaseHeld &&
            t.status === "interrupted" &&
            !this.ctx.jobs.has(t.taskId),
        );
      if (
        waiting.some((t) => {
          const f = this.ctx.store.work.execution(t.taskId);
          return (
            f.lastObservedAt === null ||
            Date.now() - f.lastObservedAt >=
              this.ctx.store.getPoolPolicy().retryIntervalMs
          );
        })
      ) {
        for (const task of waiting)
          this.ctx.store.work.updateExecution(task.taskId, {
            lastObservedAt: Date.now(),
          });
        await this.ctx.recoverTasks();
      }
    } finally {
      this.running = false;
    }
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}
