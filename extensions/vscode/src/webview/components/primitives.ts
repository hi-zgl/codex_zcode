import type { UiTask } from '../../host/types.js';
import { icon, type IconName } from '../icons.js';
import type { Child } from './types.js';
import { el, statusLabel } from './dom.js';

export function badge(content: Child | Child[], tone = ''): HTMLElement {
  return el('span', `badge ${tone}`.trim(), ...(Array.isArray(content) ? content : [content]));
}

export function pulseDot(): HTMLElement {
  const node = el('span', 'pulse-dot');
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function spinner(size = 12): HTMLElement {
  const node = el('span', 'spinner');
  if (size !== 12) {
    node.style.width = `${size}px`;
    node.style.height = `${size}px`;
  }
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function skeleton(width?: string, height?: string, className = ''): HTMLElement {
  const node = el('div', `skeleton ${className}`.trim());
  if (width) node.style.width = width;
  if (height) node.style.height = height;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

export function skeletonCard(): HTMLElement {
  return el('div', 'skeleton-card',
    el('div', 'skeleton-row',
      skeleton('35%', '16px', 'skeleton-text'),
      skeleton('60px', '20px')
    ),
    skeleton('80%', '13px', 'skeleton-text'),
    skeleton('55%', '13px', 'skeleton-text'),
    el('div', 'skeleton-row',
      skeleton('70px', '11px', 'skeleton-text'),
      skeleton('90px', '11px', 'skeleton-text')
    )
  );
}

export function notice(message: string, tone = 'info'): HTMLElement {
  const iconName: IconName = tone === 'warning' ? 'alert' : tone === 'error' ? 'x-circle' : tone === 'success' ? 'check-circle' : 'info';
  const node = el('div', `notice ${tone}`, el('span', 'notice-symbol', icon(iconName, { size: 14 })), el('p', '', message));
  node.setAttribute('role', tone === 'error' ? 'alert' : 'note');
  return node;
}

export function status(task: UiTask, stale = false): HTMLElement {
  let tone = '';
  let statusIcon: Child = null;

  if (['running', 'dispatching', 'verifying'].includes(task.status)) {
    tone = 'running';
    statusIcon = pulseDot();
  } else if (task.status === 'succeeded') {
    tone = 'success';
    statusIcon = icon('check', { size: 11 });
  } else if (task.status === 'failed') {
    tone = 'failed attention';
    statusIcon = icon('x-circle', { size: 11 });
  } else if (['waiting_approval', 'blocked', 'interrupted'].includes(task.status)) {
    tone = 'attention';
    statusIcon = icon('alert-circle', { size: 11 });
  } else if (['cancelled', 'queued'].includes(task.status)) {
    tone = 'idle';
    statusIcon = task.status === 'queued' ? icon('clock', { size: 11 }) : icon('dot', { size: 10 });
  }

  return badge([statusIcon, `${stale ? '上次已知：' : ''}${statusLabel(task)}`], tone);
}
