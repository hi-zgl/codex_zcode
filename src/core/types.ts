export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type TaskStatus =
  | 'queued'
  | 'dispatching'
  | 'running'
  | 'waiting_approval'
  | 'verifying'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'interrupted';

export type WorkspaceState = 'active' | 'merged' | 'abandoned';

export interface WorkspaceInput {
  workspaceId?: string;
  repositoryPath: string;
  worktreePath: string;
  branch: string;
  baseCommit: string;
}

export interface Workspace extends Required<WorkspaceInput> {
  state: WorkspaceState;
  activeTaskId: string | null;
  createdAt: number;
}

export interface DispatchInput {
  requestId: string;
  workspaceId: string;
  prompt: string;
  workerId?: string;
  session?: 'continue' | 'new';
  executionPolicy?: JsonValue;
}

/** This is an observation by the caller, never an inference from a timeout. */
export interface StopProof {
  kind: 'runtime_terminal' | 'process_exited' | 'history_stopped' | 'not_dispatched';
  evidence: string;
  observedAt?: number;
}

export interface Task {
  taskId: string;
  requestId: string;
  workspaceId: string;
  prompt: string;
  requestedWorkerId: string | null;
  workerId: string | null;
  session: 'continue' | 'new';
  sessionId: string | null;
  turnId: string | null;
  /** Current native command; requestId remains the immutable client idempotency key. */
  currentCommandId: string;
  /** Number of busy continuations whose send intent has been durably committed. */
  busyRetryCount: number;
  cancelRequestedAt: number | null;
  /** Immutable account/provider/model binding selected before the original dispatch. */
  runtimeBinding: JsonValue;
  executionPolicy: JsonValue;
  status: TaskStatus;
  /** Last committed event sequence, monotonic across the whole store. */
  revision: number;
  leaseHeld: boolean;
  dispatchAttemptedAt: number | null;
  executionStopped: boolean;
  stopProof: StopProof | null;
  detail: JsonValue;
  createdAt: number;
  updatedAt: number;
}

/** One native command, including an uncertain send. An intent must never be replayed. */
export interface TaskAttempt {
  taskId: string;
  index: number;
  commandId: string;
  sessionId: string | null;
  turnId: string | null;
  intentAt: number;
  acknowledgedAt: number | null;
  terminalState: 'completedSuccess' | 'failed' | 'completedInterrupted' | null;
  stopProof: StopProof | null;
  failureCategory: string | null;
  busyRetryEligible: boolean;
  continuationBlocked: boolean;
}

export interface ArtifactMetadata {
  kind: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType?: string;
}

export interface VerificationResult {
  command: string;
  exitCode: number | null;
  summary?: string;
}

export interface TaskResult {
  summary: string;
  changedFiles?: string[];
  verification?: VerificationResult[];
  blockers?: string[];
  artifacts?: ArtifactMetadata[];
}

export interface PersistedTaskResult extends Required<TaskResult> {
  taskId: string;
  createdAt: number;
}

export interface TaskEvent {
  revision: number;
  taskId: string;
  type: string;
  status: TaskStatus;
  detail: JsonValue;
  createdAt: number;
}

export interface TransitionOptions {
  detail?: JsonValue;
  executionStopped?: StopProof;
}

export interface WaitInput {
  taskIds: string[];
  /** Omit for an immediate snapshot. A map supplies a cursor for each task. */
  afterRevision?: number | Record<string, number>;
  timeoutMs?: number;
}

export interface WaitResult {
  tasks: Task[];
  changedTaskIds: string[];
  timedOut: boolean;
  revision: number;
}

export interface StoreOptions {
  pollIntervalMs?: number;
  now?: () => number;
}

export class CoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}
