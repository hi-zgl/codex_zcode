import type { RenderContext, Child, ButtonOptions, ConfirmOptions } from './types.js';
import { el } from './dom.js';
import { spinner } from './primitives.js';

export function button(
  ctx: RenderContext,
  label: Child | Child[],
  action: string,
  data: Record<string, string> = {},
  options: ButtonOptions = {}
): HTMLButtonElement {
  const variantClass = options.variant ? options.variant : options.primary ? 'primary' : '';
  const loadingClass = options.busy ? 'loading' : '';
  const node = el('button', `button ${variantClass} ${loadingClass} ${options.className ?? ''}`.trim());
  if (options.busy) {
    node.append(spinner(12));
  } else if (options.icon) {
    node.append(options.icon);
  }
  if (Array.isArray(label)) {
    for (const child of label) if (child !== null && child !== undefined && child !== false) node.append(child as string | Node);
  } else if (label !== null && label !== undefined && label !== false) {
    node.append(label as string | Node);
  }
  node.type = 'button';
  node.dataset.action = action;
  node.dataset.focus = `${action}:${Object.values(data).join(':')}`;
  for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
  node.disabled = !!options.reason || !!options.busy;
  if (options.busy) {
    node.setAttribute('aria-busy', 'true');
  }
  const toText = (c: unknown): string => typeof c === 'string' ? c : (c && typeof c === 'object' && 'textContent' in c && typeof (c as { textContent: unknown }).textContent === 'string') ? ((c as { textContent: string }).textContent) : '';
  const labelText = typeof label === 'string' ? label : Array.isArray(label) ? label.map(toText).join('').trim() : toText(label) || action;
  if (options.reason) {
    node.title = options.reason;
    node.setAttribute('aria-label', `${labelText}，不可用：${options.reason}`);
  }
  if (options.confirm && !node.disabled) {
    node.dataset.confirm = 'arm';
    node.setAttribute('aria-expanded', 'false');
    node.addEventListener('click', () => ctx.action('confirm.arm', { key: node.dataset.focus! }));
  } else {
    node.addEventListener('click', () => ctx.action(action, data));
  }
  return node;
}

/** Stable key shared by a confirm-guarded button and its armed confirmation. */
export function confirmKey(action: string, data: Record<string, string>): string {
  return `${action}:${Object.values(data).join(':')}`;
}

/**
 * Inline two-step confirmation: the armed state replaces the trigger with a
 * prompt, a danger "confirm" button (same data-focus, so keyboard focus lands
 * on it) and a cancel button. Escape or any other action disarms it.
 */
function armedConfirmation(ctx: RenderContext, label: string, action: string, data: Record<string, string>, confirm: ConfirmOptions, iconNode?: SVGElement): HTMLElement {
  const promptId = `confirm-${confirmKey(action, data).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const prompt = el('span', 'confirm-prompt', confirm.prompt);
  prompt.id = promptId;
  const accept = button(ctx, confirm.confirmLabel, action, data, { variant: 'danger', className: 'armed', icon: iconNode });
  accept.setAttribute('aria-describedby', promptId);
  const cancel = button(ctx, '取消', 'confirm.cancel', { key: confirmKey(action, data) }, { variant: 'ghost' });
  cancel.setAttribute('aria-label', `取消${label}`);
  const group = el('div', 'confirm-group', prompt, accept, cancel);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-labelledby', promptId);
  return group;
}

export function actionWithReason(
  ctx: RenderContext,
  label: string,
  action: string,
  data: Record<string, string>,
  reason: string | null,
  primary = false,
  busyKey = action,
  options: { icon?: SVGElement; variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; confirm?: ConfirmOptions } = {}
): HTMLElement {
  const busy = ctx.state.pending.has(busyKey);
  if (options.confirm && !reason && !busy && ctx.state.armedConfirm === confirmKey(action, data)) {
    return el('div', 'action-with-reason', armedConfirmation(ctx, label, action, data, options.confirm, options.icon));
  }
  const node = el('div', 'action-with-reason', button(ctx, label, action, data, {
    primary,
    variant: options.variant,
    reason,
    busy,
    icon: options.icon,
    confirm: options.confirm
  }));
  if (reason) node.append(el('p', 'disabled-reason', reason));
  return node;
}
