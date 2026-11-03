import type { UiSnapshot } from '../../../host/types.js';
import type { RenderContext } from '../types.js';
import { el, date, field, select, errorCategoryLabel, errorObservationLabel } from '../dom.js';
import { button } from '../button.js';
import { notice } from '../primitives.js';
import { mutationReason } from '../../state.js';

export function renderErrorStats(ctx:RenderContext,snapshot:UiSnapshot):HTMLElement {
  const node=el('details','error-stats',el('summary','','分类错误记录 · 按账号、任务与时间查看'));node.dataset.details='error-stats';
  node.append(el('div','error-filters',
    field('账号',select(ctx.state.rawFields.get('errors.account')??'','errors.account',[['','全部账号'],...snapshot.resources.accounts.map(account=>[account.alias,account.alias] as [string,string])])),
    field('任务',select(ctx.state.rawFields.get('errors.task')??'','errors.task',[['','全部任务'],['current','当前选中任务'],...snapshot.tasks.map(task=>[task.taskId,task.taskId] as [string,string])])),
    field('时间范围',select(ctx.state.rawFields.get('errors.hours')??'24','errors.hours',[['1','最近 1 小时'],['24','最近 24 小时'],['168','最近 7 天'],['0','全部时间']])),
    button(ctx,'查询 / 刷新错误','errors.read',{}, {reason:mutationReason(snapshot,'errorStats'),busy:ctx.state.pending.has('errors.read')})));
  node.append(el('p','field-hint','仅累计已观测到的实际失败；恢复成功不清空错误。筛选修改后点击查询应用。'));
  const stats=snapshot.errorStats;
  if(!stats){node.append(el('p','muted','尚未查询错误统计。'));return node;}
  const query=snapshot.errorStatsQuery;
  node.append(el('p','field-hint',`查询范围：${query?.accountAlias??'全部账号'} / ${query?.taskId??'全部任务'} / ${query?.fromMs?`${date(query.fromMs)} 起`:'全部时间'} · 更新于 ${date(query?.observedAtMs)}`));
  node.append(el('div','error-counts',el('strong','',`已观测错误 ${stats.total} 次`),el('span','',errorObservationLabel(stats.complete)),...Object.entries(stats.categories).map(([category,count])=>el('span','',`${errorCategoryLabel(category)} ${count}`))));
  if(stats.complete!==true)node.append(notice(`${stats.incompleteTaskCount} 项任务未确认连续观察，可能有未采集的错误；0 次不代表没有发生。`, 'warning'));
  const rows=el('ol','error-event-list');
  for(const event of stats.events)rows.append(el('li','',el('strong','',`${errorCategoryLabel(event.category)} · ${event.recoveredAt?'已恢复':'等待恢复 / 核实'}`),el('p','',event.summary),el('p','field-hint',`${event.accountAlias??'账号未绑定'} · ${event.taskId} · ${date(event.occurredAt)}`)));
  if(!stats.events.length)rows.append(el('li','muted',stats.complete===true?'已完整观测的查询范围内没有错误。':'此范围尚未观测到错误，不能据此断定没有发生。'));
  node.append(rows,el('p','field-hint','事件明细最多显示最近 100 条；累计次数包含查询范围内全部已采集记录。'));return node;
}
