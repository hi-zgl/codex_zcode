import type { UiSnapshot, UiTask } from '../../../host/types.js';
import type { UiApprovalPreview, UiPermissionReview } from '../../../../../../src/shared/ui-contract.js';
import { approvalDisabled, mutationReason, type ReviewContent } from '../../state.js';
import { icon } from '../../icons.js';
import type { RenderContext } from '../types.js';
import { el, date, bytes, section, kv, code } from '../dom.js';
import { badge, notice } from '../primitives.js';
import { button, actionWithReason } from '../button.js';
import { emptyCard, messageFor } from '../feedback.js';

export function renderApprovals(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const data = snapshot.approvals;
  const node = el('div', '',
    el('div', 'section-toolbar',
      el('h3', '', '待你决定的操作'),
      button(ctx, '刷新审批', 'approvals.list', { taskId: task.taskId }, { busy: ctx.state.pending.has(`task:${task.taskId}:approvals`), icon: icon('refresh', { size: 12 }) })
    )
  );
  node.append(el('p', 'field-hint', '先查看完整操作，再选择批准或拒绝。批准仅限本次；拒绝本项不会取消整个任务。'));
  if (mutationReason(snapshot, 'approvalRead')) node.append(notice(mutationReason(snapshot, 'approvalRead')!, 'warning'));
  if (!data) {
    node.append(emptyCard('正在等待审批列表', '点击“刷新审批”查看当前需要决定的操作。', {
      icon: 'shield',
      tone: 'info',
      hint: '仅完整且受支持的操作快照会在此展示供单次决策。'
    }));
  } else {
    node.append(el('p', 'scope-note', `已载入 ${data.items?.length ?? 0} 项 / 总数 ${data.total === null ? '未知' : data.total} · ${data.stateKnown ? '当前归属已核对' : '原生状态未知'}`));
    if (data.unattributedCount) node.append(notice(`${data.unattributedCount} 项原生交互无法归属到当前任务，未加入可操作清单。`, 'warning'));
    if (!data.stateKnown) node.append(notice('无法可靠读取当前原生归属，所有审批保持只读。可先核对执行状态。', 'warning'));
    const known = new Set<string>();
    for (const item of (data.items ?? []) as UiApprovalPreview[]) {
      known.add(item.approvalId);
      node.append(renderApprovalCard(ctx, task, item, ctx.state.reviews.get(item.approvalId)));
    }
    // Keep ACK cards visible after disappearance: disappearance alone cannot confirm our decision.
    for (const [approvalId, review] of ctx.state.reviews) {
      if (!known.has(approvalId) && review.locked) {
        node.append(renderApprovalCard(ctx, task, {
          approvalId,
          kind: 'permission',
          toolName: null,
          summary: '此操作已不在待审批列表中，答复采用情况仍以后台回执为准。',
          truncated: false,
          sourceComplete: true,
          responseState: review.review.response.state,
          readOnlyReason: null
        }, review));
      }
    }
    if (!data.items?.length && !ctx.state.reviews.size) {
      node.append(emptyCard('当前无待审批高风险操作', '系统正在安全规则下自动平稳运行。任务是否完成，请查看任务状态。', {
        icon: 'shield-check',
        tone: 'success',
        hint: '当执行器请求敏感权限或文件写入时，将在此出现待决卡片。'
      }));
    }
    if (data.nextCursor) {
      node.append(button(ctx, '继续读取审批列表', 'approvals.list', { taskId: task.taskId, cursor: data.nextCursor }, { busy: ctx.state.pending.has(`task:${task.taskId}:approvals`) }));
    }
  }
  node.append(messageFor(ctx, `task:${task.taskId}:approvals`) ?? '');
  return node;
}

export function responseLabel(state: string): string {
  return ({
    none: '待处理',
    intent_recorded: '答复已记录 · 等待确认',
    awaiting_native: '答复已发送 · 等待确认',
    confirmed: '已确认本次答复',
    resolved_unattributed: '已结束 · 采用的答复待确认',
    unknown: '答复结果待确认'
  } as Record<string, string>)[state] ?? state;
}

export function renderApprovalCard(ctx: RenderContext, task: UiTask, item: UiApprovalPreview, content: ReviewContent | undefined): HTMLElement {
  const data = { taskId: task.taskId, approvalId: item.approvalId };
  const descriptor = content?.review;
  const headerTitle = el('div', 'approval-title-wrap',
    icon('shield', { size: 16, className: 'approval-shield-icon' }),
    el('h4', '', item.toolName ?? item.kind)
  );
  const card = el('article', 'approval-card',
    el('div', 'section-toolbar', headerTitle, badge(responseLabel(descriptor?.response.state ?? item.responseState), 'attention')),
    el('code', 'identity-code', item.approvalId),
    el('p', '', item.summary),
    item.truncated && badge('摘要已截断', 'attention')
  );
  const loading = ctx.state.pending.has(`approval:${item.approvalId}`);
  const completeSource = descriptor?.content?.sourceComplete ?? item.sourceComplete;
  const progress = el('p', `approval-read-status ${content?.loadedComplete ? 'complete' : ''}`,
    loading ? '正在加载并校验完整操作…' : content?.loadedComplete ? [icon('check-circle', { size: 13 }), ' 完整操作已加载并校验'] : completeSource ? '当前仅显示摘要。' : '完整来源不可用，此操作仅可查看。'
  );
  progress.setAttribute('role', 'status');
  card.append(progress);
  if (!content) {
    card.append(button(ctx, '查看完整操作', 'approval.open', data, { primary: true, busy: loading }));
  } else {
    const identity = el('details', 'review-identity',
      el('summary', '', '审批归属与校验详情'),
      kv([
        ['任务 / 执行轮次', `${descriptor!.taskId} / ${descriptor!.owner.attemptIndex}`],
        ['操作 ID', descriptor!.owner.commandId],
        ['会话 ID', descriptor!.owner.sessionId],
        ['审阅 ID', descriptor!.reviewId],
        ['审批版本', descriptor!.approvalRevision],
        ['后台版本', descriptor!.nativeRevision],
        ['内容范围', descriptor!.content ? `${bytes(descriptor!.content.totalBytes)} · ${descriptor!.content.schema}` : '无可用来源'],
        ['SHA-256', descriptor!.content?.sha256],
        ['本次审阅有效至', date(descriptor!.expiresAtMs)]
      ])
    );
    identity.dataset.details = `identity:${item.approvalId}`;
    card.append(identity);
    if (descriptor!.redactions.length) {
      card.append(el('p', 'field-hint', `脱敏：${descriptor!.redactions.map(redaction => `${redaction.category}${redaction.decisionRelevant ? '（影响决策，整体只读）' : ''}`).join('、')}`));
    }
    if (content.text) card.append(renderPermissionContent(content.text, item.approvalId));
    card.append(button(ctx, content.locked || !completeSource || descriptor!.readOnlyReason ? '刷新审批状态' : content.loadedComplete ? '重新加载操作' : '查看完整操作', 'approval.open', data, {
      primary: !content.loadedComplete && !content.locked && completeSource && !descriptor!.readOnlyReason,
      busy: loading,
      reason: ctx.state.pending.has(`approval:${item.approvalId}:respond`) ? '正在提交答复，请稍候。' : null
    }));
    if (descriptor!.decisions.length) {
      const decisions = el('div', 'approval-decisions');
      for (const option of descriptor!.decisions) {
        // permission cancel aliases deny; display the verified once/deny pair only.
        if (option.decision === 'cancel') continue;
        const reason = approvalDisabled(ctx.state, content, option.decision);
        const isAccept = option.decision === 'accept';
        decisions.append(actionWithReason(
          ctx,
          isAccept ? '只批准本次操作' : '拒绝本次操作',
          'approval.respond',
          { ...data, decision: option.decision },
          reason,
          isAccept,
          `approval:${item.approvalId}:respond`,
          {
            variant: isAccept ? 'primary' : 'danger',
            icon: isAccept ? icon('check-circle', { size: 13 }) : icon('x-circle', { size: 13 })
          }
        ));
      }
      card.append(decisions);
    } else {
      card.append(notice('此操作暂不能在工作台答复，请在后台原始会话中处理。', 'warning'));
    }
    if (descriptor!.response.actionId) card.append(el('code', 'identity-code', `action: ${descriptor!.response.actionId}`));
    if (content.error) card.append(notice(content.error, 'warning'));
  }
  const readOnly = descriptor?.readOnlyReason ?? item.readOnlyReason;
  if (readOnly) card.append(notice(`只读：${readOnly}`, 'warning'), button(ctx, '查看处理方法', 'guidance.open', { topic: 'approval' }));
  card.append(messageFor(ctx, `approval:${item.approvalId}`) ?? '');
  return card;
}

export function renderPermissionContent(raw: string, approvalId: string): HTMLElement {
  const node = el('div', 'permission-content');
  let parsed: UiPermissionReview;
  try {
    parsed = JSON.parse(raw) as UiPermissionReview;
  } catch {
    node.append(code(raw, `审批 ${approvalId} 完整正文`));
    return node;
  }
  // Presentation only: raw remains unchanged in memory for the Host-bound review identity.
  const payload = parsed.interaction?.payload;
  if (payload?.detail && typeof payload.detail === 'object') {
    const parameters = payload.detail;
    const target = parameters.file_path ?? parameters.path ?? parameters.target ?? parameters.paths;
    node.append(
      section('本次请求的操作', kv([
        ['工具', payload.toolName],
        ['目标', typeof target === 'string' ? target : target === undefined ? '以完整参数为准' : JSON.stringify(target, null, 2)],
        ['执行目录', typeof parameters.cwd === 'string' ? parameters.cwd : parsed.workspacePath],
        ['请求范围', '只允许当前操作一次；不授予永久权限']
      ]), payload.summary && el('p', '', payload.summary))
    );
    const fields = section('完整决策参数');
    for (const [key, value] of Object.entries(parameters)) {
      fields.append(el('h5', 'parameter-label', key), code(typeof value === 'string' ? value : JSON.stringify(value, null, 2), `审批 ${approvalId} 参数 ${key}`));
    }
    node.append(fields);
  }
  const full = el('details', 'review-canonical', el('summary', '', '查看完整审阅 JSON（全部字段）'), code(JSON.stringify(parsed, null, 2), `审批 ${approvalId} 完整审阅 JSON`));
  full.dataset.details = `canonical:${approvalId}`;
  node.append(full);
  return node;
}
