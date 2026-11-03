import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import type { Task, JsonValue, TaskResult, StopProof } from "../core/types.js";
import type {
  RuntimeConnection,
  SessionRef,
  TurnRef,
  ExecutionMode,
  SessionSnapshot,
} from "../runtime/types.js";
import type { DurableTaskStore } from "../core/index.js";
import { redact, record } from "../runtime/zcode-server/events.js";
import { snapshotWorkspace } from "./workspace.js";

const exec = promisify(execFile);

export const FINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
export const TERMINAL_STATES = new Set([
  "completedSuccess",
  "failed",
  "completedInterrupted",
]);
export const UNAVAILABLE_HEALTH = new Set(["blocked", "invalid", "cooling"]);
export const APPROVAL_REVIEW_HINT =
  "This is a bounded preview. Inspect the persisted approval event and full local native details before accepting incomplete arguments.";

export type TerminalEvent = "turn_completed" | "turn_failed" | "turn_cancelled";
export interface Policy {
  mode: ExecutionMode;
  modelId: string;
  verifyCommands: { command: string; args: string[]; timeout_ms: number }[];
}
export interface Active {
  connection: RuntimeConnection;
  session?: SessionRef;
  turn?: TurnRef;
  accountAlias?: string;
  approvalResponses?: Map<string, string>;
}
export interface Observation {
  kind: "active" | "terminal" | "unknown";
  reason?: string;
  header?: Record<string, any>;
}
export interface ApprovalView {
  approvalId: string;
  kind?: string;
  toolName?: string;
  summary?: string;
  truncated?: boolean;
  approvalLogCursor?: number;
  reviewComplete: false;
  reviewHint: string;
}
export interface RecoveryResult {
  task: ReturnType<typeof compactTask>;
  attached: boolean;
  executionStopped?: boolean;
  alreadyStopped?: boolean;
  requiresInspection?: boolean;
  reason?: string;
  nativePhase?: string;
  nativeTurnState?: string;
  operationInProgress?: boolean;
  finalizing?: boolean;
  canResume?: boolean;
  pendingApprovals?: ApprovalView[];
  pendingApprovalCount?: number;
  pendingApprovalsTruncated?: boolean;
}
export interface CoordinatorRecoveryContext {
  root: string;
  store: DurableTaskStore;
  supervisor: any;
  adapter: any;
  vault: any;
  closing: boolean;
  jobs: Map<string, Promise<void>>;
  active: Map<string, Active>;
  pendingConnections: Set<RuntimeConnection>;
  recordFailure(
    taskId: string,
    commandId: string,
    data: any,
    occurredAt?: number,
  ): void;
  continueBusyTask(
    taskId: string,
    active: Active,
    snapshot?: any,
    header?: any,
  ): Promise<boolean>;
  consumeEvents(taskId: string, active: Active, cursor?: string): Promise<void>;
  finishTask(
    taskId: string,
    active: Active,
    type: TerminalEvent,
    proof: StopProof,
  ): Promise<void>;
  publishApproval(
    taskId: string,
    value: Record<string, any>,
  ): ApprovalView | undefined;
  startJob(taskId: string, action: () => Promise<void>): void;
  captureNativeFacts(taskId: string, active: Active): Promise<void>;
  recoverRejectedTask(taskId: string, evidence: string): Promise<boolean>;
  recoverUndispatchedTask(taskId: string, evidence: string): Promise<boolean>;
}

export function compactTask(task: Task) {
  return {
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    workerId: task.workerId,
    sessionId: task.sessionId,
    status: task.status,
    revision: task.revision,
    leaseHeld: task.leaseHeld,
    detail: task.detail,
    ...(task.busyRetryCount
      ? {
          retry: {
            used: task.busyRetryCount,
            max: null,
            reason: "transient_fault",
          },
        }
      : {}),
  };
}

export function safeDetail(value: unknown): JsonValue {
  const cleaned = redact(value);
  const text = JSON.stringify(cleaned);
  return text.length <= 4000
    ? JSON.parse(text)
    : { truncated: true, summary: text.slice(0, 3500) };
}

export function boundedText(
  value: unknown,
  bytes: number,
): { text?: string; truncated?: boolean } {
  if (typeof value !== "string") return {};
  const text = String(redact(value));
  if (Buffer.byteLength(text) <= bytes) return { text };
  let prefix = "";
  for (const character of text) {
    if (Buffer.byteLength(prefix + character) > bytes) break;
    prefix += character;
  }
  return { text: prefix, truncated: true };
}

export function approvalView(
  value: Record<string, any>,
): ApprovalView | undefined {
  const approvalId = value.approvalId ?? value.interactionId ?? value.id;
  if (typeof approvalId !== "string" || !approvalId || approvalId.length > 150)
    return;
  const summary = boundedText(value.payload?.summary ?? value.summary, 384);
  const kind = boundedText(value.kind, 80).text;
  const toolName = boundedText(
    value.payload?.toolName ?? value.toolName,
    100,
  ).text;
  return {
    approvalId,
    ...(kind ? { kind } : {}),
    ...(toolName ? { toolName } : {}),
    ...(summary.text ? { summary: summary.text } : {}),
    ...(summary.truncated ? { truncated: true } : {}),
    reviewComplete: false,
    reviewHint: APPROVAL_REVIEW_HINT,
  };
}

export function taskPolicy(task: Task): Policy {
  const policy = record(task.executionPolicy);
  const commands = policy.verifyCommands ?? [];
  if (
    !Array.isArray(commands) ||
    commands.length > 10 ||
    commands.some(
      (command: any) =>
        !command ||
        typeof command.command !== "string" ||
        !command.command ||
        !Array.isArray(command.args) ||
        command.args.some((arg: unknown) => typeof arg !== "string") ||
        !Number.isInteger(command.timeout_ms) ||
        command.timeout_ms < 100 ||
        command.timeout_ms > 300_000,
    )
  )
    throw new Error(
      "Stored verification policy is invalid; inspect before continuing",
    );
  return {
    mode: policy.mode ?? "build",
    modelId: policy.modelId ?? "GLM-5.3-Flash",
    verifyCommands: commands,
  };
}

export function observeSnapshot(
  task: Task,
  session: SessionRef,
  snapshot: SessionSnapshot,
): Observation {
  if (
    session.sessionId !== task.sessionId ||
    snapshot.sessionId !== task.sessionId ||
    resolve(session.workspacePath) !== resolve(snapshot.workspacePath)
  )
    return {
      kind: "unknown",
      reason: "Native snapshot identity does not match the persisted session",
    };
  if (task.turnId !== null && task.turnId !== task.currentCommandId)
    return {
      kind: "unknown",
      reason: "Persisted turn identity does not match the current command",
    };
  const raw = record(snapshot.raw);
  if (raw.sessionId !== undefined && raw.sessionId !== task.sessionId)
    return {
      kind: "unknown",
      reason: "Native snapshot contains a conflicting session identity",
    };
  const rows = raw.rows?.window;
  const works = raw.control?.activeWorks;
  if (!Array.isArray(rows) || !Array.isArray(works))
    return {
      kind: "unknown",
      reason:
        "Native snapshot does not expose checked turn rows and active work",
    };
  if (
    !Array.isArray(raw.queue?.items) ||
    !Array.isArray(raw.pendingCommands) ||
    !Array.isArray(raw.backgroundWorks)
  )
    return {
      kind: "unknown",
      reason:
        "Native snapshot does not expose complete queued, pending and background work",
    };
  if (
    raw.queue.items.length ||
    raw.pendingCommands.length ||
    raw.backgroundWorks.some(
      (work: any) =>
        ![
          "completed",
          "failed",
          "cancelled",
          "stopped",
          "completedSuccess",
          "completedInterrupted",
        ].includes(work.state ?? work.status),
    )
  )
    return {
      kind: "unknown",
      reason:
        "Native queued, pending or background work may still execute; occupancy retained",
    };
  const headers = rows.filter(
    (row: any) =>
      row.kind === "turnHeader" &&
      row.sourceCommandId === task.currentCommandId,
  );
  if (
    headers.length !== 1 ||
    typeof headers[0].turnId !== "string" ||
    !headers[0].turnId
  )
    return {
      kind: "unknown",
      reason:
        "The snapshot tail cannot uniquely identify the original native turn",
    };
  const header = headers[0];
  if (TERMINAL_STATES.has(header.state) && works.length === 0)
    return { kind: "terminal", header };
  if (
    header.state === "running" &&
    works.length === 1 &&
    works[0]?.sourceCommandId === task.currentCommandId &&
    (works[0].turnId === undefined || works[0].turnId === header.turnId)
  )
    return { kind: "active", header };
  return {
    kind: "unknown",
    header,
    reason:
      "Original turn state and native active work do not agree; occupancy retained",
  };
}

export function ownApprovals(
  task: Task,
  snapshot: SessionSnapshot,
  header: Record<string, any>,
): Record<string, any>[] {
  const rows = record(snapshot.raw).rows?.window;
  return snapshot.pendingApprovals.filter((value) => {
    const approval = record(value);
    if (
      approval.sourceCommandId !== undefined &&
      approval.sourceCommandId !== task.currentCommandId
    )
      return false;
    if (approval.turnId !== undefined && approval.turnId !== header.turnId)
      return false;
    let proved =
      approval.sourceCommandId === task.currentCommandId ||
      approval.turnId === header.turnId;
    if (approval.anchorRowId !== undefined) {
      if (!Number.isSafeInteger(approval.anchorRowId)) return false;
      const anchor = Array.isArray(rows)
        ? rows.find((row: any) => row.rowId === approval.anchorRowId)
        : undefined;
      if (anchor) {
        if (
          (anchor.sourceCommandId !== undefined &&
            anchor.sourceCommandId !== task.currentCommandId) ||
          (anchor.turnId !== undefined && anchor.turnId !== header.turnId)
        )
          return false;
        proved ||=
          anchor.sourceCommandId === task.currentCommandId ||
          anchor.turnId === header.turnId;
      }
    }
    return proved;
  });
}

export function taskSummary(
  task: Task,
  snapshot: SessionSnapshot,
  header: Record<string, any>,
): string {
  const rows = record(snapshot.raw).rows?.window;
  const own = Array.isArray(rows)
    ? rows.filter(
        (row: any) =>
          row.kind === "assistantText" &&
          (row.sourceCommandId === undefined ||
            row.sourceCommandId === task.currentCommandId) &&
          (row.turnId === header.turnId ||
            (row.turnId === undefined &&
              row.sourceCommandId === task.currentCommandId)) &&
          typeof row.text === "string",
      )
    : [];
  return String(redact(own.at(-1)?.text ?? "")).slice(0, 2000);
}

export function collectLogs(
  store: DurableTaskStore,
  taskId: string,
  cursor?: number,
  limit?: number,
) {
  const entries = store.listEvents(taskId, { afterRevision: cursor, limit });
  const events = [];
  let size = 0;
  for (const event of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (events.length && size + bytes > 8000) break;
    events.push(event);
    size += bytes;
  }
  return { events, nextCursor: events.at(-1)?.revision ?? cursor };
}

export async function readDiffArtifact(
  result: TaskResult | null,
  offset: number,
  limit: number,
) {
  const patch = (result?.artifacts ?? []).find((a) => a.kind === "patch");
  if (!patch) return { available: false as const };
  const text = await readFile(patch.path, "utf8");
  return {
    available: true as const,
    text: text.slice(offset, offset + limit),
    nextOffset: offset + limit < text.length ? offset + limit : null,
    totalCharacters: text.length,
  };
}

export async function captureDelivery(
  root: string,
  taskId: string,
  ws: { worktreePath: string },
) {
  const snapshot = await snapshotWorkspace(root, taskId, ws as any);
  const patch = await readFile(snapshot.patchFile);
  return {
    changedFiles: snapshot.changedFiles,
    artifacts: [
      {
        kind: "patch",
        path: snapshot.patchFile,
        sha256: createHash("sha256").update(patch).digest("hex"),
        sizeBytes: patch.length,
        mediaType: "text/x-diff",
      },
      snapshot.manifestArtifact,
      ...snapshot.snapshotArtifacts,
    ],
  };
}
export async function executeVerification(
  root: string,
  taskId: string,
  ws: { worktreePath: string },
  policy: Policy,
) {
  const commands = policy.verifyCommands.length
    ? policy.verifyCommands
    : [{ command: "git", args: ["diff", "--check"], timeout_ms: 30_000 }];
  const verification: {
    command: string;
    exitCode: number | null;
    summary: string;
  }[] = [];
  for (const command of commands) {
    try {
      const out = await exec(command.command, command.args, {
        cwd: ws.worktreePath,
        timeout: command.timeout_ms,
        maxBuffer: 1024 * 1024,
      });
      verification.push({
        command: [command.command, ...command.args].join(" "),
        exitCode: 0,
        summary: String(redact(out.stdout + out.stderr)).slice(0, 1500),
      });
    } catch (error: any) {
      verification.push({
        command: [command.command, ...command.args].join(" "),
        exitCode: typeof error.code === "number" ? error.code : null,
        summary: String(redact(error.stdout ?? "")).slice(0, 1000),
      });
    }
  }
  const captured = await captureDelivery(root, taskId, ws);
  const blockers: string[] = [];
  if (!policy.verifyCommands.length)
    blockers.push(
      "Only git diff --check was configured; functional acceptance remains for reviewer",
    );
  return {
    verification,
    ...captured,
    blockers,
    passed: verification.every((v) => v.exitCode === 0),
  };
}
