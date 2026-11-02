import { WebviewBridge, BridgeError, type VsCodeApi } from './bridge.js';
import type { RequestType } from '../host/protocol.js';
import type { UiSnapshot } from '../host/types.js';
import type { UiApprovalReview, UiRpcResult } from '../../../../src/shared/ui-contract.js';
import { renderApp } from './components.js';
import { applySnapshot, approvalDisabled, clearTaskContent, connectionIdentity, createState, defaultFilters, persistedUi, validateDraft, type ArtifactChunk, type DetailTab, type EventPage, type LocalState, type PatchPage, type ReviewContent } from './state.js';
import { ToastManager } from './toast-manager.js';
import { captureFrame, restoreFrame, updateInput, canFlushDraft, buildListPayload, applyVerifiedApprovalRead, applyApprovalRespondSuccess, applyApprovalRespondError, appendArtifactChunk } from './form-controller.js';

declare function acquireVsCodeApi(): VsCodeApi;
const tabs: readonly DetailTab[] = ['overview', 'approvals', 'delivery', 'events'];

/** View controller. Host owns connections, identities, authorization, filesystem and writes. */
export class WorkbenchApp {
  readonly state: LocalState;
  private readonly toasts: ToastManager;
  private disposeSubscription: () => void;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private pointerReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionSequence = 0;
  private readonly submittedDraftTokens = new Set<string>();
  private destroyed = false; private pointerGesture = false; private renderQueued = false;
  private focusAfterRender: string | null = null;
  /** Live regions live outside the re-rendered root so screen readers observe real text changes. */
  private readonly livePolite: HTMLElement;
  private readonly liveAssertive: HTMLElement;
  private readonly announcedReceipts = new Map<string, string>();
  private lastAnnouncedMessage = '';

  constructor(private readonly root: HTMLElement, readonly bridge: WebviewBridge) {
    this.state = createState(bridge.getState());
    const doc = root.ownerDocument;
    const makeLive = (politeness: 'polite' | 'assertive'): HTMLElement => {
      const node = doc.createElement('div'); node.className = 'sr-only'; node.dataset.live = politeness;
      node.setAttribute('aria-live', politeness); node.setAttribute('aria-atomic', 'true');
      if (politeness === 'assertive') node.setAttribute('role', 'alert'); else node.setAttribute('role', 'status');
      (root.parentElement ?? doc.body).append(node); return node;
    };
    this.livePolite = makeLive('polite'); this.liveAssertive = makeLive('assertive');
    this.toasts = new ToastManager({ root, state: this.state, onDismiss: key => void this.action('dismiss-action-receipt', { key }) });
    this.disposeSubscription = bridge.subscribe(snapshot => this.receiveSnapshot(snapshot));
    root.addEventListener('input', this.onInput); root.addEventListener('change', this.onChange); root.addEventListener('keydown', this.onKeyDown);
    root.addEventListener('pointerdown', this.onPointerDown, true); window.addEventListener('pointerup', this.onPointerUp, true); window.addEventListener('pointercancel', this.onPointerUp, true);
    this.render();
  }
  async start(): Promise<void> {
    await this.run('ready', async () => { const snapshot = await this.bridge.request<'ready', UiSnapshot>('ready', {}); if (snapshot?.connection) this.receiveSnapshot(snapshot); });
  }
  private receiveSnapshot(snapshot: UiSnapshot): void {
    const oldTask = this.state.snapshot?.selectedTaskId; const oldGeneration = this.state.snapshot?.connection.generation;
    const defaultProjectChanged = applySnapshot(this.state, snapshot);
    if (oldTask !== snapshot.selectedTaskId || oldGeneration !== snapshot.connection.generation) this.selectionSequence++;
    if (this.state.tab === 'delivery' && snapshot.selectedTaskId) this.state.deliveryVisited = true;
    const restore = this.state.restore;
    const restoreSelection = restore && restore.identity === connectionIdentity(snapshot) && (snapshot.connection.storeId !== null || snapshot.connection.state === 'legacy-readonly') ? restore.selectedTaskId : null;
    if (snapshot.connection.storeId !== null || snapshot.connection.state === 'legacy-readonly') this.state.restore = null;
    this.render();
    if (defaultProjectChanged || (restore && restore.identity === connectionIdentity(snapshot) && snapshot.connection.storeId !== null)) void this.serverFilter();
    if (restoreSelection && restoreSelection !== snapshot.selectedTaskId) void this.action('task.select', { taskId: restoreSelection });
  }
  render(): void {
    if (this.destroyed) return;
    if (this.pointerGesture) { this.renderQueued = true; return; }
    this.renderQueued = false; const frame = captureFrame(this.root);
    this.root.replaceChildren(renderApp({ state: this.state, action: (name, data) => void this.action(name, data) }));
    restoreFrame(this.root, frame, this.focusAfterRender); this.focusAfterRender = null;
    const persisted = persistedUi(this.state); if (persisted) this.bridge.setState(persisted);
    this.toasts.attachToastInteractions();
    this.announce();
  }
  /** Announce new messages and receipt phase changes once, via the persistent live regions. */
  private announce(): void {
    let polite = ''; let assertive = '';
    if (this.state.message && this.state.message !== this.lastAnnouncedMessage) {
      if (this.state.messageTone === 'error') assertive = this.state.message; else polite = this.state.message;
    }
    this.lastAnnouncedMessage = this.state.message;
    const seen = new Set<string>();
    for (const receipt of this.state.snapshot?.actions ?? []) {
      seen.add(receipt.key);
      if (this.announcedReceipts.get(receipt.key) === receipt.phase) continue;
      this.announcedReceipts.set(receipt.key, receipt.phase);
      if (receipt.phase === 'failed') assertive = [assertive, `操作未完成：${receipt.message}`].filter(Boolean).join(' ');
      else if (receipt.phase !== 'pending') polite = [polite, `${receipt.phase === 'succeeded' ? '已收到回执' : '结果待确认'}：${receipt.message}`].filter(Boolean).join(' ');
    }
    for (const key of Array.from(this.announcedReceipts.keys())) if (!seen.has(key)) this.announcedReceipts.delete(key);
    if (polite) this.livePolite.textContent = polite;
    if (assertive) this.liveAssertive.textContent = assertive;
  }
  private async run<T>(key: string, operation: () => Promise<T>, errorKey = key): Promise<T | undefined> {
    if (this.state.pending.has(key)) return undefined;
    this.state.pending.add(key); this.state.errors.delete(errorKey); this.render();
    const messageBefore = this.state.message;
    try { const result = await operation(); if (this.state.message !== messageBefore) this.state.messageTone = 'info'; return result; }
    catch (error) {
      if (error instanceof BridgeError && ['STALE_CONNECTION', 'STALE_SELECTION'].includes(error.detail.code)) return undefined;
      const message = error instanceof BridgeError ? `${error.detail.code} · ${error.message}` : '此操作未能完成，请查看目标状态后重试读取。';
      this.state.errors.set(errorKey, message); this.state.message = message; this.state.messageTone = 'error'; return undefined;
    } finally { this.state.pending.delete(key); this.render(); }
  }
  private current(taskId: string, sequence: number, generation: number): boolean { return this.state.snapshot?.selectedTaskId === taskId && this.selectionSequence === sequence && this.state.snapshot?.connection.generation === generation; }
  private async taskRead<T>(taskId: string, type: RequestType, key: string, payload: object, receive: (data: T) => void): Promise<void> {
    const sequence = this.selectionSequence; const generation = this.state.snapshot?.connection.generation ?? 0;
    await this.run(key, async () => { const response = await this.bridge.request(type, payload as never); if (this.current(taskId, sequence, generation)) receive(response as T); });
  }
  private async readApprovalContent(taskId: string, approvalId: string, entry: ReviewContent, sequence: number, generation: number): Promise<void> {
    const descriptor = entry.review; entry.loading = true; entry.text = null; entry.loadedComplete = false; this.render();
    try {
      const response = await this.bridge.request<'approval.read', { review: UiApprovalReview; loadedComplete: boolean; text: string }>('approval.read', { taskId, approvalId, reviewId: descriptor.reviewId });
      if (!this.current(taskId, sequence, generation) || this.state.reviews.get(approvalId) !== entry) return;
      applyVerifiedApprovalRead(taskId, approvalId, entry, response);
    } finally { entry.loading = false; }
  }
  async action(name: string, data: Record<string, string> = {}): Promise<void> {
    const snapshot = this.state.snapshot;
    if (name === 'confirm.arm') { this.state.armedConfirm = data.key; this.render(); return; }
    if (name === 'confirm.cancel') { this.disarmConfirm(); return; }
    if (this.state.armedConfirm) this.state.armedConfirm = null;
    if (name === 'message.dismiss') { this.state.message = ''; this.render(); return; }
    if (name === 'dismiss-action-receipt') { this.toasts.dismiss(data.key); this.render(); return; }
    if (name === 'page') { if (!['tasks', 'resources', 'settings'].includes(data.page)) return; this.state.page = data.page as 'tasks' | 'resources' | 'settings'; this.render(); this.focus('page-title'); return; }
    if (name === 'compose.open') {
      if (this.state.draft && this.submittedDraftTokens.has(this.state.draft.submitToken)) { this.state.draft = { ...this.state.draft, submitToken: crypto.randomUUID(), prompt: '' }; this.state.draftDirty = true; this.state.rawFields.clear(); this.scheduleDraft(); }
      this.state.page = 'compose'; this.state.validation = {}; this.render(); this.focus('page-title'); return;
    }
    if (name === 'detail.back') { this.state.detailOpen = false; this.render(); this.focusTask(); return; }
    if (name === 'filters.clear') { this.state.filters = defaultFilters(); this.state.projectDefaultApplied = true; this.render(); await this.serverFilter(); return; }
    if (name === 'filter.status') { this.state.filters.status = data.value; this.render(); await this.serverFilter(); return; }
    if (name === 'tab') {
      if (!tabs.includes(data.tab as DetailTab)) return;
      this.state.tab = data.tab as DetailTab; if (this.state.tab === 'delivery') this.state.deliveryVisited = true; this.render();
      if (snapshot?.selectedTaskId) {
        const taskId = snapshot.selectedTaskId;
        if (this.state.tab === 'approvals' && !snapshot.approvals && snapshot.connection.capabilities.approvalRead?.version) await this.action('approvals.list', { taskId });
        if (this.state.tab === 'events' && !this.state.eventsLoaded) await this.action('events.read', { taskId, cursor: '0' });
        if (this.state.tab === 'delivery' && !snapshot.delivery.manifest && snapshot.connection.capabilities.artifactSnapshots?.version) await this.action('artifacts.list', { taskId });
      }
      return;
    }
    if (name === 'account.toggle') { if (this.state.expandedAccounts.has(data.alias)) this.state.expandedAccounts.delete(data.alias); else this.state.expandedAccounts.add(data.alias); this.render(); return; }
    if (name === 'account.sort') {
      this.state.accountSortMode = data.mode === 'default' ? 'default' : 'quota_first';
      this.render();
      return;
    }
    if (name === 'verify.add' || name === 'verify.remove') {
      if (!this.state.draft) return;
      if (name === 'verify.add' && this.state.draft.verifyCommands.length < 10) this.state.draft.verifyCommands.push({ command: '', args: [], timeoutMs: 60_000 });
      if (name === 'verify.remove') this.state.draft.verifyCommands.splice(Number(data.index), 1);
      this.state.validation = {}; this.state.rawFields.clear(); this.state.draftDirty = true; this.scheduleDraft(); this.render(); return;
    }
    if (!snapshot && name !== 'ready') return;
    if (name === 'task.lookup') { const taskId = this.state.taskLookup.trim(); if (taskId) await this.action('task.select', { taskId }); return; }
    if (name === 'task.select') {
      this.selectionSequence++; clearTaskContent(this.state); this.state.detailOpen = true; this.state.page = 'tasks';
      await this.run(`task.select:${data.taskId}`, async () => { await this.bridge.request('task.select', { taskId: data.taskId }); }, 'task.select');
      if (this.state.snapshot?.selectedTaskId === data.taskId) { if (this.state.tab !== 'overview') await this.action('tab', { tab: this.state.tab }); this.focus('task-detail-title'); }
      return;
    }
    if (name === 'connect' || name === 'disconnect') {
      if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
      await this.run(name, async () => { const response = await this.bridge.request<typeof name, UiSnapshot>(name, {}); if (response?.connection) this.receiveSnapshot(response); }); return;
    }
    if (name === 'connection.configure' || name === 'daemon.start' || name === 'pool.shutdown') {
      if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
      await this.run(name, async () => { await this.bridge.request(name, {}); if (name === 'pool.shutdown') this.state.message = '实例已停止，后台正在退出。账号与任务数据已保留；下次使用请启动后台。'; }); return;
    }
    if (name === 'connection.codexSetup') { await this.run(name, async () => { const response = await this.bridge.request<'connection.codexSetup', { cancelled?: boolean }>(name, {}); if (!response?.cancelled) this.state.message = '已生成 MCP 配置，请在 Codex 中启用后开始调度任务。'; }); return; }
    if (name === 'tasks.more' || name === 'tasks.reload') { await this.run('tasks.list', () => this.bridge.request('tasks.list', name === 'tasks.more' && snapshot?.listNextCursor ? { cursor: snapshot.listNextCursor } : buildListPayload(this.state))); return; }
    if (name === 'refresh' || name === 'resources.refresh' || name === 'settings.open' || name === 'diagnostics.copy') {
      await this.run(name, async () => { await this.bridge.request(name, {}); this.state.message = name === 'diagnostics.copy' ? '已复制脱敏诊断。' : name === 'settings.open' ? '已打开当前计算环境的 VS Code 设置。' : '已更新任务和资源。'; }); return;
    }
    if (name === 'accounts.probeAll') {
      await this.run(name, async () => { await this.bridge.request(name, {}); this.state.message = '已探查所有可用账号的配额。'; }); return;
    }
    if (name === 'guidance.open') { await this.run(name, () => this.bridge.request('guidance.open', { topic: data.topic as 'connection' | 'approval' | 'workspace' | 'recovery' })); return; }
    if (name === 'settings.save') {
      const value = Number(this.state.settingsInterval); if (!Number.isInteger(value) || value < 15 || value > 300) { this.state.validation.settingsInterval = '请输入 15–300 的整数。'; this.render(); this.focusInvalid(); return; }
      await this.run(name, async () => { await this.bridge.request('settings.save', { overviewIntervalSeconds: value }); this.state.message = '刷新间隔已保存；未发起连接或执行操作。'; }); return;
    }
    if (name === 'pool.policy.set') {
      const raw = this.state.settingsConcurrency.trim(); const value = raw === '' ? null : Number(raw);
      if (value !== null && (!Number.isInteger(value) || value < 0 || value > 64)) { this.state.validation.settingsConcurrency = '请输入 0–64 的整数，或留空不限制。'; this.render(); this.focusInvalid(); return; }
      await this.run(name, async () => {
        await this.bridge.request('pool.policy.set', { maxConcurrentTasks: value }); this.state.policyDirty = false;
        this.state.settingsConcurrency = this.state.snapshot?.poolPolicy?.maxConcurrentTasks == null ? '' : String(this.state.snapshot.poolPolicy.maxConcurrentTasks);
        this.state.message = value === 0 ? '已暂停新派发；正在运行的任务继续。' : value === null ? '已取消池级并发上限。' : `并发任务上限已设为 ${value}；正在运行的任务继续。`;
      }); return;
    }
    if (name === 'accounts.import') {
      await this.run(name, async () => {
        const response = await this.bridge.request<'accounts.import', { cancelled?: boolean; fileCount?: number; recordCount?: number; duplicateCount?: number; accountCount?: number }>('accounts.import', {});
        if (!response.cancelled) { this.state.message = `已导入 ${response.fileCount ?? '—'} 个文件、${response.recordCount ?? response.accountCount ?? '—'} 条记录，本次合并 ${response.duplicateCount ?? '—'} 条重复记录。同名账号可能覆盖已有记录。`; this.state.importSummary = this.state.message; }
      }); return;
    }
    if (name === 'workspace.create') {
      if (!this.state.baseRef.trim()) { this.state.validation.baseRef = '请输入起始分支或提交。'; this.render(); this.focusInvalid(); return; }
      await this.run(name, async () => {
        const response = await this.bridge.request<'workspace.create', { cancelled?: boolean; workspace?: { workspaceId: string }; workspaceId?: string }>('workspace.create', { baseRef: this.state.baseRef.trim() });
        if (!response.cancelled) { this.state.message = '任务目录已创建，路径、分支与起始提交可在资源列表查看。'; const id = response.workspace?.workspaceId ?? response.workspaceId; if (id && this.state.draft) { this.state.draft.workspaceId = id; this.state.draftDirty = true; this.scheduleDraft(); } }
      }); return;
    }
    if (name === 'worker.start') { await this.run(name, () => this.bridge.request('worker.start', { workerId: this.state.workerId, accountAlias: this.state.workerAccount })); return; }
    if (name === 'worker.stop' || name === 'worker.probe') { await this.run(`worker:${data.workerId}:${name.split('.')[1]}`, () => this.bridge.request(name, { workerId: data.workerId }), `worker:${data.workerId}`); return; }
    if (name === 'account.probe') { await this.run(`account:${data.accountAlias}:probe`, () => this.bridge.request('account.probe', { accountAlias: data.accountAlias }), `quota:${data.accountAlias}`); return; }
    if (name === 'quota.read') { await this.run(`quota:${data.accountAlias}`, () => this.bridge.request('quota.read', { accountAlias: data.accountAlias })); return; }
    if (name === 'dispatch') {
      if (!this.state.draft || !snapshot) return;
      this.state.validation = { ...Object.fromEntries(Object.entries(this.state.validation).filter(([key]) => key.endsWith('.args'))), ...validateDraft(snapshot, this.state.draft) };
      if (Object.keys(this.state.validation).length) { this.render(); this.focusInvalid(); return; }
      await this.run('dispatch', async () => {
        await this.flushDraft(); this.submittedDraftTokens.add(this.state.draft!.submitToken); this.state.submittedDraftToken = this.state.draft!.submitToken;
        await this.bridge.request('dispatch', { submitToken: this.state.draft!.submitToken }); this.state.page = 'tasks'; this.state.detailOpen = true; this.render(); this.focus('task-detail-title');
      }); return;
    }
    if (name === 'dispatch.lookup') { await this.run(name, async () => { await this.bridge.request('dispatch.lookup', { requestId: data.requestId }); this.state.page = 'tasks'; this.state.detailOpen = true; }); return; }
    const taskId = data.taskId ?? snapshot?.selectedTaskId; if (!taskId) return;
    if (name === 'cancel' || name === 'reconcile' || name === 'resume') { await this.run(`task:${taskId}:${name}`, () => this.bridge.request(name, { taskId }), `task:${taskId}`); return; }
    if (name === 'events.read') {
      const cursor = Number(data.cursor ?? 0);
      await this.taskRead<EventPage>(taskId, name, `task:${taskId}:events`, { taskId, cursor }, page => {
        const items = page.events ?? page.items ?? []; this.state.events = cursor === 0 ? items : [...this.state.events, ...items.filter(item => !this.state.events.some(known => known.revision === item.revision))];
        this.state.eventsCursor = page.nextCursor ?? null; this.state.eventsLoaded = true;
      }); return;
    }
    if (name === 'patch.read') {
      const offset = Number(data.offset ?? 0);
      await this.taskRead<PatchPage>(taskId, name, `task:${taskId}:patch`, { taskId, offset }, page => {
        if (!page.available) { this.state.errors.set(`task:${taskId}:patch`, '此任务尚无可读 patch；这不表示没有修改。'); return; }
        this.state.patch = offset === 0 ? page.patch ?? page.content ?? page.text ?? '' : this.state.patch + (page.patch ?? page.content ?? page.text ?? '');
        this.state.patchNextOffset = page.nextOffset ?? null; this.state.patchLoaded = true;
      }); return;
    }
    if (name === 'approvals.list' || name === 'artifacts.list') {
      await this.taskRead<unknown>(taskId, name, `task:${taskId}:${name === 'approvals.list' ? 'approvals' : 'artifacts'}`, { taskId, ...(data.cursor ? { cursor: data.cursor } : {}) }, () => {}); return;
    }
    if (name === 'approval.open') {
      if (this.state.pending.has(`approval:${data.approvalId}:respond`)) return;
      const sequence = this.selectionSequence; const generation = snapshot!.connection.generation;
      await this.run(`approval:${data.approvalId}`, async () => {
        const review = await this.bridge.request<'approval.open', UiApprovalReview>('approval.open', { taskId, approvalId: data.approvalId });
        if (!this.current(taskId, sequence, generation)) return;
        if (review.taskId !== taskId || review.approvalId !== data.approvalId) throw new Error('ownership');
        const entry: ReviewContent = { review, text: null, loadedComplete: false, loading: false, error: null, locked: review.response.state !== 'none' || review.state !== 'pending' };
        this.state.reviews.set(review.approvalId, entry);
        if (review.content?.sourceComplete && !review.readOnlyReason && !entry.locked) await this.readApprovalContent(taskId, data.approvalId, entry, sequence, generation);
      }); return;
    }
    if (name === 'approval.read') {
      const entry = this.state.reviews.get(data.approvalId); if (!entry) return;
      const sequence = this.selectionSequence; const generation = snapshot!.connection.generation;
      await this.run(`approval:${data.approvalId}`, () => this.readApprovalContent(taskId, data.approvalId, entry, sequence, generation)); return;
    }
    if (name === 'approval.respond') {
      const entry = this.state.reviews.get(data.approvalId); const decision = data.decision as 'accept' | 'decline'; if (!entry || !['accept', 'decline'].includes(decision)) return;
      const disabled = approvalDisabled(this.state, entry, decision); if (disabled) { this.state.errors.set(`approval:${data.approvalId}`, disabled); this.render(); return; }
      entry.locked = true; this.render();
      await this.run(`approval:${data.approvalId}:respond`, async () => {
        try {
          const response = await this.bridge.request<'approval.respond', UiRpcResult<'ui_respond_approval'>['data']>('approval.respond', { taskId, approvalId: data.approvalId, reviewId: entry.review.reviewId, contentSha256: entry.review.content!.sha256, approvalRevision: entry.review.approvalRevision, nativeRevision: entry.review.nativeRevision, decision });
          if (this.state.reviews.get(data.approvalId) !== entry) return;
          applyApprovalRespondSuccess(entry, decision, response);
        } catch (error) { applyApprovalRespondError(entry, error); throw error; }
      }, `approval:${data.approvalId}`); return;
    }
    if (name === 'diff.open') { await this.run(`artifact:${data.fileId}`, async () => { await this.bridge.request('diff.open', { taskId, manifestSha256: data.manifestSha256, fileId: data.fileId }); this.state.inspectedFiles.add(data.fileId); this.state.message = '已打开不可变 Base / 交付快照 Diff。'; }); return; }
    if (name === 'file.current.open') { await this.run(`artifact:${data.fileId}`, async () => { await this.bridge.request('file.current.open', { taskId, manifestSha256: data.manifestSha256, fileId: data.fileId }); this.state.message = '已打开当前磁盘版本；它不代表该任务的历史交付。'; }); return; }
    if (name === 'review.set') { await this.run(name, () => this.bridge.request('review.set', { taskId, manifestSha256: data.manifestSha256, reviewed: data.reviewed === 'true' })); return; }
    if (name === 'artifact.read') {
      const side = data.side as 'base' | 'final'; const offsetBytes = Number(data.offsetBytes ?? 0);
      const file = snapshot!.delivery.files.find(item => item.fileId === data.fileId); if (!file || !['base', 'final'].includes(side) || file[side].encoding !== 'utf8') return;
      await this.taskRead<ArtifactChunk>(taskId, name, `artifact:${data.fileId}`, { taskId, manifestSha256: data.manifestSha256, fileId: data.fileId, side, offsetBytes }, page => appendArtifactChunk(this.state, file, side, data.manifestSha256, offsetBytes, page)); return;
    }
  }
  private onInput = (event: Event): void => { if (!(event.target instanceof HTMLSelectElement)) this.handleFormInput(event, false); };
  private onChange = (event: Event): void => { if (event.target instanceof HTMLSelectElement) this.handleFormInput(event, true); };
  private onPointerDown = (): void => { this.pointerGesture = true; };
  private onPointerUp = (): void => {
    if (this.pointerReleaseTimer) clearTimeout(this.pointerReleaseTimer);
    this.pointerReleaseTimer = setTimeout(() => { this.pointerReleaseTimer = null; this.pointerGesture = false; if (this.renderQueued) this.render(); }, 0);
  };
  private handleFormInput(event: Event, changed: boolean): void {
    updateInput(this.state, event, changed, {
      render: () => this.render(), scheduleDraft: () => this.scheduleDraft(),
      triggerFilter: debounced => { if (this.filterTimer) clearTimeout(this.filterTimer); if (debounced) this.filterTimer = setTimeout(() => void this.serverFilter(), 250); else void this.serverFilter(); }
    });
  }
  private scheduleDraft(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.flushDraft().catch(() => { this.state.errors.set('dispatch', '草稿尚未同步，提交时会重新校验。'); this.render(); }), 250);
  }
  private async flushDraft(): Promise<void> {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    const draft = canFlushDraft(this.state); if (!draft) return;
    await this.bridge.request('draft.change', { draft });
    if (JSON.stringify(draft) === JSON.stringify(this.state.draft)) this.state.draftDirty = false;
  }
  private async serverFilter(): Promise<void> {
    if (!this.state.snapshot?.connection.capabilities.taskList?.version) return;
    try { await this.bridge.request('tasks.list', buildListPayload(this.state)); this.state.errors.delete('tasks.list'); }
    catch (error) { if (!(error instanceof BridgeError && ['STALE_SELECTION', 'STALE_CONNECTION'].includes(error.detail.code))) this.state.errors.set('tasks.list', error instanceof Error ? error.message : '列表读取失败。'); }
    this.render();
  }
  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement;
    if (target.getAttribute('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const index = tabs.indexOf(this.state.tab);
      const tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      void this.action('tab', { tab }); this.focus(`tab-${tab}`); return;
    }
    if (target.classList.contains('task-row') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      // Roving focus through the task list; Enter/Space still selects (native button).
      const rows = Array.from(this.root.querySelectorAll<HTMLElement>('.task-list .task-row')); const index = rows.indexOf(target);
      const next = event.key === 'Home' ? rows[0] : event.key === 'End' ? rows[rows.length - 1] : rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))];
      if (next) { event.preventDefault(); next.focus(); } return;
    }
    if (event.key === 'Escape' && this.state.armedConfirm) { event.preventDefault(); this.disarmConfirm(); return; }
    if (event.key === 'Escape' && this.state.page === 'tasks' && this.state.detailOpen && !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) { event.preventDefault(); void this.action('detail.back'); }
  };
  private disarmConfirm(): void {
    const key = this.state.armedConfirm; if (!key) return;
    this.state.armedConfirm = null; this.render();
    const target = Array.from(this.root.querySelectorAll<HTMLElement>('[data-focus]')).find(node => node.dataset.focus === key);
    if (this.renderQueued || this.pointerGesture) this.focusAfterRender = `[data-focus="${key.replace(/["\\]/g, '\\$&')}"]`; else target?.focus();
  }
  private focus(id: string): void { if (this.renderQueued || this.pointerGesture) this.focusAfterRender = `#${id}`; else this.root.querySelector<HTMLElement>(`#${id}`)?.focus({ preventScroll: false }); }
  private focusInvalid(): void { if (this.renderQueued || this.pointerGesture) this.focusAfterRender = '[aria-invalid="true"]'; else this.root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }
  private focusTask(): void { if (this.renderQueued || this.pointerGesture) this.focusAfterRender = '.task-row.selected'; else this.root.querySelector<HTMLElement>('.task-row.selected')?.focus(); }
  dispose(): void {
    this.destroyed = true; this.disposeSubscription(); if (this.draftTimer) clearTimeout(this.draftTimer); if (this.filterTimer) clearTimeout(this.filterTimer); if (this.pointerReleaseTimer) clearTimeout(this.pointerReleaseTimer);
    this.toasts.dispose(); this.livePolite.remove(); this.liveAssertive.remove();
    this.root.removeEventListener('input', this.onInput); this.root.removeEventListener('change', this.onChange); this.root.removeEventListener('keydown', this.onKeyDown); clearTaskContent(this.state); this.state.draft = null; this.bridge.dispose();
    this.root.removeEventListener('pointerdown', this.onPointerDown, true); window.removeEventListener('pointerup', this.onPointerUp, true); window.removeEventListener('pointercancel', this.onPointerUp, true);
  }
}

if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') {
  const root = document.getElementById('app');
  if (root) {
    const app = new WorkbenchApp(root, new WebviewBridge(acquireVsCodeApi()));
    void app.start(); window.addEventListener('pagehide', () => app.dispose(), { once: true });
  }
}
