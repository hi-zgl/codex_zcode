import { resolve } from "node:path";
import type { RuntimeConnection, TurnRef } from "../runtime/types.js";
import type { JsonValue, StopProof } from "../core/types.js";
import { record, classifyTurnFailure } from "../runtime/zcode-server/events.js";
import {
  UNAVAILABLE_HEALTH,
  compactTask,
  approvalView,
  taskPolicy,
  observeSnapshot,
  ownApprovals,
  taskSummary,
  captureDelivery,
  type Active,
  type ApprovalView,
  type RecoveryResult,
  type CoordinatorRecoveryContext,
} from "./coordinator-helpers.js";

export function inspection(
  ctx: CoordinatorRecoveryContext,
  taskId: string,
  reason: string,
): RecoveryResult {
  const task = ctx.store.recordRecoveryInspection(taskId, {
    reason,
    requiresInspection: true,
    occupancyRetained: true,
  });
  return {
    task: compactTask(task),
    attached: false,
    requiresInspection: true,
    reason,
    executionStopped: task.executionStopped,
  };
}

export async function inspectTask(
  ctx: CoordinatorRecoveryContext,
  taskId: string,
  attach: boolean,
): Promise<RecoveryResult> {
  let task = ctx.store.getTask(taskId);
  if (ctx.closing)
    return {
      task: compactTask(task),
      attached: false,
      reason: "Daemon is shutting down",
    };
  if (ctx.jobs.has(taskId))
    return {
      task: compactTask(task),
      attached: !!ctx.active.get(taskId)?.turn,
      operationInProgress: true,
      finalizing: task.status === "verifying",
    };
  if (!task.leaseHeld)
    return {
      task: compactTask(task),
      attached: false,
      alreadyStopped: true,
      executionStopped: task.executionStopped,
    };
  ctx.store.work.updateExecution(taskId, {
    nativeErrorsComplete: null,
    nativeErrorsReason: "attached_history_unverified",
  });
  if (ctx.store.hasEnteredVerification(taskId))
    return inspection(
      ctx,
      taskId,
      "Verification was interrupted and may have left local subprocesses. Inspect those processes and workspace; automatic verification retry and lease release are refused",
    );
  if (task.dispatchAttemptedAt === null) {
    const requeued = await ctx.recoverUndispatchedTask(
      taskId,
      "No durable model dispatch intent exists",
    );
    task = ctx.store.getTask(taskId);
    return {
      task: compactTask(task),
      attached: false,
      executionStopped: true,
      reason: requeued
        ? "Not dispatched; original work saved and requeued"
        : "Not dispatched; saved and released account",
    };
  }
  if (!task.workerId || !task.sessionId)
    return inspection(
      ctx,
      taskId,
      "No confirmed native session identity; occupancy retained",
    );
  if (task.executionStopped)
    return inspection(
      ctx,
      taskId,
      "A stopped task still holds occupancy; inspect unfinished local work before releasing it",
    );
  let connection: RuntimeConnection | undefined;
  let transferred = false;
  try {
    const worker = await ctx.supervisor.status(task.workerId);
    if (!worker.endpoint || worker.state !== "ready")
      return inspection(
        ctx,
        taskId,
        "Native worker unavailable; occupancy retained",
      );
    const conn = await ctx.adapter.connect(worker.endpoint);
    connection = conn;
    ctx.pendingConnections.add(conn);
    if (ctx.closing)
      return {
        task: compactTask(ctx.store.getTask(taskId)),
        attached: false,
        reason: "Daemon is shutting down",
      };
    const ws = ctx.store.getWorkspace(task.workspaceId);
    const session = await conn.openSession({
      workspacePath: ws.worktreePath,
      sessionId: task.sessionId,
    });
    if (
      session.sessionId !== task.sessionId ||
      resolve(session.workspacePath) !== resolve(ws.worktreePath)
    )
      return inspection(
        ctx,
        taskId,
        "Native openSession returned a different session or workspace identity; occupancy retained",
      );
    const snapshot = await conn.syncHistory(session);
    await ctx.captureNativeFacts(taskId, {
      connection: conn,
      session,
      accountAlias: worker.accountAlias,
    });
    if (ctx.closing)
      return {
        task: compactTask(ctx.store.getTask(taskId)),
        attached: false,
        reason: "Daemon is shutting down",
      };
    const observation = observeSnapshot(task, session, snapshot);
    if (observation.kind === "unknown") {
      const command = await conn.queryCommand(session, task.currentCommandId);
      if (
        command !== "unknown" &&
        command.admissionRejected === true &&
        command.commandId === task.currentCommandId &&
        typeof command.evidence === "string"
      ) {
        const requeued = await ctx.recoverRejectedTask(
          taskId,
          command.evidence,
        );
        return {
          task: compactTask(ctx.store.getTask(taskId)),
          attached: false,
          executionStopped: true,
          reason: requeued
            ? "Rejected before execution; original work was requeued for a new session"
            : "Rejected before execution; saved result and released account",
        };
      }
      return {
        ...inspection(ctx, taskId, observation.reason!),
        nativePhase: snapshot.phase,
        nativeTurnState: observation.header?.state ?? "unknown",
      };
    }
    if (
      observation.kind === "terminal" &&
      observation.header!.state === "failed"
    )
      ctx.recordFailure(
        taskId,
        task.currentCommandId,
        classifyTurnFailure(record(snapshot.raw), observation.header!),
      );
    if (!attach) {
      if (observation.kind === "terminal") {
        task = ctx.store.recordStoppedResult(
          taskId,
          {
            summary: taskSummary(task, snapshot, observation.header!),
            ...(await captureDelivery(ctx.root, taskId, ws)),
            blockers: [
              "Recovered by read-only native observation; configured verification was not run",
            ],
          },
          {
            kind: "history_stopped",
            evidence: `Fresh snapshot command ${task.currentCommandId}: ${observation.header!.state}, no active, queued, pending or background work`,
          },
        );
      }
      return {
        task: compactTask(ctx.store.getTask(taskId)),
        attached: false,
        nativePhase: snapshot.phase,
        nativeTurnState: observation.header!.state,
        executionStopped: observation.kind === "terminal",
        canResume: observation.kind === "active",
      };
    }
    const turn: TurnRef = {
      ...session,
      turnId: task.currentCommandId,
      commandId: task.currentCommandId,
    };
    const active: Active = {
      connection: conn,
      session,
      turn,
      accountAlias: worker.accountAlias,
    };
    if (observation.kind === "terminal") {
      const proof: StopProof = {
        kind: "history_stopped",
        evidence: `Fresh snapshot command ${task.currentCommandId}: ${observation.header!.state}, no active work`,
      };
      ctx.store.recordAttemptTerminal(
        taskId,
        task.currentCommandId,
        observation.header!.state,
        proof,
      );
      if (observation.header!.state === "completedInterrupted") {
        ctx.active.set(taskId, active);
        transferred = true;
        ctx.store.transitionTask(taskId, "verifying", {
          executionStopped: proof,
        });
        ctx.startJob(taskId, () =>
          ctx.finishTask(taskId, active, "turn_cancelled", proof),
        );
        return {
          task: compactTask(ctx.store.getTask(taskId)),
          attached: false,
          executionStopped: true,
          finalizing: true,
        };
      }
      ctx.active.set(taskId, active);
      transferred = true;
      const attempt = ctx.store.getCurrentAttempt(taskId);
      if (
        observation.header!.state === "failed" &&
        task.cancelRequestedAt === null
      ) {
        ctx.startJob(taskId, async () => {
          if (
            await ctx.continueBusyTask(
              taskId,
              active,
              snapshot,
              observation.header,
            )
          ) {
            if (!ctx.store.getTask(taskId).leaseHeld) return;
            await ctx.consumeEvents(taskId, active, snapshot.cursor);
            return;
          }
          ctx.store.transitionTask(taskId, "verifying", {
            executionStopped: proof,
          });
          await ctx.finishTask(taskId, active, "turn_failed", proof);
        });
        return {
          task: compactTask(ctx.store.getTask(taskId)),
          attached: true,
          executionStopped: false,
        };
      }
      ctx.store.transitionTask(taskId, "verifying", {
        executionStopped: proof,
        detail: {
          reason:
            "Recovered current terminal native turn; completing verification and snapshot",
        },
      });
      ctx.startJob(taskId, () =>
        ctx.finishTask(
          taskId,
          active,
          observation.header!.state === "failed"
            ? "turn_failed"
            : "turn_completed",
          proof,
        ),
      );
      return {
        task: compactTask(ctx.store.getTask(taskId)),
        attached: false,
        executionStopped: true,
        finalizing: true,
      };
    }
    let approvalBlocked = task.status === "blocked";
    try {
      if (
        !worker.accountAlias ||
        UNAVAILABLE_HEALTH.has(
          (await ctx.vault.load(worker.accountAlias)).health,
        )
      )
        approvalBlocked = true;
    } catch {
      approvalBlocked = true;
    }
    if (ctx.closing)
      return {
        task: compactTask(ctx.store.getTask(taskId)),
        attached: false,
        reason: "Daemon is shutting down",
      };
    const approvals = ownApprovals(task, snapshot, observation.header!);
    const preview = approvals
      .slice(0, 20)
      .map(approvalView)
      .filter((view): view is ApprovalView => view !== undefined);
    const detail: JsonValue = {
      reason: approvalBlocked
        ? "Reattached original turn for observation and cancellation; accepting approvals is blocked"
        : "Reattached original native turn",
      ...((preview[0] as unknown as Record<string, JsonValue>) ?? {}),
      pendingApprovalCount: approvals.length,
    };
    ctx.store.reattachTask(taskId, {
      sessionId: session.sessionId,
      turnId: turn.turnId,
      status: approvalBlocked
        ? "blocked"
        : approvals.length
          ? "waiting_approval"
          : "running",
      detail,
    });
    const pendingApprovals = approvals
      .slice(0, 20)
      .map((value) => ctx.publishApproval(taskId, value))
      .filter((view): view is ApprovalView => view !== undefined);
    if (pendingApprovals[0])
      ctx.store.reattachTask(taskId, {
        sessionId: session.sessionId,
        turnId: turn.turnId,
        status: approvalBlocked ? "blocked" : "waiting_approval",
        detail: {
          ...(detail as Record<string, JsonValue>),
          approvalLogCursor: pendingApprovals[0].approvalLogCursor!,
        },
      });
    ctx.active.set(taskId, active);
    transferred = true;
    ctx.startJob(taskId, () =>
      ctx.consumeEvents(taskId, active, snapshot.cursor),
    );
    if (task.cancelRequestedAt !== null) await active.connection.cancel(turn);
    return {
      task: compactTask(ctx.store.getTask(taskId)),
      attached: true,
      executionStopped: false,
      pendingApprovals,
      pendingApprovalCount: approvals.length,
      pendingApprovalsTruncated: approvals.length > 20,
      ...(snapshot.pendingApprovals.length > approvals.length
        ? {
            requiresInspection: true,
            reason:
              "Some native approvals cannot be attributed to this task; review them in local ZCode",
          }
        : {}),
    };
  } catch {
    return inspection(
      ctx,
      taskId,
      "Native recovery could not be confirmed; check local worker availability and session identity. Occupancy retained",
    );
  } finally {
    if (connection) {
      ctx.pendingConnections.delete(connection);
      if (!transferred) await connection.close().catch(() => {});
    }
  }
}
