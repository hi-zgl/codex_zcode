// This is an isolated integration-only fake runtime. It is excluded from every VSIX.
import {mkdir,writeFile}from'node:fs/promises';
import {join}from'node:path';
import {execFileSync}from'node:child_process';
import {Coordinator}from'../../../../src/daemon/coordinator.ts';
import {DurableTaskStore}from'../../../../src/core/index.ts';
import {serveRpc}from'../../../../src/daemon/server.ts';
const root=process.argv[2];const repo=join(root,'repo');await mkdir(repo,{recursive:true});
execFileSync('git',['init','-b','main',repo]);await writeFile(join(repo,'code.txt'),'before\n');execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'-c','user.name=WireFixture','-c','user.email=fixture@example.invalid','commit','-m','baseline']);
const baseCommit=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const store=new DurableTaskStore(join(root,'scheduler','state.db'),{pollIntervalMs:5});store.registerWorkspace({workspaceId:'workspace-wire',repositoryPath:repo,worktreePath:repo,branch:'main',baseCommit});
const coordinator=new Coordinator(root,store);let owned;let nativeSends=0;
Object.defineProperty(coordinator.supervisor,'list',{value:async()=>owned?[{...owned,processOwned:true,runningTaskCount:0}]:[]});
Object.defineProperty(coordinator.supervisor,'status',{value:async()=>({...owned,processOwned:true,runningTaskCount:0,endpoint:{baseUrl:'http://127.0.0.1:1'}})});
Object.defineProperty(coordinator.supervisor,'start',{value:async input=>{owned={workerId:input.workerId,accountAlias:input.account.alias,state:'ready',version:'3.16.3'};return {...owned,identity:{token:'WIRE_SECRET_CANARY'}};}});
Object.defineProperty(coordinator.supervisor,'stop',{value:async workerId=>{owned={...owned,state:'stopped'};return{workerId,stopped:true,secret:'WIRE_SECRET_CANARY'};}});
const info={adapterId:'integration-only-fake',version:'3.16.3',protocolVersion:1,authRequired:false,authenticated:true,supported:true};
Object.defineProperty(coordinator.adapter,'probe',{value:async()=>info});
Object.defineProperty(coordinator.adapter,'connect',{value:async()=>{
  let current;let selection;
  return {info,openSession:async input=>{selection=input.modelSelection;return{sessionId:input.sessionId??'session-wire',workspacePath:input.workspacePath};},sendTurn:async(session,input)=>{nativeSends++;current={...session,turnId:input.requestId,commandId:input.requestId};selection=input.modelSelection;await writeFile(join(session.workspacePath,'code.txt'),'after 😀\n');await writeFile(join(session.workspacePath,'untracked.txt'),'immutable untracked\n');return current;},
    async *events(){for(const type of ['turn_started','turn_completed'])yield{id:`wire-${type}`,cursor:type,sessionId:current.sessionId,turnId:current.turnId,type,timestamp:Date.now(),data:{}};},
    syncHistory:async session=>({...session,phase:'completedSuccess',revision:1,cursor:'2',summary:'Wire completed',pendingApprovals:[],modelSelection:selection,raw:{sessionId:session.sessionId,control:{phase:'completedSuccess',activeWorks:[]},rows:{window:[{kind:'turnHeader',rowId:1,turnId:'native-wire',sourceCommandId:current.commandId,state:'completedSuccess'},{kind:'assistantText',rowId:2,turnId:'native-wire',text:'Wire completed'}]}}}),
    quota:async providerId=>({authenticated:true,provider:{id:providerId},remaining:{count:5},secret:'WIRE_SECRET_CANARY'}),respondApproval:async()=>{},cancel:async()=>{},queryCommand:async()=> 'unknown',close:async()=>{},};
}});
let dropped=false;
const rpc=await serveRpc(root,async(method,params)=>{const result=await coordinator.call(method,params);if(process.env.ZCODE_POOL_TEST_DROP_DISPATCH_ACK==='1'&&method==='dispatch_task'&&!dropped){dropped=true;throw new Error('Simulated lost dispatch acknowledgement');}return result;});console.log('ready');
process.once('SIGTERM',()=>{void(async()=>{await rpc.close();await coordinator.close();store.close();process.exit(nativeSends>1?2:0);})();});
