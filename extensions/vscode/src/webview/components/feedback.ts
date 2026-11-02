import { icon, type IconName } from '../icons.js';
import type { RenderContext, EmptyOptions } from './types.js';
import { el } from './dom.js';
import { notice } from './primitives.js';
import { button } from './button.js';

export function empty(title: string, description: string, actionOrOptions?: HTMLElement | EmptyOptions): HTMLElement {
  let action: HTMLElement | undefined;
  let iconName: IconName = 'inbox';
  let isCard = false;
  let toneClass = '';
  let hintText: string | undefined;

  if (actionOrOptions instanceof HTMLElement) {
    action = actionOrOptions;
  } else if (actionOrOptions) {
    action = actionOrOptions.action;
    if (actionOrOptions.icon) iconName = actionOrOptions.icon;
    if (actionOrOptions.card) isCard = true;
    if (actionOrOptions.tone && actionOrOptions.tone !== 'default') toneClass = `empty-tone-${actionOrOptions.tone}`;
    if (actionOrOptions.hint) hintText = actionOrOptions.hint;
  }

  const mark = el('div', 'empty-mark',
    el('div', 'empty-icon-wrapper', icon(iconName, { size: 28, className: 'empty-mark-icon' }))
  );
  const container = el('div', `empty-state${isCard ? ' empty-card' : ''}${toneClass ? ` ${toneClass}` : ''}`,
    mark,
    el('h3', '', title),
    el('p', '', description),
    hintText ? el('p', 'field-hint empty-hint', hintText) : null
  );
  if (action) container.append(action);
  return container;
}

export function emptyCard(title: string, description: string, options: EmptyOptions = {}): HTMLElement {
  return empty(title, description, { ...options, card: true });
}

export function renderActionFeedback(ctx: RenderContext): HTMLElement | null {
  const items = ctx.state.snapshot?.actions.filter(action => !ctx.state.dismissedActions.has(action.key) && (action.phase !== 'succeeded' || action.requestId)) ?? [];
  if (!items.length) return null;
  return el('section', 'action-feedback', ...items.map(action => {
    const titleText = action.phase === 'unknown' ? '结果待确认' : action.phase === 'pending' ? '提交中' : action.phase === 'failed' ? '操作未完成' : '已收到回执';
    const titleIcon = action.phase === 'succeeded' ? icon('check-circle', { size: 14, className: 'toast-icon-svg success' }) :
      action.phase === 'failed' ? icon('alert-circle', { size: 14, className: 'toast-icon-svg failed' }) :
      action.phase === 'pending' ? icon('clock', { size: 14, className: 'toast-icon-svg pending' }) :
      icon('alert', { size: 14, className: 'toast-icon-svg unknown' });

    const dismissBtn = button(
      ctx,
      [icon('x-circle', { size: 14, className: 'toast-dismiss-icon' }), el('span', 'sr-only', '关闭')],
      'dismiss-action-receipt',
      { key: action.key },
      { className: 'toast-dismiss' }
    );
    dismissBtn.setAttribute('aria-label', '关闭回执');
    dismissBtn.title = '关闭回执';

    const header = el('div', 'toast-header',
      el('div', 'toast-title-group',
        el('span', 'toast-icon', titleIcon),
        el('strong', '', titleText)
      ),
      dismissBtn
    );

    const body = el('div', 'toast-body',
      el('p', '', action.message),
      action.requestId ? el('code', '', `request: ${action.requestId}`) : null
    );

    const actions = el('div', 'toast-actions');
    if (action.taskId) {
      actions.append(button(ctx, `查看 ${action.taskId}`, 'task.select', { taskId: action.taskId }));
    }
    if (action.requestId && action.phase === 'unknown') {
      actions.append(button(ctx, '按原请求查询任务', 'dispatch.lookup', { requestId: action.requestId }));
    }

    const receipt = el('div', `action-receipt ${action.phase}`,
      header,
      body,
      actions.childNodes.length ? actions : null
    );
    receipt.setAttribute('role', 'status');
    receipt.setAttribute('aria-live', 'polite');
    receipt.dataset.key = action.key;
    return receipt;
  }));
}

export function messageFor(ctx: RenderContext, key: string): HTMLElement | null {
  const error = ctx.state.errors.get(key);
  return error ? notice(error, 'error') : null;
}
