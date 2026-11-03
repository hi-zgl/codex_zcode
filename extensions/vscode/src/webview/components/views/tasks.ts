import type { UiSnapshot } from '../../../host/types.js';
import { filterTasks, isActive, needsAttention, selectedTask, mutationReason } from '../../state.js';
import { icon } from '../../icons.js';
import type { RenderContext } from '../types.js';
import { el, date, statusLabel, statusNames, field, input, select, heading } from '../dom.js';
import { badge, notice, status } from '../primitives.js';
import { button, actionWithReason } from '../button.js';
import { emptyCard, messageFor } from '../feedback.js';
import { codexSetup } from '../header.js';
import { renderTaskDetail } from './task-detail.js';
import { renderPoolSummary, renderScope } from './pool-overview.js';
import { renderWorkOverview } from './work-flow.js';
import { renderPending } from './pending.js';
import { renderErrorStats } from './error-stats.js';

export function metric(ctx: RenderContext, label: string, count: number, filter: string, description: string): HTMLElement {
  const isSelected = ctx.state.filters.status === filter;
  const node = button(ctx, '', 'filter.status', { value: filter }, {
    className: `metric metric-${filter} ${isSelected ? 'selected' : ''}`
  });
  const iconWrap = el('div', `metric-icon-wrap ${filter}`,
    filter === 'attention' ? icon('bell', { size: 16 }) :
    filter === 'active' ? icon('zap', { size: 16 }) : icon('inbox', { size: 16 })
  );
  node.append(
    iconWrap,
    el('span', `metric-number ${filter === 'attention' && count > 0 ? 'amber' : ''}`, String(count).padStart(2, '0')),
    el('div', 'metric-info', el('strong', '', label), el('p', '', description))
  );
  return node;
}

export function renderFilters(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const projects = snapshot.projects.map(project=>project.repositoryPath);
  const filters = ctx.state.filters;
  const search = input(filters.query, 'query');
  delete search.dataset.field;
  search.dataset.filter = 'query';
  search.dataset.focus = 'filter:query';
  search.type = 'search';
  search.maxLength = 200;
  search.placeholder = 'ID、仓库、分支、执行器';
  const node = el('section', 'task-filters',
    field('项目', select(filters.project, 'project', [['', '全部项目'], ...projects.map(project => [project, project] as [string, string])], true)),
    field('状态', select(filters.status, 'status', [['all', '全部状态'], ['attention', '需要处理'], ['active', '执行中（含核验）'], ['finished', '最近结束'], ...Object.entries(statusNames)], true)),
    field('执行器', select(filters.worker, 'worker', [['', '全部执行器'], ...snapshot.resources.workers.map(worker => [worker.workerId, worker.workerId] as [string, string])], true)),
    field('任务目录', select(filters.workspace, 'workspace', [['', '全部任务目录'], ...snapshot.resources.workspaces.map(workspace => [workspace.workspaceId, workspace.workspaceId] as [string, string])], true)),
    field('搜索任务', search)
  );
  node.setAttribute('aria-label', '筛选已载入任务');
  return node;
}

export function renderTasks(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const filtered = filterTasks(snapshot, ctx.state.filters);
  const attention = snapshot.tasks.filter(task => needsAttention(task, snapshot)).length;
  const active = snapshot.tasks.filter(isActive).length;
  const advanced = el('details', 'advanced-actions', el('summary', '', '高级操作'), actionWithReason(ctx, '手动派发任务', 'compose.open', {}, mutationReason(snapshot, 'dispatchTask')));
  advanced.dataset.details = 'task-advanced';
  const page = el('div', 'task-page', heading('ZCODE / 任务', '任务监控', '由 Codex 拆分、派发和验收任务；在这里查看进度、处理必要审批、检查交付。', el('div', 'page-actions', codexSetup(ctx, snapshot, true), advanced)));
  page.append(messageFor(ctx, 'connection.codexSetup') ?? '');
  page.append(renderScope(ctx, snapshot), renderPoolSummary(ctx, snapshot));
  page.append(renderPending(ctx, snapshot));
  page.append(renderWorkOverview(ctx, snapshot) ?? '');
  page.append(renderErrorStats(ctx, snapshot));
  const totalMetric = el('div', 'metric metric-total',
    el('div', 'metric-icon-wrap total', icon('inbox', { size: 16 })),
    el('span', 'metric-number', String(snapshot.tasks.length).padStart(2, '0')),
    el('div', 'metric-info',
      el('strong', '', '已载入任务'),
      el('p', '', snapshot.scope === 'recent_50_loaded' ? '最近创建 50 条窗口 · 历史总数未知' : `当前匹配范围 · 总数 ${snapshot.total ?? '未知'}`)
    )
  );
  page.append(el('div', 'metrics',
    metric(ctx, '需要处理', attention, 'attention', '审批、阻塞、失败及待审阅交付'),
    metric(ctx, '执行中', active, 'active', '包括派发、执行与核验'),
    totalMetric
  ));
  page.append(renderFilters(ctx, snapshot));
  const task = selectedTask(ctx.state);
  const taskList = el('section', 'task-list-panel');
  taskList.setAttribute('aria-label', '任务列表');
  taskList.append(el('div', 'panel-title', el('h2', '', '已载入任务'), el('span', 'muted', '最近创建优先')));
  const list = el('div', 'task-list');
  list.dataset.scroll = 'task-list';
  list.setAttribute('aria-describedby', 'task-list-keys');
  const keys = el('span', 'sr-only', '使用上下方向键在任务之间移动，按 Enter 打开。');
  keys.id = 'task-list-keys';
  taskList.append(keys);
  if (!filtered.length) {
    const isZero = snapshot.tasks.length === 0;
    const desc = isZero
      ? '在 Codex 中描述任务目标，派发后的任务会显示在这里。也可通过高级操作手动派发。'
      : snapshot.scope === 'recent_50_loaded'
      ? '最近 50 条中没有匹配项，可继续加载历史任务。'
      : '可清除筛选后查看其他任务。';
    list.append(emptyCard('当前列表没有匹配任务', desc, {
      action: button(ctx, '清除筛选 · 全部项目', 'filters.clear', {}, { icon: icon('close', { size: 12 }) }),
      icon: isZero ? 'inbox' : 'search',
      hint: isZero ? '提示：通过顶部“连接 Codex / 生成 MCP 配置”启用自动任务调度。' : undefined
    }));
  }
  for (const item of filtered) {
    const workspace = snapshot.resources.workspaces.find(ws => ws.workspaceId === item.workspaceId);
    const row = button(ctx, '', 'task.select', { taskId: item.taskId }, { className: `task-row ${item.taskId === snapshot.selectedTaskId ? 'selected' : ''}` });
    row.setAttribute('aria-pressed', String(item.taskId === snapshot.selectedTaskId));
    row.setAttribute('aria-label', `${item.taskId}，${statusLabel(item)}，${item.workspaceId}，${item.workerId ?? '未绑定执行器'}`);
    const workerChip = el('span', `task-chip ${item.workerId ? 'has-worker' : 'no-worker'}`, icon('cpu', { size: 11 }), item.workerId ?? '未绑定执行器');
    const retryChip = item.retry ? el('span', `task-chip task-retry ${item.retry.used > 0 ? 'used' : ''}`, icon('refresh', { size: 11 }), `累计重试 ${item.retry.used} 次`) : el('span', 'task-chip muted', '续跑信息未提供');
    const branchTitle = workspace?.branch ? el('strong', 'task-row-title', icon('branch', { size: 12 }), workspace.branch) : el('strong', 'task-row-title', item.workspaceId);
    row.append(
      el('div', 'task-row-top', el('code', 'task-id', item.taskId), status(item, snapshot.connection.stale)),
      branchTitle,
      el('span', 'task-project', workspace?.repositoryPath ?? '项目路径当前未提供'),
      el('div', 'task-row-bottom', workerChip, retryChip),
      el('span', 'task-time', item.createdAtMs ? date(item.createdAtMs) : '创建时间 —')
    );
    if (item.leaseHeld && item.executionStopped !== true && !isActive(item)) row.append(badge([icon('alert', { size: 11 }), '占用未知'], 'attention'));
    if (item.status === 'succeeded') {
      const isReviewed = item.deliveryReview === 'reviewed' || (snapshot.selectedTaskId === item.taskId && snapshot.delivery.reviewed);
      row.append(el('span', 'task-review', isReviewed ? icon('check', { size: 12 }) : null, isReviewed ? ' 本客户端已审阅' : item.deliveryReview === 'pending' ? '待人工审阅' : '审阅状态待加载'));
    }
    list.append(row);
  }
  taskList.append(list, el('p', 'scope-note', `筛选 ${filtered.length} / 已载入 ${snapshot.tasks.length} · ${snapshot.scope === 'recent_50_loaded' ? '历史总数未知' : `服务端范围共 ${snapshot.total ?? '未知'} 条${ctx.state.filters.status === 'attention' ? '；需要处理仅筛选已载入任务' : ''}`}`));
  if (snapshot.listNextCursor) taskList.append(button(ctx, '继续加载历史任务', 'tasks.more', {}, { busy: ctx.state.pending.has('tasks.list'), icon: icon('history', { size: 12 }) }));
  if (ctx.state.errors.has('tasks.list')) taskList.append(notice(ctx.state.errors.get('tasks.list')!, 'warning'), button(ctx, '重新加载列表', 'tasks.reload', {}, { icon: icon('refresh', { size: 12 }) }));
  const lookup = input(ctx.state.taskLookup, 'taskLookup');
  lookup.placeholder = '已知任务完整 ID';
  taskList.append(el('div', 'task-lookup', field('通过任务 ID 查找', lookup), button(ctx, '打开任务', 'task.lookup', {}, { icon: icon('search', { size: 12 }), reason: !ctx.state.taskLookup.trim() ? '请输入完整任务 ID。' : null })));
  const detail = el('section', 'detail-container', button(ctx, [icon('arrow-left', { size: 12 }), ' 返回任务列表'], 'detail.back', {}, { className: 'mobile-back' }), task ? renderTaskDetail(ctx, snapshot, task, filtered.some(item => item.taskId === task.taskId)) : emptyCard('选择一个任务', '选中任务仅加载详情，不会恢复或执行任务。', { icon: 'list-tree', hint: '在左侧列表中选择任一任务，即可查看安全概况、待决审批、不可变交付快照与脱敏事件流。' }));
  page.append(el('div', `task-workspace ${ctx.state.detailOpen ? 'detail-open' : ''}`, taskList, detail));
  return page;
}
