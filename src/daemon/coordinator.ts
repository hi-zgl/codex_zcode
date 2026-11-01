import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { AccountVault } from '../accounts/index.js';
import { WorkerSupervisor } from '../supervisor/index.js';
import { ZCodeServerAdapter } from '../runtime/zcode-server/index.js';
import type { RuntimeConnection, SessionRef, TurnRef, ExecutionMode } from '../runtime/types.js';
import { redact } from '../runtime/zcode-server/events.js';
import { DurableTaskStore } from '../core/index.js';
import type { Task, JsonValue, TaskResult } from '../core/types.js';
import { validateMethod, type MethodName } from '../shared/methods.js';
import { createWorkspace, snapshotWorkspace } from './workspace.js';
const exec = promisify(execFile);
function compactTask(task: Task) {return {taskId:task.taskId,workspaceId:task.workspaceId,workerId:task.workerId,sessionId:task.sessionId,status:task.status,revision:task.revision,leaseHeld:task.leaseHeld,detail:task.detail};}
function safeDetail(value: unknown): JsonValue {
  const cleaned = redact(value);
  const text=JSON.stringify(cleaned);
  return text.length<=4000 ? JSON.parse(text) : {truncated:true,summary:text.slice(0,3500)};
}
interface Active {connection:RuntimeConnection;session?:SessionRef;turn?:TurnRef}
export class Coordinator {
 readonly vault: AccountVault;
 readonly supervisor:WorkerSupervisor;
 readonly adapter=new ZCodeServerAdapter();
 readonly active=new Map<string,Active>();
 private closing=false;
 private workerChanges:Promise<unknown>=Promise.resolve();
 constructor(readonly root:string,readonly store:DurableTaskStore) {
  this.vault=new AccountVault(join(root,'accounts'));
  this.supervisor=new WorkerSupervisor({poolRoot:root});
 }
 async call(method:string,input:Record<string,unknown>):Promise<unknown> {
  const {name,params:p}=validateMethod(method,input);
  if(name==='start_worker'||name==='stop_worker'||name==='dispatch_task') {
   const operation=this.workerChanges.then(()=>this.handle(name,p));
   this.workerChanges=operation.catch(()=>{});
   return operation;
  }
  return this.handle(name,p);
 }
 private async handle(name:MethodName,p:any):Promise<unknown> {
  switch(name) {
   case 'daemon_stop': throw new Error('Daemon lifecycle is handled by the local server');
   case 'overview': return {accounts:await this.vault.list(),workers:(await this.supervisor.list()).map(({endpoint,...w})=>w),workspaces:this.store.listWorkspaces(),tasks:this.store.listTasks().slice(-50).map(compactTask)};
   case 'import_accounts': return this.vault.import(p.files);
   case 'start_worker': {
    if(this.store.listTasks().some(t=>t.workerId===p.worker_id&&t.leaseHeld)) throw new Error('Worker has an active or uncertain task');
    const account=await this.vault.load(p.account_id);
    const workers=await this.supervisor.list();
    if(workers.some(w=>w.accountAlias===p.account_id&&w.workerId!==p.worker_id&&w.state!=='stopped')) throw new Error('Account is already assigned to another live worker');
    const h=await this.supervisor.start({workerId:p.worker_id,account});
    return {workerId:h.workerId,accountAlias:h.accountAlias,version:h.version,identity:h.identity};
   }
   case 'stop_worker': {
    if(this.store.listTasks().some(t=>t.workerId===p.worker_id&&t.leaseHeld)) throw new Error('Worker has an active or uncertain task; reconcile before stopping');
    return this.supervisor.stop(p.worker_id);
   }
   case 'probe_worker': {
    const worker=await this.supervisor.status(p.worker_id);
    if(!worker.endpoint||worker.state!=='ready') throw new Error('Worker not ready');
    const info=await this.adapter.probe(worker.endpoint);
    const account=await this.vault.load(worker.accountAlias);
    const connection=await this.adapter.connect(worker.endpoint);
    try {
     const providerId=`account:${account.provider}-start-plan`;
     const quota=await connection.quota(providerId);
     if(account.health==='unknown'&&quota.authenticated===true&&(quota.provider as any)?.id===providerId&&typeof (quota.remaining as any)?.count==='number'&&(quota.remaining as any).count>0) await this.vault.setHealth(account.alias,'available');
     return {info,quota};
    }
    finally {await connection.close();}
   }
   case 'create_workspace': return this.store.registerWorkspace(await createWorkspace(this.root,p.repository,p.base_ref));
   case 'dispatch_task': {
    const result=this.store.dispatch({workspaceId:p.workspace_id,workerId:p.worker_id,requestId:p.request_id,prompt:p.prompt,session:p.session,executionPolicy:{mode:p.mode,modelId:p.model_id,verifyCommands:p.verify_commands}});
    if(result.created) void this.run(result.task.taskId).catch(error=>{
     try {this.store.markInterrupted(result.task.taskId,safeDetail({message:error instanceof Error?error.message:'Task coordination failed'}));} catch {}
    });
    return {task:compactTask(result.task),created:result.created};
   }
   case 'wait': {
    const result=await this.store.wait({taskIds:p.task_ids,afterRevision:p.after_revision,timeoutMs:p.timeout_sec*1000});
    return {...result,tasks:result.tasks.map(compactTask)};
   }
   case 'get_result': return {task:compactTask(this.store.getTask(p.task_id)),result:this.store.getResult(p.task_id)};
   case 'get_logs': {
    const entries=this.store.listEvents(p.task_id,{afterRevision:p.cursor,limit:p.limit});
    const events=[]; let size=0;
    for(const event of entries) {const bytes=Buffer.byteLength(JSON.stringify(event));if(events.length&&size+bytes>8000)break;events.push(event);size+=bytes;}
    return {events,nextCursor:events.at(-1)?.revision??p.cursor};
   }
   case 'get_diff': {
    const result=this.store.getResult(p.task_id);
    const patch=result?.artifacts.find(a=>a.kind==='patch');
    if(!patch) return {available:false};
    const text=await readFile(patch.path,'utf8');
    return {available:true,text:text.slice(p.offset,p.offset+p.limit),nextOffset:p.offset+p.limit<text.length?p.offset+p.limit:null,totalCharacters:text.length};
   }
   case 'reconcile_task': {
    const task=this.store.getTask(p.task_id);
    if(this.active.has(task.taskId)) return {task:compactTask(task),attached:true};
    if(!task.leaseHeld) return {task:compactTask(task),alreadyStopped:true};
    if(!task.dispatchAttemptedAt) {
     this.store.markInterrupted(task.taskId,{reason:'Not dispatched before interruption'});
     return {task:compactTask(this.store.observeExecutionStopped(task.taskId,{kind:'not_dispatched',evidence:'No durable dispatch intent exists'}))};
    }
    if(!task.workerId||!task.sessionId) return {task:compactTask(task),requiresInspection:true,reason:'No confirmed native session identity; occupancy retained'};
    const worker=await this.supervisor.status(task.workerId);
    if(!worker.endpoint||worker.state!=='ready') return {task:compactTask(task),requiresInspection:true,reason:'Native worker unavailable; occupancy retained'};
    const conn=await this.adapter.connect(worker.endpoint);
    try {
     const ws=this.store.getWorkspace(task.workspaceId);
     const session=await conn.openSession({workspacePath:ws.worktreePath,sessionId:task.sessionId});
     const snapshot=await conn.syncHistory(session);
     const raw=snapshot.raw as any;
     const header=(raw.rows?.window??[]).find((row:any)=>row.kind==='turnHeader'&&row.sourceCommandId===task.requestId);
     const stopped=['completedSuccess','failed','completedInterrupted'].includes(header?.state)&&Array.isArray(raw.control?.activeWorks)&&raw.control.activeWorks.length===0;
     if(stopped) {
      this.store.markInterrupted(task.taskId,{reason:'Recovered terminal native turn; review before new dispatch',nativeState:header.state});
      this.store.observeExecutionStopped(task.taskId,{kind:'history_stopped',evidence:`Fresh snapshot command ${task.requestId}: ${header.state}, no active work`});
      if(!this.store.getResult(task.taskId)) this.store.recordResult(task.taskId,{summary:snapshot.summary.slice(0,2000),blockers:['Recovered native completion; configured verification was not rerun. Review workspace before continuing.']});
     }
     return {task:compactTask(this.store.getTask(task.taskId)),nativePhase:snapshot.phase,nativeTurnState:header?.state??'unknown',executionStopped:stopped};
    } finally {await conn.close();}
   }
   case 'cancel_task': {
    const task=this.store.getTask(p.task_id);
    if(task.status==='queued') return compactTask(this.store.transitionTask(task.taskId,'cancelled',{executionStopped:{kind:'not_dispatched',evidence:'Task cancelled before dispatch intent'}}));
    const active=this.active.get(task.taskId);
    if(!active?.turn) throw new Error('No live turn attachment; execution must be reconciled, not assumed stopped');
    await active.connection.cancel(active.turn);
    return {taskId:task.taskId,cancelRequested:true,terminationConfirmed:false};
   }
   case 'respond_approval': {
    const active=this.active.get(p.task_id);
    if(!active?.turn) throw new Error('Task has no live turn attachment');
    await active.connection.respondApproval(active.turn,p.approval_id,p.decision);
    const task=this.store.getTask(p.task_id);
    if(task.status==='waiting_approval') this.store.transitionTask(task.taskId,'running',{detail:{approvalId:p.approval_id,decision:p.decision}});
    return {accepted:true};
   }
  }
 }
 private async run(taskId:string):Promise<void> {
  let connection:RuntimeConnection|undefined;
  try {
   let task=this.store.getTask(taskId);
   const workerId=task.requestedWorkerId;
   if(!workerId) throw new Error('Explicit worker required');
   const worker=await this.supervisor.status(workerId);
   if(worker.state!=='ready'||!worker.endpoint) throw new Error('Worker not ready');
   const account=await this.vault.load(worker.accountAlias);
   if(account.health==='blocked'||account.health==='invalid'||account.health==='cooling') throw new Error('Account unavailable');
   const ws=this.store.getWorkspace(task.workspaceId);
   const prior=task.session==='continue' ? this.store.listTasks().filter(t=>t.taskId!==taskId&&t.workspaceId===task.workspaceId&&t.workerId===workerId&&t.sessionId&&t.executionStopped).at(-1) : undefined;
   task=this.store.beginDispatch(taskId,{workerId,sessionId:prior?.sessionId??undefined});
   connection=await this.adapter.connect(worker.endpoint);
   const policy=task.executionPolicy as {mode:ExecutionMode;modelId:string;verifyCommands:{command:string;args:string[];timeout_ms:number}[]};
   const selection={providerId:`account:${account.provider}-start-plan`,modelId:policy.modelId};
   const session=await connection.openSession({workspacePath:ws.worktreePath,sessionId:prior?.sessionId??undefined,modelSelection:selection,mode:policy.mode});
   this.store.bindSession(taskId,session.sessionId);
   const active:Active={connection,session}; this.active.set(taskId,active);
   const turn=await connection.sendTurn(session,{prompt:task.prompt,requestId:task.requestId,modelSelection:selection,mode:policy.mode});
   active.turn=turn;
   this.store.acknowledgeDispatch(taskId,{sessionId:session.sessionId,turnId:turn.turnId});
   for await(const event of connection.events(session)) {
    if(this.closing) break;
    if(event.turnId&&event.turnId!==turn.turnId) continue;
    this.store.appendEvent(taskId,event.type,safeDetail(event.data));
    if(event.type==='approval_requested') {
     const current=this.store.getTask(taskId);
     if(current.status==='running') this.store.transitionTask(taskId,'waiting_approval',{detail:safeDetail(event.data)});
    }
    if(event.type==='error') {
     const category=event.data.category;
     if(category==='risk_blocked'||category==='auth_invalid') {
      await this.vault.setHealth(account.alias,category==='risk_blocked'?'blocked':'invalid');
      this.store.markBlocked(taskId,safeDetail(event.data));
     }
     if(event.data.executionUncertain) {this.store.markInterrupted(taskId,safeDetail(event.data));break;}
    }
    if(['turn_completed','turn_failed','turn_cancelled'].includes(event.type)) {
     const proof={kind:'runtime_terminal' as const,evidence:`${event.type}:${event.id}`};
     if(event.type==='turn_cancelled') {this.store.transitionTask(taskId,'cancelled',{executionStopped:proof});break;}
     if(event.type==='turn_completed') this.store.transitionTask(taskId,'verifying',{executionStopped:proof});
     else this.store.observeExecutionStopped(taskId,proof);
     const history=await connection.syncHistory(session);
     const result:TaskResult={summary:history.summary.slice(0,2000),changedFiles:[],verification:[],blockers:[]};
     if(event.type==='turn_failed') {
      result.blockers=['Native ZCode turn failed; no automatic retry'];
      this.store.completeTask(taskId,result,{status:'failed',executionStopped:proof});break;
     }
     const commands=policy.verifyCommands.length ? policy.verifyCommands : [{command:'git',args:['diff','--check'],timeout_ms:30_000}];
     for(const command of commands) {
      try {
       const out=await exec(command.command,command.args,{cwd:ws.worktreePath,timeout:command.timeout_ms,maxBuffer:1024*1024});
       result.verification!.push({command:[command.command,...command.args].join(' '),exitCode:0,summary:String(redact(out.stdout+out.stderr)).slice(0,1500)});
      } catch(error:any) {
       result.verification!.push({command:[command.command,...command.args].join(' '),exitCode:typeof error.code==='number'?error.code:null,summary:String(redact(error.stdout??'')).slice(0,1000)});
      }
     }
     const snapshot=await snapshotWorkspace(this.root,taskId,ws);
     const patch=await readFile(snapshot.patchFile);
     result.artifacts=[{kind:'patch',path:snapshot.patchFile,sha256:createHash('sha256').update(patch).digest('hex'),sizeBytes:patch.length,mediaType:'text/x-diff'}];
     result.changedFiles=snapshot.changedFiles;
     for(const file of snapshot.untracked) result.artifacts.push({kind:'untracked',path:join(this.root,'scheduler','artifacts',taskId,file.artifact),sha256:file.sha256,sizeBytes:(await readFile(join(this.root,'scheduler','artifacts',taskId,file.artifact))).length});
     if(!policy.verifyCommands.length) result.blockers!.push('Only git diff --check was configured; functional acceptance remains for reviewer');
     this.store.completeTask(taskId,result,{status:result.verification!.every(v=>v.exitCode===0)?'succeeded':'failed',executionStopped:proof});
     break;
    }
   }
   const current=this.store.getTask(taskId);
   if(['running','waiting_approval','dispatching'].includes(current.status)) this.store.markInterrupted(taskId,{reason:'Event stream ended before confirmed terminal'});
  } catch(error) {
   const current=this.store.getTask(taskId);
   const detail=safeDetail({message:error instanceof Error?error.message:'Execution status unknown'});
   if(current.dispatchAttemptedAt===null) this.store.transitionTask(taskId,'failed',{detail,executionStopped:{kind:'not_dispatched',evidence:'Preflight failed before durable dispatch intent'}});
   else this.store.markInterrupted(taskId,detail);
  } finally {
   this.active.delete(taskId); await connection?.close().catch(()=>{});
  }
 }
 async close() {this.closing=true; await Promise.allSettled([...this.active.values()].map(a=>a.connection.close()));}
}
