export const QUOTA_PROBE_CONCURRENCY = 4;
export const QUOTA_PROBE_TIMEOUT_MS = 20_000;

export interface QuotaProbeSummary { total: number; succeeded: number; failed: number }

/** Allow each wave to query, recover a failed snapshot, and refresh resource state. */
export function quotaBatchTimeoutMs(accountCount: number): number {
  return Math.max(60_000, Math.ceil(accountCount / QUOTA_PROBE_CONCURRENCY) * (QUOTA_PROBE_TIMEOUT_MS + 20_000) + 35_000);
}
