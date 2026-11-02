import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { uiMethods, uiErrorDataSchema, type UiMethodName, type UiRpcParams, type UiRpcResult } from '../../../../src/shared/ui-contract.js';
import { methods, poolPolicySchema } from '../../../../src/shared/methods.js';

/** JSON-RPC envelope; built once instead of per response frame. */
const rpcResponseSchema = z.object({jsonrpc:z.literal('2.0'),id:z.string(),result:z.unknown().optional(),error:z.object({code:z.number(),message:z.string(),data:z.unknown().optional()}).optional()});

export class HostError extends Error {
  constructor(readonly code: string, message: string, readonly unknownOutcome = false, readonly rpcCode?: number) { super(message); }
}
export function safeError(error: unknown): {code: string; message: string; unknownOutcome?: boolean} {
  if (error instanceof HostError) return { code: error.code, message: error.message, ...(error.unknownOutcome ? {unknownOutcome: true} : {}) };
  return {code:'REQUEST_FAILED',message:'The request failed. Inspect current task state before repeating an operation.'};
}
export interface Transport { request(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number, mutating?: boolean): Promise<unknown>; dispose(): void }
export class SocketTransport implements Transport {
  private readonly sockets = new Set<Socket>();
  private disposed = false;
  constructor(readonly root: string) {}
  request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = 10_000, mutating = false): Promise<unknown> {
    if (this.disposed || signal?.aborted) return Promise.reject(new HostError('ABORTED','This window stopped waiting; daemon execution is unchanged.',mutating));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const frame = `${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`;
      if (Buffer.byteLength(frame) > 524288) { reject(new HostError('INVALID_ARGUMENT','The request exceeds the protocol size limit.')); return; }
      let buffer = Buffer.alloc(0); let done = false; let sent = false;
      const socket = createConnection(join(this.root,'scheduler','daemon.sock'));
      this.sockets.add(socket);
      const timer = setTimeout(() => finish(new HostError('TIMEOUT', mutating ? 'The operation result is unknown. Query the original request or task before retrying.' : 'The daemon read timed out; task execution is unchanged.',mutating && sent)),timeoutMs);
      const abort = () => finish(new HostError('ABORTED','This window stopped waiting; daemon execution is unchanged.',mutating && sent));
      function finish(error?: Error, result?: unknown) {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort',abort); socket.destroy();
        error ? reject(error) : resolve(result);
      }
      signal?.addEventListener('abort',abort,{once:true});
      socket.once('connect',() => {sent = true; socket.write(frame);});
      socket.on('error',() => finish(new HostError('DAEMON_UNAVAILABLE',mutating && sent ? 'Connection was lost; the operation result is unknown. Inspect the original IDs.' : 'The daemon is unavailable at the selected host and pool.',mutating && sent)));
      socket.once('close',() => {this.sockets.delete(socket); if (!done) finish(new HostError('CONNECTION_CLOSED','The daemon closed the connection before a response. Inspect current state.',mutating && sent));});
      socket.on('data',(chunk: Buffer) => {
        buffer = Buffer.concat([buffer,chunk]);
        const newline = buffer.indexOf(10);
        if (buffer.length > 1048576 || newline > 1048576) return finish(new HostError('OUTPUT_BUDGET_EXCEEDED','The daemon response exceeds the transport limit.',mutating && sent));
        if (newline < 0) return;
        try {
          const response = rpcResponseSchema.parse(JSON.parse(buffer.subarray(0,newline).toString('utf8')));
          if (response.id !== id || (!!response.error === Object.hasOwn(response,'result'))) throw new Error();
          if (response.error) {
            if(response.error.message==='Pool has active or uncertain tasks; finish or reconcile before shutdown')return finish(new HostError('POOL_BUSY','仍有执行中或状态未确认的任务。请先完成、取消并确认停止，或核对执行状态；本次未停止任何实例。'));
            if(response.error.message==='Pool shutdown incomplete; inspect Workers before retrying')return finish(new HostError('SHUTDOWN_INCOMPLETE','部分实例可能已停止，后台保留运行。请刷新检查剩余实例；不会强制终止未知执行。',true));
            const parsed = uiErrorDataSchema.safeParse(response.error.data);
            if (parsed.success) return finish(new HostError(parsed.data.kind,fixedMessage(parsed.data.kind),parsed.data.outcome === 'may_have_applied',response.error.code));
            if (response.error.code === -32601 || response.error.code === -32000 && response.error.message === 'Unknown method') return finish(new HostError('METHOD_NOT_FOUND','This daemon does not implement the requested interface.',false,response.error.code));
            return finish(new HostError('REQUEST_FAILED','The daemon rejected the request. Refresh the target and inspect its state.',mutating && sent,response.error.code));
          }
          if (method.startsWith('ui_') && newline > 262144) return finish(new HostError('OUTPUT_BUDGET_EXCEEDED','The UI response exceeds its size budget.',mutating && sent));
          finish(undefined,response.result);
        } catch { finish(new HostError('INVALID_RESPONSE','The daemon response did not match the protocol.',mutating && sent)); }
      });
    });
  }
  dispose(): void { this.disposed=true; for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); }
}
function fixedMessage(code: string): string {
  const messages: Record<string,string> = {
    APPROVAL_CHANGED:'This approval changed. Load and review the current content.',APPROVAL_GONE:'This approval is no longer pending or has expired.',
    APPROVAL_READ_ONLY:'This interaction has no complete supported review source.',APPROVAL_RESPONSE_PENDING:'An approval response is awaiting native confirmation.',
    ACTION_CONFLICT:'This action ID already belongs to a different response.',NOT_FOUND:'The requested object was not found. An in-flight dispatch may still complete.',
    WORKSPACE_BUSY:'This workspace has active or uncertain occupancy.',WORKER_BUSY:'This worker or account has active or uncertain occupancy.',
    ARTIFACT_UNAVAILABLE:'An immutable artifact is unavailable. Current files cannot replace historical content.',INTEGRITY_MISMATCH:'Artifact integrity verification failed.',
    CURSOR_STALE:'The page changed or expired. Reload the list.',CURSOR_INVALID:'This page cursor is invalid.',RECOVERY_REQUIRED:'Inspect the task and explicitly choose whether to reconcile or resume observation.',
    OUTCOME_UNKNOWN:'The operation result is unknown. Inspect the original task or request ID before retrying.',CAPABILITY_UNAVAILABLE:'The daemon does not provide this capability.',
  };
  return messages[code] ?? `The operation was rejected (${code}). Refresh the target before another action.`;
}
const id = z.string().min(1).max(150);
const task = z.object({taskId:id,workspaceId:id,workerId:id.nullable(),status:z.string(),revision:z.number().int().nonnegative(),leaseHeld:z.boolean(),sessionId:id.nullable().optional(),retry:z.object({used:z.number(),max:z.number(),reason:z.literal('model_busy')}).optional()});
const account = z.object({alias:id,provider:z.string(),health:z.string(),plan:z.string().optional(),email:z.string().optional(),name:z.string().optional()});
const workspace = z.object({workspaceId:id,repositoryPath:z.string(),worktreePath:z.string(),branch:z.string(),baseCommit:z.string(),state:z.string(),activeTaskId:id.nullable()});
const worker = z.object({workerId:id,accountAlias:id,state:z.string(),processOwned:z.boolean(),runningTaskCount:z.number().optional(),version:z.string().optional()});
const result = z.object({summary:z.string(),changedFiles:z.array(z.string()).optional(),verification:z.array(z.object({command:z.string(),exitCode:z.number().nullable(),summary:z.string().optional()})).optional(),blockers:z.array(z.string()).optional()}).nullable();
const action = z.object({task:task.optional(),taskId:id.optional(),cancelRequested:z.boolean().optional(),terminationConfirmed:z.boolean().optional(),attached:z.boolean().optional(),alreadyStopped:z.boolean().optional(),requiresInspection:z.boolean().optional(),executionStopped:z.boolean().optional(),operationInProgress:z.boolean().optional(),finalizing:z.boolean().optional(),canResume:z.boolean().optional()});
const legacy = {
  overview:z.object({tasks:z.array(task),accounts:z.array(account),workers:z.array(worker),workspaces:z.array(workspace),poolPolicy:poolPolicySchema.optional()}),
  shutdown_pool:z.object({stopping:z.literal(true),workersStopped:z.literal(true),stoppedWorkers:z.number().int().nonnegative()}),
  get_pool_policy:poolPolicySchema,set_pool_policy:poolPolicySchema,
  wait:z.object({tasks:z.array(task),changedTaskIds:z.array(id),timedOut:z.boolean(),revision:z.number().int().nonnegative()}),
  get_result:z.object({task,result}),
  get_diff:z.object({available:z.boolean(),text:z.string().optional(),nextOffset:z.number().int().nonnegative().nullable().optional(),totalCharacters:z.number().int().nonnegative().optional()}),
  get_logs:z.object({events:z.array(z.object({taskId:id,revision:z.number().int().nonnegative(),type:z.string(),status:z.string(),createdAt:z.number()})),nextCursor:z.number().int().nonnegative(),hasMore:z.boolean().optional()}),
  dispatch_task:z.object({task,created:z.boolean()}),cancel_task:z.union([action,task]),reconcile_task:action,resume_task:action,
  import_accounts:z.object({fileCount:z.number(),recordCount:z.number(),duplicateCount:z.number(),accounts:z.array(account).optional(),summaries:z.array(account).optional()}),
  create_workspace:workspace,start_worker:z.object({workerId:id,accountAlias:id,version:z.string().optional()}),stop_worker:z.object({stopped:z.boolean(),workerId:id}),
};
export type LegacyMethod = keyof typeof legacy;
export type LegacyParams<K extends LegacyMethod> = z.input<(typeof methods)[K]['schema']>;
export type LegacyResult<K extends LegacyMethod> = z.infer<(typeof legacy)[K]>;
export class TypedClient {
  private readActive = 0;
  private readonly readQueue: (() => void)[] = [];
  constructor(readonly transport: Transport) {}
  async call<K extends UiMethodName>(method: K, params: UiRpcParams<K>, signal?: AbortSignal): Promise<UiRpcResult<K>> {
    const parsed = uiMethods[method].params.parse(params);
    const mutation = method === 'ui_probe_quota' || method === 'ui_respond_approval';
    const raw = await this.invoke(method,parsed,signal,10_000,mutation);
    const value = uiMethods[method].result.safeParse(raw);
    if (!value.success) throw new HostError('INVALID_RESPONSE','The daemon response failed the UI schema.',mutation);
    return value.data as UiRpcResult<K>;
  }
  async legacy<K extends LegacyMethod>(method: K, params: LegacyParams<K>, signal?: AbortSignal): Promise<LegacyResult<K>> {
    const mutation = !['overview','wait','get_result','get_logs','get_diff','get_pool_policy'].includes(method);
    const parsed = methods[method].schema.parse(params);
    const raw = await this.invoke(method,parsed,signal,method === 'shutdown_pool' ? 55_000 : method === 'wait' ? 30_000 : 10_000,mutation);
    const value = legacy[method].safeParse(raw);
    if (!value.success) throw new HostError('INVALID_RESPONSE','The daemon response failed its view schema.',mutation);
    return value.data as LegacyResult<K>;
  }
  private async invoke(method: string, params: unknown, signal: AbortSignal | undefined, timeoutMs: number, mutation: boolean): Promise<unknown> {
    if (!mutation) {
      if (this.readActive >= 4) await new Promise<void>(resolve => this.readQueue.push(resolve));
      this.readActive++;
    }
    try { return await this.transport.request(method,params,signal,timeoutMs,mutation); }
    finally { if (!mutation) { this.readActive--; this.readQueue.shift()?.(); } }
  }
  dispose(): void { this.transport.dispose(); }
}
