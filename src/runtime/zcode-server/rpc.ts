import WebSocket from 'ws';

const HEADER_BYTES = 13;
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const NESTED_BYTES = '__zcode_rpc_nested_uint8array_v1';

function vql(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do { const next = remaining & 127; remaining >>>= 7; bytes.push(next | (remaining ? 128 : 0)); } while (remaining);
  return Buffer.from(bytes);
}

/** Official @zcode/rpc serialization tags, independently implemented from the installed runtime. */
export function encodeValue(value: unknown): Buffer {
  if (value === undefined) return Buffer.from([0]);
  if (typeof value === 'string') { const data = Buffer.from(value); return Buffer.concat([Buffer.from([1]), vql(data.length), data]); }
  if (value instanceof Uint8Array) { const data = Buffer.from(value); return Buffer.concat([Buffer.from([2]), vql(data.length), data]); }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([4]), vql(value.length), ...value.map(encodeValue)]);
  if (typeof value === 'number' && (value | 0) === value) return Buffer.concat([Buffer.from([6]), vql(value)]);
  const data = Buffer.from(JSON.stringify(value, function (key, entry) {
    const original = this[key];
    return original instanceof Uint8Array ? { [NESTED_BYTES]: true, base64: Buffer.from(original).toString('base64') } : entry;
  }));
  return Buffer.concat([Buffer.from([5]), vql(data.length), data]);
}

export function decodeValues(buffer: Buffer): unknown[] {
  let offset = 0;
  function read(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) throw new Error('Malformed RPC value length');
    const part = buffer.subarray(offset, offset + length); offset += length; return part;
  }
  function readVql(): number {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = read(1)[0]!;
      value |= (byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Malformed RPC integer');
  }
  function decode(): unknown {
    switch (read(1)[0]) {
      case 0: return undefined;
      case 1: return read(readVql()).toString('utf8');
      case 2: case 3: return new Uint8Array(read(readVql()));
      case 4: {
        const count = readVql();
        if (count < 0 || count > buffer.length - offset) throw new Error('Malformed RPC array length');
        return Array.from({ length: count }, decode);
      }
      case 5: return JSON.parse(read(readVql()).toString('utf8'), (_key, value) =>
        value && typeof value === 'object' && value[NESTED_BYTES] === true && typeof value.base64 === 'string' && Object.keys(value).length === 2
          ? new Uint8Array(Buffer.from(value.base64, 'base64')) : value);
      case 6: return readVql();
      default: throw new Error('Unknown RPC serialization tag');
    }
  }
  const values: unknown[] = [];
  while (offset < buffer.length) values.push(decode());
  return values;
}

export function encodeFrame(header: unknown[], body?: unknown): Buffer {
  const data = Buffer.concat([encodeValue(header), encodeValue(body)]);
  const prefix = Buffer.alloc(HEADER_BYTES);
  prefix.writeUInt8(1, 0);
  prefix.writeUInt32BE(data.length, 9);
  return Buffer.concat([prefix, data]);
}

export class FrameDecoder {
  private pending = Buffer.alloc(0);
  accept(data: Buffer): unknown[][] {
    this.pending = Buffer.concat([this.pending, data]);
    const messages: unknown[][] = [];
    while (this.pending.length >= HEADER_BYTES) {
      const length = this.pending.readUInt32BE(9);
      if (length > MAX_FRAME_BYTES) throw new Error('RPC frame exceeds adapter limit');
      if (this.pending.length < HEADER_BYTES + length) break;
      const frame = this.pending.subarray(0, HEADER_BYTES + length);
      this.pending = this.pending.subarray(HEADER_BYTES + length);
      if (frame[0] === 1 && length) messages.push(decodeValues(frame.subarray(HEADER_BYTES)));
    }
    return messages;
  }
}

export class RpcError extends Error {
  readonly code?: unknown;
  readonly status?: unknown;
  readonly detail?: unknown;
  constructor(value: unknown) {
    const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    super(typeof data.message === 'string' ? data.message : 'Official server RPC failed');
    this.name = typeof data.name === 'string' ? data.name : 'RpcError';
    this.code = data.code; this.status = data.status; this.detail = data.detail;
  }
}

export interface ProtocolMessageRecord {
  direction: 'send' | 'receive';
  header: unknown[];
  body: unknown;
}

export class ChannelRpc {
  private socket?: WebSocket;
  private nextId = 0;
  private decoder = new FrameDecoder();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private listeners = new Map<number, { accept: (value: any) => void; fail: (error: Error) => void }>();
  private closed = false;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
  constructor(private readonly timeoutMs = 30_000, private readonly onClose?: (error: Error) => void, private readonly observe?: (message: ProtocolMessageRecord) => void) { void this.ready.catch(() => {}); }

  async connect(url: string, token?: string): Promise<void> {
    const socket = this.socket = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, maxPayload: MAX_FRAME_BYTES });
    const timer = setTimeout(() => this.fail(new Error('Official RPC initialization timed out')), this.timeoutMs);
    socket.on('message', (raw) => {
      try {
        for (const [rawHeader, body] of this.decoder.accept(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer))) {
          if (!Array.isArray(rawHeader)) throw new Error('Malformed RPC header');
          this.observe?.({ direction: 'receive', header: rawHeader, body });
          const [type, id] = rawHeader;
          if (type === 200) { clearTimeout(timer); this.readyResolve(); continue; }
          if (typeof id !== 'number') continue;
          if (type === 201 || type === 202 || type === 203) {
            const request = this.pending.get(id);
            if (!request) continue;
            clearTimeout(request.timer); this.pending.delete(id);
            if (type === 201) request.resolve(body); else request.reject(new RpcError(body));
          } else if (type === 204) this.listeners.get(id)?.accept(body);
          else if (type === 205) { const listener = this.listeners.get(id); this.listeners.delete(id); listener?.fail(new RpcError(body)); }
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    socket.on('error', () => this.fail(new Error('Official server WebSocket connection failed')));
    socket.on('close', () => { clearTimeout(timer); this.fail(new Error('Official server WebSocket closed')); });
    try { await this.ready; } finally { clearTimeout(timer); }
  }

  private send(header: unknown[], body?: unknown): void {
    if (this.closed || !this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Official RPC connection is closed');
    this.observe?.({ direction: 'send', header, body });
    this.socket.send(encodeFrame(header, body));
  }
  async call<T = any>(channel: string, method: string, ...args: unknown[]): Promise<T> {
    await this.ready;
    if (this.closed) throw new Error('Official RPC connection is closed');
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Cancellation releases the transport waiter; it does not prove that a command did not execute.
        try { this.send([101, id]); } catch {}
        reject(new Error(`Official RPC ${method} timed out; execution may be uncertain, reconcile before retrying`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send([100, id, channel, method], args); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async listen(channel: string, event: string, arg: unknown, accept: (value: any) => void, fail: (error: Error) => void): Promise<() => void> {
    await this.ready;
    const id = this.nextId++;
    this.listeners.set(id, { accept, fail });
    this.send([102, id, channel, event], arg);
    return () => { this.listeners.delete(id); if (!this.closed) this.send([103, id]); };
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true; this.readyReject(error);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    for (const item of this.listeners.values()) item.fail(error);
    this.listeners.clear(); this.socket?.terminate(); this.onClose?.(error);
  }
  close(): void { this.fail(new Error('Runtime connection closed')); }
}
