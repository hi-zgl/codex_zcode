import type { UiSnapshot, UiTask } from '../../../host/types.js';
import { isActive, safeDetail, type DetailTab } from '../../state.js';
import { icon } from '../../icons.js';
import type { RenderContext } from '../types.js';
import { el, date, kv } from '../dom.js';
import { notice, status } from '../primitives.js';
import { button } from '../button.js';
import { renderOverview, renderTaskControls, renderEvents } from './task-overview.js';
import { renderApprovals } from './task-approvals.js';
import { renderDelivery } from './task-delivery.js';

export * from './task-overview.js';
export * from './task-approvals.js';
export * from './task-delivery.js';

export function renderTaskDetail(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask, inFilter: boolean): HTMLElement {
  const detail = safeDetail(snapshot);
  const title = el('h2', '', task.taskId);
  title.id = 'task-detail-title';
  title.tabIndex = -1;
  const node = el('div', 'task-detail',
    el('div', 'detail-heading',
      el('div', '', el('p', 'eyebrow', '任务详情'), title),
      status(task, snapshot.connection.stale)
    )
  );
  if (!inFilter) node.append(notice('此任务不在当前筛选中；详情保持打开。'));
  node.append(kv([
    ['任务目录', task.workspaceId],
    ['执行器', task.workerId],
    ['状态版本', task.revision],
    ['本地审阅', snapshot.delivery.reviewed || task.deliveryReview === 'reviewed' ? '本客户端已审阅' : task.status === 'succeeded' && detail?.result.available ? '待人工审阅' : '—']
  ]));
  if (task.leaseHeld) {
    node.append(notice(
      task.executionStopped === true
        ? '执行已停止，资源占用仍保留；可能正在核验或保存交付。'
        : task.executionStopped === undefined
        ? '尚未确认执行是否停止，执行器和任务目录暂不可复用。'
        : isActive(task)
        ? '任务正在占用执行器和任务目录。'
        : '尚未确认执行是否停止，执行器和任务目录继续保留占用。',
      'warning'
    ));
  } else if (task.executionStopped === true) {
    node.append(el('p', 'occupancy-proof', icon('check-circle', { size: 13 }), ' 执行已确认停止 · 资源占用已释放'));
  }
  if (task.cancelRequestedAtMs != null) {
    node.append(notice(`已记录取消请求（${date(task.cancelRequestedAtMs)}），等待实际停止确认；不会再触发后续自动续跑。`, 'warning'));
  }
  if (task.retry) {
    node.append(el('div', 'retry-strip',
      el('strong', '', `原会话立即继续 · 已使用 ${task.retry.used}/${task.retry.max} 次`),
      el('span', '', task.retry.max === 0 ? '已关闭模型繁忙续跑' : '仅明确的 model_busy，沿用账号、模型与会话；初次派发不计入')
    ));
  }
  if (!detail) node.append(notice('当前接口未提供可信安全详情；已有结果可读，写动作不可用。', 'warning'));
  const tabbar = el('div', 'detail-tabs');
  tabbar.setAttribute('role', 'tablist');
  tabbar.setAttribute('aria-label', '任务详情页签');
  const tabs: readonly [DetailTab, string][] = [
    ['overview', '概况'],
    ['approvals', `审批${task.approval?.pendingCount ? ` · ${task.approval.pendingCount}` : ''}`],
    ['delivery', '交付与核验'],
    ['events', '事件']
  ];
  for (const [id, label] of tabs) {
    const b = button(ctx, label, 'tab', { tab: id });
    b.setAttribute('role', 'tab');
    b.id = `tab-${id}`;
    b.setAttribute('aria-selected', String(ctx.state.tab === id));
    b.setAttribute('aria-controls', `panel-${id}`);
    b.tabIndex = ctx.state.tab === id ? 0 : -1;
    tabbar.append(b);
  }
  node.append(tabbar);
  const panel = el('div', 'tab-panel');
  panel.id = `panel-${ctx.state.tab}`;
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', `tab-${ctx.state.tab}`);
  panel.tabIndex = 0;
  if (ctx.state.tab === 'overview') panel.append(renderOverview(ctx, snapshot, task));
  if (ctx.state.tab === 'approvals') panel.append(renderApprovals(ctx, snapshot, task));
  if (ctx.state.tab === 'delivery') panel.append(renderDelivery(ctx, snapshot, task));
  if (ctx.state.tab === 'events') panel.append(renderEvents(ctx, task));
  node.append(panel);
  if (detail) node.append(renderTaskControls(ctx, snapshot, task));
  return node;
}
