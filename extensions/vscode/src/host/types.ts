import type { UiTaskDetail, UiQuota, UiArtifactManifest, UiArtifactFile, UiRpcResult } from '../../../../src/shared/ui-contract.js';
import type { PoolPolicy } from '../../../../src/core/types.js';
export type UiPoolPolicy = Pick<PoolPolicy, 'maxConcurrentTasks' | 'occupiedSlots' | 'availableSlots'> & Partial<PoolPolicy>;
/** Browser-safe view models. These contain no daemon objects or credential data. */
export interface UiTask {
  taskId: string; workspaceId: string; workerId: string | null; status: string; revision: number;
  createdAtMs?: number; updatedAtMs?: number; leaseHeld: boolean; executionStopped?: boolean;
  cancelRequestedAtMs?: number | null;
  approval?: { pendingCount: number | null; responsePending: boolean; stateKnown: boolean };
  retry?: { used: number; max: number | null; reason: 'model_busy' };
  deliveryReview?: 'unknown' | 'pending' | 'reviewed';
}
export interface UiAccount { alias: string; provider: string; health: string; plan?: string; email?: string; name?: string; enabled?: boolean }
export interface UiWorker { workerId: string; accountAlias: string; state: string; processOwned: boolean; runningTaskCount?: number; version?: string; leaseTaskIds: string[] }
export interface UiWorkspace { workspaceId: string; repositoryPath: string; worktreePath: string; branch: string; baseCommit: string; state: string; activeTaskId: string | null }
export interface UiProject {repositoryId:string;repositoryPath:string}
export interface UiConnection {
  state: 'disconnected' | 'connecting' | 'connected' | 'legacy-readonly' | 'error';
  mode: 'mock' | 'real'; generation: number; host: string; poolHome: string; trusted: boolean;
  lastReceivedAtMs: number | null; stale: boolean; storeId: string | null; instanceId: string | null;
  daemonVersion: string | null; capabilities: Record<string, { version: number; reason?: string }>;
  supported?: boolean; environmentReason?: string | null;
  error: UiError | null;
}
export interface UiError { code: string; message: string; unknownOutcome?: boolean }
export interface TaskDraft {
  workspaceId: string; workerId: string; prompt: string; session: 'continue' | 'new';
  mode: 'build' | 'edit' | 'plan' | 'yolo' | 'guarded'; modelId: string;
  verifyCommands: { command: string; args: string[]; timeoutMs: number }[];
  submitToken: string;
}
export interface UiActionState { key: string; phase: 'pending' | 'succeeded' | 'unknown' | 'failed'; message: string; requestId?: string; taskId?: string; error?: UiError }
export interface UiSnapshot {
  projects:UiProject[];
  poolPolicy: UiPoolPolicy | null;
  workOverview?: UiRpcResult<'ui_get_work_overview'>['data'] | null;
  workOverviewScope?: {repositoryPath:string|null;workId:string|null};
  decisionTodos?: {workId:string;repositoryPath:string;goal:string;todo:UiRpcResult<'ui_get_work_overview'>['data']['works'][number]['todos'][number]}[];
  errorStats?: UiRpcResult<'ui_get_error_stats'>['data'] | null;
  errorStatsQuery?: {accountAlias?:string;taskId?:string;fromMs?:number;toMs?:number;observedAtMs:number} | null;
  preferredRepositoryId?: string | null;
  focusRequest?: {id:string;target:'pending';workId?:string};
  connection: UiConnection;
  tasks: UiTask[]; scope: 'recent_50_loaded' | 'all_matching_tasks'; total: number | null; listNextCursor: string | null;
  selectedTaskId: string | null; detail: UiTaskDetail | null;
  legacyResult?: { task: UiTask; result: { summary: string; changedFiles?: string[]; verification?: {command:string;exitCode:number|null;summary?:string}[];blockers?:string[] } | null } | null;
  resources: { accounts: UiAccount[]; workers: UiWorker[]; workspaces: UiWorkspace[]; quotas: Record<string, UiQuota> };
  approvals: UiRpcResult<'ui_list_approvals'>['data'] | null;
  delivery: { manifest: UiArtifactManifest | null; files: UiArtifactFile[]; nextCursor: string | null; reviewed: boolean };
  draft: TaskDraft; actions: UiActionState[];
  overviewIntervalSeconds: number; notice: string | null;
}
export type HostPush = { v: 1; type: 'state'; generation: number; data: UiSnapshot };
export type HostResponse<T = unknown> = { v: 1; id: string; generation: number } & ({ ok: true; data: T } | { ok: false; error: UiError });
