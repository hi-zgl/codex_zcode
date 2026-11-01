import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_FRAME_BYTES = 1024 * 1024;
export function poolRoot(): string { return resolve(process.env.ZCODE_POOL_HOME ?? join(homedir(), '.zcode_pool')); }
export function socketPath(root = poolRoot()): string { return join(root, 'scheduler', 'daemon.sock'); }
export interface RpcRequest { jsonrpc: '2.0'; id: string | number; method: string; params?: Record<string, unknown> }
export function isRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return v.jsonrpc === '2.0' && (typeof v.id === 'string' || typeof v.id === 'number'&&Number.isFinite(v.id)) && typeof v.method === 'string'
    && (v.params === undefined || (!!v.params && typeof v.params === 'object' && !Array.isArray(v.params)));
}
export function consumeLines(socket: Socket, receive: (line: string) => void): void {
  let buffer = Buffer.alloc(0);
  socket.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    let index: number;
    while ((index = buffer.indexOf(10)) >= 0) {
      if (index > MAX_FRAME_BYTES) { socket.destroy(new Error('RPC frame exceeds size limit')); return; }
      const line = buffer.subarray(0, index).toString('utf8');
      buffer = buffer.subarray(index + 1);
      receive(line);
    }
    if (buffer.length > MAX_FRAME_BYTES) socket.destroy(new Error('RPC frame exceeds size limit'));
  });
}
export class RpcCallError extends Error {
 constructor(message:string,readonly code:number,readonly data?:unknown){super(message);this.name='RpcCallError';}
}
export async function rpcCall<T = unknown>(method: string, params: Record<string, unknown> = {}, options: { root?: string; timeoutMs?: number; signal?:AbortSignal } = {}): Promise<T> {
  return new Promise<T>((resolveCall, reject) => {
    const socket = createConnection(socketPath(options.root));
    socket.on('error',()=>{});
    const id = randomUUID();
    let done = false;
    const timer = setTimeout(() => finish(new Error('Daemon RPC timed out; task execution state is unchanged')), options.timeoutMs ?? 40_000);
    function finish(error?: Error, result?: T) {
      if (done) return;
      done = true; clearTimeout(timer); options.signal?.removeEventListener('abort',abort);socket.destroy();
      if (error) reject(error); else resolveCall(result as T);
    }
    const abort=()=>finish(new Error('Daemon RPC wait aborted; task execution state is unchanged'));
    options.signal?.addEventListener('abort',abort,{once:true});
    if(options.signal?.aborted){abort();return;}
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!done) finish(new Error('Daemon connection closed before response')); });
    socket.on('connect', () => {
      const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) { finish(new Error('RPC request exceeds size limit')); return; }
      socket.write(frame);
    });
    consumeLines(socket, line => {
      try {
        const response = JSON.parse(line);
        if (response.id !== id) return;
        if (response.error) finish(new RpcCallError(String(response.error.message),response.error.code,response.error.data));
        else finish(undefined, response.result as T);
      } catch { finish(new Error('Malformed daemon response')); }
    });
  });
}
