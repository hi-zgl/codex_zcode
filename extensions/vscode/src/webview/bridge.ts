import type { RequestPayload, RequestType, WebviewRequest } from '../host/protocol.js';
import type { HostPush, HostResponse, UiError, UiSnapshot } from '../host/types.js';

export interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
}
export class BridgeError extends Error {
  constructor(readonly detail: UiError) { super(detail.message); this.name = 'BridgeError'; }
}
type Pending = { generation: number; type: RequestType; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const writes = new Set<RequestType>(['dispatch', 'cancel', 'reconcile', 'resume', 'approval.respond', 'accounts.import', 'workspace.create', 'worker.start', 'worker.stop', 'worker.probe', 'account.probe', 'daemon.start', 'pool.shutdown', 'pool.policy.set']);
const connectionRequests = new Set<RequestType>(['ready', 'connect', 'disconnect', 'connection.configure', 'connection.codexSetup', 'daemon.start', 'pool.shutdown']);

/** The only Webview message boundary. Never forwards RPC methods or filesystem paths. */
export class WebviewBridge {
  private sequence = 0;
  private generation = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly subscribers = new Set<(snapshot: UiSnapshot) => void>();
  private readonly listener: (event: MessageEvent<unknown>) => void;
  constructor(private readonly api: VsCodeApi, private readonly surface: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {
    this.listener = event => this.receive(event.data);
    surface.addEventListener('message', this.listener as EventListener);
  }
  subscribe(callback: (snapshot: UiSnapshot) => void): () => void {
    this.subscribers.add(callback); return () => this.subscribers.delete(callback);
  }
  getState(): unknown { return this.api.getState(); }
  setState(value: unknown): void { this.api.setState(value); }
  request<K extends RequestType, T = unknown>(type: K, payload: RequestPayload<K>): Promise<T> {
    const id = `web-${++this.sequence}-${Date.now().toString(36)}`;
    const generation = this.generation;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError({ code: writes.has(type) ? 'OUTCOME_UNKNOWN' : 'TIMEOUT', message: writes.has(type) ? '结果待确认。请检查目标状态；此操作不会自动重发。' : '读取超时，请重试读取。', unknownOutcome: writes.has(type) }));
      }, type === 'daemon.start' ? 90_000 : writes.has(type) ? 60_000 : 35_000);
      this.pending.set(id, { generation, type, resolve: value => resolve(value as T), reject, timer });
      this.api.postMessage({ v: 1, id, generation, type, payload } as WebviewRequest);
    });
  }
  receive(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as Partial<HostPush & HostResponse>;
    if (message.v !== 1 || !Number.isSafeInteger(message.generation) || (message.generation ?? -1) < 0) return;
    if (message.type === 'state') {
      const push = value as HostPush;
      if (!push.data?.connection || push.generation < this.generation || push.data.connection.generation !== push.generation) return;
      if (push.generation > this.generation) this.advance(push.generation);
      for (const subscriber of this.subscribers) subscriber(push.data);
      return;
    }
    const response = value as HostResponse;
    const pending = typeof response.id === 'string' ? this.pending.get(response.id) : undefined;
    if (!pending || typeof response.ok !== 'boolean') return;
    // Connection actions may themselves advance generation, including before their ACK.
    if (response.generation !== this.generation && !(connectionRequests.has(pending.type) && response.generation >= this.generation)) return;
    if (!connectionRequests.has(pending.type) && pending.generation !== response.generation) return;
    this.pending.delete(response.id); clearTimeout(pending.timer);
    if (response.generation > this.generation) this.advance(response.generation);
    if (response.ok) pending.resolve(response.data);
    else pending.reject(new BridgeError(response.error));
  }
  private advance(generation: number): void {
    this.generation = generation;
    for (const [id, pending] of this.pending) {
      if (connectionRequests.has(pending.type) || pending.generation === generation) continue;
      clearTimeout(pending.timer); this.pending.delete(id);
      pending.reject(new BridgeError({ code: writes.has(pending.type) ? 'OUTCOME_UNKNOWN' : 'STALE_CONNECTION', message: writes.has(pending.type) ? '连接已变化，操作结果待确认；请检查原目标。' : '连接已变化，已丢弃旧读取。', unknownOutcome: writes.has(pending.type) }));
    }
  }
  dispose(): void {
    this.surface.removeEventListener('message', this.listener as EventListener);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Webview closed')); }
    this.pending.clear(); this.subscribers.clear();
  }
}
