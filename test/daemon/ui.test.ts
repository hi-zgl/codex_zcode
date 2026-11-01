import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DurableTaskStore} from '../../src/core/store.js';
import type {Task,PersistedTaskResult} from '../../src/core/types.js';
import {UiService,type UiBackend,type UiApprovalObservation} from '../../src/daemon/ui.js';
import {Coordinator} from '../../src/daemon/coordinator.js';
import {UiRpcError,digest} from '../../src/daemon/ui-support.js';
import {ZCodeServerConnection} from '../../src/runtime/zcode-server/index.js';
import {uiMethods,uiPermissionReviewSchema,uiCapabilitiesSchema,type UiApprovalReview,type UiTaskDetail,type UiCapabilities} from '../../src/shared/ui-contract.js';
import {MCP_PRESENTED_METHODS,MCP_MAX_TEXT_BYTES} from '../../src/shared/presentation.js';
import {rpcCall,RpcCallError} from '../../src/shared/rpc.js';
import {serveRpc} from '../../src/daemon/server.js';
import {snapshotWorkspace,git} from '../../src/daemon/workspace.js';

const kind=(expected:string)=>(error:unknown)=>error instanceof UiRpcError&&error.data?.kind===expected;
async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'zpool-ui-'));const db=join(root,'scheduler','state.db');
 const store=new DurableTaskStore(db,{now:()=>10000});
 const state={approvals:[] as Record<string,any>[],nativeRevision:7,sourceComplete:true,stablePermissionIds:true,attached:true,accept:true,sends:[] as {approvalId:string;optionId:string}[],sendFails:false,observes:0,quotaFails:false,quotaReads:0};
 const locks=new Map<string,Promise<unknown>>();
 const backend:UiBackend={attachment:()=>state.attached,accounts:async()=>[{alias:'account-fixture',provider:'zai',authMode:'oauth',health:'available',quota:{total:30,used:30,remaining:0,updatedAt:1234567890}}],
  observeApprovals:async task=>{state.observes++;if(!state.attached)return null;return {snapshot:{sessionId:task.sessionId!,workspacePath:'/repo/worktree',phase:'running',revision:state.nativeRevision,cursor:'7',summary:'private-assistant',pendingApprovals:state.approvals,raw:{}},approvals:state.approvals,nativeTurnId:'native-turn',sourceComplete:state.sourceComplete,stablePermissionIds:state.stablePermissionIds,unattributedCount:0};},
  serialApproval:(id,action)=>{const work=(locks.get(id)??Promise.resolve()).catch(()=>{}).then(action);locks.set(id,work);return work;},canAcceptApproval:async()=>state.accept,
  sendApproval:async(_task,approvalId,optionId)=>{state.sends.push({approvalId,optionId});if(state.sendFails)throw new Error('PRIVATE secret runtime exception');},
  probeQuota:async()=>{state.quotaReads++;if(state.quotaFails)throw Object.assign(new Error('PRIVATE exception'),{accountAlias:'account-fixture'});return {accountAlias:'account-fixture',providerId:'account:zai-start-plan',quota:{provider:{id:'account:zai-start-plan'},authenticated:true,generatedAt:13,serverTime:14,remaining:{count:0,percentage:0,nextResetTime:15}}};}};
 const ui=new UiService(root,store,backend);
 let counter=0;
 const create=(running=true)=>{
  counter++;const workspaceId=`workspace-${counter}`,workerId=`worker-${counter}`,requestId=`request-${counter}`;
  store.registerWorkspace({workspaceId,repositoryPath:'/repo',worktreePath:`/repo/worktree-${counter}`,branch:'main',baseCommit:'abcdef'});
  const task=store.dispatch({workspaceId,workerId,requestId,prompt:'PRIVATE original prompt',executionPolicy:{mode:'build',modelId:'model',busyRetryLimit:3,verifyCommands:[]}}).task;
  if(running){store.beginDispatch(task.taskId,{workerId,sessionId:'native-session',runtimeBinding:{accountAlias:'account-fixture',providerId:'account:zai-start-plan',modelId:'model'}});store.acknowledgeDispatch(task.taskId,{sessionId:'native-session',turnId:requestId});}
  return store.getTask(task.taskId);
 };
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return {root,db,store,state,backend,ui,create};
}
function permission(task:Task,text='edited content'){
 return {interactionId:'perm_'+randomUUID(),kind:'permission',sourceCommandId:task.currentCommandId,turnId:'native-turn',anchorRowId:12,createdAt:1,payload:{kind:'permission',toolCallId:'tool-call',toolName:'Edit',summary:'Edit this file',detail:{file_path:'/repo/worktree/file.ts',old_string:'before',new_string:text,replace_all:false},options:[{optionId:'allowOnce',kind:'allowOnce',label:'Allow once',response:{decision:'allow',reason:'Approved once'}},{optionId:'deny',kind:'deny',label:'Deny',response:{decision:'deny',reason:'User declined'}}]}};
}
async function review(ui:UiService,task:Task,id:string){return (await ui.call('ui_get_approval',{apiVersion:1,task_id:task.taskId,approval_id:id}) as {data:UiApprovalReview}).data;}
function respond(task:Task,r:UiApprovalReview,actionId=randomUUID(),decision='accept'){return {apiVersion:1,task_id:task.taskId,approval_id:r.approvalId,review_id:r.reviewId,expected_approval_revision:r.approvalRevision,expected_native_revision:r.nativeRevision,expected_content_sha256:r.content!.sha256,decision,action_id:actionId};}

test('UI bootstrap and task/request lookup expose typed whitelisted state without native connections',async t=>{
 const {ui,create,state,store,root,db}=await fixture(t);const task=create();store.requestCancellation(task.taskId);store.appendEvent(task.taskId,'private',{endpoint:'PRIVATE endpoint',prompt:'PRIVATE detail',token:'PRIVATE token'});
 const caps=await ui.call('ui_capabilities',{bootstrapVersion:1,client:{name:'vscode',version:'test'},supportedApiMajors:[4,1]}) as UiCapabilities;
 assert.equal(caps.capabilities.taskList.version,1);assert.equal(caps.limits.responseBytes,262144);
 const missing=structuredClone(caps) as any;delete missing.capabilities.quotaProbe;const negotiated=uiCapabilitiesSchema.parse(missing);assert.equal(negotiated.capabilities.quotaProbe.version,0);assert.equal(negotiated.capabilities.taskDetail.version,1);
 const data=(await ui.call('ui_get_task_detail',{apiVersion:1,request_id:task.requestId}) as {data:UiTaskDetail}).data;
 assert.equal(data.taskId,task.taskId);assert.equal(data.cancelRequestedAtMs,10000);assert.equal(data.leaseHeld,true);assert.equal(data.executionStopped,false);assert.equal(data.attempts[0].commandId,task.requestId);assert.equal(data.verificationPolicy.defaultDiffCheck,true);assert(!JSON.stringify(data).includes('PRIVATE'));assert.equal(state.observes,0);
 await assert.rejects(ui.call('ui_get_task_detail',{apiVersion:1,request_id:'in-flight-not-persisted'}),kind('NOT_FOUND'));
 for(const input of [{apiVersion:1},{apiVersion:1,task_id:task.taskId,request_id:task.requestId},{apiVersion:1,task_id:task.taskId,extra:true}])await assert.rejects(ui.call('ui_get_task_detail',input),e=>e instanceof UiRpcError&&e.code===-32602);
 await assert.rejects(ui.call('ui_capabilities',{bootstrapVersion:1,client:{name:'vscode',version:'test'},supportedApiMajors:[2]}),kind('INCOMPATIBLE_API'));
 const second=new DurableTaskStore(db);try{const ui2=new UiService(root,second,state as never);assert.equal(second.storeId,caps.storeId);assert.notEqual(ui2.instanceId,caps.instanceId);}finally{second.close();}
 for(const method of Object.keys(uiMethods))assert(!MCP_PRESENTED_METHODS.has(method));assert.equal(MCP_MAX_TEXT_BYTES,16384);
});

test('task pages have exact server filters, stable tie ordering and revision-gated signed cursors',async t=>{
 const {ui,create,store,root,backend}=await fixture(t);const tasks=[create(false),create(false),create(false)];
 const first=(await ui.call('ui_list_tasks',{apiVersion:1,limit:1})) as any;const second=(await ui.call('ui_list_tasks',{apiVersion:1,limit:1,cursor:first.data.nextCursor})) as any;
 const third=(await ui.call('ui_list_tasks',{apiVersion:1,limit:1,cursor:second.data.nextCursor})) as any;
 assert.equal(first.data.total,3);assert.equal(third.data.nextCursor,null);assert.deepEqual([first,second,third].map(p=>p.data.items[0].taskId),tasks.map(t=>t.taskId).sort());
 const empty=await ui.call('ui_list_tasks',{apiVersion:1,filter:{statuses:[]}}) as any;assert.equal(empty.data.total,0);
 const noPrompt=await ui.call('ui_list_tasks',{apiVersion:1,filter:{query:'PRIVATE original prompt'}}) as any;assert.equal(noPrompt.data.total,0);
 const literal=await ui.call('ui_list_tasks',{apiVersion:1,filter:{query:'WORKSPACE-2',repository_path:'/repo',lease_held:true}}) as any;assert.equal(literal.data.total,1);assert.equal(literal.data.items[0].taskId,tasks[1].taskId);
 await assert.rejects(ui.call('ui_list_tasks',{apiVersion:1,limit:2,cursor:first.data.nextCursor}),kind('CURSOR_INVALID'));
 await assert.rejects(ui.call('ui_list_tasks',{apiVersion:1,limit:1,cursor:first.data.nextCursor+'x'}),kind('CURSOR_INVALID'));
 const ui2=new UiService(root,store,backend);await assert.rejects(ui2.call('ui_list_tasks',{apiVersion:1,limit:1,cursor:first.data.nextCursor}),kind('CURSOR_STALE'));
 store.appendEvent(tasks[2].taskId,'unrelated_event');await assert.rejects(ui.call('ui_list_tasks',{apiVersion:1,limit:1,cursor:first.data.nextCursor}),kind('CURSOR_STALE'));
});

test('quota reads preserve imported provenance, real zero and prior live state after probe failure',async t=>{
 const {ui,state,root,store,backend}=await fixture(t);let q=(await ui.call('ui_get_quota',{apiVersion:1,account_id:'account-fixture'}) as any).data;
 assert.equal(state.quotaReads,0);assert.equal(q.imported.remaining,0);assert.equal(q.imported.observedAtMs,null);assert.equal(q.imported.generatedAt.unit,'unknown');assert.equal(q.imported.generatedAt.atMs,null);assert.equal(q.live,null);
 q=(await ui.call('ui_probe_quota',{apiVersion:1,worker_id:'worker'}) as any).data;assert.equal(q.live.remaining,0);assert.equal(q.live.unit,'unknown');assert.equal(q.live.percentage.scale,'unknown');assert.equal(q.live.nextReset.unit,'unknown');assert.equal(q.lastProbe.state,'succeeded');
 state.quotaFails=true;await assert.rejects(ui.call('ui_probe_quota',{apiVersion:1,worker_id:'worker'}),kind('NATIVE_UNAVAILABLE'));
 const after=(await ui.call('ui_get_quota',{apiVersion:1,account_id:'account-fixture'}) as any).data;assert.equal(after.live.observedAtMs,q.live.observedAtMs);assert.equal(after.lastProbe.state,'failed');
 const ui2=new UiService(root,store,backend);assert.equal((await ui2.call('ui_get_quota',{apiVersion:1,account_id:'account-fixture'}) as any).data.live,null);
});

test('complete approvals exceed legacy budgets, persist canonical UTF8 and bind one durable response',async t=>{
 const {ui,create,state,store}=await fixture(t);const task=create();const source=permission(task,'改动😀'.repeat(9000));state.approvals=[source];
 const r=await review(ui,task,source.interactionId);assert(r.content&&r.content.totalBytes>16384);assert.equal(r.decisions.length,2);assert.equal(r.content.sourceComplete,true);
 const chunks:Buffer[]=[];let offset=0;for(;;){const page=(await ui.call('ui_read_approval',{apiVersion:1,task_id:task.taskId,approval_id:r.approvalId,review_id:r.reviewId,offset_bytes:offset,limit_bytes:3001}) as any).data;assert.equal(page.offsetBytes,offset);const bytes=Buffer.from(page.dataBase64,'base64');assert.equal(page.byteLength,bytes.length);chunks.push(bytes);if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes;}
 const all=Buffer.concat(chunks);assert.equal(all.length,r.content.totalBytes);assert.equal(digest(all),r.content.sha256);const document=uiPermissionReviewSchema.parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(all)));assert.equal(document.interaction.payload.detail.new_string,source.payload.detail.new_string);
 const params=respond(task,r);const [a,b]=await Promise.all([ui.call('ui_respond_approval',params),ui.call('ui_respond_approval',params)]) as any[];assert.equal(a.data.responseState,'awaiting_native');assert.deepEqual(a.data,b.data);assert.equal(state.sends.length,1);assert.deepEqual(state.sends[0],{approvalId:r.approvalId,optionId:'allowOnce'});
 assert.equal((await review(ui,task,r.approvalId)).response.state,'awaiting_native');assert.equal(store.listUiRecords('approval_snapshot',task.taskId).length,1);
 await assert.rejects(ui.call('ui_respond_approval',{...params,decision:'decline'}),kind('ACTION_CONFLICT'));
 await assert.rejects(ui.call('ui_respond_approval',{...params,action_id:randomUUID()}),kind('APPROVAL_RESPONSE_PENDING'));
 state.approvals=[];const page=(await ui.call('ui_list_approvals',{apiVersion:1,task_id:task.taskId}) as any).data;assert.equal(page.total,0);const receipt=(await ui.call('ui_respond_approval',params) as any).data;assert.equal(receipt.responseState,'resolved_unattributed');assert.notEqual(receipt.responseState,'confirmed');
});

test('fresh native revisions and incomplete/unknown/redacted sources never become actionable',async t=>{
 const {ui,create,state}=await fixture(t);const task=create();let source=permission(task);state.approvals=[source];let r=await review(ui,task,source.interactionId);state.nativeRevision++;
 await assert.rejects(ui.call('ui_respond_approval',respond(task,r)),kind('APPROVAL_CHANGED'));assert.equal(state.sends.length,0);
 r=await review(ui,task,source.interactionId);(source.payload.detail as Record<string,unknown>).extra_decision_field='run another command';state.nativeRevision++;let unsupported=await review(ui,task,source.interactionId);assert.equal(unsupported.content,null);assert.equal(unsupported.decisions.length,0);assert.match(unsupported.readOnlyReason!,/schema/);
 source=permission(task);source.payload.detail.new_string='Authorization: Bearer secret-token';state.approvals=[source];const redacted=await review(ui,task,source.interactionId);assert.equal(redacted.content,null);assert.equal(redacted.redactions[0].decisionRelevant,true);
 source=permission(task);state.approvals=[source];state.sourceComplete=false;const incomplete=await review(ui,task,source.interactionId);assert.equal(incomplete.content,null);assert.equal(incomplete.decisions.length,0);
 state.sourceComplete=true;state.stablePermissionIds=false;const unstable=await review(ui,task,source.interactionId);assert(unstable.content);assert.equal(unstable.decisions.length,0);assert.equal(unstable.readOnlyReason,'native_interaction_stability_unverified');
 await assert.rejects(ui.call('ui_respond_approval',respond(task,unstable,randomUUID(),'decline')),kind('APPROVAL_READ_ONLY'));assert.equal(state.sends.length,0);
 state.attached=false;assert.equal((await ui.call('ui_list_approvals',{apiVersion:1,task_id:task.taskId}) as any).data.stateKnown,false);assert.equal((await review(ui,task,r.approvalId)).state,'unknown');
});

test('lost ACK and daemon restart preserve unknown receipts without resending approval intent',async t=>{
 const {ui,create,state,root,db,backend,store}=await fixture(t);const task=create();const source=permission(task);state.approvals=[source];const r=await review(ui,task,source.interactionId);const params=respond(task,r);state.sendFails=true;
 await assert.rejects(ui.call('ui_respond_approval',params),e=>kind('OUTCOME_UNKNOWN')(e)&&(e as UiRpcError).data?.outcome==='may_have_applied');assert.equal(state.sends.length,1);
 const reopened=new DurableTaskStore(db);try{const ui2=new UiService(root,reopened,backend);assert.equal((await ui2.call('ui_respond_approval',params) as any).data.responseState,'unknown');assert.equal(state.sends.length,1);await assert.rejects(ui2.call('ui_respond_approval',{...params,action_id:randomUUID()}),kind('APPROVAL_RESPONSE_PENDING'));assert.equal(reopened.storeId,store.storeId);}finally{reopened.close();}
});

test('immutable file API reads old task base/final bytes, handles absent/empty and rejects path params',async t=>{
 const {ui,create,root,store}=await fixture(t);const repo=join(root,'repo');await mkdir(repo);await git(repo,['init','-b','main']);await git(repo,['config','user.email','fixture@example.invalid']);await git(repo,['config','user.name','Fixture']);await writeFile(join(repo,'file.txt'),'base\n');await git(repo,['add','.']);await git(repo,['commit','-m','base']);const baseCommit=(await git(repo,['rev-parse','HEAD'])).trim();
 const task=create(false);await writeFile(join(repo,'file.txt'),'task one\n');await writeFile(join(repo,'empty.txt'),'');const snapshot=await snapshotWorkspace(root,task.taskId,{worktreePath:repo,baseCommit});
 const patch=await readFile(snapshot.patchFile);store.beginDispatch(task.taskId);store.transitionTask(task.taskId,'verifying',{executionStopped:{kind:'runtime_terminal',evidence:'test finished'}});store.completeTask(task.taskId,{summary:'done',artifacts:[{kind:'patch',path:snapshot.patchFile,sha256:digest(patch),sizeBytes:patch.length},snapshot.manifestArtifact,...snapshot.snapshotArtifacts]},{status:'succeeded'});
 const manifest=(await ui.call('ui_get_artifact_manifest',{apiVersion:1,task_id:task.taskId}) as any).data;assert.equal(manifest.state,'available');assert.equal(manifest.baseCommit,baseCommit);assert.equal(manifest.fileCount,2);
 const page=(await ui.call('ui_list_artifact_files',{apiVersion:1,task_id:task.taskId,manifest_sha256:manifest.manifestSha256,limit:1}) as any).data;store.appendEvent(task.taskId,'unrelated');const more=(await ui.call('ui_list_artifact_files',{apiVersion:1,task_id:task.taskId,manifest_sha256:manifest.manifestSha256,limit:1,cursor:page.nextCursor}) as any).data;assert.equal(more.nextCursor,null);
 const files=[...page.items,...more.items];const file=files.find(f=>f.relativePath==='file.txt'),empty=files.find(f=>f.relativePath==='empty.txt');assert.equal(empty.base.state,'absent');assert.equal(empty.final.state,'available');assert.equal(empty.final.sizeBytes,0);
 await writeFile(join(repo,'file.txt'),'task two\n');for(const [side,text] of [['base','base\n'],['final','task one\n']]){const data=(await ui.call('ui_read_artifact_file',{apiVersion:1,task_id:task.taskId,manifest_sha256:manifest.manifestSha256,file_id:file.fileId,side,offset_bytes:0}) as any).data;assert.equal(Buffer.from(data.dataBase64,'base64').toString(),text);assert.equal(data.fileSha256,digest(text));}
 await assert.rejects(ui.call('ui_read_artifact_file',{apiVersion:1,task_id:task.taskId,manifest_sha256:manifest.manifestSha256,file_id:file.fileId,side:'final',offset_bytes:0,path:'/etc/passwd'}),e=>e instanceof UiRpcError&&e.code===-32602);
});

test('typed RPC errors retain fixed code/data and never echo source exception text',async t=>{
 const {root,ui}=await fixture(t);const service=await serveRpc(root,(method,p)=>ui.call(method,p));t.after(()=>service.close());
 await assert.rejects(rpcCall('ui_get_task_detail',{apiVersion:1,task_id:'missing'},{root}),e=>e instanceof RpcCallError&&e.code===-32010&&(e.data as any).kind==='NOT_FOUND');
 await assert.rejects(rpcCall('ui_get_task_detail',{apiVersion:1,task_id:'missing',PRIVATE:'do not echo'},{root}),e=>e instanceof RpcCallError&&e.code===-32602&&!e.message.includes('PRIVATE'));
 await assert.rejects(rpcCall('ui_unrecognized',{}, {root}),e=>e instanceof RpcCallError&&e.code===-32601);
});

test('adapter fixes full approval source and native revision from one clone before any subsequent await',async()=>{
 const raw:any={sessionId:'native-session',revision:7,control:{phase:'running',activeWorks:[]},rows:{window:[]},pendingInteractions:[{interactionId:'first',payload:{detail:'original'}}]};
 const connection=new ZCodeServerConnection({adapterId:'fixture',version:'3.16.3',protocolVersion:1,conversationProtocolVersion:3,authRequired:false,authenticated:true,supported:true},1000);
 (connection as any).ensureSubscribed=async()=>({projection:{snapshot:raw,cursor:'7'}});let weakReads=0;(connection as any).syncHistory=async()=>{weakReads++;raw.revision=8;raw.pendingInteractions=[];return {revision:8};};
 const source=await connection.readApprovalSnapshot({sessionId:'native-session',workspacePath:'/repo'});assert.equal(weakReads,0);assert.equal(source.snapshot.revision,7);assert.equal(source.pendingApprovals[0].interactionId,'first');raw.pendingInteractions[0].payload.detail='later';assert.equal((source.pendingApprovals[0].payload as any).detail,'original');
});

test('coordinator refuses changed model/owner and observes strong approval removal without confirming a decision',async t=>{
 const {create,store,root}=await fixture(t);const task=create();const coordinator=new Coordinator(root,store);let selection={providerId:'account:zai-start-plan',modelId:'other-model'};const source=permission(task);let pending=true;
 const fake:any={info:{version:'3.16.3'},close:async()=>{},openSession:async(input:any)=>({sessionId:task.sessionId,workspacePath:input.workspacePath}),readApprovalSnapshot:async(session:any)=>({snapshot:{...session,phase:'running',revision:7,cursor:'7',summary:'',modelSelection:selection,pendingApprovals:pending?[source]:[],raw:{sessionId:task.sessionId,control:{activeWorks:[{sourceCommandId:task.currentCommandId,turnId:'native-turn'}]},rows:{window:[{rowId:12,kind:'turnHeader',sourceCommandId:task.currentCommandId,turnId:'native-turn',state:'running'}]}}},pendingApprovals:pending?[source]:[],sourceComplete:true,stablePermissionIds:true})};
 fake.syncHistory=async(session:any)=>(await fake.readApprovalSnapshot(session)).snapshot;fake.respondApproval=async()=>{pending=false;};
 coordinator.active.set(task.taskId,{connection:fake,session:{sessionId:task.sessionId!,workspacePath:'/repo/worktree'},turn:{sessionId:task.sessionId!,workspacePath:'/repo/worktree',turnId:task.currentCommandId,commandId:task.currentCommandId},accountAlias:'account-fixture'});
 Object.defineProperty(coordinator.supervisor,'status',{value:async()=>({state:'ready',accountAlias:'account-fixture',endpoint:{baseUrl:'http://127.0.0.1:1'}})});Object.defineProperty(coordinator.adapter,'connect',{value:async()=>fake});t.after(()=>coordinator.close());
 await assert.rejects(coordinator.call('ui_get_approval',{apiVersion:1,task_id:task.taskId,approval_id:source.interactionId}),kind('MODEL_SELECTION_MISMATCH'));
 selection={providerId:'account:bigmodel-start-plan',modelId:'model'};await assert.rejects(coordinator.call('ui_get_approval',{apiVersion:1,task_id:task.taskId,approval_id:source.interactionId}),kind('MODEL_SELECTION_MISMATCH'));
 selection={providerId:'account:zai-start-plan',modelId:'model'};source.sourceCommandId='different-command';const list=(await coordinator.call('ui_list_approvals',{apiVersion:1,task_id:task.taskId}) as any).data;assert.equal(list.total,0);assert.equal(list.unattributedCount,1);assert.equal(store.getTask(task.taskId).status,'running');
 source.sourceCommandId=task.currentCommandId;Object.defineProperty(coordinator.vault,'load',{value:async()=>({alias:'account-fixture',provider:'zai',health:'available'})});
 const r=(await coordinator.call('ui_get_approval',{apiVersion:1,task_id:task.taskId,approval_id:source.interactionId}) as any).data;const params=respond(task,r);await coordinator.call('ui_respond_approval',params);const after=store.getTask(task.taskId).revision;
 await store.wait({taskIds:[task.taskId],afterRevision:after,timeoutMs:1000});const detail=(await coordinator.call('ui_get_task_detail',{apiVersion:1,task_id:task.taskId}) as any).data;assert.equal(detail.approval.pendingCount,0);assert.equal(detail.approval.responsePending,false);assert.equal((await coordinator.call('ui_respond_approval',params) as any).data.responseState,'resolved_unattributed');
});
