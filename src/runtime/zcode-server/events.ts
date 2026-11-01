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

export function classifyError(value: unknown): ErrorCategory {
  const object = value instanceof Error ? { message: value.message, ...record(value) } : value;
  const data = JSON.stringify(object ?? '').toLowerCase();
  if (/3012|unusual activity|risk.block|风控|异常活动/.test(data)) return 'risk_blocked';
  if (/\b401\b|\b403\b|unauthori[sz]ed|token.{0,30}(?:invalid|expired)|invalid.{0,20}(?:token|credential|identity)|鉴权|登录失效|未登录|身份无效/.test(data)) return 'auth_invalid';
  if (/\b429\b|rate.?limit|too many|繁忙|并发限制|请求过于频繁/.test(data)) return 'rate_limited';
  if (/\b50[0-9]\b|\b52[0-9]\b|econnreset|timed? ?out|timeout|upstream|service unavailable|服务.{0,10}(?:异常|不可用)/.test(data)) return 'server_error';
  return 'unknown';
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
  private interactions = new Set<string>();
  private serial = 0;
  private frameError?: Record<string, any>;
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
    this.event('error', { message: error instanceof Error ? error.message : String(error), category: classifyError(error), executionUncertain: true });
  }
  apply(frame: Record<string, any>, subscriptionLogEpoch?: string): void {
    const payload = record(frame.payload);
    if (payload.kind === 'snapshot') {
      const snapshot = record(payload.snapshot);
      if (snapshot.sessionId !== this.sessionId || snapshot.logEpoch !== (subscriptionLogEpoch ?? frame.logEpoch ?? snapshot.logEpoch) || snapshot.seq !== frame.toSeq) throw new Error('Conversation snapshot identity or sequence mismatch');
      this.snapshot = structuredClone(snapshot);
      this.frameError = snapshot.control?.lastError ?? undefined;
      this.event('session_snapshot', { phase: snapshot.control?.phase, revision: snapshot.revision, logEpoch: snapshot.logEpoch, seq: snapshot.seq, tailRows: snapshot.rows?.window?.length ?? 0 });
      for (const row of snapshot.rows?.window ?? []) if (row.kind === 'turnHeader' && row.sourceCommandId) this.rowCommands.set(row.turnId, row.sourceCommandId);
      for (const row of snapshot.rows?.window ?? []) this.row(record(row));
      this.state(snapshot);
      return;
    }
    if (payload.kind !== 'deltas' || !Array.isArray(payload.deltas) || !this.snapshot) throw new Error('Conversation deltas arrived without a snapshot');
    if ((subscriptionLogEpoch ?? frame.logEpoch ?? this.snapshot.logEpoch) !== this.snapshot.logEpoch || frame.fromSeq !== this.snapshot.seq || frame.toSeq < frame.fromSeq) throw new Error('Conversation sequence gap; reconcile before continuing');
    let rows = this.snapshot.rows.window as Array<Record<string, any>>;
    this.frameError = payload.deltas.filter((delta: any) => delta.op === 'state.updated' && delta.patch?.control).at(-1)?.patch?.control?.lastError ?? undefined;
    for (const value of payload.deltas) {
      const delta = record(value);
      if (delta.op === 'row.appended' || delta.op === 'row.upserted') {
        const next = structuredClone(record(delta.row));
        const index = rows.findIndex((row) => row.rowId === next.rowId);
        if (index < 0) rows.push(next); else rows[index] = next;
        rows.sort((a, b) => a.rowId - b.rowId);
        this.row(next);
      } else if (delta.op === 'row.delta') {
        const row = rows.find((entry) => entry.rowId === delta.rowId);
        if (!row || typeof delta.append !== 'string') throw new Error('Conversation delta targets a missing row');
        const path = delta.path;
        if (typeof path === 'string' && ['text', 'inputText', 'output.text', 'summaryText'].includes(path)) {
          if (path === 'output.text') {
            row.output = { ...record(row.output), text: (typeof row.output?.text === 'string' ? row.output.text : '') + delta.append };
          } else row[path] = (typeof row[path] === 'string' ? row[path] : '') + delta.append;
          if (row.kind === 'assistantText' && path === 'text') this.event('assistant_message', { rowId: row.rowId, text: delta.append, delta: true, runtimeTurnId: row.turnId }, this.turn(row));
        }
      } else if (delta.op === 'row.removed') {
        this.snapshot.rows.window = rows = rows.filter((row) => row.rowId < delta.fromRowId);
        for (const id of this.rowStates.keys()) if (id >= delta.fromRowId) { this.rowStates.delete(id); this.terminalStates.delete(id); }
      } else if (delta.op === 'state.updated') {
        Object.assign(this.snapshot, structuredClone(record(delta.patch)));
        this.state(record(delta.patch));
      }
    }
    this.snapshot.seq = frame.toSeq;
    // Revision changes are authoritative state patches when present; sequence is independent.
    if (typeof frame.revision === 'number') this.snapshot.revision = frame.revision;
  }
  private turn(row: Record<string, any>): string | undefined { return row.sourceCommandId ?? this.rowCommands.get(row.turnId); }
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
        if (row.state === 'failed') this.event('turn_failed', { ...data, ...(this.frameError ? { error: this.frameError, category: classifyError(this.frameError) } : {}) }, turnId, row.endedAt);
        if (row.state === 'completedInterrupted') this.event('turn_cancelled', data, turnId, row.endedAt);
      }
    } else if (row.kind === 'assistantText') this.event('assistant_message', { ...data, delta: false }, turnId);
    else if (row.kind === 'toolCall') this.event(['success', 'error', 'cancelled'].includes(row.status) ? 'tool_result' : 'tool_call', data, turnId);
    else if (row.kind === 'error') this.event('error', { ...data, category: classifyError(row) }, turnId);
  }
  private state(state: Record<string, any>): void {
    if (state.runtimeInitialization) this.event('runtime_status', state.runtimeInitialization);
    const lastError = state.control?.lastError;
    if (lastError) {
      const signature = JSON.stringify(lastError);
      if (signature !== this.lastError) {
        this.lastError = signature;
        const latest = (this.snapshot?.rows?.window ?? []).filter((row: any) => row.kind === 'turnHeader').at(-1);
        this.event('error', { ...lastError, category: classifyError(lastError) }, latest ? this.turn(latest) : undefined);
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
