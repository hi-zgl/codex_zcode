/* Local interaction prototype. No fetch, sockets, storage, commands, or external dependencies. */
(() => {
  'use strict';

  const icons = {
    tasks: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    diff: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m13 5h3a2 2 0 0 0 2-2v-3M7 12h10m-5-5v10"/>',
    accounts: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 17.5h.01M17 7.5h1M17 17.5h1"/>',
    reset: '<path d="M3 10a9 9 0 1 1 2.5 8.2M3 4v6h6"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back: '<path d="M19 12H5m6 6-6-6 6-6"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    expand: '<path d="M14 3h7v7M10 21H3v-7M21 3l-7 7M3 21l7-7"/>',
    shield: '<path d="m12 3 8 3v6c0 4-5 7-8 9-3-2-8-5-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',
    approval: '<path d="m12 3 8 3v6c0 4-5 7-8 9-3-2-8-5-8-9V6l8-3Z"/><path d="M12 8v5m0 3h.01"/>',
    command: '<path d="m4 6 6 6-6 6m9 0h7"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
    connection: '<path d="M7 12a5 5 0 0 1 8.5-3.5m1.5 3.5a5 5 0 0 1-8.5 3.5M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2"/><path d="M15 4v5h5M9 20v-5H4"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    alert: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
    review: '<path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5M15 3h6v6M21 3l-9 9"/>',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
  const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initialTasks = [
    { id: 'T-1042', title: '补齐审批记录的幂等校验', status: 'waiting_approval', worker: 'wrk-01', account: '日常开发', workspace: 'approval-guard', time: '16:44', retry: 0, max: 3, approval: 'pending', description: 'Worker 已准备运行测试，等待本次命令的执行许可。', events: [
      { time: '16:40', title: '任务派发已确认', description: '已绑定原会话与独立工作区。' },
      { time: '16:43', title: '修改已写入工作区', description: '审批记录与对应测试已更新。' },
      { time: '16:44', title: '等待本次操作审批', description: '请求运行工作区内的测试命令。', type: 'amber' },
    ] },
    { id: 'T-1041', title: '修复订阅恢复后的事件游标', status: 'running', worker: 'wrk-02', account: '协作验证', workspace: 'event-cursor', time: '16:43', retry: 1, max: 3, description: '已因明确的模型繁忙在原会话续跑，当前回合正在执行。', events: [
      { time: '16:38', title: '任务派发已确认', description: '当前任务、账号和 Worker 绑定保持一致。' },
      { time: '16:42', title: '当前回合因模型繁忙终止', description: '已确认 model_busy 归属于本次原生回合。', type: 'amber' },
      { time: '16:42', title: '已确认无活动执行', description: '原会话及执行绑定核对通过。' },
      { time: '16:42', title: '立即在原会话发送“继续”', description: '续跑次数已持久化：1 / 3；沿用原账号与模型。' },
      { time: '16:43', title: '正在执行', description: '等待当前原生回合结束。', type: 'active' },
    ] },
    { id: 'T-1040', title: '为 Worker 租约增加冲突检查', status: 'succeeded', worker: 'wrk-04', account: '回归测试', workspace: 'worker-lease', time: '16:39', retry: 0, max: 3, reviewed: false, description: '原生回合已结束。差异快照与核验结果已就绪，等待主会话审阅。', events: [
      { time: '16:31', title: '任务派发已确认', description: '在独立 worktree 中执行。' },
      { time: '16:37', title: '原生回合已结束', description: '开始收集完整变更范围。' },
      { time: '16:39', title: '本地核验已通过', description: '测试与类型检查退出码均为 0。' },
      { time: '16:39', title: '等待主会话审阅', description: '差异与核验结果均为固定快照。', type: 'amber' },
    ] },
    { id: 'T-1039', title: '恢复中断任务的执行状态', status: 'interrupted', worker: 'wrk-03', account: '专项任务', workspace: 'recovery-state', time: '16:36', retry: 0, max: 3, reconciliation: 'unknown', description: '连接中断后无法确认原执行状态。Worker 与工作区仍保留占用。', events: [
      { time: '16:28', title: '任务派发已确认', description: '原始请求已经被接收。' },
      { time: '16:35', title: '原生连接中断', description: '保留任务与原命令的身份信息。', type: 'amber' },
      { time: '16:36', title: '执行状态仍未知', description: '占用未释放；恢复连接后先做只读对账。', type: 'amber' },
    ] },
    { id: 'T-1038', title: '压缩 overview 的返回字段', status: 'succeeded', worker: 'wrk-04', account: '回归测试', workspace: 'compact-overview', time: '16:20', retry: 0, max: 3, reviewed: true, description: '已审阅示例交付与核验结果，任务已完成。', events: [
      { time: '16:12', title: '任务派发已确认', description: '结果输出遵循精简字段约定。' },
      { time: '16:19', title: '本地核验已通过', description: '测试通过，输出体积符合约定。' },
      { time: '16:20', title: '主会话已审阅', description: '完成记录已归档。', type: 'active' },
    ] },
  ];
  const accounts = [
    { id: 'acct-01', alias: '日常开发', worker: 'wrk-01', health: '可用', quota: 78, task: 'T-1042', binding: 'session-a7c2' },
    { id: 'acct-02', alias: '协作验证', worker: 'wrk-02', health: '可用', quota: 43, task: 'T-1041', binding: 'session-b4e1' },
    { id: 'acct-03', alias: '专项任务', worker: 'wrk-03', health: '待确认', quota: null, task: 'T-1039', binding: 'session-c9d3' },
    { id: 'acct-04', alias: '回归测试', worker: 'wrk-04', health: '可用', quota: 91, task: 'T-1040', binding: 'session-d2f8' },
  ];
  const diffs = [
    { path: 'src/scheduler/lease.ts', name: 'lease.ts', parent: 'src/scheduler', added: 14, removed: 3, lines: [
      ['hunk', '', '', '@@ -42,7 +42,18 @@ acquireWorkerLease'],
      ['context', '42', '42', 'const lease = store.getWorkerLease(workerId);'],
      ['remove', '43', '', 'if (lease?.taskId) return lease;'],
      ['add', '', '43', 'if (lease && lease.taskId !== taskId) {'],
      ['add', '', '44', '  throw new WorkerOccupiedError(workerId);'],
      ['add', '', '45', '}'],
      ['context', '44', '46', ''],
      ['remove', '45', '', 'store.saveLease({ workerId, taskId });'],
      ['add', '', '47', 'return store.transaction(() => {'],
      ['add', '', '48', '  assertWorkspaceAvailable(workspaceId, taskId);'],
      ['add', '', '49', '  return store.saveLease({'],
      ['add', '', '50', '    workerId, workspaceId, taskId,'],
      ['add', '', '51', '    state: "occupied",'],
      ['add', '', '52', '  });'],
      ['add', '', '53', '});'],
      ['context', '46', '54', ''],
      ['context', '47', '55', '// Unknown execution retains its lease.'],
    ] },
    { path: 'test/scheduler/lease.test.ts', name: 'lease.test.ts', parent: 'test/scheduler', added: 10, removed: 0, lines: [
      ['hunk', '', '', '@@ -78,3 +78,13 @@ worker lease'],
      ['context', '78', '78', 'describe("worker lease", () => {'],
      ['add', '', '79', '  it("retains an unknown execution lease", () => {'],
      ['add', '', '80', '    const lease = occupiedLease("interrupted");'],
      ['add', '', '81', '    expect(() => acquire(lease.workerId))'],
      ['add', '', '82', '      .toThrow(WorkerOccupiedError);'],
      ['add', '', '83', '  });'],
      ['add', '', '84', ''],
      ['add', '', '85', '  it("accepts an idempotent owner", () => {'],
      ['add', '', '86', '    expect(acquireForSameTask()).toEqual(lease);'],
      ['add', '', '87', '  });'],
      ['context', '79', '88', '});'],
    ] },
  ];
  const archivedDiffs = [
    { path: 'src/mcp/overview.ts', name: 'overview.ts', parent: 'src/mcp', lines: [
      ['hunk', '', '', '@@ -25,4 +25,8 @@ serializeTask'],
      ['context', '25', '25', 'return {'],
      ['context', '26', '26', '  task_id: task.id,'],
      ['context', '27', '27', '  status: task.status,'],
      ['remove', '28', '', '  history: task.history,'],
      ['add', '', '28', '  retry: {'],
      ['add', '', '29', '    used: task.retry.used,'],
      ['add', '', '30', '    max: task.retry.max,'],
      ['add', '', '31', '    reason: "model_busy",'],
      ['add', '', '32', '  },'],
      ['context', '29', '33', '};'],
    ] },
    { path: 'test/mcp/overview.test.ts', name: 'overview.test.ts', parent: 'test/mcp', lines: [
      ['hunk', '', '', '@@ -60,2 +60,7 @@ compact task output'],
      ['context', '60', '60', 'it("keeps the task output compact", () => {'],
      ['add', '', '61', '  const output = serializeTask(task);'],
      ['add', '', '62', '  expect(output).not.toHaveProperty("history");'],
      ['add', '', '63', '  expect(output.retry.used).toBe(1);'],
      ['add', '', '64', '  expect(output.retry.max).toBe(3);'],
      ['context', '61', '65', '});'],
    ] },
  ];
  for (const file of [...diffs, ...archivedDiffs]) {
    file.added = file.lines.filter(([type]) => type === 'add').length;
    file.removed = file.lines.filter(([type]) => type === 'remove').length;
  }
  const artifactFor = (task) => {
    const files = task.id === 'T-1038' ? archivedDiffs : diffs;
    return { files, added: files.reduce((sum, file) => sum + file.added, 0), removed: files.reduce((sum, file) => sum + file.removed, 0), time: task.id === 'T-1038' ? '16:19' : '16:39', test: task.id === 'T-1038' ? 'overview' : 'lease' };
  };

  let tasks = structuredClone(initialTasks);
  let state = { mode: 'workbench', page: 'tasks', filter: 'pending', selected: 'T-1042', tab: 'overview', detailOpen: false, file: 0, expandedAccount: null, quotaTime: '2026-11-01 16:40', connection: 'disconnected', sidebarFilter: 'pending', reviewAcknowledged: false };
  let modal = null;
  let focusBeforeModal = null;
  let toastTimer = null;
  const app = document.getElementById('app');
  const modalRoot = document.getElementById('modal-root');
  const pending = (task) => ['waiting_approval', 'verifying', 'interrupted', 'blocked', 'failed'].includes(task.status) || (task.status === 'succeeded' && task.reviewed === false);
  const findTask = (id = state.selected) => tasks.find((task) => task.id === id);
  const counts = () => ({ pending: tasks.filter(pending).length, running: tasks.filter((task) => task.status === 'running').length, all: tasks.length });
  const statusInfo = (task) => task.status === 'succeeded' && task.reviewed === false ? ['待审阅', 'blue'] : task.status === 'interrupted' && task.reconciliation === 'active' ? ['待恢复跟踪', 'amber'] : ({ waiting_approval: ['等待审批', 'amber'], running: ['执行中', 'green'], verifying: ['核验中', 'blue'], interrupted: ['状态未知', 'amber'], succeeded: ['已完成', 'green'], blocked: ['已阻塞', 'amber'], failed: ['失败 · 繁忙上限', 'amber'] }[task.status] || ['待处理', '']);
  const badge = (task) => { const [label, color] = statusInfo(task); return `<span class="badge ${color}">${label}</span>`; };
  const now = () => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const filteredTasks = (filter) => tasks.filter((task) => filter === 'all' || (filter === 'pending' ? pending(task) : task.status === 'running'));

  function topbar() {
    return `<header class="app-topbar">
      <div class="app-brand"><span class="brand-glyph" aria-hidden="true"></span><strong>ZCODE POOL</strong><span class="brand-slash">/</span><span class="brand-label">管理台</span></div>
      <div class="topbar-actions">
        <div class="segmented" role="group" aria-label="原型视图">
          <button data-action="mode" data-mode="workbench" aria-pressed="${state.mode === 'workbench'}">工作台</button>
          <button data-action="mode" data-mode="sidebar" aria-pressed="${state.mode === 'sidebar'}">侧栏预览</button>
        </div>
        <button class="icon-btn" data-action="reset" title="重置全部演示状态" aria-label="重置全部演示状态">${icon('reset')}</button>
      </div>
    </header>`;
  }

  function nav() {
    const c = counts();
    const items = [ ['tasks', '任务工作台', 'tasks', c.pending], ['review', '差异与核验', 'diff', findTask('T-1040').reviewed ? '' : '1'], ['accounts', '账号与实例', 'accounts', '4'] ];
    return `<nav class="main-nav" aria-label="管理台导航"><p class="nav-caption">CONTROL ROOM</p>${items.map(([page, label, glyph, count]) => `<button class="nav-button" data-action="page" data-page="${page}" ${state.page === page ? 'aria-current="page"' : ''} title="${label}" aria-label="${label}${count ? `，${count} 项` : ''}">${icon(glyph)}<span class="nav-label">${label}</span>${count ? `<span class="nav-count">${count}</span>` : ''}</button>`).join('')}
      <div class="nav-spacer"></div>
      <div class="connection-card"><div class="connection-status"><span class="status-dot ${state.connection === 'recovered' ? 'green' : ''}"></span>${state.connection === 'recovered' ? '演示连接已恢复' : 'daemon 未连接'}</div><p>${state.connection === 'recovered' ? '本地模拟完成。<br>未建立真实服务连接。' : 'daemon 独立运行<br>恢复后先核对原执行状态'}</p><button class="text-btn" data-action="connect">${icon('connection')}${state.connection === 'recovered' ? '查看恢复演示' : '演示连接恢复'}</button></div>
      <div class="nav-footer">ACCOUNT ↔ WORKER<br>一对一绑定</div></nav>`;
  }

  function pageHeader(eyebrow, title, description, extra = '') {
    return `<div class="page-header"><div><div class="eyebrow">${eyebrow}</div><h1 id="page-title" tabindex="-1">${title}</h1><p>${description}</p></div>${extra || `<div class="session-badge">${icon('shield')}<div><strong>Codex 主会话管理</strong><span>DISPATCH · REVIEW · INTEGRATE</span></div></div>`}</div>`;
  }

  function taskCard(task) {
    return `<button class="task-card" data-action="select-task" data-task="${task.id}" aria-pressed="${task.id === state.selected}" aria-label="${escape(task.id + ' ' + task.title + '，' + statusInfo(task)[0])}"><div class="task-card-top"><span class="task-id">${task.id}</span>${badge(task)}</div><h3>${escape(task.title)}</h3><div class="task-card-bottom"><span>${task.worker} <span style="color:#58665c">/</span> ${escape(task.workspace)}</span>${task.retry ? `<span class="busy-mini">续跑 ${task.retry}/${task.max}</span>` : `<span>${task.time}</span>`}</div></button>`;
  }

  function filterButtons(sidebar = false) {
    const c = counts();
    const current = sidebar ? state.sidebarFilter : state.filter;
    const filters = sidebar ? [['pending', '待处理', c.pending], ['running', '运行中', c.running], ['accounts', '实例', 4]] : [['pending', '待处理', c.pending], ['all', '全部', c.all], ['running', '运行中', c.running]];
    return filters.map(([filter, label, count]) => `<button class="filter" data-action="${sidebar ? 'sidebar-filter' : 'filter'}" data-filter="${filter}" aria-pressed="${current === filter}">${label}<span>${count}</span></button>`).join('');
  }

  function taskPage() {
    const c = counts();
    const list = filteredTasks(state.filter);
    const task = findTask();
    return `${pageHeader('WORKSPACE / OVERVIEW', '任务工作台', '关注需要决定的事，查看每一次状态变化。')}
      <div class="overview-strip" aria-label="任务概况">
        <button class="metric" data-action="filter" data-filter="pending"><span class="metric-value amber">${String(c.pending).padStart(2, '0')}</span><div><div class="metric-label">待你处理</div><div class="metric-detail">审批、核验与状态确认</div></div></button>
        <button class="metric" data-action="filter" data-filter="running"><span class="metric-value green">${String(c.running).padStart(2, '0')}</span><div><div class="metric-label">正在执行</div><div class="metric-detail">按状态跟踪原生回合</div></div></button>
        <button class="metric" data-action="page" data-page="accounts"><span class="metric-value">04</span><div><div class="metric-label">绑定实例</div><div class="metric-detail">${findTask('T-1039').status === 'interrupted' ? '1 个执行状态待确认' : '每个账号独立绑定'}</div></div></button>
      </div>
      <div class="task-workspace ${state.detailOpen ? 'detail-open' : ''}">
        <section class="task-list-panel" aria-labelledby="task-list-title"><div class="panel-title"><h2 id="task-list-title">任务队列</h2><span>按处理优先级排序</span></div><div class="filter-bar" role="group" aria-label="筛选任务">${filterButtons()}</div><div class="task-list">${list.length ? list.map(taskCard).join('') : `<div class="empty-state">${icon('check')}<h3>当前没有${state.filter === 'pending' ? '待处理' : '运行中'}任务</h3><p>可切换到“全部”查看其他示例任务。</p><button class="button subtle" data-action="filter" data-filter="all">查看全部</button></div>`}</div><p class="task-list-foot">示例快照 · 2026-11-01 16:44<br>任务进度以状态与事件表示。</p></section>
        <div class="detail-container"><button class="mobile-back" data-action="back">${icon('back')}返回任务队列</button>${taskDetail(task)}</div>
      </div>`;
  }

  function taskDetail(task) {
    return `<section class="task-detail" aria-label="任务详情"><header class="detail-header"><div class="detail-topline"><span class="task-id">${task.id} <span style="color:#536057">/</span> TASK DETAIL</span>${badge(task)}</div><h2 class="detail-title" id="task-detail-title" tabindex="-1">${escape(task.title)}</h2><p class="detail-description">${escape(task.description)}</p><dl class="task-meta"><div class="meta-item"><dt>账号 / Worker</dt><dd>${escape(task.account)} · ${task.worker}</dd></div><div class="meta-item"><dt>续跑次数 used / max</dt><dd>${task.retry} / ${task.max}${task.retry ? ' · model_busy' : ''}</dd></div><div class="meta-item"><dt>独立工作区</dt><dd>${escape(task.workspace)}</dd></div></dl></header>
      <div class="detail-tabs" role="tablist" aria-label="任务详情页签">${[['overview', '概览'], ['changes', '差异与核验'], ['events', '状态事件']].map(([tab, label]) => `<button class="detail-tab" id="tab-${tab}" role="tab" aria-selected="${state.tab === tab}" aria-controls="task-tab-panel" data-action="tab" data-tab="${tab}">${label}</button>`).join('')}</div>
      <div class="detail-body" id="task-tab-panel" role="tabpanel" aria-labelledby="tab-${state.tab}">${state.tab === 'events' ? `<div class="section-label">${icon('clock')}状态事件摘要<span class="mono">${task.events.length} EVENTS</span></div>${timeline(task.events)}` : state.tab === 'changes' ? taskChanges(task) : overview(task)}</div></section>`;
  }

  function timeline(events) {
    return `<ol class="timeline">${events.map((event) => `<li class="${event.type || ''}"><time>${escape(event.time)}</time><span class="timeline-mark" aria-hidden="true"></span><div><div class="timeline-title">${escape(event.title)}</div><div class="timeline-description">${escape(event.description)}</div></div></li>`).join('')}</ol>`;
  }

  function approvalPanel(task) {
    return `<div class="section-label">${icon('approval')}需要本次执行许可<span class="mono">APP-081</span></div><section class="approval-block"><div class="approval-heading">${icon('command')}运行工作区测试<span class="mono">SHELL</span></div><div class="approval-operation"><div class="operation-label">操作预览 · 不会在原型中执行</div><pre class="command">npm test -- approval-idempotency</pre><div class="operation-details"><div><span>工作目录</span><strong class="mono">.worktrees/approval-guard</strong></div><div><span>请求范围</span><strong>仅批准这一次操作</strong></div></div></div><div class="approval-actions"><span>决定将记录来源与时间</span><div class="button-row"><button class="button" data-action="approval" data-decision="reject" data-task="${task.id}">拒绝</button><button class="button primary" data-action="approval" data-decision="approve" data-task="${task.id}">${icon('check')}只批准本次</button></div></div></section><p class="demo-footnote">演示中的批准与拒绝只更新本页状态，命令不会执行。</p>`;
  }

  function overview(task) {
    const artifact = artifactFor(task);
    if (task.status === 'waiting_approval') return `${approvalPanel(task)}<h3 class="block-heading">最近状态</h3>${timeline(task.events.slice(-2))}`;
    if (task.id === 'T-1041') return `<div class="retry-banner"><div><strong>${task.status === 'failed' ? '自动续跑次数已用完' : '模型繁忙后，原会话立即继续'}</strong><p>${task.status === 'failed' ? '任务已停止自动续跑，等待主会话决定。' : '确认失败回合终止、无活动执行后提交。'}</p></div><div class="retry-counter">${task.retry}<small> / ${task.max}</small></div></div><div class="section-label">${icon('clock')}繁忙续跑时间线<span class="mono">model_busy</span></div>${timeline(task.events)}<div class="detail-footer"><p class="inline-note">${task.status === 'failed' ? '上限耗尽后不会继续循环。' : '沿用当前账号、模型与会话；次数不会因重启清零。'}</p><button class="button subtle" data-action="busy" ${task.status === 'failed' ? 'disabled title="已达续跑上限，请重置演示后体验"' : ''}>${icon('reset')}${task.status === 'failed' ? '已达续跑上限' : '演示一次繁忙'}</button></div>`;
    if (task.status === 'interrupted') return `<div class="unknown-panel"><h3>${icon('alert')}${task.reconciliation === 'active' ? '已发现原执行，可恢复跟踪' : '原执行状态未知，保留占用'}</h3><p>${task.reconciliation === 'active' ? '只读对账已找到原会话中的活动执行。任务仍保留 interrupted，点击恢复跟踪后才重新附着原执行。' : '当前无法证明原任务已经停止。先恢复连接并核对原会话，避免重复派发或重复执行。'}</p><div class="lock-row"><span>${icon('lock')}${task.worker} 占用保留</span><span>${icon('lock')}${escape(task.workspace)} 占用保留</span></div>${task.reconciliation === 'active' ? `<button class="button primary" data-action="attach-task" data-task="${task.id}">${icon('connection')}恢复跟踪（演示）</button>` : `<button class="button" data-action="reconcile" data-task="${task.id}">${icon('connection')}演示只读对账</button>`}</div><h3 class="block-heading">恢复记录</h3>${timeline(task.events)}`;
    if (task.id === 'T-1040' || task.status === 'succeeded') return `<div class="result-summary"><h3>${icon('check')}${task.reviewed ? '示例交付已审阅' : '差异与核验已就绪'}</h3><p>${task.reviewed ? '示例审阅记录已保存到当前页面。' : '已固定交付差异与核验输出，等待主会话审阅后决定后续集成。'}</p></div><div class="result-facts"><div class="result-fact"><strong>02</strong><span>变更文件</span></div><div class="result-fact"><strong>+${artifact.added} <span>−${artifact.removed}</span></strong><span>差异行数</span></div><div class="result-fact"><strong>2 / 2</strong><span>核验通过 · 示例</span></div></div><button class="button primary" data-action="open-review" data-task="${task.id}">${icon('diff')}查看差异与核验</button><h3 class="block-heading">交付记录</h3>${timeline(task.events.slice(-2))}`;
    return `<div class="result-summary"><h3>${icon('check')}${task.approval === 'rejected' ? '本次操作已拒绝' : task.reconciliation === 'attached' ? '已重新附着原执行' : '本次操作已批准'}</h3><p>${task.approval === 'rejected' ? '演示反馈已记录。Worker 可据此调整后续操作。' : task.reconciliation === 'attached' ? '已显式恢复原会话中的活动执行，继续跟踪原任务。' : '演示反馈已记录，任务回到执行状态。'}</p></div><h3 class="block-heading">最近状态</h3>${timeline(task.events.slice(-3))}`;
  }

  function taskChanges(task) {
    const artifact = artifactFor(task);
    if (!['T-1040', 'T-1038'].includes(task.id)) return `<div class="empty-state">${icon('file')}<h3>尚未生成交付快照</h3><p>回合结束后固定差异范围，再收集核验结果。目前请继续查看任务状态。</p><button class="button subtle" data-action="open-review" data-task="T-1040">查看已就绪示例 ${icon('arrow')}</button></div>`;
    return `<div class="result-summary"><h3>${icon('check')}2 项核验通过 · 示例结果</h3><p>快照包含未暂存、已暂存、未跟踪文件及任务内提交的完整变更范围。</p></div><div class="result-facts"><div class="result-fact"><strong>02</strong><span>变更文件</span></div><div class="result-fact"><strong>+${artifact.added} <span>−${artifact.removed}</span></strong><span>差异行数</span></div><div class="result-fact"><strong>0</strong><span>核验退出码</span></div></div><button class="button primary" data-action="open-review" data-task="${task.id}">${icon('expand')}展开差异与核验</button>`;
  }

  function reviewPage() {
    const task = ['T-1040', 'T-1038'].includes(state.selected) ? findTask() : findTask('T-1040');
    const artifact = artifactFor(task);
    const file = artifact.files[state.file] || artifact.files[0];
    return `${pageHeader('ARTIFACTS / REVIEW', '差异与核验', '以固定差异与实际核验结果审查交付。')}
      <div class="review-heading"><div><h2>${escape(task.title)}</h2><p><span class="mono">${task.id} · ${task.worker} · ${escape(task.workspace)}</span></p></div><select id="review-task-select" class="select-field" aria-label="选择核验任务"><option value="T-1040" ${task.id === 'T-1040' ? 'selected' : ''}>T-1040 · 租约冲突检查</option><option value="T-1038" ${task.id === 'T-1038' ? 'selected' : ''}>T-1038 · 精简输出（已完成）</option></select></div>
      <div class="snapshot-bar"><span>${icon('lock')} 固定交付快照 <span class="mono">snap-${task.id.slice(2)}-a81f</span></span><span class="mono">示例 · 2026-11-01 ${artifact.time}</span></div>
      <section class="diff-layout" aria-label="示例代码差异"><div class="diff-files" aria-label="变更文件">${artifact.files.map((item, i) => `<button class="diff-file" data-action="file" data-file="${i}" aria-pressed="${i === state.file}">${icon('file')}<span>${escape(item.name)}<small class="mono">${escape(item.parent)}</small></span></button>`).join('')}</div><div class="diff-main"><div class="diff-title"><span>${escape(file.path)}</span><span class="diff-stats">+${file.added}<i>−${file.removed}</i></span></div><div class="diff-code" tabindex="0" aria-label="${escape(file.path)} 的示例差异，可横向滚动">${file.lines.map(([type, oldLine, newLine, code]) => `<div class="code-line ${type}"><span>${oldLine}</span><span>${newLine}</span><span class="sign">${type === 'add' ? '+' : type === 'remove' ? '−' : ''}</span><code>${escape(code)}</code></div>`).join('')}</div></div></section>
      <section class="checks-panel" aria-labelledby="checks-title"><div class="checks-header"><h3 id="checks-title">核验结果 <span class="badge green" style="margin-left:8px">全部通过</span></h3><span>以下命令与输出为示例，原型不会执行</span></div><div class="check-row"><span class="check-icon">${icon('check')}</span><div class="check-row-main"><code>npm test -- ${artifact.test}</code><p>38 个测试通过 · 示例耗时 1.8s · 16:39:12</p></div><span class="check-exit">EXIT 0</span></div><div class="check-row"><span class="check-icon">${icon('check')}</span><div class="check-row-main"><code>npm run typecheck</code><p>类型检查通过 · 示例耗时 2.1s · 16:39:15</p></div><span class="check-exit">EXIT 0</span></div></section>
      ${task.reviewed ? `<div class="reviewed-note">${icon('check')}该任务的示例交付已审阅。</div>` : `<div class="review-actions"><label class="checkbox-label"><input id="review-acknowledged" type="checkbox" ${state.reviewAcknowledged ? 'checked' : ''}>我已审阅示例差异与核验输出</label><button class="button primary" data-action="review-complete" data-task="${task.id}" ${state.reviewAcknowledged ? '' : 'disabled title="先勾选已审阅示例差异与核验输出"'}>${icon('check')}标记已审阅</button></div>`}
      <p class="demo-footnote">审阅标记只更新本页演示记录。后续集成由 Codex 主会话决定。</p>`;
  }

  function workerStatus(account) {
    const task = findTask(account.task);
    if (account.worker === 'wrk-04') return { text: '空闲', color: 'green', caption: task.reviewed ? '最近交付已审阅' : '交付待主会话审阅' };
    const [text, color] = statusInfo(task);
    return { text, color, caption: `${task.id} · ${task.status === 'interrupted' ? '占用保留' : '原会话绑定'}` };
  }

  function accountPage() {
    return `${pageHeader('ACCOUNTS / WORKERS', '账号与实例', '每个账号绑定一个 Worker，独立跟踪可用性与额度。')}
      <div class="account-summary"><div><strong>4 个绑定</strong> <span style="color:#69766b">/</span> 3 个账号可用<span class="mono">示例额度 · 更新于 ${escape(state.quotaTime)}</span></div><button class="button subtle" data-action="refresh-quota">${icon('reset')}刷新示例额度</button></div>
      <section class="account-table" aria-label="账号与 Worker 绑定"><div class="account-table-header" aria-hidden="true"><span>账号别名</span><span>一对一绑定</span><span>实例状态</span><span>五小时剩余额度 · 示例</span><span></span></div>${accounts.map((account) => {
        const worker = workerStatus(account);
        const expanded = state.expandedAccount === account.id;
        return `<button class="account-row" data-action="account" data-account="${account.id}" aria-expanded="${expanded}" aria-controls="details-${account.id}" aria-label="${escape(account.alias)}，绑定 ${account.worker}，${worker.text}，查看详情"><span class="account-cell"><strong>${escape(account.alias)}</strong><span class="mono">${account.id}</span></span><span class="account-cell"><strong class="worker-name">${account.worker}</strong><span class="worker-binding">${account.health === '可用' ? '账号可用' : '身份与执行待核对'}</span></span><span class="account-cell health-cell"><span class="badge ${worker.color}">${worker.text}</span><span class="mono">${worker.caption}</span></span><span class="account-cell quota-cell">${account.quota === null ? '<span class="quota-unknown">— 未知</span><span class="mono">不根据任务用量推算</span>' : `<span class="quota-head"><span>剩余 · 示例</span><strong>${account.quota}%</strong></span><span class="quota-track" aria-hidden="true"><span style="width:${account.quota}%"></span></span>`}</span><span class="account-chevron">${icon('chevron')}</span></button>${expanded ? `<div class="account-expanded" id="details-${account.id}"><div><p>固定绑定 <span class="mono">${account.id} ↔ ${account.worker}</span></p><p>原生会话 <span class="mono">${account.binding}</span> · 示例标识</p><p>${account.worker === 'wrk-03' && findTask(account.task).status === 'interrupted' ? '执行状态未知，保留占用，暂不可派发新任务。' : account.worker === 'wrk-04' ? '实例当前空闲；最近交付保留为固定快照。' : '当前任务执行期间保留此绑定。'}</p></div><button class="button" data-action="open-task" data-task="${account.task}">查看关联任务 ${icon('arrow')}</button></div>` : ''}`;
      }).join('')}</section><div class="account-legend"><span><i class="status-dot green" aria-hidden="true"></i>可用 / 执行中</span><span><i class="status-dot amber" aria-hidden="true"></i>需要决定 / 状态未知</span><span>额度更新时间独立于任务状态</span></div>
      <div class="account-note">${icon('info')}<div><h3>额度与任务用量分开记录</h3><p>这里只展示带有更新时间的示例剩余额度。服务未提供或无法确认的数值显示为“未知”。账号切换与新任务派发由 Codex 主会话统一管理。</p></div></div>`;
  }

  function sidebar() {
    const task = findTask();
    const list = filteredTasks(state.sidebarFilter);
    const selectedInList = list.some((item) => item.id === task.id);
    return `<main class="sidebar-stage" id="main-content"><section class="sidebar-preview" aria-label="VS Code 紧凑侧栏预览"><header class="sidebar-title"><strong>ZCODE POOL</strong><button class="icon-btn" data-action="open-workbench" aria-label="在工作台展开当前任务" title="在工作台展开">${icon('expand')}</button></header><div class="sidebar-session"><div class="sidebar-session-top"><strong>codex_zcode</strong><span class="badge green">主会话管理</span></div><p>待处理 ${counts().pending} 项 · 执行中 ${counts().running} 项</p></div><div class="sidebar-tabs" role="group" aria-label="侧栏筛选">${filterButtons(true)}</div><div class="sidebar-list">${list.length ? list.map(taskCard).join('') : `<div class="empty-state">${icon('check')}<h3>没有运行中任务</h3><p>待处理与实例状态仍可查看。</p></div>`}</div>${selectedInList ? `<div class="sidebar-detail"><div class="task-id">${task.id} / QUICK ACTION</div><h3>${escape(task.title)}</h3><p>${escape(task.description)}</p>${task.status === 'waiting_approval' ? `<div class="command">npm test -- approval-idempotency</div><button class="button primary" data-action="approval-preview" data-task="${task.id}">${icon('approval')}审阅本次操作</button>` : task.status === 'interrupted' ? `<button class="button" data-action="reconcile" data-task="${task.id}">${icon('connection')}演示只读对账</button>` : task.status === 'succeeded' && !task.reviewed ? `<button class="button primary" data-action="open-review" data-task="${task.id}">${icon('diff')}展开差异与核验</button>` : `<button class="button" data-action="open-workbench">查看任务详情 ${icon('arrow')}</button>`}</div>` : ''}<footer class="sidebar-connection"><span class="connection-status"><i class="status-dot ${state.connection === 'recovered' ? 'green' : ''}" aria-hidden="true"></i>${state.connection === 'recovered' ? '连接已恢复 · 演示' : 'daemon 未连接'}</span><button class="text-btn" data-action="connect">${state.connection === 'recovered' ? '恢复记录' : '演示恢复'}</button></footer></section>
      <aside class="sidebar-explainer"><div class="eyebrow">VSCODE / SIDEBAR ENTRY</div><h1>随手看状态，<br>展开做决定。</h1><p>侧栏保留任务入口与关键操作。需要审查差异、核验结果或账号绑定时，在编辑区打开完整管理台。</p><button class="button" data-action="open-workbench">打开管理工作台 ${icon('arrow')}</button><div class="sidebar-principles"><div class="sidebar-principle"><span>01</span><div><strong>让待处理保持可见</strong><p>审批、待审阅与未知状态合并成短队列。</p></div></div><div class="sidebar-principle"><span>02</span><div><strong>主会话掌握管理权</strong><p>任务派发、交付审查与集成由 Codex 统一管理。</p></div></div><div class="sidebar-principle"><span>03</span><div><strong>连接恢复后先对账</strong><p>保留原任务与占用，根据执行证据恢复跟踪。</p></div></div></div></aside></main>`;
  }

  function render() {
    app.innerHTML = topbar() + (state.mode === 'sidebar' ? sidebar() : `<div class="app-shell">${nav()}<main class="main-content" id="main-content">${state.page === 'accounts' ? accountPage() : state.page === 'review' ? reviewPage() : taskPage()}</main></div>`);
  }

  function toast(message) {
    clearTimeout(toastTimer);
    const element = document.getElementById('toast');
    element.innerHTML = `${icon('check')}<span>${escape(message)}</span>`;
    element.hidden = false;
    toastTimer = setTimeout(() => { element.hidden = true; }, 6500);
  }

  function focusHeading(id = 'page-title') {
    document.getElementById(id)?.focus({ preventScroll: true });
  }

  function modalContent() {
    const task = modal.task ? findTask(modal.task) : null;
    const artifact = task ? artifactFor(task) : null;
    let title = '', content = '', actions = '';
    if (modal.type === 'approval' || modal.type === 'approval-preview') {
      const isPreview = modal.type === 'approval-preview';
      const approve = modal.decision === 'approve';
      title = isPreview ? '审阅本次操作' : approve ? '只批准这一次操作' : '拒绝这一次操作';
      content = `<p class="modal-intro">${isPreview ? '先检查操作内容与工作目录，再选择本次决定。' : approve ? '本次许可仅针对下面的测试命令，不保存为自动审批规则。' : '本次命令不会获准执行，拒绝决定会回传给原任务。'}</p><div class="modal-command"><div class="operation-label">操作预览</div><pre class="command">npm test -- approval-idempotency</pre></div><dl class="modal-facts"><dt>所属任务</dt><dd class="mono">${task.id} · ${task.worker}</dd><dt>工作目录</dt><dd class="mono">.worktrees/approval-guard</dd><dt>审批范围</dt><dd>本次请求 APP-081</dd><dt>决定来源</dt><dd>本地原型演示</dd></dl><div class="demo-warning">${icon('info')}<span>这是本地交互演示。确认后只更新本页的审批、任务与计数，不执行命令。</span></div>`;
      actions = isPreview ? `<button class="button" data-action="approval" data-task="${task.id}" data-decision="reject">拒绝</button><button class="button primary" data-action="approval" data-task="${task.id}" data-decision="approve">只批准本次</button>` : `<button class="button" data-action="close-modal">返回检查</button><button class="button ${approve ? 'primary' : 'danger'}" data-action="confirm-approval" data-task="${task.id}" data-decision="${modal.decision}">${approve ? '确认本地批准演示' : '确认本地拒绝演示'}</button>`;
    } else if (modal.type === 'reconcile') {
      title = '恢复连接与只读对账';
      content = `<p class="modal-intro">核对原会话与原执行，不重发任务。选择一个示例结果，查看任务与占用如何变化。</p><dl class="modal-facts"><dt>原任务</dt><dd class="mono">${task.id} · ${task.worker}</dd><dt>保留工作区</dt><dd class="mono">${escape(task.workspace)}</dd><dt>对账方式</dt><dd>核对原命令与原会话的执行证据</dd></dl><div class="modal-subhead">选择本地模拟结果</div><label class="radio-option"><input type="radio" name="reconcile-result" value="unknown" checked><div><strong>仍无法确认执行状态</strong><span>保留 interrupted 与占用，继续等待主会话处理。</span></div></label><label class="radio-option"><input type="radio" name="reconcile-result" value="active"><div><strong>找到原会话中的活动执行</strong><span>只记录活动执行的发现；再由显式动作恢复跟踪。</span></div></label><div class="demo-warning" style="margin-top:15px">${icon('info')}<span>只改变本地示例状态，不访问 daemon 或原生会话。</span></div>`;
      actions = `<button class="button" data-action="close-modal">取消</button><button class="button primary" data-action="confirm-reconcile" data-task="${task.id}">运行本地对账演示</button>`;
    } else if (modal.type === 'connect') {
      title = state.connection === 'recovered' ? '连接恢复演示记录' : '演示连接恢复';
      content = `<p class="modal-intro">扩展与独立运行的 daemon 重新建立连接后，先恢复订阅，再核对任务的原执行状态。</p>${timeline([{ time: '01', title: '恢复管理连接', description: '本地模拟连接状态变化。' }, { time: '02', title: '读取持久化任务与事件游标', description: '继续跟踪已有任务。' }, { time: '03', title: '对中断任务只读对账', description: '状态未知时保留占用。', type: 'amber' }])}<div class="demo-warning" style="margin-top:20px">${icon('info')}<span>原型始终未连接服务。点击后仅显示“演示连接已恢复”，任务不会自动重发。</span></div>`;
      actions = `<button class="button" data-action="close-modal">关闭</button>${state.connection === 'recovered' ? `<button class="button primary" data-action="reconcile" data-task="T-1039">查看原任务对账</button>` : '<button class="button primary" data-action="confirm-connect">确认本地恢复演示</button>'}`;
    } else if (modal.type === 'review') {
      title = '标记这份示例交付已审阅';
      content = `<p class="modal-intro">已查看差异快照与两项通过的核验结果。确认后，当前页面中的任务将显示为已完成。</p><dl class="modal-facts"><dt>任务</dt><dd class="mono">${task.id}</dd><dt>差异快照</dt><dd class="mono">snap-${task.id.slice(2)}-a81f</dd><dt>变更</dt><dd>2 个文件 · +${artifact.added} / −${artifact.removed}</dd><dt>核验</dt><dd>测试、类型检查 · 示例退出码 0</dd></dl><div class="demo-warning">${icon('info')}<span>仅保存本页演示状态。此操作不会执行 Git 合并、提交或清理。</span></div>`;
      actions = `<button class="button" data-action="close-modal">返回审阅</button><button class="button primary" data-action="confirm-review" data-task="${task.id}">确认本地审阅演示</button>`;
    } else if (modal.type === 'reset') {
      title = '重置演示状态';
      content = `<p class="modal-intro">审批、续跑次数、连接恢复与审阅标记将回到初始示例状态。</p><div class="demo-warning">${icon('info')}<span>只重置当前页面，没有真实任务或数据会被修改。</span></div>`;
      actions = `<button class="button" data-action="close-modal">保留当前状态</button><button class="button primary" data-action="confirm-reset">重置本地演示</button>`;
    }
    return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby="modal-demo-label" tabindex="-1"><div class="modal-header"><div><div class="modal-kicker" id="modal-demo-label">LOCAL INTERACTION / 示例演示</div><h2 id="modal-title">${title}</h2></div><button class="icon-btn" data-action="close-modal" aria-label="关闭对话框">${icon('close')}</button></div><div class="modal-content">${content}</div><div class="modal-actions">${actions}</div></section></div>`;
  }

  function openModal(next) {
    if (!modal) focusBeforeModal = document.activeElement;
    modal = next;
    modalRoot.innerHTML = modalContent();
    app.setAttribute('inert', '');
    app.setAttribute('aria-hidden', 'true');
    modalRoot.querySelector('.modal')?.focus();
  }

  function closeModal(restoreFocus = true) {
    modal = null;
    modalRoot.innerHTML = '';
    app.removeAttribute('inert');
    app.removeAttribute('aria-hidden');
    if (restoreFocus && focusBeforeModal?.isConnected) focusBeforeModal.focus();
    focusBeforeModal = null;
  }

  function openTask(id) {
    state.mode = 'workbench'; state.page = 'tasks'; state.selected = id; state.tab = 'overview'; state.detailOpen = true;
    state.filter = pending(findTask(id)) ? 'pending' : findTask(id).status === 'running' ? 'running' : 'all';
    render(); focusHeading('task-detail-title');
  }

  function chooseTask(id) {
    state.selected = id; state.tab = 'overview'; state.detailOpen = true;
    render();
    if (state.mode === 'workbench') focusHeading('task-detail-title');
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action;
    const id = button.dataset.task;
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'mode') { state.mode = button.dataset.mode; render(); return; }
    if (action === 'page') { state.page = button.dataset.page; state.detailOpen = false; render(); focusHeading(); return; }
    if (action === 'filter') {
      state.filter = button.dataset.filter; state.detailOpen = false;
      const list = filteredTasks(state.filter); if (list.length && !list.some((item) => item.id === state.selected)) { state.selected = list[0].id; state.tab = 'overview'; }
      render(); return;
    }
    if (action === 'select-task') { chooseTask(id); return; }
    if (action === 'tab') { state.tab = button.dataset.tab; render(); document.getElementById(`tab-${state.tab}`)?.focus(); return; }
    if (action === 'back') { state.detailOpen = false; render(); return; }
    if (action === 'approval-preview') { if (findTask(id)?.approval !== 'pending') { toast('该审批已有本地演示决定。'); return; } openModal({ type: action, task: id }); return; }
    if (action === 'approval') {
      const task = findTask(id); const approve = button.dataset.decision === 'approve';
      if (task.approval !== 'pending') return;
      task.approval = approve ? 'approved' : 'rejected'; task.status = 'running'; task.time = now();
      task.description = approve ? '本次测试操作已获本地演示批准。任务回到执行状态。' : '本次测试操作已被本地演示拒绝。Worker 可据此调整后续操作。';
      task.events.push({ time: now(), title: approve ? '本次操作已批准 · 本地演示' : '本次操作已拒绝 · 本地演示', description: '决定来源：本地交互原型；命令未执行。', type: 'active' });
      closeModal(false); state.filter = 'running'; render(); toast(approve ? '本地演示：已批准本次操作，任务与待处理计数已更新。' : '本地演示：已拒绝本次操作，任务与待处理计数已更新。'); return;
    }
    if (action === 'busy') {
      const task = findTask('T-1041'); if (task.status === 'failed') return;
      if (task.retry < task.max) {
        task.retry += 1; task.events = task.events.filter((item) => item.type !== 'active');
        task.events.push({ time: now(), title: '当前回合因模型繁忙终止 · 演示', description: '已确认失败回合归属、执行绑定一致且无活动执行。', type: 'amber' }, { time: now(), title: '立即在原会话发送“继续” · 演示', description: `续跑次数：${task.retry} / ${task.max}；原账号、模型与会话保持一致。` }, { time: now(), title: '正在执行 · 本地演示', description: '等待当前原生回合结束。', type: 'active' });
        render(); toast(`本地演示：立即原会话续跑，已使用 ${task.retry} / ${task.max} 次。`);
      } else {
        task.status = 'failed'; task.description = '续跑次数已达上限。再次繁忙后停止自动续跑，等待主会话决定。';
        task.events = task.events.filter((item) => item.type !== 'active');
        task.events.push({ time: now(), title: '再次繁忙，续跑上限已耗尽 · 演示', description: '任务保留现场，不再自动发送“继续”。', type: 'amber' });
        state.filter = 'pending'; render(); toast('本地演示：已到续跑上限，任务进入待处理。');
      } return;
    }
    if (action === 'reconcile') { openModal({ type: 'reconcile', task: id }); return; }
    if (action === 'attach-task') {
      const task = findTask(id);
      if (task.reconciliation !== 'active') return;
      task.reconciliation = 'attached'; task.status = 'running';
      task.description = '已显式恢复原会话中的活动执行，继续跟踪原任务；未重复派发。';
      task.events.push({ time: now(), title: '恢复原执行跟踪 · 本地演示', description: '根据已确认的活动执行重新附着；原任务与会话不变。', type: 'active' });
      closeModal(false); state.mode = 'workbench'; state.page = 'tasks'; state.selected = id; state.filter = 'running'; state.detailOpen = true; render(); toast('本地演示：已显式恢复原执行跟踪，未重复派发。'); return;
    }
    if (action === 'confirm-reconcile') {
      const task = findTask(id); const result = modalRoot.querySelector('input[name="reconcile-result"]:checked')?.value || 'unknown';
      state.connection = 'recovered'; task.reconciliation = result;
      if (result === 'active') {
        task.status = 'interrupted'; task.description = '只读对账已发现原会话中的活动执行。任务仍保留中断状态，等待显式恢复跟踪。';
        task.events.push({ time: now(), title: '发现原会话活动执行 · 本地演示', description: '只读对账完成；任务状态未改变，等待显式恢复跟踪。', type: 'amber' });
      } else {
        task.status = 'interrupted'; task.description = '连接恢复后仍无法确认原执行状态。Worker 与工作区继续保留占用。';
        task.events.push({ time: now(), title: '对账后执行仍未知 · 本地演示', description: '保留 interrupted 与占用，不重发任务。', type: 'amber' });
      }
      closeModal(false); state.mode = 'workbench'; state.page = 'tasks'; state.selected = id; state.detailOpen = true; state.tab = 'overview'; state.filter = 'pending'; render(); toast(result === 'active' ? '本地演示：只读对账发现原执行，可显式恢复跟踪。' : '本地演示：执行仍未知，占用继续保留。'); return;
    }
    if (action === 'connect') { openModal({ type: 'connect' }); return; }
    if (action === 'confirm-connect') { state.connection = 'recovered'; closeModal(false); render(); toast('本地演示：连接恢复，原任务保持原状；中断任务仍需对账。'); return; }
    if (action === 'open-review') { state.mode = 'workbench'; state.page = 'review'; state.selected = id; state.file = 0; state.reviewAcknowledged = false; render(); focusHeading(); return; }
    if (action === 'file') { state.file = Number(button.dataset.file); render(); app.querySelector(`[data-action="file"][data-file="${state.file}"]`)?.focus(); return; }
    if (action === 'review-complete') { if (state.reviewAcknowledged) openModal({ type: 'review', task: id }); return; }
    if (action === 'confirm-review') {
      const task = findTask(id); task.reviewed = true; task.description = '已在本地演示中审阅固定差异与核验结果，任务已完成。';
      task.events.push({ time: now(), title: '交付已审阅 · 本地演示', description: '差异与核验输出已查看；未执行集成。', type: 'active' });
      closeModal(false); render(); toast('本地演示：已标记审阅完成，待处理计数已更新。'); return;
    }
    if (action === 'account') { state.expandedAccount = state.expandedAccount === button.dataset.account ? null : button.dataset.account; render(); app.querySelector(`[data-action="account"][data-account="${button.dataset.account}"]`)?.focus(); return; }
    if (action === 'open-task') { openTask(id); return; }
    if (action === 'refresh-quota') {
      const d = new Date(); state.quotaTime = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${now()}`;
      render(); toast('已刷新本地示例时间，未查询任何账号或额度服务。'); return;
    }
    if (action === 'sidebar-filter') {
      if (button.dataset.filter === 'accounts') { state.mode = 'workbench'; state.page = 'accounts'; render(); focusHeading(); return; }
      state.sidebarFilter = button.dataset.filter; const list = filteredTasks(state.sidebarFilter); if (list.length && !list.some((item) => item.id === state.selected)) state.selected = list[0].id; render(); return;
    }
    if (action === 'open-workbench') { openTask(state.selected); return; }
    if (action === 'reset') { openModal({ type: 'reset' }); return; }
    if (action === 'confirm-reset') {
      closeModal(false); tasks = structuredClone(initialTasks); state = { mode: 'workbench', page: 'tasks', filter: 'pending', selected: 'T-1042', tab: 'overview', detailOpen: false, file: 0, expandedAccount: null, quotaTime: '2026-11-01 16:40', connection: 'disconnected', sidebarFilter: 'pending', reviewAcknowledged: false }; render(); toast('已恢复初始示例数据。');
    }
  });

  document.addEventListener('change', (event) => {
    if (event.target.id === 'review-task-select') { state.selected = event.target.value; state.file = 0; state.reviewAcknowledged = false; render(); document.getElementById('review-task-select')?.focus(); }
    if (event.target.id === 'review-acknowledged') { state.reviewAcknowledged = event.target.checked; const button = app.querySelector('[data-action="review-complete"]'); if (button) { button.disabled = !state.reviewAcknowledged; button.title = state.reviewAcknowledged ? '' : '先勾选已审阅示例差异与核验输出'; } }
  });

  document.addEventListener('keydown', (event) => {
    if (modal && event.key === 'Escape') { event.preventDefault(); closeModal(); return; }
    if (modal && event.key === 'Tab') {
      const focusable = [...modalRoot.querySelectorAll('button:not(:disabled), input, select, [tabindex="0"]')];
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRoot.querySelector('.modal'))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modalRoot.querySelector('.modal'))) { event.preventDefault(); first?.focus(); }
    }
    if (!modal && event.target.getAttribute?.('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const tabs = ['overview', 'changes', 'events']; const current = tabs.indexOf(state.tab);
      state.tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : tabs[(current + (event.key === 'ArrowRight' ? 1 : 2)) % 3];
      render(); document.getElementById(`tab-${state.tab}`)?.focus();
    }
  });

  render();
})();
