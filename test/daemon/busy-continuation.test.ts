import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { CoreError, DurableTaskStore } from '../../src/core/index.js';
import { Coordinator } from '../../src/daemon/coordinator.js';
import type { OpenSessionInput, RuntimeConnection, RuntimeEvent, RuntimeInfo, SessionRef, SessionSnapshot, TurnInput, TurnRef } from '../../src/runtime/types.js';

const exec = promisify(execFile);
type Outcome = 'busy' | 'success' | 'running' | 'busy_error_only' | 'rate_limited' | 'auth_invalid' | 'unknown';

/** An append-only native history. Events emitted before an ACK remain available. */
class BusyRuntime implements RuntimeConnection {
 readonly info: RuntimeInfo = {adapterId:'fake',version:'3.16.3',protocolVersion:1,authRequired:false,authenticated:true,supported:true};
 readonly sent: {session:SessionRef;input:TurnInput}[] = [];
 readonly opened: OpenSessionInput[] = [];
 readonly cancelled: TurnRef[] = [];
 readonly cursors: (string | undefined)[] = [];
 readonly eventsLog: RuntimeEvent[] = [];
 readonly headers: Record<string,any>[] = [];
 outcomes: Outcome[] = ['busy','success'];
 activeWorks: Record<string,unknown>[] = [];
 lastError?: Record<string,unknown>;
 closed = false;
 ackErrorAt?: number;
 onSend?: (input:TurnInput,index:number)=>void | Promise<void>;
 onSnapshot?: ()=>void | Promise<void>;
 snapshotPatch?: (snapshot:SessionSnapshot)=>void;
 private wake?: ()=>void;
 async openSession(input:OpenSessionInput):Promise<SessionRef> {
  this.opened.push(input);return {sessionId:input.sessionId??'native-session',workspacePath:input.workspacePath};
 }
 emit(type:RuntimeEvent['type'],commandId:string,data:Record<string,unknown>={}):void {
  const cursor=String(this.eventsLog.length+1);
  this.eventsLog.push({id:`native:${cursor}`,cursor,type,sessionId:'native-session',turnId:commandId,timestamp:Date.now(),data});this.wake?.();
 }
 async sendTurn(session:SessionRef,input:TurnInput):Promise<TurnRef> {
  this.sent.push({session:{...session},input:structuredClone(input)});
  const index=this.sent.length-1;const commandId=input.requestId!;const now=Date.now()+index;
  const header={kind:'turnHeader',rowId:index*10+1,turnId:`native-turn-${index}`,sourceCommandId:commandId,state:'running',startedAt:now};
  this.headers.push(header);this.activeWorks=[{sourceCommandId:commandId,turnId:header.turnId}];this.lastError=undefined;
  this.emit('turn_started',commandId);
  const outcome=this.outcomes[index]??'success';
  if(outcome==='success') {
   Object.assign(header,{state:'completedSuccess',endedAt:now+1});this.activeWorks=[];this.emit('turn_completed',commandId);
  } else if(outcome!=='running') {
   const category=outcome==='busy'||outcome==='busy_error_only'?'model_busy':outcome;
   this.lastError={sourceCommandId:commandId,turnId:header.turnId,at:now+1,message:category==='model_busy'?'model is busy':category==='rate_limited'?'429 rate limit':category==='auth_invalid'?'401 unauthorized':'unexpected failure'};
   const data={...this.lastError,category,errorAttribution:'turn',busyRetryEligible:category==='model_busy'};
   this.emit('error',commandId,data);
   if(outcome!=='busy_error_only') {Object.assign(header,{state:'failed',endedAt:now+1});this.activeWorks=[];this.emit('turn_failed',commandId,data);}
  }
  await this.onSend?.(input,index);
  if(this.ackErrorAt===index)throw new Error('ACK lost after possible native acceptance');
  return {...session,turnId:commandId,commandId};
 }
 async syncHistory(session:SessionRef):Promise<SessionSnapshot> {
  await this.onSnapshot?.();
  const latest=this.headers.at(-1)!;
  const snapshot:SessionSnapshot={...session,phase:latest?.state??'idle',revision:this.eventsLog.length,cursor:String(this.eventsLog.length),summary:'foreign summary',pendingApprovals:[],modelSelection:{providerId:'account:zai-start-plan',modelId:'GLM-5.3-Flash'},raw:{sessionId:session.sessionId,control:{activeWorks:structuredClone(this.activeWorks),...(this.lastError?{lastError:structuredClone(this.lastError)}:{})},rows:{window:this.headers.flatMap(header=>[structuredClone(header),{kind:'assistantText',rowId:header.rowId+1,turnId:header.turnId,text:`Result for ${header.sourceCommandId}`}])}}};
  this.snapshotPatch?.(snapshot);return snapshot;
 }
 async *events(_session:SessionRef,cursor?:string):AsyncIterable<RuntimeEvent> {
  this.cursors.push(cursor);let after=Number(cursor??0);
  while(!this.closed) {
   const batch=this.eventsLog.filter(event=>Number(event.cursor)>after);
   for(const event of batch){after=Number(event.cursor);yield event;}
   if(this.closed)break;
   await new Promise<void>(resolve=>{this.wake=resolve;if(this.closed||this.eventsLog.some(event=>Number(event.cursor)>after))resolve();});
  }
 }
 async queryCommand():Promise<'unknown'>{return 'unknown';}
 async quota():Promise<Record<string,unknown>>{return {};}
 async respondApproval():Promise<void>{}
 async cancel(turn:TurnRef):Promise<void>{this.cancelled.push({...turn});}
 async close():Promise<void>{this.closed=true;this.wake?.();}
}

async function until(predicate:()=>boolean):Promise<void> {
 const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('Busy fixture did not settle');await delay(5);}
}
function connect(coordinator:Coordinator,runtime:BusyRuntime):void {
 Object.defineProperty(coordinator.supervisor,'status',{value:async()=>({workerId:'worker',accountAlias:'account-fixture',state:'ready',endpoint:{baseUrl:'http://127.0.0.1:1'}})});
 Object.defineProperty(coordinator.vault,'load',{value:async()=>({alias:'account-fixture',provider:'zai',health:'available'}),configurable:true});
 Object.defineProperty(coordinator.vault,'setHealth',{value:async()=>{}});
 Object.defineProperty(coordinator.adapter,'connect',{value:async()=>{runtime.closed=false;return runtime;}});
}
async function fixture(t:TestContext) {
 const root=await mkdtemp(join(tmpdir(),'zcode-busy-'));const repo=join(root,'repo');await mkdir(repo);
 await exec('git',['init','-b','trunk',repo]);await writeFile(join(repo,'code.txt'),'baseline\n');await exec('git',['-C',repo,'add','.']);
 await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','baseline']);
 const baseCommit=(await exec('git',['-C',repo,'rev-parse','HEAD'])).stdout.trim();
 const databasePath=join(root,'scheduler','state.db');const store=new DurableTaskStore(databasePath,{pollIntervalMs:5});
 store.registerWorkspace({workspaceId:'workspace',repositoryPath:repo,worktreePath:repo,branch:'trunk',baseCommit});
 const coordinator=new Coordinator(root,store);const runtime=new BusyRuntime();connect(coordinator,runtime);
 const coordinators=[coordinator];const stores=[store];
 t.after(async()=>{await Promise.all(coordinators.map(value=>value.close()));for(const value of stores)value.close();await rm(root,{recursive:true,force:true});});
 return {root,repo,databasePath,store,coordinator,runtime,
  async restart(){await coordinator.close();store.close();const nextStore=new DurableTaskStore(databasePath);nextStore.recoverInterruptedTasks();const next=new Coordinator(root,nextStore);stores.push(nextStore);coordinators.push(next);connect(next,runtime);return {store:nextStore,coordinator:next};},
  async dispatch(extra:Record<string,unknown>={}) {return await coordinator.call('dispatch_task',{workspace_id:'workspace',worker_id:'worker',request_id:'request',prompt:'Original prompt must only be sent once',verify_commands:[{command:process.execPath,args:['-e','process.exit(0)'],timeout_ms:1000}],...extra}) as {task:{taskId:string};created:boolean};},
 };
}
async function settled(store:DurableTaskStore,coordinator:Coordinator,taskId:string) {
 await until(()=>['succeeded','failed','cancelled','interrupted','blocked'].includes(store.getTask(taskId).status)&&!coordinator.active.has(taskId));return store.getTask(taskId);
}

test('busy terminal immediately continues in the same session with the pinned provider and a unique durable command',async t=>{
 const f=await fixture(t);let yieldedAfterTerminal=false;
 f.runtime.onSnapshot=()=>{yieldedAfterTerminal=false;setImmediate(()=>{yieldedAfterTerminal=true;});};
 f.runtime.onSend=async(input,index)=>{
  const task=f.store.listTasks()[0]!;const attempt=f.store.getCurrentAttempt(task.taskId)!;
  assert.equal(attempt.commandId,input.requestId);assert.equal(attempt.acknowledgedAt,null);assert.equal(task.status,'dispatching');assert.equal(task.leaseHeld,true);
  if(index===1){assert.equal(f.store.hasEnteredVerification(task.taskId),false);assert.equal(yieldedAfterTerminal,false,'continue must be sent before yielding to a backoff timer');await writeFile(join(f.repo,'code.txt'),'after busy continuation\n');}
 };
 const {task:{taskId}}=await f.dispatch();const task=await settled(f.store,f.coordinator,taskId);
 assert.equal(task.status,'succeeded');assert.equal(task.requestId,'request');assert.equal(task.busyRetryCount,1);
 assert.equal(f.runtime.sent.length,2);assert.deepEqual(f.runtime.sent.map(value=>value.input.prompt),['Original prompt must only be sent once','继续']);
 assert.notEqual(f.runtime.sent[1]!.input.requestId,'request');assert.equal(task.currentCommandId,f.runtime.sent[1]!.input.requestId);
 assert.deepEqual(f.runtime.sent.map(value=>value.session.sessionId),['native-session','native-session']);
 assert.deepEqual(f.runtime.sent.map(value=>value.input.modelSelection),[{providerId:'account:zai-start-plan',modelId:'GLM-5.3-Flash'},{providerId:'account:zai-start-plan',modelId:'GLM-5.3-Flash'}]);
 assert.equal(f.runtime.opened.length,1);assert.equal(f.runtime.cursors.length,1,'reuse the event iterator across continuations');
 const attempts=f.store.listAttempts(taskId);assert.deepEqual(attempts.map(value=>value.terminalState),['failed','completedSuccess']);
 assert.equal(f.store.listEvents(taskId).filter(event=>event.type==='task_completed').length,1);assert.match(f.store.getResult(taskId)!.summary,/continue_/);
 assert.match(await readFile(f.store.getResult(taskId)!.artifacts[0]!.path,'utf8'),/after busy continuation/);
 assert.equal((await f.dispatch()).created,false);assert.equal(f.runtime.sent.length,2);
});

test('busy continuations have a finite configurable limit including zero',async t=>{
 for(const limit of [0,2,3])await t.test(`limit ${limit}`,async child=>{
  const f=await fixture(child);f.runtime.outcomes=Array(6).fill('busy');const {task:{taskId}}=await f.dispatch({busy_retry_limit:limit});
  const task=await settled(f.store,f.coordinator,taskId);assert.equal(task.status,'failed');assert.equal(task.busyRetryCount,limit);assert.equal(f.runtime.sent.length,limit+1);assert.equal(task.leaseHeld,false);
  assert.equal(f.store.listEvents(taskId).filter(event=>event.type==='task_completed').length,1);assert.equal(f.store.getResult(taskId)!.blockers.some(value=>value.includes(`${limit} of ${limit}`)),true);
 });
});

test('active, uncertain, unattributed, quota and unsafe failures never start a continuation',async t=>{
 const cases:{name:string;outcome?:Outcome;patch?:(f:Awaited<ReturnType<typeof fixture>>)=>void;expected:string}[]=[
  {name:'terminal with active native work',patch:f=>{f.runtime.snapshotPatch=snapshot=>{(snapshot.raw.control as any).activeWorks=[{sourceCommandId:'foreign'}];};},expected:'interrupted'},
  {name:'terminal without active-work proof',patch:f=>{f.runtime.snapshotPatch=snapshot=>{delete (snapshot.raw.control as any).activeWorks;};},expected:'interrupted'},
  {name:'unattributed busy terminal',patch:f=>{f.runtime.onSend=()=>{for(const event of f.runtime.eventsLog)if(['error','turn_failed'].includes(event.type))Object.assign(event.data,{errorAttribution:'unattributed',busyRetryEligible:false});f.runtime.lastError={message:'model is busy'};};},expected:'failed'},
  {name:'quota',outcome:'rate_limited',expected:'failed'},
  {name:'authentication',outcome:'auth_invalid',expected:'failed'},
  {name:'unknown',outcome:'unknown',expected:'failed'},
  {name:'new auth failure conflicts with earlier busy',patch:f=>{f.runtime.snapshotPatch=snapshot=>{const header=(snapshot.raw.rows as any).window[0];header.error={message:'401 unauthorized'};};},expected:'failed'},
  {name:'provider changed',patch:f=>{f.runtime.snapshotPatch=snapshot=>{snapshot.modelSelection!.providerId='paid-provider';};},expected:'interrupted'},
 ];
 for(const scenario of cases)await t.test(scenario.name,async child=>{
  const f=await fixture(child);if(scenario.outcome)f.runtime.outcomes=[scenario.outcome];scenario.patch?.(f);const {task:{taskId}}=await f.dispatch();const task=await settled(f.store,f.coordinator,taskId);
  assert.equal(task.status,scenario.expected);assert.equal(f.runtime.sent.length,1);assert.equal(task.busyRetryCount,0);if(task.status==='interrupted')assert.equal(task.leaseHeld,true);
 });
});

test('a busy error without a terminal event cannot send continue',async t=>{
 const f=await fixture(t);f.runtime.outcomes=['busy_error_only'];const {task:{taskId}}=await f.dispatch();await until(()=>f.store.getCurrentAttempt(taskId)?.busyRetryEligible===true);
 await delay(30);assert.equal(f.runtime.sent.length,1);assert.equal(f.store.getTask(taskId).status,'running');assert.equal(f.store.getTask(taskId).leaseHeld,true);
 await f.coordinator.close();assert.equal(f.store.getTask(taskId).status,'interrupted');assert.equal(f.runtime.sent.length,1);
});

test('cancellation while checking a stopped busy turn durably prevents continue',async t=>{
 const f=await fixture(t);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let checking=false;
 f.runtime.onSnapshot=async()=>{checking=true;await gate;};const {task:{taskId}}=await f.dispatch();await until(()=>checking);
 const cancelled=await f.coordinator.call('cancel_task',{task_id:taskId}) as any;assert.equal(cancelled.cancelRequested,true);assert.notEqual(f.store.getTask(taskId).cancelRequestedAt,null);
 release();assert.equal((await settled(f.store,f.coordinator,taskId)).status,'cancelled');assert.equal(f.runtime.sent.length,1);assert.equal(f.store.listAttempts(taskId).length,1);
});

test('cancellation during continuation ACK waits for and targets the new command',async t=>{
 const f=await fixture(t);f.runtime.outcomes=['busy','running'];let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let awaitingAck=false;
 f.runtime.onSend=async(_input,index)=>{if(index===1){awaitingAck=true;await gate;}};const {task:{taskId}}=await f.dispatch();await until(()=>awaitingAck);
 const result=await f.coordinator.call('cancel_task',{task_id:taskId}) as any;assert.equal(result.awaitingTurnIdentity,true);assert.equal(f.runtime.cancelled.length,0);
 release();await until(()=>f.runtime.cancelled.length===1);const commandId=f.store.getTask(taskId).currentCommandId;assert.notEqual(commandId,'request');assert.equal(f.runtime.cancelled[0]!.commandId,commandId);
 const header=f.runtime.headers.at(-1)!;header.state='failed';f.runtime.activeWorks=[];f.runtime.lastError={sourceCommandId:commandId,turnId:header.turnId,message:'model is busy'};
 f.runtime.emit('turn_failed',commandId,{category:'model_busy',errorAttribution:'turn',busyRetryEligible:true});assert.equal((await settled(f.store,f.coordinator,taskId)).status,'cancelled');assert.equal(f.runtime.sent.length,2);
});

test('lost continuation ACK recovers the current attempt without resending it or the original prompt',async t=>{
 const f=await fixture(t);f.runtime.ackErrorAt=1;const {task:{taskId}}=await f.dispatch();assert.equal((await settled(f.store,f.coordinator,taskId)).status,'interrupted');
 const pending=f.store.getCurrentAttempt(taskId)!;assert.equal(pending.index,1);assert.equal(pending.acknowledgedAt,null);assert.notEqual(pending.commandId,'request');
 const next=await f.restart();const [recovery]=await next.coordinator.recoverTasks();assert.equal(recovery!.finalizing,true);
 assert.equal((await settled(next.store,next.coordinator,taskId)).status,'succeeded');assert.equal(f.runtime.sent.length,2);assert.equal(next.store.getTask(taskId).currentCommandId,pending.commandId);
 assert.equal(f.runtime.opened.at(-1)!.sessionId,'native-session');assert.equal(f.runtime.opened.at(-1)!.modelSelection,undefined,'recovery observes the existing session without writing its config');
 assert.equal(next.store.listEvents(taskId).filter(event=>event.type==='task_completed').length,1);assert.equal(next.store.getResult(taskId)!.summary,`Result for ${pending.commandId}`);
});

test('a continuation intent persisted before any native acceptance is never sent again after restart',async t=>{
 const f=await fixture(t);const task=f.store.dispatch({requestId:'request',workspaceId:'workspace',workerId:'worker',prompt:'Original prompt',executionPolicy:{mode:'build',modelId:'GLM-5.3-Flash',busyRetryLimit:3,verifyCommands:[]}}).task;
 f.store.beginDispatch(task.taskId,{runtimeBinding:{accountAlias:'account-fixture',providerId:'account:zai-start-plan',modelId:'GLM-5.3-Flash'}});f.store.bindSession(task.taskId,'native-session');f.store.acknowledgeDispatch(task.taskId,{sessionId:'native-session',turnId:'request'});
 f.store.recordAttemptFailure(task.taskId,'request',{category:'model_busy',busyRetryEligible:true});f.store.recordAttemptTerminal(task.taskId,'request','failed',{kind:'history_stopped',evidence:'Exact busy turn failed and activeWorks empty'});
 const continued=f.store.beginBusyContinuation(task.taskId,'request',3);f.runtime.headers.push({kind:'turnHeader',rowId:1,turnId:'native-turn-0',sourceCommandId:'request',state:'failed'});f.runtime.lastError={sourceCommandId:'request',message:'model is busy'};
 const next=await f.restart();const [recovery]=await next.coordinator.recoverTasks();assert.equal(recovery!.requiresInspection,true);assert.equal(next.store.getTask(task.taskId).currentCommandId,continued.currentCommandId);assert.equal(next.store.getTask(task.taskId).leaseHeld,true);assert.equal(f.runtime.sent.length,0);assert.equal(next.store.listAttempts(task.taskId).length,2);
 await assert.rejects(next.coordinator.call('dispatch_task',{workspace_id:'workspace',worker_id:'worker',request_id:'another',prompt:'replacement'}),error=>error instanceof CoreError&&error.code==='WORKSPACE_BUSY');
});

test('recovery after the stopped busy attempt but before continuation intent creates exactly one new command',async t=>{
 const f=await fixture(t);const task=f.store.dispatch({requestId:'request',workspaceId:'workspace',workerId:'worker',prompt:'Original prompt',executionPolicy:{mode:'build',modelId:'GLM-5.3-Flash',busyRetryLimit:3,verifyCommands:[]}}).task;
 f.store.beginDispatch(task.taskId,{runtimeBinding:{accountAlias:'account-fixture',providerId:'account:zai-start-plan',modelId:'GLM-5.3-Flash'}});f.store.bindSession(task.taskId,'native-session');f.store.acknowledgeDispatch(task.taskId,{sessionId:'native-session',turnId:'request'});
 f.store.recordAttemptFailure(task.taskId,'request',{category:'model_busy',busyRetryEligible:true});f.store.recordAttemptTerminal(task.taskId,'request','failed',{kind:'history_stopped',evidence:'Exact stopped busy turn'});
 f.runtime.headers.push({kind:'turnHeader',rowId:1,turnId:'old-native-turn',sourceCommandId:'request',state:'failed'});f.runtime.lastError={sourceCommandId:'request',message:'model is busy'};f.runtime.outcomes=['success'];
 const next=await f.restart();await Promise.all([next.coordinator.recoverTasks(),next.coordinator.call('resume_task',{task_id:task.taskId})]);
 const done=await settled(next.store,next.coordinator,task.taskId);assert.equal(done.status,'succeeded');assert.equal(f.runtime.sent.length,1);assert.equal(f.runtime.sent[0]!.input.prompt,'继续');assert.equal(done.busyRetryCount,1);assert.equal(next.store.listAttempts(task.taskId).length,2);
});
