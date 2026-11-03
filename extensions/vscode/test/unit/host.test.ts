import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {ActionService, type NativeAdapter} from '../../src/host/actions.js';
import {MockTransport,loadMockFixture} from '../../src/host/mock.js';
import {HostError,TypedClient,type Transport} from '../../src/host/client.js';
import {MessageRouter} from '../../src/host/router.js';
import {parseRequest} from '../../src/host/protocol.js';
import {PollCoordinator} from '../../src/host/polling.js';
import type {RequestType} from '../../src/host/protocol.js';
const fixturePath=resolve(__dirname,'../fixtures/pool-demo.json');
async function harness(trusted=true){
  const fixture=await loadMockFixture(fixturePath);const transport=new MockTransport(fixture);const transports=[transport];const storage=new Map<string,unknown>();const diffs:string[]=[];let first=true;
  const native:NativeAdapter={trusted:()=>trusted,getState:<T>(key:string,fallback:T)=>(storage.get(key)??fallback)as T,setState:async(key,value)=>{storage.set(key,value);},pickAccountFiles:async()=>undefined,pickRepository:async()=>'/mock/source',openDiff:async(_task,_hash,file,read)=>{diffs.push(await read('base'),await read('final'),file.fileId);},openSettings:async()=>{},saveInterval:async()=>{},copyDiagnostics:async()=>{},guidance:async()=>{}};
  const service=new ActionService({mode:'mock',poolHome:'/mock/pool',host:'mock-host',authority:'local',createTransport:async()=>{if(first){first=false;return transport;}const next=new MockTransport(fixture);transports.push(next);return next;},native,onSnapshot:()=>{}});
  let id=0;const execute=(type:RequestType,payload:unknown={})=>service.execute(parseRequest({v:1,id:String(++id),generation:service.generation(),type,payload}));
  return {service,transport,transports,native,storage,diffs,execute,setTrusted:(value:boolean)=>{trusted=value;}};
}
function setApprovalContent(h:Awaited<ReturnType<typeof harness>>,document:any):void{
  const review=h.transport.fixture.reviews['approval-demo']!;const text=JSON.stringify(document);
  h.transport.fixture.approvalContents[review.reviewId]=text;
  review.content={...review.content!,totalBytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')};
}
async function officialPermissionHarness(){
  const h=await harness();const review=h.transport.fixture.reviews['approval-demo']!;
  const document=JSON.parse(h.transport.fixture.approvalContents[review.reviewId]!);
  document.interaction=JSON.parse(await readFile(resolve(__dirname,'../../../../test/runtime/fixtures/official-permission.json'),'utf8'));
  document.interaction.interactionId=review.approvalId;
  review.decisions=[{decision:'accept',label:'Allow once',nativeOptionId:'allowOnce'},{decision:'decline',label:'Deny',nativeOptionId:'deny'}];
  setApprovalContent(h,document);await h.execute('connect');await h.execute('task.select',{taskId:review.taskId});
  return {...h,document};
}
test('strict bridge rejects generic RPC, paths, unknown keys and oversized requests',()=>{
  const good={v:1,id:'r',generation:0,type:'worker.stop',payload:{workerId:'worker-demo'}};assert.equal(parseRequest(good).type,'worker.stop');
  for(const bad of [{...good,method:'daemon_stop'},{...good,type:'rpc.call'},{...good,payload:{workerId:'worker-demo',path:'/etc/passwd'}},{...good,payload:{workerId:'worker-demo',transport:'real'}},{...good,payload:{workerId:'x'.repeat(151)}}])assert.throws(()=>parseRequest(bad));
});
test('activation and ready do no transport work; trust and legacy capabilities are checked in Host',async()=>{
  const h=await harness(false);assert.equal(h.transport.calls.length,0);await h.execute('ready');assert.equal(h.transport.calls.length,0);await h.execute('connect');assert.ok(h.transport.calls.every(c=>c.method==='ui_capabilities'||c.method==='overview'||c.method.startsWith('ui_get_')||c.method==='ui_list_tasks'));
  for(const [type,payload]of [['worker.probe',{workerId:'worker-demo'}],['worker.stop',{workerId:'worker-demo'}],['cancel',{taskId:'task-approval'}],['accounts.import',{}]]as const)await assert.rejects(h.execute(type,payload),/Trust this workspace/);
  h.service.dispose();assert.ok(!h.transport.calls.some(c=>['daemon_stop','stop_worker','cancel_task'].includes(c.method)));
});
test('router deduplicates IDs and rejects stale generation without forwarding',async()=>{
  const h=await harness();const replies:any[]=[];const router=new MessageRouter(h.service,r=>replies.push(r));
  const connect={v:1,id:'connect',generation:0,type:'connect',payload:{}};await Promise.all([router.receive(connect),router.receive(connect)]);assert.equal(h.transport.calls.filter(c=>c.method==='ui_capabilities').length,1);
  await router.receive({v:1,id:'bad',generation:0,type:'worker.stop',payload:{workerId:'worker-demo'}});assert.equal(replies.at(-1).error.code,'STALE_CONNECTION');
  await router.receive({...connect,payload:{method:'dispatch_task'}});assert.equal(replies.at(-1).error.code,'INVALID_MESSAGE');router.dispose();h.service.dispose();
});
test('one submit token has one request ID; uncertain writes are not replayed',async()=>{
  const h=await harness();await h.execute('connect');const draft={...h.service.state.draft,workspaceId:'workspace-demo',workerId:'worker-demo',prompt:'A deterministic mock task.'};await h.execute('draft.change',{draft});
  await Promise.all([h.execute('dispatch',{submitToken:draft.submitToken}),h.execute('dispatch',{submitToken:draft.submitToken})]);
  assert.equal(h.transport.calls.filter(c=>c.method==='dispatch_task').length,1);
  const saved=h.storage.get('dispatchRecovery')as any[];assert.equal(saved.length,1);assert.equal(JSON.stringify(saved).includes(draft.prompt),false);assert.ok(saved[0].payloadHash);
  await h.execute('draft.change',{draft:{...draft,prompt:'different'}});await assert.rejects(h.execute('dispatch',{submitToken:draft.submitToken}),/different task content/);h.service.dispose();
});
test('complete approval is hash-verified; accepts require complete content and receipt prevents opposing replies',async()=>{
  const h=await harness();await h.execute('connect');await h.execute('task.select',{taskId:'task-approval'});const review:any=await h.execute('approval.open',{taskId:'task-approval',approvalId:'approval-demo'});
  const payload={taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId,contentSha256:review.content.sha256,approvalRevision:review.approvalRevision,nativeRevision:review.nativeRevision,decision:'accept'};
  await assert.rejects(h.execute('approval.respond',payload),/Load and verify all/);
  const body:any=await h.execute('approval.read',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId});assert.ok(body.loadedComplete);assert.ok(body.text.length>4000);
  const response:any=await h.execute('approval.respond',payload);assert.equal(response.responseState,'awaiting_native');assert.equal(h.transport.calls.filter(c=>c.method==='ui_respond_approval').length,1);
  await assert.rejects(h.execute('approval.respond',{...payload,decision:'decline'}));assert.equal(h.transport.calls.filter(c=>c.method==='ui_respond_approval').length,1);h.service.dispose();
});
test('official Edit review supports optional denial feedback and retains fixed allow-once/deny choices',async()=>{
  for(const freeText of [undefined,false,true]){
    const h=await officialPermissionHarness();
    try{
      if(freeText===undefined)delete h.document.interaction.payload.freeText;else h.document.interaction.payload.freeText=freeText;
      setApprovalContent(h,h.document);
      const review:any=await h.execute('approval.open',{taskId:'task-approval',approvalId:'approval-demo'});
      assert.equal(review.readOnlyReason,null);assert.deepEqual(review.decisions.map((decision:any)=>decision.nativeOptionId),['allowOnce','deny']);
      const body:any=await h.execute('approval.read',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId});
      assert.equal(body.loadedComplete,true);assert.deepEqual(JSON.parse(body.text),h.document);
      assert.ok(h.document.interaction.payload.options.find((option:any)=>option.kind==='allowAlways').response.permissionUpdates);
      assert.equal(h.transport.calls.some(call=>call.method==='ui_respond_approval'),false);
    }finally{h.service.dispose();}
  }
});
test('feedback-capable reviews retain strict schema, owner, digest and option-response checks',async()=>{
  const cases:[string,string,(h:Awaited<ReturnType<typeof officialPermissionHarness>>)=>void][]=[
    ['unknown decision parameters','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.payload.detail.extra_decision_field='another operation';}],
    ['different owner','APPROVAL_CHANGED',h=>{h.document.owner.nativeTurnId='another-turn';}],
    ['different interaction','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.interactionId='another-approval';}],
    ['duplicate option ID','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.payload.options.push(structuredClone(h.document.interaction.payload.options[0]));}],
    ['wrong option kind','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.payload.options[0].kind='allowAlways';}],
    ['mismatched response','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.payload.options[0].response.decision='deny';}],
    ['allow-once permission update','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.payload.options[0].response.permissionUpdates=[];}],
    ['deny permission update','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.payload.options.at(-1).response.permissionUpdates=[];}],
    ['non-string reason','UNSUPPORTED_SCHEMA',h=>{h.document.interaction.payload.options[0].response.reason={operation:'another operation'};}],
  ];
  for(const [label,code,change]of cases){
    const h=await officialPermissionHarness();
    try{
      change(h);setApprovalContent(h,h.document);
      const review:any=await h.execute('approval.open',{taskId:'task-approval',approvalId:'approval-demo'});
      await assert.rejects(h.execute('approval.read',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId}),(error:unknown)=>error instanceof HostError&&error.code===code,label);
      await assert.rejects(h.execute('approval.respond',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId,contentSha256:review.content.sha256,approvalRevision:review.approvalRevision,nativeRevision:review.nativeRevision,decision:'accept'}),/Load and verify all/);
      assert.equal(h.transport.calls.some(call=>call.method==='ui_respond_approval'),false);
    }finally{h.service.dispose();}
  }
  const h=await officialPermissionHarness();
  try{
    const review:any=await h.execute('approval.open',{taskId:'task-approval',approvalId:'approval-demo'});
    h.transport.fixture.approvalContents[review.reviewId]+=' ';
    await assert.rejects(h.execute('approval.read',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId}),(error:unknown)=>error instanceof HostError&&error.code==='INTEGRITY_MISMATCH');
  }finally{h.service.dispose();}
});
test('immutable file Diff verifies whole file hashes; review binds manifest and never calls daemon',async()=>{
  const h=await harness();await h.execute('connect');await h.execute('task.select',{taskId:'task-complete'});await h.execute('artifacts.list',{taskId:'task-complete'});
  const delivery=h.service.state.delivery;const manifestSha256=delivery.manifest!.manifestSha256!;
  await assert.rejects(h.execute('review.set',{taskId:'task-complete',manifestSha256,reviewed:true}),/Open each available/);
  for(const file of delivery.files)await h.execute('diff.open',{taskId:'task-complete',manifestSha256,fileId:file.fileId});assert.ok(h.diffs.includes('export const answer = 42; // 😀\n'));
  const before=h.transport.calls.length;await h.execute('review.set',{taskId:'task-complete',manifestSha256,reviewed:true});assert.equal(h.transport.calls.length,before);assert.equal(h.service.state.delivery.reviewed,true);
  await assert.rejects(h.execute('diff.open',{taskId:'task-complete',manifestSha256,fileId:'../../etc/passwd'}),/does not belong/);h.service.dispose();
});
test('typed response schema strips secrets and refuses missing control fields',async()=>{
  const transport:Transport={request:async()=>({accounts:[{alias:'safe',provider:'zai',health:'unknown',accessToken:'SECRET'}],workers:[],workspaces:[],tasks:[]}),dispose(){}};const client=new TypedClient(transport);
  const response=await client.legacy('overview',{});assert.equal(JSON.stringify(response).includes('SECRET'),false);
  transport.request=async()=>({selectedApiVersion:{major:1,minor:0}});await assert.rejects(client.call('ui_capabilities',{bootstrapVersion:1,client:{name:'vscode',version:'0.1.0'},supportedApiMajors:[1]}),/failed the UI schema/);
});
test('hidden polling aborts current wait, never renews it and dispose does not mutate',async()=>{
  let waits=0,refreshes=0,aborts=0;const poll=new PollCoordinator(async()=>{refreshes++;},async signal=>{waits++;await new Promise<void>(resolve=>{signal.addEventListener('abort',()=>{aborts++;resolve();},{once:true});});return true;},()=>15000,()=>{});
  poll.setVisible(true);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(waits,1);assert.equal(refreshes,1);poll.setVisible(false);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(aborts,1);assert.equal(waits,1);poll.dispose();
});
test('late selection responses and lower revisions never overwrite the current detail',async()=>{
  const h=await harness();await h.execute('connect');const original=h.transport.request.bind(h.transport);let release:(()=>void)|undefined;
  h.transport.request=async(method,p,signal)=>{const payload=p as any;if(method==='ui_get_task_detail'&&payload.task_id==='task-complete')await new Promise<void>(resolveWait=>{release=resolveWait;});return original(method,p,undefined);};
  const first=h.execute('task.select',{taskId:'task-complete'});await new Promise(resolveWait=>setImmediate(resolveWait));
  await h.execute('task.select',{taskId:'task-unknown'});release!();await assert.rejects(first,/newer task/);assert.equal(h.service.state.detail!.taskId,'task-unknown');
  const current=h.service.state.detail!;current.revision=1000;h.transport.fixture.details['task-unknown']!.revision=1;await h.execute('task.select',{taskId:'task-unknown'});assert.equal(h.service.state.detail!.revision,1000);h.service.dispose();
});
test('panel close clears approval read authority and aborts content reads without task cancellation',async()=>{
  const h=await harness();await h.execute('connect');await h.execute('task.select',{taskId:'task-approval'});const review:any=await h.execute('approval.open',{taskId:'task-approval',approvalId:'approval-demo'});
  await h.execute('approval.read',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId});h.service.closePanel();
  await assert.rejects(h.execute('approval.respond',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId,contentSha256:review.content.sha256,approvalRevision:review.approvalRevision,nativeRevision:review.nativeRevision,decision:'accept'}),/stale, read-only/);
  assert.equal(h.transport.calls.filter(c=>c.method==='cancel_task'||c.method==='stop_worker').length,0);assert.equal(h.service.state.draft.submitToken.length>0,true);h.service.dispose();
});
test('current-file opening is manifest-bound and mock never reads workspace files',async()=>{
  const h=await harness();await h.execute('connect');await h.execute('task.select',{taskId:'task-complete'});await h.execute('artifacts.list',{taskId:'task-complete'});const manifestSha256=h.service.state.delivery.manifest!.manifestSha256!;
  await assert.rejects(h.execute('file.current.open',{taskId:'task-complete',manifestSha256,fileId:'file-demo'}),/does not read/);
  const file=h.service.state.delivery.files[0]!;file.finalPath='../../outside';await assert.rejects(h.execute('file.current.open',{taskId:'task-complete',manifestSha256,fileId:file.fileId}),/safe current-worktree path/);h.service.dispose();
});
test('stale snapshots block Host writes and reconnect clears live quota caches',async()=>{
  const h=await harness();await h.execute('connect');await h.execute('worker.probe',{workerId:'worker-demo'});assert.ok(h.service.state.resources.quotas['account-demo']?.live);
  h.service.state.connection.stale=true;await assert.rejects(h.execute('worker.probe',{workerId:'worker-demo'}),/Refresh this connection/);h.service.disconnect();assert.deepEqual(h.service.state.resources.quotas,{});h.service.dispose();
});
test('hide/show invalidates the previous polling iteration and refresh remains single-flight',async()=>{
  let waits=0;let refreshes=0;let finishRefresh:()=>void=()=>{};
  const coordinator=new PollCoordinator(async()=>{refreshes++;if(refreshes===1)await new Promise<void>(resolveRefresh=>{finishRefresh=resolveRefresh;});},async signal=>{waits++;await new Promise<void>(resolveWait=>signal.addEventListener('abort',()=>setTimeout(resolveWait,10),{once:true}));return true;},()=>15000,()=>{});
  const first=coordinator.requestRefresh();const second=coordinator.requestRefresh();assert.equal(refreshes,1);finishRefresh();await Promise.all([first,second]);
  coordinator.setVisible(true);await new Promise(resolveWait=>setTimeout(resolveWait,20));assert.equal(waits,1);coordinator.setVisible(false);coordinator.setVisible(true);await new Promise(resolveWait=>setTimeout(resolveWait,40));assert.equal(waits,2);coordinator.dispose();
});
for(const picker of ['accounts.import','workspace.create']as const)test(`deferred ${picker} picker cannot move its intent across generation or trust changes`,async()=>{
  for(const reconnect of [false,true]){
    const h=await harness();await h.execute('connect');let finish:(value:any)=>void=()=>{};
    if(picker==='accounts.import')h.native.pickAccountFiles=async()=>new Promise(resolvePicker=>{finish=resolvePicker;});else h.native.pickRepository=async()=>new Promise(resolvePicker=>{finish=resolvePicker;});
    const pending=h.execute(picker,picker==='workspace.create'?{baseRef:'HEAD'}:{});await new Promise(resolveWait=>setImmediate(resolveWait));
    if(reconnect){h.service.disconnect();await h.execute('connect');}h.setTrusted(false);finish(picker==='accounts.import'?['/mock/account.json']:'/mock/repo');
    await assert.rejects(pending);assert.equal(h.transports.flatMap(t=>t.calls).filter(c=>c.method==='import_accounts'||c.method==='create_workspace').length,0);h.service.dispose();
  }
});
for(const operation of ['dispatch','approval.respond']as const)test(`deferred ${operation} storage cannot send to a replaced connection`,async()=>{
  const h=await harness();await h.execute('connect');let payload:any;
  if(operation==='dispatch'){const draft={...h.service.state.draft,workspaceId:'workspace-demo',workerId:'worker-demo',prompt:'Never cross connections.'};await h.execute('draft.change',{draft});payload={submitToken:draft.submitToken};}
  else{await h.execute('task.select',{taskId:'task-approval'});const review:any=await h.execute('approval.open',{taskId:'task-approval',approvalId:'approval-demo'});await h.execute('approval.read',{taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId});payload={taskId:review.taskId,approvalId:review.approvalId,reviewId:review.reviewId,contentSha256:review.content.sha256,approvalRevision:review.approvalRevision,nativeRevision:review.nativeRevision,decision:'accept'};}
  const original=h.native.setState;let finish:()=>void=()=>{};let stored=false;
  h.native.setState=async(key,value)=>{if(key===(operation==='dispatch'?'dispatchRecovery':'approvalReceipts'))await new Promise<void>(resolveStorage=>{stored=true;finish=resolveStorage;});await original(key,value);};
  const pending=h.execute(operation,payload);await new Promise(resolveWait=>setImmediate(resolveWait));assert.ok(stored);h.service.disconnect();await h.execute('connect');h.setTrusted(false);finish();await assert.rejects(pending);
  assert.equal(h.transports.flatMap(t=>t.calls).filter(c=>c.method==='dispatch_task'||c.method==='ui_respond_approval').length,0);h.service.dispose();
});
test('reconnecting to a new store discards the old history chain and loads its first page',async()=>{
  const old=await loadMockFixture(fixturePath);const template=old.details['task-complete']!;
  old.details=Object.fromEntries(Array.from({length:60},(_,i)=>{const taskId=`old-${String(i).padStart(3,'0')}`;return[taskId,{...structuredClone(template),taskId,requestId:`request-${taskId}`,createdAtMs:template.createdAtMs+i}];}));old.overview.workspaces=old.overview.workspaces.filter(w=>w.workspaceId==='workspace-demo');
  const next=structuredClone(old);next.capabilities.storeId='new-store';next.capabilities.instanceId='new-instance';next.details={'new-only':{...structuredClone(template),taskId:'new-only',requestId:'request-new-only'}};
  const h=await harness();let connects=0;const service=new ActionService({mode:'mock',poolHome:'/mock/pool',host:'mock-host',authority:'local',createTransport:async()=>new MockTransport(connects++?next:old),native:h.native,onSnapshot:()=>{}});let id=0;const exec=(type:RequestType,payload:unknown={})=>service.execute(parseRequest({v:1,id:String(++id),generation:service.generation(),type,payload}));
  await exec('connect');assert.equal(service.state.tasks.length,50);assert.ok(service.state.listNextCursor);await exec('tasks.list',{cursor:service.state.listNextCursor});assert.equal(service.state.tasks.length,60);service.disconnect();await exec('connect');assert.equal(service.state.connection.storeId,'new-store');assert.equal(service.state.total,1);assert.deepEqual(service.state.tasks.map(task=>task.taskId),['new-only']);assert.equal(service.state.listNextCursor,null);service.dispose();h.service.dispose();
});

test('finish-work is a separate guarded operation: busy refusal retains connection, idle shutdown disconnects once',async()=>{
 const h=await harness();try{
  await h.execute('connect');await assert.rejects(h.execute('pool.shutdown'),{code:'POOL_BUSY'});
  assert.equal(h.service.snapshot().connection.state,'connected');
  h.setTrusted(false);await assert.rejects(h.execute('pool.shutdown'),{code:'WORKSPACE_UNTRUSTED'});h.setTrusted(true);
  for(const detail of Object.values(h.transport.fixture.details))detail.leaseHeld=false;
  const before=h.transport.calls.filter(c=>c.method==='shutdown_pool').length;
  const results=await Promise.all([h.execute('pool.shutdown'),h.execute('pool.shutdown')]);
  assert.deepEqual(results[0],results[1]);assert.equal(h.transport.calls.filter(c=>c.method==='shutdown_pool').length,before+1);
  assert.equal(h.service.snapshot().connection.state,'disconnected');
  assert.ok(h.transport.fixture.overview.accounts.length,'accounts retained');
 }finally{h.service.dispose();}
});

test('finish-work is unavailable against older daemons without lifecycle capability',async()=>{
 const h=await harness();try{
  h.transport.fixture.capabilities.capabilities.poolLifecycle={version:0};await h.execute('connect');
  await assert.rejects(h.execute('pool.shutdown'));assert.equal(h.transport.calls.some(c=>c.method==='shutdown_pool'),false);
 }finally{h.service.dispose();}
});

test('account.probe direct pass requests quota and updates live quota cache with tier and windows',async()=>{
 const h=await harness();try{
  await h.execute('connect');
  const result:any=await h.execute('account.probe',{accountAlias:'account-demo'});
  assert.equal(result.accountAlias,'account-demo');
  assert.equal(result.live?.tier,'pro');
  assert.equal(result.live?.windows.length,2);
  assert.ok(h.service.state.resources.quotas['account-demo']?.live);
  assert.equal(h.service.state.resources.quotas['account-demo']?.live?.tier,'pro');
  assert.equal(h.transport.calls.some(c=>c.method==='ui_probe_quota'&&(c.params as any).account_id==='account-demo'),true);
 }finally{h.service.dispose();}
});

test('accounts.probeAll batches all available accounts with dynamic quota updates and retains email/name metadata',async()=>{
 const h=await harness();try{
  await h.execute('connect');
  const demo=h.service.state.resources.accounts.find(a=>a.alias==='account-demo');
  const review=h.service.state.resources.accounts.find(a=>a.alias==='account-review');
  assert.equal(demo?.email,'builder@example.invalid');
  assert.equal(demo?.name,'builder@example.invalid');
  assert.equal(review?.email,'reviewer@example.invalid');

  const firstProbe:any=await h.execute('account.probe',{accountAlias:'account-demo'});
  const firstRemaining=firstProbe.live?.remaining;

  const probeAllResult:any=await h.execute('accounts.probeAll',{});
  assert.equal(probeAllResult.probed,true);
  assert.ok(h.service.state.resources.quotas['account-demo']?.live);
  assert.ok(h.service.state.resources.quotas['account-review']?.live);

  const secondRemaining=h.service.state.resources.quotas['account-demo']?.live?.remaining;
  assert.notEqual(firstRemaining,secondRemaining);

  await h.execute('resources.refresh',{});
  const thirdRemaining=h.service.state.resources.quotas['account-demo']?.live?.remaining;
  assert.notEqual(secondRemaining,thirdRemaining);
 }finally{h.service.dispose();}
});

test('typed error reads retain observed counts and unknown completeness including zero-error accounts',async()=>{
  const h=await harness();
  try{
    await h.execute('connect');
    const account=h.service.state.workOverview!.accountErrors['account-unknown'];
    assert.equal(account.total,0);assert.equal(account.complete,null);assert.equal(account.incompleteTaskCount,1);
    await h.execute('errors.read',{taskId:'task-unknown'});
    assert.equal(h.service.state.errorStats!.total,0);assert.equal(h.service.state.errorStats!.complete,null);
    await h.execute('errors.read',{taskId:'task-complete'});
    assert.equal(h.service.state.errorStats!.total,5);assert.equal(h.service.state.errorStats!.complete,true);
    assert.equal(new Set(h.service.state.errorStats!.events.map(event=>event.occurrenceKey)).size,5);
  }finally{h.service.dispose();}
});

