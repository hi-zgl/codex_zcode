import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sortAccountsByQuota,
  extractAccountQuotaMetrics,
  type SortableAccount,
} from '../../src/shared/account-sort.js';
import type { UiQuota } from '../../src/shared/ui-contract.js';

function mockQuota(opts: {
  remaining?: number | null;
  windows?: Array<{ name: string; remaining?: number | null; percentageUsed?: number; unit?: string }>;
  live?: boolean;
}): UiQuota {
  const snap = {
    source: (opts.live ? 'live_probe' : 'imported_snapshot') as any,
    accountAlias: 'acc',
    providerId: 'zai',
    observedAtMs: Date.now(),
    storedAtMs: Date.now(),
    tier: 'pro' as const,
    tierName: 'Pro',
    windows: (opts.windows ?? []).map((w, idx) => ({
      id: `w-${idx}`,
      name: w.name,
      windowType: (w.unit === 'tokens' ? 'token_pool' : 'hourly_window') as any,
      total: 100,
      used: 0,
      remaining: w.remaining ?? 100,
      percentageUsed: w.percentageUsed ?? 0,
      unit: w.unit ?? '次',
      resetsAtMs: null,
      resetsLabel: null,
    })),
    generatedAt: null,
    serverTime: null,
    nextReset: null,
    unit: 'tokens' as const,
    total: 100,
    used: 0,
    remaining: opts.remaining ?? null,
    percentage: null,
    authenticated: true,
    freshness: 'fresh' as const,
  };
  return {
    accountAlias: 'acc',
    imported: opts.live ? null : snap,
    live: opts.live ? snap : null,
    lastProbe: { state: opts.live ? 'succeeded' : 'never', attemptedAtMs: null, errorCode: null },
    displayFreshnessWindowMs: 60000,
  };
}

test('hierarchy: Rank 4 (available) > Rank 3 (unprobed) > Rank 2 (exhausted) > Rank 1 (blocked)', () => {
  const accounts: SortableAccount[] = [
    { alias: 'acc-blocked', email: 'blocked@test.com', health: 'blocked' },
    { alias: 'acc-exhausted', email: 'zero@test.com', health: 'available' },
    { alias: 'acc-unprobed', email: 'unprobed@test.com', health: 'available' },
    { alias: 'acc-active', email: 'active@test.com', health: 'available' },
  ];

  const quotas: Record<string, UiQuota> = {
    'acc-active': mockQuota({ remaining: 50 }),
    'acc-exhausted': mockQuota({ remaining: 0 }),
  };

  const sorted = sortAccountsByQuota(accounts, quotas, 'quota_first');
  assert.deepEqual(
    sorted.map((a) => a.alias),
    ['acc-active', 'acc-unprobed', 'acc-exhausted', 'acc-blocked']
  );
});

test('Rank 4 secondary sort: descending by token remaining capacity and multi-window', () => {
  const accounts: SortableAccount[] = [
    { alias: 'acc-100m', email: 'b@test.com' },
    { alias: 'acc-500m', email: 'a@test.com' },
    { alias: 'acc-50req', email: 'c@test.com' },
  ];

  const quotas: Record<string, UiQuota> = {
    'acc-100m': mockQuota({
      windows: [{ name: 'GLM-5.3-Flash', remaining: 100_000_000, unit: 'tokens' }],
    }),
    'acc-500m': mockQuota({
      windows: [{ name: 'GLM-5.3-Flash', remaining: 500_000_000, unit: 'tokens' }],
    }),
    'acc-50req': mockQuota({
      windows: [{ name: '5小时限制', remaining: 50, unit: '次' }],
    }),
  };

  const sorted = sortAccountsByQuota(accounts, quotas, 'quota_first');
  assert.deepEqual(
    sorted.map((a) => a.alias),
    ['acc-500m', 'acc-100m', 'acc-50req']
  );
});

test('account offline quota metadata (quota_raw and remaining) is recognized before probe', () => {
  const accounts: SortableAccount[] = [
    { alias: 'acc-offline-0', quota: { remaining: 0 } },
    { alias: 'acc-offline-raw', quota: { quota_raw: [{ remaining_units: 500_000_000 }] } },
    { alias: 'acc-offline-empty' },
  ];

  const sorted = sortAccountsByQuota(accounts, null, 'quota_first');
  assert.deepEqual(
    sorted.map((a) => a.alias),
    ['acc-offline-raw', 'acc-offline-empty', 'acc-offline-0']
  );
});

test('mode default preserves original order', () => {
  const accounts: SortableAccount[] = [
    { alias: 'acc-z', health: 'blocked' },
    { alias: 'acc-a', health: 'available' },
  ];
  const quotas: Record<string, UiQuota> = {
    'acc-a': mockQuota({ remaining: 100 }),
  };

  const sorted = sortAccountsByQuota(accounts, quotas, 'default');
  assert.deepEqual(
    sorted.map((a) => a.alias),
    ['acc-z', 'acc-a']
  );
});

test('tie-breaker: case-insensitive alphabetical by email or alias', () => {
  const accounts: SortableAccount[] = [
    { alias: 'acc-2', email: 'Beta@test.com' },
    { alias: 'acc-1', email: 'alpha@test.com' },
    { alias: 'acc-3', email: 'charlie@test.com' },
  ];

  const sorted = sortAccountsByQuota(accounts, null, 'quota_first');
  assert.deepEqual(
    sorted.map((a) => a.alias),
    ['acc-1', 'acc-2', 'acc-3']
  );
});

test('boundaries: empty list and single item return cleanly', () => {
  assert.deepEqual(sortAccountsByQuota([]), []);
  const single = [{ alias: 'only-one' }];
  assert.deepEqual(sortAccountsByQuota(single), single);
});

test('quota windows or raw buckets without numeric data do not mark an account exhausted', () => {
  const windowsOnly = extractAccountQuotaMetrics(
    { alias: 'a', health: 'available' },
    { live: { windows: [{ windowType: 'token_pool', unit: 'tokens' }] } } as any,
  );
  assert.equal(windowsOnly.rank, 3);
  const rawOnly = extractAccountQuotaMetrics({ alias: 'b', health: 'available', quota: { quota_raw: [{ show_name: 'GLM' }] } });
  assert.equal(rawOnly.rank, 3);
  const exhausted = extractAccountQuotaMetrics(
    { alias: 'c', health: 'available' },
    { live: { windows: [{ windowType: 'token_pool', unit: 'tokens', percentageUsed: 100 }] } } as any,
  );
  assert.equal(exhausted.rank, 2);
});
