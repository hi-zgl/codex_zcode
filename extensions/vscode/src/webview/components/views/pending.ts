import type { UiSnapshot } from '../../../host/types.js';
import type { RenderContext } from '../types.js';
import { el, date, field, input } from '../dom.js';
import { badge } from '../primitives.js';
import { actionWithReason, button } from '../button.js';
import { mutationReason } from '../../state.js';

export function renderPending(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const works = (snapshot.workOverview?.works ?? []).filter(work => !ctx.state.filters.project || work.repositoryPath === ctx.state.filters.project);
  const todos = works.flatMap(work => work.todos.map(todo => ({work,todo})));
  const approvals = snapshot.tasks.filter(task => task.status === 'waiting_approval');
  const node = el('section', 'pending-panel', el('div', 'section-toolbar', el('h2', '', '集中待处理'), badge(`${todos.length + approvals.length} 项`, todos.length + approvals.length ? 'attention' : 'quiet')));
  node.id='pending-items';node.tabIndex=-1;
  if (!todos.length && !approvals.length) node.append(el('p', 'muted', '当前范围没有待处理事项。可自动恢复的普通通道错误保留在错误记录中。'));
  for (const {work,todo} of todos) {
    const row = el('article', 'pending-item', el('strong', '', todo.summary), el('p', 'field-hint', `${work.goal} · ${work.commanderId} · ${date(todo.createdAt)}`),
      button(ctx, '查看总任务', 'work.select', {workId:work.workId}));
    if (todo.kind === 'resource_shortage' && todo.availableAccounts !== null && todo.availableAccounts > 0) {
      const count = input(ctx.state.rawFields.get(`partialAccounts:${todo.todoId}`) ?? String(todo.availableAccounts), `partialAccounts:${todo.todoId}`, 'number'); count.min='1';count.max=String(todo.availableAccounts);count.step='1';
      row.append(field('本次确认使用账号数', count, `申请 ${work.requestedAccounts} 个，当前可用 ${todo.availableAccounts} 个；确认后按这个数量部分推进。`),
        actionWithReason(ctx, '确认按此数量推进', 'work.todo.resolve', {workId:work.workId,todoId:todo.todoId,decision:'approve_partial',availableAccounts:String(todo.availableAccounts)}, mutationReason(snapshot,'workTodos')));
    } else {
      row.append(el('p', 'field-hint', todo.kind === 'all_accounts_low' ? '新派发已暂停；可查看额度与账号，处理后重新检查。' : '需要语义判断时，请在当前指挥入口说明决定；其他独立工作继续。'),
        button(ctx, '额度与账号', 'page', {page:'resources'}),
        actionWithReason(ctx, '重新检查', 'work.todo.resolve', {workId:work.workId,todoId:todo.todoId,decision:'retry'}, mutationReason(snapshot,'workTodos')));
    }
    node.append(row);
  }
  for (const task of approvals) node.append(el('article','pending-item',el('strong','','原生执行需要审批'),el('p','field-hint',task.taskId),button(ctx,'查看完整审批','task.approvals',{taskId:task.taskId})));
  return node;
}
