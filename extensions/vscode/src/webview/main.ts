import { WebviewBridge, BridgeError, type VsCodeApi } from './bridge.js';
import type { RequestType, RequestPayload } from '../host/protocol.js';
import type { UiSnapshot, TaskDraft } from '../host/types.js';
import type { UiApprovalReview, UiRpcResult } from '../../../../src/shared/ui-contract.js';
import { renderApp } from './components.js';
import { applySnapshot, approvalDisabled, clearTaskContent, connectionIdentity, createState, defaultFilters, persistedUi, validateDraft, type ArtifactChunk, type DetailTab, type EventPage, type LocalState, type PatchPage } from './state.js';

declare function acquireVsCodeApi(): VsCodeApi;
type Frame = { focus: string | undefined; selection: [number | null, number | null] | null; scroll: Map<string, number>; details: Map<string, boolean> };
const tabs: DetailTab[] = ['overview', 'approvals', 'delivery', 'events'];

/** View controller. Host owns connections, identities, authorization, filesystem and writes. */
export class WorkbenchApp {
  readonly state: LocalState;
  private disposeSubscription: () => void;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  private filterTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionSequence = 0;
  private readonly submittedDraftTokens = new Set<string>();
  private destroyed = false;
  private pointerGesture = false;
  private renderQueued = false;
  private pointerReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private focusAfterRender: string | null = null;
  constructor(private readonly root: HTMLElement, readonly bridge: WebviewBridge) {
    this.state = createState(bridge.getState());
    this.disposeSubscription = bridge.subscribe(snapshot => this.receiveSnapshot(snapshot));
    root.addEventListener('input', this.onInput);
    root.addEventListener('change', this.onChange);
    root.addEventListener('keydown', this.onKeyDown);
    root.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('pointerup', this.onPointerUp, true);
    window.addEventListener('pointercancel', this.onPointerUp, true);
    this.render();
  }
  async start(): Promise<void> {
    await this.run('ready', async () => {
      const snapshot = await this.bridge.request<'ready', UiSnapshot>('ready', {});
      if (snapshot?.connection) this.receiveSnapshot(snapshot);
    });
  }
  private receiveSnapshot(snapshot: UiSnapshot): void {
    const oldTask = this.state.snapshot?.selectedTaskId;
    const oldGeneration = this.state.snapshot?.connection.generation;
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
  private captureFrame(): Frame {
    const active = document.activeElement as HTMLInputElement | null;
    const selection = active && (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && ['text', 'search'].includes(active.type))) ? [active.selectionStart, active.selectionEnd] as [number | null, number | null] : null;
    return { focus: active?.dataset.focus, selection, scroll: new Map(Array.from(this.root.querySelectorAll<HTMLElement>('[data-scroll]')).map(node => [node.dataset.scroll!, node.scrollTop])), details: new Map(Array.from(this.root.querySelectorAll<HTMLDetailsElement>('[data-details]')).map(node => [node.dataset.details!, node.open])) };
  }
  render(): void {
    if (this.destroyed) return;
    if (this.pointerGesture) { this.renderQueued = true; return; }
    this.renderQueued = false;
    const frame = this.captureFrame();
    this.root.replaceChildren(renderApp({ state: this.state, action: (name, data) => void this.action(name, data) }));
    for (const node of Array.from(this.root.querySelectorAll<HTMLElement>('[data-scroll]'))) node.scrollTop = frame.scroll.get(node.dataset.scroll!) ?? 0;
    for (const node of Array.from(this.root.querySelectorAll<HTMLDetailsElement>('[data-details]'))) node.open = frame.details.get(node.dataset.details!) ?? false;
    if (frame.focus) {
      const target = Array.from(this.root.querySelectorAll<HTMLElement>('[data-focus]')).find(node => node.dataset.focus === frame.focus);
      if (target && !('disabled' in target && target.disabled)) {
        target.focus({ preventScroll: true });
        if (frame.selection && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) target.setSelectionRange(frame.selection[0], frame.selection[1]);
      }
    }
    if (this.focusAfterRender) { this.root.querySelector<HTMLElement>(this.focusAfterRender)?.focus(); this.focusAfterRender = null; }
    const persisted = persistedUi(this.state); if (persisted) this.bridge.setState(persisted);
  }
  private async run<T>(key: string, operation: () => Promise<T>, errorKey = key): Promise<T | undefined> {
    if (this.state.pending.has(key)) return undefined;
    this.state.pending.add(key); this.state.errors.delete(errorKey); this.render();
    try { return await operation(); }
    catch (error) {
      if (error instanceof BridgeError && ['STALE_CONNECTION', 'STALE_SELECTION'].includes(error.detail.code)) return undefined;
      const message = error instanceof BridgeError ? `${error.detail.code} · ${error.message}` : '此操作未能完成，请查看目标状态后重试读取。';
      this.state.errors.set(errorKey, message); this.state.message = message;
      return undefined;
    } finally { this.state.pending.delete(key); this.render(); }
  }
  private current(taskId: string, sequence: number, generation: number): boolean { return this.state.snapshot?.selectedTaskId === taskId && this.selectionSequence === sequence && this.state.snapshot?.connection.generation === generation; }
  private async taskRead<T>(taskId: string, type: RequestType, key: string, payload: object, receive: (data: T) => void): Promise<void> {
    const sequence = this.selectionSequence; const generation = this.state.snapshot?.connection.generation ?? 0;
    await this.run(key, async () => { const response = await this.bridge.request(type, payload as never); if (this.current(taskId, sequence, generation)) receive(response as T); });
  }
  async action(name: string, data: Record<string, string> = {}): Promise<void> {
    const snapshot = this.state.snapshot;
    if (name === 'page') {
      if (!['tasks', 'resources', 'settings'].includes(data.page)) return;
      this.state.page = data.page as 'tasks' | 'resources' | 'settings'; this.render(); this.focus('page-title'); return;
    }
    if (name === 'compose.open') {
      if (this.state.draft && this.submittedDraftTokens.has(this.state.draft.submitToken)) {
        // A new token is created only by this explicit independent-task action.
        this.state.draft = { ...this.state.draft, submitToken: crypto.randomUUID(), prompt: '' }; this.state.draftDirty = true; this.state.rawFields.clear(); this.scheduleDraft();
      }
      this.state.page = 'compose'; this.state.validation = {}; this.render(); this.focus('page-title'); return;
    }
    if (name === 'detail.back') { this.state.detailOpen = false; this.render(); this.focusTask(); return; }
    if (name === 'filters.clear') { this.state.filters = defaultFilters(); this.state.projectDefaultApplied = true; this.render(); await this.serverFilter(); return; }
    if (name === 'filter.status') { this.state.filters.status = data.value; this.render(); await this.serverFilter(); return; }
    if (name === 'tab') {
      if (!tabs.includes(data.tab as DetailTab)) return;
      this.state.tab = data.tab as DetailTab;
      if (this.state.tab === 'delivery') this.state.deliveryVisited = true;
      this.render();
      if (snapshot?.selectedTaskId) {
        const taskId = snapshot.selectedTaskId;
        if (this.state.tab === 'approvals' && !snapshot.approvals && snapshot.connection.capabilities.approvalRead?.version) await this.action('approvals.list', { taskId });
        if (this.state.tab === 'events' && !this.state.eventsLoaded) await this.action('events.read', { taskId, cursor: '0' });
        if (this.state.tab === 'delivery' && !snapshot.delivery.manifest && snapshot.connection.capabilities.artifactSnapshots?.version) await this.action('artifacts.list', { taskId });
      }
      return;
    }
    if (name === 'account.toggle') { if (this.state.expandedAccounts.has(data.alias)) this.state.expandedAccounts.delete(data.alias); else this.state.expandedAccounts.add(data.alias); this.render(); return; }
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
      if (this.state.snapshot?.selectedTaskId === data.taskId) {
        if (this.state.tab !== 'overview') await this.action('tab', { tab: this.state.tab });
        this.focus('task-detail-title');
      }
      return;
    }
    if (name === 'connect' || name === 'disconnect') {
      if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
      await this.run(name, async () => { const response = await this.bridge.request<typeof name, UiSnapshot>(name, {}); if (response?.connection) this.receiveSnapshot(response); }); return;
    }
    if (name === 'tasks.more' || name === 'tasks.reload') { await this.run('tasks.list', () => this.bridge.request('tasks.list', name === 'tasks.more' && snapshot?.listNextCursor ? { cursor: snapshot.listNextCursor } : this.listPayload())); return; }
    if (name === 'refresh' || name === 'resources.refresh' || name === 'settings.open' || name === 'diagnostics.copy') {
      await this.run(name, async () => { await this.bridge.request(name, {}); this.state.message = name === 'diagnostics.copy' ? '已复制脱敏诊断。' : name === 'settings.open' ? '已打开当前 Host 的 VS Code 设置。' : '已更新当前快照。'; }); return;
    }
    if (name === 'guidance.open') { await this.run(name, () => this.bridge.request('guidance.open', { topic: data.topic as 'connection' | 'approval' | 'workspace' | 'recovery' })); return; }
    if (name === 'settings.save') {
      const value = Number(this.state.settingsInterval);
      if (!Number.isInteger(value) || value < 15 || value > 300) { this.state.validation.settingsInterval = '请输入 15–300 的整数。'; this.render(); this.focusInvalid(); return; }
      await this.run(name, async () => { await this.bridge.request('settings.save', { overviewIntervalSeconds: value }); this.state.message = '刷新间隔已保存；未发起连接或执行操作。'; }); return;
    }
    if (name === 'accounts.import') {
      await this.run(name, async () => {
        const response = await this.bridge.request<'accounts.import', { cancelled?: boolean; fileCount?: number; recordCount?: number; duplicateCount?: number; accountCount?: number }>('accounts.import', {});
        if (!response.cancelled) { this.state.message = `导入已返回：${response.fileCount ?? '—'} 个文件，${response.recordCount ?? response.accountCount ?? '—'} 条记录，同批去重 ${response.duplicateCount ?? '—'}。去重数不是池内已有数；同 alias 可能被覆盖。`; this.state.importSummary = this.state.message; }
      }); return;
    }
    if (name === 'workspace.create') {
      if (!this.state.baseRef.trim()) { this.state.validation.baseRef = '请输入 base ref。'; this.render(); this.focusInvalid(); return; }
      await this.run(name, async () => {
        const response = await this.bridge.request<'workspace.create', { cancelled?: boolean; workspace?: { workspaceId: string }; workspaceId?: string }>('workspace.create', { baseRef: this.state.baseRef.trim() });
        if (!response.cancelled) { this.state.message = '创建已返回，实际 worktree、分支与 base commit 请查看资源列表。'; const id = response.workspace?.workspaceId ?? response.workspaceId; if (id && this.state.draft) { this.state.draft.workspaceId = id; this.state.draftDirty = true; this.scheduleDraft(); } }
      }); return;
    }
    if (name === 'worker.start') { await this.run(name, () => this.bridge.request('worker.start', { workerId: this.state.workerId, accountAlias: this.state.workerAccount })); return; }
    if (name === 'worker.stop' || name === 'worker.probe') { await this.run(`worker:${data.workerId}:${name.split('.')[1]}`, () => this.bridge.request(name, { workerId: data.workerId }), `worker:${data.workerId}`); return; }
    if (name === 'quota.read') { await this.run(`quota:${data.accountAlias}`, () => this.bridge.request('quota.read', { accountAlias: data.accountAlias })); return; }
    if (name === 'dispatch') {
      if (!this.state.draft || !snapshot) return;
      this.state.validation = { ...Object.fromEntries(Object.entries(this.state.validation).filter(([key]) => key.endsWith('.args'))), ...validateDraft(snapshot, this.state.draft) };
      if (Object.keys(this.state.validation).length) { this.render(); this.focusInvalid(); return; }
      await this.run('dispatch', async () => {
        await this.flushDraft();
        this.submittedDraftTokens.add(this.state.draft!.submitToken);
        this.state.submittedDraftToken = this.state.draft!.submitToken;
        await this.bridge.request('dispatch', { submitToken: this.state.draft!.submitToken });
        this.state.page = 'tasks'; this.state.detailOpen = true; this.render(); this.focus('task-detail-title');
      }); return;
    }
    if (name === 'dispatch.lookup') { await this.run(name, async () => { await this.bridge.request('dispatch.lookup', { requestId: data.requestId }); this.state.page = 'tasks'; this.state.detailOpen = true; }); return; }
    const taskId = data.taskId ?? snapshot?.selectedTaskId;
    if (!taskId) return;
    if (name === 'cancel' || name === 'reconcile' || name === 'resume') { await this.run(`task:${taskId}:${name}`, () => this.bridge.request(name, { taskId }), `task:${taskId}`); return; }
    if (name === 'events.read') {
      const cursor = Number(data.cursor ?? 0);
      await this.taskRead<EventPage>(taskId, name, `task:${taskId}:events`, { taskId, cursor }, page => {
        const items = page.events ?? page.items ?? [];
        this.state.events = cursor === 0 ? items : [...this.state.events, ...items.filter(item => !this.state.events.some(known => known.revision === item.revision))];
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
      const label = name === 'approvals.list' ? 'approvals' : 'artifacts';
      await this.taskRead<unknown>(taskId, name, `task:${taskId}:${label}`, { taskId, ...(data.cursor ? { cursor: data.cursor } : {}) }, () => {}); return;
    }
    if (name === 'approval.open') {
      const sequence = this.selectionSequence; const generation = snapshot!.connection.generation;
      await this.run(`approval:${data.approvalId}`, async () => {
        const review = await this.bridge.request<'approval.open', UiApprovalReview>('approval.open', { taskId, approvalId: data.approvalId });
        if (!this.current(taskId, sequence, generation)) return;
        if (review.taskId !== taskId || review.approvalId !== data.approvalId) throw new Error('ownership');
        this.state.reviews.set(review.approvalId, { review, text: null, loadedComplete: false, loading: false, error: null, locked: review.response.state !== 'none' || review.state !== 'pending' });
      }); return;
    }
    if (name === 'approval.read') {
      const entry = this.state.reviews.get(data.approvalId); if (!entry) return;
      const sequence = this.selectionSequence; const generation = snapshot!.connection.generation; entry.loading = true;
      await this.run(`approval:${data.approvalId}`, async () => {
        const response = await this.bridge.request<'approval.read', { review: UiApprovalReview; loadedComplete: boolean; text: string }>('approval.read', { taskId, approvalId: data.approvalId, reviewId: entry.review.reviewId });
        if (!this.current(taskId, sequence, generation) || this.state.reviews.get(data.approvalId) !== entry) return;
        if (response.review.reviewId !== entry.review.reviewId || response.review.content?.sha256 !== entry.review.content?.sha256) throw new Error('identity');
        entry.review = response.review; entry.text = response.text; entry.loadedComplete = response.loadedComplete === true; entry.loading = false;
      }); entry.loading = false; this.render(); return;
    }
    if (name === 'approval.respond') {
      const entry = this.state.reviews.get(data.approvalId); const decision = data.decision as 'accept' | 'decline';
      if (!entry || !['accept', 'decline'].includes(decision)) return;
      const disabled = approvalDisabled(this.state, entry, decision); if (disabled) { this.state.errors.set(`approval:${data.approvalId}`, disabled); this.render(); return; }
      entry.locked = true; this.render();
      await this.run(`approval:${data.approvalId}:respond`, async () => {
        try {
          const response = await this.bridge.request<'approval.respond', UiRpcResult<'ui_respond_approval'>['data']>('approval.respond', { taskId, approvalId: data.approvalId, reviewId: entry.review.reviewId, contentSha256: entry.review.content!.sha256, approvalRevision: entry.review.approvalRevision, nativeRevision: entry.review.nativeRevision, decision });
          if (this.state.reviews.get(data.approvalId) !== entry) return;
          entry.review.response = { actionId: response.actionId, decision, state: response.responseState }; entry.review.state = 'response_pending';
          entry.error = response.responseState === 'resolved_unattributed' ? '此审批已不再待处理，无法确认采用了哪次答复。' : response.responseState === 'confirmed' ? null : '答复已发送，等待原生确认。任务状态与资源占用继续以 daemon 为准。';
        } catch (error) {
          if (error instanceof BridgeError && error.detail.code === 'APPROVAL_CHANGED') { entry.text = null; entry.loadedComplete = false; entry.locked = false; entry.error = '审批已变化，请重新读取完整内容；旧 hash 不可再使用。'; entry.review.readOnlyReason = 'APPROVAL_CHANGED'; }
          else { entry.locked = true; entry.error = error instanceof BridgeError && error.detail.code === 'APPROVAL_GONE' ? '审批已不再待处理或已失效；无法确认由谁、采用何种答复。' : '答复结果待确认。请读取当前审批或核对执行状态，不会自动重发。'; }
          throw error;
        }
      }, `approval:${data.approvalId}`); return;
    }
    if (name === 'diff.open') {
      await this.run(`artifact:${data.fileId}`, async () => { await this.bridge.request('diff.open', { taskId, manifestSha256: data.manifestSha256, fileId: data.fileId }); this.state.inspectedFiles.add(data.fileId); this.state.message = '已打开不可变 Base / 交付快照 Diff。'; }); return;
    }
    if (name === 'file.current.open') { await this.run(`artifact:${data.fileId}`, async () => { await this.bridge.request('file.current.open', { taskId, manifestSha256: data.manifestSha256, fileId: data.fileId }); this.state.message = '已打开当前磁盘版本；它不代表该任务的历史交付。'; }); return; }
    if (name === 'review.set') { await this.run(name, () => this.bridge.request('review.set', { taskId, manifestSha256: data.manifestSha256, reviewed: data.reviewed === 'true' })); return; }
    if (name === 'artifact.read') {
      const side = data.side as 'base' | 'final'; const offsetBytes = Number(data.offsetBytes ?? 0);
      const file = snapshot!.delivery.files.find(item => item.fileId === data.fileId); if (!file || !['base', 'final'].includes(side) || file[side].encoding !== 'utf8') return;
      await this.taskRead<ArtifactChunk>(taskId, name, `artifact:${data.fileId}`, { taskId, manifestSha256: data.manifestSha256, fileId: data.fileId, side, offsetBytes }, page => {
        if (page.fileId !== file.fileId || page.side !== side || page.manifestSha256 !== data.manifestSha256 || page.offsetBytes !== offsetBytes || page.encoding !== 'utf8') throw new Error('identity');
        if (offsetBytes === 0) this.state.artifact = { file, side, text: '', loadedBytes: 0, totalBytes: page.totalBytes, nextOffsetBytes: 0, decoder: new TextDecoder('utf-8', { fatal: true }), complete: false, error: null };
        const artifact = this.state.artifact;
        if (!artifact || artifact.file.fileId !== file.fileId || artifact.side !== side || artifact.loadedBytes !== offsetBytes) return;
        const chunk = Uint8Array.from(atob(page.dataBase64), char => char.charCodeAt(0));
        artifact.text += artifact.decoder.decode(chunk, { stream: page.nextOffsetBytes !== null }); artifact.loadedBytes += chunk.byteLength; artifact.totalBytes = page.totalBytes; artifact.nextOffsetBytes = page.nextOffsetBytes; artifact.complete = page.nextOffsetBytes === null && artifact.loadedBytes === page.totalBytes;
      }); return;
    }
  }
  // Text inputs already emitted input. Handling their blur-time change again would
  // replace the clicked submit button between pointerdown and click.
  private onInput = (event: Event): void => { if (!(event.target instanceof HTMLSelectElement)) this.updateInput(event, false); };
  private onChange = (event: Event): void => { if (event.target instanceof HTMLSelectElement) this.updateInput(event, true); };
  private onPointerDown = (): void => { this.pointerGesture = true; };
  private onPointerUp = (): void => {
    // Finish the pointerup/click sequence before applying asynchronous Host pushes.
    if (this.pointerReleaseTimer) clearTimeout(this.pointerReleaseTimer);
    this.pointerReleaseTimer = setTimeout(() => { this.pointerReleaseTimer = null; this.pointerGesture = false; if (this.renderQueued) this.render(); }, 0);
  };
  private updateInput(event: Event, changed: boolean): void {
    const target = event.target as HTMLInputElement;
    if (!target || !('value' in target)) return;
    const filter = target.dataset.filter;
    if (filter && Object.hasOwn(this.state.filters, filter)) {
      if (filter === 'project') this.state.projectDefaultApplied = true;
      this.state.filters[filter as keyof typeof this.state.filters] = target.value; this.render();
      if (this.filterTimer) clearTimeout(this.filterTimer);
      if (filter === 'query' && !changed) this.filterTimer = setTimeout(() => void this.serverFilter(), 250);
      else void this.serverFilter(); return;
    }
    const key = target.dataset.field; if (!key) return;
    if (key.startsWith('draft.') && this.state.draft) {
      const field = key.slice(6) as keyof TaskDraft;
      if (field === 'busyRetryLimit') this.state.draft.busyRetryLimit = Number(target.value);
      else if (['workspaceId', 'workerId', 'prompt', 'session', 'mode', 'modelId'].includes(field)) (this.state.draft as unknown as Record<string, unknown>)[field] = target.value;
      this.state.draftDirty = true; delete this.state.validation[field]; this.scheduleDraft();
      if (changed || ['workspaceId', 'workerId'].includes(field)) this.render(); return;
    }
    if (key.startsWith('verify.') && this.state.draft) {
      const [, indexText, field] = key.split('.'); const command = this.state.draft.verifyCommands[Number(indexText)]; if (!command) return;
      delete this.state.validation[key];
      if (field === 'command') command.command = target.value;
      if (field === 'timeoutMs') command.timeoutMs = Number(target.value);
      if (field === 'args') {
        this.state.rawFields.set(key, target.value);
        try { const args: unknown = JSON.parse(target.value); if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error(); command.args = args; }
        catch { this.state.validation[key] = '请输入有效的 JSON 字符串数组。'; }
      }
      this.state.draftDirty = true; this.scheduleDraft(); if (changed) this.render(); return;
    }
    if (['workerId', 'workerAccount', 'baseRef', 'settingsInterval', 'taskLookup'].includes(key)) {
      (this.state as unknown as Record<string, unknown>)[key] = target.value; delete this.state.validation[key]; this.render();
    }
  }
  private scheduleDraft(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => void this.flushDraft().catch(() => { this.state.errors.set('dispatch', '草稿尚未同步到 Host。提交时会重新校验。'); this.render(); }), 250);
  }
  private async flushDraft(): Promise<void> {
    if (this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = null; }
    if (!this.state.draft || !this.state.draftDirty) return;
    if (Object.keys(this.state.validation).some(key => key.endsWith('.args'))) return;
    const draft = structuredClone(this.state.draft);
    // Incomplete executable fields remain in this Webview until valid, never silently truncated.
    if (draft.verifyCommands.some(command => !command.command.trim()) || !draft.modelId.trim() || !Number.isInteger(draft.busyRetryLimit) || draft.busyRetryLimit < 0 || draft.busyRetryLimit > 10) return;
    await this.bridge.request('draft.change', { draft });
    if (JSON.stringify(draft) === JSON.stringify(this.state.draft)) this.state.draftDirty = false;
  }
  private listPayload(): RequestPayload<'tasks.list'> {
    const snapshot = this.state.snapshot; const filters = this.state.filters;
    const repository = snapshot?.resources.workspaces.find(workspace => workspace.repositoryPath === filters.project);
    const statuses = (filters.status === 'active' ? ['queued', 'dispatching', 'running', 'waiting_approval', 'verifying'] : filters.status === 'finished' ? ['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted'] : !['all', 'attention'].includes(filters.status) ? [filters.status] : undefined) as NonNullable<RequestPayload<'tasks.list'>['filter']>['statuses'];
    return { filter: { ...(repository ? { repositoryId: repository.workspaceId } : {}), ...(filters.workspace ? { workspaceId: filters.workspace } : {}), ...(filters.worker ? { workerId: filters.worker } : {}), ...(statuses ? { statuses } : {}), ...(filters.query.trim() ? { query: filters.query.trim() } : {}) } };
  }
  private async serverFilter(): Promise<void> {
    if (!this.state.snapshot?.connection.capabilities.taskList?.version) return;
    const payload = this.listPayload();
    // A filter request may overtake a previous read. Host sequences these; UI keeps navigation live.
    try { await this.bridge.request('tasks.list', payload); this.state.errors.delete('tasks.list'); }
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
    if (event.key === 'Escape' && this.state.page === 'tasks' && this.state.detailOpen && !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) { event.preventDefault(); void this.action('detail.back'); }
  };
  private focus(id: string): void { if (this.renderQueued || this.pointerGesture) this.focusAfterRender = `#${id}`; else this.root.querySelector<HTMLElement>(`#${id}`)?.focus({ preventScroll: false }); }
  private focusInvalid(): void { if (this.renderQueued || this.pointerGesture) this.focusAfterRender = '[aria-invalid="true"]'; else this.root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(); }
  private focusTask(): void { if (this.renderQueued || this.pointerGesture) this.focusAfterRender = '.task-row.selected'; else this.root.querySelector<HTMLElement>('.task-row.selected')?.focus(); }
  dispose(): void {
    this.destroyed = true; this.disposeSubscription(); if (this.draftTimer) clearTimeout(this.draftTimer); if (this.filterTimer) clearTimeout(this.filterTimer); if (this.pointerReleaseTimer) clearTimeout(this.pointerReleaseTimer);
    this.root.removeEventListener('input', this.onInput); this.root.removeEventListener('change', this.onChange); this.root.removeEventListener('keydown', this.onKeyDown); clearTaskContent(this.state); this.state.draft = null; this.bridge.dispose();
    this.root.removeEventListener('pointerdown', this.onPointerDown, true); window.removeEventListener('pointerup', this.onPointerUp, true); window.removeEventListener('pointercancel', this.onPointerUp, true);
  }
}

if (typeof document !== 'undefined' && typeof acquireVsCodeApi === 'function') {
  const root = document.getElementById('app');
  if (root) {
    const app = new WorkbenchApp(root, new WebviewBridge(acquireVsCodeApi()));
    void app.start();
    window.addEventListener('pagehide', () => app.dispose(), { once: true });
  }
}
