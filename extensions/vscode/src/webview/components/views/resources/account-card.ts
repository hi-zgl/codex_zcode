import type { UiSnapshot } from '../../../../host/types.js';
import type { UiQuota } from '../../../../../../../src/shared/ui-contract.js';
import { mutationReason } from '../../../state.js';
import { icon } from '../../../icons.js';
import type { RenderContext } from '../../types.js';
import { el } from '../../dom.js';
import { badge, pulseDot } from '../../primitives.js';
import { button } from '../../button.js';
import { renderQuotaWindow, renderQuotaPanel, formatQuotaNumber, renderTierBadge, resolveQuotaUnit } from './quota-panel.js';
import { renderQuotaBar } from './quota-bar.js';

export { renderTierBadge };

/**
 * Maps resource state codes to user-friendly localized labels.
 */
export function resourceState(value: string): string {
  const states: Record<string, string> = {
    ready: '就绪',
    starting: '启动中',
    stopped: '已停止',
    active: '可用',
    archived: '已归档',
    available: '可用',
    unknown: '未确认',
    blocked: '受阻',
    invalid: '无效',
    cooling: '冷却中',
    error: '异常'
  };
  return states[value] ?? value;
}

/** In-memory timestamp tracker for 1-second probe click suppression */
const probeDebounce = new Map<string, number>();

/**
 * Compact embedded quota slot (.row-quota-slot) shown directly in account card.
 */
function renderQuotaSlot(quota: UiQuota | undefined, nowMs: number): HTMLElement {
  const slot = el('div', 'row-quota-slot');
  const snap = quota?.live ?? quota?.imported;

  if (!snap) {
    const hint = el('span', 'field-hint', '尚未探测额度；点击右上角即可查询实时配额');
    slot.append(hint);
    return slot;
  }

  if (snap.windows && snap.windows.length > 0) {
    for (const win of snap.windows.slice(0, 2)) {
      slot.append(renderQuotaWindow(win, nowMs, true));
    }
  } else if (snap.remaining !== null && snap.total !== null && snap.total > 0) {
    const usedPct = ((snap.total - snap.remaining) / snap.total) * 100;
    const isCompact = snap.total >= 100_000;
    const unit = resolveQuotaUnit(snap);
    const barLabel = `${formatQuotaNumber(snap.remaining, isCompact)} / ${formatQuotaNumber(snap.total, isCompact)}`;
    const bar = renderQuotaBar({
      percentageUsed: usedPct,
      compact: true,
      labelOverride: barLabel,
      ariaLabel: `当前额度概览: 余量 ${formatQuotaNumber(snap.remaining)} / 总量 ${formatQuotaNumber(snap.total)}`,
    });
    bar.title = `额度概览：余量 ${formatQuotaNumber(snap.remaining)} / 总量 ${formatQuotaNumber(snap.total)}${unit ? ' ' + unit : ''}`;
    slot.append(bar);
  } else {
    const rem = formatQuotaNumber(snap.remaining);
    const tot = snap.total !== null ? ` / ${formatQuotaNumber(snap.total)}` : '';
    const unit = resolveQuotaUnit(snap);
    const unitDesc = unit ? ` ${unit}` : '';
    const text = `额度快照：${rem}${tot}${unitDesc}`;
    slot.append(el('span', 'field-hint', text));
  }

  return slot;
}

/**
 * Renders an account card with live quota probing, tier badge, and embedded slot.
 */
export function renderAccountCard(
  ctx: RenderContext,
  snapshot: UiSnapshot,
  alias: string,
  nowMs: number = Date.now()
): HTMLElement {
  const account = snapshot.resources.accounts.find(item => item.alias === alias)!;
  const expanded = ctx.state.expandedAccounts.has(alias);
  const quota = snapshot.resources.quotas[alias] as UiQuota | undefined;
  const activeSnapshot = quota?.live ?? quota?.imported;

  const isAvailable = account.health === 'available';
  const healthBadge = badge(
    isAvailable ? [pulseDot(), ` ${resourceState(account.health)}`] : resourceState(account.health),
    ['blocked', 'invalid', 'cooling'].includes(account.health) ? 'attention' : isAvailable ? 'success' : ''
  );

  // Direct Account Probe button with spinner, busy state, and 1s debounce
  const probeBusyKey = `account:${alias}:probe`;
  const isProbeBusy = ctx.state.pending.has(probeBusyKey);
  const probeReason = mutationReason(snapshot, 'quotaProbe');

  const probeBtn = button(
    ctx,
    isProbeBusy ? '探测中...' : '探测额度',
    'account.probe',
    { accountAlias: alias },
    {
      busy: isProbeBusy,
      reason: probeReason,
      icon: !isProbeBusy ? icon('refresh', { size: 11 }) : undefined,
      className: 'btn-mini probe-btn',
    }
  );

  // 1-second click debounce capture listener
  probeBtn.addEventListener('click', (event: MouseEvent) => {
    const now = Date.now();
    const last = probeDebounce.get(alias) ?? 0;
    if (now - last < 1000) {
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    probeDebounce.set(alias, now);
  }, true);

  // Header Title Row with Tier Badge and display name prioritizing email
  const accountDisplayName = account.email || account.name || alias;
  const tierBadge = renderTierBadge(activeSnapshot?.tier);
  const titleBox = el('div', '',
    el('h4', '', accountDisplayName),
    tierBadge,
    account.email ? badge(alias, 'idle') : null,
    el('span', 'muted', ` · ${account.provider}${account.plan ? ` · ${account.plan}` : ''}`)
  );

  const toolbar = el('div', 'section-toolbar',
    titleBox,
    el('div', 'toolbar-actions', probeBtn, healthBadge)
  );

  // Slot embedded directly inside the card
  const slot = renderQuotaSlot(quota, nowMs);

  // Toggle button for expanding quota details
  const toggle = button(
    ctx,
    expanded ? '收起额度明细' : '展开额度明细',
    'account.toggle',
    { alias }
  );
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-controls', `quota-${alias}`);

  const card = el('article', 'resource-card account-card', toolbar, slot, toggle);

  if (expanded) {
    const panel = renderQuotaPanel(ctx, alias, quota, nowMs);
    card.append(panel);
  }

  return card;
}
