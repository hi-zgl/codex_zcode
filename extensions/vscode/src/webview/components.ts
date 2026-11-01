import type { UiSnapshot, UiTask } from '../host/types.js';
import type { UiApprovalPreview, UiQuotaSnapshot, UiQuota, UiArtifactFile, UiPermissionReview } from '../../../../src/shared/ui-contract.js';
import { approvalDisabled, filterTasks, isActive, mutationReason, needsAttention, safeDetail, selectedTask, workerUnavailable, type LocalState, type DetailTab, type ReviewContent } from './state.js';

export type Action = (name: string, data?: Record<string, string>) => void;
export interface RenderContext { state: LocalState; action: Action }
type Child = Node | string | null | undefined | false;
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); if (className) node.className = className;
  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}
function text(value: unknown, fallback = '当前接口未提供'): string { return value === null || value === undefined || value === '' ? fallback : String(value); }
export function date(value: number | null | undefined): string { return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知'; }
export function bytes(value: number | null | undefined): string { return value == null ? '大小未知' : value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`; }
const statusNames: Record<string, string> = { queued: '已登记', dispatching: '派发中', running: '执行中', waiting_approval: '等待审批', verifying: '核验中', succeeded: '已完成', failed: '失败', cancelled: '已取消', blocked: '已阻塞', interrupted: '观察中断' };
export function statusLabel(task: UiTask): string { return statusNames[task.status] ?? task.status; }
function badge(label: string, tone = ''): HTMLElement { return el('span', `badge ${tone}`, label); }
function status(task: UiTask, stale = false): HTMLElement { return badge(`${stale ? '上次已知：' : ''}${statusLabel(task)}`, ['waiting_approval', 'failed', 'blocked', 'interrupted'].includes(task.status) ? 'attention' : task.status === 'succeeded' ? 'success' : ''); }
function button(ctx: RenderContext, label: string, action: string, data: Record<string, string> = {}, options: { primary?: boolean; reason?: string | null; busy?: boolean; className?: string } = {}): HTMLButtonElement {
  const node = el('button', `button ${options.primary ? 'primary' : ''} ${options.className ?? ''}`, options.busy ? `${label}…` : label);
  node.type = 'button'; node.dataset.action = action;
  node.dataset.focus = `${action}:${Object.values(data).join(':')}`;
  for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
  node.disabled = !!options.reason || !!options.busy;
  if (options.reason) { node.title = options.reason; node.setAttribute('aria-label', `${label}，不可用：${options.reason}`); }
  node.addEventListener('click', () => ctx.action(action, data)); return node;
}
function actionWithReason(ctx: RenderContext, label: string, action: string, data: Record<string, string>, reason: string | null, primary = false, busyKey = action): HTMLElement {
  const node = el('div', 'action-with-reason', button(ctx, label, action, data, { primary, reason, busy: ctx.state.pending.has(busyKey) }));
  if (reason) node.append(el('p', 'disabled-reason', reason));
  return node;
}
function section(title: string, ...children: Child[]): HTMLElement { return el('section', 'section', el('h3', '', title), ...children); }
function kv(items: [string, unknown][]): HTMLElement {
  const node = el('dl', 'metadata');
  for (const [label, value] of items) node.append(el('div', 'metadata-item', el('dt', '', label), el('dd', '', text(value))));
  return node;
}
function notice(message: string, tone = 'info'): HTMLElement { const node = el('div', `notice ${tone}`, el('span', 'notice-symbol', tone === 'warning' ? '!' : 'i'), el('p', '', message)); node.setAttribute('role', tone === 'error' ? 'alert' : 'note'); return node; }
function empty(title: string, description: string, action?: HTMLElement): HTMLElement { return el('div', 'empty-state', el('span', 'empty-mark', '◇'), el('h3', '', title), el('p', '', description), action); }
function field(label: string, control: HTMLElement, hint?: string, error?: string): HTMLElement {
  const wrapper = el('div', 'field');
  const id = control.id || `field-${control.dataset.field ?? control.dataset.filter ?? label.replace(/\s/g, '-')}`;
  control.id = id; const caption = el('label', '', label); caption.htmlFor = id;
  wrapper.append(caption, control);
  if (hint) { const node = el('p', 'field-hint', hint); node.id = `${id}-hint`; control.setAttribute('aria-describedby', node.id); wrapper.append(node); }
  if (error) { const node = el('p', 'field-error', error); node.id = `${id}-error`; node.setAttribute('role', 'alert'); control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', `${control.getAttribute('aria-describedby') ?? ''} ${node.id}`.trim()); wrapper.append(node); }
  return wrapper;
}
function input(value: string, key: string, type = 'text'): HTMLInputElement {
  const node = el('input'); node.type = type; node.value = value; node.dataset.field = key; node.dataset.focus = key; return node;
}
function select(value: string, key: string, options: [string, string][], filter = false): HTMLSelectElement {
  const node = el('select'); node.dataset[filter ? 'filter' : 'field'] = key; node.dataset.focus = `${filter ? 'filter:' : ''}${key}`;
  for (const [id, title] of options) { const option = el('option', '', title); option.value = id; node.append(option); }
  node.value = value; return node;
}
function code(content: string, label: string): HTMLElement { const pre = el('pre', 'code-block', el('code', '', content)); pre.tabIndex = 0; pre.setAttribute('aria-label', label); pre.dataset.scroll = label; return pre; }
function messageFor(ctx: RenderContext, key: string): HTMLElement | null { const error = ctx.state.errors.get(key); return error ? notice(error, 'error') : null; }
function heading(kicker: string, title: string, description: string, actions?: HTMLElement): HTMLElement { const h = el('h1', '', title); h.id = 'page-title'; h.tabIndex = -1; return el('div', 'page-heading', el('div', '', el('p', 'eyebrow', kicker), h, el('p', 'muted', description)), actions); }
function connectReason(snapshot: UiSnapshot): string | null {
  return snapshot.connection.supported === false || ['UNSUPPORTED_ENVIRONMENT', 'UNSUPPORTED_PLATFORM'].includes(snapshot.connection.error?.code ?? '') ? snapshot.connection.environmentReason ?? '此执行环境不受支持，请使用 Linux、Remote SSH 到 Linux 或 WSL。' : null;
}
function connectionBusy(ctx: RenderContext, snapshot: UiSnapshot): boolean {
  return snapshot.connection.state === 'connecting' || ['connect', 'daemon.start', 'connection.configure', 'connection.codexSetup'].some(action => ctx.state.pending.has(action));
}
function startDaemonReason(snapshot: UiSnapshot): string | null {
  return connectReason(snapshot) ?? (!snapshot.connection.trusted ? '请先在 VS Code 中信任此工作区。' : null);
}
function codexSetupReason(snapshot: UiSnapshot): string | null {
  return connectReason(snapshot) ?? (snapshot.connection.mode === 'mock' ? '演示模式不生成真实 Codex MCP 配置。' : !snapshot.connection.trusted ? '请先在 VS Code 中信任此工作区。' : null);
}
function codexSetup(ctx: RenderContext, snapshot: UiSnapshot, primary = false): HTMLElement {
  return actionWithReason(ctx, '连接 Codex / 生成 MCP 配置', 'connection.codexSetup', {}, codexSetupReason(snapshot) ?? (connectionBusy(ctx, snapshot) && !ctx.state.pending.has('connection.codexSetup') ? '请等待当前连接操作完成。' : null), primary);
}
function resourceState(value: string): string {
  return ({ ready: '就绪', starting: '启动中', stopped: '已停止', active: '可用', archived: '已归档', available: '可用', unknown: '未确认', blocked: '受阻', invalid: '无效', cooling: '冷却中', error: '异常' } as Record<string, string>)[value] ?? value;
}

export function renderApp(ctx: RenderContext): HTMLElement {
  const snapshot = ctx.state.snapshot;
  const root = el('div', 'workbench');
  root.append(renderHeader(ctx));
  if (!snapshot) { root.append(empty('正在打开工作台', '正在读取连接状态。')); return root; }
  root.append(renderConnection(ctx, snapshot), renderNavigation(ctx));
  if (snapshot.notice) root.append(notice(snapshot.notice, 'warning'));
  const feedback = renderActionFeedback(ctx); if (feedback) root.append(feedback);
  const main = el('main', 'main-content'); main.id = 'main-content';
  if (ctx.state.page === 'settings') main.append(renderSettings(ctx, snapshot));
  else if (snapshot.connection.state === 'disconnected' || (snapshot.connection.state === 'error' && !snapshot.tasks.length)) main.append(renderWelcome(ctx, snapshot));
  else if (ctx.state.page === 'resources') main.append(renderResources(ctx, snapshot));
  else if (ctx.state.page === 'compose') main.append(renderComposer(ctx, snapshot));
  else main.append(renderTasks(ctx, snapshot));
  root.append(main);
  const live = el('div', 'sr-only', ctx.state.message); live.setAttribute('aria-live', 'polite'); live.setAttribute('aria-atomic', 'true'); root.append(live);
  return root;
}
function renderHeader(ctx: RenderContext): HTMLElement {
  const skip = el('a', 'skip-link', '跳到主要内容'); skip.href = '#main-content';
  return el('header', 'app-header', skip, el('div', 'brand', el('span', 'brand-mark', 'Z'), el('strong', '', 'ZCODE')), el('span', 'header-description', 'Codex 调度 · 任务监控'), ctx.state.snapshot?.connection.mode === 'mock' ? badge('演示模式 · 模拟数据', 'demo') : badge('本地 / 远程服务', 'quiet'));
}
function renderConnection(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const connection = snapshot.connection;
  const names = { disconnected: '未连接', connecting: '连接中', connected: '已连接', 'legacy-readonly': '只读连接', error: '连接中断' };
  const indicator = el('span', `connection-indicator ${connection.state === 'connected' ? 'online' : ''}`); indicator.setAttribute('aria-hidden', 'true');
  const scope = el('div', 'execution-context', el('div', 'connection-status', indicator, el('strong', '', connection.supported === false ? '不受支持' : connection.stale && connection.state !== 'disconnected' ? '连接状态待确认' : names[connection.state]), !connection.trusted && badge('受限模式', 'attention')), el('span', 'host-label', `运行环境：${connection.host}`), el('code', 'pool-path', connection.poolHome));
  const actions = el('div', 'inline-actions');
  if (['connected', 'legacy-readonly'].includes(connection.state) || (connection.state === 'error' && snapshot.tasks.length)) actions.append(button(ctx, '刷新', 'refresh', {}, { busy: ctx.state.pending.has('refresh') }), button(ctx, '断开连接', 'disconnect'));
  else actions.append(button(ctx, connection.state === 'error' ? '重新连接' : '连接', 'connect', {}, { primary: true, busy: connectionBusy(ctx, snapshot), reason: connectReason(snapshot) }));
  const node = el('section', 'connection-banner', scope, el('div', 'connection-trailing', el('span', 'sync-time', connection.stale ? `缓存 · 最后同步 ${date(connection.lastReceivedAtMs)}` : connection.lastReceivedAtMs ? `同步于 ${date(connection.lastReceivedAtMs)}` : '尚未同步'), actions));
  if (connection.stale && connection.state !== 'disconnected') actions.prepend(button(ctx, '重新连接', 'connect', {}, { busy: ctx.state.pending.has('connect') }));
  node.setAttribute('aria-label', '连接与运行环境');
  if (connection.error) node.append(notice(`${connection.error.code} · ${connection.error.message}`, 'warning'));
  else if (connectReason(snapshot)) node.append(notice(connectReason(snapshot)!, 'warning'));
  if (connection.state === 'legacy-readonly') node.append(notice('当前后台服务版本仅支持查看，暂不能审批、提交任务或管理资源。', 'warning'));
  return node;
}
function renderNavigation(ctx: RenderContext): HTMLElement {
  const node = el('nav', 'page-nav'); node.setAttribute('aria-label', '工作台页面');
  for (const [id, label] of [['tasks', '任务监控'], ['resources', '额度与资源'], ['settings', '设置']]) {
    const b = button(ctx, label, 'page', { page: id }); if (ctx.state.page === id || (id === 'tasks' && ctx.state.page === 'compose')) b.setAttribute('aria-current', 'page'); node.append(b);
  }
  return node;
}
function renderWelcome(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const actions = el('div', 'inline-actions', codexSetup(ctx, snapshot, true), button(ctx, '连接监控', 'connect', {}, { busy: connectionBusy(ctx, snapshot), reason: connectReason(snapshot) }), button(ctx, '选择连接目录', 'connection.configure', {}, { busy: ctx.state.pending.has('connection.configure'), reason: connectionBusy(ctx, snapshot) ? '请等待当前连接操作完成。' : null }));
  if (snapshot.connection.mode === 'real' && !['connected', 'legacy-readonly'].includes(snapshot.connection.state)) actions.append(actionWithReason(ctx, '启动后台并连接', 'daemon.start', {}, startDaemonReason(snapshot) ?? (connectionBusy(ctx, snapshot) ? '请等待当前连接操作完成。' : null), false));
  return el('div', 'welcome', heading('ZCODE / 开始', '连接任务工作台', '在 Codex 中描述目标并调度任务，在这里监控进度、额度与交付。'), el('div', 'welcome-card', el('span', 'welcome-symbol', '⌁'), el('h2', '', snapshot.connection.error ? '暂时无法连接' : '让 Codex 使用同一后台'), el('p', '', '先生成 MCP 配置并在 Codex 中启用。工作台与 Codex 共享当前连接目录的账号、任务和并发设置。'), kv([['运行环境', snapshot.connection.host], ['连接目录', snapshot.connection.poolHome], ['工作区信任', snapshot.connection.trusted ? '已信任' : '受限模式 · 仅可查看']]), actions, el('p', 'field-hint', snapshot.connection.mode === 'mock' ? '演示模式使用模拟数据，可点击“连接监控”查看。' : '生成配置不会自动连接 Codex；启用配置后需重新连接 Codex。后台负责运行任务，关闭工作台后任务继续。'), button(ctx, '连接帮助', 'guidance.open', { topic: 'connection' })), messageFor(ctx, 'connect'), messageFor(ctx, 'connection.configure'), messageFor(ctx, 'connection.codexSetup'), messageFor(ctx, 'daemon.start'));
}
function renderActionFeedback(ctx: RenderContext): HTMLElement | null {
  const items = ctx.state.snapshot?.actions.filter(action => action.phase !== 'succeeded' || action.requestId) ?? [];
  if (!items.length) return null;
  return el('section', 'action-feedback', ...items.map(action => el('div', `action-receipt ${action.phase}`, el('strong', '', action.phase === 'unknown' ? '结果待确认' : action.phase === 'pending' ? '提交中' : action.phase === 'failed' ? '操作未完成' : '已收到回执'), el('p', '', action.message), action.requestId && el('code', '', `request: ${action.requestId}`), action.taskId && button(ctx, `查看 ${action.taskId}`, 'task.select', { taskId: action.taskId }), action.requestId && action.phase === 'unknown' && button(ctx, '按原请求查询任务', 'dispatch.lookup', { requestId: action.requestId }))));
}
function renderTasks(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const filtered = filterTasks(snapshot, ctx.state.filters);
  const attention = snapshot.tasks.filter(task => needsAttention(task, snapshot)).length;
  const active = snapshot.tasks.filter(isActive).length;
  const advanced = el('details', 'advanced-actions', el('summary', '', '高级操作'), actionWithReason(ctx, '手动派发任务', 'compose.open', {}, mutationReason(snapshot, 'dispatchTask'))); advanced.dataset.details = 'task-advanced';
  const page = el('div', 'task-page', heading('ZCODE / 任务', '任务监控', '由 Codex 拆分、派发和验收任务；在这里查看进度、处理必要审批、检查交付。', el('div', 'page-actions', codexSetup(ctx, snapshot, true), advanced)));
  page.append(messageFor(ctx, 'connection.codexSetup') ?? '');
  page.append(el('div', 'metrics', metric(ctx, '需要处理', attention, 'attention', '审批、阻塞、失败及待审阅交付'), metric(ctx, '执行中', active, 'active', '包括派发、执行与核验'), el('div', 'metric', el('span', 'metric-number', String(snapshot.tasks.length).padStart(2, '0')), el('div', '', el('strong', '', '已载入任务'), el('p', '', snapshot.scope === 'recent_50_loaded' ? '最近创建 50 条窗口 · 历史总数未知' : `当前匹配范围 · 总数 ${snapshot.total ?? '未知'}`)))));
  page.append(renderFilters(ctx, snapshot));
  const task = selectedTask(ctx.state);
  const taskList = el('section', 'task-list-panel'); taskList.setAttribute('aria-label', '任务列表');
  taskList.append(el('div', 'panel-title', el('h2', '', '已载入任务'), el('span', 'muted', '最近创建优先')));
  const list = el('div', 'task-list'); list.dataset.scroll = 'task-list';
  if (!filtered.length) list.append(empty('当前列表没有匹配任务', snapshot.tasks.length === 0 ? '在 Codex 中描述任务目标，派发后的任务会显示在这里。也可通过高级操作手动派发。' : snapshot.scope === 'recent_50_loaded' ? '最近 50 条中没有匹配项，可继续加载历史任务。' : '可清除筛选后查看其他任务。', button(ctx, '清除筛选 · 全部项目', 'filters.clear')));
  for (const item of filtered) {
    const workspace = snapshot.resources.workspaces.find(ws => ws.workspaceId === item.workspaceId);
    const row = button(ctx, '', 'task.select', { taskId: item.taskId }, { className: `task-row ${item.taskId === snapshot.selectedTaskId ? 'selected' : ''}` });
    row.setAttribute('aria-pressed', String(item.taskId === snapshot.selectedTaskId)); row.setAttribute('aria-label', `${item.taskId}，${statusLabel(item)}，${item.workspaceId}，${item.workerId ?? '未绑定执行器'}`);
    row.append(el('div', 'task-row-top', el('code', 'task-id', item.taskId), status(item, snapshot.connection.stale)), el('strong', 'task-row-title', workspace?.branch ?? item.workspaceId), el('span', 'task-project', workspace?.repositoryPath ?? '项目路径当前未提供'), el('div', 'task-row-bottom', el('span', '', item.workerId ?? '未绑定执行器'), item.retry ? el('span', '', `原会话续跑 ${item.retry.used}/${item.retry.max}`) : el('span', '', '续跑信息未提供')), el('span', 'task-time', item.createdAtMs ? date(item.createdAtMs) : '创建时间 —'));
    if (item.leaseHeld && item.executionStopped !== true && !isActive(item)) row.append(badge('! 占用未知', 'attention'));
    if (item.status === 'succeeded') row.append(el('span', 'task-review', item.deliveryReview === 'reviewed' || (snapshot.selectedTaskId === item.taskId && snapshot.delivery.reviewed) ? '✓ 本客户端已审阅' : item.deliveryReview === 'pending' ? '待人工审阅' : '审阅状态待加载'));
    list.append(row);
  }
  taskList.append(list, el('p', 'scope-note', `筛选 ${filtered.length} / 已载入 ${snapshot.tasks.length} · ${snapshot.scope === 'recent_50_loaded' ? '历史总数未知' : `服务端范围共 ${snapshot.total ?? '未知'} 条${ctx.state.filters.status === 'attention' ? '；需要处理仅筛选已载入任务' : ''}`}`));
  if (snapshot.listNextCursor) taskList.append(button(ctx, '继续加载历史任务', 'tasks.more', {}, { busy: ctx.state.pending.has('tasks.list') }));
  if (ctx.state.errors.has('tasks.list')) taskList.append(notice(ctx.state.errors.get('tasks.list')!, 'warning'), button(ctx, '重新加载列表', 'tasks.reload'));
  const lookup = input(ctx.state.taskLookup, 'taskLookup'); lookup.placeholder = '已知任务完整 ID';
  taskList.append(el('div', 'task-lookup', field('通过任务 ID 查找', lookup), button(ctx, '打开任务', 'task.lookup', {}, { reason: !ctx.state.taskLookup.trim() ? '请输入完整任务 ID。' : null })));
  const detail = el('section', 'detail-container', button(ctx, '← 返回任务列表', 'detail.back', {}, { className: 'mobile-back' }), task ? renderTaskDetail(ctx, snapshot, task, filtered.some(item => item.taskId === task.taskId)) : empty('选择一个任务', '选中任务仅加载详情，不会恢复或执行任务。'));
  page.append(el('div', `task-workspace ${ctx.state.detailOpen ? 'detail-open' : ''}`, taskList, detail));
  return page;
}
function metric(ctx: RenderContext, label: string, count: number, filter: string, description: string): HTMLElement {
  const node = button(ctx, '', 'filter.status', { value: filter }, { className: 'metric' }); node.append(el('span', `metric-number ${filter === 'attention' ? 'amber' : ''}`, String(count).padStart(2, '0')), el('div', '', el('strong', '', label), el('p', '', description))); return node;
}
function renderFilters(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const projects = [...new Set(snapshot.resources.workspaces.map(workspace => workspace.repositoryPath))].filter(Boolean);
  const filters = ctx.state.filters;
  const search = input(filters.query, 'query'); delete search.dataset.field; search.dataset.filter = 'query'; search.dataset.focus = 'filter:query'; search.type = 'search'; search.maxLength = 200; search.placeholder = 'ID、仓库、分支、执行器';
  const node = el('section', 'task-filters', field('项目', select(filters.project, 'project', [['', '全部项目'], ...projects.map(project => [project, project] as [string, string])], true)), field('状态', select(filters.status, 'status', [['all', '全部状态'], ['attention', '需要处理'], ['active', '执行中（含核验）'], ['finished', '最近结束'], ...Object.entries(statusNames)], true)), field('执行器', select(filters.worker, 'worker', [['', '全部执行器'], ...snapshot.resources.workers.map(worker => [worker.workerId, worker.workerId] as [string, string])], true)), field('任务目录', select(filters.workspace, 'workspace', [['', '全部任务目录'], ...snapshot.resources.workspaces.map(workspace => [workspace.workspaceId, workspace.workspaceId] as [string, string])], true)), field('搜索任务', search));
  node.setAttribute('aria-label', '筛选已载入任务'); return node;
}
function renderTaskDetail(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask, inFilter: boolean): HTMLElement {
  const detail = safeDetail(snapshot);
  const title = el('h2', '', task.taskId); title.id = 'task-detail-title'; title.tabIndex = -1;
  const node = el('div', 'task-detail', el('div', 'detail-heading', el('div', '', el('p', 'eyebrow', '任务详情'), title), status(task, snapshot.connection.stale)));
  if (!inFilter) node.append(notice('此任务不在当前筛选中；详情保持打开。'));
  node.append(kv([['任务目录', task.workspaceId], ['执行器', task.workerId], ['状态版本', task.revision], ['本地审阅', snapshot.delivery.reviewed || task.deliveryReview === 'reviewed' ? '本客户端已审阅' : task.status === 'succeeded' && detail?.result.available ? '待人工审阅' : '—']]));
  if (task.leaseHeld) node.append(notice(task.executionStopped === true ? '执行已停止，资源占用仍保留；可能正在核验或保存交付。' : task.executionStopped === undefined ? '尚未确认执行是否停止，执行器和任务目录暂不可复用。' : isActive(task) ? '任务正在占用执行器和任务目录。' : '尚未确认执行是否停止，执行器和任务目录继续保留占用。', 'warning'));
  else if (task.executionStopped === true) node.append(el('p', 'occupancy-proof', '✓ 执行已确认停止 · 资源占用已释放'));
  if (task.cancelRequestedAtMs != null) node.append(notice(`已记录取消请求（${date(task.cancelRequestedAtMs)}），等待实际停止确认；不会再触发后续自动续跑。`, 'warning'));
  if (task.retry) node.append(el('div', 'retry-strip', el('strong', '', `原会话立即继续 · 已使用 ${task.retry.used}/${task.retry.max} 次`), el('span', '', task.retry.max === 0 ? '已关闭模型繁忙续跑' : '仅明确的 model_busy，沿用账号、模型与会话；初次派发不计入')));
  if (!detail) node.append(notice('当前接口未提供可信安全详情；已有结果可读，写动作不可用。', 'warning'));
  const tabbar = el('div', 'detail-tabs'); tabbar.setAttribute('role', 'tablist'); tabbar.setAttribute('aria-label', '任务详情页签');
  const tabs: [DetailTab, string][] = [['overview', '概况'], ['approvals', `审批${task.approval?.pendingCount ? ` · ${task.approval.pendingCount}` : ''}`], ['delivery', '交付与核验'], ['events', '事件']];
  for (const [id, label] of tabs) { const b = button(ctx, label, 'tab', { tab: id }); b.setAttribute('role', 'tab'); b.id = `tab-${id}`; b.setAttribute('aria-selected', String(ctx.state.tab === id)); b.setAttribute('aria-controls', `panel-${id}`); b.tabIndex = ctx.state.tab === id ? 0 : -1; tabbar.append(b); }
  node.append(tabbar);
  const panel = el('div', 'tab-panel'); panel.id = `panel-${ctx.state.tab}`; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', `tab-${ctx.state.tab}`); panel.tabIndex = 0;
  if (ctx.state.tab === 'overview') panel.append(renderOverview(ctx, snapshot, task));
  if (ctx.state.tab === 'approvals') panel.append(renderApprovals(ctx, snapshot, task));
  if (ctx.state.tab === 'delivery') panel.append(renderDelivery(ctx, snapshot, task));
  if (ctx.state.tab === 'events') panel.append(renderEvents(ctx, task));
  node.append(panel);
  if (detail) node.append(renderTaskControls(ctx, snapshot, task));
  return node;
}
function renderOverview(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const detail = safeDetail(snapshot);
  if (!detail) {
    const legacy = snapshot.legacyResult?.result;
    return el('div', '', section('安全概况', el('p', '', '旧接口仅提供有限只读投影。'), legacy?.summary && el('p', '', String(legacy.summary)), kv([['任务状态', task.status], ['停止证明', task.executionStopped === undefined ? '当前接口未提供' : task.executionStopped ? '已确认' : '尚未确认']])));
  }
  const binding = detail.selection.binding;
  const node = el('div', '', detail.diagnostic && notice(`${detail.diagnostic.code} · ${detail.diagnostic.message}`, 'warning'), section('执行与绑定', kv([['源仓库', detail.workspace.repositoryPath], ['执行目录', detail.workspace.worktreePath], ['分支', detail.workspace.branch], ['起始提交', detail.workspace.baseCommit], ['账号 / 服务商', binding ? `${binding.accountAlias} / ${binding.providerId}` : '尚未绑定'], ['请求模型', detail.selection.requestedModelId], ['已绑定模型', binding?.modelId], ['会话 ID', detail.execution.sessionId], ['操作 ID', detail.execution.currentCommandId], ['运行模式', detail.selection.mode], ['会话策略', detail.selection.requestedSession === 'continue' ? '继续最近可复用会话；否则新建' : '新会话'], ['观察连接', detail.execution.attachment], ['请求 ID', detail.requestId]])), section('停止依据', detail.execution.stopProof ? kv([['证明类型', detail.execution.stopProof.kind], ['观察时间', date(detail.execution.stopProof.observedAtMs)], ['说明', detail.execution.stopProof.evidenceSummary]]) : el('p', 'muted', '尚未取得本次执行的停止证明。请求已收到或结果已返回，都不代表执行已停止。')), section('核验策略', detail.verificationPolicy.complete ? detail.verificationPolicy.defaultDiffCheck ? code('git diff --check', '默认核验命令') : el('div', '', ...detail.verificationPolicy.commands.map(command => code(`${command.command} ${command.args.map(arg => JSON.stringify(arg)).join(' ')}\n超时 ${command.timeoutMs}ms`, '核验命令与参数'))) : notice(detail.verificationPolicy.unavailableReason ?? '策略无法完整安全显示，恢复观察不可用。', 'warning')));
  const attempts = el('ol', 'attempt-list');
  for (const attempt of detail.attempts) attempts.append(el('li', '', el('strong', '', `执行 ${attempt.index}${detail.currentAttemptIndex === attempt.index ? ' · 当前' : ''}`), kv([['操作 ID', attempt.commandId], ['请求记录时间', date(attempt.intentAtMs)], ['后台回执', attempt.acknowledgedAtMs === null ? '尚未确认；可能已发送' : date(attempt.acknowledgedAtMs)], ['结束状态', attempt.terminalState], ['失败类别', attempt.failureCategory], ['停止证明', attempt.stopProofKind]])));
  node.append(section('执行记录', attempts)); return node;
}
function renderTaskControls(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const detail = safeDetail(snapshot)!;
  const actions = el('section', 'task-controls', el('h3', '', '任务操作'));
  const data = { taskId: task.taskId };
  if (detail.controls.reconcile.available || ['interrupted', 'blocked', 'dispatching'].includes(task.status) || (task.leaseHeld && !isActive(task))) {
    const reason = mutationReason(snapshot, 'reconcileTask') ?? (!detail.controls.reconcile.available ? detail.controls.reconcile.reason ?? '当前状态不适用。' : null);
    actions.append(actionWithReason(ctx, '核对执行状态', 'reconcile', data, reason, false, `task:${task.taskId}:reconcile`), el('p', 'field-hint', '不发送模型命令或运行核验；会更新本地任务记录，并可能释放已证实停止的占用。'));
  }
  if (detail.controls.resume.available || ['interrupted', 'blocked'].includes(task.status)) {
    const reason = mutationReason(snapshot, 'resumeTask') ?? (!detail.verificationPolicy.complete ? '核验策略尚不能完整安全显示。' : !detail.controls.resume.available ? detail.controls.resume.reason ?? '当前状态不适用。' : null);
    actions.append(actionWithReason(ctx, '恢复观察', 'resume', data, reason, true, `task:${task.taskId}:resume`), el('p', 'field-hint', '附着原执行；结束后可能运行既有核验，明确繁忙时可使用剩余的原会话续跑。'));
  }
  if (task.status !== 'verifying' && (detail.controls.cancel.available || isActive(task) || ['blocked', 'interrupted'].includes(task.status))) {
    const reason = mutationReason(snapshot, 'cancelTask') ?? (task.cancelRequestedAtMs != null ? '取消意图已记录，等待实际停止确认。' : !detail.controls.cancel.available ? detail.controls.cancel.reason ?? '当前状态不适用。' : null);
    actions.append(actionWithReason(ctx, task.cancelRequestedAtMs != null ? '等待停止确认' : '请求取消整个任务', 'cancel', data, reason, false, `task:${task.taskId}:cancel`));
  }
  actions.append(messageFor(ctx, `task:${task.taskId}`) ?? ''); return actions;
}
function renderApprovals(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const data = snapshot.approvals;
  const node = el('div', '', el('div', 'section-toolbar', el('h3', '', '待你决定的操作'), button(ctx, '刷新审批', 'approvals.list', { taskId: task.taskId }, { busy: ctx.state.pending.has(`task:${task.taskId}:approvals`) })));
  node.append(el('p', 'field-hint', '先查看完整操作，再选择批准或拒绝。批准仅限本次；拒绝本项不会取消整个任务。'));
  if (mutationReason(snapshot, 'approvalRead')) node.append(notice(mutationReason(snapshot, 'approvalRead')!, 'warning'));
  if (!data) node.append(empty('正在等待审批列表', '点击“刷新审批”查看当前需要决定的操作。'));
  else {
    node.append(el('p', 'scope-note', `已载入 ${data.items?.length ?? 0} 项 / 总数 ${data.total === null ? '未知' : data.total} · ${data.stateKnown ? '当前归属已核对' : '原生状态未知'}`));
    if (data.unattributedCount) node.append(notice(`${data.unattributedCount} 项原生交互无法归属到当前任务，未加入可操作清单。`, 'warning'));
    if (!data.stateKnown) node.append(notice('无法可靠读取当前原生归属，所有审批保持只读。可先核对执行状态。', 'warning'));
    const known = new Set<string>();
    for (const item of (data.items ?? []) as UiApprovalPreview[]) { known.add(item.approvalId); node.append(renderApprovalCard(ctx, task, item, ctx.state.reviews.get(item.approvalId))); }
    // Keep ACK cards visible after disappearance: disappearance alone cannot confirm our decision.
    for (const [approvalId, review] of ctx.state.reviews) if (!known.has(approvalId) && review.locked) node.append(renderApprovalCard(ctx, task, { approvalId, kind: 'permission', toolName: null, summary: '此操作已不在待审批列表中，答复采用情况仍以后台回执为准。', truncated: false, sourceComplete: true, responseState: review.review.response.state, readOnlyReason: null }, review));
    if (!data.items?.length && !ctx.state.reviews.size) node.append(empty('当前没有待处理审批', '任务是否完成，请查看任务状态。'));
    if (data.nextCursor) node.append(button(ctx, '继续读取审批列表', 'approvals.list', { taskId: task.taskId, cursor: data.nextCursor }, { busy: ctx.state.pending.has(`task:${task.taskId}:approvals`) }));
  }
  node.append(messageFor(ctx, `task:${task.taskId}:approvals`) ?? ''); return node;
}
function responseLabel(state: string): string { return ({ none: '待处理', intent_recorded: '答复已记录 · 等待确认', awaiting_native: '答复已发送 · 等待确认', confirmed: '已确认本次答复', resolved_unattributed: '已结束 · 采用的答复待确认', unknown: '答复结果待确认' } as Record<string, string>)[state] ?? state; }
function renderApprovalCard(ctx: RenderContext, task: UiTask, item: UiApprovalPreview, content: ReviewContent | undefined): HTMLElement {
  const data = { taskId: task.taskId, approvalId: item.approvalId };
  const descriptor = content?.review;
  const card = el('article', 'approval-card', el('div', 'section-toolbar', el('h4', '', item.toolName ?? item.kind), badge(responseLabel(descriptor?.response.state ?? item.responseState), 'attention')), el('code', 'identity-code', item.approvalId), el('p', '', item.summary), item.truncated && badge('摘要已截断', 'attention'));
  const loading = ctx.state.pending.has(`approval:${item.approvalId}`);
  const completeSource = descriptor?.content?.sourceComplete ?? item.sourceComplete;
  const progress = el('p', `approval-read-status ${content?.loadedComplete ? 'complete' : ''}`, loading ? '正在加载并校验完整操作…' : content?.loadedComplete ? '✓ 完整操作已加载并校验' : completeSource ? '当前仅显示摘要。' : '完整来源不可用，此操作仅可查看。');
  progress.setAttribute('role', 'status'); card.append(progress);
  if (!content) card.append(button(ctx, '查看完整操作', 'approval.open', data, { primary: true, busy: loading }));
  else {
    const identity = el('details', 'review-identity', el('summary', '', '审批归属与校验详情'), kv([['任务 / 执行轮次', `${descriptor!.taskId} / ${descriptor!.owner.attemptIndex}`], ['操作 ID', descriptor!.owner.commandId], ['会话 ID', descriptor!.owner.sessionId], ['审阅 ID', descriptor!.reviewId], ['审批版本', descriptor!.approvalRevision], ['后台版本', descriptor!.nativeRevision], ['内容范围', descriptor!.content ? `${bytes(descriptor!.content.totalBytes)} · ${descriptor!.content.schema}` : '无可用来源'], ['SHA-256', descriptor!.content?.sha256], ['本次审阅有效至', date(descriptor!.expiresAtMs)]]));
    identity.dataset.details = `identity:${item.approvalId}`; card.append(identity);
    if (descriptor!.redactions.length) card.append(el('p', 'field-hint', `脱敏：${descriptor!.redactions.map(redaction => `${redaction.category}${redaction.decisionRelevant ? '（影响决策，整体只读）' : ''}`).join('、')}`));
    if (content.text) card.append(renderPermissionContent(content.text, item.approvalId));
    card.append(button(ctx, content.locked || !completeSource || descriptor!.readOnlyReason ? '刷新审批状态' : content.loadedComplete ? '重新加载操作' : '查看完整操作', 'approval.open', data, { primary: !content.loadedComplete && !content.locked && completeSource && !descriptor!.readOnlyReason, busy: loading, reason: ctx.state.pending.has(`approval:${item.approvalId}:respond`) ? '正在提交答复，请稍候。' : null }));
    if (descriptor!.decisions.length) {
      const decisions = el('div', 'approval-decisions');
      for (const option of descriptor!.decisions) {
        // permission cancel aliases deny; display the verified once/deny pair only.
        if (option.decision === 'cancel') continue;
        const reason = approvalDisabled(ctx.state, content, option.decision);
        decisions.append(actionWithReason(ctx, option.decision === 'accept' ? '只批准本次操作' : '拒绝本次操作', 'approval.respond', { ...data, decision: option.decision }, reason, option.decision === 'accept', `approval:${item.approvalId}:respond`));
      }
      card.append(decisions);
    } else card.append(notice('此操作暂不能在工作台答复，请在后台原始会话中处理。', 'warning'));
    if (descriptor!.response.actionId) card.append(el('code', 'identity-code', `action: ${descriptor!.response.actionId}`));
    if (content.error) card.append(notice(content.error, 'warning'));
  }
  const readOnly = descriptor?.readOnlyReason ?? item.readOnlyReason;
  if (readOnly) card.append(notice(`只读：${readOnly}`, 'warning'), button(ctx, '查看处理方法', 'guidance.open', { topic: 'approval' }));
  card.append(messageFor(ctx, `approval:${item.approvalId}`) ?? ''); return card;
}
function renderPermissionContent(raw: string, approvalId: string): HTMLElement {
  const node = el('div', 'permission-content');
  let parsed: UiPermissionReview;
  try { parsed = JSON.parse(raw) as UiPermissionReview; }
  catch { node.append(code(raw, `审批 ${approvalId} 完整正文`)); return node; }
  // Presentation only: raw remains unchanged in memory for the Host-bound review identity.
  const payload = parsed.interaction?.payload;
  if (payload?.detail && typeof payload.detail === 'object') {
    const parameters = payload.detail;
    const target = parameters.file_path ?? parameters.path ?? parameters.target ?? parameters.paths;
    node.append(section('本次请求的操作', kv([['工具', payload.toolName], ['目标', typeof target === 'string' ? target : target === undefined ? '以完整参数为准' : JSON.stringify(target, null, 2)], ['执行目录', typeof parameters.cwd === 'string' ? parameters.cwd : parsed.workspacePath], ['请求范围', '只允许当前操作一次；不授予永久权限']]), payload.summary && el('p', '', payload.summary)));
    const fields = section('完整决策参数');
    for (const [key, value] of Object.entries(parameters)) fields.append(el('h5', 'parameter-label', key), code(typeof value === 'string' ? value : JSON.stringify(value, null, 2), `审批 ${approvalId} 参数 ${key}`));
    node.append(fields);
  }
  const full = el('details', 'review-canonical', el('summary', '', '查看完整审阅 JSON（全部字段）'), code(JSON.stringify(parsed, null, 2), `审批 ${approvalId} 完整审阅 JSON`));
  full.dataset.details = `canonical:${approvalId}`; node.append(full); return node;
}
function renderDelivery(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const detail = safeDetail(snapshot); const result = detail?.result;
  const node = el('div', 'delivery');
  if (!result?.available) {
    const legacy = snapshot.legacyResult?.result;
    if (legacy) node.append(section('交付摘要（旧接口）', el('p', '', legacy.summary), legacy.verification && section('核验记录', ...legacy.verification.map(item => el('div', 'verification-row', el('code', '', item.command), badge(item.exitCode === null ? '退出码未知' : `退出码 ${item.exitCode}`), item.summary && code(item.summary, '旧接口核验摘要')))), legacy.blockers && section('Blockers', el('ul', '', ...legacy.blockers.map(item => el('li', '', item))))));
    else node.append(empty('交付尚未生成', '结果为空不能证明没有修改，也不表示已通过核验。'));
  } else {
    node.append(section('交付总结', el('p', 'delivery-summary', result.summary || '没有摘要。'), result.summaryTruncated && badge('摘要已截断', 'attention')));
    if (result.blockers.length) node.append(section('仍需处理', el('ul', 'blockers', ...result.blockers.map(blocker => el('li', '', blocker)))));
    const verification = el('div', 'verification-list');
    for (const item of result.verification) verification.append(el('article', 'verification-row', el('div', 'section-toolbar', el('code', '', item.commandDisplay), badge(item.exitCode === null ? '退出码未知' : `退出码 ${item.exitCode}`, item.exitCode === 0 ? 'success' : 'attention')), item.summary && code(item.summary, '核验输出摘要'), item.summaryTruncated && badge('输出摘要已截断', 'attention')));
    node.append(section('核验事实', result.verification.length ? verification : el('p', 'muted', '当前结果没有核验记录。'), notice('命令退出码仅说明这些检查的执行结果，仍需功能验收。')));
  }
  const manifest = snapshot.delivery.manifest;
  node.append(section('不可变交付快照', el('div', 'inline-actions', button(ctx, manifest ? '刷新文件清单' : '加载快照与文件清单', 'artifacts.list', { taskId: task.taskId }, { busy: ctx.state.pending.has(`task:${task.taskId}:artifacts`) }), button(ctx, ctx.state.patchLoaded ? '重新读取 patch' : '读取 patch 文字', 'patch.read', { taskId: task.taskId, offset: '0' }, { busy: ctx.state.pending.has(`task:${task.taskId}:patch`) }))));
  if (manifest) {
    node.append(kv([['快照状态', manifest.state], ['起始提交', manifest.baseCommit], ['比较范围', '相对任务目录起始提交的累计变化，可能包含先前任务'], ['文件范围', 'Git 已跟踪文件与未忽略的未跟踪文件'], ['捕获开始', date(manifest.captureStartedAtMs)], ['捕获结束', date(manifest.captureCompletedAtMs)], ['一致性', manifest.consistency === 'lease_held_non_atomic' ? '保存期间保留资源占用，逐文件捕获；各文件的保存时间可能不同' : '旧数据一致性未知'], ['交付清单 SHA-256', manifest.manifestSha256], ['文件计数', manifest.fileCount === null ? '未知' : `${manifest.fileCount} 项（可用 ${manifest.availableFileCount}，缺口 ${manifest.unavailableFileCount}）`]]));
    if (manifest.unavailableReason || manifest.state !== 'available') node.append(notice(manifest.unavailableReason ?? '此任务没有完整历史文件快照；不能使用当前 worktree 冒充历史 Diff。', 'warning'));
    const files = el('div', 'artifact-files');
    for (const file of snapshot.delivery.files as UiArtifactFile[]) files.append(renderArtifactFile(ctx, task, file, manifest.manifestSha256));
    node.append(files);
    if (snapshot.delivery.nextCursor) node.append(button(ctx, '继续读取文件清单', 'artifacts.list', { taskId: task.taskId, cursor: snapshot.delivery.nextCursor }, { busy: ctx.state.pending.has(`task:${task.taskId}:artifacts`) }));
    const canReview = manifest.state === 'available' && !!manifest.manifestSha256 && manifest.fileListComplete && !snapshot.delivery.nextCursor && snapshot.delivery.files.length === manifest.fileCount && ctx.state.deliveryVisited;
    const unopenedFiles = snapshot.delivery.files.filter(file => file.nativeDiff.available && !ctx.state.inspectedFiles.has(file.fileId));
    const reason = mutationReason(snapshot, 'artifactSnapshots') ?? (!canReview ? '需要完整交付清单、文件列表，以及已查看的交付与核验信息。' : task.status === 'verifying' ? '核验尚未结束。' : !snapshot.delivery.reviewed && unopenedFiles.length ? `请先打开 ${unopenedFiles.length} 个尚未查看的不可变文件 Diff。` : null);
    node.append(section('本窗口审阅', el('p', '', snapshot.delivery.reviewed ? '✓ 本窗口已标记审阅这份交付。' : '完成变更检查与功能验收后，可记录本窗口的审阅结果。'), actionWithReason(ctx, snapshot.delivery.reviewed ? '撤销已审阅标记' : '标记已审阅', 'review.set', { taskId: task.taskId, manifestSha256: manifest.manifestSha256 ?? '', reviewed: String(!snapshot.delivery.reviewed) }, reason, true), el('p', 'field-hint', '标记仅用于当前窗口，绑定本任务的这份交付。代码合并与其他客户端的验收需分别进行。')));
  }
  if (ctx.state.patchLoaded) node.append(section(ctx.state.patchNextOffset === null ? '完整 patch 文字' : '部分 patch · 尚未完整载入', code(ctx.state.patch || '此可用 patch 为空。', '累计 patch 文字'), ctx.state.patchNextOffset !== null && button(ctx, '继续读取 patch（UTF-16 offset）', 'patch.read', { taskId: task.taskId, offset: String(ctx.state.patchNextOffset) }, { busy: ctx.state.pending.has(`task:${task.taskId}:patch`) }), el('p', 'field-hint', 'patch 不包含未跟踪文件内容；分页 offset 单位为 UTF-16 code units。')));
  const artifact = ctx.state.artifact;
  if (artifact) node.append(section(`${artifact.file.displayPath} · ${artifact.side === 'base' ? 'Base' : '交付'}固定文本${artifact.file[artifact.side].kind === 'symlink' ? '（符号链接目标文字）' : ''}`, el('p', 'scope-note', `已载入 ${bytes(artifact.loadedBytes)} / ${bytes(artifact.totalBytes)} · ${artifact.complete ? '全文已读齐' : '尚未完整载入'}`), code(artifact.text, '不可变工件文本'), artifact.error && notice(artifact.error, 'error'), artifact.nextOffsetBytes !== null && button(ctx, '继续读取工件文本', 'artifact.read', { taskId: task.taskId, manifestSha256: manifest?.manifestSha256 ?? '', fileId: artifact.file.fileId, side: artifact.side, offsetBytes: String(artifact.nextOffsetBytes) }, { busy: ctx.state.pending.has(`artifact:${artifact.file.fileId}`) })));
  node.append(messageFor(ctx, `task:${task.taskId}:artifacts`) ?? '', messageFor(ctx, `task:${task.taskId}:patch`) ?? ''); return node;
}
function renderArtifactFile(ctx: RenderContext, task: UiTask, file: UiArtifactFile, manifestSha256: string | null): HTMLElement {
  const node = el('article', 'artifact-file', el('div', 'section-toolbar', el('strong', 'file-path', file.displayPath), badge(file.change)), el('p', 'field-hint', `Base: ${file.base.state} · ${file.base.kind} · ${bytes(file.base.sizeBytes)} → 交付: ${file.final.state} · ${file.final.kind} · ${bytes(file.final.sizeBytes)}`));
  if (file.change === 'untracked') node.append(el('p', 'field-hint', '未跟踪工件 · 不包含在 patch 中'));
  const readReason = !manifestSha256 ? '缺少已验证的 manifest 身份。' : file.nativeDiff.available ? null : file.nativeDiff.reason ?? '不可用的文件类型或历史字节。';
  node.append(actionWithReason(ctx, '打开原生 Diff', 'diff.open', { taskId: task.taskId, manifestSha256: manifestSha256 ?? '', fileId: file.fileId }, readReason));
  const contentActions = el('div', 'inline-actions');
  for (const side of ['base', 'final'] as const) if (file[side].state === 'available' && file[side].encoding === 'utf8') contentActions.append(button(ctx, `读取${side === 'base' ? ' Base ' : '交付'}工件文本`, 'artifact.read', { taskId: task.taskId, manifestSha256: manifestSha256 ?? '', fileId: file.fileId, side, offsetBytes: '0' }, { reason: !manifestSha256 ? '缺少 manifest 身份。' : null, busy: ctx.state.pending.has(`artifact:${file.fileId}`) }));
  node.append(contentActions, kv([['Base SHA-256', file.base.sha256], ['Final SHA-256', file.final.sha256]]));
  node.append(actionWithReason(ctx, '打开当前文件（当前磁盘版本）', 'file.current.open', { taskId: task.taskId, manifestSha256: manifestSha256 ?? '', fileId: file.fileId }, ctx.state.snapshot?.connection.mode === 'mock' ? '演示模式没有真实的当前磁盘文件。' : !manifestSha256 || !file.relativePath ? '缺少受限的文件身份或可安全映射的相对路径。' : null, false, `artifact:${file.fileId}`));
  node.append(el('p', 'field-hint', '当前磁盘文件可能已被后续任务修改；历史交付仍以上方的不可变快照 Diff 为准。'));
  if (file.final.encoding === 'binary' || file.base.encoding === 'binary') node.append(el('p', 'field-hint', '二进制文件：仅显示类型、大小、摘要与存在性，不作为文本解码。'));
  node.append(messageFor(ctx, `artifact:${file.fileId}`) ?? ''); return node;
}
function renderEvents(ctx: RenderContext, task: UiTask): HTMLElement {
  const node = el('div', '', el('div', 'section-toolbar', el('h3', '', '持久脱敏事件'), button(ctx, '从头读取', 'events.read', { taskId: task.taskId, cursor: '0' }, { busy: ctx.state.pending.has(`task:${task.taskId}:events`) })), el('p', 'field-hint', '每页 20 条；是否还有更多由 nextCursor 决定。'));
  if (!ctx.state.eventsLoaded) node.append(empty('尚未读取事件', '仅按需加载持久事件，不显示 prompt 或原生会话全文。'));
  const list = el('ol', 'event-list');
  for (const event of ctx.state.events) list.append(el('li', '', el('div', 'event-marker', '·'), el('div', '', el('div', 'section-toolbar', el('strong', '', event.type ?? '事件'), el('span', 'muted', `rev ${event.revision ?? '—'}`)), el('p', 'field-hint', `${date(event.createdAtMs ?? event.createdAt)} · ${event.status ?? '—'}`), event.detail != null && code(typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail, null, 2), '脱敏事件详情'))));
  node.append(list);
  if (ctx.state.eventsLoaded && !ctx.state.events.length) node.append(el('p', 'muted', '当前页没有事件。'));
  if (ctx.state.eventsCursor !== null) node.append(button(ctx, '继续读取事件', 'events.read', { taskId: task.taskId, cursor: String(ctx.state.eventsCursor) }, { busy: ctx.state.pending.has(`task:${task.taskId}:events`) }));
  node.append(messageFor(ctx, `task:${task.taskId}:events`) ?? ''); return node;
}
function renderResources(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const node = el('div', 'resources-page', heading('ZCODE / 额度', '额度与资源', '查看账号额度与可用资源，必要时人工调整；Codex 使用同一连接目录。', button(ctx, '刷新资源', 'resources.refresh', {}, { busy: ctx.state.pending.has('resources.refresh') })));
  node.append(section('账号与额度', el('p', 'field-hint', `展开账号可读取额度快照；在线查询通过下方执行器发起。从 ${snapshot.connection.host} 导入 1–100 个 OAuth JSON 文件，同名账号可能覆盖已有记录。`), actionWithReason(ctx, '导入账号文件', 'accounts.import', {}, mutationReason(snapshot, 'importAccounts')), ctx.state.importSummary && notice(ctx.state.importSummary), !snapshot.resources.accounts.length && empty('尚无账号', '导入账号后，可为它启动执行器。已有历史任务仍可查看。'), ...snapshot.resources.accounts.map(account => renderAccount(ctx, snapshot, account.alias))));
  const workerId = input(ctx.state.workerId, 'workerId'); workerId.placeholder = '例如 wrk-01';
  const accountSelect = select(ctx.state.workerAccount, 'workerAccount', [['', '请选择账号'], ...snapshot.resources.accounts.map(account => [account.alias, `${account.alias} · ${account.provider} · ${resourceState(account.health)}`] as [string, string])]);
  const selectedAccount = snapshot.resources.accounts.find(account => account.alias === ctx.state.workerAccount);
  const startReason = mutationReason(snapshot, 'startWorker') ?? (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(ctx.state.workerId) ? '名称须为 1–64 个字母、数字、下划线或连字符。' : !selectedAccount ? '请选择账号。' : snapshot.resources.workers.some(worker => worker.accountAlias === selectedAccount.alias && worker.state !== 'stopped') ? '此账号已有未停止的执行器，请先检查其状态。' : ['blocked', 'invalid', 'cooling'].includes(selectedAccount.health) ? '此账号当前状态不允许启动。' : null);
  node.append(section('执行器', el('p', 'field-hint', '执行器使用绑定账号运行任务；每个账号同时使用一个执行器。'), el('div', 'worker-start-form', field('执行器名称', workerId), field('绑定账号', accountSelect), actionWithReason(ctx, '启动执行器', 'worker.start', {}, startReason, true)), messageFor(ctx, 'worker.start'), !snapshot.resources.workers.length && empty('尚无执行器', '填写名称并选择账号后启动。'), ...snapshot.resources.workers.map(worker => {
    const occupied = worker.leaseTaskIds.length > 0 || worker.runningTaskCount === undefined || worker.runningTaskCount !== 0;
    const stopReason = mutationReason(snapshot, 'stopWorker') ?? (!worker.processOwned ? '尚未确认此执行器属于当前连接目录。' : worker.state !== 'ready' ? '执行器尚未就绪，暂不能从这里停止。' : occupied ? '执行器仍在运行、状态未知或有任务占用，暂不能停止。' : null);
    const probeReason = mutationReason(snapshot, 'quotaProbe') ?? (worker.state !== 'ready' ? '执行器就绪后可查询额度。' : null);
    return el('article', 'resource-card', el('div', 'section-toolbar', el('h4', '', worker.workerId), badge(resourceState(worker.state), worker.state === 'ready' ? 'success' : 'attention')), kv([['绑定账号', worker.accountAlias], ['运行版本', worker.version], ['正在运行的操作数', worker.runningTaskCount === undefined ? '未知' : worker.runningTaskCount], ['占用任务', worker.leaseTaskIds.length ? worker.leaseTaskIds.join('、') : '无已知占用'], ['管理归属', worker.processOwned ? '属于当前连接目录' : '尚未确认']]), ...worker.leaseTaskIds.map(taskId => button(ctx, `查看占用任务 ${taskId}`, 'task.select', { taskId })), el('div', 'resource-actions', actionWithReason(ctx, '查询认证与额度', 'worker.probe', { workerId: worker.workerId }, probeReason, false, `worker:${worker.workerId}:probe`), actionWithReason(ctx, '停止空闲执行器', 'worker.stop', { workerId: worker.workerId }, stopReason, false, `worker:${worker.workerId}:stop`)), el('p', 'field-hint', '查询会连接官方服务，更新账号认证与额度。执行器就绪后仍可能被任务占用。'), messageFor(ctx, `worker:${worker.workerId}`));
  })));
  const baseRef = input(ctx.state.baseRef, 'baseRef');
  node.append(section('任务目录', el('p', 'field-hint', '从干净的 Git 仓库创建独立任务目录与新分支，供任务在其中修改和核验代码。'), el('div', 'workspace-create-form', field('起始分支或提交', baseRef, '如 HEAD、main 或提交 ID；点击按钮后选择源仓库。', ctx.state.validation.baseRef), actionWithReason(ctx, '选择仓库并创建任务目录', 'workspace.create', {}, mutationReason(snapshot, 'createWorkspace') ?? (!ctx.state.baseRef.trim() ? '请输入起始分支或提交。' : null), true)), messageFor(ctx, 'workspace.create'), !snapshot.resources.workspaces.length && empty('尚无任务目录', '从源仓库创建任务目录后，即可提交任务。'), ...snapshot.resources.workspaces.map(workspace => el('article', 'resource-card', el('div', 'section-toolbar', el('h4', '', workspace.workspaceId), badge(resourceState(workspace.state))), kv([['源仓库', workspace.repositoryPath], ['执行目录', workspace.worktreePath], ['分支', workspace.branch], ['起始提交', workspace.baseCommit], ['占用任务', workspace.activeTaskId ?? '无已知占用']]), workspace.activeTaskId && button(ctx, '查看关联任务', 'task.select', { taskId: workspace.activeTaskId })))));
  return node;
}
function renderAccount(ctx: RenderContext, snapshot: UiSnapshot, alias: string): HTMLElement {
  const account = snapshot.resources.accounts.find(item => item.alias === alias)!;
  const expanded = ctx.state.expandedAccounts.has(alias); const quota = snapshot.resources.quotas[alias] as UiQuota | undefined;
  const toggle = button(ctx, expanded ? '收起额度来源' : '展开额度来源', 'account.toggle', { alias }); toggle.setAttribute('aria-expanded', String(expanded)); toggle.setAttribute('aria-controls', `quota-${alias}`);
  const node = el('article', 'resource-card account-card', el('div', 'section-toolbar', el('div', '', el('h4', '', alias), el('span', 'muted', `${account.provider}${account.plan ? ` · ${account.plan}` : ''}`)), badge(resourceState(account.health), ['blocked', 'invalid', 'cooling'].includes(account.health) ? 'attention' : account.health === 'available' ? 'success' : '')), toggle);
  if (expanded) {
    const content = el('div', 'quota-detail'); content.id = `quota-${alias}`;
    content.append(button(ctx, '读取已有额度快照（无网络）', 'quota.read', { accountAlias: alias }, { busy: ctx.state.pending.has(`quota:${alias}`) }));
    if (!quota) content.append(el('p', 'muted', '尚未读取额度记录。账号健康与额度分别判断，不使用旧额度自动派发。'));
    else {
      content.append(el('div', 'quota-sources', renderQuota('在线查询快照', quota.live, quota.displayFreshnessWindowMs), renderQuota('导入快照', quota.imported, quota.displayFreshnessWindowMs)));
      content.append(el('p', quota.lastProbe.state === 'failed' ? 'field-error' : 'field-hint', `最近查询：${quota.lastProbe.state === 'never' ? '从未查询' : quota.lastProbe.state === 'failed' ? `失败 ${quota.lastProbe.errorCode ?? ''}；保留上次成功值` : '成功'}${quota.lastProbe.attemptedAtMs ? ` · ${date(quota.lastProbe.attemptedAtMs)}` : ''}`));
    }
    content.append(messageFor(ctx, `quota:${alias}`) ?? ''); node.append(content);
  }
  return node;
}
function renderQuota(title: string, quota: UiQuotaSnapshot | null, freshnessWindowMs: number): HTMLElement {
  const node = el('div', 'quota-source', el('h5', '', title));
  if (!quota) { node.append(el('p', 'muted', title.startsWith('在线') ? '未查询' : '没有导入额度快照')); return node; }
  const sourceTime = (time: UiQuotaSnapshot['generatedAt']): string => time ? time.atMs !== null ? date(time.atMs) : `${time.value}（单位 ${time.unit}，不推测日期）` : '未知';
  let freshness = quota.freshness;
  if (quota.source === 'live_probe' && quota.observedAtMs !== null) { const age = Date.now() - quota.observedAtMs; freshness = age < 0 ? 'unknown' : age > freshnessWindowMs ? 'stale' : quota.freshness; }
  node.append(el('div', 'quota-value', quota.remaining === null ? '余量未知' : String(quota.remaining), el('span', '', quota.unit === 'unknown' ? '单位未知' : quota.unit)), kv([['来源', quota.source === 'live_probe' ? '用户发起的在线查询' : '导入时快照'], ['总量 / 已用', `${quota.total === null ? '未知' : quota.total} / ${quota.used === null ? '未知' : quota.used}`], ['观测时间', date(quota.observedAtMs)], ['官方生成时间', sourceTime(quota.generatedAt)], ['官方服务器时间', sourceTime(quota.serverTime)], ['下次重置', sourceTime(quota.nextReset)], ['新鲜度', freshness === 'fresh' ? '近期观测（不保证云端余额）' : freshness === 'stale' ? '陈旧快照' : '未知']]));
  const percentage = quota.percentage;
  if (percentage && percentage.scale !== 'unknown') {
    const value = percentage.scale === '0_to_1' ? percentage.value * 100 : percentage.value;
    if (value >= 0 && value <= 100) { const meter = el('progress'); meter.max = 100; meter.value = value; meter.setAttribute('aria-label', `${title}百分比 ${value.toFixed(1)}%`); node.append(meter, el('span', 'field-hint', `原始百分比指标 ${value.toFixed(1)}%`)); }
  }
  return node;
}
function renderComposer(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const draft = ctx.state.draft ?? snapshot.draft;
  const workspace = snapshot.resources.workspaces.find(item => item.workspaceId === draft.workspaceId);
  const worker = snapshot.resources.workers.find(item => item.workerId === draft.workerId);
  const account = snapshot.resources.accounts.find(item => item.alias === worker?.accountAlias);
  const node = el('div', 'composer-page', heading('ZCODE / 高级操作', '手动派发任务', '直接指定任务目录与执行器。日常可在 Codex 中描述目标，由 Codex 调度。草稿在关闭或重载窗口后可能丢失。', button(ctx, '返回任务列表', 'page', { page: 'tasks' })));
  node.append(el('p', 'field-hint', '任务目录是代码修改的位置；执行器决定使用哪个账号。'));
  const form = el('form', 'composer-form'); form.noValidate = true; form.addEventListener('submit', event => { event.preventDefault(); ctx.action('dispatch'); });
  form.append(el('div', 'form-grid', field('任务目录', select(draft.workspaceId, 'draft.workspaceId', [['', '请选择任务目录'], ...snapshot.resources.workspaces.map(item => [item.workspaceId, `${item.workspaceId} · ${item.branch}${item.activeTaskId ? ' · 已占用' : ''}`] as [string, string])]), undefined, ctx.state.validation.workspaceId), field('执行器', select(draft.workerId, 'draft.workerId', [['', '请选择执行器'], ...snapshot.resources.workers.map(item => [item.workerId, `${item.workerId} · ${item.accountAlias} · ${resourceState(item.state)}`] as [string, string])]), undefined, ctx.state.validation.workerId)));
  if (workspace) form.append(kv([['源仓库', workspace.repositoryPath], ['执行目录', workspace.worktreePath], ['分支', workspace.branch], ['起始提交', workspace.baseCommit]]));
  if (worker) { form.append(kv([['绑定账号', `${worker.accountAlias} / ${account?.provider ?? '服务商未知'}`], ['账号状态', account ? resourceState(account.health) : '未知'], ['正在运行的操作数', worker.runningTaskCount === undefined ? '未知' : worker.runningTaskCount], ['占用任务', worker.leaseTaskIds.join('、') || '无已知占用']])); const unavailable = workerUnavailable(snapshot, worker.workerId); if (unavailable) form.append(notice(unavailable, 'warning')); }
  if (account?.health === 'unknown') form.append(notice('账号认证状态尚未确认，可在“资源”页查询认证与额度。', 'warning'));
  const prompt = el('textarea'); prompt.value = draft.prompt; prompt.rows = 9; prompt.maxLength = 100_001; prompt.dataset.field = 'draft.prompt'; prompt.dataset.focus = 'draft.prompt';
  form.append(field('要完成的工作', prompt, '描述目标、要求和验收方式。内容只发送给所选执行器的当前任务。', ctx.state.validation.prompt));
  const model = input(draft.modelId, 'draft.modelId'); const retries = input(String(draft.busyRetryLimit), 'draft.busyRetryLimit', 'number'); retries.min = '0'; retries.max = '10'; retries.step = '1';
  form.append(el('div', 'form-grid', field('模型 ID', model, '后台会检查模型是否可用。', ctx.state.validation.modelId), field('运行模式', select(draft.mode, 'draft.mode', ['build', 'edit', 'plan', 'yolo', 'guarded'].map(mode => [mode, mode])), '由已安装的运行环境决定具体行为。'), field('会话', select(draft.session, 'draft.session', [['continue', '继续最近可复用会话'], ['new', '新会话']]), '仅复用同任务目录、同执行器且已停止的会话；没有则新建。'), field('模型繁忙时续跑次数', retries, '默认 3 次；0 关闭，最多 10 次。使用原会话发送“继续”。', ctx.state.validation.busyRetryLimit)));
  const commands = section('核验命令', el('p', 'field-hint', '任务执行结束后运行这些命令检查结果，最多 10 项。'));
  for (const [index, command] of draft.verifyCommands.entries()) {
    const executable = input(command.command, `verify.${index}.command`); const args = input(ctx.state.rawFields.get(`verify.${index}.args`) ?? JSON.stringify(command.args), `verify.${index}.args`); const timeout = input(String(command.timeoutMs), `verify.${index}.timeoutMs`, 'number'); timeout.min = '100'; timeout.max = '300000';
    commands.append(el('div', 'verification-command', el('h4', '', `命令 ${index + 1}`), field('命令名称', executable, undefined, ctx.state.validation[`verify.${index}.command`]), field('参数（JSON 字符串数组）', args, '如 ["--test","test/example.test.ts"]；不经过 shell。', ctx.state.validation[`verify.${index}.args`]), field('超时（毫秒）', timeout, undefined, ctx.state.validation[`verify.${index}.timeoutMs`]), button(ctx, '移除此命令', 'verify.remove', { index: String(index) })));
  }
  if (!draft.verifyCommands.length) commands.append(code('git diff --check', '未配置命令时使用此默认核验'));
  commands.append(button(ctx, '添加核验命令', 'verify.add', {}, { reason: draft.verifyCommands.length >= 10 ? '已达 10 项上限。' : null })); form.append(commands);
  const reason = mutationReason(snapshot, 'dispatchTask') ?? (ctx.state.submittedDraftToken === draft.submitToken ? '此草稿已提交，保留原请求身份。请检查回执或查询原请求；建立独立任务请返回列表使用“高级操作”。' : null);
  form.append(actionWithReason(ctx, '提交任务', 'dispatch', {}, reason, true), messageFor(ctx, 'dispatch') ?? '', el('p', 'field-hint', '提交后可在任务列表查看进度。若结果待确认，请通过回执查询原请求。'));
  node.append(form); return node;
}
function renderSettings(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const connection = snapshot.connection; const interval = input(ctx.state.settingsInterval, 'settingsInterval', 'number'); interval.min = '15'; interval.max = '300';
  const valid = Number.isInteger(Number(ctx.state.settingsInterval)) && Number(ctx.state.settingsInterval) >= 15 && Number(ctx.state.settingsInterval) <= 300;
  const concurrency = input(ctx.state.settingsConcurrency, 'settingsConcurrency', 'number'); concurrency.min = '0'; concurrency.max = '64'; concurrency.step = '1'; concurrency.placeholder = '不限制';
  concurrency.disabled = ctx.state.pending.has('pool.policy.set');
  const rawConcurrency = ctx.state.settingsConcurrency.trim(); const numericConcurrency = Number(rawConcurrency);
  const validConcurrency = rawConcurrency === '' || (Number.isInteger(numericConcurrency) && numericConcurrency >= 0 && numericConcurrency <= 64);
  const policy = snapshot.poolPolicy;
  const policyReason = mutationReason(snapshot, 'poolPolicy') ?? (!policy ? '并发设置尚未读取，请刷新连接。' : !validConcurrency ? '请输入 0–64 的整数，或留空不限制。' : null);
  const diagnostic = { host: connection.host, pool: connection.poolHome, mode: connection.mode, state: connection.state, storeId: connection.storeId, instanceId: connection.instanceId, daemonVersion: connection.daemonVersion, error: connection.error?.code, taskId: snapshot.selectedTaskId, revision: snapshot.detail?.revision };
  const diagnostics = el('details', 'settings-diagnostics', el('summary', '', '高级：诊断信息'), el('p', 'field-hint', '复制内容包括连接身份、状态、版本与错误码，以及当前任务 ID。审批正文、提示词和凭据不会附在诊断中。'), code(JSON.stringify(diagnostic, null, 2), '待复制的脱敏诊断预览'), button(ctx, '复制脱敏诊断', 'diagnostics.copy'), messageFor(ctx, 'diagnostics.copy'));
  diagnostics.dataset.details = 'settings-diagnostics';
  return el('div', 'settings-page', heading('ZCODE / 设置', '设置', 'Codex 与工作台共享连接目录和并发上限。'),
    section('连接 Codex', el('p', 'field-hint', '生成当前连接目录的 MCP 配置，在 Codex 中启用后重新连接 Codex。配置生成不代表 Codex 已连接。'), codexSetup(ctx, snapshot, true), messageFor(ctx, 'connection.codexSetup')),
    section('并发任务', policy && kv([['当前上限', policy.maxConcurrentTasks === null ? '不限制' : policy.maxConcurrentTasks === 0 ? '0 · 暂停新派发' : policy.maxConcurrentTasks], ['占用槽位', policy.occupiedSlots], ['可用槽位', policy.availableSlots === null ? '不限制' : policy.availableSlots]]),
      field('并发任务上限', concurrency, '0–64；留空不限制。设为 0 暂停新派发，降低上限不会停止已有任务。', ctx.state.validation.settingsConcurrency),
      actionWithReason(ctx, '保存并发上限', 'pool.policy.set', {}, policyReason, true), messageFor(ctx, 'pool.policy.set')),
    section('后台连接', kv([['运行环境', connection.host], ['连接目录', connection.poolHome], ['连接模式', connection.mode === 'mock' ? '演示（模拟数据）' : '后台服务'], ['工作区信任', connection.trusted ? '已信任' : '受限模式']]), el('div', 'inline-actions', button(ctx, '选择连接目录', 'connection.configure', {}, { busy: ctx.state.pending.has('connection.configure') }), button(ctx, '更多 VS Code 设置', 'settings.open'), button(ctx, '连接帮助', 'guidance.open', { topic: 'connection' })), el('p', 'field-hint', '切换目录后面板需重新连接；Codex 后续调用使用新目录，原目录任务保留。切换远程计算环境请使用 VS Code Remote 窗口。'), messageFor(ctx, 'connection.configure')),
    section('自动刷新', field('刷新间隔（秒）', interval, '默认 30 秒，范围 15–300 秒；工作台可见时自动发现新任务。', ctx.state.validation.settingsInterval), actionWithReason(ctx, '保存刷新间隔', 'settings.save', {}, valid ? null : '请输入 15–300 的整数。', true), messageFor(ctx, 'settings.save')), diagnostics);
}
