import type { UiSnapshot } from '../../../../host/types.js';
import type { UiQuotaSnapshot } from '../../../../../../../src/shared/ui-contract.js';
import { sortAccountsByQuota } from '../../../../../../../src/shared/account-sort.js';
import { mutationReason } from '../../../state.js';
import { icon } from '../../../icons.js';
import type { RenderContext } from '../../types.js';
import { el, section, heading } from '../../dom.js';
import { notice } from '../../primitives.js';
import { button, actionWithReason } from '../../button.js';
import { emptyCard } from '../../feedback.js';
import { renderAccountCard, resourceState, renderTierBadge } from './account-card.js';
import { renderQuotaPanel, renderQuota, renderQuotaWindow, formatResetTime, formatQuotaNumber } from './quota-panel.js';
import { renderQuotaBar, computeBarTheme, shouldInFill, formatPercentage } from './quota-bar.js';
import { renderWorkerSection } from './worker-panel.js';
import { renderWorkspaceSection } from './workspace-panel.js';

/** Active countdown & auto-refresh interval handle */
let tickerTimer: ReturnType<typeof setInterval> | null = null;
let lastAutoRefreshAtMs = 0;

/**
 * Updates all relative countdown elements in the resources view without backend calls.
 * Scans for `[data-resets-at]` attributes and calculates the relative difference.
 */
function updateCountdowns(root: HTMLElement): void {
  const elements = root.querySelectorAll<HTMLElement>('[data-resets-at]');
  const now = Date.now();
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i]!;
    const raw = element.dataset.resetsAt;
    if (!raw) continue;
    const resetsAt = Number(raw);
    if (Number.isFinite(resetsAt)) {
      const kind = element.dataset.resetKind;
      element.textContent = formatResetTime(resetsAt, now, kind === 'reset' || kind === 'expires' ? kind : 'unknown');
    }
  }
}

/**
 * Mounts or keeps alive the local countdown ticker and 60-second auto-probe scheduler.
 * Automatically cleans up interval when root is disconnected from the DOM.
 */
export function scheduleAutoRefreshTicker(root: HTMLElement, ctx: RenderContext): void {
  if (tickerTimer !== null) {
    clearInterval(tickerTimer);
    tickerTimer = null;
  }

  if (lastAutoRefreshAtMs === 0) {
    lastAutoRefreshAtMs = Date.now();
  }

  tickerTimer = setInterval(() => {
    if (!root.isConnected) {
      if (tickerTimer !== null) {
        clearInterval(tickerTimer);
        tickerTimer = null;
      }
      return;
    }

    // A hidden webview neither needs fresh countdown text nor should spend live
    // probes; the next visible tick catches up (the 60s gate is time-based).
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    // 1. Local countdown ticking every interval
    updateCountdowns(root);

    // 2. Auto-probe scheduler every 60 seconds
    const now = Date.now();
    if (now - lastAutoRefreshAtMs >= 60_000) {
      lastAutoRefreshAtMs = now;
      const snap = ctx.state.snapshot;
      if (
        snap &&
        snap.connection.trusted &&
        !snap.connection.stale &&
        snap.connection.capabilities.quotaProbe?.version &&
        !ctx.state.pending.has('accounts.probeAll')
      ) {
        void ctx.action('accounts.probeAll', {});
      }
    }
  }, 10_000);
}

/**
 * Main resources overview page renderer.
 * Coordinates accounts, quotas, workers, and workspace directories.
 */
export function renderResources(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const nowMs = Date.now();

  // Full probe action button with loading state
  const isProbeAllBusy = ctx.state.pending.has('accounts.probeAll');
  const probeAllReason = mutationReason(snapshot, 'quotaProbe');

  const probeAllBtn = button(
    ctx,
    isProbeAllBusy ? '探查中...' : '全量探查额度',
    'accounts.probeAll',
    {},
    {
      busy: isProbeAllBusy,
      reason: probeAllReason,
      icon: !isProbeAllBusy ? icon('refresh', { size: 12 }) : undefined,
      className: 'btn-probe-all'
    }
  );

  const refreshBtn = button(ctx, '刷新资源', 'resources.refresh', {}, {
    busy: ctx.state.pending.has('resources.refresh'),
    icon: icon('refresh', { size: 12 })
  });

  const headerActions = el('div', 'toolbar-actions', probeAllBtn, refreshBtn);

  const headerNode = heading(
    'ZCODE / 额度',
    '额度与资源',
    '查看账号额度与可用资源；可收起各资源区或展开账号详情。Codex 使用同一连接目录。',
    headerActions
  );

  const root = el('div', 'resources-page', headerNode);

  // Accounts & Quotas Section with accurate direct-probe guidance
  const accountHint = el(
    'p',
    'field-hint',
    `全量探查覆盖所有已导入账号，无需先启动执行器；可直接探测单个账号，可见时每 60 秒自动查询。从 ${snapshot.connection.host} 导入 1–100 个 OAuth JSON 文件，按账号身份去重并保留较新快照；导入额度不代表实时余额。`
  );

  const importBtn = actionWithReason(
    ctx,
    '导入账号文件',
    'accounts.import',
    {},
    mutationReason(snapshot, 'importAccounts'),
    false,
    'accounts.import',
    { icon: icon('add', { size: 12 }) }
  );

  const sortMode = ctx.state.accountSortMode ?? 'quota_first';
  const isQuotaFirst = sortMode === 'quota_first';
  const sortBtn = button(
    ctx,
    isQuotaFirst ? '排序：额度优先' : '排序：导入顺序',
    'account.sort',
    { mode: isQuotaFirst ? 'default' : 'quota_first' },
    {
      icon: icon(isQuotaFirst ? 'sort-precedence' : 'list-ordered', { size: 12 }),
      className: isQuotaFirst ? 'btn-sort-toggle active' : 'btn-sort-toggle',
    }
  );

  const accountToolbar = el('div', 'account-toolbar', importBtn, sortBtn);

  const accountsSection = section(
    '账号与额度',
    accountHint,
    accountToolbar,
    ctx.state.importSummary ? notice(ctx.state.importSummary) : null
  );

  const sortedAccounts = sortAccountsByQuota(
    snapshot.resources.accounts,
    snapshot.resources.quotas,
    sortMode
  );

  if (!sortedAccounts.length) {
    accountsSection.append(emptyCard(
      '尚无账号',
      '导入账号后，可为它启动执行器。已有历史任务仍可查看。',
      { icon: 'shield', hint: '支持批量导入 1–100 个 OAuth JSON 凭据文件。' }
    ));
  } else {
    for (const account of sortedAccounts) {
      accountsSection.append(renderAccountCard(ctx, snapshot, account.alias, nowMs));
    }
  }

  const resourceSections = [
    ['accounts', accountsSection, snapshot.resources.accounts.length],
    ['workers', renderWorkerSection(ctx, snapshot), snapshot.resources.workers.length],
    ['workspaces', renderWorkspaceSection(ctx, snapshot), snapshot.resources.workspaces.length]
  ] as const;
  for (const [id, resourceSection, count] of resourceSections) {
    const title = resourceSection.firstElementChild!;
    title.append(`（${count}）`);
    const collapsed = ctx.state.collapsedResourceSections.has(id);
    const content = el('div', 'resource-section-content');
    content.id = `resources-${id}`;
    content.hidden = collapsed;
    content.append(...Array.from(resourceSection.children).slice(1));
    const toggle = button(ctx, collapsed ? '展开' : '收起', 'resources.toggleSection', { section: id });
    toggle.setAttribute('aria-label', `${collapsed ? '展开' : '收起'}${title.textContent}`);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-controls', content.id);
    resourceSection.replaceChildren(el('div', 'section-toolbar resource-section-heading', title, toggle), content);
    root.append(resourceSection);
  }

  // Start lightweight local countdown ticker & 60s auto-probe scheduler
  scheduleAutoRefreshTicker(root, ctx);

  return root;
}

/**
 * Backward compatibility alias for renderAccountCard.
 */
export function renderAccount(ctx: RenderContext, snapshot: UiSnapshot, alias: string): HTMLElement {
  return renderAccountCard(ctx, snapshot, alias);
}

// Re-export all submodules for seamless integration
export {
  resourceState,
  renderTierBadge,
  renderAccountCard,
  renderQuotaPanel,
  renderQuota,
  renderQuotaWindow,
  formatResetTime,
  formatQuotaNumber,
  renderQuotaBar,
  computeBarTheme,
  shouldInFill,
  formatPercentage,
  renderWorkerSection,
  renderWorkspaceSection
};
