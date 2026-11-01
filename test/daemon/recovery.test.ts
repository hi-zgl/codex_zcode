import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test, { type TestContext } from 'node:test';
import { DurableTaskStore } from '../../src/core/index.js';
import { rpcCall } from '../../src/shared/rpc.js';

const exec=promisify(execFile);
const loader=import.meta.resolve('tsx');
const fakeEntry=fileURLToPath(new URL('./recovery-child.ts',import.meta.url));
const actualEntry=fileURLToPath(new URL('../../src/daemon/main.ts',import.meta.url));
async function waitFor(predicate:()=>Promise<boolean>,message:string):Promise<void>{
 const deadline=Date.now()+6000;
 while(!await predicate()){if(Date.now()>deadline)throw new Error(message);await delay(10);}
}
async function exists(path:string):Promise<boolean>{try{await readFile(path);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function kill(child:ChildProcess,signal:NodeJS.Signals='SIGKILL'){
 if(child.exitCode!==null||child.signalCode!==null)return;
 const exited=once(child,'exit');child.kill(signal);await exited;
}
async function fixture(t:TestContext,verifyCommands:{command:string;args:string[];timeout_ms:number}[]=[]){
 const root=await mkdtemp(join(tmpdir(),'zpr-'));const repo=join(root,'repo');await mkdir(repo);
 await exec('git',['init','-b','trunk',repo]);await writeFile(join(repo,'code.txt'),'baseline\n');
 await exec('git',['-C',repo,'add','code.txt']);await exec('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','baseline']);
 const baseCommit=(await exec('git',['-C',repo,'rev-parse','HEAD'])).stdout.trim();
 const databasePath=join(root,'scheduler','state.db');const store=new DurableTaskStore(databasePath);
 store.registerWorkspace({workspaceId:'workspace',repositoryPath:repo,worktreePath:repo,branch:'trunk',baseCommit});
 const task=store.dispatch({requestId:'request',workspaceId:'workspace',workerId:'worker',prompt:'Do not replay this original prompt',executionPolicy:{mode:'build',modelId:'GLM-5.3-Flash',verifyCommands}}).task;
 store.beginDispatch(task.taskId);store.bindSession(task.taskId,'native-session');store.acknowledgeDispatch(task.taskId,{sessionId:'native-session',turnId:'request'});store.close();
 const children:ChildProcess[]=[];
 t.after(async()=>{await Promise.all(children.map(child=>kill(child)));await rm(root,{recursive:true,force:true});});
 return {root,repo,databasePath,taskId:task.taskId,children,
  async native(state:string,version=0,pendingApprovals:Record<string,unknown>[]=[]){const path=join(root,'native-state.json');await writeFile(path+'.tmp',JSON.stringify({state,version,pendingApprovals}));await rename(path+'.tmp',path);},
  daemon(fake=true){let stderr='';const child=spawn(process.execPath,['--import',loader,fake?fakeEntry:actualEntry],{env:{...process.env,ZCODE_POOL_HOME:root},stdio:['ignore','ignore','pipe']});child.stderr!.on('data',chunk=>{stderr+=String(chunk);});children.push(child);const exited=once(child,'exit');return {child,exited,stderr:()=>stderr};},
  task(){const reader=new DurableTaskStore(databasePath);try{return reader.getTask(task.taskId);}finally{reader.close();}},
 };
}
async function readyTask(root:string,taskId:string,status:string):Promise<void>{
 await waitFor(async()=>{try{const result=await rpcCall<{tasks:{taskId:string;status:string}[]}>('overview',{}, {root,timeoutMs:150});return result.tasks.some(task=>task.taskId===taskId&&task.status===status);}catch{return false;}},`daemon did not report ${status}`);
}

test('real daemon subprocesses automatically reattach the original task after SIGKILL and can approve and cancel without replay', {timeout:15000}, async t=>{
 const f=await fixture(t);await f.native('running',0,[{interactionId:'approval-original',kind:'permission',anchorRowId:3,payload:{toolName:'Edit',summary:'Review original edit'}}]);
 const first=f.daemon();await readyTask(f.root,f.taskId,'waiting_approval');
 assert.equal((f.task().detail as any).approvalId,'approval-original');
 await rpcCall('respond_approval',{task_id:f.taskId,approval_id:'approval-original',decision:'accept'},{root:f.root});
 await f.native('running',1,[]);await kill(first.child);
 const second=f.daemon();await readyTask(f.root,f.taskId,'running');
 const cancellation=await rpcCall<{terminationConfirmed:boolean}>('cancel_task',{task_id:f.taskId},{root:f.root});
 assert.equal(cancellation.terminationConfirmed,false);assert.equal(f.task().leaseHeld,true);
 await f.native('completedInterrupted',2);await readyTask(f.root,f.taskId,'cancelled');
 assert.equal(f.task().leaseHeld,false);assert.equal(await exists(join(f.root,'unexpected-send')),false);
 assert.equal((await readFile(join(f.root,'subscriptions'),'utf8')).trim().split('\n').length,2);
 const actions=(await readFile(join(f.root,'actions'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
 assert.deepEqual(actions.map(action=>[action.type,action.commandId]),[['approval','request'],['cancel','request']]);
 assert.equal(actions[0].approvalId,'approval-original');
 await rpcCall('daemon_stop',{}, {root:f.root});await second.exited;assert.equal(second.child.exitCode,0,second.stderr());
});

test('daemon shutdown retains ownership while recovered verification drains and publishes exactly one immutable result', {timeout:15000}, async t=>{
 const localScript="const fs=require('node:fs');fs.appendFileSync('verification-count','once\\n');const timer=setInterval(()=>{if(fs.existsSync('verification-release'))clearInterval(timer)},5);setTimeout(()=>process.exit(3),5000).unref()";
 const f=await fixture(t,[{command:process.execPath,args:['-e',localScript],timeout_ms:6000}]);
 const localMarker=join(f.repo,'verification-count');const localGate=join(f.repo,'verification-release');
 await f.native('completedSuccess');
 const daemon=f.daemon();await waitFor(()=>exists(localMarker),'recovered verification did not start');
 await rpcCall('daemon_stop',{}, {root:f.root});
 await waitFor(async()=>{try{await rpcCall('overview',{}, {root:f.root,timeoutMs:150});return false;}catch(error){return /shutting down/.test(String(error));}},'daemon did not begin draining');
 assert.equal(daemon.child.exitCode,null);
 const ownership=JSON.parse(await readFile(join(f.root,'scheduler','daemon.lock'),'utf8'));assert.equal(ownership.pid,daemon.child.pid);
 const competitor=f.daemon(false);await competitor.exited;assert.notEqual(competitor.child.exitCode,0);assert.match(competitor.stderr(),/already running/);
 const during=new DurableTaskStore(f.databasePath);try{assert.equal(during.getTask(f.taskId).status,'verifying');assert.equal(during.getTask(f.taskId).leaseHeld,true);}finally{during.close();}
 await writeFile(localGate,'');await daemon.exited;assert.equal(daemon.child.exitCode,0,daemon.stderr());
 const resultStore=new DurableTaskStore(f.databasePath);let result;try{assert.equal(resultStore.getTask(f.taskId).status,'succeeded');result=resultStore.getResult(f.taskId)!;assert.equal(resultStore.listEvents(f.taskId).filter(event=>event.type==='task_completed').length,1);}finally{resultStore.close();}
 assert.equal(result.summary,'Recovered fixture result');assert.equal(await readFile(localMarker,'utf8'),'once\n');
 const again=f.daemon();await readyTask(f.root,f.taskId,'succeeded');assert.equal(await readFile(localMarker,'utf8'),'once\n');
 assert.equal(await exists(join(f.root,'unexpected-send')),false);
 await rpcCall('daemon_stop',{}, {root:f.root});await again.exited;assert.equal(again.child.exitCode,0,again.stderr());
});

test('repeated daemon restarts preserve interrupted-verification occupancy and do not retry side effects', {timeout:15000}, async t=>{
 const f=await fixture(t,[{command:process.execPath,args:['-e',"require('node:fs').appendFileSync('unexpected-verification','ran')"],timeout_ms:1000}]);
 const setup=new DurableTaskStore(f.databasePath);setup.transitionTask(f.taskId,'verifying',{executionStopped:{kind:'runtime_terminal',evidence:'Authoritative terminal before abrupt verification interruption'}});setup.close();await f.native('completedSuccess');
 for(let restart=0;restart<2;restart++){
  const daemon=f.daemon();await readyTask(f.root,f.taskId,'interrupted');await waitFor(async()=>{try{return (f.task().detail as any).requiresInspection===true;}catch{return false;}},'interrupted verification was not reported');
  assert.equal(f.task().status,'interrupted');assert.equal(f.task().leaseHeld,true);assert.equal(f.task().executionStopped,true);
  const reconciled=await rpcCall<{requiresInspection:boolean}>('reconcile_task',{task_id:f.taskId},{root:f.root});assert.equal(reconciled.requiresInspection,true);
  await kill(daemon.child);
 }
 assert.equal(await exists(join(f.repo,'unexpected-verification')),false);assert.equal(await exists(join(f.root,'subscriptions')),false);assert.equal(await exists(join(f.root,'unexpected-send')),false);
});
