import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { join } from 'node:path';
import type { UiQuotaTier, UiQuotaWindowItem, UiQuotaSnapshot } from '../shared/ui-contract.js';
import { startPlanProviderId, type AccountCredentials } from '../accounts/index.js';
import { redact } from '../runtime/zcode-server/events.js';

export const BILLING_BALANCE_URL = 'https://zcode.z.ai/api/v1/zcode-plan/billing/balance';
export const CLIENT_APP_VERSION = '3.16.3';

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function record(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}
function sourceTime(value: unknown, unit: 'ms' | 'unknown' = 'unknown') {
  if (value === null || value === undefined) return null;
  const n = finite(value);
  return n !== null ? { value: n, unit, atMs: unit === 'ms' && n >= 0 ? n : null } : { value: String(value), unit: 'unknown' as const, atMs: null };
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

function usedPercentage(total: number | null, used: number | null, remaining: number | null, officialUsed: number | null = null): number | null {
  let value = officialUsed;
  if (total !== null && total > 0 && used !== null) value = used / total * 100;
  else if (total !== null && total > 0 && remaining !== null) value = (1 - remaining / total) * 100;
  else if (remaining === 0) value = 100;
  return value !== null && Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value)) * 10) / 10 : null;
}
function secondsAsMs(value: unknown): number | null {
  const seconds = finite(value);
  return seconds !== null && seconds >= 0 ? Math.round(seconds * 1000) : null;
}
function windowKind(period: unknown, unit: string): UiQuotaWindowItem['windowType'] {
  if (period === 'hourly') return 'hourly_window';
  if (period === 'daily' || period === 'weekly' || period === 'monthly') return period;
  return unit === 'tokens' ? 'token_pool' : 'custom';
}
function windowUnit(value: unknown): string {
  return value === 'token' || value === 'tokens' ? 'tokens' : value === 'count' || value === 'requests' ? '次' : typeof value === 'string' && value ? value : 'unknown';
}
function resetFields(atMs: number | null, period: unknown, expires: boolean, nowMs: number) {
  const resetKind = period === 'one_time' || expires ? 'expires' as const
    : ['hourly', 'daily', 'weekly', 'monthly'].includes(String(period)) ? 'reset' as const : 'unknown' as const;
  const label = formatResetLabel(atMs, nowMs);
  return { resetsAtMs: atMs, resetKind,
    resetsLabel: label === null ? null : resetKind === 'expires' ? atMs! <= nowMs ? '已到期' : label.replace('重置', '到期')
      : resetKind === 'reset' ? label : atMs! <= nowMs ? '官方时间点已到' : label.replace('重置', '到官方时间点') };
}
function resolveLimits(raw: Record<string, any>, nowMs: number, providerId: string): UiQuotaWindowItem[] {
  const quota = record(raw.quota), data = record(raw.data);
  const balances = [raw.quota_raw, raw.balances, quota.quota_raw, quota.balances, data.quota_raw, data.balances].find(Array.isArray) ?? [];
  if (balances.length) return balances.map((item: any, idx: number) => {
    const total = finite(item.total_units ?? item.total), used = finite(item.used_units ?? item.used);
    const remaining = finite(item.remaining_units ?? item.available_units ?? item.remaining);
    const unit = windowUnit(item.unit_type);
    const plans = [raw.subscription_raw, raw.plans, data.plans].find(Array.isArray) ?? [];
    const plan = plans.find((plan: any) => item.user_plan_id && plan.user_plan_id ? item.user_plan_id === plan.user_plan_id : item.plan_id === plan.plan_id);
    const period = item.period ?? plan?.entitlements?.find((entitlement: any) => entitlement.entitlement_id === item.entitlement_id)?.period;
    const atMs = secondsAsMs(item.expires_at ?? item.period_end ?? raw.quota_reset_at);
    return { id: String(item.bucket_id ?? item.id ?? item.plan_id ?? `balance-${idx}`), name: item.show_name || item.name || item.plan_id || '配额窗口',
      windowType: windowKind(period, unit), total, used, remaining, percentageUsed: usedPercentage(total, used, remaining), unit,
      ...resetFields(atMs, period, item.expires_at !== undefined && !['hourly', 'daily', 'weekly', 'monthly'].includes(String(period)), nowMs) };
  });
  const limits = [quota.limits, data.limits, raw.limits].find(Array.isArray) ?? [];
  if (limits.length) return limits.map((limit: any, idx: number) => {
    const details = record(limit.usageDetails?.[0]);
    // Start Plan limits carry bucket identity and a remaining fraction. Coding Plan
    // percentage is an already-used percentage, even when its numeric value is <= 1.
    const startBucket = typeof limit.bucketId === 'string' || typeof limit.planId === 'string' || limit.unitType === 'token';
    const percent = finite(limit.percentage);
    const officialUsed = percent === null ? null : startBucket && providerId.endsWith('-start-plan') ? (1 - percent) * 100 : percent;
    const total = finite(limit.total ?? limit.number);
    const used = finite(limit.currentValue ?? limit.used ?? limit.usage);
    const remaining = finite(limit.remaining);
    const unit = windowUnit(limit.unitType ?? (limit.type === 'TOKENS_LIMIT' ? 'token' : undefined));
    const name = details.displayName ?? details.modelCode ?? (limit.type === 'TOKENS_LIMIT' ? 'Token 限制' : limit.type === 'TIME_LIMIT' ? '时长限制' : limit.planId ?? '配额窗口');
    const atMs = finite(limit.nextResetTime ?? limit.periodEnd) ?? secondsAsMs(raw.quota_reset_at);
    return { id: String(limit.bucketId ?? limit.type ?? `win-${idx}`), name,
      windowType: windowKind(limit.period, unit), total, used, remaining, percentageUsed: usedPercentage(total, used, remaining, officialUsed), unit,
      ...resetFields(atMs, limit.period, limit.period === 'one_time', nowMs) };
  });
  const rem = record(raw.remaining);
  const total = finite(raw.total ?? raw.quota_total), used = finite(raw.used ?? raw.quota_used), remaining = finite(rem.count ?? raw.remaining ?? raw.quota_remaining);
  const percentage = finite(rem.percentage);
  const officialUsed = percentage !== null && providerId.endsWith('-start-plan') ? (1 - percentage) * 100 : null;
  if (total === null && used === null && remaining === null && officialUsed === null) return [];
  return [{ id: 'main', name: '官方额度摘要', windowType: 'custom', total, used, remaining,
    percentageUsed: usedPercentage(total, used, remaining, officialUsed), unit: 'unknown',
    ...resetFields(finite(rem.nextResetTime) ?? secondsAsMs(raw.quota_reset_at), undefined, false, nowMs) }];
}

export function resolveQuotaSnapshot(params: QuotaResolveParams): UiQuotaSnapshot {
  const raw = record(params.rawQuota);
  const now = Date.now();
  const windows = resolveLimits(raw, now, params.providerId);
  const level = String(record(raw.quota).level ?? record(raw.data).level ?? raw.level ?? '');
  const details = Array.isArray(record(raw.subscription).details) ? record(raw.subscription).details : [];
  const primarySub = details[0] ? record(details[0]) : null;

  const subList = Array.isArray(raw.subscription_raw) ? raw.subscription_raw
    : Array.isArray(raw.plans) ? raw.plans
    : raw.subscription_raw && typeof raw.subscription_raw === 'object' ? [raw.subscription_raw]
    : raw.plans && typeof raw.plans === 'object' ? [raw.plans]
    : [];
  const firstSubValue = subList.find((sub: any) => sub.status?.toLowerCase() === 'active') ?? subList[0];
  const firstSub = firstSubValue ? record(firstSubValue) : null;
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
  const remainingFraction = finite(rem.percentage);
  const percentage = remainingFraction !== null && params.providerId.endsWith('-start-plan')
    ? { value: Math.min(100, Math.max(0, remainingFraction * 100)), scale: '0_to_100' as const }
    : primaryWin?.percentageUsed !== null && primaryWin?.percentageUsed !== undefined
      ? { value: 100 - primaryWin.percentageUsed, scale: '0_to_100' as const } : null;
  const authenticated = typeof params.authenticated === 'boolean' ? params.authenticated : typeof raw.authenticated === 'boolean' ? raw.authenticated : null;
  const resetsAtMs = finite(rem.nextResetTime ?? primaryWin?.resetsAtMs) ?? secondsAsMs(raw.quota_reset_at);

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
    generatedAt: sourceTime(raw.generatedAt ?? raw.updatedAt ?? raw.usage_updated_at, raw.updatedAt !== undefined && raw.generatedAt === undefined ? 'unknown' : 'ms'),
    serverTime: sourceTime(raw.serverTime, 'ms'),
    nextReset: sourceTime(resetsAtMs, 'ms'),
    unit,
    total,
    used,
    remaining,
    percentage,
    authenticated,
    freshness: params.freshness ?? 'unknown',
    // rawSnapshot crosses the daemon → UI boundary; never forward credential-like fields.
    ...(params.rawQuota ? { rawSnapshot: redact(params.rawQuota) } : {}),
  };
}

async function quotaSourceHeaders(): Promise<Record<string, string>> {
  let deviceMid: string | undefined;
  try {
    const state = JSON.parse(await readFile(join(homedir(), '.zcode/v2/telemetry-state.json'), 'utf8'));
    if (typeof state.deviceMid === 'string' && state.deviceMid.trim() && state.deviceMid.length <= 256 && /^[\x20-\x7e]+$/.test(state.deviceMid)) deviceMid = state.deviceMid.trim();
  } catch {}
  // Use the existing physical device identity, just as the official Server does.
  // A missing identity is never replaced with a fabricated or rotated identity.
  return { 'User-Agent': `ZCode/${CLIENT_APP_VERSION}`, 'X-ZCode-App-Version': CLIENT_APP_VERSION,
    'HTTP-Referer': 'https://zcode.z.ai', 'X-Title': 'Z Code@electron', 'X-Platform': `${process.platform}-${process.arch}`,
    'X-Os-Category': process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    'X-Os-Version': release(), 'X-Client-Language': Intl.DateTimeFormat().resolvedOptions().locale,
    'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone, ...(deviceMid ? { 'X-Device-Mid': deviceMid } : {}) };
}

export async function directProbeAccount(account: AccountCredentials, fetchImpl: typeof fetch = globalThis.fetch): Promise<{ accountAlias: string; providerId: string; quota: Record<string, unknown> }> {
  const providerId = startPlanProviderId(account.provider);
  // These imported OAuth accounts use Start Plan, whose authoritative endpoint is
  // billing/balance. The Coding Plan monitor endpoint is a different entitlement.
  const response = await fetchImpl(`${BILLING_BALANCE_URL}?app_version=${CLIENT_APP_VERSION}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { ...await quotaSourceHeaders(), Authorization: `Bearer ${account.zcodeJwtToken}`, 'x-request-id': randomUUID(), Accept: 'application/json' },
  }).catch(() => null);
  if (!response) throw new Error('Start Plan quota query failed with network error');
  let payload: Record<string, any>;
  try { payload = record(await response.json()); } catch { throw new Error(`Start Plan quota query returned invalid JSON (HTTP ${response.status})`); }
  if (!response.ok || payload.code !== 0 || payload.success === false) throw new Error(`Start Plan quota query failed (HTTP ${response.status}, code ${typeof payload.code === 'number' ? payload.code : 'unknown'})`);
  const data = record(payload.data);
  if (!Array.isArray(data.plans) || !Array.isArray(data.balances)) throw new Error('Start Plan quota response lacks plans or balances');
  const serverTime = secondsAsMs(data.server_time);
  const responseDate = Date.parse(response.headers?.get('date') ?? '');
  const nowSeconds = (Number.isFinite(responseDate) ? responseDate : serverTime ?? Date.now()) / 1000;
  const plans = data.plans.map((plan: any) => plan.status?.trim().toLowerCase() === 'active' && Number(plan.ends_at) > 0 && Number(plan.ends_at) <= nowSeconds ? { ...plan, status: 'expired' } : plan);
  const balances = data.balances.filter((balance: any) => {
    const owners = plans.filter((plan: any) => balance.user_plan_id && plan.user_plan_id ? balance.user_plan_id === plan.user_plan_id : balance.plan_id === plan.plan_id);
    return !owners.length || owners.some((plan: any) => plan.status?.trim().toLowerCase() !== 'expired');
  });
  const current = plans.find((plan: any) => plan.status?.trim().toLowerCase() === 'active');
  return { accountAlias: account.alias, providerId, quota: {
    authenticated: true, provider: { id: providerId, name: account.provider === 'zai' ? 'Z.ai - Start Plan' : 'BigModel - Start Plan' },
    generatedAt: Date.now(), ...(serverTime !== null ? { serverTime } : {}),
    ...current ? {} : { unavailableReason: 'no_plan', startPlanExpired: plans.some((plan: any) => plan.status?.trim().toLowerCase() === 'expired') },
    quota_raw: current ? balances : [], subscription_raw: plans,
  } };
}
