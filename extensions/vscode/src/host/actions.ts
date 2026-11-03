import { randomUUID } from 'node:crypto';
import type { UiMethodName, UiRpcParams, UiRpcResult, UiApprovalReview, UiTaskDetail, UiArtifactFile } from '../../../../src/shared/ui-contract.js';
import { TypedClient, HostError, safeError } from './client.js';
import { PollCoordinator } from './polling.js';
import { projectChoices,resolvePreferredRepositoryId } from './project-context.js';
import type { RouterTarget } from './router.js';
import type { WebviewRequest, RequestPayload } from './protocol.js';
import type { UiSnapshot, UiActionState } from './types.js';
import { QUOTA_PROBE_CONCURRENCY, type QuotaProbeSummary } from '../quota-probe.js';
import {
  blankDraft, sha256, createInitialSnapshot, resetDisconnectedSnapshot, buildTaskListWireFilter, mergeTaskDetail, buildDispatchPayload, validateDispatchResources,
  decodeChunk, validatePermissionContent, assertReadApprovalReady, decodeAndVerifyApprovalBytes, assertApprovalRespondable, assertTaskCanAcceptApproval, handleApprovalRespondFailure,
  requireSelectedArtifactFile, applyArtifactListPage, assertReviewPreconditions, formatDiagnosticsPayload, reviewStorageKey, openArtifactDiff, openCurrentDiskFile, readArtifactChunk, fetchFullArtifact,
  assertWorkerStartable, assertWorkerStoppable, assertRealHostAction, type NativeAdapter, type ServiceOptions, type Recovery, type ReviewEntry
} from './action-helpers.js';

export type { NativeAdapter, ServiceOptions, Recovery } from './action-helpers.js';
export { blankDraft, sha256, decodeChunk, validatePermissionContent } from './action-helpers.js';

export class ActionService implements RouterTarget {
  readonly state: UiSnapshot;
  private client?: TypedClient;
  private disposed = false; private visible = false; private historicalPagesLoaded = false;
  private selectionSequence = 0; private listSequence = 0;
  private workScopeSequence = 0;
  private workFilter: {repositoryPath?:string;workId?:string} = {};
  private listFilter: RequestPayload<'tasks.list'>['filter'];
  private readonly rootAbort = new AbortController(); private connectionAbort = new AbortController(); private selectionAbort = new AbortController();
  private readonly taskCache = new Map<string, UiTaskDetail>(); private readonly reviews = new Map<string, ReviewEntry>();
  private readonly submissions = new Map<string, { hash: string; generation: number; promise: Promise<unknown> }>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly approvalReceipts = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  private readonly deliveryOpened = new Set<string>(); private readonly viewedFiles = new Set<string>();
  private poll: PollCoordinator;
  constructor(private readonly options: ServiceOptions) {
    this.state = createInitialSnapshot(options);
    this.poll = new PollCoordinator(signal => this.refreshSnapshot(signal), signal => this.wait(signal), () => this.state.overviewIntervalSeconds * 1000, error => { this.state.connection.stale = true; this.state.connection.error = safeError(error); this.emit(); });
  }
  generation(): number { return this.state.connection.generation; }
  snapshot(): UiSnapshot {
    this.state.connection.trusted=this.options.native.trusted();const context=this.options.projectContext?.();
    this.state.projects=projectChoices(context,this.state.resources.workspaces,[...(this.state.workOverview?.works??[]),...(this.state.decisionTodos??[])]);
    const repositories=[...this.state.resources.workspaces,...this.state.projects.map(project=>({workspaceId:project.repositoryId,repositoryPath:project.repositoryPath,worktreePath:project.repositoryPath}))];
    const preferredId=context?resolvePreferredRepositoryId(context,repositories):null;
    const preferredPath=repositories.find(repository=>repository.workspaceId===preferredId)?.repositoryPath;
    this.state.preferredRepositoryId=this.state.projects.find(project=>project.repositoryPath===preferredPath)?.repositoryId??null;return this.state;
  }
  private emit(): void { if (!this.disposed) this.options.onSnapshot(this.snapshot()); }
  setVisible(visible: boolean): void { this.visible = visible; this.poll.setVisible(visible && !!this.client); }
  async refreshDecisions(): Promise<void> {
    if(!this.client||this.state.connection.state!=='connected'||!this.state.connection.capabilities.workOverview?.version)return;
    const generation=this.generation();
    return this.serialize(`${generation}:decisions.read`,async()=>{
      try{const overview=(await this.ui('ui_get_work_overview',{apiVersion:1,limit:20})).data;this.updateDecisions(overview);this.emit();}
      catch(error){if(generation===this.generation()){this.state.connection.stale=true;this.state.connection.error=safeError(error);this.emit();}}
    });
  }
  private updateDecisions(overview:NonNullable<UiSnapshot['workOverview']>):void {
    this.state.decisionTodos=overview.works.flatMap(work=>work.todos.map(todo=>({workId:work.workId,repositoryPath:work.repositoryPath,goal:work.goal,todo})));
  }
  private async loadWorkOverview(signal=this.connectionAbort.signal):Promise<NonNullable<UiSnapshot['workOverview']>> {
    const scope=this.workFilter,sequence=this.workScopeSequence;
    const overview=(await this.ui('ui_get_work_overview',{apiVersion:1,limit:20,repository_path:scope.repositoryPath,work_id:scope.workId},signal)).data;
    if(sequence!==this.workScopeSequence)throw new HostError('STALE_SELECTION','A newer work scope is active.');
    this.state.workOverview=overview;
    this.state.workOverviewScope={repositoryPath:scope.repositoryPath??(scope.workId?overview.works[0]?.repositoryPath:null)??null,workId:scope.workId??null};
    this.state.poolPolicy=overview.poolPolicy;
    if(!scope.repositoryPath&&!scope.workId)this.updateDecisions(overview);
    return overview;
  }
  async readWorkOverview(payload:RequestPayload<'work.read'>):Promise<NonNullable<UiSnapshot['workOverview']>> {
    this.requireCapability('workOverview');
    const repository=payload.repositoryId?this.snapshot().projects.find(project=>project.repositoryId===payload.repositoryId):undefined;
    if(payload.repositoryId&&!repository)throw new HostError('NOT_FOUND','Choose a project supplied by this Host or the current work overview.');
    this.workFilter={repositoryPath:repository?.repositoryPath,workId:payload.workId};this.workScopeSequence++;
    const overview=await this.loadWorkOverview();this.emit();return overview;
  }
  async focusWork(workId:string):Promise<void> {
    const overview=await this.readWorkOverview({workId});
    if(!overview.works.some(work=>work.workId===workId))throw new HostError('NOT_FOUND','The requested work is no longer available.');
    this.state.focusRequest={id:randomUUID(),target:'pending',workId};this.emit();
  }
  setOverviewInterval(seconds: number): void { if (this.state.overviewIntervalSeconds === seconds) return; this.state.overviewIntervalSeconds = seconds; this.poll.intervalChanged(); this.emit(); }
  trustChanged(): void { this.emit(); }
  private requireConnection(): TypedClient { if (!this.client) throw new HostError('NOT_CONNECTED', 'Connect explicitly to the selected host and pool.'); return this.client; }
  private requireCapability(name: string, mutate = false): void {
    this.requireConnection();
    if (mutate && !this.options.native.trusted()) throw new HostError('WORKSPACE_UNTRUSTED', 'Trust this workspace before execution or account changes.');
    if (mutate && this.state.connection.stale) throw new HostError('STALE_DATA', 'Refresh this connection before changing resources or execution.');
    if (this.state.connection.state === 'legacy-readonly' || !this.state.connection.capabilities[name]?.version) throw new HostError('CAPABILITY_UNAVAILABLE', 'This daemon does not provide the capability required for this action.');
  }
  private assertCurrent(generation: number): void { if (this.disposed || generation !== this.generation()) throw new HostError('STALE_CONNECTION', 'The connection changed while this request was loading.'); }
  private async ui<K extends UiMethodName>(method: K, params: UiRpcParams<K>, signal = this.connectionAbort.signal): Promise<UiRpcResult<K>> {
    const generation = this.generation(); const result = await this.requireConnection().call(method, params, signal); this.assertCurrent(generation);
    if (method !== 'ui_capabilities' && 'meta' in result && (result.meta.storeId !== this.state.connection.storeId || result.meta.instanceId !== this.state.connection.instanceId)) { this.disconnect(); throw new HostError('CONNECTION_CHANGED', 'The daemon or store identity changed. Connect again to negotiate current capabilities.'); }
    this.state.connection.lastReceivedAtMs = Date.now(); this.state.connection.stale = false; this.state.connection.error = null; return result;
  }
  async connect(): Promise<UiSnapshot> {
    if (this.options.configurationError) throw this.options.configurationError;
    if (this.state.connection.supported === false) throw new HostError('UNSUPPORTED_PLATFORM', this.state.connection.environmentReason ?? 'This host does not support real daemon connections.');
    if (this.state.connection.state === 'connecting') return this.state;
    this.disconnect(false); const generation = this.generation(); this.state.connection.state = 'connecting'; this.emit();
    try {
      const transport = await this.options.createTransport(); this.assertCurrent(generation); this.client = new TypedClient(transport);
      try {
        const capabilities = await this.ui('ui_capabilities', { bootstrapVersion: 1, client: { name: 'vscode', version: '0.1.0' }, supportedApiMajors: [1] });
        this.state.connection = { ...this.state.connection, state: 'connected', storeId: capabilities.storeId, instanceId: capabilities.instanceId, daemonVersion: capabilities.daemonVersion, capabilities: capabilities.capabilities, lastReceivedAtMs: Date.now() };
      } catch (error) { if (error instanceof HostError && error.code === 'METHOD_NOT_FOUND') this.state.connection.state = 'legacy-readonly'; else throw error; }
      await this.refresh(); await this.recoverDispatches(); this.poll.setVisible(this.visible); this.emit(); return this.state;
    } catch (error) { if (generation === this.generation()) { this.client?.dispose(); this.client = undefined; this.state.connection.state = 'error'; this.state.connection.error = safeError(error); this.emit(); } throw error; }
  }
  disconnect(emit = true): void {
    this.poll.setVisible(false); this.poll.reset(); this.connectionAbort.abort(); this.selectionAbort.abort(); this.connectionAbort = new AbortController(); this.selectionAbort = new AbortController(); this.client?.dispose(); this.client = undefined;
    resetDisconnectedSnapshot(this.state, this.options.configurationError, this.generation() + 1);
    this.reviews.clear(); this.taskCache.clear(); this.deliveryOpened.clear(); this.viewedFiles.clear(); this.listSequence++; this.selectionSequence++; this.workScopeSequence++;this.workFilter={};this.historicalPagesLoaded = false; this.listFilter = undefined;
    if (emit) this.emit();
  }
  refresh(signal = this.connectionAbort.signal): Promise<void> { return this.poll.requestRefresh(false, signal); }
  private async refreshSnapshot(signal: AbortSignal): Promise<void> {
    const generation = this.generation(); const overview = await this.requireConnection().legacy('overview', {}, signal); this.assertCurrent(generation);
    const detailRequests = new Map<string, Promise<UiTaskDetail>>();
    const detailFor = (taskId: string): Promise<UiTaskDetail> => {
      let pending = detailRequests.get(taskId);
      if (!pending) { pending = this.ui('ui_get_task_detail', { apiVersion: 1, task_id: taskId }, signal).then(value => value.data); detailRequests.set(taskId, pending); }
      return pending;
    };
    this.state.resources.accounts = overview.accounts; this.state.poolPolicy = this.state.connection.capabilities.poolPolicy?.version === 1 ? overview.poolPolicy ?? null : null;
    this.state.resources.workspaces = overview.workspaces; this.state.resources.workers = overview.workers.map(worker => ({ ...worker, leaseTaskIds: overview.tasks.filter(task => task.workerId === worker.workerId && task.leaseHeld).map(task => task.taskId) }));
    if (this.state.connection.capabilities.taskList?.version) {
      if (!this.historicalPagesLoaded) await this.listTasks({ filter: this.listFilter }, signal);
      else this.state.notice = 'Loaded history is retained. Refresh the task list explicitly to discover a new list revision.';
    } else {
      this.state.tasks = overview.tasks.slice(-50).reverse(); this.state.scope = 'recent_50_loaded'; this.state.total = null; this.state.listNextCursor = null;
      if (this.state.connection.capabilities.taskDetail?.version) { const details = await Promise.all(overview.tasks.map(task => detailFor(task.taskId))); this.assertCurrent(generation); for (const detail of details) this.mergeDetail(detail, false); }
    }
    if (this.state.connection.capabilities.taskDetail?.version) {
      const held = [...new Set(overview.workspaces.map(w => w.activeTaskId).filter((id): id is string => !!id))];
      const details = await Promise.all(held.map(detailFor)); for (const detail of details) this.mergeDetail(detail, false);
      for (const worker of this.state.resources.workers) worker.leaseTaskIds = [...new Set([...worker.leaseTaskIds, ...details.filter(t => t.workerId === worker.workerId && t.leaseHeld).map(t => t.taskId)])];
    }
    if (this.state.selectedTaskId && this.state.connection.capabilities.taskDetail?.version) this.mergeDetail(await detailFor(this.state.selectedTaskId));
    if (this.state.connection.capabilities.workOverview?.version) {
      try{await this.loadWorkOverview(signal);}catch(error){if(!(error instanceof HostError&&error.code==='STALE_SELECTION'))throw error;}
      if(this.workFilter.repositoryPath||this.workFilter.workId)await this.refreshDecisions();
    }
    if (this.state.connection.capabilities.quotaSnapshots?.version) {
      await Promise.all(this.state.resources.accounts.map(async account => { const quota = (await this.ui('ui_get_quota', { apiVersion: 1, account_id: account.alias }, signal)).data; this.state.resources.quotas[account.alias] = quota; }));
    }
    this.state.connection.lastReceivedAtMs = Date.now(); this.state.connection.stale = false; this.state.connection.error = null; this.emit();
  }
  async listTasks(payload: RequestPayload<'tasks.list'>, signal = this.connectionAbort.signal): Promise<unknown> {
    if (!this.state.connection.capabilities.taskList?.version) { if (payload.cursor) throw new HostError('CAPABILITY_UNAVAILABLE', 'Only the recent 50-task window is available.'); return { items: this.state.tasks, scope: this.state.scope, total: null, nextCursor: null }; }
    const sequence = ++this.listSequence; const filter = payload.filter ?? this.listFilter; const wireFilter = buildTaskListWireFilter(filter,this.snapshot().projects);
    let page;
    try { page = (await this.ui('ui_list_tasks', { apiVersion: 1, limit: 50, sort: 'created_desc', filter: wireFilter, ...(payload.cursor ? { cursor: payload.cursor } : {}) }, signal)).data; }
    catch (error) { if (error instanceof HostError && ['CURSOR_STALE', 'CURSOR_INVALID'].includes(error.code)) { this.state.listNextCursor = null; this.state.total = null; this.state.notice = 'The task list changed. These loaded rows are retained; reload the first page for a current list.'; this.emit(); } throw error; }
    if (sequence !== this.listSequence) throw new HostError('STALE_SELECTION', 'A newer task filter is active.');
    this.listFilter = filter; this.historicalPagesLoaded = !!payload.cursor; this.state.tasks = payload.cursor ? [...this.state.tasks, ...page.items] : page.items;
    this.state.scope = page.scope; this.state.total = page.total; this.state.listNextCursor = page.nextCursor; this.emit(); return page;
  }
  private mergeDetail(detail: UiTaskDetail, add = true): void { mergeTaskDetail(this.state, this.taskCache, this.reviews, detail, add); }
  async selectTask(taskId: string, reset = true): Promise<unknown> {
    this.requireConnection(); const sequence = ++this.selectionSequence; this.selectionAbort.abort(); this.selectionAbort = new AbortController(); this.state.selectedTaskId = taskId;
    if (reset) { this.state.detail = null; this.state.approvals = null; this.state.delivery = { manifest: null, files: [], nextCursor: null, reviewed: false }; this.reviews.clear(); this.emit(); }
    if (this.state.connection.state === 'legacy-readonly') {
      const value = await this.requireConnection().legacy('get_result', { task_id: taskId }, this.selectionAbort.signal); if (sequence !== this.selectionSequence) throw new HostError('STALE_SELECTION', 'A newer task is selected.');
      this.state.legacyResult = value; this.state.notice = 'Legacy daemon: read-only recent window. Stop proof, complete approvals and immutable file diffs are unavailable.'; this.emit(); return value;
    }
    this.requireCapability('taskDetail'); const detail = (await this.ui('ui_get_task_detail', { apiVersion: 1, task_id: taskId }, this.selectionAbort.signal)).data;
    if (sequence !== this.selectionSequence) throw new HostError('STALE_SELECTION', 'A newer task is selected.'); this.mergeDetail(detail); this.emit(); return detail;
  }
  private async freshTask(taskId: string): Promise<UiTaskDetail> { this.requireCapability('taskDetail'); const detail = (await this.ui('ui_get_task_detail', { apiVersion: 1, task_id: taskId })).data; this.mergeDetail(detail); return detail; }
  private async wait(signal: AbortSignal): Promise<boolean | 'idle'> {
    if (!this.client) return 'idle';
    const tasks = this.state.tasks.filter(task => task.leaseHeld || !['succeeded', 'failed', 'cancelled'].includes(task.status)).slice(0, 50); if (!tasks.length) return 'idle';
    const generation = this.generation(); const started = Date.now();
    const result = await this.client.legacy('wait', { task_ids: tasks.map(task => task.taskId), after_revision: Object.fromEntries(tasks.map(task => [task.taskId, task.revision])), timeout_sec: 25 }, signal); this.assertCurrent(generation);
    for (const task of result.tasks) {
      const current = this.state.tasks.find(t => t.taskId === task.taskId); if (current && task.revision >= current.revision) Object.assign(current, task);
      if (this.state.connection.capabilities.taskDetail?.version && result.changedTaskIds.includes(task.taskId)) this.mergeDetail((await this.ui('ui_get_task_detail', { apiVersion: 1, task_id: task.taskId }, signal)).data, false);
    }
    this.state.connection.stale = false; this.state.connection.lastReceivedAtMs = Date.now(); this.emit(); return Date.now() - started > 1000;
  }
  private poolKey(): string { return `${this.options.authority}|${this.options.poolHome}|${this.state.connection.storeId}`; }
  private async recoverDispatches(): Promise<void> {
    if (!this.state.connection.capabilities.taskLookupByRequest?.version) return;
    for (const record of this.options.native.getState<Recovery[]>('dispatchRecovery', []).filter(r => r.poolKey === this.poolKey())) {
      try { const task = (await this.ui('ui_get_task_detail', { apiVersion: 1, request_id: record.requestId })).data; this.mergeDetail(task); this.action({ key: `dispatch:${record.requestId}`, phase: 'succeeded', message: 'The original dispatch was found by its request ID.', requestId: record.requestId, taskId: task.taskId }); }
      catch (error) { this.action({ key: `dispatch:${record.requestId}`, phase: 'unknown', message: 'The original dispatch is unresolved. No new request was sent.', requestId: record.requestId, error: safeError(error) }); }
    }
  }
  private action(value: UiActionState): void { const i = this.state.actions.findIndex(action => action.key === value.key); if (i < 0) this.state.actions.push(value); else this.state.actions[i] = value; this.emit(); }
  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.operations.get(key); if (existing) return existing as Promise<T>;
    const promise = operation().finally(() => { if (this.operations.get(key) === promise) this.operations.delete(key); }); this.operations.set(key, promise); return promise;
  }
  private async mutate<T>(key: string, operation: () => Promise<T>, taskId?: string): Promise<T> {
    const generation = this.generation();
    return this.serialize(`${generation}:${key}`, async () => {
      this.assertCurrent(generation); this.action({ key, phase: 'pending', message: 'Submitting the explicit operation; waiting for daemon state.', taskId });
      try { const result = await operation(); this.assertCurrent(generation); this.action({ key, phase: 'succeeded', message: key.startsWith('cancel:') ? 'Cancellation was requested. Occupancy remains until termination is confirmed.' : 'The daemon acknowledged this operation. Current task state remains authoritative.', taskId }); await this.poll.requestRefresh(true, this.connectionAbort.signal); this.assertCurrent(generation); return result; }
      catch (error) { const safe = safeError(error); if (generation === this.generation()) this.action({ key, phase: safe.unknownOutcome ? 'unknown' : 'failed', message: safe.message, taskId, error: safe }); throw error; }
    });
  }
  private dispatch(submitToken: string): Promise<unknown> {
    this.requireCapability('dispatchTask', true); const { draft, payload, fingerprint } = buildDispatchPayload(this.state, submitToken);
    const generation = this.generation(); const client = this.requireConnection(); const signal = this.connectionAbort.signal; const existing = this.submissions.get(submitToken);
    if (existing) { if (existing.hash !== fingerprint) throw new HostError('REQUEST_CONFLICT', 'This submit token is already bound to different task content.'); if (existing.generation !== generation) throw new HostError('STALE_CONNECTION', 'This submission belongs to the original connection. Query its request ID; it was not resent.'); return existing.promise; }
    validateDispatchResources(this.state); const requestId = randomUUID();
    const promise = (async () => {
      const record: Recovery = { requestId, payloadHash: fingerprint, workspaceId: draft.workspaceId, workerId: draft.workerId, poolKey: this.poolKey() };
      const recovery = this.options.native.getState<Recovery[]>('dispatchRecovery', []); await this.options.native.setState('dispatchRecovery', [...recovery.filter(r => r.requestId !== requestId), record].slice(-100));
      this.assertCurrent(generation); this.requireCapability('dispatchTask', true); this.action({ key: `dispatch:${requestId}`, phase: 'pending', message: 'Dispatch submitted with a stable request ID.', requestId });
      try {
        const result = await client.legacy('dispatch_task', { ...payload, request_id: requestId }, signal); this.assertCurrent(generation);
        this.action({ key: `dispatch:${requestId}`, phase: 'succeeded', message: 'Task dispatch was acknowledged.', requestId, taskId: result.task.taskId });
        await this.poll.requestRefresh(true, signal); this.assertCurrent(generation); await this.selectTask(result.task.taskId); return { ...result, requestId };
      } catch (error) { const safe = safeError(error); if (generation === this.generation()) this.action({ key: `dispatch:${requestId}`, phase: 'unknown', message: 'Dispatch result is unresolved. Query this request ID before an explicit retry.', requestId, error: safe }); throw error; }
    })();
    this.submissions.set(submitToken, { hash: fingerprint, generation, promise }); return promise;
  }
  private async control(type: 'cancel' | 'reconcile' | 'resume', taskId: string): Promise<unknown> {
    this.requireCapability(`${type}Task`, true); const generation = this.generation(); const client = this.requireConnection(); const signal = this.connectionAbort.signal;
    return this.mutate(`${type}:${taskId}`, async () => {
      const task = await this.freshTask(taskId); const control = task.controls[type]; if (!control.available) throw new HostError('ACTION_UNAVAILABLE', control.reason ?? 'This action is unavailable for the current task.');
      if (type === 'resume' && !task.verificationPolicy.complete) throw new HostError('RECOVERY_REQUIRED', 'The complete verification policy is unavailable. Inspect this task before resuming.');
      const method = { cancel: 'cancel_task', reconcile: 'reconcile_task', resume: 'resume_task' }[type] as 'cancel_task' | 'reconcile_task' | 'resume_task';
      this.assertCurrent(generation); this.requireCapability(`${type}Task`, true); return client.legacy(method, { task_id: taskId }, signal);
    }, taskId);
  }
  private reviewKey(taskId: string, approvalId: string): string { return `${this.poolKey()}|${taskId}|${approvalId}`; }
  private async openApproval(taskId: string, approvalId: string): Promise<UiApprovalReview> {
    this.requireCapability('approvalRead'); await this.freshTask(taskId); const review = (await this.ui('ui_get_approval', { apiVersion: 1, task_id: taskId, approval_id: approvalId })).data;
    if (review.taskId !== taskId || review.approvalId !== approvalId) throw new HostError('INVALID_RESPONSE', 'Approval ownership did not match the selected task.');
    this.reviews.set(this.reviewKey(taskId, approvalId), { review, loadedComplete: false }); return review;
  }
  private async readApproval(taskId: string, approvalId: string, reviewId: string): Promise<unknown> {
    this.requireCapability('approvalRead'); const entry = this.reviews.get(this.reviewKey(taskId, approvalId)); const review = assertReadApprovalReady(entry, reviewId);
    const chunks: Buffer[] = []; let offset = 0;
    do {
      const page = (await this.ui('ui_read_approval', { apiVersion: 1, task_id: taskId, approval_id: approvalId, review_id: reviewId, offset_bytes: offset, limit_bytes: 65536 }, this.selectionAbort.signal)).data;
      const chunk = decodeChunk(page, offset, review.content!.totalBytes); if (page.reviewId !== reviewId || page.contentSha256 !== review.content!.sha256) throw new HostError('INTEGRITY_MISMATCH', 'The approval page identity changed.');
      chunks.push(chunk); if (page.nextOffsetBytes === null) break; offset = page.nextOffsetBytes;
    } while (true);
    const text = decodeAndVerifyApprovalBytes(chunks, review); if (this.reviews.get(this.reviewKey(taskId, approvalId)) !== entry) throw new HostError('APPROVAL_CHANGED', 'Select and load the current approval again.');
    entry!.loadedComplete = true; entry!.text = text; return { review, loadedComplete: true, text };
  }
  private respondApproval(payload: RequestPayload<'approval.respond'>): Promise<unknown> {
    this.requireCapability('approvalRespondFingerprint', true); const key = this.reviewKey(payload.taskId, payload.approvalId); const entry = this.reviews.get(key);
    const review = assertApprovalRespondable(entry, payload); const generation = this.generation(); const fingerprint = sha256(JSON.stringify(payload));
    const previous = this.approvalReceipts.get(key); if (previous) { if (previous.fingerprint !== fingerprint) throw new HostError('APPROVAL_RESPONSE_PENDING', 'The previous response result must be checked before another decision.'); return previous.promise; }
    const actionId = randomUUID();
    const promise = this.mutate(`approval:${key}`, async () => {
      const task = await this.freshTask(payload.taskId); if (payload.decision === 'accept') assertTaskCanAcceptApproval(task, this.state.resources.accounts);
      const receipts = this.options.native.getState<unknown[]>('approvalReceipts', []); await this.options.native.setState('approvalReceipts', [...receipts, { actionId, taskId: payload.taskId, approvalId: payload.approvalId, contentSha256: payload.contentSha256, poolKey: this.poolKey() }].slice(-100));
      this.assertCurrent(generation); this.requireCapability('approvalRespondFingerprint', true); review.response = { actionId, decision: payload.decision, state: 'intent_recorded' };
      const result = (await this.ui('ui_respond_approval', { apiVersion: 1, task_id: payload.taskId, approval_id: payload.approvalId, review_id: payload.reviewId, expected_approval_revision: payload.approvalRevision, expected_native_revision: payload.nativeRevision, expected_content_sha256: payload.contentSha256, decision: payload.decision, action_id: actionId })).data;
      review.response.state = result.responseState; review.state = 'response_pending'; entry!.loadedComplete = false; delete entry!.text; return result;
    }, payload.taskId).catch(error => handleApprovalRespondFailure(this.reviews, this.approvalReceipts, key, entry!, review, error));
    this.approvalReceipts.set(key, { fingerprint, promise }); return promise;
  }
  private async artifacts(taskId: string, cursor?: string): Promise<unknown> {
    this.requireCapability('artifactSnapshots'); await this.freshTask(taskId);
    const manifest = (await this.ui('ui_get_artifact_manifest', { apiVersion: 1, task_id: taskId }, this.selectionAbort.signal)).data;
    if (manifest.taskId !== taskId) throw new HostError('INVALID_RESPONSE', 'The artifact manifest belongs to a different task.');
    if (this.state.selectedTaskId !== taskId) throw new HostError('STALE_SELECTION', 'Select the task before reading its delivery.');
    if (cursor && this.state.delivery.manifest?.manifestSha256 !== manifest.manifestSha256) throw new HostError('CURSOR_STALE', 'The artifact manifest changed.');
    this.state.delivery.manifest = manifest;
    if (manifest.state !== 'available' || !manifest.manifestSha256) { this.state.delivery.files = []; this.state.delivery.nextCursor = null; this.emit(); return { manifest, items: [], nextCursor: null }; }
    const page = (await this.ui('ui_list_artifact_files', { apiVersion: 1, task_id: taskId, manifest_sha256: manifest.manifestSha256, ...(cursor ? { cursor } : {}), limit: 50 }, this.selectionAbort.signal)).data;
    applyArtifactListPage(this.state, this.options.native, this.deliveryOpened, this.reviewStorageKey(taskId, manifest.manifestSha256), taskId, manifest, page, cursor); this.emit(); return { manifest, ...page };
  }
  private artifactFile(taskId: string, manifestSha256: string, fileId: string): UiArtifactFile { return requireSelectedArtifactFile(this.state, taskId, manifestSha256, fileId); }
  private readArtifact(taskId: string, manifestSha256: string, fileId: string, side: 'base' | 'final', offsetBytes = 0): Promise<UiRpcResult<'ui_read_artifact_file'>['data']> {
    this.requireCapability('artifactSnapshots'); return readArtifactChunk((m, p, s) => this.ui(m, p, s), this.state, taskId, manifestSha256, fileId, side, offsetBytes, this.selectionAbort.signal);
  }
  private fullArtifact(taskId: string, hash: string, file: UiArtifactFile, side: 'base' | 'final'): Promise<string> {
    return fetchFullArtifact((m, p, s) => this.ui(m, p, s), this.state, taskId, hash, file, side, this.selectionAbort.signal);
  }
  private reviewStorageKey(taskId: string, hash: string): string { return reviewStorageKey(this.poolKey(), taskId, hash); }
  private probeAccountQuota(accountAlias: string, generation = this.generation(), workerId?: string): Promise<UiRpcResult<'ui_probe_quota'>['data']> {
    this.assertCurrent(generation);
    return this.serialize(`${generation}:quota:${accountAlias}`, async () => {
      this.assertCurrent(generation);
      try {
        const quota = (await this.ui('ui_probe_quota', { apiVersion: 1, ...(workerId ? { worker_id: workerId } : { account_id: accountAlias }) })).data;
        this.assertCurrent(generation);
        this.state.resources.quotas[quota.accountAlias] = quota; this.emit();
        return quota;
      } catch (error) {
        this.assertCurrent(generation);
        // The daemon records failed probes before rejecting. Read that state so
        // the card retains its last value and can immediately show the failure.
        if (this.state.connection.capabilities.quotaSnapshots?.version) {
          try {
            const quota = (await this.ui('ui_get_quota', { apiVersion: 1, account_id: accountAlias })).data;
            this.assertCurrent(generation);
            this.state.resources.quotas[quota.accountAlias] = quota; this.emit();
          } catch { this.assertCurrent(generation); }
        }
        throw error;
      }
    });
  }
  private probeAccounts(): Promise<QuotaProbeSummary> {
    const generation = this.generation();
    return this.serialize(`${generation}:quota:batch`, async () => {
      const targets = this.state.resources.accounts.map(account => account.alias);
      const summary: QuotaProbeSummary = { total: targets.length, succeeded: 0, failed: 0 };
      for (let offset = 0; offset < targets.length; offset += QUOTA_PROBE_CONCURRENCY) {
        this.assertCurrent(generation);
        await Promise.all(targets.slice(offset, offset + QUOTA_PROBE_CONCURRENCY).map(async alias => {
          this.assertCurrent(generation);
          try { await this.probeAccountQuota(alias, generation); summary.succeeded++; }
          catch { this.assertCurrent(generation); summary.failed++; }
        }));
      }
      this.assertCurrent(generation);
      return summary;
    });
  }
  async execute(request: WebviewRequest): Promise<unknown> {
    if (this.disposed) throw new HostError('DISPOSED', 'This workbench has closed.');
    if (request.type !== 'ready' && request.generation !== this.generation()) throw new HostError('STALE_CONNECTION', 'Reload the current workbench state.');
    switch (request.type) {
      case 'ready': this.emit(); return this.snapshot();
      case 'connection.codexSetup': assertRealHostAction(this.options, this.state, 'codex'); return this.options.native.codexSetup!();
      case 'pool.shutdown': {
        this.requireCapability('poolLifecycle', true); const generation = this.generation();
        return this.serialize(`${generation}:pool.shutdown`, async () => {
          try { const result = await this.requireConnection().legacy('shutdown_pool', {}, this.connectionAbort.signal); this.assertCurrent(generation); this.disconnect(); return result; }
          catch (error) { const safe = safeError(error); if (generation === this.generation()) this.action({ key: 'pool.shutdown', phase: safe.unknownOutcome ? 'unknown' : 'failed', message: safe.message, error: safe }); throw error; }
        });
      }
      case 'pool.policy.set': {
        this.requireCapability('poolPolicy', true); const p = request.payload;
        return this.mutate('pool.policy.set', () => this.requireConnection().legacy('set_pool_policy', { ...(p.maxConcurrentTasks !== undefined ? {max_concurrent_tasks:p.maxConcurrentTasks}:{}), ...(p.retryIntervalMs !== undefined ? {retry_interval_ms:p.retryIntervalMs}:{}), ...(p.recoveryWaitMs !== undefined ? {recovery_wait_ms:p.recoveryWaitMs}:{}), ...(p.silenceCheckMs !== undefined ? {silence_check_ms:p.silenceCheckMs}:{}), ...(p.lowQuotaThresholdPercent !== undefined ? {low_quota_threshold_percent:p.lowQuotaThresholdPercent}:{}), ...(p.defaultCommanderQuota !== undefined ? {default_commander_quota:p.defaultCommanderQuota}:{}) }, this.connectionAbort.signal));
      }
      case 'commander.quota.set': this.requireCapability('commanderQuota', true); return this.mutate(`commander:${request.payload.commanderId}:quota`, () => this.requireConnection().legacy('set_commander_quota', {commander_id:request.payload.commanderId,default_quota:request.payload.defaultQuota}, this.connectionAbort.signal));
      case 'account.enabled.set': this.requireCapability('accountEnabled', true); return this.mutate(`account:${request.payload.accountAlias}:enabled`, () => this.requireConnection().legacy('set_account_enabled', {account_id:request.payload.accountAlias,enabled:request.payload.enabled}, this.connectionAbort.signal));
      case 'work.todo.resolve': this.requireCapability('workTodos', true); return this.mutate(`todo:${request.payload.todoId}`, () => this.requireConnection().legacy('resolve_work_todo', {work_id:request.payload.workId,todo_id:request.payload.todoId,action:request.payload.action,...(request.payload.availableAccounts?{available_accounts:request.payload.availableAccounts}:{}),user_confirmed:true}, this.connectionAbort.signal));
      case 'work.read':return this.readWorkOverview(request.payload);
      case 'errors.read': {
        this.requireCapability('errorStats'); const p = request.payload;
        const stats = (await this.ui('ui_get_error_stats', {apiVersion:1,account_alias:p.accountAlias,task_id:p.taskId,work_id:p.workId,from_ms:p.fromMs,to_ms:p.toMs})).data;
        this.state.errorStats = stats; this.state.errorStatsQuery = {...p,observedAtMs:Date.now()}; this.emit(); return stats;
      }
      case 'connection.configure': if (!this.options.native.configureConnection) throw new HostError('ACTION_UNAVAILABLE', 'Connection configuration is unavailable in this Host.'); await this.options.native.configureConnection(); return { configured: true };
      case 'daemon.start': assertRealHostAction(this.options, this.state, 'daemon'); await this.options.native.startDaemon!(); return { started: true };
      case 'connect': return this.connect();
      case 'disconnect': this.disconnect(); return this.state;
      case 'refresh': await this.refresh(); return this.state;
      case 'resources.refresh': {
        const generation = this.generation();
        await this.refresh();
        this.assertCurrent(generation);
        if (this.state.connection.capabilities.quotaProbe?.version && this.options.native.trusted() && !this.state.connection.stale) await this.probeAccounts();
        this.assertCurrent(generation);
        return this.state;
      }
      case 'accounts.probeAll':
        this.requireCapability('quotaProbe', true);
        return this.mutate('probe:accounts:all', () => this.probeAccounts());
      case 'tasks.list': return this.listTasks(request.payload);
      case 'task.select': return this.selectTask(request.payload.taskId);
      case 'draft.change': this.state.draft = request.payload.draft; this.emit(); return { saved: true };
      case 'dispatch': return this.dispatch(request.payload.submitToken);
      case 'dispatch.lookup': { this.requireCapability('taskLookupByRequest'); const detail = (await this.ui('ui_get_task_detail', { apiVersion: 1, request_id: request.payload.requestId })).data; this.mergeDetail(detail); this.emit(); return detail; }
      case 'cancel': case 'reconcile': case 'resume': return this.control(request.type, request.payload.taskId);
      case 'events.read': { const page = await this.requireConnection().legacy('get_logs', { task_id: request.payload.taskId, cursor: request.payload.cursor ?? 0, limit: 20 }, this.selectionAbort.signal); if (page.events.some(e => e.taskId !== request.payload.taskId) || (page.events.length && page.nextCursor <= (request.payload.cursor ?? 0))) throw new HostError('INVALID_RESPONSE', 'Event pagination did not advance for the selected task.'); return page; }
      case 'patch.read': { const offset = request.payload.offset ?? 0; const page = await this.requireConnection().legacy('get_diff', { task_id: request.payload.taskId, offset, limit: 4000 }, this.selectionAbort.signal); if (page.available && page.nextOffset !== null && page.nextOffset !== undefined && page.nextOffset <= offset) throw new HostError('INVALID_RESPONSE', 'Patch pagination did not advance.'); return { ...page, offset, offsetUnit: 'utf16' }; }
      case 'approvals.list': { this.requireCapability('approvalRead'); const page = (await this.ui('ui_list_approvals', { apiVersion: 1, task_id: request.payload.taskId, ...(request.payload.cursor ? { cursor: request.payload.cursor } : {}), limit: 20 }, this.selectionAbort.signal)).data; if (this.state.selectedTaskId === request.payload.taskId) { this.state.approvals = request.payload.cursor && this.state.approvals ? { ...page, items: [...this.state.approvals.items, ...page.items] } : page; this.emit(); } return page; }
      case 'approval.open': return this.openApproval(request.payload.taskId, request.payload.approvalId);
      case 'approval.read': return this.readApproval(request.payload.taskId, request.payload.approvalId, request.payload.reviewId);
      case 'approval.respond': return this.respondApproval(request.payload);
      case 'accounts.import': { this.requireCapability('importAccounts', true); const generation = this.generation(); const client = this.requireConnection(); const signal = this.connectionAbort.signal; const files = await this.options.native.pickAccountFiles(this.options.host); if (!files?.length) return { cancelled: true }; if (files.length > 100) throw new HostError('INVALID_ARGUMENT', 'Select between 1 and 100 OAuth JSON files.'); this.assertCurrent(generation); this.requireCapability('importAccounts', true); return this.mutate('accounts.import', () => client.legacy('import_accounts', { files }, signal)); }
      case 'workspace.create': { this.requireCapability('createWorkspace', true); const generation = this.generation(); const client = this.requireConnection(); const signal = this.connectionAbort.signal; const repository = await this.options.native.pickRepository(this.options.host); if (!repository) return { cancelled: true }; this.assertCurrent(generation); this.requireCapability('createWorkspace', true); return this.mutate('workspace.create', () => client.legacy('create_workspace', { repository, base_ref: request.payload.baseRef }, signal)); }
      case 'worker.start': this.requireCapability('startWorker', true); assertWorkerStartable(this.state, request.payload.workerId, request.payload.accountAlias); return this.mutate(`worker:${request.payload.workerId}`, () => this.requireConnection().legacy('start_worker', { worker_id: request.payload.workerId, account_id: request.payload.accountAlias }, this.connectionAbort.signal));
      case 'worker.stop': { this.requireCapability('stopWorker', true); const workerId = assertWorkerStoppable(this.state, request.payload.workerId); return this.mutate(`worker:${workerId}`, () => this.requireConnection().legacy('stop_worker', { worker_id: workerId }, this.connectionAbort.signal)); }
      case 'worker.probe': { this.requireCapability('quotaProbe', true); const worker = this.state.resources.workers.find(w => w.workerId === request.payload.workerId); if (!worker || worker.state !== 'ready') throw new HostError('WORKER_UNAVAILABLE', 'Choose a currently ready worker.'); return this.mutate(`probe:${worker.workerId}`, () => this.probeAccountQuota(worker.accountAlias, this.generation(), worker.workerId)); }
      case 'account.probe': { this.requireCapability('quotaProbe', true); if (!this.state.resources.accounts.some(a => a.alias === request.payload.accountAlias)) throw new HostError('NOT_FOUND', 'The account is not in the current pool.'); return this.mutate(`probe:account:${request.payload.accountAlias}`, () => this.probeAccountQuota(request.payload.accountAlias)); }
      case 'quota.read': { this.requireCapability('quotaSnapshots'); if (!this.state.resources.accounts.some(a => a.alias === request.payload.accountAlias)) throw new HostError('NOT_FOUND', 'The account is not in the current pool.'); const quota = (await this.ui('ui_get_quota', { apiVersion: 1, account_id: request.payload.accountAlias })).data; this.state.resources.quotas[quota.accountAlias] = quota; this.emit(); return quota; }
      case 'artifacts.list': return this.artifacts(request.payload.taskId, request.payload.cursor);
      case 'artifact.read': return this.readArtifact(request.payload.taskId, request.payload.manifestSha256, request.payload.fileId, request.payload.side, request.payload.offsetBytes);
      case 'diff.open': { const { taskId, manifestSha256, fileId } = request.payload; const file = this.artifactFile(taskId, manifestSha256, fileId); await openArtifactDiff(this.options, taskId, manifestSha256, file, side => this.fullArtifact(taskId, manifestSha256, file, side)); this.viewedFiles.add(`${taskId}|${manifestSha256}|${fileId}`); return { opened: true }; }
      case 'file.current.open': { const { taskId, manifestSha256, fileId } = request.payload; const file = this.artifactFile(taskId, manifestSha256, fileId); await openCurrentDiskFile(this.options, file, await this.freshTask(taskId)); return { opened: true, version: 'current_disk' }; }
      case 'review.set': { const { taskId, manifestSha256, reviewed } = request.payload; assertReviewPreconditions(this.state, this.deliveryOpened, this.viewedFiles, taskId, manifestSha256, reviewed); await this.options.native.setState(this.reviewStorageKey(taskId, manifestSha256), reviewed); this.state.delivery.reviewed = reviewed; const summary = this.state.tasks.find(task => task.taskId === taskId); if (summary) summary.deliveryReview = reviewed ? 'reviewed' : 'pending'; this.emit(); return { reviewed }; }
      case 'settings.open': await this.options.native.openSettings(); return { opened: true };
      case 'settings.save': await this.options.native.saveInterval(request.payload.overviewIntervalSeconds); this.setOverviewInterval(request.payload.overviewIntervalSeconds); return { saved: true };
      case 'diagnostics.copy': await this.options.native.copyDiagnostics(formatDiagnosticsPayload(this.state)); return { copied: true };
      case 'guidance.open': await this.options.native.guidance(request.payload.topic); return { opened: true };
    }
  }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.poll.dispose(); this.rootAbort.abort(); this.connectionAbort.abort(); this.selectionAbort.abort(); this.client?.dispose(); this.client = undefined; this.reviews.clear(); this.taskCache.clear(); this.state.draft = blankDraft(); }
  closePanel(): void { this.selectionAbort.abort(); this.selectionAbort = new AbortController(); this.selectionSequence++; this.reviews.clear(); }
}
