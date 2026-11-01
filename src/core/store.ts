import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CoreError,
  type ArtifactMetadata,
  type DispatchInput,
  type JsonValue,
  type PersistedTaskResult,
  type StopProof,
  type StoreOptions,
  type Task,
  type TaskAttempt,
  type TaskEvent,
  type TaskResult,
  type TaskStatus,
  type TransitionOptions,
  type WaitInput,
  type WaitResult,
  type Workspace,
  type WorkspaceInput,
  type WorkspaceState,
} from './types.js';

export const MAX_WAIT_MS = 25_000;
const FINAL_STATUSES = new Set<TaskStatus>(['succeeded', 'failed', 'cancelled']);
const RELEASE_STATUSES = new Set<TaskStatus>([...FINAL_STATUSES, 'blocked', 'interrupted']);
const STATUSES = new Set<TaskStatus>([
  'queued', 'dispatching', 'running', 'waiting_approval', 'verifying',
  'succeeded', 'failed', 'cancelled', 'blocked', 'interrupted',
]);
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['dispatching', 'blocked', 'interrupted', 'cancelled', 'failed'],
  dispatching: ['running', 'waiting_approval', 'verifying', 'blocked', 'interrupted', 'failed', 'cancelled'],
  running: ['waiting_approval', 'verifying', 'blocked', 'interrupted', 'failed', 'cancelled'],
  waiting_approval: ['running', 'verifying', 'blocked', 'interrupted', 'failed', 'cancelled'],
  verifying: ['succeeded', 'failed', 'blocked', 'interrupted', 'cancelled'],
  blocked: ['interrupted', 'verifying', 'failed', 'cancelled'],
  interrupted: ['blocked', 'verifying', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

interface TaskRow {
  task_id: string;
  request_id: string;
  workspace_id: string;
  payload: string;
  prompt: string;
  requested_worker_id: string | null;
  worker_id: string | null;
  session_mode: 'continue' | 'new';
  session_id: string | null;
  turn_id: string | null;
  current_command_id: string;
  busy_retry_count: number;
  cancel_requested_at: number | null;
  runtime_binding: string;
  execution_policy: string;
  status: TaskStatus;
  revision: number;
  lease_held: number;
  dispatch_attempted_at: number | null;
  execution_stopped: number;
  stop_proof: string | null;
  detail: string;
  created_at: number;
  updated_at: number;
}

interface WorkspaceRow {
  workspace_id: string;
  repository_path: string;
  worktree_path: string;
  branch: string;
  base_commit: string;
  state: WorkspaceState;
  created_at: number;
  active_task_id?: string | null;
}

interface ResultRow { payload: string; created_at: number }
interface AttemptRow {
  task_id: string; attempt_index: number; command_id: string; session_id: string | null;
  turn_id: string | null; intent_at: number; acknowledged_at: number | null;
  terminal_state: TaskAttempt['terminalState']; stop_proof: string | null;
  failure_category: string | null; busy_retry_eligible: number; continuation_blocked: number;
}
interface EventRow {
  revision: number;
  task_id: string;
  type: string;
  status: TaskStatus;
  detail: string;
  created_at: number;
}

function fail(code: string, message: string): never {
  throw new CoreError(code, message);
}

function requiredString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_ARGUMENT', `${name} must be a nonempty string`);
  }
}

function nonnegativeInteger(value: unknown, name: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('INVALID_ARGUMENT', `${name} must be a nonnegative safe integer`);
  }
}

/** Reject non-JSON values and sort object keys for semantic idempotency checks. */
function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null) fail('INVALID_ARGUMENT', 'Value must contain only JSON data');
    if (ancestors.has(item)) fail('INVALID_ARGUMENT', 'JSON data must not contain cycles');
    ancestors.add(item);
    let normalized: JsonValue;
    if (Array.isArray(item)) {
      normalized = Array.from(item, normalize);
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) fail('INVALID_ARGUMENT', 'JSON objects must be plain objects');
      const object = item as Record<string, unknown>;
      normalized = Object.fromEntries(Object.keys(object).sort().map((key) => [key, normalize(object[key])]));
    }
    ancestors.delete(item);
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

function taskFromRow(row: TaskRow): Task {
  return {
    taskId: row.task_id, requestId: row.request_id, workspaceId: row.workspace_id,
    prompt: row.prompt, requestedWorkerId: row.requested_worker_id, workerId: row.worker_id,
    session: row.session_mode, sessionId: row.session_id, turnId: row.turn_id,
    currentCommandId: row.current_command_id, busyRetryCount: row.busy_retry_count,
    cancelRequestedAt: row.cancel_requested_at, runtimeBinding: JSON.parse(row.runtime_binding) as JsonValue,
    executionPolicy: JSON.parse(row.execution_policy) as JsonValue, status: row.status,
    revision: row.revision, leaseHeld: row.lease_held === 1, dispatchAttemptedAt: row.dispatch_attempted_at,
    executionStopped: row.execution_stopped === 1,
    stopProof: row.stop_proof === null ? null : JSON.parse(row.stop_proof) as StopProof,
    detail: JSON.parse(row.detail) as JsonValue, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function attemptFromRow(row: AttemptRow): TaskAttempt {
  return {taskId:row.task_id,index:row.attempt_index,commandId:row.command_id,sessionId:row.session_id,
    turnId:row.turn_id,intentAt:row.intent_at,acknowledgedAt:row.acknowledged_at,terminalState:row.terminal_state,
    stopProof:row.stop_proof===null?null:JSON.parse(row.stop_proof) as StopProof,
    failureCategory:row.failure_category,busyRetryEligible:row.busy_retry_eligible===1,continuationBlocked:row.continuation_blocked===1};
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return {
    workspaceId: row.workspace_id, repositoryPath: row.repository_path,
    worktreePath: row.worktree_path, branch: row.branch, baseCommit: row.base_commit,
    state: row.state, activeTaskId: row.active_task_id ?? null, createdAt: row.created_at,
  };
}

function normalizeResult(result: TaskResult): Required<TaskResult> {
  if (typeof result?.summary !== 'string') fail('INVALID_ARGUMENT', 'result.summary must be a string');
  const changedFiles = result.changedFiles ?? [];
  const verification = result.verification ?? [];
  const blockers = result.blockers ?? [];
  const artifacts = result.artifacts ?? [];
  for (const [name, values] of [['changedFiles', changedFiles], ['blockers', blockers]] as const) {
    if (!Array.isArray(values)) fail('INVALID_ARGUMENT', `result.${name} must be an array`);
    for (const value of values) requiredString(value, `result.${name} entry`);
  }
  if (!Array.isArray(verification)) fail('INVALID_ARGUMENT', 'result.verification must be an array');
  for (const item of verification) {
    requiredString(item?.command, 'verification.command');
    if (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) fail('INVALID_ARGUMENT', 'verification.exitCode must be an integer or null');
    if (item.summary !== undefined && typeof item.summary !== 'string') fail('INVALID_ARGUMENT', 'verification.summary must be a string');
  }
  if (!Array.isArray(artifacts)) fail('INVALID_ARGUMENT', 'result.artifacts must be an array');
  const artifactPaths = new Set<string>();
  for (const artifact of artifacts) {
    validateArtifact(artifact);
    if (artifactPaths.has(artifact.path)) fail('INVALID_ARGUMENT', 'Artifact paths must be unique within a result');
    artifactPaths.add(artifact.path);
  }
  return JSON.parse(canonicalJson({ summary: result.summary, changedFiles, verification, blockers, artifacts })) as Required<TaskResult>;
}

function validateArtifact(artifact: ArtifactMetadata): void {
  requiredString(artifact?.kind, 'artifact.kind');
  requiredString(artifact.path, 'artifact.path');
  if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) fail('INVALID_ARGUMENT', 'artifact.sha256 must be a lowercase SHA-256 digest');
  nonnegativeInteger(artifact.sizeBytes, 'artifact.sizeBytes');
  if (artifact.mediaType !== undefined) requiredString(artifact.mediaType, 'artifact.mediaType');
}

/**
 * The durable boundary before any runtime side effect. Call beginDispatch once,
 * commit it, and only then send to the runtime. An uncertain command is never replayed.
 */
export class DurableTaskStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly listeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  constructor(readonly databasePath: string, options: StoreOptions = {}) {
    requiredString(databasePath, 'databasePath');
    this.now = options.now ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
    if (!Number.isSafeInteger(this.pollIntervalMs) || this.pollIntervalMs < 1 || this.pollIntervalMs > 1_000) {
      fail('INVALID_ARGUMENT', 'pollIntervalMs must be between 1 and 1000');
    }
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.initializeSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private initializeSchema(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
    // Recheck after acquiring the write lock: another process may have migrated
    // between opening this connection and obtaining schema ownership.
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 2) fail('UNSUPPORTED_SCHEMA', `State schema ${version.user_version} is newer than this program`);
    if (version.user_version === 2) {this.db.exec('COMMIT');return;}
    if (version.user_version === 0) this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id TEXT PRIMARY KEY,
        repository_path TEXT NOT NULL,
        worktree_path TEXT NOT NULL UNIQUE,
        branch TEXT NOT NULL,
        base_commit TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'merged', 'abandoned')),
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id),
        payload TEXT NOT NULL,
        prompt TEXT NOT NULL,
        requested_worker_id TEXT,
        worker_id TEXT,
        session_mode TEXT NOT NULL CHECK (session_mode IN ('continue', 'new')),
        session_id TEXT,
        turn_id TEXT,
        execution_policy TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','dispatching','running','waiting_approval','verifying','succeeded','failed','cancelled','blocked','interrupted')),
        revision INTEGER NOT NULL DEFAULT 0,
        lease_held INTEGER NOT NULL DEFAULT 1 CHECK (lease_held IN (0,1)),
        dispatch_attempted_at INTEGER,
        execution_stopped INTEGER NOT NULL DEFAULT 0 CHECK (execution_stopped IN (0,1)),
        stop_proof TEXT,
        detail TEXT NOT NULL DEFAULT 'null',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_workspace_lease ON tasks(workspace_id) WHERE lease_held = 1;
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_worker_lease ON tasks(worker_id) WHERE lease_held = 1 AND worker_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS task_events (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, revision);
      CREATE TABLE IF NOT EXISTS task_results (
        task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS immutable_task_results_update BEFORE UPDATE ON task_results
        BEGIN SELECT RAISE(ABORT, 'Task results are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_task_results_delete BEFORE DELETE ON task_results
        BEGIN SELECT RAISE(ABORT, 'Task results are immutable'); END;
      PRAGMA user_version = 1;
    `);
    this.db.exec(`
      ALTER TABLE tasks ADD COLUMN current_command_id TEXT NOT NULL DEFAULT '';
      ALTER TABLE tasks ADD COLUMN busy_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (busy_retry_count >= 0);
      ALTER TABLE tasks ADD COLUMN cancel_requested_at INTEGER;
      ALTER TABLE tasks ADD COLUMN runtime_binding TEXT NOT NULL DEFAULT 'null';
      UPDATE tasks SET current_command_id = request_id;
      CREATE TABLE task_attempts (
        task_id TEXT NOT NULL REFERENCES tasks(task_id),
        attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
        command_id TEXT NOT NULL UNIQUE,
        session_id TEXT,
        turn_id TEXT,
        intent_at INTEGER NOT NULL,
        acknowledged_at INTEGER,
        terminal_state TEXT CHECK (terminal_state IN ('completedSuccess','failed','completedInterrupted')),
        stop_proof TEXT,
        failure_category TEXT,
        busy_retry_eligible INTEGER NOT NULL DEFAULT 0 CHECK (busy_retry_eligible IN (0,1)),
        continuation_blocked INTEGER NOT NULL DEFAULT 0 CHECK (continuation_blocked IN (0,1)),
        PRIMARY KEY (task_id,attempt_index)
      ) STRICT;
      INSERT INTO task_attempts(task_id,attempt_index,command_id,session_id,turn_id,intent_at,acknowledged_at,stop_proof)
        SELECT task_id,0,request_id,session_id,turn_id,dispatch_attempted_at,
          CASE WHEN turn_id IS NOT NULL THEN updated_at END,stop_proof FROM tasks WHERE dispatch_attempted_at IS NOT NULL;
      PRAGMA user_version = 2;
    `);
    this.db.exec('COMMIT');
    } catch (error) {
      try {this.db.exec('ROLLBACK');} catch { /* Preserve the original migration failure. */ }
      throw error;
    }
  }

  private ensureOpen(): void {
    if (this.closed) fail('STORE_CLOSED', 'The task store is closed');
  }

  private write<T>(action: () => T): T {
    this.ensureOpen();
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = action();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
    for (const listener of [...this.listeners]) listener();
    return result;
  }

  private taskRow(taskId: string): TaskRow {
    this.ensureOpen();
    requiredString(taskId, 'taskId');
    const row = this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as unknown as TaskRow | undefined;
    return row ?? fail('TASK_NOT_FOUND', `Task ${taskId} was not found`);
  }

  private event(taskId: string, type: string, status: TaskStatus, detail: JsonValue, at: number): number {
    const encoded = canonicalJson(detail);
    const inserted = this.db.prepare('INSERT INTO task_events(task_id,type,status,detail,created_at) VALUES(?,?,?,?,?)')
      .run(taskId, type, status, encoded, at);
    const revision = Number(inserted.lastInsertRowid);
    this.db.prepare('UPDATE tasks SET revision = ?, updated_at = ? WHERE task_id = ?').run(revision, at, taskId);
    return revision;
  }

  registerWorkspace(input: WorkspaceInput): Workspace {
    for (const key of ['repositoryPath', 'worktreePath', 'branch', 'baseCommit'] as const) requiredString(input?.[key], key);
    if (input.workspaceId !== undefined) requiredString(input.workspaceId, 'workspaceId');
    const workspaceId = input.workspaceId ?? `ws_${randomUUID()}`;
    return this.write(() => {
      const existing = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ? OR worktree_path = ?')
        .get(workspaceId, input.worktreePath) as unknown as WorkspaceRow | undefined;
      if (existing) {
        if ((input.workspaceId !== undefined && existing.workspace_id !== input.workspaceId)
          || existing.repository_path !== input.repositoryPath || existing.worktree_path !== input.worktreePath
          || existing.branch !== input.branch || existing.base_commit !== input.baseCommit) {
          fail('WORKSPACE_CONFLICT', 'Workspace identity is already registered with different metadata');
        }
        return this.getWorkspace(existing.workspace_id);
      }
      this.db.prepare('INSERT INTO workspaces(workspace_id,repository_path,worktree_path,branch,base_commit,created_at) VALUES(?,?,?,?,?,?)')
        .run(workspaceId, input.repositoryPath, input.worktreePath, input.branch, input.baseCommit, this.now());
      return this.getWorkspace(workspaceId);
    });
  }

  getWorkspace(workspaceId: string): Workspace {
    this.ensureOpen();
    requiredString(workspaceId, 'workspaceId');
    const row = this.db.prepare(`SELECT w.*, t.task_id AS active_task_id FROM workspaces w
      LEFT JOIN tasks t ON t.workspace_id = w.workspace_id AND t.lease_held = 1 WHERE w.workspace_id = ?`)
      .get(workspaceId) as unknown as WorkspaceRow | undefined;
    return row ? workspaceFromRow(row) : fail('WORKSPACE_NOT_FOUND', `Workspace ${workspaceId} was not found`);
  }

  listWorkspaces(): Workspace[] {
    this.ensureOpen();
    return (this.db.prepare(`SELECT w.*, t.task_id AS active_task_id FROM workspaces w
      LEFT JOIN tasks t ON t.workspace_id = w.workspace_id AND t.lease_held = 1 ORDER BY w.created_at, w.workspace_id`)
      .all() as unknown as WorkspaceRow[]).map(workspaceFromRow);
  }

  setWorkspaceState(workspaceId: string, state: WorkspaceState): Workspace {
    if (!['active', 'merged', 'abandoned'].includes(state)) fail('INVALID_ARGUMENT', 'Invalid workspace state');
    return this.write(() => {
      const workspace = this.getWorkspace(workspaceId);
      if (workspace.activeTaskId !== null) fail('WORKSPACE_BUSY', 'Cannot change workspace lifecycle while a task holds its lease');
      this.db.prepare('UPDATE workspaces SET state = ? WHERE workspace_id = ?').run(state, workspaceId);
      return this.getWorkspace(workspaceId);
    });
  }

  dispatch(input: DispatchInput): { task: Task; created: boolean } {
    for (const key of ['requestId', 'workspaceId', 'prompt'] as const) requiredString(input?.[key], key);
    if (input.workerId !== undefined) requiredString(input.workerId, 'workerId');
    const session = input.session ?? 'continue';
    if (session !== 'continue' && session !== 'new') fail('INVALID_ARGUMENT', 'session must be continue or new');
    const executionPolicy = canonicalJson(input.executionPolicy ?? null);
    const idempotencyPolicy = JSON.parse(executionPolicy) as JsonValue;
    // Adding an opt-out with the default enabled policy must preserve pre-upgrade
    // request identity. The original execution policy and payload stay immutable.
    if (idempotencyPolicy && typeof idempotencyPolicy==='object' && !Array.isArray(idempotencyPolicy)
      && idempotencyPolicy.busyRetryLimit===3) delete idempotencyPolicy.busyRetryLimit;
    const payload = canonicalJson({
      workspaceId: input.workspaceId, prompt: input.prompt, workerId: input.workerId ?? null,
      session, executionPolicy: idempotencyPolicy,
    });
    return this.write(() => {
      const duplicate = this.db.prepare('SELECT * FROM tasks WHERE request_id = ?').get(input.requestId) as unknown as TaskRow | undefined;
      if (duplicate) {
        if (duplicate.payload !== payload) fail('IDEMPOTENCY_CONFLICT', 'requestId was already used with a different dispatch payload');
        return { task: taskFromRow(duplicate), created: false };
      }
      const workspace = this.getWorkspace(input.workspaceId);
      if (workspace.state !== 'active') fail('WORKSPACE_INACTIVE', 'Tasks require an active workspace');
      if (workspace.activeTaskId !== null) fail('WORKSPACE_BUSY', `Workspace is held by task ${workspace.activeTaskId}`);
      if (input.workerId !== undefined) this.assertWorkerAvailable(input.workerId);
      const taskId = `task_${randomUUID()}`;
      const at = this.now();
      this.db.prepare(`INSERT INTO tasks(task_id,request_id,workspace_id,payload,prompt,requested_worker_id,worker_id,
        session_mode,execution_policy,current_command_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?)`)
        .run(taskId, input.requestId, input.workspaceId, payload, input.prompt, input.workerId ?? null,
          input.workerId ?? null, session, executionPolicy, input.requestId, at, at);
      this.event(taskId, 'task_created', 'queued', null, at);
      return { task: this.getTask(taskId), created: true };
    });
  }

  private assertWorkerAvailable(workerId: string, excludingTaskId?: string): void {
    const holder = this.db.prepare('SELECT task_id FROM tasks WHERE worker_id = ? AND lease_held = 1 AND task_id != ?')
      .get(workerId, excludingTaskId ?? '') as { task_id: string } | undefined;
    if (holder) fail('WORKER_BUSY', `Worker ${workerId} is held by task ${holder.task_id}`);
  }

  beginDispatch(taskId: string, input: { workerId?: string; sessionId?: string; runtimeBinding?: JsonValue } = {}): Task {
    if (input.workerId !== undefined) requiredString(input.workerId, 'workerId');
    if (input.sessionId !== undefined) requiredString(input.sessionId, 'sessionId');
    return this.write(() => {
      const row = this.taskRow(taskId);
      if (row.dispatch_attempted_at !== null) fail('DISPATCH_ALREADY_ATTEMPTED', 'Dispatch intent already exists; reconcile instead of resending');
      if (row.status !== 'queued' || row.lease_held !== 1 || row.execution_stopped === 1) fail('INVALID_TRANSITION', 'Only an unstarted queued task can be dispatched');
      const workerId = input.workerId ?? row.worker_id;
      requiredString(workerId, 'workerId');
      if (row.requested_worker_id !== null && workerId !== row.requested_worker_id) fail('WORKER_MISMATCH', 'Cannot silently change the requested worker');
      this.assertWorkerAvailable(workerId, taskId);
      const at = this.now();
      this.db.prepare(`UPDATE tasks SET status = 'dispatching', worker_id = ?, session_id = ?, dispatch_attempted_at = ?, runtime_binding = ? WHERE task_id = ?`)
        .run(workerId, input.sessionId ?? null, at, canonicalJson(input.runtimeBinding ?? null), taskId);
      this.db.prepare('INSERT INTO task_attempts(task_id,attempt_index,command_id,session_id,intent_at) VALUES(?,0,?,?,?)')
        .run(taskId,row.current_command_id,input.sessionId ?? null,at);
      this.event(taskId, 'dispatch_intent', 'dispatching', { workerId, sessionId: input.sessionId ?? null }, at);
      return this.getTask(taskId);
    });
  }

  acknowledgeDispatch(taskId: string, refs: { sessionId?: string; turnId?: string } = {}): Task {
    if (refs.sessionId !== undefined) requiredString(refs.sessionId, 'sessionId');
    if (refs.turnId !== undefined) requiredString(refs.turnId, 'turnId');
    return this.write(() => {
      const row = this.taskRow(taskId);
      if ((row.session_id !== null && refs.sessionId !== undefined && row.session_id !== refs.sessionId)
        || (row.turn_id !== null && refs.turnId !== undefined && row.turn_id !== refs.turnId)) {
        fail('RUNTIME_REFERENCE_CONFLICT', 'Runtime session/turn identity cannot be changed');
      }
      if (row.status === 'running' && (refs.sessionId === undefined || refs.sessionId === row.session_id)
        && (refs.turnId === undefined || refs.turnId === row.turn_id)) return taskFromRow(row);
      if (row.status !== 'dispatching' || row.execution_stopped === 1) fail('INVALID_TRANSITION', 'Only a pending dispatch can be acknowledged');
      this.db.prepare("UPDATE tasks SET status = 'running', session_id = ?, turn_id = ? WHERE task_id = ?")
        .run(refs.sessionId ?? row.session_id, refs.turnId ?? row.turn_id, taskId);
      this.db.prepare('UPDATE task_attempts SET session_id = ?, turn_id = ?, acknowledged_at = ? WHERE task_id = ? AND command_id = ?')
        .run(refs.sessionId ?? row.session_id,refs.turnId ?? row.turn_id,this.now(),taskId,row.current_command_id);
      const detail: JsonValue = { sessionId: refs.sessionId ?? row.session_id, turnId: refs.turnId ?? row.turn_id };
      this.event(taskId, 'dispatch_acknowledged', 'running', detail, this.now());
      return this.getTask(taskId);
    });
  }

  /** Persist the native session before sending a turn, without claiming acceptance. */
  bindSession(taskId: string, sessionId: string): Task {
    requiredString(sessionId, 'sessionId');
    return this.write(() => {
      const row = this.taskRow(taskId);
      if (row.status !== 'dispatching' || row.execution_stopped === 1) fail('INVALID_TRANSITION', 'Only a pending dispatch can bind its runtime session');
      if (row.session_id !== null) {
        if (row.session_id !== sessionId) fail('RUNTIME_REFERENCE_CONFLICT', 'Runtime session identity cannot be changed');
        return taskFromRow(row);
      }
      this.db.prepare('UPDATE tasks SET session_id = ? WHERE task_id = ?').run(sessionId, taskId);
      this.db.prepare('UPDATE task_attempts SET session_id = ? WHERE task_id = ? AND command_id = ?')
        .run(sessionId,taskId,row.current_command_id);
      this.event(taskId, 'session_bound', row.status, { sessionId }, this.now());
      return this.getTask(taskId);
    });
  }

  listAttempts(taskId: string): TaskAttempt[] {
    this.taskRow(taskId);
    return (this.db.prepare('SELECT * FROM task_attempts WHERE task_id = ? ORDER BY attempt_index').all(taskId) as unknown as AttemptRow[]).map(attemptFromRow);
  }

  getCurrentAttempt(taskId: string): TaskAttempt | null {
    const task = this.taskRow(taskId);
    const row = this.db.prepare('SELECT * FROM task_attempts WHERE task_id = ? AND command_id = ?')
      .get(taskId,task.current_command_id) as unknown as AttemptRow | undefined;
    return row ? attemptFromRow(row) : null;
  }

  /** Only explicitly attributed failure evidence is supplied here by the native adapter. */
  recordAttemptFailure(taskId: string, commandId: string, input: {category: string; busyRetryEligible: boolean}): TaskAttempt {
    requiredString(commandId,'commandId');requiredString(input.category,'category');
    return this.write(() => {
      const row = this.taskRow(taskId);
      if (row.current_command_id !== commandId || !this.getCurrentAttempt(taskId)) fail('RUNTIME_REFERENCE_CONFLICT','Failure evidence must identify the current native command');
      const eligible = input.category === 'model_busy' && input.busyRetryEligible;
      const current = this.getCurrentAttempt(taskId)!;
      // A disqualifying owned failure is never erased by a later busy diagnostic.
      const blocked = current.continuationBlocked || !eligible;
      if (current.failureCategory===input.category && current.busyRetryEligible===eligible && current.continuationBlocked===blocked) return current;
      this.db.prepare('UPDATE task_attempts SET failure_category = ?, busy_retry_eligible = ?, continuation_blocked = ? WHERE task_id = ? AND command_id = ?')
        .run(input.category,eligible?1:0,blocked?1:0,taskId,commandId);
      this.event(taskId,'attempt_failure_observed',row.status,{commandId,category:input.category,busyRetryEligible:eligible,continuationBlocked:blocked},this.now());
      return this.getCurrentAttempt(taskId)!;
    });
  }

  /** Record termination for this attempt without releasing the task's lease or entering verification. */
  recordAttemptTerminal(taskId: string, commandId: string, state: NonNullable<TaskAttempt['terminalState']>, proof: StopProof): TaskAttempt {
    if (!['completedSuccess','failed','completedInterrupted'].includes(state)) fail('INVALID_ARGUMENT','Invalid attempt terminal state');
    return this.write(() => {
      const row = this.taskRow(taskId);
      const attempt = this.getCurrentAttempt(taskId);
      if (row.current_command_id !== commandId || !attempt) fail('RUNTIME_REFERENCE_CONFLICT','Terminal proof must identify the current native command');
      if (attempt.terminalState && attempt.terminalState !== state) fail('RUNTIME_REFERENCE_CONFLICT','Observed native terminal state cannot change');
      if (attempt.terminalState === state && attempt.stopProof?.kind === proof.kind) return attempt;
      const normalized = this.normalizeProof(row,proof);
      this.db.prepare('UPDATE task_attempts SET terminal_state = ?, stop_proof = ? WHERE task_id = ? AND command_id = ?')
        .run(state,canonicalJson(normalized),taskId,commandId);
      this.event(taskId,'attempt_terminal_observed',row.status,{commandId,state,proof:normalized as unknown as JsonValue},this.now());
      return this.getCurrentAttempt(taskId)!;
    });
  }

  /** Commit a fresh continuation intent exactly once. A committed command is never sent again. */
  beginBusyContinuation(taskId: string, expectedCommandId: string, maxContinuations: number): Task {
    nonnegativeInteger(maxContinuations,'maxContinuations');
    if (maxContinuations > 10) fail('INVALID_ARGUMENT','maxContinuations must not exceed 10');
    return this.write(() => {
      const row = this.taskRow(taskId);
      const attempt = this.getCurrentAttempt(taskId);
      if (row.current_command_id !== expectedCommandId || !attempt) fail('RUNTIME_REFERENCE_CONFLICT','Continuation must follow the current native command');
      if (row.cancel_requested_at !== null) fail('CANCEL_REQUESTED','Cancellation prevents any further continuation');
      if (row.busy_retry_count >= maxContinuations) fail('BUSY_RETRY_LIMIT','Busy continuation limit reached');
      if (!row.session_id || row.lease_held !== 1 || row.execution_stopped !== 0
        || !['dispatching','running','waiting_approval','interrupted'].includes(row.status)
        || attempt.terminalState !== 'failed' || !attempt.busyRetryEligible || attempt.continuationBlocked
        || attempt.stopProof?.kind !== 'history_stopped' || row.runtime_binding === 'null'
        || this.hasEnteredVerification(taskId) || this.getResult(taskId)) {
        fail('INVALID_TRANSITION','Continuation requires an attributed busy terminal with checked inactive native work and the original runtime binding');
      }
      const commandId = `continue_${randomUUID()}`;
      const index = row.busy_retry_count+1;
      const at = this.now();
      this.db.prepare('INSERT INTO task_attempts(task_id,attempt_index,command_id,session_id,intent_at) VALUES(?,?,?,?,?)')
        .run(taskId,index,commandId,row.session_id,at);
      this.db.prepare("UPDATE tasks SET status = 'dispatching', current_command_id = ?, turn_id = NULL, busy_retry_count = ?, execution_stopped = 0, stop_proof = NULL, detail = ? WHERE task_id = ?")
        .run(commandId,index,canonicalJson({reason:'model_busy',retry:{used:index,max:maxContinuations,reason:'model_busy'}}),taskId);
      this.event(taskId,'busy_continue_intent','dispatching',{commandId,previousCommandId:expectedCommandId,retry:{used:index,max:maxContinuations,reason:'model_busy'}},at);
      return this.getTask(taskId);
    });
  }

  requestCancellation(taskId: string): Task {
    return this.write(() => {
      const row = this.taskRow(taskId);
      if (row.cancel_requested_at !== null || FINAL_STATUSES.has(row.status)) return taskFromRow(row);
      const at = this.now();
      this.db.prepare('UPDATE tasks SET cancel_requested_at = ? WHERE task_id = ?').run(at,taskId);
      this.event(taskId,'cancellation_requested',row.status,{currentCommandId:row.current_command_id},at);
      return this.getTask(taskId);
    });
  }

  /** Reattach only after the coordinator has observed this exact existing native command. */
  reattachTask(taskId: string, refs: {
    sessionId: string; turnId: string; status: 'running' | 'waiting_approval' | 'blocked'; detail?: JsonValue;
  }): Task {
    requiredString(refs.sessionId, 'sessionId');
    requiredString(refs.turnId, 'turnId');
    if (!['running', 'waiting_approval', 'blocked'].includes(refs.status)) fail('INVALID_ARGUMENT', 'Invalid attachment status');
    return this.write(() => {
      const row = this.taskRow(taskId);
      if (row.dispatch_attempted_at === null || row.session_id === null || row.lease_held !== 1 || row.execution_stopped === 1
        || !['dispatching', 'running', 'waiting_approval', 'blocked', 'interrupted'].includes(row.status)) {
        fail('INVALID_TRANSITION', 'Only an occupied, uncertain dispatched task can reattach to observed native execution');
      }
      if (row.session_id !== refs.sessionId || (row.turn_id !== null && row.turn_id !== refs.turnId)) {
        fail('RUNTIME_REFERENCE_CONFLICT', 'Runtime session/turn identity cannot be changed');
      }
      const detail = canonicalJson(refs.detail ?? null);
      if (row.status === refs.status && row.turn_id === refs.turnId && row.detail === detail) return taskFromRow(row);
      this.db.prepare('UPDATE tasks SET status = ?, turn_id = ?, detail = ? WHERE task_id = ?')
        .run(refs.status, refs.turnId, detail, taskId);
      this.db.prepare('UPDATE task_attempts SET turn_id = ?, acknowledged_at = COALESCE(acknowledged_at,?) WHERE task_id = ? AND command_id = ?')
        .run(refs.turnId,this.now(),taskId,row.current_command_id);
      this.event(taskId, 'execution_reattached', refs.status, JSON.parse(detail) as JsonValue, this.now());
      return this.getTask(taskId);
    });
  }

  /** Verification commands may have side effects, including child processes surviving a crash. */
  hasEnteredVerification(taskId: string): boolean {
    this.taskRow(taskId);
    return this.db.prepare("SELECT 1 FROM task_events WHERE task_id = ? AND status = 'verifying' LIMIT 1").get(taskId) !== undefined;
  }

  /** Preserve occupancy when verification cannot be completed or safely retried. */
  interruptVerification(taskId: string, detail: JsonValue): Task {
    return this.write(() => {
      const row = this.taskRow(taskId);
      if (row.status !== 'verifying' || row.lease_held !== 1 || row.execution_stopped !== 1) {
        fail('INVALID_TRANSITION', 'Only occupied verification can be interrupted without releasing its lease');
      }
      this.db.prepare("UPDATE tasks SET status = 'interrupted', detail = ? WHERE task_id = ?")
        .run(canonicalJson(detail), taskId);
      this.event(taskId, 'verification_interrupted', 'interrupted', detail, this.now());
      return this.getTask(taskId);
    });
  }

  /** Report inspection requirements without inferring termination or releasing occupancy. */
  recordRecoveryInspection(taskId: string, detail: JsonValue): Task {
    return this.write(() => {
      const row = this.taskRow(taskId);
      const encoded = canonicalJson(detail);
      if (row.detail === encoded) return taskFromRow(row);
      this.db.prepare('UPDATE tasks SET detail = ? WHERE task_id = ?').run(encoded, taskId);
      this.event(taskId, 'recovery_requires_inspection', row.status, detail, this.now());
      return this.getTask(taskId);
    });
  }

  private normalizeProof(row: TaskRow, proof: StopProof): StopProof {
    if (!['runtime_terminal', 'process_exited', 'history_stopped', 'not_dispatched'].includes(proof?.kind)) fail('INVALID_ARGUMENT', 'Invalid execution stop proof kind');
    requiredString(proof.evidence, 'stopProof.evidence');
    const observedAt = proof.observedAt ?? this.now();
    nonnegativeInteger(observedAt, 'stopProof.observedAt');
    if (proof.kind === 'not_dispatched' && row.dispatch_attempted_at !== null) fail('INVALID_STOP_PROOF', 'A dispatch intent exists; absence of an acknowledgement does not prove non-execution');
    if (row.dispatch_attempted_at !== null && observedAt < row.dispatch_attempted_at) fail('INVALID_STOP_PROOF', 'Stop observation predates the dispatch intent');
    return { kind: proof.kind, evidence: proof.evidence, observedAt };
  }

  observeExecutionStopped(taskId: string, proof: StopProof): Task {
    return this.write(() => {
      const row = this.taskRow(taskId);
      const normalized = this.normalizeProof(row, proof);
      const release = RELEASE_STATUSES.has(row.status);
      this.db.prepare('UPDATE tasks SET execution_stopped = 1, stop_proof = ?, lease_held = ? WHERE task_id = ?')
        .run(canonicalJson(normalized), release ? 0 : row.lease_held, taskId);
      this.event(taskId, 'execution_stopped', row.status, normalized as unknown as JsonValue, this.now());
      return this.getTask(taskId);
    });
  }

  private transition(row: TaskRow, status: TaskStatus, options: TransitionOptions, eventType = 'status_changed'): Task {
    if (!STATUSES.has(status)) fail('INVALID_ARGUMENT', 'Invalid task status');
    if (status === 'dispatching') fail('INVALID_TRANSITION', 'Use beginDispatch to persist the dispatch intent');
    if (row.status !== status && !TRANSITIONS[row.status].includes(status)) fail('INVALID_TRANSITION', `Cannot transition ${row.status} to ${status}`);
    let proof = options.executionStopped === undefined ? null : this.normalizeProof(row, options.executionStopped);
    if (status === 'cancelled' && row.dispatch_attempted_at === null && proof === null && row.execution_stopped === 0) {
      proof = { kind: 'not_dispatched', evidence: 'Durable task has no dispatch intent', observedAt: this.now() };
    }
    const stopped = proof !== null || row.execution_stopped === 1;
    if ((FINAL_STATUSES.has(status) || status === 'verifying') && !stopped) fail('EXECUTION_NOT_STOPPED', 'Observed stopped execution is required before verification or a final state');
    if (status === 'verifying' && row.lease_held !== 1) fail('LEASE_RELEASED', 'Cannot verify a task after releasing its workspace lease');
    if ((status === 'running' || status === 'waiting_approval') && stopped) fail('INVALID_TRANSITION', 'A stopped task cannot resume execution');
    if (status === 'succeeded' && !this.db.prepare('SELECT task_id FROM task_results WHERE task_id = ?').get(row.task_id)) {
      fail('RESULT_REQUIRED', 'Success requires an immutable task result');
    }
    const detail = options.detail === undefined ? row.detail : canonicalJson(options.detail);
    if (row.status === status && proof === null && detail === row.detail) return taskFromRow(row);
    const release = stopped && RELEASE_STATUSES.has(status);
    this.db.prepare('UPDATE tasks SET status = ?, execution_stopped = ?, stop_proof = ?, lease_held = ?, detail = ? WHERE task_id = ?')
      .run(status, stopped ? 1 : 0, proof === null ? row.stop_proof : canonicalJson(proof), release ? 0 : row.lease_held, detail, row.task_id);
    const eventDetail: JsonValue = proof === null
      ? JSON.parse(detail) as JsonValue
      : { detail: JSON.parse(detail) as JsonValue, executionStopped: proof as unknown as JsonValue };
    this.event(row.task_id, eventType, status, eventDetail, this.now());
    return this.getTask(row.task_id);
  }

  transitionTask(taskId: string, status: TaskStatus, options: TransitionOptions = {}): Task {
    return this.write(() => this.transition(this.taskRow(taskId), status, options));
  }

  markInterrupted(taskId: string, detail: JsonValue = null): Task {
    return this.transitionTask(taskId, 'interrupted', { detail });
  }

  markBlocked(taskId: string, detail: JsonValue = null): Task {
    return this.transitionTask(taskId, 'blocked', { detail });
  }

  /** Run once after obtaining the daemon lock. Never replay an uncertain turn. */
  recoverInterruptedTasks(): Task[] {
    return this.write(() => {
      const rows = this.db.prepare("SELECT * FROM tasks WHERE status IN ('dispatching','running','waiting_approval','verifying') ORDER BY created_at,task_id")
        .all() as unknown as TaskRow[];
      return rows.map((row) => {
        const detail: JsonValue = { reason: 'daemon_restarted', previousStatus: row.status, action: 'reconcile_before_any_new_dispatch' };
        // Retain leases even when a previous runtime stop proof exists: interrupted
        // verification may itself still have an external process to reconcile.
        this.db.prepare("UPDATE tasks SET status = 'interrupted', detail = ? WHERE task_id = ?")
          .run(canonicalJson(detail), row.task_id);
        this.event(row.task_id, 'recovery_interrupted', 'interrupted', detail, this.now());
        return this.getTask(row.task_id);
      });
    });
  }

  private putResult(row: TaskRow, result: Required<TaskResult>): boolean {
    const payload = canonicalJson(result);
    const existing = this.db.prepare('SELECT payload,created_at FROM task_results WHERE task_id = ?')
      .get(row.task_id) as unknown as ResultRow | undefined;
    if (existing) {
      if (existing.payload !== payload) fail('RESULT_IMMUTABLE', 'A task result and its artifact metadata cannot be overwritten');
      return false;
    }
    this.db.prepare('INSERT INTO task_results(task_id,payload,created_at) VALUES(?,?,?)').run(row.task_id, payload, this.now());
    return true;
  }

  recordResult(taskId: string, result: TaskResult): PersistedTaskResult {
    const normalized = normalizeResult(result);
    return this.write(() => {
      const row = this.taskRow(taskId);
      if (row.execution_stopped !== 1) fail('EXECUTION_NOT_STOPPED', 'Stop execution before publishing its result artifacts');
      if (this.putResult(row, normalized)) this.event(taskId, 'result_recorded', row.status, null, this.now());
      return this.getResult(taskId)!;
    });
  }

  completeTask(taskId: string, result: TaskResult, options: {
    status: 'succeeded' | 'failed'; executionStopped?: StopProof; detail?: JsonValue;
  }): Task {
    if (options?.status !== 'succeeded' && options?.status !== 'failed') fail('INVALID_ARGUMENT', 'Completion status must be succeeded or failed');
    const normalized = normalizeResult(result);
    return this.write(() => {
      const row = this.taskRow(taskId);
      this.putResult(row, normalized);
      return this.transition(row, options.status, options, 'task_completed');
    });
  }

  getTask(taskId: string): Task {
    return taskFromRow(this.taskRow(taskId));
  }

  listTasks(): Task[] {
    this.ensureOpen();
    return (this.db.prepare('SELECT * FROM tasks ORDER BY created_at,task_id').all() as unknown as TaskRow[]).map(taskFromRow);
  }

  getResult(taskId: string): PersistedTaskResult | null {
    this.taskRow(taskId);
    const result = this.db.prepare('SELECT payload,created_at FROM task_results WHERE task_id = ?')
      .get(taskId) as unknown as ResultRow | undefined;
    return result ? { ...JSON.parse(result.payload) as Required<TaskResult>, taskId, createdAt: result.created_at } : null;
  }

  listEvents(taskId: string, options?: { afterRevision?: number; limit?: number }): TaskEvent[];
  listEvents(taskId: string, afterRevision?: number, limit?: number): TaskEvent[];
  listEvents(taskId: string, options: { afterRevision?: number; limit?: number } | number = {}, positionalLimit?: number): TaskEvent[] {
    this.taskRow(taskId);
    const afterRevision = typeof options === 'number' ? options : options.afterRevision ?? 0;
    const limit = (typeof options === 'number' ? positionalLimit : options.limit) ?? 100;
    nonnegativeInteger(afterRevision, 'afterRevision');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_ARGUMENT', 'Event limit must be between 1 and 500');
    return (this.db.prepare('SELECT * FROM task_events WHERE task_id = ? AND revision > ? ORDER BY revision LIMIT ?')
      .all(taskId, afterRevision, limit) as unknown as EventRow[]).map((row) => ({
        revision: row.revision, taskId: row.task_id, type: row.type,
        status: row.status, detail: JSON.parse(row.detail) as JsonValue, createdAt: row.created_at,
      }));
  }

  appendEvent(taskId: string, type: string, detail: JsonValue = null): TaskEvent {
    requiredString(type, 'event.type');
    return this.write(() => {
      const row = this.taskRow(taskId);
      const at = this.now();
      const revision = this.event(taskId, type, row.status, detail, at);
      return { revision, taskId, type, status: row.status, detail: JSON.parse(canonicalJson(detail)) as JsonValue, createdAt: at };
    });
  }

  getRevision(): number {
    this.ensureOpen();
    return (this.db.prepare('SELECT COALESCE(MAX(revision), 0) AS revision FROM task_events').get() as { revision: number }).revision;
  }

  wait(input: WaitInput): Promise<WaitResult> {
    this.ensureOpen();
    if (!Array.isArray(input?.taskIds) || input.taskIds.length < 1 || input.taskIds.length > 100) fail('INVALID_ARGUMENT', 'wait requires between 1 and 100 task IDs');
    for (const id of input.taskIds) requiredString(id, 'taskId');
    const taskIds = [...new Set(input.taskIds)];
    const timeoutMs = input.timeoutMs ?? MAX_WAIT_MS;
    nonnegativeInteger(timeoutMs, 'timeoutMs');
    if (timeoutMs > MAX_WAIT_MS) fail('INVALID_ARGUMENT', `timeoutMs must not exceed ${MAX_WAIT_MS}`);
    const afterRevision = input.afterRevision;
    if (typeof afterRevision === 'number') nonnegativeInteger(afterRevision, 'afterRevision');
    else if (afterRevision !== undefined) {
      if (afterRevision === null || typeof afterRevision !== 'object' || Array.isArray(afterRevision)) fail('INVALID_ARGUMENT', 'afterRevision must be a number or a task revision map');
      for (const taskId of taskIds) {
        if (!Object.hasOwn(afterRevision, taskId)) fail('INVALID_ARGUMENT', `Missing revision cursor for task ${taskId}`);
        nonnegativeInteger(afterRevision[taskId], `afterRevision.${taskId}`);
      }
    }
    // Take immutable copies before the asynchronous wait so callers cannot move
    // its cursor or task set after registering it.
    const cursors = Object.fromEntries(taskIds.map((taskId) => [taskId,
      typeof afterRevision === 'number' ? afterRevision : afterRevision?.[taskId] ?? -1]));
    return new Promise<WaitResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let poll: ReturnType<typeof setInterval> | undefined;
      const cleanup = (): void => {
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (poll !== undefined) clearInterval(poll);
        this.listeners.delete(check);
        this.closeListeners.delete(onClose);
      };
      const check = (timedOut = false): void => {
        if (settled) return;
        try {
          // One read transaction keeps a global cursor from advancing past an
          // event that is absent from the returned task snapshots.
          this.ensureOpen();
          this.db.exec('BEGIN');
          let tasks: Task[];
          let revision: number;
          try {
            tasks = taskIds.map((taskId) => this.getTask(taskId));
            revision = this.getRevision();
            this.db.exec('COMMIT');
          } catch (error) {
            try { this.db.exec('ROLLBACK'); } catch { /* Preserve the read failure. */ }
            throw error;
          }
          const changedTaskIds = tasks.filter((task) => task.revision > cursors[task.taskId]!).map((task) => task.taskId);
          if (changedTaskIds.length > 0 || timedOut || timeoutMs === 0) {
            cleanup();
            resolve({ tasks, changedTaskIds, timedOut: changedTaskIds.length === 0, revision });
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const onClose = (): void => {
        cleanup();
        reject(new CoreError('STORE_CLOSED', 'The task store was closed while waiting'));
      };
      // Registration precedes the first read. Same-process writes wake this
      // immediately; polling observes commits by another connection/process.
      this.listeners.add(check);
      this.closeListeners.add(onClose);
      check();
      if (!settled) {
        timer = setTimeout(() => check(true), timeoutMs);
        poll = setInterval(check, this.pollIntervalMs);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
    this.listeners.clear();
    this.closeListeners.clear();
    this.db.close();
  }
}
