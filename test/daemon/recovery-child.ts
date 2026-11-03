// A daemon subprocess with only the native runtime boundary replaced. No real model or worker is launched.
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AccountVault } from '../../src/accounts/index.js';
import { WorkerSupervisor } from '../../src/supervisor/index.js';
import { ZCodeServerAdapter } from '../../src/runtime/zcode-server/index.js';
import type { RuntimeConnection, RuntimeEvent, RuntimeInfo, SessionRef, SessionSnapshot, TurnInput, TurnRef } from '../../src/runtime/types.js';

const root=process.env.ZCODE_POOL_HOME!;
interface NativeState {state:string;version:number;pendingApprovals:Record<string,unknown>[];commandId?:string}
class FileRuntime implements RuntimeConnection {
 readonly info:RuntimeInfo={adapterId:'recovery-fixture',version:'3.16.3',protocolVersion:1,authRequired:false,authenticated:true,supported:true};
 private closed=false;
 private async state():Promise<NativeState>{return JSON.parse(await readFile(join(root,'native-state.json'),'utf8'));}
 async openSession(input:SessionRef):Promise<SessionRef>{
  if(input.sessionId!=='native-session')throw new Error('Recovery must open the existing native session');
  await appendFile(join(root,'subscriptions'),`${input.sessionId}\n`);return input;
 }
 async sendTurn(_session:SessionRef,_input:TurnInput):Promise<TurnRef>{await appendFile(join(root,'unexpected-send'),'sendTurn\n');throw new Error('Recovery must never send a turn');}
 async syncHistory(session:SessionRef):Promise<SessionSnapshot>{
  const state=await this.state();
  const commandId=state.commandId??'request';
  return {...session,phase:state.state,revision:state.version,cursor:String(state.version),summary:'Unrelated session summary must not be returned',pendingApprovals:state.pendingApprovals,raw:{queue:{items:[]},pendingCommands:[],backgroundWorks:[],sessionId:session.sessionId,control:{phase:state.state,activeWorks:state.state==='running'?[{sourceCommandId:commandId,turnId:'product-turn',foregroundExecutionId:'foreground'}]:[]},rows:{window:[{kind:'turnHeader',rowId:1,turnId:'product-turn',sourceCommandId:commandId,state:state.state},{kind:'assistantText',rowId:2,turnId:'product-turn',text:'Recovered fixture result'},{kind:'toolCall',rowId:3,turnId:'product-turn',toolName:'Edit'}]}}};
 }
 async *events(session:SessionRef,cursor='0'):AsyncIterable<RuntimeEvent>{
  let after=Number(cursor);
  while(!this.closed){
   const state=await this.state();
   if(state.version>after){
    after=state.version;
    const type=state.state==='completedSuccess'?'turn_completed':state.state==='failed'?'turn_failed':state.state==='completedInterrupted'?'turn_cancelled':state.pendingApprovals.length?'approval_requested':'runtime_status';
    yield {id:`fixture:${after}`,cursor:String(after),type,sessionId:session.sessionId,...(type==='approval_requested'?{}:{turnId:state.commandId??'request'}),timestamp:Date.now(),data:type==='approval_requested'?state.pendingApprovals[0]!: {}};
   }
   await delay(10);
  }
 }
 async queryCommand():Promise<'unknown'>{return 'unknown';}
 async quota():Promise<Record<string,unknown>>{return {};}
 async respondApproval(turn:TurnRef,approvalId:string,decision:unknown):Promise<void>{await appendFile(join(root,'actions'),`${JSON.stringify({type:'approval',commandId:turn.commandId,approvalId,decision})}\n`);}
 async cancel(turn:TurnRef):Promise<void>{await appendFile(join(root,'actions'),`${JSON.stringify({type:'cancel',commandId:turn.commandId})}\n`);}
 async close():Promise<void>{this.closed=true;}
}
Object.defineProperty(ZCodeServerAdapter.prototype,'connect',{value:async()=>new FileRuntime()});
Object.defineProperty(WorkerSupervisor.prototype,'status',{value:async(workerId:string)=>({workerId,accountAlias:'account-fixture',state:'ready',endpoint:{baseUrl:'http://127.0.0.1:1'}})});
Object.defineProperty(AccountVault.prototype,'load',{value:async()=>({alias:'account-fixture',provider:'zai',health:'available'})});
await import('../../src/daemon/main.js');
