import type { UiTask } from '../../host/types.js';
import type { Child, Children } from './types.js';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Children): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

export function text(value: unknown, fallback = '当前接口未提供'): string {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

export function date(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
}

export function bytes(value: number | null | undefined): string {
  return value == null ? '大小未知' : value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`;
}

export const statusNames: Record<string, string> = {
  queued: '已登记',
  dispatching: '派发中',
  running: '执行中',
  waiting_approval: '等待审批',
  verifying: '核验中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  blocked: '已阻塞',
  interrupted: '观察中断'
};

export function statusLabel(task: UiTask): string {
  return statusNames[task.status] ?? task.status;
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return el('section', 'section', el('h3', '', title), ...children);
}

export function kv(items: [string, unknown][]): HTMLElement {
  const node = el('dl', 'metadata');
  for (const [label, value] of items) {
    node.append(el('div', 'metadata-item', el('dt', '', label), el('dd', '', text(value))));
  }
  return node;
}

export function field(label: string, control: HTMLElement, hint?: string, error?: string): HTMLElement {
  const wrapper = el('div', 'field');
  const id = control.id || `field-${control.dataset.field ?? control.dataset.filter ?? label.replace(/\s/g, '-')}`;
  control.id = id;
  const caption = el('label', '', label);
  caption.htmlFor = id;
  wrapper.append(caption, control);
  if (hint) {
    const node = el('p', 'field-hint', hint);
    node.id = `${id}-hint`;
    control.setAttribute('aria-describedby', node.id);
    wrapper.append(node);
  }
  if (error) {
    const node = el('p', 'field-error', error);
    node.id = `${id}-error`;
    node.setAttribute('role', 'alert');
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute('aria-describedby', `${control.getAttribute('aria-describedby') ?? ''} ${node.id}`.trim());
    wrapper.append(node);
  }
  return wrapper;
}

export function input(value: string, key: string, type = 'text'): HTMLInputElement {
  const node = el('input');
  node.type = type;
  node.value = value;
  node.dataset.field = key;
  node.dataset.focus = key;
  return node;
}

export function select(value: string, key: string, options: [string, string][], filter = false): HTMLSelectElement {
  const node = el('select');
  node.dataset[filter ? 'filter' : 'field'] = key;
  node.dataset.focus = `${filter ? 'filter:' : ''}${key}`;
  for (const [id, title] of options) {
    const option = el('option', '', title);
    option.value = id;
    node.append(option);
  }
  node.value = value;
  return node;
}

export function code(content: string, label: string): HTMLElement {
  const isDiff = /^(diff --git |--- |\+\+\+ |@@ )/m.test(content);
  const codeEl = el('code');
  if (isDiff) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const kind = line.startsWith('@@') ? 'diff-hunk'
        : line.startsWith('+') && !line.startsWith('+++') ? 'diff-add'
        : line.startsWith('-') && !line.startsWith('---') ? 'diff-del'
        : /^(diff --git |index |--- |\+\+\+ |new file|deleted file|similarity |rename )/.test(line) ? 'diff-meta'
        : 'diff-ctx';
      codeEl.append(el('span', `diff-line ${kind}`, line));
      if (i < lines.length - 1) codeEl.append('\n');
    }
  } else {
    codeEl.textContent = content;
  }
  const pre = el('pre', isDiff ? 'code-block diff-block' : 'code-block', codeEl);
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', label);
  pre.dataset.scroll = label;
  return pre;
}

export function heading(kicker: string, title: string, description: string, actions?: HTMLElement): HTMLElement {
  const h = el('h1', '', title);
  h.id = 'page-title';
  h.tabIndex = -1;
  return el('div', 'page-heading', el('div', '', el('p', 'eyebrow', kicker), h, el('p', 'muted', description)), actions);
}
