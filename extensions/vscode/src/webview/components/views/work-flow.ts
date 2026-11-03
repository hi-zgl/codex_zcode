import type { UiSnapshot } from '../../../host/types.js';
import type { WorkView } from '../../../../../../src/shared/work-contract.js';
import type { RenderContext } from '../types.js';
import { el, date, kv, errorObservationLabel, errorObservationReason } from '../dom.js';
import { badge, notice } from '../primitives.js';
import { button } from '../button.js';

const stageNames = { not_started: '未开始', running: '进行中', blocked: '受阻 / 待处理', rework: '返工中', completed: '已确认完成' };
const itemNames: Record<string, string> = { queued: '排队等待账号', dispatching: '派发中', running: '执行中', waiting_approval: '等待审批', verifying: '保存与核验中', succeeded: '实施已完成', failed: '执行失败', cancelled: '已取消', blocked: '受阻', interrupted: '待核实', pending: '未开始', ready: '等待派发', waiting: '等待依赖' };
const acceptanceNames = { running: '验收中', passed: '验收通过', failed: '验收未通过' };

/** Layout only; dependencies never authorize execution or stage completion. */
export function stageLevels(stages: WorkView['stages']): WorkView['stages'][] {
  const levels = new Map<string, number>();
  const remaining = new Set(stages.map(stage => stage.stageId));
  for (let pass = 0; pass < stages.length && remaining.size; pass++) {
    let changed = false;
    for (const stage of stages) {
      if (!remaining.has(stage.stageId) || stage.dependsOn.some(id => !levels.has(id))) continue;
      levels.set(stage.stageId, stage.dependsOn.length ? Math.max(...stage.dependsOn.map(id => levels.get(id)!)) + 1 : 0);
      remaining.delete(stage.stageId); changed = true;
    }
    if (!changed) break;
  }
  const fallback = Math.max(-1, ...levels.values()) + 1;
  for (const id of remaining) levels.set(id, fallback);
  const groups: WorkView['stages'][] = [];
  for (const stage of stages) (groups[levels.get(stage.stageId)!] ??= []).push(stage);
  return groups;
}

function stageCard(ctx: RenderContext, work: WorkView, stage: WorkView['stages'][number]): HTMLElement {
  const confirmed = stage.status === 'completed' && stage.confirmation !== null && !stage.rework;
  const state = confirmed ? 'completed' : stage.rework ? 'rework' : stage.status === 'completed' ? 'running' : stage.status;
  const items = work.items.filter(item => item.stageId === stage.stageId);
  const node = el('details', `stage-node stage-${state}`);
  node.dataset.stageId = stage.stageId; node.dataset.stageState = state;
  node.dataset.details = `stage:${work.workId}:${stage.stageId}`;
  const indicator = el('span', 'stage-indicator', confirmed ? '✓' : state === 'running' ? '●' : ['blocked','rework'].includes(state) ? '!' : '○');
  indicator.setAttribute('aria-hidden', 'true');
  node.append(el('summary', '', el('div', 'stage-title', indicator, el('strong', '', stage.title)),
    el('span', 'stage-state-label', stageNames[state]),
    el('div', 'stage-accounts', ...(stage.accountAliases.length ? stage.accountAliases.map(alias => badge(alias, 'quiet')) : [el('span', 'muted', '尚未分配账号')])),
    el('span', 'stage-expand-label', `${items.length} 项子任务 · 展开查看`)));
  const content = el('div', 'stage-content');
  const dependencies = stage.dependsOn.map(id => work.stages.find(other => other.stageId === id)?.title ?? id);
  if (dependencies.length) content.append(el('p', 'field-hint', `前置阶段：${dependencies.join('、')}`));
  if (stage.blockedReason) content.append(notice(stage.blockedReason, 'warning'));
  if (stage.criteria.length) content.append(el('ul', 'stage-criteria', ...stage.criteria.map(criterion => el('li', '', criterion))));
  const list = el('ul', 'stage-items');
  for (const item of items) {
    const row = el('li', '', el('div', 'section-toolbar', el('strong', '', item.title), badge(item.kind === 'acceptance' ? '验收执行' : '实施', 'quiet')),
      el('p', '', `${itemNames[item.status] ?? item.status} · ${item.accountAlias ?? '等待分配账号'}`));
    if (item.execution?.observation === 'silent') row.append(el('p', 'field-hint', '执行中但静默 · 程序只读核查原任务'));
    if (item.execution?.observation === 'unknown') row.append(el('p', 'field-hint', '执行待核实 · 保留账号占用'));
    if (item.execution?.observation === 'recovering') row.append(el('p', 'field-hint', `恢复等待 · 本段开始 ${date(item.execution.waitingSince)}`));
    if (item.execution) { row.append(el('p','field-hint',`已观测错误 ${item.execution.errorCount} 次 · ${errorObservationLabel(item.execution.nativeErrorsComplete)}`));if(item.execution.nativeErrorsComplete!==true)row.append(el('p','field-hint',errorObservationReason(item.execution.nativeErrorsReason))); }
    if (item.blockedReason) row.append(el('p', 'field-hint', item.blockedReason));
    if (item.taskId) row.append(button(ctx, '查看执行与交付', 'task.select', { taskId: item.taskId }));
    list.append(row);
  }
  if (!items.length) list.append(el('li', 'muted', '指挥尚未交办此阶段的子任务。'));
  content.append(list);
  if (confirmed) content.append(el('p', 'stage-confirmation', `指挥确认：${stage.confirmation!.summary} · ${date(stage.confirmation!.confirmedAt)}`));
  else if (items.length && items.every(item => item.status === 'succeeded')) content.append(el('p', 'field-hint', '子任务已执行完毕，等待指挥确认阶段目标。'));
  node.append(content); return node;
}

function renderStageGraph(ctx: RenderContext, work: WorkView): HTMLElement {
  const levels = stageLevels(work.stages);
  const canvas = el('div', 'stage-diagram'); canvas.dataset.workGraph = work.workId;
  const edges = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); edges.classList.add('stage-edges'); edges.setAttribute('aria-hidden', 'true');
  const marker=document.createElementNS('http://www.w3.org/2000/svg','marker');marker.id='stage-arrow';marker.setAttribute('viewBox','0 0 6 6');marker.setAttribute('refX','5');marker.setAttribute('refY','3');marker.setAttribute('markerWidth','6');marker.setAttribute('markerHeight','6');marker.setAttribute('orient','auto');
  const arrow=document.createElementNS('http://www.w3.org/2000/svg','path');arrow.setAttribute('d','M0,0 L6,3 L0,6 Z');arrow.setAttribute('fill','var(--muted)');marker.append(arrow);const defs=document.createElementNS('http://www.w3.org/2000/svg','defs');defs.append(marker);edges.append(defs);
  for (const stage of work.stages) for (const dependency of stage.dependsOn) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.dataset.from = dependency; path.dataset.to = stage.stageId; path.classList.add('stage-edge'); path.setAttribute('marker-end','url(#stage-arrow)'); edges.append(path);
  }
  const columns = el('div', 'stage-columns'); columns.style.gridTemplateColumns = `repeat(${Math.max(1, levels.length)}, minmax(0, 1fr))`;
  for (const group of levels) columns.append(el('div', 'stage-column', group.length>1?el('span','parallel-label',`并行分支 · ${group.length} 个阶段`):null, ...group.map(stage => stageCard(ctx, work, stage))));
  canvas.append(edges, columns);
  const section = el('section', 'work-flow', el('div', 'section-toolbar', el('h3', '', '任务阶段与账号分配'), el('span', 'muted', `${work.stages.length} 个阶段 · 连线表示真实依赖`)),
    el('div', 'stage-legend', ...Object.entries(stageNames).map(([key, name]) => el('span', `legend-${key}`, name))), canvas);
  if (!work.stages.length) section.append(el('p', 'muted', '指挥尚未登记阶段。'));
  return section;
}

/** Geometry refresh after render, expansion and viewport changes. */
export function drawStageEdges(root: HTMLElement): void {
  for (const canvas of Array.from(root.querySelectorAll<HTMLElement>('[data-work-graph]'))) {
    const svg = canvas.querySelector<SVGSVGElement>('svg.stage-edges'); if (!svg) continue;
    const box = canvas.getBoundingClientRect(); svg.setAttribute('viewBox', `0 0 ${Math.max(1, box.width)} ${Math.max(1, box.height)}`);
    const nodes = new Map(Array.from(canvas.querySelectorAll<HTMLElement>('[data-stage-id]')).map(node => [node.dataset.stageId!, node]));
    for (const path of Array.from(svg.querySelectorAll<SVGPathElement>('path.stage-edge'))) {
      const from = nodes.get(path.dataset.from!)?.getBoundingClientRect(); const to = nodes.get(path.dataset.to!)?.getBoundingClientRect(); if (!from || !to) continue;
      const horizontal = to.left > from.right;
      const x1 = (horizontal ? from.right : from.left + from.width / 2) - box.left;
      const y1 = (horizontal ? from.top + Math.min(from.height / 2, 70) : from.bottom) - box.top;
      const x2 = (horizontal ? to.left : to.left + to.width / 2) - box.left;
      const y2 = (horizontal ? to.top + Math.min(to.height / 2, 70) : to.top) - box.top;
      const mid = (x1 + x2) / 2;
      const branch=Array.from(svg.querySelectorAll<SVGPathElement>('path.stage-edge')).filter(edge=>edge.dataset.from===path.dataset.from).length>1;
      const lane=branch?4:box.width-4;
      path.setAttribute('d', horizontal ? `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}` : `M${x1},${y1} V${y1+8} H${lane} V${y2-8} H${x2} V${y2}`);
    }
  }
}

export function renderWorkOverview(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement | null {
  if (!snapshot.workOverview) return null;
  const works = snapshot.workOverview.works.filter(work => !ctx.state.filters.project || work.repositoryPath === ctx.state.filters.project);
  if (!works.length) return el('section', 'work-empty', el('h2', '', '总任务'), el('p', 'muted', '指挥登记总目标与计划后，此处显示阶段、实施和验收进度。'));
  const work = works.find(item => item.workId === ctx.state.selectedWorkId) ?? works[0]!;
  const selector = el('div', 'work-selector');
  for (const item of works) { const choice = button(ctx, item.goal, 'work.select', { workId: item.workId }, { className: `work-choice ${item.workId === work.workId ? 'selected' : ''}` }); choice.setAttribute('aria-pressed', String(item.workId === work.workId)); selector.append(choice); }
  const implemented = work.items.filter(item => item.kind === 'implementation');
  const activeAcceptances = work.acceptances.filter(acceptance => acceptance.status === 'running'); const latest = work.acceptances.at(-1);
  const node = el('section', 'work-overview',
    el('div', 'section-toolbar', el('h2', '', '总任务与阶段进度'), badge(work.status === 'completed' ? '总任务已确认完成' : work.status === 'cancelled' ? '总任务已取消' : '推进中', work.status === 'completed' ? 'success' : 'quiet')),
    selector, el('h3', 'work-goal', work.goal), kv([['项目', work.repositoryPath], ['当前指挥', work.commanderId], ['本次账号配额', `${work.effectiveAccounts} / 申请 ${work.requestedAccounts}`]]),
    el('div', 'work-facts',
      el('div', 'work-fact', el('strong', '', '实施'), el('p', '', `${implemented.filter(item => item.status === 'succeeded').length} / ${implemented.length} 项执行完成`), el('span', 'muted', '执行结束后保存成果并释放账号')),
      el('div', 'work-fact', el('strong', '', '验收'), el('p', '', activeAcceptances.length ? `${activeAcceptances.length} 项验收中` : latest ? acceptanceNames[latest.status] : '尚未安排'), el('span', 'muted', activeAcceptances.length ? activeAcceptances.map(acceptance => `${acceptance.executor.name}（${acceptance.executor.kind === 'external' ? '外部资源，不占账号' : 'ZCode，占用账号'}）`).join('、') : latest?.executor.name ?? '由指挥按需安排执行者'))), renderStageGraph(ctx, work));
  if(snapshot.workOverviewScope?.workId)node.append(el('p','field-hint','当前定位此总任务；选择项目或共享池可返回对应范围列表。'));
  if (work.next) node.append(el('p', 'work-next', el('strong', '', '下一步：'), work.next));
  if (work.acceptances.length) {
    const details = el('details', 'acceptance-summary', el('summary', '', '验收结论与固定交付')); details.dataset.details = `acceptances:${work.workId}`;
    for (const acceptance of work.acceptances.slice(-10).reverse()) details.append(el('article', '', el('strong', '', `${acceptanceNames[acceptance.status]} · ${acceptance.executor.name}`), el('p', '', acceptance.summary || '等待验收结论'), el('p', 'field-hint', `固定交付 ${acceptance.deliveryId}`), acceptance.workspacePath?(work.status==='active'?el('div','',kv([['本次固定验收目录（临时）',acceptance.workspacePath]]),el('p','field-hint','目录在总任务结束后清理；固定交付引用与工件仍保留。')):el('p','field-hint','总任务已结束，临时验收目录不再作为可用入口；请按固定交付引用查看成果。')):null, acceptance.evidence.length ? el('ul', '', ...acceptance.evidence.map(evidence => el('li', '', evidence))) : null));
    node.append(details);
  }
  if (snapshot.workOverview.truncated) node.append(notice(`当前载入 ${snapshot.workOverview.works.length} / ${snapshot.workOverview.total} 个总任务；更早任务未展开。`));
  return node;
}
