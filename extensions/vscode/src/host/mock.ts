import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { uiCapabilitiesSchema,uiTaskDetailSchema,uiApprovalReviewSchema,uiArtifactManifestSchema,uiArtifactFileSchema,uiPermissionReviewSchema, type UiTaskDetail } from '../../../../src/shared/ui-contract.js';
import { HostError, type Transport } from './client.js';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fixtureSchema=z.object({version:z.literal(1),clock:z.number().int(),capabilities:uiCapabilitiesSchema,
  overview:z.object({accounts:z.array(z.object({alias:z.string(),provider:z.string(),health:z.string(),plan:z.string().optional()})),workers:z.array(z.object({workerId:z.string(),accountAlias:z.string(),state:z.string(),processOwned:z.boolean(),runningTaskCount:z.number(),version:z.string().optional()})),workspaces:z.array(z.object({workspaceId:z.string(),repositoryPath:z.string(),worktreePath:z.string(),branch:z.string(),baseCommit:z.string(),activeTaskId:z.string().nullable(),state:z.string()})),tasks:z.array(z.unknown())}),
  details:z.record(uiTaskDetailSchema),reviews:z.record(uiApprovalReviewSchema),approvalContents:z.record(z.string()),manifests:z.record(uiArtifactManifestSchema),files:z.record(z.array(uiArtifactFileSchema)),fileContents:z.record(z.string()),patches:z.record(z.string()),events:z.array(z.object({taskId:z.string(),revision:z.number(),type:z.string(),status:z.string(),createdAt:z.number()})),
}).strict();
export type MockFixture=z.infer<typeof fixtureSchema>;
export function validateMockFixture(value:unknown):MockFixture{
  const fixture=fixtureSchema.parse(value);
  for(const review of Object.values(fixture.reviews)){
    if(!review.content)continue;const text=fixture.approvalContents[review.reviewId];
    if(text===undefined||Buffer.byteLength(text)!==review.content.totalBytes||hash(text)!==review.content.sha256)throw new Error('Invalid mock approval integrity');
    uiPermissionReviewSchema.parse(JSON.parse(text));
  }
  for(const files of Object.values(fixture.files))for(const file of files)for(const side of ['base','final'] as const){const expected=file[side];if(expected.state==='available'){const text=fixture.fileContents[`${file.fileId}:${side}`];if(text===undefined||hash(text)!==expected.sha256||Buffer.byteLength(text)!==expected.sizeBytes)throw new Error('Invalid mock artifact integrity');}}
  return fixture;
}
export async function loadMockFixture(path:string):Promise<MockFixture>{
  try{return validateMockFixture(JSON.parse(await readFile(path,'utf8')));}catch{throw new HostError('MOCK_INITIALIZATION_FAILED','The selected mock fixture is missing or invalid. Real transport was not opened.');}
}
/** Deterministic memory-only state machine. It has no socket, runtime, worker or vault imports. */
export class MockTransport implements Transport {
  readonly calls:{method:string;params:unknown}[]=[];
  readonly fixture:MockFixture;
  private disposed=false;
  private revision=100;
  private maxConcurrentTasks:number|null=null;
  private policy(){const occupiedSlots=Object.values(this.fixture.details).filter(t=>t.leaseHeld).length;return {maxConcurrentTasks:this.maxConcurrentTasks,occupiedSlots,availableSlots:this.maxConcurrentTasks===null?null:Math.max(0,this.maxConcurrentTasks-occupiedSlots)};}
  private readonly responseTicks=new Map<string,number>();
  failNext?:string;
  constructor(fixture:MockFixture){this.fixture=structuredClone(validateMockFixture(fixture));}
  private envelope(data:unknown):unknown{return {meta:{apiVersion:1,instanceId:this.fixture.capabilities.instanceId,storeId:this.fixture.capabilities.storeId,servedAtMs:this.fixture.clock},data};}
  async request(method:string,raw:unknown,signal?:AbortSignal):Promise<unknown>{
    if(this.disposed||signal?.aborted)throw new HostError('ABORTED','Mock observation was stopped.');
    this.calls.push({method,params:structuredClone(raw)});
    if(this.failNext===method){this.failNext=undefined;throw new HostError('DAEMON_UNAVAILABLE','The mock connection was interrupted. No real connection was opened.');}
    const p=raw as Record<string,any>;const f=this.fixture;const task=p.task_id?f.details[p.task_id]:undefined;
    switch(method){
      case 'ui_capabilities':return f.capabilities;
      case 'overview':return {...f.overview,poolPolicy:this.policy(),tasks:Object.values(f.details).map(d=>this.compact(d))};
      case 'shutdown_pool':{if(Object.values(f.details).some(d=>d.leaseHeld))throw new HostError('POOL_BUSY','仍有任务占用，无法收工。');const workers=f.overview.workers.filter(w=>w.state!=='stopped');for(const worker of workers){worker.state='stopped';worker.processOwned=false;}return {stopping:true,workersStopped:true,stoppedWorkers:workers.length};}
      case 'get_pool_policy':return this.policy();
      case 'set_pool_policy':{if(p.max_concurrent_tasks!==null&&(!Number.isInteger(p.max_concurrent_tasks)||p.max_concurrent_tasks<0||p.max_concurrent_tasks>64))throw new HostError('INVALID_ARGUMENT','Invalid concurrency limit');this.maxConcurrentTasks=p.max_concurrent_tasks;return this.policy();}
      case 'ui_get_task_detail':{const detail=task??Object.values(f.details).find(d=>d.requestId===p.request_id);if(!detail)throw new HostError('NOT_FOUND','The original task was not found; no dispatch was resent.');this.advance(detail);return this.envelope(detail);}
      case 'ui_list_tasks':{
        const revision=this.listRevision();const filter=p.filter??{};const marker=JSON.stringify(filter);let offset=0;
        if(p.cursor){let c;try{c=JSON.parse(Buffer.from(p.cursor,'base64url').toString());}catch{throw new HostError('CURSOR_INVALID','Mock cursor is invalid.');}if(c.marker!==marker||c.revision!==revision)throw new HostError('CURSOR_STALE','Mock list changed.');offset=c.offset;}
        const items=Object.values(f.details).filter(d=>(!filter.repository_path||d.workspace.repositoryPath===filter.repository_path)&&(!filter.workspace_id||d.workspaceId===filter.workspace_id)&&(!filter.worker_id||d.workerId===filter.worker_id)&&(!filter.statuses||filter.statuses.includes(d.status))&&(filter.lease_held===undefined||d.leaseHeld===filter.lease_held)&&(!filter.query||[d.taskId,d.workspaceId,d.workerId,d.workspace.repositoryPath,d.workspace.branch].some(s=>s?.toLowerCase().includes(filter.query.toLowerCase())))).sort((a,b)=>b.createdAtMs-a.createdAtMs||a.taskId.localeCompare(b.taskId));
        const limit=p.limit??50;const next=offset+limit;return this.envelope({items:items.slice(offset,next),total:items.length,nextCursor:next<items.length?Buffer.from(JSON.stringify({marker,revision,offset:next})).toString('base64url'):null,listRevision:revision,observedAtMs:f.clock,scope:'all_matching_tasks'});
      }
      case 'wait':{
        // Abortable delay prevents an immediate mock wait from becoming a polling busy loop.
        await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},1000);const abort=()=>{clearTimeout(timer);reject(new HostError('ABORTED','Mock wait aborted.'));};signal?.addEventListener('abort',abort,{once:true});});
        const tasks=(p.task_ids as string[]).map(id=>f.details[id]).filter((d):d is UiTaskDetail=>!!d);for(const d of tasks)this.advance(d);
        const changed=tasks.filter(d=>d.revision>(typeof p.after_revision==='number'?p.after_revision:p.after_revision?.[d.taskId]??-1));return {tasks:tasks.map(d=>this.compact(d)),changedTaskIds:changed.map(d=>d.taskId),timedOut:!changed.length,revision:this.listRevision()};
      }
      case 'get_result':if(!task)throw new HostError('NOT_FOUND','Task not found.');return {task:this.compact(task),result:task.result.available?{summary:task.result.summary,verification:task.result.verification.map(v=>({command:v.commandDisplay,exitCode:v.exitCode,summary:v.summary})),changedFiles:['src/demo.ts','notes.txt'],blockers:task.result.blockers}:null};
      case 'get_logs':{const events=f.events.filter(e=>e.taskId===p.task_id&&e.revision>(p.cursor??0)).slice(0,p.limit??20);return {events,nextCursor:events.at(-1)?.revision??p.cursor??0,hasMore:false};}
      case 'get_diff':{const patch=f.patches[p.task_id];if(patch===undefined)return {available:false};const offset=p.offset??0;const text=patch.slice(offset,offset+(p.limit??4000));return {available:true,text,nextOffset:offset+text.length<patch.length?offset+text.length:null,totalCharacters:patch.length};}
      case 'ui_list_approvals':{
        if(!task)throw new HostError('NOT_FOUND','Task not found.');const reviews=Object.values(f.reviews).filter(r=>r.taskId===task.taskId&&r.state!=='gone');
        return this.envelope({items:reviews.map(r=>({approvalId:r.approvalId,kind:'permission',toolName:'Write',summary:'Write src/demo.ts. Load full content before allowing once.',truncated:true,sourceComplete:r.content?.sourceComplete??false,responseState:r.response.state,readOnlyReason:r.readOnlyReason})),total:reviews.length,nextCursor:null,approvalSetRevision:`set-${task.revision}`,stateKnown:true,unattributedCount:0});
      }
      case 'ui_get_approval':{const review=f.reviews[p.approval_id];if(!review||review.taskId!==p.task_id)throw new HostError('APPROVAL_GONE','Approval is no longer pending.');return this.envelope(review);}
      case 'ui_read_approval':{const review=f.reviews[p.approval_id];if(!review||review.taskId!==p.task_id||review.reviewId!==p.review_id)throw new HostError('APPROVAL_CHANGED','Mock review changed.');return this.envelope({...this.chunk(f.approvalContents[review.reviewId]!,p.offset_bytes,p.limit_bytes),reviewId:review.reviewId,contentSha256:review.content!.sha256});}
      case 'ui_respond_approval':{
        const review=f.reviews[p.approval_id];if(!task||!review||review.state!=='pending'||review.content?.sha256!==p.expected_content_sha256||review.approvalRevision!==p.expected_approval_revision||review.nativeRevision!==p.expected_native_revision)throw new HostError('APPROVAL_CHANGED','The mock approval changed. Reload its complete content.');
        review.response={actionId:p.action_id,decision:p.decision,state:'awaiting_native'};review.state='response_pending';task.approval.responsePending=true;task.revision=++this.revision;this.responseTicks.set(task.taskId,0);
        return this.envelope({taskId:task.taskId,approvalId:review.approvalId,actionId:p.action_id,responseState:'awaiting_native',nativeRevisionAtCheck:review.nativeRevision,taskRevision:task.revision});
      }
      case 'ui_get_artifact_manifest':return this.envelope(f.manifests[p.task_id]??{taskId:p.task_id,state:'not_captured',schemaVersion:1,manifestSha256:null,scope:'workspace_base_cumulative',baseCommit:task?.workspace.baseCommit??'',sourceScope:'git_tracked_plus_nonignored_untracked',captureStartedAtMs:null,captureCompletedAtMs:null,consistency:'legacy_unknown',fileCount:null,availableFileCount:0,unavailableFileCount:0,fileListComplete:false,patch:{available:false,sha256:null,sizeBytes:null},unavailableReason:'No immutable delivery was captured.'});
      case 'ui_list_artifact_files':{const files=f.files[p.manifest_sha256];if(!files||f.manifests[p.task_id]?.manifestSha256!==p.manifest_sha256)throw new HostError('ARTIFACT_UNAVAILABLE','Unknown mock manifest.');return this.envelope({items:files,total:files.length,nextCursor:null,manifestSha256:p.manifest_sha256});}
      case 'ui_read_artifact_file':{if(f.manifests[p.task_id]?.manifestSha256!==p.manifest_sha256)throw new HostError('ARTIFACT_UNAVAILABLE','Unknown mock manifest.');const file=f.files[p.manifest_sha256]?.find(item=>item.fileId===p.file_id);const content=f.fileContents[`${p.file_id}:${p.side}`];if(!file||content===undefined)throw new HostError('ARTIFACT_UNAVAILABLE','Immutable mock side is absent.');const chunk=this.chunk(content,p.offset_bytes,p.limit_bytes);return this.envelope({...chunk,manifestSha256:p.manifest_sha256,fileId:p.file_id,side:p.side,fileSha256:file[p.side as 'base'|'final'].sha256,chunkSha256:hash(Buffer.from(chunk.dataBase64,'base64')),encoding:'utf8'});}
      case 'ui_get_quota':case 'ui_probe_quota':{const alias=method==='ui_get_quota'?p.account_id:f.overview.workers.find(w=>w.workerId===p.worker_id)?.accountAlias;if(!alias)throw new HostError('NOT_FOUND','Mock account not found.');const live=method==='ui_probe_quota';return this.envelope({accountAlias:alias,imported:{source:'imported_snapshot',accountAlias:alias,providerId:'account:zai-start-plan',observedAtMs:null,storedAtMs:null,generatedAt:{value:1793491000,unit:'unknown',atMs:null},serverTime:null,nextReset:null,unit:'unknown',total:null,used:null,remaining:0,percentage:null,authenticated:null,freshness:'unknown'},live:live?{source:'live_probe',accountAlias:alias,providerId:'account:zai-start-plan',observedAtMs:Date.now(),storedAtMs:Date.now(),generatedAt:null,serverTime:null,nextReset:null,unit:'unknown',total:100,used:20,remaining:80,percentage:null,authenticated:true,freshness:'fresh'}:null,lastProbe:{state:live?'succeeded':'never',attemptedAtMs:live?Date.now():null,errorCode:null},displayFreshnessWindowMs:120000});}
      case 'dispatch_task':{
        const prior=Object.values(f.details).find(d=>d.requestId===p.request_id);if(prior)return {task:this.compact(prior),created:false};
        if(this.policy().availableSlots===0)throw new HostError('POOL_CAPACITY_REACHED','并发已满或新任务已暂停；等待现有任务释放占用。');
        const workspace=f.overview.workspaces.find(w=>w.workspaceId===p.workspace_id);const worker=f.overview.workers.find(w=>w.workerId===p.worker_id);if(!workspace||!worker||workspace.activeTaskId)throw new HostError('WORKSPACE_BUSY','Mock resource is held.');
        const detail=structuredClone(f.details['task-approval']!);const taskId=`task-mock-${++this.revision}`;const commandId=p.request_id;const sessionId=`mock-session-${this.revision}`;
        Object.assign(detail,{taskId,workspaceId:workspace.workspaceId,workerId:worker.workerId,workspace:structuredClone(workspace),requestId:p.request_id,status:'running',revision:this.revision,createdAtMs:f.clock+this.revision,updatedAtMs:f.clock+this.revision,leaseHeld:true,executionStopped:false,cancelRequestedAtMs:null,diagnostic:null});
        detail.execution={dispatchAttemptedAtMs:f.clock,currentCommandId:commandId,sessionId,turnId:commandId,stopProof:null,attachment:'attached',finalizing:false};
        detail.attempts=[{index:0,commandId,sessionId,turnId:commandId,intentAtMs:f.clock,acknowledgedAtMs:f.clock,terminalState:null,stopProofKind:null,failureCategory:null,busyRetryEligible:false,continuationBlocked:false}];detail.currentAttemptIndex=0;
        detail.result={available:false,createdAtMs:null,summary:'',summaryTruncated:false,changedFileCount:0,artifactCount:0,verification:[],blockers:[],manifestState:'not_captured'};
        detail.approval={pendingCount:0,responsePending:false,stateKnown:true};detail.controls.cancel.available=true;detail.controls.reconcile.available=false;detail.controls.resume.available=false;
        detail.selection={requestedWorkerId:worker.workerId,requestedSession:p.session,mode:p.mode,requestedModelId:p.model_id,binding:{accountAlias:worker.accountAlias,providerId:`account:${f.overview.accounts.find(a=>a.alias===worker.accountAlias)?.provider??'zai'}-start-plan`,modelId:p.model_id}};
        detail.verificationPolicy.commands=p.verify_commands.map((c:any)=>({command:c.command,args:c.args,timeoutMs:c.timeout_ms}));detail.verificationPolicy.defaultDiffCheck=!p.verify_commands.length;detail.retry={used:0,max:p.busy_retry_limit,reason:'model_busy'};
        f.details[taskId]=detail;workspace.activeTaskId=taskId;this.responseTicks.set(taskId,0);return {task:this.compact(detail),created:true};
      }
      case 'cancel_task':if(!task)throw new HostError('NOT_FOUND','Task not found.');task.cancelRequestedAtMs=f.clock;task.revision=++this.revision;task.controls.cancel.available=false;return {task:this.compact(task),cancelRequested:true,terminationConfirmed:false};
      case 'reconcile_task':if(!task)throw new HostError('NOT_FOUND','Task not found.');task.execution.attachment='not_attached';task.controls.resume.available=true;task.revision=++this.revision;return {task:this.compact(task),canResume:true,requiresInspection:false};
      case 'resume_task':if(!task)throw new HostError('NOT_FOUND','Task not found.');task.execution.attachment='attached';task.status='running';task.revision=++this.revision;this.responseTicks.set(task.taskId,2);return {task:this.compact(task),attached:true};
      case 'create_workspace':{const item={workspaceId:`workspace-${++this.revision}`,repositoryPath:p.repository,worktreePath:`/mock/worktrees/${this.revision}`,branch:`zcode/mock-${this.revision}`,baseCommit:p.base_ref,state:'active',activeTaskId:null};f.overview.workspaces.push(item);return item;}
      case 'start_worker':{const worker={workerId:p.worker_id,accountAlias:p.account_id,state:'ready',processOwned:true,runningTaskCount:0,version:'3.16.3'};f.overview.workers.push(worker);return worker;}
      case 'stop_worker':{const worker=f.overview.workers.find(w=>w.workerId===p.worker_id);if(worker)worker.state='stopped';return {workerId:p.worker_id,stopped:true};}
      case 'import_accounts':return {fileCount:p.files.length,recordCount:p.files.length,duplicateCount:0,summaries:f.overview.accounts.slice(0,1)};
      default:throw new HostError('METHOD_NOT_FOUND','The mock has no such interface.');
    }
  }
  private listRevision():number{return Math.max(0,...Object.values(this.fixture.details).map(d=>d.revision));}
  private compact(d:UiTaskDetail):unknown{const {taskId,workspaceId,workerId,status,revision,leaseHeld,retry}=d;return {taskId,workspaceId,workerId,status,revision,leaseHeld,retry};}
  private chunk(text:string,offset:number,limit=65536){const bytes=Buffer.from(text);const chunk=bytes.subarray(offset,offset+limit);return {offsetBytes:offset,dataBase64:chunk.toString('base64'),byteLength:chunk.length,nextOffsetBytes:offset+chunk.length<bytes.length?offset+chunk.length:null,totalBytes:bytes.length};}
  private advance(task:UiTaskDetail):void{
    const tick=this.responseTicks.get(task.taskId);if(tick===undefined)return;this.responseTicks.set(task.taskId,tick+1);
    if(tick===1){for(const review of Object.values(this.fixture.reviews).filter(r=>r.taskId===task.taskId)){review.state='gone';review.response.state='resolved_unattributed';}task.approval={pendingCount:0,responsePending:false,stateKnown:true};task.status='running';task.revision=++this.revision;}
    if(tick===3){task.status='verifying';task.revision=++this.revision;}
    if(tick>=5){task.status=task.cancelRequestedAtMs?'cancelled':'succeeded';task.executionStopped=true;task.leaseHeld=false;task.revision=++this.revision;task.result=structuredClone(this.fixture.details['task-complete']!.result);task.execution.stopProof={kind:'runtime_terminal',observedAtMs:this.fixture.clock,evidenceSummary:'Mock execution reached a terminal state.'};task.controls.cancel.available=false;const workspace=this.fixture.overview.workspaces.find(w=>w.workspaceId===task.workspaceId);if(workspace)workspace.activeTaskId=null;const source=this.fixture.manifests['task-complete'];if(source)this.fixture.manifests[task.taskId]={...source,taskId:task.taskId};this.responseTicks.delete(task.taskId);}
  }
  dispose():void{this.disposed=true;}
}
