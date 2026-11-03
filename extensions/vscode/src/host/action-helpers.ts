import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { uiPermissionReviewSchema, type UiApprovalReview, type UiTaskDetail, type UiArtifactFile, type UiArtifactManifest, type UiRpcResult, type UiMethodName, type UiRpcParams } from '../../../../src/shared/ui-contract.js';
import { HostError, safeError, type Transport } from './client.js';
import type { ProjectContext } from './project-context.js';
import type { RequestPayload } from './protocol.js';
import type { UiSnapshot, TaskDraft, UiWorkspace, UiAccount } from './types.js';

export interface NativeAdapter {
  trusted(): boolean; getState<T>(key: string, fallback: T): T; setState(key: string, value: unknown): Promise<void>;
  pickAccountFiles(host: string): Promise<string[] | undefined>; pickRepository(host: string): Promise<string | undefined>;
  openDiff(taskId: string, manifestSha256: string, file: UiArtifactFile, read: (side: 'base' | 'final') => Promise<string>): Promise<void>;
  openCurrentFile?(worktreePath: string, relativePath: string): Promise<void>; openSettings(): Promise<void>;
  configureConnection?(): Promise<void>; codexSetup?(): Promise<{ cancelled?: boolean }>; startDaemon?(): Promise<void>;
  saveInterval(value: number): Promise<void>; copyDiagnostics(value: string): Promise<void>; guidance(topic: string): Promise<void>;
}

export interface ServiceOptions {
  mode: 'mock' | 'real'; poolHome: string; host: string; authority: string;
  createTransport(): Promise<Transport>; native: NativeAdapter; onSnapshot(snapshot: UiSnapshot): void;
  overviewIntervalSeconds?: number; initialGeneration?: number; supported?: boolean; environmentReason?: string;
  configurationError?: HostError; projectContext?(): ProjectContext;
}

export interface Recovery { requestId: string; payloadHash: string; workspaceId: string; workerId: string; poolKey: string; taskId?: string }
export interface ReviewEntry { review: UiApprovalReview; loadedComplete: boolean; text?: string }

export const blankDraft = (): TaskDraft => ({ workspaceId: '', workerId: '', prompt: '', session: 'continue', mode: 'build', modelId: 'GLM-5.3-Flash', verifyCommands: [], submitToken: randomUUID() });
export const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function createInitialSnapshot(options: ServiceOptions): UiSnapshot {
  return {
    connection: {
      state: options.configurationError ? 'error' : 'disconnected', mode: options.mode, generation: options.initialGeneration ?? 0,
      host: options.host, poolHome: options.poolHome, trusted: options.native.trusted(), lastReceivedAtMs: null, stale: false,
      storeId: null, instanceId: null, daemonVersion: null, capabilities: {},
      error: options.configurationError ? safeError(options.configurationError) : null,
      supported: options.supported ?? true, environmentReason: options.environmentReason ?? null
    },
    projects:[],poolPolicy: null, workOverview: null, workOverviewScope:{repositoryPath:null,workId:null}, decisionTodos:[], errorStats: null, tasks: [], scope: 'recent_50_loaded', total: null, listNextCursor: null, selectedTaskId: null, detail: null,
    resources: { accounts: [], workers: [], workspaces: [], quotas: {} }, approvals: null,
    delivery: { manifest: null, files: [], nextCursor: null, reviewed: false }, draft: blankDraft(), actions: [],
    overviewIntervalSeconds: options.overviewIntervalSeconds ?? 30, notice: null
  };
}

export function resetDisconnectedSnapshot(state: UiSnapshot, configurationError: HostError | undefined, nextGeneration: number): void {
  state.connection = {
    ...state.connection, state: configurationError ? 'error' : 'disconnected', generation: nextGeneration,
    stale: state.tasks.length > 0, error: configurationError ? safeError(configurationError) : null,
    storeId: null, instanceId: null, capabilities: {}
  };
  state.detail = null; state.selectedTaskId = null; state.legacyResult = null; state.approvals = null;
  state.delivery = { manifest: null, files: [], nextCursor: null, reviewed: false };
  state.resources.quotas = {}; state.poolPolicy = null; state.workOverview = null; state.workOverviewScope={repositoryPath:null,workId:null};state.decisionTodos=[];delete state.focusRequest;state.errorStats = null; state.tasks = []; state.total = null; state.listNextCursor = null;
}

export function buildTaskListWireFilter(filter: RequestPayload<'tasks.list'>['filter'],projects:{repositoryId:string;repositoryPath:string}[]) {
  const repository = filter?.repositoryId ? projects.find(project=>project.repositoryId===filter.repositoryId) : undefined;
  if (filter?.repositoryId && !repository) throw new HostError('NOT_FOUND', 'Choose a project supplied by this Host or the current work overview.');
  return filter ? {
    ...(repository ? { repository_path: repository.repositoryPath } : {}),
    ...(filter.workspaceId ? { workspace_id: filter.workspaceId } : {}),
    ...(filter.workerId ? { worker_id: filter.workerId } : {}),
    ...(filter.statuses ? { statuses: filter.statuses } : {}),
    ...(filter.leaseHeld !== undefined ? { lease_held: filter.leaseHeld } : {}),
    ...(filter.query ? { query: filter.query } : {})
  } : undefined;
}

export function mergeTaskDetail(state: UiSnapshot, taskCache: Map<string, UiTaskDetail>, reviews: Map<string, ReviewEntry>, detail: UiTaskDetail, add = true): void {
  const previous = taskCache.get(detail.taskId);
  if (previous && previous.revision > detail.revision) { if (state.selectedTaskId === detail.taskId) state.detail = previous; return; }
  taskCache.set(detail.taskId, detail);
  if (detail.executionStopped || detail.cancelRequestedAtMs !== null || detail.approval.pendingCount === 0) {
    for (const entry of reviews.values()) if (entry.review.taskId === detail.taskId) { entry.loadedComplete = false; delete entry.text; }
  }
  const index = state.tasks.findIndex(task => task.taskId === detail.taskId);
  const priorReview = index >= 0 ? state.tasks[index]!.deliveryReview : undefined;
  const summary = { ...detail, deliveryReview: detail.result.available ? (priorReview === 'reviewed' ? 'reviewed' : 'pending') : 'unknown' } as const;
  if (index >= 0) { if (state.tasks[index]!.revision <= detail.revision) state.tasks[index] = summary; }
  else if (add) state.tasks.unshift(summary);
  if (state.selectedTaskId === detail.taskId) state.detail = detail;
}

export function buildDispatchPayload(state: UiSnapshot, submitToken: string) {
  const draft = state.draft;
  if (draft.submitToken !== submitToken) throw new HostError('ACTION_CONFLICT', 'This submission belongs to an earlier draft.');
  const payload = {
    workspace_id: draft.workspaceId, worker_id: draft.workerId, prompt: draft.prompt, session: draft.session,
    mode: draft.mode, model_id: draft.modelId,
    verify_commands: draft.verifyCommands.map(c => ({ command: c.command, args: c.args, timeout_ms: c.timeoutMs }))
  };
  return { draft, payload, fingerprint: sha256(JSON.stringify(payload)) };
}

export function validateDispatchResources(state: UiSnapshot): void {
  const draft = state.draft;
  const workspace = state.resources.workspaces.find(w => w.workspaceId === draft.workspaceId);
  const worker = state.resources.workers.find(w => w.workerId === draft.workerId);
  if (!workspace || workspace.state !== 'active' || workspace.activeTaskId || !worker || worker.state !== 'ready' || worker.leaseTaskIds.length) {
    throw new HostError('RESOURCE_UNAVAILABLE', 'Choose a current active workspace and a ready worker without known or uncertain occupancy.');
  }
  const account = state.resources.accounts.find(a => a.alias === worker.accountAlias);
  if (!account || ['blocked', 'invalid', 'cooling'].includes(account.health)) throw new HostError('AUTH_INVALID', 'The selected worker account is unavailable.');
  if (!draft.prompt.trim()) throw new HostError('INVALID_ARGUMENT', 'Enter a task prompt.');
}

export function decodeChunk(page: { offsetBytes: number; dataBase64: string; byteLength: number; nextOffsetBytes: number | null; totalBytes: number }, offset: number, total: number): Buffer {
  const chunk = Buffer.from(page.dataBase64, 'base64');
  if (chunk.toString('base64') !== page.dataBase64 || page.offsetBytes !== offset || page.totalBytes !== total || chunk.length !== page.byteLength || chunk.length > 65536 || offset + chunk.length > total || (page.nextOffsetBytes !== null && (page.nextOffsetBytes !== offset + chunk.length || page.nextOffsetBytes <= offset)) || (page.nextOffsetBytes === null && offset + chunk.length !== total)) {
    throw new HostError('INTEGRITY_MISMATCH', 'A content page failed length, position or encoding verification.');
  }
  return chunk;
}

export function validatePermissionContent(data: unknown, review: UiApprovalReview): void {
  const parsed = uiPermissionReviewSchema.safeParse(data);
  if (!parsed.success) throw new HostError('UNSUPPORTED_SCHEMA', 'This permission review contains an unsupported decision schema.');
  const value = parsed.data;
  if (value.taskId !== review.taskId || value.approvalId !== review.approvalId || JSON.stringify(value.owner) !== JSON.stringify(review.owner)) {
    throw new HostError('APPROVAL_CHANGED', 'The permission review belongs to another interaction or attempt.');
  }
  const options = value.interaction.payload.options;
  if (value.interaction.interactionId !== review.approvalId || new Set(options.map(option => option.optionId)).size !== options.length || review.decisions.some(decision => {
    const option = options.find(item => item.optionId === decision.nativeOptionId);
    if (!option || (decision.decision === 'accept' && option.kind !== 'allowOnce') || (decision.decision === 'decline' && option.kind !== 'deny') || decision.decision === 'cancel') return true;
    const response = option.response;
    return response !== undefined && (response.decision !== (decision.decision === 'accept' ? 'allow' : 'deny') || Object.keys(response).some(key => !['decision', 'reason'].includes(key)) || (response.reason !== undefined && typeof response.reason !== 'string'));
  })) {
    throw new HostError('UNSUPPORTED_SCHEMA', 'This interaction does not provide supported allow-once and deny decisions.');
  }
}

export function assertReadApprovalReady(entry: ReviewEntry | undefined, reviewId: string): UiApprovalReview {
  const review = entry?.review;
  if (!entry || !review || review.reviewId !== reviewId || !review.content || !review.content.sourceComplete || review.readOnlyReason) {
    throw new HostError('APPROVAL_READ_ONLY', 'This approval has no complete supported review source.');
  }
  if (review.content.totalBytes > 8388608) throw new HostError('OUTPUT_BUDGET_EXCEEDED', 'Approval content exceeds the complete-review limit.');
  return review;
}

export function decodeAndVerifyApprovalBytes(chunks: Buffer[], review: UiApprovalReview): string {
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== review.content!.totalBytes || sha256(bytes) !== review.content!.sha256) throw new HostError('INTEGRITY_MISMATCH', 'The complete approval digest does not match.');
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    validatePermissionContent(JSON.parse(text), review);
    return text;
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw new HostError('UNSUPPORTED_SCHEMA', 'This approval content is not valid supported permission-review JSON.');
  }
}

export function assertApprovalRespondable(entry: ReviewEntry | undefined, payload: RequestPayload<'approval.respond'>): UiApprovalReview {
  const review = entry?.review;
  if (!entry || !review || review.reviewId !== payload.reviewId || !review.content?.sourceComplete || review.readOnlyReason || review.redactions.some(r => r.decisionRelevant) || review.state !== 'pending' || review.response.state !== 'none' || review.expiresAtMs < Date.now() || review.content.sha256 !== payload.contentSha256 || review.approvalRevision !== payload.approvalRevision || review.nativeRevision !== payload.nativeRevision || !review.decisions.some(d => d.decision === payload.decision)) {
    throw new HostError('APPROVAL_CHANGED', 'This approval is stale, read-only, or no longer supports this decision. Load its current review.');
  }
  if (payload.decision === 'accept' && !entry.loadedComplete) throw new HostError('APPROVAL_NOT_LOADED', 'Load and verify all approval content before allowing this operation.');
  return review;
}

export function assertTaskCanAcceptApproval(task: UiTaskDetail, accounts: UiAccount[]): void {
  const account = accounts.find(a => a.alias === task.selection.binding?.accountAlias);
  if (task.cancelRequestedAtMs !== null || task.status === 'blocked' || !account || ['blocked', 'invalid', 'cooling'].includes(account.health)) {
    throw new HostError('AUTH_INVALID', 'This task or account cannot accept an approval.');
  }
}

export function handleApprovalRespondFailure(reviews: Map<string, ReviewEntry>, approvalReceipts: Map<string, { fingerprint: string; promise: Promise<unknown> }>, key: string, entry: ReviewEntry, review: UiApprovalReview, error: unknown): never {
  entry.loadedComplete = false; delete entry.text;
  if (error instanceof HostError && (['APPROVAL_CHANGED', 'APPROVAL_GONE', 'APPROVAL_READ_ONLY'].includes(error.code) || (review.response.state === 'none' && !error.unknownOutcome))) {
    reviews.delete(key); approvalReceipts.delete(key);
  } else if (review.response.state === 'intent_recorded') review.response.state = 'unknown';
  throw error;
}

export function requireSelectedArtifactFile(state: UiSnapshot, taskId: string, manifestSha256: string, fileId: string): UiArtifactFile {
  if (state.selectedTaskId !== taskId || state.delivery.manifest?.manifestSha256 !== manifestSha256) throw new HostError('ARTIFACT_UNAVAILABLE', 'Load the selected task manifest before opening a file.');
  const file = state.delivery.files.find(f => f.fileId === fileId);
  if (!file) throw new HostError('ARTIFACT_UNAVAILABLE', 'The file does not belong to the loaded immutable manifest.');
  return file;
}

export function applyArtifactListPage(state: UiSnapshot, native: NativeAdapter, deliveryOpened: Set<string>, reviewKey: string, taskId: string, manifest: UiArtifactManifest, page: UiRpcResult<'ui_list_artifact_files'>['data'], cursor?: string): void {
  if (page.manifestSha256 !== manifest.manifestSha256) throw new HostError('INTEGRITY_MISMATCH', 'Artifact list identity changed.');
  state.delivery.files = cursor ? [...state.delivery.files, ...page.items] : page.items;
  state.delivery.nextCursor = page.nextCursor;
  state.delivery.reviewed = native.getState<boolean>(reviewKey, false);
  const summary = state.tasks.find(task => task.taskId === taskId);
  if (summary) summary.deliveryReview = state.delivery.reviewed ? 'reviewed' : 'pending';
  deliveryOpened.add(`${taskId}|${manifest.manifestSha256}`);
}

export function verifyArtifactChunkPage(page: UiRpcResult<'ui_read_artifact_file'>['data'], manifestSha256: string, fileId: string, side: 'base' | 'final', offsetBytes: number, expected: UiArtifactFile['base']): UiRpcResult<'ui_read_artifact_file'>['data'] {
  const chunk = decodeChunk(page, offsetBytes, expected.sizeBytes!);
  if (page.manifestSha256 !== manifestSha256 || page.fileId !== fileId || page.side !== side || page.fileSha256 !== expected.sha256 || sha256(chunk) !== page.chunkSha256) {
    throw new HostError('INTEGRITY_MISMATCH', 'The immutable file page failed identity or hash verification.');
  }
  return page;
}

export function assertSafeWorktreePath(file: UiArtifactFile): string {
  const path = file.finalPath ?? file.relativePath;
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(part => part === '..' || part === '.' || !part)) {
    throw new HostError('PATH_REJECTED', 'This artifact does not have a safe current-worktree path.');
  }
  return path;
}

export function assertReviewPreconditions(state: UiSnapshot, deliveryOpened: Set<string>, viewedFiles: Set<string>, taskId: string, manifestSha256: string, reviewed: boolean): void {
  const manifest = state.delivery.manifest;
  if (state.selectedTaskId !== taskId || manifest?.manifestSha256 !== manifestSha256 || manifest.state !== 'available' || !manifest.fileListComplete || state.delivery.nextCursor || !deliveryOpened.has(`${taskId}|${manifestSha256}`)) {
    throw new HostError('REVIEW_INCOMPLETE', 'Load the complete immutable delivery list, summary and verification before marking it reviewed.');
  }
  if (reviewed && state.delivery.files.some(f => f.nativeDiff.available && !viewedFiles.has(`${taskId}|${manifestSha256}|${f.fileId}`))) {
    throw new HostError('REVIEW_INCOMPLETE', 'Open each available immutable file Diff before marking the delivery reviewed.');
  }
}

export function formatDiagnosticsPayload(state: UiSnapshot): string {
  const c = state.connection;
  return JSON.stringify({ host: c.host, pool: c.poolHome, mode: c.mode, state: c.state, storeId: c.storeId, instanceId: c.instanceId, daemonVersion: c.daemonVersion, error: c.error?.code, taskId: state.selectedTaskId, revision: state.detail?.revision }, null, 2);
}

export function decodeUtf8Artifact(chunks: Buffer[], expectedSize: number, expectedSha256: string): string {
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== expectedSize || sha256(bytes) !== expectedSha256) throw new HostError('INTEGRITY_MISMATCH', 'The complete immutable file hash does not match.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new HostError('ARTIFACT_UNAVAILABLE', 'The immutable file does not contain strict UTF-8 text.'); }
}

export function assertWorkerStartable(state: UiSnapshot, workerId: string, accountAlias: string): void {
  const account = state.resources.accounts.find(a => a.alias === accountAlias);
  if (!account || ['blocked', 'invalid', 'cooling'].includes(account.health) || state.resources.workers.some(w => (w.workerId === workerId || w.accountAlias === accountAlias) && w.state !== 'stopped')) {
    throw new HostError('WORKER_BUSY', 'Choose an available account without another live or uncertain worker.');
  }
}

export function assertWorkerStoppable(state: UiSnapshot, workerId: string): string {
  const worker = state.resources.workers.find(w => w.workerId === workerId);
  if (!worker || !worker.processOwned || worker.leaseTaskIds.length || worker.runningTaskCount !== 0) {
    throw new HostError('WORKER_BUSY', 'Only an owned worker with confirmed zero native tasks and no daemon lease can be stopped.');
  }
  return worker.workerId;
}

export function assertRealHostAction(options: ServiceOptions, state: UiSnapshot, kind: 'codex' | 'daemon'): void {
  if (!options.native.trusted()) throw new HostError('WORKSPACE_UNTRUSTED', kind === 'codex' ? 'Trust this workspace before preparing Codex integration.' : 'Trust this workspace before starting the daemon.');
  if (options.mode !== 'real') throw new HostError('ACTION_UNAVAILABLE', kind === 'codex' ? 'Codex setup requires a real Linux connection.' : 'Daemon startup is available only for a real connection.');
  if (state.connection.supported === false) throw new HostError(kind === 'codex' ? 'ACTION_UNAVAILABLE' : 'UNSUPPORTED_PLATFORM', kind === 'codex' ? 'Codex setup requires a real Linux connection.' : state.connection.environmentReason ?? 'This host does not support real daemon connections.');
  if (options.configurationError) throw options.configurationError;
  if (kind === 'codex' && !options.native.codexSetup) throw new HostError('ACTION_UNAVAILABLE', 'Codex setup is unavailable in this Host.');
  if (kind === 'daemon' && !options.native.startDaemon) throw new HostError('ACTION_UNAVAILABLE', 'Daemon startup is unavailable in this Host.');
}

export function reviewStorageKey(poolKey: string, taskId: string, hash: string): string {
  return `review:${sha256(`${poolKey}|${taskId}|${hash}`)}`;
}
export async function openArtifactDiff(options: ServiceOptions, taskId: string, manifestSha256: string, file: UiArtifactFile, fullArtifact: (side: 'base' | 'final') => Promise<string>): Promise<void> {
  if (!file.nativeDiff.available) throw new HostError('ARTIFACT_UNAVAILABLE', file.nativeDiff.reason ?? 'This file has no complete immutable Diff.');
  await options.native.openDiff(taskId, manifestSha256, file, fullArtifact);
}
export async function openCurrentDiskFile(options: ServiceOptions, file: UiArtifactFile, detail: UiTaskDetail): Promise<void> {
  const path = assertSafeWorktreePath(file);
  if (options.mode === 'mock') throw new HostError('MOCK_READ_ONLY', 'Mock mode does not read the fixture workspace or current disk files.');
  if (!options.native.openCurrentFile) throw new HostError('CAPABILITY_UNAVAILABLE', 'This Host cannot open current disk files.');
  await options.native.openCurrentFile(detail.workspace.worktreePath, path);
}
export async function readArtifactChunk(
  ui: <K extends UiMethodName>(method: K, params: UiRpcParams<K>, signal?: AbortSignal) => Promise<UiRpcResult<K>>,
  state: UiSnapshot, taskId: string, manifestSha256: string, fileId: string, side: 'base' | 'final', offsetBytes = 0, signal?: AbortSignal
): Promise<UiRpcResult<'ui_read_artifact_file'>['data']> {
  const file = requireSelectedArtifactFile(state, taskId, manifestSha256, fileId); const expected = file[side];
  if (expected.state !== 'available' || expected.sizeBytes === null || !expected.sha256) throw new HostError('ARTIFACT_UNAVAILABLE', expected.reason ?? 'This immutable file side is absent or unavailable.');
  const page = (await ui('ui_read_artifact_file', { apiVersion: 1, task_id: taskId, manifest_sha256: manifestSha256, file_id: fileId, side, offset_bytes: offsetBytes, limit_bytes: 65536 }, signal)).data;
  return verifyArtifactChunkPage(page, manifestSha256, fileId, side, offsetBytes, expected);
}
export async function fetchFullArtifact(
  ui: <K extends UiMethodName>(method: K, params: UiRpcParams<K>, signal?: AbortSignal) => Promise<UiRpcResult<K>>,
  state: UiSnapshot, taskId: string, hash: string, file: UiArtifactFile, side: 'base' | 'final', signal?: AbortSignal
): Promise<string> {
  const expected = file[side]; if (expected.state === 'absent') return '';
  if (expected.state !== 'available' || expected.encoding !== 'utf8' || expected.sizeBytes === null || expected.sizeBytes > 2097152 || expected.kind === 'gitlink' || expected.kind === 'unknown') throw new HostError('ARTIFACT_UNAVAILABLE', 'Native Diff requires a complete UTF-8 snapshot of at most 2 MiB per side.');
  const chunks: Buffer[] = []; let offset = 0;
  do { const page = await readArtifactChunk(ui, state, taskId, hash, file.fileId, side, offset, signal); chunks.push(Buffer.from(page.dataBase64, 'base64')); if (page.nextOffsetBytes === null) break; offset = page.nextOffsetBytes; } while (true);
  return decodeUtf8Artifact(chunks, expected.sizeBytes, expected.sha256!);
}

