import { crc32 } from 'node:zlib';
import type { ErrorCategory, RuntimeEvent, RuntimeEventType } from '../types.js';

export function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
}

export function redact<T>(value: T): T {
  function walk(entry: unknown, depth: number): unknown {
    if (depth > 20) return '[depth limited]';
    if (typeof entry === 'string') return entry.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]');
    if (Array.isArray(entry)) return entry.map((item) => walk(item, depth + 1));
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).map(([key, item]) =>
      [key, /^(?:token|access_?token|refresh_?token|zcode_?jwt_?token|authorization|cookie|set-cookie|credentials?|api_?key|password|secret|ingressToken)$/i.test(key) ? '[redacted]' : walk(item, depth + 1)]));
    return entry;
  }
  return walk(value, 0) as T;
}

/** Read error fields, never prompt/body text or tool output from an arbitrary row. */
export function classifyError(value: unknown): ErrorCategory {
  const root = record(value);
  if (root.kind && !['error', 'turnHeader'].includes(root.kind)) return 'unknown';
  const parts: string[] = [];
  const visited = new Set<object>();
  let toolError = false;
  let retryAfter = false;
  const scalarFields = ['code', 'errorCode', 'providerErrorCode', 'status', 'statusCode', 'status_code', 'httpStatus', 'message', 'reason', 'detail', 'details', 'underlyingErrorMessage', 'underlyingErrorDetail', 'type'];
  function read(entry: unknown, depth = 0): void {
    if (depth > 8) return;
    if (typeof entry === 'string' || typeof entry === 'number') { parts.push(String(entry).toLowerCase()); return; }
    if (!entry || typeof entry !== 'object' || visited.has(entry)) return;
    visited.add(entry);
    const source = entry instanceof Error ? { ...record(entry), message: entry.message, cause: entry.cause } : record(entry);
    if (source.source === 'tool' || source.toolCallId !== undefined || source.toolName !== undefined) toolError = true;
    if (['retryAfter', 'retry_after', 'retry-after', 'nextRetryAt'].some(key => source[key] !== undefined)) retryAfter = true;
    if (record(source.headers)['retry-after'] !== undefined) retryAfter = true;
    for (const key of scalarFields) if (source[key] !== undefined) read(source[key], depth + 1);
    for (const key of ['error', 'cause', 'attribution', 'response', 'data', 'body']) if (source[key] && typeof source[key] === 'object') read(source[key], depth + 1);
    if (typeof source.error === 'string') read(source.error, depth + 1);
  }
  read(value);
  const data = parts.join('\n');
  if (/\b3012\b|unusual activity|risk[._ -]?block|风控|异常活动/.test(data)) return 'risk_blocked';
  if (/\b401\b|\b403\b|unauthori[sz]ed|token.{0,30}(?:invalid|expired)|invalid.{0,20}(?:token|credential|identity)|鉴权|登录失效|未登录|身份无效/.test(data)) return 'auth_invalid';
  // Quota exhaustion and a provider's explicit wait instruction are not an immediate busy retry.
  if (retryAfter || /retry[ -]?after|retry in \d|insufficient[ _-]?(?:quota|balance|credit)|quota[ _-]?(?:exceeded|exhausted)|billing|额度.{0,12}(?:不足|耗尽|用尽)|余额不足|配额.{0,12}(?:不足|耗尽|用尽)/.test(data)) return 'rate_limited';
  const busyCode = /\b(?:model_busy|model_overloaded|server_busy|server_overloaded|provider_busy|provider_overloaded|overloaded_error|model_at_capacity)\b/.test(data);
  const busyMessage = /\b(?:model|inference(?: server)?|server|service|provider)\s+(?:(?:is|are|currently|temporarily|too|very)\s+)*(?:busy|overloaded|at capacity)\b|\b(?:overloaded|busy)\s+(?:model|inference|server|service|provider)\b|(?:模型|服务|服务器|上游|系统).{0,8}(?:繁忙|过载|负载过高)/.test(data);
  if (!toolError && (busyCode || busyMessage)) return 'model_busy';
  if (/\b429\b|rate[._ -]?limit|too many requests|concurrency[ _-]?(?:limit|exceeded)|并发限制|请求过于频繁|限流/.test(data)) return 'rate_limited';
  if (/\b5[0-9]{2}\b|econnreset|timed? ?out|timeout|upstream|service unavailable|服务.{0,10}(?:异常|不可用)/.test(data)) return 'server_error';
  return 'unknown';
}

export interface TurnFailureClassification {
  category: ErrorCategory;
  errorAttribution: 'turn' | 'unattributed';
  busyRetryEligible: boolean;
  error?: Record<string, any>;
  retryAfterMs?: number;
}

/** Structured provider wait instructions. Never reads prompts, tool output, or guesses timestamp units. */
export function extractRetryAfterMs(value: unknown, nowMs = Date.now()): number | undefined {
  const waits: number[] = [];
  const visited = new Set<object>();
  const add = (value: unknown, multiplier: number) => {
    const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
    if (Number.isFinite(n) && n >= 0 && Number.isFinite(n * multiplier)) waits.push(n * multiplier);
  };
  const standard = (value: unknown) => {
    const before = waits.length;
    add(value, 1000);
    if (before === waits.length && typeof value === 'string' && /GMT$/i.test(value.trim())) {
      const date = Date.parse(value);
      if (Number.isFinite(date)) waits.push(Math.max(0, date - nowMs));
    }
  };
  function read(entry: unknown, depth = 0): void {
    if (depth > 8 || !entry || typeof entry !== 'object' || visited.has(entry)) return;
    visited.add(entry);
    const source = entry instanceof Error ? { ...record(entry), cause: entry.cause } : record(entry);
    if (source.kind && !['error', 'turnHeader'].includes(source.kind) || source.source === 'tool' || source.toolCallId !== undefined || source.toolName !== undefined) return;
    for (const key of ['retryAfterMs', 'retryDelayMs']) add(source[key], 1);
    add(source.retryAfterSeconds, 1000);
    for (const key of ['retryAfter', 'retry_after', 'retry-after']) standard(source[key]);
    for (const key of ['headers', 'responseHeaders']) for (const [name, value] of Object.entries(record(source[key]))) if (name.toLowerCase() === 'retry-after') standard(value);
    for (const key of ['error', 'cause', 'data', 'body', 'response', 'attribution', 'detail', 'details', 'underlyingErrorDetail']) {
      const nested = source[key];
      if (typeof nested === 'string' && nested.length < 32768 && nested.trim().startsWith('{')) {
        try { read(JSON.parse(nested), depth + 1); } catch {}
      } else read(nested, depth + 1);
    }
  }
  read(value);
  return waits.length ? Math.max(...waits) : undefined;
}

function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function turnHeaders(snapshot: Record<string, any>): Array<Record<string, any>> {
  return (Array.isArray(snapshot.rows?.window) ? snapshot.rows.window : []).filter((row: any) => row.kind === 'turnHeader');
}
function attributedToTurn(error: Record<string, any>, header: Record<string, any>, snapshot: Record<string, any>, owner?: Record<string, any>): boolean {
  let explicit = false;
  const identities: Array<{ key: string; value: string }> = [];
  for (const source of [owner, error, record(error.attribution)]) {
    if (!source) continue;
    for (const [key, expected] of [['sourceCommandId', header.sourceCommandId], ['commandId', header.sourceCommandId], ['turnId', header.turnId], ['runtimeTurnId', header.turnId]] as const) {
      if (source[key] === undefined) continue;
      if (typeof source[key] !== 'string' || !expected || source[key] !== expected) return false;
      explicit = true;
      identities.push({ key, value: source[key] });
    }
  }
  if (explicit) return turnHeaders(snapshot).filter(row => identities.every(({ key, value }) =>
    (['sourceCommandId', 'commandId'].includes(key) ? row.sourceCommandId : row.turnId) === value)).length === 1;
  // Official 3.16.3 onTurnError sets lastError.at and failed header.endedAt from
  // the same event.timestamp.getTime(). Do not guess a time window or units.
  return timestamp(error.at) && timestamp(header.startedAt) && timestamp(header.endedAt)
    && header.startedAt <= header.endedAt && error.at === header.endedAt
    && turnHeaders(snapshot).filter(row => row.state === 'failed' && row.endedAt === error.at).length === 1;
}

/** Shared by live terminal events and cold snapshot recovery. Tool rows are never failure evidence. */
export function classifyTurnFailure(snapshot: Record<string, any>, header: Record<string, any>): TurnFailureClassification {
  const unknown: TurnFailureClassification = { category: 'unknown', errorAttribution: 'unattributed', busyRetryEligible: false };
  if (header.kind !== 'turnHeader' || header.state !== 'failed' || typeof header.sourceCommandId !== 'string' || !header.sourceCommandId
    || typeof header.turnId !== 'string' || !header.turnId) return unknown;
  const candidates: Array<{ error: Record<string, any>; owner?: Record<string, any> }> = [];
  if (header.error && typeof header.error === 'object') candidates.push({ error: record(header.error), owner: header });
  for (const row of Array.isArray(snapshot.rows?.window) ? snapshot.rows.window : []) {
    if (row.kind === 'error') candidates.push({ error: { ...row, ...record(row.error) }, owner: row });
  }
  if (snapshot.control?.lastError && typeof snapshot.control.lastError === 'object') candidates.push({ error: record(snapshot.control.lastError) });
  const matched = candidates.filter(candidate => attributedToTurn(candidate.error, header, snapshot, candidate.owner));
  if (!matched.length) return unknown;
  const categories = matched.map(candidate => classifyError(candidate.error));
  const category = (['risk_blocked', 'auth_invalid', 'rate_limited', 'server_error', 'unknown', 'model_busy'] as const).find(category => categories.includes(category))!;
  const retryAfterMs = matched.reduce<number | undefined>((maximum, candidate) => {
    const delay = extractRetryAfterMs(candidate.error);
    return delay === undefined ? maximum : Math.max(maximum ?? 0, delay);
  }, undefined);
  return { category, errorAttribution: 'turn', busyRetryEligible: category === 'model_busy', error: matched[categories.indexOf(category)]!.error, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

/** A logical frame can span multiple RPC notifications. Reject incomplete or corrupt payloads. */
export class TopicAssembler {
  private assemblies = new Map<string, { count: number; bytes: number; checksum: string; topic: string; subscriptionId: string; pieces: Map<number, Buffer> }>();
  accept(value: unknown): Record<string, any> | undefined {
    const wire = record(value);
    if (wire.wireVersion !== 3) throw new Error('Unsupported conversation wire version');
    if (wire.kind === 'complete') {
      const frame = record(wire.frame);
      if (frame.topic !== wire.topic || frame.subscriptionId !== wire.subscriptionId) throw new Error('Conversation frame routing mismatch');
      return frame;
    }
    if (wire.kind !== 'fragment') throw new Error('Unknown conversation frame encoding');
    if (typeof wire.logicalFrameId !== 'string' || !Number.isSafeInteger(wire.fragmentCount) || wire.fragmentCount < 1 || wire.fragmentCount > 4096 ||
      !Number.isSafeInteger(wire.fragmentIndex) || wire.fragmentIndex < 0 || wire.fragmentIndex >= wire.fragmentCount ||
      !Number.isSafeInteger(wire.logicalBytes) || wire.logicalBytes < 1 || wire.logicalBytes > 32 * 1024 * 1024 ||
      typeof wire.dataBase64 !== 'string' || wire.checksum?.algorithm !== 'crc32' || !/^[0-9a-f]{8}$/.test(wire.checksum?.value)) throw new Error('Malformed conversation fragment');
    let assembly = this.assemblies.get(wire.logicalFrameId);
    if (!assembly) {
      if (this.assemblies.size >= 8) throw new Error('Too many incomplete conversation frames');
      assembly = { count: wire.fragmentCount, bytes: wire.logicalBytes, checksum: wire.checksum.value, topic: wire.topic, subscriptionId: wire.subscriptionId, pieces: new Map() };
      this.assemblies.set(wire.logicalFrameId, assembly);
    }
    if (assembly.count !== wire.fragmentCount || assembly.bytes !== wire.logicalBytes || assembly.checksum !== wire.checksum.value || assembly.topic !== wire.topic || assembly.subscriptionId !== wire.subscriptionId) throw new Error('Inconsistent conversation fragment');
    const bytes = Buffer.from(wire.dataBase64, 'base64');
    if (bytes.toString('base64') !== wire.dataBase64) throw new Error('Invalid conversation fragment base64');
    const old = assembly.pieces.get(wire.fragmentIndex);
    if (old && !old.equals(bytes)) throw new Error('Conflicting duplicate conversation fragment');
    assembly.pieces.set(wire.fragmentIndex, bytes);
    if ([...assembly.pieces.values()].reduce((sum, chunk) => sum + chunk.length, 0) > assembly.bytes) throw new Error('Conversation fragment size overflow');
    if (assembly.pieces.size !== assembly.count) return;
    this.assemblies.delete(wire.logicalFrameId);
    const data = Buffer.concat(Array.from({ length: assembly.count }, (_, i) => assembly!.pieces.get(i)!));
    if (data.length !== assembly.bytes || crc32(data).toString(16).padStart(8, '0') !== assembly.checksum) throw new Error('Conversation fragment checksum mismatch');
    const frame = record(JSON.parse(data.toString('utf8')));
    if (frame.topic !== assembly.topic || frame.subscriptionId !== assembly.subscriptionId) throw new Error('Conversation frame routing mismatch');
    return frame;
  }
}

/** Holds a checked tail projection and emits semantic transitions, never command-ACK completion. */
export class ConversationProjection {
  snapshot?: Record<string, any>;
  private rowCommands = new Map<string, string>();
  private rowStates = new Map<number, string>();
  private terminalStates = new Map<number, string>();
  private lastError = '';
  private usage = '';
  private apiRetry = '';
  private nativeOccurrences = new Set<string>();
  private nativePendingFailures = new Map<string, Record<string, any>>();
  private liveNativeTurns = new Set<string>();
  private incompleteNativeTurns = new Set<string>();
  private nativeObservationStates = new Map<string, string>();
  private interactions = new Set<string>();
  private serial = 0;
  readonly history: RuntimeEvent[] = [];
  constructor(readonly sessionId: string, private readonly emit: (event: RuntimeEvent) => void, private readonly maxEvents = 10_000) {}

  get cursor(): string { return String(this.serial); }
  private event(type: RuntimeEventType, data: Record<string, unknown>, turnId?: string, timestamp?: number): void {
    const cursor = String(++this.serial);
    const event: RuntimeEvent = { id: `${this.sessionId}:${cursor}`, cursor, type, sessionId: this.sessionId, ...(turnId ? { turnId } : {}), timestamp: timestamp ?? Date.now(), data: redact(data) };
    this.history.push(event);
    if (this.history.length > this.maxEvents) this.history.shift();
    this.emit(event);
  }
  fault(error: unknown): void {
    for (const nativeTurn of this.liveNativeTurns) this.nativeObservation(nativeTurn, null, 'observation_lost');
    this.liveNativeTurns.clear();
    this.event('error', { message: error instanceof Error ? error.message : String(error), category: classifyError(error), executionUncertain: true });
  }
  apply(frame: Record<string, any>, subscriptionLogEpoch?: string, nativeEvents: unknown[] = [], nativeRead: boolean | { complete: boolean; reason?: string } = false): void {
    const payload = record(frame.payload);
    if (payload.kind === 'snapshot') {
      const snapshot = record(payload.snapshot);
      if (snapshot.sessionId !== this.sessionId || snapshot.logEpoch !== (subscriptionLogEpoch ?? frame.logEpoch ?? snapshot.logEpoch) || snapshot.seq !== frame.toSeq) throw new Error('Conversation snapshot identity or sequence mismatch');
      this.snapshot = structuredClone(snapshot);
      this.event('session_snapshot', { phase: snapshot.control?.phase, revision: snapshot.revision, logEpoch: snapshot.logEpoch, seq: snapshot.seq, tailRows: snapshot.rows?.window?.length ?? 0 });
      for (const row of snapshot.rows?.window ?? []) if (row.kind === 'turnHeader' && row.sourceCommandId) this.rowCommands.set(row.turnId, row.sourceCommandId);
      this.nativeFailures(nativeEvents);
      for (const row of snapshot.rows?.window ?? []) if (row.kind === 'turnHeader') this.nativeObservation(row.turnId, null,
        typeof nativeRead === 'object' && !nativeRead.complete ? nativeRead.reason ?? 'source_read_failed' : 'attached_history_unverified');
      for (const row of snapshot.rows?.window ?? []) this.row(record(row));
      this.state(snapshot);
      return;
    }
    if (payload.kind !== 'deltas' || !Array.isArray(payload.deltas) || !this.snapshot) throw new Error('Conversation deltas arrived without a snapshot');
    if ((subscriptionLogEpoch ?? frame.logEpoch ?? this.snapshot.logEpoch) !== this.snapshot.logEpoch || frame.fromSeq !== this.snapshot.seq || frame.toSeq < frame.fromSeq) throw new Error('Conversation sequence gap; reconcile before continuing');
    let rows = this.snapshot.rows.window as Array<Record<string, any>>;
    const transitions: Array<() => void> = [];
    for (const value of payload.deltas) {
      const delta = record(value);
      if (delta.op === 'row.appended' || delta.op === 'row.upserted') {
        const next = structuredClone(record(delta.row));
        const index = rows.findIndex((row) => row.rowId === next.rowId);
        if (index < 0) rows.push(next); else rows[index] = next;
        rows.sort((a, b) => a.rowId - b.rowId);
        const observed = structuredClone(next);
        if (!this.rowStates.has(next.rowId) && next.kind === 'turnHeader' && next.state === 'running') this.liveNativeTurns.add(next.turnId);
        transitions.push(() => this.row(observed));
      } else if (delta.op === 'row.delta') {
        const row = rows.find((entry) => entry.rowId === delta.rowId);
        if (!row || typeof delta.append !== 'string') throw new Error('Conversation delta targets a missing row');
        const path = delta.path;
        if (typeof path === 'string' && ['text', 'inputText', 'output.text', 'summaryText'].includes(path)) {
          if (path === 'output.text') {
            row.output = { ...record(row.output), text: (typeof row.output?.text === 'string' ? row.output.text : '') + delta.append };
          } else row[path] = (typeof row[path] === 'string' ? row[path] : '') + delta.append;
          if (row.kind === 'assistantText' && path === 'text') {
            const observed = { rowId: row.rowId, text: delta.append, delta: true, runtimeTurnId: row.turnId };
            const owner = { sourceCommandId: row.sourceCommandId, turnId: row.turnId };
            transitions.push(() => this.event('assistant_message', observed, this.turn(owner)));
          }
        }
      } else if (delta.op === 'row.removed') {
        this.snapshot.rows.window = rows = rows.filter((row) => row.rowId < delta.fromRowId);
        for (const id of this.rowStates.keys()) if (id >= delta.fromRowId) { this.rowStates.delete(id); this.terminalStates.delete(id); }
      } else if (delta.op === 'state.updated') {
        Object.assign(this.snapshot, structuredClone(record(delta.patch)));
        transitions.push(() => this.state(record(delta.patch)));
      }
    }
    this.snapshot.seq = frame.toSeq;
    // Revision changes are authoritative state patches when present; sequence is independent.
    if (typeof frame.revision === 'number') this.snapshot.revision = frame.revision;
    for (const row of rows) if (row.kind === 'turnHeader' && row.sourceCommandId) this.rowCommands.set(row.turnId, row.sourceCommandId);
    this.nativeFailures(nativeEvents);
    if (nativeRead) for (const row of rows) if (row.kind === 'turnHeader' && this.liveNativeTurns.has(row.turnId)) {
      const unattributed = this.incompleteNativeTurns.has(row.turnId);
      const complete = (typeof nativeRead === 'object' ? nativeRead.complete : nativeRead) && !unattributed;
      this.nativeObservation(row.turnId, complete ? true : null, complete ? 'live_turn_observed' : unattributed ? 'unattributed_native_error' : typeof nativeRead === 'object' ? nativeRead.reason ?? 'source_read_failed' : 'source_read_failed');
    }
    // Official onTurnError emits the header before control.lastError in one batch.
    // Observe the checked complete batch before emitting any terminal transition.
    for (const transition of transitions) transition();
  }
  private turn(row: Record<string, any>): string | undefined { return row.sourceCommandId ?? this.rowCommands.get(row.turnId); }
  private nativeObservation(nativeTurn: string, complete: true | null, reason: string): void {
    const commandId = this.rowCommands.get(nativeTurn);
    if (!commandId) return;
    const signature = `${complete}:${reason}`;
    if (this.nativeObservationStates.get(nativeTurn) === signature) return;
    this.nativeObservationStates.set(nativeTurn, signature);
    this.event('runtime_status', { kind: 'native_error_observation', complete, reason }, commandId);
  }
  /** Whitelist actual native failures, never token deltas, headers or request bodies. */
  private nativeFailures(values: unknown[]): void {
    const pending = this.nativePendingFailures;
    const schedules = new Map<string, { delayMs: number; nextRetryAt: number }>();
    for (const value of values) {
      const event = record(value), payload = record(event.payload);
      if (event.sessionId === this.sessionId && event.type === 'session.updated' && payload.type === 'model_retry_scheduled'
        && typeof payload.requestId === 'string' && Number.isFinite(payload.delayMs) && payload.delayMs >= 0 && timestamp(event.timestamp)) {
        schedules.set(`${event.turnId}\0${payload.requestId}\0${payload.attempt}`, { delayMs: payload.delayMs, nextRetryAt: event.timestamp + payload.delayMs });
      }
    }
    for (const value of values) {
      const event = record(value), payload = record(event.payload);
      if (event.sessionId !== this.sessionId || typeof event.eventId !== 'string' || !event.eventId) continue;
      const matching = turnHeaders(this.snapshot!).filter(header => typeof event.sourceCommandId === 'string' && header.sourceCommandId === event.sourceCommandId);
      const nativeTurn = typeof event.turnId === 'string' ? event.turnId : matching.length === 1 ? matching[0]!.turnId : undefined;
      if (payload.type === 'model_request_started' || payload.type === 'model_request_completed') {
        if (nativeTurn) pending.delete(nativeTurn);
      }
      if (event.type === 'session.updated' && payload.type === 'model_request_failed') {
        const occurrenceKey = `native-model:${event.eventId}`;
        const category = classifyError(payload);
        if (nativeTurn) pending.set(nativeTurn, { reason: payload.reason, statusCode: payload.statusCode, retryable: payload.retryable, occurrenceKey, category });
        if (this.nativeOccurrences.has(occurrenceKey)) continue;
        this.nativeOccurrences.add(occurrenceKey);
        const commandId = nativeTurn && this.rowCommands.get(nativeTurn);
        if (!commandId) for (const active of this.liveNativeTurns) this.incompleteNativeTurns.add(active);
        const reasonCode = typeof payload.reason === 'string' && /^[a-z0-9_.-]{1,160}$/i.test(payload.reason) ? payload.reason : 'unknown';
        const retryAfterMs = extractRetryAfterMs(payload);
        const schedule = schedules.get(`${event.turnId}\0${payload.requestId}\0${payload.attempt}`);
        this.event('error', { origin: 'native_model_request', occurrenceKey, category, reasonCode,
          errorAttribution: commandId ? 'turn' : 'unattributed', busyRetryEligible: false,
          ...(typeof payload.requestId === 'string' ? { nativeRequestId: payload.requestId } : {}),
          ...(Number.isSafeInteger(payload.attempt) ? { attempt: payload.attempt } : {}),
          ...(Number.isSafeInteger(payload.maxAttempts) ? { maxAttempts: payload.maxAttempts } : {}),
          ...(Number.isSafeInteger(payload.statusCode) ? { statusCode: payload.statusCode } : {}),
          ...(typeof payload.retryable === 'boolean' ? { nativeRetryable: payload.retryable } : {}),
          ...(schedule ? { nativeRetryDelayMs: schedule.delayMs, nextRetryAt: schedule.nextRetryAt } : {}),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }, commandId || undefined, event.timestamp);
      }
    }
  }
  private occurrence(header: Record<string, any> | undefined, category: ErrorCategory, error?: Record<string, any>): Record<string, string> {
    const native = header && this.nativePendingFailures.get(header.turnId), attribution = record(error?.attribution);
    // Merge only the same explicit final provider/network failure, never an
    // unrelated tool/runtime error or a recovered intermediate request.
    return native?.category === category && native.retryable === false && ['provider', 'network'].includes(attribution.source)
      && typeof attribution.reason === 'string' && attribution.reason === native.reason && attribution.statusCode === native.statusCode
      ? { occurrenceKey: native.occurrenceKey } : {};
  }
  private row(row: Record<string, any>): void {
    if (typeof row.rowId !== 'number') throw new Error('Conversation row has no numeric ID');
    if (row.kind === 'turnHeader' && row.sourceCommandId) this.rowCommands.set(row.turnId, row.sourceCommandId);
    const signature = JSON.stringify(row);
    const previous = this.rowStates.get(row.rowId);
    if (previous === signature) return;
    this.rowStates.set(row.rowId, signature);
    const turnId = this.turn(row);
    const data = { ...row, runtimeTurnId: row.turnId };
    if (row.kind === 'turnHeader') {
      if (row.state === 'running') { this.terminalStates.delete(row.rowId); if (!previous) this.event('turn_started', data, turnId, row.startedAt); }
      if (row.state !== 'running' && this.terminalStates.get(row.rowId) !== row.state) {
        this.terminalStates.set(row.rowId, row.state);
        if (row.state === 'completedSuccess') this.event('turn_completed', data, turnId, row.endedAt);
        if (row.state === 'failed') {
          const failure = classifyTurnFailure(this.snapshot!, row);
          this.event('turn_failed', { ...data, ...failure, ...this.occurrence(row, failure.category, failure.error) }, turnId, row.endedAt);
        }
        if (row.state === 'completedInterrupted') this.event('turn_cancelled', data, turnId, row.endedAt);
        this.liveNativeTurns.delete(row.turnId);
      }
    } else if (row.kind === 'assistantText') this.event('assistant_message', { ...data, delta: false }, turnId);
    else if (row.kind === 'toolCall') this.event(['success', 'error', 'cancelled'].includes(row.status) ? 'tool_result' : 'tool_call', data, turnId);
    else if (row.kind === 'error') {
      const headers = turnHeaders(this.snapshot!).filter(header => attributedToTurn({ ...row, ...record(row.error) }, header, this.snapshot!, row));
      const owner = headers.length === 1 ? headers[0] : undefined;
      const category = classifyError(row);
      this.event('error', { ...data, category, ...this.occurrence(owner, category, { ...row, ...record(row.error) }), errorAttribution: owner ? 'turn' : 'unattributed', busyRetryEligible: !!owner && category === 'model_busy' }, owner ? this.turn(owner) : undefined);
    }
  }
  private state(state: Record<string, any>): void {
    if (state.runtimeInitialization) this.event('runtime_status', state.runtimeInitialization);
    if (state.control && Object.hasOwn(state.control, 'apiRetry')) {
      const retry = state.control.apiRetry, signature = JSON.stringify(retry);
      const works = this.snapshot?.control?.activeWorks;
      const commandId = Array.isArray(works) && works.length === 1 && typeof works[0].sourceCommandId === 'string' ? works[0].sourceCommandId : undefined;
      if (retry && signature !== this.apiRetry) this.event('runtime_status', { kind: 'api_retry', attempt: retry.attempt, maxAttempts: retry.maxAttempts, nextRetryAt: retry.nextRetryAt, reasonCode: retry.reasonCode }, commandId);
      this.apiRetry = signature;
    }
    const lastError = state.control?.lastError;
    if (state.control && Object.hasOwn(state.control, 'lastError') && !lastError) this.lastError = '';
    if (lastError) {
      const signature = JSON.stringify(lastError);
      if (signature !== this.lastError) {
        this.lastError = signature;
        const headers = turnHeaders(this.snapshot!).filter(header => header.state === 'failed' && attributedToTurn(record(lastError), header, this.snapshot!));
        const owner = headers.length === 1 ? headers[0] : undefined;
        const category = classifyError(lastError);
        this.event('error', { ...lastError, category, ...this.occurrence(owner, category, lastError), errorAttribution: owner ? 'turn' : 'unattributed', busyRetryEligible: !!owner && category === 'model_busy' }, owner ? this.turn(owner) : undefined);
      }
    }
    if (state.usage) {
      const signature = JSON.stringify(state.usage);
      if (signature !== this.usage) { this.usage = signature; this.event('usage', state.usage); }
    }
    if (Array.isArray(state.pendingInteractions)) {
      for (const interaction of state.pendingInteractions) {
        const id = interaction.interactionId ?? interaction.id;
        if (typeof id === 'string' && !this.interactions.has(id)) this.event('approval_requested', { ...interaction, approvalId: id });
      }
      this.interactions = new Set(state.pendingInteractions.map((entry: any) => entry.interactionId ?? entry.id).filter((id: any) => typeof id === 'string'));
    }
  }
}
