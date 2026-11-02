import type { UiQuota, UiQuotaSnapshot, UiQuotaWindowItem, UiQuotaTier } from '../../../../../../../src/shared/ui-contract.js';
import type { RenderContext } from '../../types.js';
import { el, date, kv } from '../../dom.js';
import { button } from '../../button.js';
import { icon } from '../../../icons.js';
import { messageFor } from '../../feedback.js';
import { renderQuotaBar } from './quota-bar.js';

/**
 * Formats a quota numeric value into tabular figures display text.
 * Returns '未知' for invalid numbers, en-US format or compact metric suffix (e.g. 500M).
 */
export function formatQuotaNumber(value: number | null | undefined, compact: boolean = false): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未知';
  if (compact) {
    const abs = Math.abs(value);
    const sign = value < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
    if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
    if (abs >= 10_000) return `${sign}${(abs / 1_000).toFixed(1).replace(/\.0$/, '')}K`;
  }
  return value.toLocaleString('en-US');
}

/** Formats relative reset countdown with tabular figures (e.g., "5小时后重置"). */
export function formatResetTime(resetsAtMs: number | null, nowMs: number = Date.now()): string {
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) return '—';
  const diff = resetsAtMs - nowMs;
  if (diff <= 0) return '已重置';
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `${mins}分钟后重置`;
  // Derive every unit from the same rounded-up minute count so boundaries never read
  // "0小时59分" (59.5 min) or "0天" (23h59.5m).
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}小时${remMins}分后重置` : `${hours}小时后重置`;
  return `${Math.floor(mins / 1_440)}天后重置`;
}

/** Formats relative elapsed time string (e.g., "3分钟前"). */
export function formatTimeAgo(timeMs: number | null, nowMs: number = Date.now()): string {
  if (!timeMs || !Number.isFinite(timeMs)) return '未知时间';
  const diff = Math.max(0, nowMs - timeMs);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}小时前` : `${Math.floor(hours / 24)}天前`;
}

/** Renders subscription tier badge (.tier-b) aligned with zcode-switch. */
export function renderTierBadge(tier: UiQuotaTier | string | undefined): HTMLElement {
  const raw = (tier ?? 'unknown').toLowerCase();
  const known = ['max', 'pro', 'lite', 'start', 'trial', 'free'];
  const matched = known.includes(raw) ? raw : 'other';
  const label = raw === 'unknown' ? 'FREE' : raw.toUpperCase();
  const badgeNode = el('span', `tier-b ${matched}`, label);
  badgeNode.setAttribute('aria-label', `订阅等级: ${label}`);
  return badgeNode;
}

/** Resolves unit label ('次', 'tokens', etc.). Never returns 'unknown' or '单位未知'. */
export function resolveQuotaUnit(snapshot: UiQuotaSnapshot | null | undefined): string {
  if (!snapshot) return '';
  if (snapshot.unit && snapshot.unit !== 'unknown') return snapshot.unit === 'requests' ? '次' : snapshot.unit;
  if (snapshot.windows && snapshot.windows.length > 0) {
    const winUnit = snapshot.windows.find(w => w.unit && w.unit !== 'unknown')?.unit;
    if (winUnit) return winUnit === 'requests' ? '次' : winUnit;
  }
  return '';
}

/** Formats source timestamp safely; returns null if not available or unknown. */
export function formatSourceTime(time: UiQuotaSnapshot['generatedAt']): string | null {
  if (!time) return null;
  if (time.atMs !== null && Number.isFinite(time.atMs)) return date(time.atMs);
  if (time.value !== null && time.value !== undefined && time.value !== 'unknown' && time.value !== '') {
    return `${time.value}（单位 ${time.unit}，不推测日期）`;
  }
  return null;
}

/** Renders an aligned 3-column quota window row (.q-win). */
export function renderQuotaWindow(win: UiQuotaWindowItem, nowMs: number = Date.now(), mini = false): HTMLElement {
  const row = el('div', `q-win ${mini ? 'mini' : ''}`);
  const label = el('span', 'q-win-label', win.name);
  label.title = win.name;

  let barLabel: string | undefined;
  const unitStr = win.unit && win.unit !== 'unknown' ? win.unit : '';
  if (win.remaining !== null && win.total !== null) {
    const isCompact = mini || win.total >= 100_000;
    barLabel = `${formatQuotaNumber(win.remaining, isCompact)} / ${formatQuotaNumber(win.total, isCompact)}`;
  } else if (win.remaining !== null) {
    barLabel = `${formatQuotaNumber(win.remaining, mini)}${unitStr ? ` ${unitStr}` : ''} 剩余`;
  }

  const bar = renderQuotaBar({
    percentageUsed: win.percentageUsed,
    labelOverride: barLabel,
    compact: mini,
    ariaLabel: `${win.name}配额`,
  });
  if (win.remaining !== null || win.total !== null) {
    const unitDesc = unitStr ? ` ${unitStr}` : '';
    bar.title = `${win.name}：余量 ${formatQuotaNumber(win.remaining)} / 总量 ${formatQuotaNumber(win.total)}${unitDesc}`;
  }

  const countdownText = win.resetsLabel ?? formatResetTime(win.resetsAtMs, nowMs);
  const reset = el('span', 'q-win-reset', countdownText);
  if (win.resetsAtMs) reset.dataset.resetsAt = String(win.resetsAtMs);

  row.append(label, bar, reset);
  return row;
}

/** Renders stale cache degradation warning alert (.quota-cache-warning). */
export function renderCacheWarning(accountAlias: string, quota: UiQuota, nowMs: number = Date.now()): HTMLElement | null {
  const snapshot = quota.live ?? quota.imported;
  const isProbeFailed = quota.lastProbe.state === 'failed';
  const isStale = snapshot?.freshness === 'stale';
  if (!snapshot || (!isProbeFailed && !isStale)) return null;

  const isError = isProbeFailed && !quota.live;
  const warning = el('div', `quota-cache-warning ${isError ? 'error' : ''}`);
  warning.setAttribute('role', 'alert');

  const warnIcon = el('span', 'quota-cache-warning-icon', icon(isError ? 'x-circle' : 'alert', { size: 14 }));
  const content = el('div', 'quota-cache-warning-content');
  const title = el('span', 'quota-cache-warning-title', isError ? '云端探测未就绪，当前展示历史快照' : '额度快照已陈旧，建议刷新云端数据');
  const observedStr = snapshot.observedAtMs ? date(snapshot.observedAtMs) : '未知';
  const time = el('span', 'quota-cache-warning-time', `观测于 ${observedStr}（${formatTimeAgo(snapshot.observedAtMs, nowMs)}）`);
  content.append(title, time);

  const retryBtn = el('button', 'quota-cache-warning-btn', '重试探测');
  retryBtn.type = 'button';
  retryBtn.dataset.action = 'account.probe';
  retryBtn.dataset.accountAlias = accountAlias;

  warning.append(warnIcon, content, el('div', 'quota-cache-warning-action', retryBtn));
  return warning;
}

/** Backward-compatible single quota source view (live_probe or imported_snapshot). */
export function renderQuota(
  title: string,
  quota: UiQuotaSnapshot | null,
  freshnessWindowMs: number,
  nowMs: number = Date.now()
): HTMLElement {
  const node = el('div', 'quota-source', el('h5', '', title));
  if (!quota) {
    node.append(el('p', 'muted', title.startsWith('在线') ? '未查询' : '没有导入额度快照'));
    return node;
  }

  const unit = resolveQuotaUnit(quota);
  let freshness = quota.freshness;
  if (quota.source === 'live_probe' && quota.observedAtMs !== null) {
    const age = nowMs - quota.observedAtMs;
    freshness = age < 0 ? 'unknown' : age > freshnessWindowMs ? 'stale' : quota.freshness;
  }

  const valueEl = el('div', 'quota-value', quota.remaining === null ? '余量未知' : formatQuotaNumber(quota.remaining));
  if (unit) valueEl.append(el('span', '', unit));
  node.append(valueEl);

  const kvPairs: [string, string][] = [['来源', quota.source === 'live_probe' ? '在线实时探测' : '导入时快照']];
  if (quota.total !== null || quota.used !== null) {
    kvPairs.push(['总量 / 已用', `${formatQuotaNumber(quota.total)} / ${formatQuotaNumber(quota.used)}`]);
  }
  if (quota.observedAtMs) kvPairs.push(['观测时间', date(quota.observedAtMs)]);
  const genTime = formatSourceTime(quota.generatedAt);
  if (genTime) kvPairs.push(['官方生成时间', genTime]);
  const srvTime = formatSourceTime(quota.serverTime);
  if (srvTime) kvPairs.push(['官方服务器时间', srvTime]);
  const nxtReset = formatSourceTime(quota.nextReset);
  if (nxtReset) kvPairs.push(['下次重置', nxtReset]);
  if (freshness && freshness !== 'unknown') {
    kvPairs.push(['新鲜度', freshness === 'fresh' ? '近期观测' : '陈旧快照']);
  }
  if (kvPairs.length > 0) node.append(kv(kvPairs));

  if (quota.windows && quota.windows.length > 0) {
    const winList = el('div', 'q-items');
    for (const win of quota.windows) winList.append(renderQuotaWindow(win, nowMs));
    node.append(winList);
  } else if (quota.percentage && quota.percentage.scale !== 'unknown') {
    const val = quota.percentage.scale === '0_to_1' ? quota.percentage.value * 100 : quota.percentage.value;
    if (val >= 0 && val <= 100) node.append(renderQuotaBar({ percentageUsed: 100 - val, remainingPercentage: val }));
  }
  return node;
}

/** Renders the unified quota monitoring dashboard (.quota-panel). */
export function renderQuotaPanel(
  ctx: RenderContext,
  accountAlias: string,
  quota: UiQuota | undefined,
  nowMs: number = Date.now()
): HTMLElement {
  const panel = el('div', 'quota-panel');
  panel.id = `quota-${accountAlias}`;

  panel.append(el('div', 'q-head',
    el('span', 'q-eyebrow', 'QUOTA MONITORING / 配额概览'),
    el('span', 'q-who', accountAlias)
  ));

  if (!quota) {
    panel.append(el('p', 'muted', '尚未读取额度记录。账号健康与额度分别判断，不使用旧额度自动派发。'));
    panel.append(button(ctx, '读取已有额度快照（无网络）', 'quota.read', { accountAlias }, { busy: ctx.state.pending.has(`quota:${accountAlias}`) }));
    return panel;
  }

  const warning = renderCacheWarning(accountAlias, quota, nowMs);
  if (warning) panel.append(warning);

  const isLive = Boolean(quota.live);
  const activeSnap = quota.live ?? quota.imported;
  if (activeSnap) {
    const planName = activeSnap.tierName || (activeSnap.tier && activeSnap.tier !== 'unknown' ? `${activeSnap.tier.toUpperCase()} 计划` : '标准配额');
    const sourceBadge = el('span', `q-source-badge ${isLive ? 'live' : 'imported'}`, isLive ? '🟢 在线实时数据' : '📦 导入快照');
    const sourceRow = el('div', 'q-source-row', renderTierBadge(activeSnap.tier), el('span', 'pg-name', planName), sourceBadge);
    if (activeSnap.observedAtMs) {
      sourceRow.append(el('span', 'q-source-time', `观测于 ${date(activeSnap.observedAtMs)}（${formatTimeAgo(activeSnap.observedAtMs, nowMs)}）`));
    }
    panel.append(sourceRow);
  }

  // Windows breakdown list or scalar fallback
  const windows = activeSnap?.windows ?? [];
  if (windows.length > 0) {
    const winList = el('div', 'q-items');
    for (const win of windows) winList.append(renderQuotaWindow(win, nowMs));
    panel.append(winList);
  } else if (activeSnap) {
    const remText = activeSnap.remaining === null ? '余量未知' : formatQuotaNumber(activeSnap.remaining);
    const unit = resolveQuotaUnit(activeSnap);
    const valueEl = el('div', 'quota-value', remText);
    if (unit) valueEl.append(el('span', '', unit));
    panel.append(valueEl);

    if (activeSnap.remaining !== null && activeSnap.total !== null && activeSnap.total > 0) {
      const usedPct = ((activeSnap.total - activeSnap.remaining) / activeSnap.total) * 100;
      const isCompact = activeSnap.total >= 100_000;
      const barLabel = `${formatQuotaNumber(activeSnap.remaining, isCompact)} / ${formatQuotaNumber(activeSnap.total, isCompact)}${unit ? ' ' + unit : ''}`;
      panel.append(renderQuotaBar({ percentageUsed: usedPct, labelOverride: barLabel }));
    }
  }

  // Metadata kv pairs (only fields with actual values, no "未知" empty rows!)
  if (activeSnap) {
    const metaPairs: [string, string][] = [];
    const unit = resolveQuotaUnit(activeSnap);
    if (activeSnap.total !== null && activeSnap.used !== null) {
      metaPairs.push(['总量 / 已用', `${formatQuotaNumber(activeSnap.total)} / ${formatQuotaNumber(activeSnap.used)}${unit ? ' ' + unit : ''}`]);
    }
    const genTime = formatSourceTime(activeSnap.generatedAt);
    if (genTime) metaPairs.push(['官方生成时间', genTime]);
    const srvTime = formatSourceTime(activeSnap.serverTime);
    if (srvTime) metaPairs.push(['官方服务器时间', srvTime]);
    const nxtReset = formatSourceTime(activeSnap.nextReset);
    if (nxtReset) metaPairs.push(['下次重置', nxtReset]);
    if (metaPairs.length > 0) panel.append(el('div', 'q-meta-kv', kv(metaPairs)));
  }

  const lastState = quota.lastProbe.state;
  const statusNote = `最近查询：${lastState === 'never' ? '从未查询' : lastState === 'failed' ? `失败 ${quota.lastProbe.errorCode ?? ''}；保留上次成功值` : '成功'}${quota.lastProbe.attemptedAtMs ? ` · ${date(quota.lastProbe.attemptedAtMs)}` : ''}`;
  panel.append(el('p', lastState === 'failed' ? 'field-error' : 'field-hint', statusNote));

  panel.append(el('div', 'resource-actions',
    button(ctx, '读取已有快照（离线）', 'quota.read', { accountAlias }, { busy: ctx.state.pending.has(`quota:${accountAlias}`) })
  ));

  const feedback = messageFor(ctx, `quota:${accountAlias}`);
  if (feedback) panel.append(feedback);

  return panel;
}
