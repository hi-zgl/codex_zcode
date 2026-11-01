import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { AccountVault } from '../accounts/index.js';
import { WorkerSupervisor } from '../supervisor/index.js';
import { ZCodeServerAdapter } from '../runtime/zcode-server/index.js';
import type { RuntimeConnection, SessionRef, TurnRef, ExecutionMode, RuntimeEvent, SessionSnapshot, ModelSelection } from '../runtime/types.js';
import { redact, record, classifyTurnFailure } from '../runtime/zcode-server/events.js';
import { DurableTaskStore } from '../core/index.js';
import type { Task, JsonValue, TaskResult, StopProof } from '../core/types.js';
import { validateMethod, type MethodName } from '../shared/methods.js';
import { createWorkspace, snapshotWorkspace } from './workspace.js';
import { UiService } from './ui.js';
import { UiRpcError } from './ui-support.js';

const exec = promisify(execFile);
const FINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_STATES = new Set(['completedSuccess', 'failed', 'completedInterrupted']);
const UNAVAILABLE_HEALTH = new Set(['blocked', 'invalid', 'cooling']);
const APPROVAL_REVIEW_HINT = 'This is a bounded preview. Inspect the persisted approval event and full local native details before accepting incomplete arguments.';

type TerminalEvent = 'turn_completed' | 'turn_failed' | 'turn_cancelled';
interface Policy { mode: ExecutionMode; modelId: string; busyRetryLimit: number; verifyCommands: {command: string; args: string[]; timeout_ms: number}[] }
interface Active { connection: RuntimeConnection; session?: SessionRef; turn?: TurnRef; accountAlias?: string; approvalResponses?: Map<string,string> }
interface Observation { kind: 'active' | 'terminal' | 'unknown'; reason?: string; header?: Record<string, any> }
interface ApprovalView {
 approvalId: string; kind?: string; toolName?: string; summary?: string; truncated?: boolean;
 approvalLogCursor?: number; reviewComplete: false; reviewHint: string;
}
interface RecoveryResult {
 task: ReturnType<typeof compactTask>; attached: boolean; executionStopped?: boolean; alreadyStopped?: boolean;
 requiresInspection?: boolean; reason?: string; nativePhase?: string; nativeTurnState?: string;
 operationInProgress?: boolean; finalizing?: boolean; canResume?: boolean;
 pendingApprovals?: ApprovalView[]; pendingApprovalCount?: number; pendingApprovalsTruncated?: boolean;
}

function compactTask(task: Task) {
 const max = record(task.executionPolicy).busyRetryLimit ?? 3;
 return {taskId:task.taskId,workspaceId:task.workspaceId,workerId:task.workerId,sessionId:task.sessionId,status:task.status,revision:task.revision,leaseHeld:task.leaseHeld,detail:task.detail,...(task.busyRetryCount?{retry:{used:task.busyRetryCount,max,reason:'model_busy'}}:{})};
}
function safeDetail(value: unknown): JsonValue {
 const cleaned = redact(value);
 const text = JSON.stringify(cleaned);
 return text.length <= 4000 ? JSON.parse(text) : {truncated:true,summary:text.slice(0,3500)};
}
function boundedText(value: unknown, bytes: number): {text?: string; truncated?: boolean} {
 if (typeof value !== 'string') return {};
 const text = String(redact(value));
 if (Buffer.byteLength(text) <= bytes) return {text};
 let prefix = '';
 for (const character of text) {
  if (Buffer.byteLength(prefix + character) > bytes) break;
  prefix += character;
 }
 return {text:prefix,truncated:true};
}
function approvalView(value: Record<string, any>): ApprovalView | undefined {
 const approvalId = value.approvalId ?? value.interactionId ?? value.id;
 if (typeof approvalId !== 'string' || !approvalId || approvalId.length > 150) return;
 const summary = boundedText(value.payload?.summary ?? value.summary, 384);
 const kind = boundedText(value.kind, 80).text;
 const toolName = boundedText(value.payload?.toolName ?? value.toolName, 100).text;
 return {approvalId,...(kind ? {kind} : {}),...(toolName ? {toolName} : {}),...(summary.text ? {summary:summary.text} : {}),...(summary.truncated ? {truncated:true} : {}),reviewComplete:false,reviewHint:APPROVAL_REVIEW_HINT};
}
function taskPolicy(task: Task): Policy {
 const policy = record(task.executionPolicy);
 const commands = policy.verifyCommands ?? [];
 if (!Array.isArray(commands) || commands.length > 10 || commands.some(command =>
  !command || typeof command.command !== 'string' || !command.command || !Array.isArray(command.args)
  || command.args.some((arg: unknown) => typeof arg !== 'string') || !Number.isInteger(command.timeout_ms)
  || command.timeout_ms < 100 || command.timeout_ms > 300_000)) throw new Error('Stored verification policy is invalid; inspect before continuing');
 const busyRetryLimit = policy.busyRetryLimit ?? 3;
 if (!Number.isInteger(busyRetryLimit) || busyRetryLimit < 0 || busyRetryLimit > 10) throw new Error('Stored busy continuation policy is invalid; inspect before continuing');
 return {mode:policy.mode ?? 'build',modelId:policy.modelId ?? 'GLM-5.3-Flash',busyRetryLimit,verifyCommands:commands};
}
function observeSnapshot(task: Task, session: SessionRef, snapshot: SessionSnapshot): Observation {
 if (session.sessionId !== task.sessionId || snapshot.sessionId !== task.sessionId
  || resolve(session.workspacePath) !== resolve(snapshot.workspacePath)) return {kind:'unknown',reason:'Native snapshot identity does not match the persisted session'};
 if (task.turnId !== null && task.turnId !== task.currentCommandId) return {kind:'unknown',reason:'Persisted turn identity does not match the current command'};
 const raw = record(snapshot.raw);
 if (raw.sessionId !== undefined && raw.sessionId !== task.sessionId) return {kind:'unknown',reason:'Native snapshot contains a conflicting session identity'};
 const rows = raw.rows?.window;
 const works = raw.control?.activeWorks;
 if (!Array.isArray(rows) || !Array.isArray(works)) return {kind:'unknown',reason:'Native snapshot does not expose checked turn rows and active work'};
 const headers = rows.filter((row: any) => row.kind === 'turnHeader' && row.sourceCommandId === task.currentCommandId);
 if (headers.length !== 1 || typeof headers[0].turnId !== 'string' || !headers[0].turnId) return {kind:'unknown',reason:'The snapshot tail cannot uniquely identify the original native turn'};
 const header = headers[0];
 if (TERMINAL_STATES.has(header.state) && works.length === 0) return {kind:'terminal',header};
 if (header.state === 'running' && works.length === 1 && works[0]?.sourceCommandId === task.currentCommandId
  && (works[0].turnId === undefined || works[0].turnId === header.turnId)) return {kind:'active',header};
 return {kind:'unknown',header,reason:'Original turn state and native active work do not agree; occupancy retained'};
}
function ownApprovals(task: Task, snapshot: SessionSnapshot, header: Record<string, any>): Record<string, any>[] {
 const rows = record(snapshot.raw).rows?.window;
 return snapshot.pendingApprovals.filter(value => {
  const approval = record(value);
  // An explicit conflicting identity always wins over an anchor or session-wide activity.
  if (approval.sourceCommandId !== undefined && approval.sourceCommandId !== task.currentCommandId) return false;
  if (approval.turnId !== undefined && approval.turnId !== header.turnId) return false;
  let proved = approval.sourceCommandId === task.currentCommandId || approval.turnId === header.turnId;
  if (approval.anchorRowId !== undefined) {
   if (!Number.isSafeInteger(approval.anchorRowId)) return false;
   const anchor = Array.isArray(rows) ? rows.find((row: any) => row.rowId === approval.anchorRowId) : undefined;
   if (anchor) {
    if ((anchor.sourceCommandId !== undefined && anchor.sourceCommandId !== task.currentCommandId)
     || (anchor.turnId !== undefined && anchor.turnId !== header.turnId)) return false;
    proved ||= anchor.sourceCommandId === task.currentCommandId || anchor.turnId === header.turnId;
   }
  }
  return proved;
 });
}
function taskSummary(task: Task, snapshot: SessionSnapshot, header: Record<string, any>): string {
 const rows = record(snapshot.raw).rows?.window;
 const own = Array.isArray(rows) ? rows.filter((row: any) => row.kind === 'assistantText'
  && (row.sourceCommandId === undefined || row.sourceCommandId === task.currentCommandId)
  && (row.turnId === header.turnId || (row.turnId === undefined && row.sourceCommandId === task.currentCommandId)) && typeof row.text === 'string') : [];
 return String(redact(own.at(-1)?.text ?? '')).slice(0,2000);
}

export class Coordinator {
 readonly vault: AccountVault;
 readonly supervisor: WorkerSupervisor;
 readonly adapter = new ZCodeServerAdapter();
 readonly active = new Map<string,Active>();
 private readonly jobs = new Map<string,Promise<void>>();
 private readonly recoveries = new Map<string,{attach:boolean;promise:Promise<RecoveryResult>}>();
 private readonly pendingConnections = new Set<RuntimeConnection>();
 private readonly approvalRefreshes = new Map<string,Promise<void>>();
 private readonly approvalOperations = new Map<string,Promise<unknown>>();
 private closing = false;
 private workerChanges: Promise<unknown> = Promise.resolve();
 readonly ui: UiService;
 constructor(readonly root: string, readonly store: DurableTaskStore) {
  this.vault = new AccountVault(join(root,'accounts'));
  this.supervisor = new WorkerSupervisor({poolRoot:root});
  this.ui=new UiService(root,store,{
   attachment:taskId=>!!this.active.get(taskId)?.turn,
   serialApproval:(taskId,action)=>this.serialApproval(taskId,action),
   accounts:()=>this.vault.list(),
   observeApprovals:async task=>{
    const active=this.active.get(task.taskId);
    if(!active?.session||!active.turn||task.executionStopped||!task.leaseHeld||active.turn.commandId!==task.currentCommandId||active.session.sessionId!==task.sessionId)return null;
    let connection:RuntimeConnection|undefined;
    try{
     const worker=await this.supervisor.status(task.workerId!);if(worker.state!=='ready'||!worker.endpoint)throw new UiRpcError('NATIVE_UNAVAILABLE');
     // A separate read-only subscription gives this check a fresh native snapshot.
     // Existing-session open does not create a session, configure it or resume execution.
     connection=await this.adapter.connect(worker.endpoint);
     const session=await connection.openSession({workspacePath:this.store.getWorkspace(task.workspaceId).worktreePath,sessionId:task.sessionId!});
     const source=connection.readApprovalSnapshot?await connection.readApprovalSnapshot(session):{snapshot:await connection.syncHistory(session),pendingApprovals:[],sourceComplete:false,stablePermissionIds:false};
     const latest=this.store.getTask(task.taskId);if(latest.currentCommandId!==task.currentCommandId||latest.sessionId!==task.sessionId)return null;
     const observation=observeSnapshot(latest,session,source.snapshot);if(observation.kind!=='active')return null;
     const binding=record(latest.runtimeBinding),selection=source.snapshot.modelSelection;
     if(!selection||selection.providerId!==binding.providerId||selection.modelId!==binding.modelId)throw new UiRpcError('MODEL_SELECTION_MISMATCH');
     const approvals=ownApprovals(latest,{...source.snapshot,pendingApprovals:source.pendingApprovals},observation.header!);
     return {snapshot:source.snapshot,approvals,nativeTurnId:observation.header!.turnId,sourceComplete:source.sourceComplete,stablePermissionIds:source.stablePermissionIds,unattributedCount:source.pendingApprovals.length-approvals.length};
    }finally{if(connection&&connection!==active.connection)await connection.close().catch(()=>{});}
   },
   canAcceptApproval:async task=>{
    const binding=record(task.runtimeBinding),active=this.active.get(task.taskId);
    if(typeof binding.accountAlias!=='string'||binding.accountAlias!==active?.accountAlias)return false;
    try{const account=await this.vault.load(binding.accountAlias);return !UNAVAILABLE_HEALTH.has(account.health)&&binding.providerId===`account:${account.provider}-start-plan`;}catch{return false;}
   },
   sendApproval:async(task,approvalId,optionId)=>{
    const active=this.active.get(task.taskId);if(!active?.turn||active.turn.commandId!==task.currentCommandId)throw new UiRpcError('RECOVERY_REQUIRED');
    await active.connection.respondApproval(active.turn,approvalId,{optionId});
    active.approvalResponses??=new Map();active.approvalResponses.set(approvalId,`ui:${optionId}`);
    this.watchApprovalRevision(task.taskId,active);
   },
   probeQuota:async workerId=>{
    const worker=await this.supervisor.status(workerId);if(worker.state!=='ready'||!worker.endpoint)throw new UiRpcError('WORKER_UNAVAILABLE',{outcome:'not_started'});
    try{const result=await this.handle('probe_worker',{worker_id:workerId}) as {quota:Record<string,unknown>};const account=await this.vault.load(worker.accountAlias);return {accountAlias:worker.accountAlias,providerId:`account:${account.provider}-start-plan`,quota:result.quota};}
    catch(error){throw Object.assign(new UiRpcError('NATIVE_UNAVAILABLE',{outcome:'may_have_applied'}),{accountAlias:worker.accountAlias});}
   },
  });
 }
 private serialApproval<T>(taskId:string,action:()=>Promise<T>):Promise<T>{
  const previous=this.approvalOperations.get(taskId)??Promise.resolve();
  const operation=previous.catch(()=>{}).then(()=>{if(this.closing)throw new Error('Daemon is shutting down');return action();}).finally(()=>{if(this.approvalOperations.get(taskId)===operation)this.approvalOperations.delete(taskId);});
  this.approvalOperations.set(taskId,operation);return operation;
 }
 async call(method: string, input: Record<string,unknown>): Promise<unknown> {
  if(method.startsWith('ui_')){if(this.closing)throw new UiRpcError('NATIVE_UNAVAILABLE');return this.ui.call(method,input);}
  const {name,params:p} = validateMethod(method,input);
  if (this.closing) throw new Error('Daemon is shutting down');
  if (name === 'respond_approval') {
   return this.serialApproval(p.task_id,()=>this.handle(name,p));
  }
  if (name === 'start_worker' || name === 'stop_worker' || name === 'dispatch_task') {
   const operation = this.workerChanges.then(() => this.handle(name,p));
   this.workerChanges = operation.catch(() => {});
   return operation;
  }
  return this.handle(name,p);
 }
 private async handle(name: MethodName, p: any): Promise<unknown> {
  switch (name) {
   case 'daemon_stop': throw new Error('Daemon lifecycle is handled by the local server');
   case 'overview': return {accounts:await this.vault.list(),workers:(await this.supervisor.list()).map(({endpoint,...w})=>w),workspaces:this.store.listWorkspaces(),tasks:this.store.listTasks().slice(-50).map(compactTask),poolPolicy:this.store.getPoolPolicy()};
   case 'get_pool_policy': return this.store.getPoolPolicy();
   case 'set_pool_policy': return this.store.setPoolPolicy({maxConcurrentTasks:p.max_concurrent_tasks});
   case 'import_accounts': return this.vault.import(p.files);
   case 'start_worker': {
    if (this.store.listTasks().some(t=>t.workerId===p.worker_id&&t.leaseHeld)) throw new Error('Worker has an active or uncertain task');
    const account = await this.vault.load(p.account_id);
    const workers = await this.supervisor.list();
    if (workers.some(w=>w.accountAlias===p.account_id&&w.workerId!==p.worker_id&&w.state!=='stopped')) throw new Error('Account is already assigned to another live worker');
    const h = await this.supervisor.start({workerId:p.worker_id,account});
    return {workerId:h.workerId,accountAlias:h.accountAlias,version:h.version,identity:h.identity};
   }
   case 'stop_worker': {
    if (this.store.listTasks().some(t=>t.workerId===p.worker_id&&t.leaseHeld)) throw new Error('Worker has an active or uncertain task; reconcile before stopping');
    return this.supervisor.stop(p.worker_id);
   }
   case 'probe_worker': {
    const worker = await this.supervisor.status(p.worker_id);
    if (!worker.endpoint || worker.state !== 'ready') throw new Error('Worker not ready');
    const info = await this.adapter.probe(worker.endpoint);
    const account = await this.vault.load(worker.accountAlias);
    const connection = await this.adapter.connect(worker.endpoint);
    try {
     const providerId = `account:${account.provider}-start-plan`;
     const quota = await connection.quota(providerId);
     if (account.health==='unknown'&&quota.authenticated===true&&(quota.provider as any)?.id===providerId&&typeof (quota.remaining as any)?.count==='number'&&(quota.remaining as any).count>0) await this.vault.setHealth(account.alias,'available');
     return {info,quota};
    } finally {await connection.close();}
   }
   case 'create_workspace': return this.store.registerWorkspace(await createWorkspace(this.root,p.repository,p.base_ref));
   case 'dispatch_task': {
    const result = this.store.dispatch({workspaceId:p.workspace_id,workerId:p.worker_id,requestId:p.request_id,prompt:p.prompt,session:p.session,executionPolicy:{mode:p.mode,modelId:p.model_id,busyRetryLimit:p.busy_retry_limit,verifyCommands:p.verify_commands}});
    if (result.created) this.startJob(result.task.taskId, () => this.run(result.task.taskId));
    return {task:compactTask(result.task),created:result.created};
   }
   case 'wait': {
    const result = await this.store.wait({taskIds:p.task_ids,afterRevision:p.after_revision,timeoutMs:p.timeout_sec*1000});
    return {...result,tasks:result.tasks.map(compactTask)};
   }
   case 'get_result': return {task:compactTask(this.store.getTask(p.task_id)),result:this.store.getResult(p.task_id)};
   case 'get_logs': {
    const entries = this.store.listEvents(p.task_id,{afterRevision:p.cursor,limit:p.limit});
    const events = []; let size = 0;
    for (const event of entries) {const bytes=Buffer.byteLength(JSON.stringify(event));if(events.length&&size+bytes>8000)break;events.push(event);size+=bytes;}
    return {events,nextCursor:events.at(-1)?.revision??p.cursor};
   }
   case 'get_diff': {
    const result = this.store.getResult(p.task_id);
    const patch = result?.artifacts.find(a=>a.kind==='patch');
    if (!patch) return {available:false};
    const text = await readFile(patch.path,'utf8');
    return {available:true,text:text.slice(p.offset,p.offset+p.limit),nextOffset:p.offset+p.limit<text.length?p.offset+p.limit:null,totalCharacters:text.length};
   }
   case 'reconcile_task': return this.recoverTask(p.task_id,false);
   case 'resume_task': return this.recoverTask(p.task_id,true);
   case 'cancel_task': {
    let task = this.store.requestCancellation(p.task_id);
    if (task.status === 'queued') return compactTask(this.store.transitionTask(task.taskId,'cancelled',{executionStopped:{kind:'not_dispatched',evidence:'Task cancelled before dispatch intent'}}));
    if (!this.active.get(task.taskId)?.turn) await this.recoverTask(task.taskId,true);
    task = this.store.getTask(task.taskId);
    if (task.executionStopped) return {task:compactTask(task),cancelRequested:false,terminationConfirmed:true};
    const active = this.active.get(task.taskId);
    if (!active?.turn) {
     if (this.jobs.has(task.taskId)) return {task:compactTask(task),cancelRequested:true,terminationConfirmed:false,awaitingTurnIdentity:true};
     throw new Error('Cannot safely identify the current live turn; cancellation is persisted and prevents further continuation');
    }
    await active.connection.cancel(active.turn);
    return {taskId:task.taskId,cancelRequested:true,terminationConfirmed:false};
   }
   case 'respond_approval': {
    if(this.store.listUiApprovalActions<{approvalId:string;responseState:string}>(p.task_id).some(a=>a.approvalId===p.approval_id&&['intent_recorded','awaiting_native','unknown'].includes(a.responseState)))throw new UiRpcError('APPROVAL_RESPONSE_PENDING',{outcome:'not_started'});
    if (!this.active.get(p.task_id)?.turn) await this.recoverTask(p.task_id,true);
    const active = this.active.get(p.task_id);
    const task = this.store.getTask(p.task_id);
    if (!active?.turn || !active.session || task.executionStopped) throw new Error('Task has no safely attached live turn');
    if (active.approvalResponses?.has(p.approval_id)) {
     if (active.approvalResponses.get(p.approval_id) !== p.decision) throw new Error('A response was already sent for this approval; wait for its native revision');
     return {accepted:true,awaitingNativeRevision:true,task:compactTask(task)};
    }
    const snapshot = await active.connection.syncHistory(active.session);
    const observation = observeSnapshot(task,active.session,snapshot);
    if (observation.kind !== 'active' || !ownApprovals(task,snapshot,observation.header!).some(value=>approvalView(value)?.approvalId===p.approval_id)) throw new Error('Approval cannot be attributed to this original task; inspect it in local ZCode');
    if (p.decision === 'accept') {
     if (task.status === 'blocked' || !active.accountAlias) throw new Error('Task or account is blocked from accepting approvals; cancellation remains available');
     const account = await this.vault.load(active.accountAlias);
     if (UNAVAILABLE_HEALTH.has(account.health)) throw new Error('Account is unavailable; accepting approvals would bypass its blocked state');
    }
    await active.connection.respondApproval(active.turn,p.approval_id,p.decision);
    active.approvalResponses ??= new Map();
    active.approvalResponses.set(p.approval_id,p.decision);
    this.store.appendEvent(task.taskId,'approval_response_sent',{respondedApprovalId:p.approval_id,decision:p.decision});
    await this.refreshApprovalState(task.taskId,active);
    this.watchApprovalRevision(task.taskId,active);
    const current = this.store.getTask(task.taskId);
    return {accepted:true,awaitingNativeRevision:active.approvalResponses.size>0,pendingApprovalCount:record(current.detail).pendingApprovalCount??0,task:compactTask(current)};
   }
  }
 }

 private startJob(taskId: string, action: () => Promise<void>): void {
  if (this.jobs.has(taskId)) throw new Error('Task already has a coordinator operation');
  const job = Promise.resolve().then(action).catch(error => this.handleFailure(taskId,error)).finally(async () => {
   const active = this.active.get(taskId);
   this.active.delete(taskId);
   await active?.connection.close().catch(() => {});
   if (this.jobs.get(taskId) === job) this.jobs.delete(taskId);
  });
  this.jobs.set(taskId,job);
 }
 private handleFailure(taskId: string, error: unknown): void {
  const task = this.store.getTask(taskId);
  if (FINAL_STATUSES.has(task.status) || this.store.getResult(taskId)) return;
  const detail = safeDetail({message:error instanceof Error?error.message:'Execution status unknown',requiresInspection:true});
  if (task.status === 'verifying') this.store.interruptVerification(taskId,detail);
  else if (task.dispatchAttemptedAt === null) this.store.transitionTask(taskId,'failed',{detail,executionStopped:{kind:'not_dispatched',evidence:'Preflight failed before durable dispatch intent'}});
  else this.store.markInterrupted(taskId,detail);
 }
 private async run(taskId: string): Promise<void> {
  let connection: RuntimeConnection | undefined;
  try {
   let task = this.store.getTask(taskId);
   if (task.status !== 'queued' || this.closing) return;
   const workerId = task.requestedWorkerId;
   if (!workerId) throw new Error('Explicit worker required');
   const worker = await this.supervisor.status(workerId);
   if (worker.state !== 'ready' || !worker.endpoint) throw new Error('Worker not ready');
   const account = await this.vault.load(worker.accountAlias);
   if (UNAVAILABLE_HEALTH.has(account.health)) throw new Error('Account unavailable');
   if (this.closing) return;
   const ws = this.store.getWorkspace(task.workspaceId);
   const prior = task.session==='continue' ? this.store.listTasks().filter(t=>t.taskId!==taskId&&t.workspaceId===task.workspaceId&&t.workerId===workerId&&t.sessionId&&t.executionStopped).at(-1) : undefined;
   const policy = taskPolicy(task);
   const selection = {providerId:`account:${account.provider}-start-plan`,modelId:policy.modelId};
   task = this.store.beginDispatch(taskId,{workerId,sessionId:prior?.sessionId??undefined,runtimeBinding:{accountAlias:account.alias,...selection}});
   connection = await this.adapter.connect(worker.endpoint);
   const active: Active = {connection,accountAlias:account.alias};
   this.active.set(taskId,active);
   if (this.closing) return;
   const session = await connection.openSession({workspacePath:ws.worktreePath,sessionId:prior?.sessionId??undefined,modelSelection:selection,mode:policy.mode});
   if (resolve(session.workspacePath) !== resolve(ws.worktreePath) || (prior?.sessionId && session.sessionId !== prior.sessionId)) throw new Error('Native session identity did not match the requested workspace/session');
   active.session = session;
   this.store.bindSession(taskId,session.sessionId);
   if (this.closing) return;
   await this.sendAttempt(taskId,active,task.prompt);
   await this.consumeEvents(taskId,active);
  } finally {
   if (connection && !this.active.has(taskId)) await connection.close().catch(() => {});
   const task = this.store.getTask(taskId);
   if (['running','waiting_approval','dispatching'].includes(task.status)) this.store.markInterrupted(taskId,{reason:this.closing?'Daemon connection closed; native execution was not stopped':'Event stream ended before confirmed terminal'});
  }
 }
 private async sendAttempt(taskId: string, active: Active, prompt: string): Promise<void> {
  const task = this.store.getTask(taskId);
  const session = active.session!;
  const policy = taskPolicy(task);
  const binding = record(task.runtimeBinding);
  if (typeof binding.providerId!=='string' || typeof binding.modelId!=='string' || session.sessionId!==task.sessionId) throw new Error('Original runtime binding is unavailable; send refused');
  const selection: ModelSelection = {providerId:binding.providerId,modelId:binding.modelId};
  // Clear the old turn before awaiting the ACK: cancellation must never target a
  // previous stopped attempt while a new command may already be executing.
  active.turn = undefined;
  active.approvalResponses?.clear();
  const turn = await active.connection.sendTurn(session,{prompt,requestId:task.currentCommandId,modelSelection:selection,mode:policy.mode});
  if (turn.sessionId!==session.sessionId || turn.turnId!==task.currentCommandId || turn.commandId!==task.currentCommandId) throw new Error('Native acknowledgement did not identify the current command');
  active.turn = turn;
  this.store.acknowledgeDispatch(taskId,{sessionId:session.sessionId,turnId:turn.turnId});
  if (this.store.getTask(taskId).cancelRequestedAt!==null) await active.connection.cancel(turn);
 }
 private recordFailure(taskId: string, commandId: string, data: {errorAttribution?:unknown;category?:unknown;busyRetryEligible?:unknown}): void {
  if (data.errorAttribution!=='turn' || typeof data.category!=='string') return;
  this.store.recordAttemptFailure(taskId,commandId,{category:data.category,busyRetryEligible:data.busyRetryEligible===true});
 }
 private async continueBusyTask(taskId: string, active: Active, snapshot?: SessionSnapshot, header?: Record<string, any>): Promise<boolean> {
  let task = this.store.getTask(taskId);
  const attempt = this.store.getCurrentAttempt(taskId);
  if (!attempt?.busyRetryEligible || attempt.continuationBlocked || attempt.failureCategory!=='model_busy') return false;
  const policy = taskPolicy(task);
  if (task.busyRetryCount>=policy.busyRetryLimit) {
   this.store.appendEvent(taskId,'busy_continue_limit_reached',{retry:{used:task.busyRetryCount,max:policy.busyRetryLimit,reason:'model_busy'}});
   return false;
  }
  const session = active.session!;
  const history = snapshot ?? await active.connection.syncHistory(session);
  task = this.store.getTask(taskId);
  const observation = observeSnapshot(task,session,history);
  if (observation.kind!=='terminal' || observation.header!.state!=='failed' || (header && header.turnId!==observation.header!.turnId)) throw new Error('Busy continuation requires the current failed native turn and no active native work; occupancy retained');
  this.recordFailure(taskId,task.currentCommandId,classifyTurnFailure(record(history.raw),observation.header!));
  const checkedAttempt = this.store.getCurrentAttempt(taskId);
  if (!checkedAttempt?.busyRetryEligible || checkedAttempt.continuationBlocked || task.status==='blocked') return false;
  const proof: StopProof = {kind:'history_stopped',evidence:`Fresh snapshot command ${task.currentCommandId}: failed, no active work`};
  this.store.recordAttemptTerminal(taskId,task.currentCommandId,'failed',proof);
  if (task.cancelRequestedAt!==null || this.closing) return false;
  const binding = record(task.runtimeBinding);
  if (typeof binding.accountAlias!=='string' || typeof binding.providerId!=='string' || typeof binding.modelId!=='string'
   || active.accountAlias!==binding.accountAlias || binding.modelId!==policy.modelId) return false;
  const account = await this.vault.load(binding.accountAlias);
  if (UNAVAILABLE_HEALTH.has(account.health) || `account:${account.provider}-start-plan`!==binding.providerId) return false;
  if (history.modelSelection && (history.modelSelection.providerId!==binding.providerId || history.modelSelection.modelId!==binding.modelId)) throw new Error('Native session provider/model changed; busy continuation refused');
  task = this.store.getTask(taskId);
  if (task.cancelRequestedAt!==null || this.closing) return false;
  // This transaction is the only authorization to issue a new command. A crash
  // after it leaves an uncertain attempt that recovery observes without resend.
  task = this.store.beginBusyContinuation(taskId,task.currentCommandId,policy.busyRetryLimit);
  await this.sendAttempt(taskId,active,'继续');
  return true;
 }
 private publishApproval(taskId: string, value: Record<string, any>): ApprovalView | undefined {
  const view = approvalView(value);
  if (!view) return;
  const event = this.store.appendEvent(taskId,'approval_requested',{...view,detail:safeDetail(value)} as unknown as JsonValue);
  return {...view,approvalLogCursor:event.revision-1};
 }
 private async refreshApprovalState(taskId: string, active: Active): Promise<void> {
  let task = this.store.getTask(taskId);
  if (!active.session || task.executionStopped || !['running','waiting_approval','blocked'].includes(task.status)) return;
  const snapshot = await active.connection.syncHistory(active.session);
  task = this.store.getTask(taskId);
  if (task.executionStopped || !['running','waiting_approval','blocked'].includes(task.status)) return;
  const observation = observeSnapshot(task,active.session,snapshot);
  if (observation.kind !== 'active') return;
  const approvals = ownApprovals(task,snapshot,observation.header!);
  this.ui.noteObservedApprovalSet(task,approvals,observation.header!.turnId);
  const ids = new Set(approvals.map(value=>approvalView(value)?.approvalId));
  for (const id of active.approvalResponses?.keys() ?? []) if (!ids.has(id)) active.approvalResponses!.delete(id);
  const first = approvals[0] ? approvalView(approvals[0]) : undefined;
  const previous = record(task.detail);
  const view = first && first.approvalId!==previous.approvalId ? this.publishApproval(taskId,approvals[0]!) : first ? {...first,...(typeof previous.approvalLogCursor==='number'?{approvalLogCursor:previous.approvalLogCursor}:{})} : undefined;
  const awaiting = (active.approvalResponses?.size ?? 0)>0;
  this.store.transitionTask(taskId,task.status==='blocked'?'blocked':approvals.length?'waiting_approval':'running',{detail:{...(view as unknown as Record<string,JsonValue> ?? {}),reason:awaiting?'Approval response sent; waiting for the native pending-interaction revision':approvals.length?'Native approval remains pending':'No native approvals remain pending',pendingApprovalCount:approvals.length,approvalResponsePending:awaiting}});
 }
 private watchApprovalRevision(taskId: string, active: Active): void {
  if (!active.approvalResponses?.size || this.approvalRefreshes.has(taskId)) return;
  const refresh = (async () => {
   while (!this.closing && this.active.get(taskId)===active && active.approvalResponses?.size && !this.store.getTask(taskId).executionStopped) {
    await new Promise(resolve=>setTimeout(resolve,100));
    if (this.closing || this.active.get(taskId)!==active) break;
    await this.refreshApprovalState(taskId,active);
   }
  })().catch(()=>{/* Preserve pending state when a native revision cannot be confirmed. */}).finally(()=>{
   if (this.approvalRefreshes.get(taskId)===refresh) this.approvalRefreshes.delete(taskId);
  });
  this.approvalRefreshes.set(taskId,refresh);
 }
 private async consumeEvents(taskId: string, active: Active, cursor?: string): Promise<void> {
  const {connection,session} = active;
  if (!session || !active.turn) throw new Error('Missing native turn attachment');
  try {
   for await (const event of connection.events(session,cursor)) {
    if (this.closing) break;
    const turn = active.turn;
    if (!turn) throw new Error('Current native command has no confirmed acknowledgement');
    if (event.sessionId !== session.sessionId || (event.turnId && event.turnId !== turn.turnId)) continue;
    if (FINAL_STATUSES.has(this.store.getTask(taskId).status)) break;
    if (event.type === 'approval_requested') {
     const task = this.store.getTask(taskId);
     const source=connection.readApprovalSnapshot?await connection.readApprovalSnapshot(session):null;
     const snapshot = source?.snapshot??await connection.syncHistory(session);
     const observation = observeSnapshot(task,session,snapshot);
     if(observation.kind==='active'&&source){const approvals=ownApprovals(task,{...snapshot,pendingApprovals:source.pendingApprovals},observation.header!);this.ui.captureApprovals(task,{snapshot,approvals,nativeTurnId:observation.header!.turnId,sourceComplete:source.sourceComplete,stablePermissionIds:source.stablePermissionIds,unattributedCount:source.pendingApprovals.length-approvals.length});}
     const id = approvalView(event.data)?.approvalId;
     const approval = observation.kind==='active' ? ownApprovals(task,snapshot,observation.header!).find(value=>approvalView(value)?.approvalId===id) : undefined;
     if (!approval) continue;
     const view = this.publishApproval(taskId,approval);
     if (view && ['running','waiting_approval','blocked'].includes(task.status)) this.store.transitionTask(taskId,task.status==='blocked'?'blocked':'waiting_approval',{detail:{...view,pendingApprovalCount:ownApprovals(task,snapshot,observation.header!).length} as unknown as JsonValue});
     continue;
    }
    const terminal = ['turn_completed','turn_failed','turn_cancelled'].includes(event.type);
    if (terminal && event.turnId !== turn.turnId) continue;
    // Unattributed content from a session snapshot is never claimed as this task's output.
    if (!event.turnId && ['assistant_message','tool_call','tool_result','turn_started'].includes(event.type)) continue;
    this.store.appendEvent(taskId,event.type,safeDetail(event.data));
    if (event.type === 'error') {
     if (event.turnId===turn.turnId) this.recordFailure(taskId,turn.commandId,event.data);
     const category = event.data.category;
     if (category === 'risk_blocked' || category === 'auth_invalid') {
      if (active.accountAlias) await this.vault.setHealth(active.accountAlias,category==='risk_blocked'?'blocked':'invalid');
      this.store.markBlocked(taskId,safeDetail(event.data));
     }
     if (event.data.executionUncertain) {this.store.markInterrupted(taskId,safeDetail(event.data));break;}
    }
    if (terminal) {
     const proof: StopProof = {kind:'runtime_terminal',evidence:`${event.type}:${event.id}`};
     this.recordFailure(taskId,turn.commandId,event.data);
     this.store.recordAttemptTerminal(taskId,turn.commandId,event.type==='turn_completed'?'completedSuccess':event.type==='turn_failed'?'failed':'completedInterrupted',proof);
     if (event.type==='turn_failed' && await this.continueBusyTask(taskId,active)) continue;
     this.store.transitionTask(taskId,'verifying',{executionStopped:proof});
     await this.finishTask(taskId,active,event.type as TerminalEvent,proof);
     break;
    }
   }
  } finally {
   const task = this.store.getTask(taskId);
   if (['running','waiting_approval','dispatching'].includes(task.status)) this.store.markInterrupted(taskId,{reason:this.closing?'Daemon connection closed; native execution was not stopped':'Event stream ended before confirmed terminal'});
  }
 }
 private async finishTask(taskId: string, active: Active, type: TerminalEvent, proof: StopProof): Promise<void> {
  const task = this.store.getTask(taskId);
  if (this.store.getResult(taskId)) return;
  const session = active.session!;
  const history = await active.connection.syncHistory(session);
  const observation = observeSnapshot(task,session,history);
  if (observation.kind !== 'terminal') throw new Error(observation.reason ?? 'Original turn is not terminal with no active work; verification refused');
  const expected = type==='turn_completed'?'completedSuccess':type==='turn_failed'?'failed':'completedInterrupted';
  if (observation.header!.state !== expected) throw new Error('Native terminal state conflicts with the observed terminal event');
  this.ui.noteObservedApprovalSet(task,ownApprovals(task,history,observation.header!),observation.header!.turnId);
  if (type === 'turn_cancelled' || (type==='turn_failed' && this.store.getTask(taskId).cancelRequestedAt!==null)) {
   this.store.transitionTask(taskId,'cancelled',{executionStopped:proof});
   return;
  }
  const result: TaskResult = {summary:taskSummary(task,history,observation.header!),changedFiles:[],verification:[],blockers:[]};
  if (type === 'turn_failed') {
   this.recordFailure(taskId,task.currentCommandId,classifyTurnFailure(record(history.raw),observation.header!));
   const attempt = this.store.getCurrentAttempt(taskId);
   const policy = taskPolicy(task);
   result.blockers = [attempt?.busyRetryEligible && !attempt.continuationBlocked
    ? `Native model remains busy; ${task.busyRetryCount} of ${policy.busyRetryLimit} same-session continuations used`
    : 'Native ZCode turn failed; no eligible model-busy continuation'];
   this.store.completeTask(taskId,result,{status:'failed',executionStopped:proof});
   return;
  }
  const policy = taskPolicy(task);
  const ws = this.store.getWorkspace(task.workspaceId);
  const commands = policy.verifyCommands.length ? policy.verifyCommands : [{command:'git',args:['diff','--check'],timeout_ms:30_000}];
  for (const command of commands) {
   try {
    const out = await exec(command.command,command.args,{cwd:ws.worktreePath,timeout:command.timeout_ms,maxBuffer:1024*1024});
    result.verification!.push({command:[command.command,...command.args].join(' '),exitCode:0,summary:String(redact(out.stdout+out.stderr)).slice(0,1500)});
   } catch (error: any) {
    result.verification!.push({command:[command.command,...command.args].join(' '),exitCode:typeof error.code==='number'?error.code:null,summary:String(redact(error.stdout??'')).slice(0,1000)});
   }
  }
  const snapshot = await snapshotWorkspace(this.root,taskId,ws);
  const patch = await readFile(snapshot.patchFile);
  result.artifacts = [{kind:'patch',path:snapshot.patchFile,sha256:createHash('sha256').update(patch).digest('hex'),sizeBytes:patch.length,mediaType:'text/x-diff'},snapshot.manifestArtifact,...snapshot.snapshotArtifacts];
  result.changedFiles = snapshot.changedFiles;
  if (!policy.verifyCommands.length) result.blockers!.push('Only git diff --check was configured; functional acceptance remains for reviewer');
  this.store.completeTask(taskId,result,{status:result.verification!.every(v=>v.exitCode===0)?'succeeded':'failed',executionStopped:proof});
 }

 /** Restore observation; only a proved busy terminal may start a fresh bounded continuation. */
 async recoverTasks(): Promise<RecoveryResult[]> {
  const candidates = this.store.listTasks().filter(task=>task.leaseHeld);
  return Promise.all(candidates.map(task=>this.recoverTask(task.taskId,true)));
 }
 private recoverTask(taskId: string, attach: boolean): Promise<RecoveryResult> {
  const existing = this.recoveries.get(taskId);
  if (existing) return existing.attach===attach ? existing.promise : existing.promise.then(()=>this.recoverTask(taskId,attach));
  const promise = this.inspectTask(taskId,attach).finally(() => {
   if (this.recoveries.get(taskId)?.promise === promise) this.recoveries.delete(taskId);
  });
  this.recoveries.set(taskId,{attach,promise});
  return promise;
 }
 private inspection(taskId: string, reason: string): RecoveryResult {
  const task = this.store.recordRecoveryInspection(taskId,{reason,requiresInspection:true,occupancyRetained:true});
  return {task:compactTask(task),attached:false,requiresInspection:true,reason,executionStopped:task.executionStopped};
 }
 private async inspectTask(taskId: string, attach: boolean): Promise<RecoveryResult> {
  let task = this.store.getTask(taskId);
  if (this.closing) return {task:compactTask(task),attached:false,reason:'Daemon is shutting down'};
  if (this.jobs.has(taskId)) return {task:compactTask(task),attached:!!this.active.get(taskId)?.turn,operationInProgress:true,finalizing:task.status==='verifying'};
  if (!task.leaseHeld) return {task:compactTask(task),attached:false,alreadyStopped:true,executionStopped:task.executionStopped};
  if (this.store.hasEnteredVerification(taskId)) return this.inspection(taskId,'Verification was interrupted and may have left local subprocesses. Inspect those processes and workspace; automatic verification retry and lease release are refused');
  if (task.dispatchAttemptedAt === null) {
   this.store.markInterrupted(taskId,{reason:'Not dispatched before interruption'});
   task = this.store.observeExecutionStopped(taskId,{kind:'not_dispatched',evidence:'No durable dispatch intent exists'});
   return {task:compactTask(task),attached:false,executionStopped:true};
  }
  if (!task.workerId || !task.sessionId) return this.inspection(taskId,'No confirmed native session identity; occupancy retained');
  if (task.executionStopped) return this.inspection(taskId,'A stopped task still holds occupancy; inspect unfinished local work before releasing it');
  let connection: RuntimeConnection | undefined;
  let transferred = false;
  try {
   const worker = await this.supervisor.status(task.workerId);
   if (!worker.endpoint || worker.state !== 'ready') return this.inspection(taskId,'Native worker unavailable; occupancy retained');
   connection = await this.adapter.connect(worker.endpoint);
   this.pendingConnections.add(connection);
   if (this.closing) return {task:compactTask(this.store.getTask(taskId)),attached:false,reason:'Daemon is shutting down'};
   const ws = this.store.getWorkspace(task.workspaceId);
   // An existing session ID is mandatory: this call subscribes without createSession or config writes.
   const session = await connection.openSession({workspacePath:ws.worktreePath,sessionId:task.sessionId});
   if (session.sessionId !== task.sessionId || resolve(session.workspacePath) !== resolve(ws.worktreePath)) return this.inspection(taskId,'Native openSession returned a different session or workspace identity; occupancy retained');
   const snapshot = await connection.syncHistory(session);
   if (this.closing) return {task:compactTask(this.store.getTask(taskId)),attached:false,reason:'Daemon is shutting down'};
   const observation = observeSnapshot(task,session,snapshot);
   if (observation.kind === 'unknown') return {...this.inspection(taskId,observation.reason!),nativePhase:snapshot.phase,nativeTurnState:observation.header?.state??'unknown'};
   if (observation.kind==='terminal' && observation.header!.state==='failed') this.recordFailure(taskId,task.currentCommandId,classifyTurnFailure(record(snapshot.raw),observation.header!));
   if (!attach) {
    if (observation.kind === 'terminal') {
     this.store.markInterrupted(taskId,{reason:'Recovered terminal native turn; configured verification was not run',nativeTurnState:observation.header!.state});
     task = this.store.observeExecutionStopped(taskId,{kind:'history_stopped',evidence:`Fresh snapshot command ${task.currentCommandId}: ${observation.header!.state}, no active work`});
     if (!this.store.getResult(taskId)) this.store.recordResult(taskId,{summary:taskSummary(task,snapshot,observation.header!),blockers:['Recovered native completion by read-only reconciliation; configured verification was not run. Review workspace before continuing.']});
    }
    return {task:compactTask(this.store.getTask(taskId)),attached:false,nativePhase:snapshot.phase,nativeTurnState:observation.header!.state,executionStopped:observation.kind==='terminal',canResume:observation.kind==='active'};
   }
   const turn: TurnRef = {...session,turnId:task.currentCommandId,commandId:task.currentCommandId};
   const active: Active = {connection,session,turn,accountAlias:worker.accountAlias};
   if (observation.kind === 'terminal') {
    const proof: StopProof = {kind:'history_stopped',evidence:`Fresh snapshot command ${task.currentCommandId}: ${observation.header!.state}, no active work`};
    this.store.recordAttemptTerminal(taskId,task.currentCommandId,observation.header!.state,proof);
    if (observation.header!.state === 'completedInterrupted') {
     task = this.store.transitionTask(taskId,'cancelled',{executionStopped:proof});
     return {task:compactTask(task),attached:false,executionStopped:true};
    }
    this.active.set(taskId,active);
    transferred = true;
    const attempt = this.store.getCurrentAttempt(taskId);
    if (observation.header!.state==='failed' && attempt?.busyRetryEligible && !attempt.continuationBlocked
      && task.cancelRequestedAt===null && task.busyRetryCount<taskPolicy(task).busyRetryLimit) {
     this.startJob(taskId,async()=>{
      if (await this.continueBusyTask(taskId,active,snapshot,observation.header)) {
       // Start at the pre-send snapshot, so even a terminal buffered before ACK
       // is consumed while old attempts are filtered by their command identity.
       await this.consumeEvents(taskId,active,snapshot.cursor);
       return;
      }
      this.store.transitionTask(taskId,'verifying',{executionStopped:proof});
      await this.finishTask(taskId,active,'turn_failed',proof);
     });
     return {task:compactTask(this.store.getTask(taskId)),attached:true,executionStopped:false};
    }
    this.store.transitionTask(taskId,'verifying',{executionStopped:proof,detail:{reason:'Recovered current terminal native turn; completing verification and snapshot'}});
    this.startJob(taskId,()=>this.finishTask(taskId,active,observation.header!.state==='failed'?'turn_failed':'turn_completed',proof));
    return {task:compactTask(this.store.getTask(taskId)),attached:false,executionStopped:true,finalizing:true};
   }
   let approvalBlocked = task.status === 'blocked';
   try {
    if (!worker.accountAlias || UNAVAILABLE_HEALTH.has((await this.vault.load(worker.accountAlias)).health)) approvalBlocked = true;
   } catch { approvalBlocked = true; }
   if (this.closing) return {task:compactTask(this.store.getTask(taskId)),attached:false,reason:'Daemon is shutting down'};
   const approvals = ownApprovals(task,snapshot,observation.header!);
   const preview = approvals.slice(0,20).map(approvalView).filter((view): view is ApprovalView=>view!==undefined);
   const detail: JsonValue = {reason:approvalBlocked?'Reattached original turn for observation and cancellation; accepting approvals is blocked':'Reattached original native turn',...(preview[0] as unknown as Record<string,JsonValue> ?? {}),pendingApprovalCount:approvals.length};
   this.store.reattachTask(taskId,{sessionId:session.sessionId,turnId:turn.turnId,status:approvalBlocked?'blocked':approvals.length?'waiting_approval':'running',detail});
   const pendingApprovals = approvals.slice(0,20).map(value=>this.publishApproval(taskId,value)).filter((view): view is ApprovalView=>view!==undefined);
   if (pendingApprovals[0]) this.store.reattachTask(taskId,{sessionId:session.sessionId,turnId:turn.turnId,status:approvalBlocked?'blocked':'waiting_approval',detail:{...detail as Record<string,JsonValue>,approvalLogCursor:pendingApprovals[0].approvalLogCursor!}});
   this.active.set(taskId,active);
   transferred = true;
   // The initial snapshot has already been inspected and its own approvals published. Skip its historical output.
   this.startJob(taskId,()=>this.consumeEvents(taskId,active,snapshot.cursor));
   if (task.cancelRequestedAt!==null) await active.connection.cancel(turn);
   return {task:compactTask(this.store.getTask(taskId)),attached:true,executionStopped:false,pendingApprovals,pendingApprovalCount:approvals.length,pendingApprovalsTruncated:approvals.length>20,...(snapshot.pendingApprovals.length>approvals.length?{requiresInspection:true,reason:'Some native approvals cannot be attributed to this task; review them in local ZCode'}:{})};
  } catch {
   // Native errors can contain prompts or unmarked credentials. Only a fixed control
   // diagnostic may cross this default-output boundary, even when recovery fails.
   return this.inspection(taskId,'Native recovery could not be confirmed; check local worker availability and session identity. Occupancy retained');
  } finally {
   if (connection) {
    this.pendingConnections.delete(connection);
    if (!transferred) await connection.close().catch(() => {});
   }
  }
 }
 async close(): Promise<void> {
  this.closing = true;
  await this.workerChanges.catch(() => {});
  await Promise.allSettled([...this.pendingConnections,...[...this.active.values()].map(value=>value.connection)].map(connection=>connection.close()));
  await Promise.allSettled([...this.recoveries.values()].map(value=>value.promise));
  await Promise.allSettled([...this.approvalOperations.values()]);
  await Promise.allSettled([...this.jobs.values()]);
  await Promise.allSettled([...this.approvalRefreshes.values()]);
 }
}
