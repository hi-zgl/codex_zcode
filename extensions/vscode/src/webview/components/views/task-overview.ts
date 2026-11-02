import type { UiSnapshot, UiTask } from '../../../host/types.js';
import { isActive, mutationReason, safeDetail } from '../../state.js';
import { icon } from '../../icons.js';
import type { RenderContext } from '../types.js';
import { el, date, section, kv, code } from '../dom.js';
import { notice } from '../primitives.js';
import { button, actionWithReason } from '../button.js';
import { emptyCard, messageFor } from '../feedback.js';

export function renderOverview(_ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const detail = safeDetail(snapshot);
  if (!detail) {
    const legacy = snapshot.legacyResult?.result;
    return el('div', '',
      section('安全概况',
        el('p', '', '旧接口仅提供有限只读投影。'),
        legacy?.summary && el('p', '', String(legacy.summary)),
        kv([
          ['任务状态', task.status],
          ['停止证明', task.executionStopped === undefined ? '当前接口未提供' : task.executionStopped ? '已确认' : '尚未确认']
        ])
      )
    );
  }
  const binding = detail.selection.binding;
  const node = el('div', '',
    detail.diagnostic && notice(`${detail.diagnostic.code} · ${detail.diagnostic.message}`, 'warning'),
    section('执行与绑定', kv([
      ['源仓库', detail.workspace.repositoryPath],
      ['执行目录', detail.workspace.worktreePath],
      ['分支', detail.workspace.branch],
      ['起始提交', detail.workspace.baseCommit],
      ['账号 / 服务商', binding ? `${binding.accountAlias} / ${binding.providerId}` : '尚未绑定'],
      ['请求模型', detail.selection.requestedModelId],
      ['已绑定模型', binding?.modelId],
      ['会话 ID', detail.execution.sessionId],
      ['操作 ID', detail.execution.currentCommandId],
      ['运行模式', detail.selection.mode],
      ['会话策略', detail.selection.requestedSession === 'continue' ? '继续最近可复用会话；否则新建' : '新会话'],
      ['观察连接', detail.execution.attachment],
      ['请求 ID', detail.requestId]
    ])),
    section('停止依据', detail.execution.stopProof ? kv([
      ['证明类型', detail.execution.stopProof.kind],
      ['观察时间', date(detail.execution.stopProof.observedAtMs)],
      ['说明', detail.execution.stopProof.evidenceSummary]
    ]) : el('p', 'muted', '尚未取得本次执行的停止证明。请求已收到或结果已返回，都不代表执行已停止。')),
    section('核验策略', detail.verificationPolicy.complete ? detail.verificationPolicy.defaultDiffCheck ? code('git diff --check', '默认核验命令') : el('div', '', ...detail.verificationPolicy.commands.map(command => code(`${command.command} ${command.args.map(arg => JSON.stringify(arg)).join(' ')}\n超时 ${command.timeoutMs}ms`, '核验命令与参数'))) : notice(detail.verificationPolicy.unavailableReason ?? '策略无法完整安全显示，恢复观察不可用。', 'warning'))
  );
  const attempts = el('ol', 'attempt-list');
  for (const attempt of detail.attempts) {
    attempts.append(el('li', '',
      el('strong', '', `执行 ${attempt.index}${detail.currentAttemptIndex === attempt.index ? ' · 当前' : ''}`),
      kv([
        ['操作 ID', attempt.commandId],
        ['请求记录时间', date(attempt.intentAtMs)],
        ['后台回执', attempt.acknowledgedAtMs === null ? '尚未确认；可能已发送' : date(attempt.acknowledgedAtMs)],
        ['结束状态', attempt.terminalState],
        ['失败类别', attempt.failureCategory],
        ['停止证明', attempt.stopProofKind]
      ])
    ));
  }
  node.append(section('执行记录', attempts));
  return node;
}

export function renderTaskControls(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const detail = safeDetail(snapshot)!;
  const actions = el('section', 'task-controls', el('h3', '', '任务操作'));
  const data = { taskId: task.taskId };
  if (detail.controls.reconcile.available || ['interrupted', 'blocked', 'dispatching'].includes(task.status) || (task.leaseHeld && !isActive(task))) {
    const reason = mutationReason(snapshot, 'reconcileTask') ?? (!detail.controls.reconcile.available ? detail.controls.reconcile.reason ?? '当前状态不适用。' : null);
    actions.append(
      actionWithReason(ctx, '核对执行状态', 'reconcile', data, reason, false, `task:${task.taskId}:reconcile`, { icon: icon('sync', { size: 12 }) }),
      el('p', 'field-hint', '不发送模型命令或运行核验；会更新本地任务记录，并可能释放已证实停止的占用。')
    );
  }
  if (detail.controls.resume.available || ['interrupted', 'blocked'].includes(task.status)) {
    const reason = mutationReason(snapshot, 'resumeTask') ?? (!detail.verificationPolicy.complete ? '核验策略尚不能完整安全显示。' : !detail.controls.resume.available ? detail.controls.resume.reason ?? '当前状态不适用。' : null);
    actions.append(
      actionWithReason(ctx, '恢复观察', 'resume', data, reason, true, `task:${task.taskId}:resume`, { icon: icon('play', { size: 12 }) }),
      el('p', 'field-hint', '附着原执行；结束后可能运行既有核验，明确繁忙时可使用剩余的原会话续跑。')
    );
  }
  if (task.status !== 'verifying' && (detail.controls.cancel.available || isActive(task) || ['blocked', 'interrupted'].includes(task.status))) {
    const reason = mutationReason(snapshot, 'cancelTask') ?? (task.cancelRequestedAtMs != null ? '取消意图已记录，等待实际停止确认。' : !detail.controls.cancel.available ? detail.controls.cancel.reason ?? '当前状态不适用。' : null);
    actions.append(
      actionWithReason(ctx, task.cancelRequestedAtMs != null ? '等待停止确认' : '请求取消整个任务', 'cancel', data, reason, false, `task:${task.taskId}:cancel`, { variant: 'danger', icon: icon('circle-slash', { size: 12 }), confirm: { prompt: `取消任务 ${task.taskId}？执行将被要求停止，无法撤销。`, confirmLabel: '确认取消任务' } })
    );
  }
  actions.append(messageFor(ctx, `task:${task.taskId}`) ?? '');
  return actions;
}

export function renderEvents(ctx: RenderContext, task: UiTask): HTMLElement {
  const node = el('div', '',
    el('div', 'section-toolbar',
      el('h3', '', '持久脱敏事件'),
      button(ctx, '从头读取', 'events.read', { taskId: task.taskId, cursor: '0' }, { busy: ctx.state.pending.has(`task:${task.taskId}:events`), icon: icon('refresh', { size: 12 }) })
    ),
    el('p', 'field-hint', '每页 20 条；是否还有更多由 nextCursor 决定。')
  );
  if (!ctx.state.eventsLoaded) {
    node.append(emptyCard('尚未读取事件', '仅按需加载持久事件，不显示 prompt 或原生会话全文。', {
      icon: 'terminal',
      tone: 'info',
      hint: '点击上方“从头读取”按分页拉取脱敏执行轨迹。'
    }));
  }
  const list = el('ol', 'event-list');
  for (const event of ctx.state.events) {
    list.append(el('li', '',
      el('div', 'event-marker', icon('dot', { size: 10 })),
      el('div', '',
        el('div', 'section-toolbar', el('strong', '', event.type ?? '事件'), el('span', 'muted', `rev ${event.revision ?? '—'}`)),
        el('p', 'field-hint', `${date(event.createdAtMs ?? event.createdAt)} · ${event.status ?? '—'}`),
        event.detail != null && code(typeof event.detail === 'string' ? event.detail : JSON.stringify(event.detail, null, 2), '脱敏事件详情')
      )
    ));
  }
  node.append(list);
  if (ctx.state.eventsLoaded && !ctx.state.events.length) {
    node.append(emptyCard('当前页没有事件', '此任务尚未记录任何持久化脱敏执行事件。系统正在平稳运行中。', {
      icon: 'clock',
      hint: '状态流转或核验完成后，可再次点击“从头读取”刷新事件流。'
    }));
  }
  if (ctx.state.eventsCursor !== null) {
    node.append(button(ctx, '继续读取事件', 'events.read', { taskId: task.taskId, cursor: String(ctx.state.eventsCursor) }, { busy: ctx.state.pending.has(`task:${task.taskId}:events`) }));
  }
  node.append(messageFor(ctx, `task:${task.taskId}:events`) ?? '');
  return node;
}
