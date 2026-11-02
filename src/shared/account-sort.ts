import type { UiQuota, UiQuotaSnapshot } from './ui-contract.js';

export type AccountSortMode = 'quota_first' | 'default';

export interface SortableAccount {
  alias: string;
  health?: string;
  email?: string;
  name?: string;
  quota?: Record<string, any>;
  [key: string]: any;
}

export interface AccountQuotaMetrics {
  rank: 1 | 2 | 3 | 4;
  remainingTokens: number;
  remainingScalar: number;
  minPercentageUsed: number;
  identifier: string;
}

const UNHEALTHY_STATUSES = new Set(['blocked', 'invalid', 'cooling', 'error', 'unhealthy', 'disabled', 'forbidden']);

function num(val: unknown): number | null {
  return typeof val === 'number' && Number.isFinite(val) ? val : null;
}

/**
 * Extracts quota evaluation metrics:
 * Rank 4 (Available > 0) > Rank 3 (Unprobed) > Rank 2 (Exhausted = 0) > Rank 1 (Blocked/Error).
 */
export function extractAccountQuotaMetrics(account: SortableAccount, quota?: UiQuota | null): AccountQuotaMetrics {
  const health = (account.health ?? 'available').toLowerCase();
  const identifier = (account.email || account.alias).toLowerCase();

  if (UNHEALTHY_STATUSES.has(health)) {
    return { rank: 1, remainingTokens: 0, remainingScalar: 0, minPercentageUsed: 100, identifier };
  }

  const snap: UiQuotaSnapshot | null | undefined = quota?.live ?? quota?.imported;
  if (snap) {
    if (snap.windows && snap.windows.length > 0) {
      let hasPositive = false;
      let hasZero = false;
      let maxTokens = 0;
      let maxScalar = 0;
      let minPct = 100;

      for (const w of snap.windows) {
        const rem = num(w.remaining);
        if (rem !== null) {
          if (rem > 0) hasPositive = true;
          else if (rem === 0) hasZero = true;
          if (w.unit === 'tokens' || w.windowType === 'token_pool') maxTokens = Math.max(maxTokens, rem);
          else maxScalar = Math.max(maxScalar, rem);
        }
        const pct = num(w.percentageUsed);
        if (pct !== null) {
          minPct = Math.min(minPct, pct);
          if (pct < 100) hasPositive = true;
        }
      }

      if (hasPositive) return { rank: 4, remainingTokens: maxTokens, remainingScalar: maxScalar, minPercentageUsed: minPct, identifier };
      if (hasZero || minPct >= 100) return { rank: 2, remainingTokens: 0, remainingScalar: 0, minPercentageUsed: 100, identifier };
    }

    const rem = num(snap.remaining);
    if (rem !== null) {
      if (rem > 0) {
        const isTok = snap.unit === 'tokens';
        return { rank: 4, remainingTokens: isTok ? rem : 0, remainingScalar: isTok ? 0 : rem, minPercentageUsed: 0, identifier };
      }
      return { rank: 2, remainingTokens: 0, remainingScalar: 0, minPercentageUsed: 100, identifier };
    }
  }

  const accQuota = account.quota;
  if (accQuota && typeof accQuota === 'object') {
    const raw = Array.isArray(accQuota.quota_raw) ? accQuota.quota_raw : null;
    if (raw && raw.length > 0) {
      let maxTokens = 0;
      let hasPos = false;
      let allZero = true;
      for (const b of raw) {
        const rem = num(b.remaining_units ?? b.available_units);
        if (rem !== null) {
          if (rem > 0) { hasPos = true; allZero = false; maxTokens = Math.max(maxTokens, rem); }
          else if (rem < 0) { allZero = false; }
        }
      }
      if (hasPos) return { rank: 4, remainingTokens: maxTokens, remainingScalar: 0, minPercentageUsed: 0, identifier };
      if (allZero) return { rank: 2, remainingTokens: 0, remainingScalar: 0, minPercentageUsed: 100, identifier };
    }

    const rem = num(accQuota.remaining);
    if (rem !== null) {
      if (rem > 0) return { rank: 4, remainingTokens: rem, remainingScalar: 0, minPercentageUsed: 0, identifier };
      return { rank: 2, remainingTokens: 0, remainingScalar: 0, minPercentageUsed: 100, identifier };
    }
  }

  // Rank 3: Healthy but unprobed
  return { rank: 3, remainingTokens: 0, remainingScalar: 0, minPercentageUsed: 0, identifier };
}

/**
 * Pure function to sort accounts with available quota prioritized.
 */
export function sortAccountsByQuota<T extends SortableAccount>(
  accounts: readonly T[],
  quotas?: Record<string, UiQuota | undefined> | null,
  mode: AccountSortMode = 'quota_first'
): T[] {
  if (mode === 'default' || accounts.length <= 1) return [...accounts];

  const decorated = accounts.map((account, index) => ({
    account,
    metrics: extractAccountQuotaMetrics(account, quotas ? quotas[account.alias] : undefined),
    index,
  }));

  decorated.sort((a, b) => {
    // 1. Primary: Rank descending (4 > 3 > 2 > 1)
    if (b.metrics.rank !== a.metrics.rank) return b.metrics.rank - a.metrics.rank;

    // 2. Secondary within Rank 4: Remaining capacity descending
    if (a.metrics.rank === 4) {
      if (b.metrics.remainingTokens !== a.metrics.remainingTokens) {
        return b.metrics.remainingTokens - a.metrics.remainingTokens;
      }
      if (b.metrics.remainingScalar !== a.metrics.remainingScalar) {
        return b.metrics.remainingScalar - a.metrics.remainingScalar;
      }
      if (a.metrics.minPercentageUsed !== b.metrics.minPercentageUsed) {
        return a.metrics.minPercentageUsed - b.metrics.minPercentageUsed;
      }
    }

    // 3. Tie-breaker: Case-insensitive alphabetical order
    const idDiff = a.metrics.identifier.localeCompare(b.metrics.identifier);
    if (idDiff !== 0) return idDiff;

    // 4. Stable original position
    return a.index - b.index;
  });

  return decorated.map((d) => d.account);
}
