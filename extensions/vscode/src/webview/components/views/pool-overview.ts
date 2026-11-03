import type { UiSnapshot } from '../../../host/types.js';
import type { UiQuota } from '../../../../../../src/shared/ui-contract.js';
import { isActive, mutationReason } from '../../state.js';
import type { RenderContext } from '../types.js';
import { el, date, field, input, select, errorObservationLabel } from '../dom.js';
import { badge } from '../primitives.js';
import { button, actionWithReason } from '../button.js';

export function quotaSummary(quota: UiQuota | undefined): string {
  const snapshot = quota?.live ?? quota?.imported;
  if (!snapshot) return '额度未查询';
  const windows = snapshot.windows.filter((window): window is typeof window & {percentageUsed:number} => window.percentageUsed !== null);
  if (windows.length) {
    const limiting = windows.reduce((a, b) => a.percentageUsed >= b.percentageUsed ? a : b);
    return `${limiting.name} · 剩余 ${Math.max(0, 100 - limiting.percentageUsed).toFixed(0)}%`;
  }
  if (snapshot.percentage?.scale === '0_to_100') return `剩余 ${snapshot.percentage.value.toFixed(0)}%`;
  if (snapshot.percentage?.scale === '0_to_1') return `剩余 ${(snapshot.percentage.value * 100).toFixed(0)}%`;
  if (snapshot.remaining !== null) return `剩余 ${snapshot.remaining.toLocaleString('zh-CN')}${snapshot.unit === 'unknown' ? '' : ` ${snapshot.unit}`}`;
  return '官方未提供余量';
}

export function renderScope(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const project = ctx.state.filters.project;
  const preferred = snapshot.projects.find(project => project.repositoryId === snapshot.preferredRepositoryId);
  const projects = snapshot.projects.map(project=>project.repositoryPath);
  const pool = button(ctx, '共享账号池', 'scope.pool', {}, { className: `scope-choice ${project ? '' : 'selected'}` });
  pool.setAttribute('aria-pressed', String(!project));
  const current = button(ctx, '当前项目', 'scope.project', {}, { className: `scope-choice ${project ? 'selected' : ''}`, reason: preferred || project ? null : '当前 VS Code 项目无法唯一确定，请从项目列表选择。' });
  current.setAttribute('aria-pressed', String(!!project));
  const scope = el('section', 'scope-bar', el('div', 'scope-switch', pool, current), el('p', 'muted', project || '查看全部指挥、项目与共享资源'));
  scope.setAttribute('aria-label', '查看范围');
  if (projects.length > 1) scope.append(field('选择项目', select(project, 'project', [['', '共享池 · 全部项目'], ...projects.map(path => [path, path] as [string, string])], true)));
  return scope;
}

export function renderPoolSummary(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const project = ctx.state.filters.project;
  const scoped = snapshot.tasks.filter(task => !project || snapshot.resources.workspaces.some(workspace => workspace.workspaceId === task.workspaceId && workspace.repositoryPath === project));
  const occupied = new Set(snapshot.resources.workers.filter(worker => worker.leaseTaskIds.length || (worker.runningTaskCount ?? 0) > 0).map(worker => worker.accountAlias));
  const ready = snapshot.resources.accounts.filter(account => account.enabled !== false && account.health === 'available' && !occupied.has(account.alias)).length;
  const taskSummary = el('section', 'overview-card',
    el('div', 'section-toolbar', el('h2', '', '任务概况'), badge(project ? '当前项目' : '共享池', 'quiet')),
    el('div', 'summary-counts',
      el('div', '', el('strong', '', String(scoped.filter(isActive).length)), el('span', '', '实施执行中')),
      el('div', '', el('strong', '', String(scoped.filter(task => task.status === 'waiting_approval').length)), el('span', '', '等待原生审批')),
      el('div', '', el('strong', '', String(scoped.length)), el('span', '', '已载入执行'))
    ),
    el('p', 'field-hint', '实施完成与验收结论分别记录。阶段由指挥确认后点亮。')
  );
  const accounts = el('section', 'overview-card',
    el('div', 'section-toolbar', el('h2', '', '账号概况'), button(ctx, '额度与账号', 'page', { page: 'resources' })),
    el('div', 'summary-counts',
      el('div', '', el('strong', '', String(snapshot.resources.accounts.length)), el('span', '', '共享账号')),
      el('div', '', el('strong', '', String(occupied.size)), el('span', '', '正在占用')),
      el('div', '', el('strong', '', String(ready)), el('span', '', '未占用且健康'))
    )
  );
  const rows = el('ul', 'account-summary-list');
  const relevant = [...snapshot.resources.accounts].sort((a, b) => Number(occupied.has(b.alias)) - Number(occupied.has(a.alias))).slice(0, 4);
  for (const account of relevant) {
    const quota = snapshot.resources.quotas[account.alias];
    const worker = snapshot.resources.workers.find(item => item.accountAlias === account.alias && item.leaseTaskIds.length);
    const freshness = quota?.live ?? quota?.imported;
    const row = el('li', '', el('strong', '', account.alias), el('span', '', worker?.leaseTaskIds.join('、') || (account.health === 'available' ? '未占用' : account.health)), el('span', 'muted', quotaSummary(quota)));
    const errors=snapshot.workOverview?.accountErrors?.[account.alias];
    if(errors)row.append(el('span','account-summary-errors muted',`已观测错误 ${errors.total} 次 · ${errorObservationLabel(errors.complete)}`));
    row.title = freshness ? `额度观察时间：${date(freshness.observedAtMs)}${quota?.lastProbe.state === 'failed' ? ' · 最近查询失败，显示旧值' : ''}` : '尚未查询官方额度';
    rows.append(row);
  }
  if (!relevant.length) rows.append(el('li', 'muted', '尚未导入账号'));
  accounts.append(rows);
  const limit = input(ctx.state.settingsConcurrency, 'settingsConcurrency', 'number');
  limit.min = '0'; limit.max = '64'; limit.step = '1'; limit.placeholder = '不限制';
  const value = ctx.state.settingsConcurrency.trim();
  const valid = !value || Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 64;
  const controls = el('details', 'overview-resource-controls', el('summary', '', '资源与配额操作'),
    el('div', 'quick-resource-actions',
      field('全池并发上限', limit, '0 暂停新派发；降低上限不打断已执行任务。'),
      actionWithReason(ctx, '保存上限', 'pool.policy.set', {}, mutationReason(snapshot, 'poolPolicy') ?? (!valid ? '请输入 0–64，或留空不限制。' : null)),
      button(ctx, '暂停新派发', 'pool.pause', {}, { reason: mutationReason(snapshot, 'poolPolicy') }),
      button(ctx, '账号启停与额度', 'page', { page: 'resources' }),
      button(ctx, '全部设置', 'page', { page: 'settings' })
    )
  );
  controls.dataset.details = 'overview-resources';
  return el('div', 'pool-overview', el('div', 'overview-columns', taskSummary, accounts), controls);
}
