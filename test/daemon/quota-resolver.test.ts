import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalTier,
  formatResetLabel,
  resolveQuotaSnapshot,
  directProbeAccount,
  QUOTA_LIMIT_URL,
  BILLING_BALANCE_URL,
} from '../../src/daemon/quota-resolver.js';
import type { AccountCredentials } from '../../src/accounts/index.js';

test('canonicalTier classifies product and level strings into standardized tiers', () => {
  assert.equal(canonicalTier('GLM-Pro-Coding'), 'pro');
  assert.equal(canonicalTier('Pro Plan'), 'pro');
  assert.equal(canonicalTier('MAX-2026'), 'max');
  assert.equal(canonicalTier('Lite-Subscription'), 'lite');
  assert.equal(canonicalTier('Start Plan'), 'start');
  assert.equal(canonicalTier('Free Trial'), 'trial');
  assert.equal(canonicalTier('free tier'), 'free');
  assert.equal(canonicalTier('RandomString'), 'unknown');
  assert.equal(canonicalTier(null), 'unknown');
  assert.equal(canonicalTier(undefined), 'unknown');
});

test('formatResetLabel formats reset countdown into human-readable string', () => {
  const now = 1_000_000;
  assert.equal(formatResetLabel(null, now), null);
  assert.equal(formatResetLabel(undefined, now), null);
  assert.equal(formatResetLabel(now - 100, now), '即将重置');
  assert.equal(formatResetLabel(now, now), '即将重置');
  assert.equal(formatResetLabel(now + 30_000, now), '30秒后重置');
  assert.equal(formatResetLabel(now + 120_000, now), '2分钟后重置');
  assert.equal(formatResetLabel(now + 3_600_000, now), '1小时后重置');
  assert.equal(formatResetLabel(now + 5_400_000, now), '1小时30分后重置');
  assert.equal(formatResetLabel(now + 90_000_000, now), '1天1小时后重置');
  assert.equal(formatResetLabel(now + 86_400_000, now), '1天后重置');
});

test('resolveQuotaSnapshot normalizes limits into windows and calculates percentageUsed', () => {
  const now = 10_000_000;
  const raw = {
    quota: {
      level: 'Pro',
      limits: [
        {
          type: 'TOKENS_LIMIT',
          unitType: 'token',
          unit: 1000,
          currentValue: 250,
          remaining: 750,
          nextResetTime: now + 3600_000,
        },
        {
          type: 'TIME_LIMIT',
          period: 'hourly',
          unit: 5,
          total: 100,
          used: 80,
          remaining: 20,
        },
      ],
    },
    subscription: {
      details: [{ productName: 'ZCode Pro Tier' }],
    },
  };

  const snapshot = resolveQuotaSnapshot({
    source: 'live_probe',
    accountAlias: 'test-acc',
    providerId: 'account:zai-start-plan',
    observedAtMs: now,
    storedAtMs: now,
    rawQuota: raw,
    freshness: 'fresh',
  });

  assert.equal(snapshot.tier, 'pro');
  assert.equal(snapshot.tierName, 'ZCode Pro Tier');
  assert.equal(snapshot.unit, 'tokens');
  assert.equal(snapshot.windows.length, 2);

  const win0 = snapshot.windows[0];
  assert.equal(win0.name, 'Token 限制');
  assert.equal(win0.windowType, 'token_pool');
  assert.equal(win0.total, 1000);
  assert.equal(win0.used, 250);
  assert.equal(win0.remaining, 750);
  assert.equal(win0.percentageUsed, 25);
  assert.equal(win0.unit, 'tokens');

  const win1 = snapshot.windows[1];
  assert.equal(win1.name, '时长限制');
  assert.equal(win1.windowType, 'hourly_window');
  assert.equal(win1.total, 100);
  assert.equal(win1.used, 80);
  assert.equal(win1.percentageUsed, 80);
});

test('resolveQuotaSnapshot handles fallback when only remaining is present', () => {
  const snapshot = resolveQuotaSnapshot({
    source: 'imported_snapshot',
    accountAlias: 'test-acc',
    providerId: 'account:zai-start-plan',
    rawQuota: {
      total: 200,
      used: 50,
      remaining: { count: 150 },
    },
  });

  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].percentageUsed, 25);
  assert.equal(snapshot.windows[0].total, 200);
  assert.equal(snapshot.windows[0].remaining, 150);
});

test('directProbeAccount invokes quota endpoint with credentials and handles fallback', async () => {
  const account: AccountCredentials = {
    alias: 'acc-1',
    provider: 'zai',
    userId: 'user-1',
    accessToken: 'test-token',
    zcodeJwtToken: 'jwt-token',
    userInfo: {},
    raw: {},
    health: 'available',
  };

  let requestedUrl = '';
  let authHeader = '';

  const mockFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authHeader = (init?.headers as Record<string, string>)?.Authorization ?? '';
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 200,
        data: {
          level: 'Pro',
          limits: [],
          remaining: { count: 50 },
        },
      }),
    } as any;
  };

  const result = await directProbeAccount(account, mockFetch);
  assert.equal(requestedUrl, QUOTA_LIMIT_URL);
  assert.equal(authHeader, 'Bearer jwt-token');
  assert.equal(result.accountAlias, 'acc-1');
  assert.equal(result.providerId, 'account:zai-start-plan');
  assert.equal(result.quota.authenticated, true);

  // Test fallback if primary URL fails
  const mockFallbackFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === QUOTA_LIMIT_URL) {
      return { ok: false, status: 404 } as any;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 200, data: { level: 'Start' } }),
    } as any;
  };

  const fallbackResult = await directProbeAccount(account, mockFallbackFetch);
  assert.equal(fallbackResult.accountAlias, 'acc-1');
});

test('resolveQuotaSnapshot resolves real exported account structures with quota_raw and subscription_raw', () => {
  const raw = {
    plan_type: 'ZCODE WEEKEND BUILD',
    quota_total: 500000000.0,
    quota_used: 0.0,
    quota_remaining: 500000000.0,
    quota_reset_at: 1793581200,
    usage_updated_at: 1793533691188,
    subscription_raw: [
      {
        description: '',
        ends_at: 1793581200,
        entitlements: [
          {
            capabilities: ['model:glm-5.3-flash'],
            effective_at: 1793372400,
            entitlement_id: 'ent-zcode-v3-start-plan-1030-wk-1',
            grant_units: 500000000,
            meter: 'model_usage',
            period: 'one_time',
            priority: 101,
            show_name: 'GLM-5.3-Flash',
            unit_type: 'token',
          },
        ],
        name: 'ZCODE WEEKEND BUILD',
        plan_id: 'zcode-v3-start-plan-1030-wk',
        priority: 101,
        starts_at: 1793371312,
        status: 'active',
        user_plan_id: 'upl_2116178779393183744',
      },
    ],
    quota_raw: [
      {
        available_units: 500000000,
        bucket_id: 'bucket_2116409240354062336',
        capabilities: ['model:glm-5.3-flash'],
        entitlement_id: 'ent-zcode-v3-start-plan-1030-wk-1',
        entitlement_priority: 101,
        expires_at: 1793581200,
        meter: 'model_usage',
        period_end: 1793581200,
        period_start: 1793371312,
        plan_id: 'zcode-v3-start-plan-1030-wk',
        plan_priority: 101,
        priority: 101,
        remaining_units: 500000000,
        show_name: 'GLM-5.3-Flash',
        total_units: 500000000,
        unit_type: 'token',
        used_units: 0,
        user_plan_id: 'upl_2116178779393183744',
      },
    ],
  };

  const snapshot = resolveQuotaSnapshot({
    source: 'imported_snapshot',
    accountAlias: 'acc-real-1',
    providerId: 'account:zai-start-plan',
    rawQuota: raw,
  });

  assert.equal(snapshot.tier, 'start');
  assert.equal(snapshot.tierName, 'ZCODE WEEKEND BUILD');
  assert.equal(snapshot.unit, 'tokens');
  assert.equal(snapshot.windows.length, 1);

  const win = snapshot.windows[0];
  assert.equal(win.name, 'GLM-5.3-Flash');
  assert.equal(win.total, 500_000_000);
  assert.equal(win.used, 0);
  assert.equal(win.remaining, 500_000_000);
  assert.equal(win.unit, 'tokens');
  assert.equal(win.resetsAtMs, 1793581200000);
  assert.equal(win.percentageUsed, 0);
  assert.notEqual(win.resetsLabel, null);
});

test('directProbeAccount throws business error on HTTP 200 with code 500', async () => {
  const account: AccountCredentials = {
    alias: 'acc-err',
    provider: 'zai',
    userId: 'user-err',
    accessToken: 'test-token',
    zcodeJwtToken: 'jwt-token',
    userInfo: {},
    raw: {},
    health: 'available',
  };

  const mockBusinessErrorFetch: typeof fetch = async () => {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        code: 500,
        msg: '当前用户不存在coding plan',
        success: false,
      }),
    } as any;
  };

  await assert.rejects(
    () => directProbeAccount(account, mockBusinessErrorFetch),
    (err: Error) => {
      assert.match(err.message, /当前用户不存在coding plan/);
      return true;
    }
  );
});

