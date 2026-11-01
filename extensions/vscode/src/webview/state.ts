import type { UiSnapshot, UiTask, TaskDraft } from '../host/types.js';
import type { UiApprovalReview, UiTaskDetail, UiArtifactFile, UiRpcResult } from '../../../../src/shared/ui-contract.js';

export type Page = 'tasks' | 'resources' | 'compose' | 'settings';
export type DetailTab = 'overview' | 'approvals' | 'delivery' | 'events';
export interface Filters { project: string; status: string; worker: string; workspace: string; query: string }
export interface ReviewContent { review: UiApprovalReview; text: string | null; loadedComplete: boolean; loading: boolean; error: string | null; locked: boolean }
export interface EventRow { revision?: number; type?: string; status?: string; createdAtMs?: number; createdAt?: number; detail?: unknown }
export interface EventPage { events?: EventRow[]; items?: EventRow[]; nextCursor: number | null }
export interface PatchPage { available: boolean; patch?: string; content?: string; text?: string; nextOffset: number | null; offset?: number }
export interface ArtifactText { file: UiArtifactFile; side: 'base' | 'final'; text: string; loadedBytes: number; totalBytes: number; nextOffsetBytes: number | null; decoder: TextDecoder; complete: boolean; error: string | null }
export interface LocalState {
  snapshot: UiSnapshot | null; page: Page; tab: DetailTab; filters: Filters; detailOpen: boolean;
  expandedAccounts: Set<string>; reviews: Map<string, ReviewContent>; events: EventRow[]; eventsCursor: number | null; eventsLoaded: boolean;
  patch: string; patchLoaded: boolean; patchNextOffset: number | null; artifact: ArtifactText | null;
  pending: Set<string>; errors: Map<string, string>; message: string; draft: TaskDraft | null; draftDirty: boolean;
  workerId: string; workerAccount: string; baseRef: string; settingsInterval: string;
  validation: Record<string, string>; taskLookup: string; loadedIdentity: string | null; restore: PersistedUi | null;
  deliveryVisited: boolean; inspectedFiles: Set<string>;
  rawFields: Map<string, string>;
  submittedDraftToken: string | null; importSummary: string | null;
  projectDefaultApplied: boolean;
}
export interface PersistedUi { version: 1; identity: string; page: 'tasks' | 'resources' | 'settings'; tab: DetailTab; filters: Filters; selectedTaskId: string | null }
const tabs: DetailTab[] = ['overview', 'approvals', 'delivery', 'events'];
export const defaultFilters = (): Filters => ({ project: '', status: 'all', worker: '', workspace: '', query: '' });
export function readPersisted(value: unknown): PersistedUi | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Partial<PersistedUi>;
  if (p.version !== 1 || typeof p.identity !== 'string' || !['tasks', 'resources', 'settings'].includes(p.page ?? '') || !tabs.includes(p.tab as DetailTab) || !p.filters) return null;
  const filters = p.filters;
  if (!['project', 'status', 'worker', 'workspace', 'query'].every(key => typeof filters[key as keyof Filters] === 'string')) return null;
  if (p.selectedTaskId !== null && typeof p.selectedTaskId !== 'string') return null;
  return { version: 1, identity: p.identity, page: p.page as PersistedUi['page'], tab: p.tab!, filters: { project: filters.project, status: filters.status, worker: filters.worker, workspace: filters.workspace, query: filters.query }, selectedTaskId: p.selectedTaskId ?? null };
}
export function createState(persisted: unknown = null): LocalState {
  return { snapshot: null, page: 'tasks', tab: 'overview', filters: defaultFilters(), detailOpen: false, expandedAccounts: new Set(), reviews: new Map(), events: [], eventsCursor: null, eventsLoaded: false, patch: '', patchLoaded: false, patchNextOffset: null, artifact: null, pending: new Set(), errors: new Map(), message: '', draft: null, draftDirty: false, workerId: '', workerAccount: '', baseRef: 'HEAD', settingsInterval: '30', validation: {}, taskLookup: '', loadedIdentity: null, restore: readPersisted(persisted), deliveryVisited: false, inspectedFiles: new Set(), rawFields: new Map(), submittedDraftToken: null, importSummary: null, projectDefaultApplied: false };
}
export function connectionIdentity(snapshot: UiSnapshot): string { return `${snapshot.connection.host}\u0000${snapshot.connection.poolHome}\u0000${snapshot.connection.storeId ?? ''}`; }
export function clearTaskContent(state: LocalState): void {
  state.reviews.clear(); state.events = []; state.eventsLoaded = false; state.eventsCursor = null;
  state.patch = ''; state.patchLoaded = false; state.patchNextOffset = null; state.artifact = null;
  state.deliveryVisited = false; state.inspectedFiles.clear();
  for (const key of state.errors.keys()) if (key.startsWith('task:') || key.startsWith('approval:') || key.startsWith('artifact:')) state.errors.delete(key);
}
export function applySnapshot(state: LocalState, snapshot: UiSnapshot): boolean {
  const previous = state.snapshot;
  if (previous && snapshot.connection.generation < previous.connection.generation) return false;
  let defaultProjectChanged = false;
  const identity = connectionIdentity(snapshot);
  const resolvedIdentity = snapshot.connection.storeId !== null || snapshot.connection.state === 'legacy-readonly';
  const changedTarget = previous && (previous.connection.host !== snapshot.connection.host || previous.connection.poolHome !== snapshot.connection.poolHome);
  const changedIdentity = !!changedTarget || (resolvedIdentity && state.loadedIdentity !== null && identity !== state.loadedIdentity);
  const changedInstance = previous?.connection.instanceId && snapshot.connection.instanceId !== previous.connection.instanceId;
  const changedGeneration = previous && snapshot.connection.generation !== previous.connection.generation;
  if (changedIdentity) {
    state.filters = defaultFilters(); state.tab = 'overview'; state.detailOpen = false;
    state.expandedAccounts.clear(); state.draft = null; state.draftDirty = false; state.page = 'tasks';
    state.pending.clear(); state.errors.clear(); state.message = ''; state.restore = null; state.rawFields.clear(); state.submittedDraftToken = null; state.importSummary = null; state.projectDefaultApplied = false;
  }
  if (changedIdentity || changedGeneration || changedInstance || previous?.selectedTaskId !== snapshot.selectedTaskId) clearTaskContent(state);
  if (previous?.delivery.manifest?.manifestSha256 && previous.delivery.manifest.manifestSha256 !== snapshot.delivery.manifest?.manifestSha256) { state.inspectedFiles.clear(); state.artifact = null; }
  if (resolvedIdentity && state.restore?.identity === identity && !previous?.connection.storeId) {
    state.filters = { ...state.restore.filters }; state.tab = state.restore.tab; state.page = state.restore.page;
    state.projectDefaultApplied = true;
  }
  if (resolvedIdentity && !state.projectDefaultApplied && (snapshot.preferredRepositoryId !== undefined || snapshot.resources.workspaces.length > 0)) {
    state.projectDefaultApplied = true;
    // Preference is only an opaque ID for a registered repository. Paths never come from
    // page input, and later active-editor changes cannot overwrite the user's filter.
    const preferred = snapshot.resources.workspaces.find(workspace => workspace.workspaceId === snapshot.preferredRepositoryId);
    if (preferred) { state.filters.project = preferred.repositoryPath; defaultProjectChanged = true; }
  }
  if (resolvedIdentity) state.loadedIdentity = identity;
  if (snapshot.connection.state !== 'connected') for (const review of state.reviews.values()) { review.text = null; review.loadedComplete = false; }
  if (!state.draftDirty) state.draft = { ...snapshot.draft, verifyCommands: snapshot.draft.verifyCommands.map(command => ({ ...command, args: [...command.args] })) };
  // Hash/revision changes invalidate only the matching review; a task status update never approves it.
  if (snapshot.detail?.taskId === snapshot.selectedTaskId && previous?.detail?.execution?.currentCommandId && snapshot.detail?.execution?.currentCommandId !== previous.detail.execution.currentCommandId) state.reviews.clear();
  if (snapshot.approvals?.stateKnown) {
    const setChanged = previous?.approvals && previous.approvals.approvalSetRevision !== snapshot.approvals.approvalSetRevision;
    const fullList = snapshot.approvals.nextCursor === null && snapshot.approvals.total !== null && snapshot.approvals.items.length >= snapshot.approvals.total;
    for (const [approvalId, entry] of state.reviews) {
      const item = snapshot.approvals.items.find(item => item.approvalId === approvalId);
      if (!item && fullList) {
        entry.text = null; entry.loadedComplete = false; entry.locked = true; entry.review.state = 'gone';
        if (entry.review.response.state !== 'none' && entry.review.response.state !== 'confirmed') {
          entry.review.response.state = 'resolved_unattributed'; entry.error = '此审批已不再待处理，无法确认采用了哪次答复。';
        } else if (entry.review.response.state === 'none') entry.review.readOnlyReason = 'APPROVAL_GONE';
      } else if (item) {
        if (item.responseState !== 'none') { entry.review.response.state = item.responseState; entry.review.state = 'response_pending'; entry.locked = true; }
        if (!item.sourceComplete || item.readOnlyReason || (setChanged && !entry.locked)) {
          entry.text = null; entry.loadedComplete = false; entry.review.readOnlyReason = item.readOnlyReason ?? (!item.sourceComplete ? '完整来源不可用。' : 'APPROVAL_CHANGED');
        }
      }
    }
  }
  state.snapshot = snapshot;
  if (!state.pending.has('settings.save')) state.settingsInterval = String(snapshot.overviewIntervalSeconds);
  return defaultProjectChanged;
}
export function persistedUi(state: LocalState): PersistedUi | null {
  if (!state.snapshot || (!state.snapshot.connection.storeId && state.snapshot.connection.state !== 'legacy-readonly')) return null;
  return { version: 1, identity: connectionIdentity(state.snapshot), page: state.page === 'compose' ? 'tasks' : state.page, tab: state.tab, filters: { ...state.filters }, selectedTaskId: state.snapshot.selectedTaskId };
}
export function safeDetail(snapshot: UiSnapshot | null): UiTaskDetail | null {
  const detail = snapshot?.detail;
  return detail?.workspace && detail?.execution && detail?.selection && detail?.result ? detail as UiTaskDetail : null;
}
export function selectedTask(state: LocalState): UiTask | null {
  const snapshot = state.snapshot; if (!snapshot?.selectedTaskId) return null;
  return snapshot.tasks.find(task => task.taskId === snapshot.selectedTaskId) ?? (snapshot.detail?.taskId === snapshot.selectedTaskId ? snapshot.detail : snapshot.legacyResult?.task.taskId === snapshot.selectedTaskId ? snapshot.legacyResult.task : null);
}
export const isActive = (task: UiTask): boolean => ['queued', 'dispatching', 'running', 'waiting_approval', 'verifying'].includes(task.status);
export function needsAttention(task: UiTask, snapshot: UiSnapshot): boolean {
  return ['waiting_approval', 'blocked', 'failed', 'interrupted'].includes(task.status) || (task.leaseHeld && task.executionStopped !== true && !isActive(task)) || (task.status === 'succeeded' && (task.deliveryReview === 'pending' || (snapshot.selectedTaskId === task.taskId && snapshot.detail?.result.available === true && !snapshot.delivery.reviewed && task.deliveryReview !== 'reviewed')));
}
export function filterTasks(snapshot: UiSnapshot, filters: Filters): UiTask[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return snapshot.tasks.filter(task => {
    const workspace = snapshot.resources.workspaces.find(item => item.workspaceId === task.workspaceId);
    if (filters.project && workspace?.repositoryPath !== filters.project) return false;
    if (filters.worker && task.workerId !== filters.worker) return false;
    if (filters.workspace && task.workspaceId !== filters.workspace) return false;
    if (filters.status === 'attention' && !needsAttention(task, snapshot)) return false;
    if (filters.status === 'active' && !isActive(task)) return false;
    if (filters.status === 'finished' && isActive(task)) return false;
    if (!['all', 'attention', 'active', 'finished'].includes(filters.status) && task.status !== filters.status) return false;
    return !query || [task.taskId, task.workspaceId, task.workerId, workspace?.repositoryPath, workspace?.branch].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
  });
}
export function mutationReason(snapshot: UiSnapshot, capability: string): string | null {
  if (snapshot.connection.stale) return '当前为缓存快照，请重新连接后操作。';
  if (snapshot.connection.state !== 'connected') return snapshot.connection.state === 'legacy-readonly' ? '旧 daemon 仅支持只读查看。' : '请先连接 daemon。';
  if (!snapshot.connection.trusted) return '受限模式仅可查看。请在 VS Code 信任此工作区后操作。';
  const cap = snapshot.connection.capabilities[capability];
  if (!cap || cap.version < 1) return `当前 daemon 未提供 ${capability} 能力${cap?.reason ? `（${cap.reason}）` : ''}。`;
  return null;
}
export function workerUnavailable(snapshot: UiSnapshot, workerId: string): string | null {
  const worker = snapshot.resources.workers.find(item => item.workerId === workerId);
  if (!worker) return '请选择 Worker。';
  if (worker.state !== 'ready') return 'Worker 尚未 ready。';
  if (worker.leaseTaskIds.length) return `Worker 仍由 ${worker.leaseTaskIds.join('、')} 持有占用。`;
  if (worker.runningTaskCount === undefined) return 'Worker 尚无可靠的原生活动计数，请刷新资源。';
  if (worker.runningTaskCount !== 0) return 'Worker 当前仍有原生活动执行。';
  const health = snapshot.resources.accounts.find(account => account.alias === worker.accountAlias)?.health;
  if (['blocked', 'invalid', 'cooling'].includes(health ?? '')) return `绑定账号状态为 ${health}，不可派发。`;
  return null;
}
export function validateDraft(snapshot: UiSnapshot, draft: TaskDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  const workspace = snapshot.resources.workspaces.find(item => item.workspaceId === draft.workspaceId);
  if (!workspace || workspace.state !== 'active') errors.workspaceId = '请选择已登记的 active 任务 workspace。';
  else if (workspace.activeTaskId) errors.workspaceId = `workspace 由 ${workspace.activeTaskId} 占用，请先检查该任务。`;
  const workerReason = workerUnavailable(snapshot, draft.workerId); if (workerReason) errors.workerId = workerReason;
  if (!draft.prompt.trim()) errors.prompt = '请输入任务提示词。';
  else if (draft.prompt.length > 100_000) errors.prompt = '提示词超过 100000 个 UTF-16 单元。';
  if (!draft.modelId.trim()) errors.modelId = '请输入明确的模型 ID。';
  if (!Number.isInteger(draft.busyRetryLimit) || draft.busyRetryLimit < 0 || draft.busyRetryLimit > 10) errors.busyRetryLimit = '续跑上限须为 0–10 的整数。';
  if (draft.verifyCommands.length > 10) errors.verifyCommands = '最多配置 10 项核验命令。';
  for (const [index, command] of draft.verifyCommands.entries()) {
    if (!command.command.trim()) errors[`verify.${index}.command`] = '请输入 executable。';
    if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > 300_000) errors[`verify.${index}.timeoutMs`] = '超时须为 100–300000ms。';
  }
  if (new TextEncoder().encode(JSON.stringify(draft)).length > 500_000) errors.prompt = '请求内容超过安全预算，请缩短提示词或命令参数。';
  return errors;
}
export function approvalDisabled(state: LocalState, review: ReviewContent, decision: 'accept' | 'decline' | 'cancel'): string | null {
  if (!state.snapshot) return '尚无连接。';
  const capability = mutationReason(state.snapshot, 'approvalRespondFingerprint'); if (capability) return capability;
  if (state.snapshot.approvals && !state.snapshot.approvals.stateKnown) return '当前原生审批归属未知，整个审批保持只读。';
  const descriptor = review.review;
  if (review.locked || descriptor.response.state !== 'none' || descriptor.state !== 'pending') return '答复已提交或状态待确认，请读取当前审批状态。';
  if (!descriptor.content?.sourceComplete || descriptor.readOnlyReason || descriptor.redactions.some(item => item.decisionRelevant)) return descriptor.readOnlyReason ?? '缺少完整可信来源，此审批仅可查看。';
  if (descriptor.expiresAtMs <= Date.now()) return '审阅令牌已过期，请重新读取当前审批。';
  if (!descriptor.decisions.some(item => item.decision === decision)) return '原生交互未提供此答复形式。';
  if (decision === 'accept') {
    if (!review.loadedComplete || !review.text) return '完整内容尚未读齐并校验，暂不能批准。';
    const task = selectedTask(state);
    if (task?.cancelRequestedAtMs != null || task?.status === 'blocked') return '任务已有取消意图或已阻塞，不能批准。';
    const binding = safeDetail(state.snapshot)?.selection.binding;
    const account = state.snapshot.resources.accounts.find(item => item.alias === binding?.accountAlias);
    if (['blocked', 'invalid', 'cooling'].includes(account?.health ?? '')) return `账号状态为 ${account!.health}，不能批准。`;
  }
  return null;
}
export type ArtifactChunk = UiRpcResult<'ui_read_artifact_file'>['data'];
