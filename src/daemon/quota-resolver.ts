import { randomUUID } from 'node:crypto';
import type { UiQuotaTier, UiQuotaWindowItem, UiQuotaSnapshot } from '../shared/ui-contract.js';
import type { AccountCredentials } from '../accounts/index.js';

export const QUOTA_LIMIT_URL = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
export const BILLING_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
export const CLIENT_APP_VERSION = '3.16.3';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function sourceTime(value: unknown) {
  if (value === null || value === undefined) return null;
  const n = finite(value);
  return n !== null ? { value: n, unit: 'unknown' as const, atMs: null } : { value: String(value), unit: 'unknown' as const, atMs: null };
}

export function canonicalTier(input?: string | null): UiQuotaTier {
  if (!input) return 'unknown';
  const lower = input.toLowerCase();
  if (lower.includes('max')) return 'max';
  if (lower.includes('pro')) return 'pro';
  if (lower.includes('lite')) return 'lite';
  if (lower.includes('start')) return 'start';
  if (lower.includes('trial')) return 'trial';
  if (lower.includes('free')) return 'free';
  return 'unknown';
}

export function formatResetLabel(resetsAtMs?: number | null, nowMs: number = Date.now()): string | null {
  if (resetsAtMs === null || resetsAtMs === undefined) return null;
  const diffMs = resetsAtMs - nowMs;
  if (diffMs <= 0) return '即将重置';
  if (diffMs < 60_000) return `${Math.max(1, Math.ceil(diffMs / 1000))}秒后重置`;
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}分钟后重置`;
  if (diffMs < 86_400_000) {
    const hours = Math.floor(diffMs / 3_600_000);
    const mins = Math.floor((diffMs % 3_600_000) / 60_000);
    return mins > 0 ? `${hours}小时${mins}分后重置` : `${hours}小时后重置`;
  }
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  return hours > 0 ? `${days}天${hours}小时后重置` : `${days}天后重置`;
}

export interface QuotaResolveParams {
  source: 'imported_snapshot' | 'live_probe';
  accountAlias: string;
  providerId: string;
  observedAtMs?: number | null;
  storedAtMs?: number | null;
  rawQuota?: Record<string, unknown> | null;
  authenticated?: boolean | null;
  freshness?: 'fresh' | 'stale' | 'unknown';
}

function resolveLimits(raw: Record<string, any>, nowMs: number): UiQuotaWindowItem[] {
  const quota = record(raw.quota);
  const data = record(raw.data);
  const balances = Array.isArray(raw.quota_raw) ? raw.quota_raw
    : Array.isArray(raw.balances) ? raw.balances
    : Array.isArray(quota.quota_raw) ? quota.quota_raw
    : Array.isArray(quota.balances) ? quota.balances
    : Array.isArray(data.quota_raw) ? data.quota_raw
    : Array.isArray(data.balances) ? data.balances
    : [];

  if (balances.length > 0) {
    return balances.map((item: any, idx: number) => {
      const name = item.show_name || item.name || item.plan_id || '配额窗口';
      const total = finite(item.total_units ?? item.total);
      const used = finite(item.used_units ?? item.used);
      const remaining = finite(item.remaining_units ?? item.available_units ?? item.remaining);
      let percentageUsed = 0;
      if (total !== null && total > 0 && used !== null) percentageUsed = Math.min(100, Math.max(0, (used / total) * 100));
      else if (total !== null && total > 0 && remaining !== null) percentageUsed = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
      else if (item.percentage !== undefined && item.percentage !== null) {
        const p = Number(item.percentage);
        percentageUsed = p <= 1 ? Math.min(100, Math.max(0, (1 - p) * 100)) : Math.min(100, Math.max(0, p));
      } else if (remaining === 0) percentageUsed = 100;
      const unit = item.unit_type === 'token' ? 'tokens' : (typeof item.unit_type === 'string' && item.unit_type ? item.unit_type : '次');
      const rawReset = finite(item.period_end ?? item.expires_at ?? item.nextResetTime ?? raw.quota_reset_at);
      const resetsAtMs = rawReset !== null ? (rawReset < 1e11 ? Math.round(rawReset * 1000) : rawReset) : null;
      const windowType = item.unit_type === 'token' ? 'token_pool'
        : (item.period === 'hourly' ? 'hourly_window' : item.period === 'daily' ? 'daily' : item.period === 'weekly' ? 'weekly' : item.period === 'monthly' ? 'monthly' : 'custom');
      return {
        id: String(item.bucket_id ?? item.id ?? item.plan_id ?? `balance-${idx}`),
        name,
        windowType,
        total,
        used,
        remaining,
        percentageUsed: Math.round(percentageUsed * 10) / 10,
        unit,
        resetsAtMs,
        resetsLabel: formatResetLabel(resetsAtMs, nowMs),
      };
    });
  }

  const limits = Array.isArray(quota.limits) ? quota.limits : Array.isArray(data.limits) ? data.limits : Array.isArray(raw.limits) ? raw.limits : [];
  if (limits.length > 0) {
    return limits.map((l: any, idx: number) => {
      const details = Array.isArray(l.usageDetails) && l.usageDetails[0] ? record(l.usageDetails[0]) : null;
      const modelName = details?.displayName ?? details?.modelCode ?? null;
      const name = modelName ?? (l.type === 'TOKENS_LIMIT' ? 'Token 限制' : l.type === 'TIME_LIMIT' ? '时长限制' : (l.period === 'one_time' ? '总计配额' : (l.period === 'hourly' || l.unit === 5 ? '5小时限制' : l.planId ?? '配额窗口')));
      const windowType = l.unitType === 'token' ? 'token_pool' : (l.period === 'hourly' || l.unit === 5 ? 'hourly_window' : l.period === 'daily' ? 'daily' : l.period === 'weekly' ? 'weekly' : l.period === 'monthly' ? 'monthly' : 'custom');
      const total = finite(l.total ?? l.number ?? l.unit ?? l.usage);
      const used = finite(l.currentValue ?? l.usage ?? l.used);
      const remaining = finite(l.remaining);
      let percentageUsed = 0;
      if (total !== null && total > 0 && used !== null) percentageUsed = Math.min(100, Math.max(0, (used / total) * 100));
      else if (total !== null && total > 0 && remaining !== null) percentageUsed = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
      else if (l.percentage !== undefined && l.percentage !== null) {
        const p = Number(l.percentage);
        percentageUsed = p <= 1 ? Math.min(100, Math.max(0, (1 - p) * 100)) : Math.min(100, Math.max(0, p));
      } else if (remaining === 0) percentageUsed = 100;
      const unit = l.unitType === 'token' ? 'tokens' : (l.unitType === 'count' ? '次' : (typeof l.unitType === 'string' && l.unitType ? l.unitType : '次'));
      const rawReset = finite(l.nextResetTime ?? l.periodEnd ?? l.period_end ?? raw.quota_reset_at);
      const resetsAtMs = rawReset !== null ? (rawReset < 1e11 ? Math.round(rawReset * 1000) : rawReset) : null;
      return { id: String(l.bucketId ?? l.type ?? `win-${idx}`), name, windowType, total, used, remaining, percentageUsed: Math.round(percentageUsed * 10) / 10, unit, resetsAtMs, resetsLabel: formatResetLabel(resetsAtMs, nowMs) };
    });
  }
  const rem = record(raw.remaining);
  const hasRemaining = rem.count !== undefined || rem.percentage !== undefined || raw.remaining !== undefined;
  if (hasRemaining) {
    const total = finite(raw.total);
    const used = finite(raw.used);
    const remaining = finite(rem.count ?? raw.remaining);
    let percentageUsed = 0;
    if (total !== null && total > 0 && used !== null) percentageUsed = Math.min(100, Math.max(0, (used / total) * 100));
    else if (total !== null && total > 0 && remaining !== null) percentageUsed = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    else if (rem.percentage !== undefined) {
      const p = Number(rem.percentage);
      percentageUsed = p <= 1 ? Math.min(100, Math.max(0, (1 - p) * 100)) : Math.min(100, Math.max(0, p));
    } else if (remaining === 0) percentageUsed = 100;
    const rawReset = finite(rem.nextResetTime ?? raw.quota_reset_at);
    const resetsAtMs = rawReset !== null ? (rawReset < 1e11 ? Math.round(rawReset * 1000) : rawReset) : null;
    return [{ id: 'main', name: '主频配额', windowType: 'hourly_window', total, used, remaining, percentageUsed: Math.round(percentageUsed * 10) / 10, unit: 'tokens', resetsAtMs, resetsLabel: formatResetLabel(resetsAtMs, nowMs) }];
  }
  return [];
}

export function resolveQuotaSnapshot(params: QuotaResolveParams): UiQuotaSnapshot {
  const raw = record(params.rawQuota);
  const now = Date.now();
  const windows = resolveLimits(raw, now);
  const level = String(record(raw.quota).level ?? record(raw.data).level ?? raw.level ?? '');
  const details = Array.isArray(record(raw.subscription).details) ? record(raw.subscription).details : [];
  const primarySub = details[0] ? record(details[0]) : null;

  const subList = Array.isArray(raw.subscription_raw) ? raw.subscription_raw
    : Array.isArray(raw.plans) ? raw.plans
    : raw.subscription_raw && typeof raw.subscription_raw === 'object' ? [raw.subscription_raw]
    : raw.plans && typeof raw.plans === 'object' ? [raw.plans]
    : [];
  const firstSub = subList[0] ? record(subList[0]) : null;
  const subName = firstSub ? (firstSub.name ?? firstSub.show_name ?? firstSub.plan_name ?? firstSub.plan_id) : null;
  const planType = typeof raw.plan_type === 'string' && raw.plan_type.trim() ? raw.plan_type.trim() : null;

  const tierName = primarySub?.productName ?? subName ?? planType ?? (level || null);
  let tier = canonicalTier(primarySub?.productName ?? subName ?? planType ?? level);
  if (tier === 'unknown') {
    tier = canonicalTier(firstSub?.plan_id ?? primarySub?.productId ?? (level || null) ?? params.providerId);
  }

  const rem = record(raw.remaining);
  const primaryWin = windows[0];
  const total = finite(raw.total ?? primaryWin?.total);
  const used = finite(raw.used ?? primaryWin?.used);
  const remaining = finite(rem.count ?? raw.remaining ?? primaryWin?.remaining);
  const percentage = rem.percentage !== undefined && finite(rem.percentage) !== null
    ? { value: rem.percentage, scale: 'unknown' as const }
    : primaryWin ? { value: primaryWin.percentageUsed, scale: '0_to_100' as const } : null;
  const authenticated = typeof params.authenticated === 'boolean' ? params.authenticated : typeof raw.authenticated === 'boolean' ? raw.authenticated : null;
  const resetRaw = finite(rem.nextResetTime ?? primaryWin?.resetsAtMs ?? raw.quota_reset_at);
  const resetsAtMs = resetRaw !== null ? (resetRaw < 1e11 ? Math.round(resetRaw * 1000) : resetRaw) : null;

  let unit: 'credits' | 'tokens' | 'requests' | 'unknown' = 'unknown';
  const winUnit = primaryWin?.unit;
  if (winUnit === 'tokens' || winUnit === 'credits' || winUnit === 'requests') {
    unit = winUnit;
  } else if (winUnit === '次' || winUnit === 'count') {
    unit = 'requests';
  } else if (windows.some(w => w.unit === 'tokens')) {
    unit = 'tokens';
  } else if (windows.some(w => w.unit === '次' || w.unit === 'requests' || w.unit === 'count')) {
    unit = 'requests';
  }

  return {
    source: params.source,
    accountAlias: params.accountAlias,
    providerId: params.providerId,
    observedAtMs: params.observedAtMs ?? null,
    storedAtMs: params.storedAtMs ?? null,
    tier,
    tierName,
    windows,
    generatedAt: sourceTime(raw.generatedAt ?? raw.updatedAt),
    serverTime: sourceTime(raw.serverTime),
    nextReset: sourceTime(resetsAtMs),
    unit,
    total,
    used,
    remaining,
    percentage,
    authenticated,
    freshness: params.freshness ?? 'unknown',
    ...(params.rawQuota ? { rawSnapshot: params.rawQuota } : {}),
  };
}

function isBusinessError(payload: any): boolean {
  if (!payload || typeof payload !== 'object') return true;
  if (payload.code !== undefined && payload.code !== 200 && payload.code !== 0) return true;
  if (payload.success === false) return true;
  return false;
}

export async function directProbeAccount(account: AccountCredentials, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ accountAlias: string; providerId: string; quota: Record<string, unknown> }> {
  const token = account.zcodeJwtToken || account.accessToken;
  const providerId = `account:${account.provider}-start-plan`;
  const requestId = randomUUID();
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': `ZCode/${CLIENT_APP_VERSION}`, 'x-request-id': requestId, Accept: 'application/json' };
  let response = await fetchImpl(QUOTA_LIMIT_URL, { method: 'GET', headers }).catch(() => null);
  let payload: any = null;
  if (response && response.ok) {
    try { payload = await response.json(); } catch { payload = null; }
  }
  if (!payload || isBusinessError(payload)) {
    const fallbackUrl = `${BILLING_BALANCE_URL}?app_version=${CLIENT_APP_VERSION}`;
    const fallbackResponse = await fetchImpl(fallbackUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': `ZCode/${CLIENT_APP_VERSION}` },
    }).catch(() => null);
    if (fallbackResponse && fallbackResponse.ok) {
      try {
        const fallbackPayload = await fallbackResponse.json();
        if (!isBusinessError(fallbackPayload)) {
          payload = fallbackPayload;
        } else if (!payload) {
          payload = fallbackPayload;
        }
      } catch {}
    }
  }
  if (!payload) {
    throw new Error(response ? `Direct quota probe failed with HTTP status ${response.status}` : 'Direct quota probe failed with network error');
  }
  if (isBusinessError(payload)) {
    throw new Error(payload.msg || payload.message || 'Probe returned business error');
  }
  const data = record(payload.data ?? payload);
  return {
    accountAlias: account.alias,
    providerId,
    quota: {
      authenticated: true,
      provider: { id: providerId, name: account.provider === 'zai' ? 'Z.ai - Coding Plan' : 'BigModel - Coding Plan' },
      generatedAt: Date.now(),
      serverTime: Date.now(),
      remaining: record(data.remaining),
      quota: { level: data.level ?? 'Start', limits: data.limits ?? [] },
      subscription: record(data.subscription),
      ...(data.quota_raw || payload.quota_raw ? { quota_raw: data.quota_raw ?? payload.quota_raw } : {}),
      ...(data.balances || payload.balances ? { balances: data.balances ?? payload.balances } : {}),
      ...(data.subscription_raw || payload.subscription_raw ? { subscription_raw: data.subscription_raw ?? payload.subscription_raw } : {}),
      ...(data.plans || payload.plans ? { plans: data.plans ?? payload.plans } : {}),
      raw: payload,
    },
  };
}
