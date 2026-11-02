import type { RenderContext, Child, ButtonOptions } from './types.js';
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
  node.addEventListener('click', () => ctx.action(action, data));
  return node;
}

export function actionWithReason(
  ctx: RenderContext,
  label: string,
  action: string,
  data: Record<string, string>,
  reason: string | null,
  primary = false,
  busyKey = action,
  options: { icon?: SVGElement; variant?: 'primary' | 'secondary' | 'danger' | 'ghost' } = {}
): HTMLElement {
  const node = el('div', 'action-with-reason', button(ctx, label, action, data, {
    primary,
    variant: options.variant,
    reason,
    busy: ctx.state.pending.has(busyKey),
    icon: options.icon
  }));
  if (reason) node.append(el('p', 'disabled-reason', reason));
  return node;
}
