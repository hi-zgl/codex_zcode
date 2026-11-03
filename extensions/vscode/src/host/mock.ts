import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { uiCapabilitiesSchema,uiTaskDetailSchema,uiApprovalReviewSchema,uiArtifactManifestSchema,uiArtifactFileSchema,uiPermissionReviewSchema,uiMethods, type UiTaskDetail } from '../../../../src/shared/ui-contract.js';
import {errorRecordSchema} from '../../../../src/shared/work-contract.js';
import { HostError, type Transport } from './client.js';
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
const fixtureSchema=z.object({version:z.literal(1),clock:z.number().int(),capabilities:uiCapabilitiesSchema,
  workOverview:uiMethods.ui_get_work_overview.result.shape.data.optional(),errorRecords:z.array(errorRecordSchema).default([]),
  nativeErrorCoverage:z.record(z.boolean().nullable()),
  overview:z.object({accounts:z.array(z.object({alias:z.string(),provider:z.string(),health:z.string(),plan:z.string().optional(),quota:z.record(z.unknown()).optional(),email:z.string().optional(),name:z.string().optional(),enabled:z.boolean().optional()})),workers:z.array(z.object({workerId:z.string(),accountAlias:z.string(),state:z.string(),processOwned:z.boolean(),runningTaskCount:z.number(),version:z.string().optional()})),workspaces:z.array(z.object({workspaceId:z.string(),repositoryPath:z.string(),worktreePath:z.string(),branch:z.string(),baseCommit:z.string(),activeTaskId:z.string().nullable(),state:z.string()})),tasks:z.array(z.unknown())}),
  details:z.record(uiTaskDetailSchema),reviews:z.record(uiApprovalReviewSchema),approvalContents:z.record(z.string()),manifests:z.record(uiArtifactManifestSchema),files:z.record(z.array(uiArtifactFileSchema)),fileContents:z.record(z.string()),patches:z.record(z.string()),events:z.array(z.object({taskId:z.string(),revision:z.number(),type:z.string(),status:z.string(),createdAt:z.number()})),
}).strict();
export type MockFixture=z.infer<typeof fixtureSchema>;
interface MockFilterParams { repository_path?:string; workspace_id?:string; worker_id?:string; statuses?:string[]; lease_held?:boolean; query?:string }
interface MockVerifyCommand { command:string; args:string[]; timeout_ms:number }
interface MockRequestParams extends Record<string,unknown> {
  task_id?:string; max_concurrent_tasks?:number|null; request_id?:string; filter?:MockFilterParams; cursor?:string|number; limit?:number;
  task_ids?:string[]; after_revision?:number|Record<string,number>; offset?:number; approval_id?:string; review_id?:string; offset_bytes?:number; limit_bytes?:number;
  expected_content_sha256?:string; expected_approval_revision?:string; expected_native_revision?:number; action_id?:string; decision?:'accept'|'decline'|'cancel';
  manifest_sha256?:string; file_id?:string; side?:'base'|'final'; account_id?:string; worker_id?:string; workspace_id?:string;
  session?:'continue'|'new'; mode?:'build'|'edit'|'plan'|'yolo'|'guarded'; model_id?:string; verify_commands?:MockVerifyCommand[];
  repository?:string; base_ref?:string; files?:string[];
}
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
  private settings={retryIntervalMs:5000,recoveryWaitMs:120000,silenceCheckMs:900000,lowQuotaThresholdPercent:5,defaultCommanderQuota:2};
  private policy(){const occupiedSlots=Object.values(this.fixture.details).filter(t=>t.leaseHeld).length;return {maxConcurrentTasks:this.maxConcurrentTasks,occupiedSlots,availableSlots:this.maxConcurrentTasks===null?null:Math.max(0,this.maxConcurrentTasks-occupiedSlots),...this.settings};}
  private errors(p:Record<string,unknown>){
    const events=this.fixture.errorRecords.filter(event=>(!p.account_alias||event.accountAlias===p.account_alias)&&(!p.task_id||event.taskId===p.task_id)&&(!p.work_id||event.workId===p.work_id)&&(typeof p.from_ms!=='number'||event.occurredAt>=p.from_ms)&&(typeof p.to_ms!=='number'||event.occurredAt<=p.to_ms));
    const work=p.work_id?this.fixture.workOverview?.works.find(work=>work.workId===p.work_id):null;
    const relevant=Object.values(this.fixture.details).filter(task=>(!p.account_alias||task.selection.binding?.accountAlias===p.account_alias)&&(!p.task_id||task.taskId===p.task_id)&&(!work||work.items.some(item=>item.taskId===task.taskId))&&(typeof p.from_ms!=='number'||task.updatedAtMs>=p.from_ms)&&(typeof p.to_ms!=='number'||task.createdAtMs<=p.to_ms));
    const incompleteTaskCount=relevant.filter(task=>this.fixture.nativeErrorCoverage[task.taskId]!==true).length;
    const categories:Record<string,number>={};for(const event of events)categories[event.category]=(categories[event.category]??0)+1;
    return {total:events.length,categories,events:events.slice(-100).reverse(),complete:incompleteTaskCount?null:true,incompleteTaskCount};
  }
  private readonly responseTicks=new Map<string,number>();
  private readonly probeCounts=new Map<string,number>();
  failNext?:string;
  constructor(fixture:MockFixture){this.fixture=structuredClone(validateMockFixture(fixture));}
  private envelope(data:unknown):unknown{return {meta:{apiVersion:1,instanceId:this.fixture.capabilities.instanceId,storeId:this.fixture.capabilities.storeId,servedAtMs:this.fixture.clock},data};}
  async request(method:string,raw:unknown,signal?:AbortSignal):Promise<unknown>{
    if(this.disposed||signal?.aborted)throw new HostError('ABORTED','Mock observation was stopped.');
    this.calls.push({method,params:structuredClone(raw)});
    if(this.failNext===method){this.failNext=undefined;throw new HostError('DAEMON_UNAVAILABLE','The mock connection was interrupted. No real connection was opened.');}
    const p=(raw&&typeof raw==='object'?raw:{}) as MockRequestParams;const f=this.fixture;const task=p.task_id?f.details[p.task_id]:undefined;
    switch(method){
      case 'ui_capabilities':return f.capabilities;
      case 'overview':return {...f.overview,poolPolicy:this.policy(),tasks:Object.values(f.details).map(d=>this.compact(d))};
      case 'shutdown_pool':{if(Object.values(f.details).some(d=>d.leaseHeld))throw new HostError('POOL_BUSY','仍有任务占用，无法收工。');const workers=f.overview.workers.filter(w=>w.state!=='stopped');for(const worker of workers){worker.state='stopped';worker.processOwned=false;}return {stopping:true,workersStopped:true,stoppedWorkers:workers.length};}
      case 'get_pool_policy':return this.policy();
      case 'set_pool_policy':{if(p.max_concurrent_tasks!==undefined){if(p.max_concurrent_tasks!==null&&(typeof p.max_concurrent_tasks!=='number'||!Number.isInteger(p.max_concurrent_tasks)||p.max_concurrent_tasks<0||p.max_concurrent_tasks>64))throw new HostError('INVALID_ARGUMENT','Invalid concurrency limit');this.maxConcurrentTasks=p.max_concurrent_tasks;}for(const [wire,key] of [['retry_interval_ms','retryIntervalMs'],['recovery_wait_ms','recoveryWaitMs'],['silence_check_ms','silenceCheckMs'],['low_quota_threshold_percent','lowQuotaThresholdPercent'],['default_commander_quota','defaultCommanderQuota']] as const)if(typeof p[wire]==='number')this.settings[key]=p[wire] as number;return this.policy();}
      case 'ui_get_work_overview':{
        const all=(f.workOverview?.works??[]).filter(work=>(!p.repository_path||work.repositoryPath===p.repository_path)&&(!p.work_id||work.workId===p.work_id)).sort((a,b)=>b.updatedAt-a.updatedAt);
        const accountErrors=Object.fromEntries(f.overview.accounts.map(account=>{const {total,categories,complete,incompleteTaskCount}=this.errors({account_alias:account.alias});return [account.alias,{total,categories,complete,incompleteTaskCount}];}));
        return this.envelope({works:all.slice(0,p.limit??20),commanders:f.workOverview?.commanders??[],poolPolicy:this.policy(),total:all.length,truncated:all.length>(p.limit??20),observedAtMs:Date.now(),accountErrors});
      }
      case 'ui_get_error_stats':return this.envelope(this.errors(p));
      case 'set_commander_quota':{const commander=f.workOverview?.commanders.find(item=>item.commanderId===p.commander_id);if(!commander)throw new HostError('NOT_FOUND','Commander not found.');commander.defaultQuota=p.default_quota as number;return commander;}
      case 'set_account_enabled':{const account=f.overview.accounts.find(item=>item.alias===p.account_id);if(!account)throw new HostError('NOT_FOUND','Account not found.');account.enabled=p.enabled===true;return {accountAlias:account.alias,enabled:account.enabled};}
      case 'resolve_work_todo':{const work=f.workOverview?.works.find(item=>item.workId===p.work_id);if(!work)throw new HostError('NOT_FOUND','Work not found.');if(p.action==='approve_partial'){work.partialApproval=p.available_accounts as number;work.effectiveAccounts=p.available_accounts as number;}work.todos=work.todos.filter(todo=>todo.todoId!==p.todo_id);return work;}
      case 'ui_get_task_detail':{const detail=task??Object.values(f.details).find(d=>d.requestId===p.request_id);if(!detail)throw new HostError('NOT_FOUND','The original task was not found; no dispatch was resent.');this.advance(detail);return this.envelope(detail);}
      case 'ui_list_tasks':{
        const revision=this.listRevision();const filter=p.filter??{};const marker=JSON.stringify(filter);let offset=0;
        if(typeof p.cursor==='string'&&p.cursor){let c:{marker?:string;revision?:number;offset?:number};try{c=JSON.parse(Buffer.from(p.cursor,'base64url').toString()) as {marker?:string;revision?:number;offset?:number};}catch{throw new HostError('CURSOR_INVALID','Mock cursor is invalid.');}if(c.marker!==marker||c.revision!==revision)throw new HostError('CURSOR_STALE','Mock list changed.');offset=c.offset??0;}
        const queryLower=filter.query?.toLowerCase();
        const items=Object.values(f.details).filter(d=>(!filter.repository_path||d.workspace.repositoryPath===filter.repository_path)&&(!filter.workspace_id||d.workspaceId===filter.workspace_id)&&(!filter.worker_id||d.workerId===filter.worker_id)&&(!filter.statuses||filter.statuses.includes(d.status))&&(filter.lease_held===undefined||d.leaseHeld===filter.lease_held)&&(!queryLower||[d.taskId,d.workspaceId,d.workerId,d.workspace.repositoryPath,d.workspace.branch].some(s=>s?.toLowerCase().includes(queryLower)))).sort((a,b)=>b.createdAtMs-a.createdAtMs||a.taskId.localeCompare(b.taskId));
        const limit=p.limit??50;const next=offset+limit;return this.envelope({items:items.slice(offset,next),total:items.length,nextCursor:next<items.length?Buffer.from(JSON.stringify({marker,revision,offset:next})).toString('base64url'):null,listRevision:revision,observedAtMs:f.clock,scope:'all_matching_tasks'});
      }
      case 'wait':{
        // Abortable delay prevents an immediate mock wait from becoming a polling busy loop.
        await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},1000);const abort=()=>{clearTimeout(timer);reject(new HostError('ABORTED','Mock wait aborted.'));};signal?.addEventListener('abort',abort,{once:true});});
        const tasks=(p.task_ids??[]).map(id=>f.details[id]).filter((d):d is UiTaskDetail=>!!d);for(const d of tasks)this.advance(d);
        const changed=tasks.filter(d=>d.revision>(typeof p.after_revision==='number'?p.after_revision:p.after_revision?.[d.taskId]??-1));return {tasks:tasks.map(d=>this.compact(d)),changedTaskIds:changed.map(d=>d.taskId),timedOut:!changed.length,revision:this.listRevision()};
      }
      case 'get_result':if(!task)throw new HostError('NOT_FOUND','Task not found.');return {task:this.compact(task),result:task.result.available?{summary:task.result.summary,verification:task.result.verification.map(v=>({command:v.commandDisplay,exitCode:v.exitCode,summary:v.summary})),changedFiles:['src/demo.ts','notes.txt'],blockers:task.result.blockers}:null};
      case 'get_logs':{const cursorNum=typeof p.cursor==='number'?p.cursor:0;const events=f.events.filter(e=>e.taskId===p.task_id&&e.revision>cursorNum).slice(0,p.limit??20);return {events,nextCursor:events.at(-1)?.revision??cursorNum,hasMore:false};}
      case 'get_diff':{const patch=p.task_id?f.patches[p.task_id]:undefined;if(patch===undefined)return {available:false};const offset=p.offset??0;const text=patch.slice(offset,offset+(p.limit??4000));return {available:true,text,nextOffset:offset+text.length<patch.length?offset+text.length:null,totalCharacters:patch.length};}
      case 'ui_list_approvals':{
        if(!task)throw new HostError('NOT_FOUND','Task not found.');const reviews=Object.values(f.reviews).filter(r=>r.taskId===task.taskId&&r.state!=='gone');
        return this.envelope({items:reviews.map(r=>({approvalId:r.approvalId,kind:'permission',toolName:'Write',summary:'Write src/demo.ts. Load full content before allowing once.',truncated:true,sourceComplete:r.content?.sourceComplete??false,responseState:r.response.state,readOnlyReason:r.readOnlyReason})),total:reviews.length,nextCursor:null,approvalSetRevision:`set-${task.revision}`,stateKnown:true,unattributedCount:0});
      }
      case 'ui_get_approval':{const review=p.approval_id?f.reviews[p.approval_id]:undefined;if(!review||review.taskId!==p.task_id)throw new HostError('APPROVAL_GONE','Approval is no longer pending.');return this.envelope(review);}
      case 'ui_read_approval':{const review=p.approval_id?f.reviews[p.approval_id]:undefined;if(!review||review.taskId!==p.task_id||review.reviewId!==p.review_id)throw new HostError('APPROVAL_CHANGED','Mock review changed.');return this.envelope({...this.chunk(f.approvalContents[review.reviewId]!,p.offset_bytes??0,p.limit_bytes),reviewId:review.reviewId,contentSha256:review.content!.sha256});}
      case 'ui_respond_approval':{
        const review=p.approval_id?f.reviews[p.approval_id]:undefined;if(!task||!review||review.state!=='pending'||review.content?.sha256!==p.expected_content_sha256||review.approvalRevision!==p.expected_approval_revision||review.nativeRevision!==p.expected_native_revision)throw new HostError('APPROVAL_CHANGED','The mock approval changed. Reload its complete content.');
        review.response={actionId:p.action_id??null,decision:p.decision??null,state:'awaiting_native'};review.state='response_pending';task.approval.responsePending=true;task.revision=++this.revision;this.responseTicks.set(task.taskId,0);
        return this.envelope({taskId:task.taskId,approvalId:review.approvalId,actionId:p.action_id,responseState:'awaiting_native',nativeRevisionAtCheck:review.nativeRevision,taskRevision:task.revision});
      }
      case 'ui_get_artifact_manifest':return this.envelope(f.manifests[p.task_id??'']??{taskId:p.task_id??'',state:'not_captured',schemaVersion:1,manifestSha256:null,scope:'workspace_base_cumulative',baseCommit:task?.workspace.baseCommit??'',sourceScope:'git_tracked_plus_nonignored_untracked',captureStartedAtMs:null,captureCompletedAtMs:null,consistency:'legacy_unknown',fileCount:null,availableFileCount:0,unavailableFileCount:0,fileListComplete:false,patch:{available:false,sha256:null,sizeBytes:null},unavailableReason:'No immutable delivery was captured.'});
      case 'ui_list_artifact_files':{const files=p.manifest_sha256?f.files[p.manifest_sha256]:undefined;if(!files||!p.task_id||f.manifests[p.task_id]?.manifestSha256!==p.manifest_sha256)throw new HostError('ARTIFACT_UNAVAILABLE','Unknown mock manifest.');return this.envelope({items:files,total:files.length,nextCursor:null,manifestSha256:p.manifest_sha256});}
      case 'ui_read_artifact_file':{if(!p.task_id||!p.manifest_sha256||f.manifests[p.task_id]?.manifestSha256!==p.manifest_sha256)throw new HostError('ARTIFACT_UNAVAILABLE','Unknown mock manifest.');const file=f.files[p.manifest_sha256]?.find(item=>item.fileId===p.file_id);const side=p.side??'final';const content=f.fileContents[`${p.file_id}:${side}`];if(!file||content===undefined)throw new HostError('ARTIFACT_UNAVAILABLE','Immutable mock side is absent.');const chunk=this.chunk(content,p.offset_bytes??0,p.limit_bytes);return this.envelope({...chunk,manifestSha256:p.manifest_sha256,fileId:p.file_id,side,fileSha256:file[side].sha256,chunkSha256:hash(Buffer.from(chunk.dataBase64,'base64')),encoding:'utf8'});}
      case 'ui_get_quota':case 'ui_probe_quota':{
        const alias=p.account_id??f.overview.workers.find(w=>w.workerId===p.worker_id)?.accountAlias;if(!alias)throw new HostError('NOT_FOUND','Mock account not found.');
        const targetAcc=f.overview.accounts.find(a=>a.alias===alias);
        const requestedProbe=method==='ui_probe_quota';const now=Date.now();
        const probeCount=(this.probeCounts.get(alias)??0)+(requestedProbe?1:0);if(requestedProbe)this.probeCounts.set(alias,probeCount);const live=probeCount>0;
        const rawBucket=Array.isArray(targetAcc?.quota?.quota_raw)?(targetAcc!.quota!.quota_raw[0] as Record<string,any>):undefined;
        const bucketName=rawBucket?.show_name||rawBucket?.name||'GLM-5.3-Flash';
        const tokenTotal=typeof rawBucket?.total_units==='number'?rawBucket.total_units:(typeof targetAcc?.quota?.total==='number'?targetAcc.quota.total:500000000);
        const baseUsed=typeof rawBucket?.used_units==='number'?rawBucket.used_units:(typeof targetAcc?.quota?.used==='number'?targetAcc.quota.used:0);
        const usedDelta=(probeCount>0?(probeCount-1)*3:0)%60;const used=Math.min(95,20+usedDelta);const remaining=100-used;
        const tokenDelta=(probeCount>0?(probeCount-1)*15000000:0)%350000000;
        const tokenUsed=Math.min(tokenTotal,baseUsed+tokenDelta);
        const tokenRemaining=Math.max(0,tokenTotal-tokenUsed);
        const tokenPct=Math.round((tokenUsed/tokenTotal)*100);
        const rawReset=rawBucket?.period_end??rawBucket?.expires_at??1793581200;
        const resetsAtMs=rawReset<1e11?rawReset*1000:rawReset;
        const planName=targetAcc?.plan||(Array.isArray(targetAcc?.quota?.subscription_raw)?(targetAcc!.quota!.subscription_raw[0] as any)?.name:undefined)||'ZCODE WEEKEND BUILD';
        return this.envelope({
          accountAlias:alias,
          imported:{
            source:'imported_snapshot',accountAlias:alias,providerId:`account:${targetAcc?.provider??'zai'}-start-plan`,
            observedAtMs:null,storedAtMs:null,tier:'start',tierName:planName,
            windows:[{id:`win-${alias}-imported`,name:bucketName,windowType:'token_pool',total:tokenTotal,used:baseUsed,remaining:Math.max(0,tokenTotal-baseUsed),percentageUsed:Math.round((baseUsed/tokenTotal)*100),unit:'tokens',resetsAtMs,resetsLabel:'1天后重置'}],
            generatedAt:{value:1793491000,unit:'unknown',atMs:null},serverTime:null,nextReset:null,unit:'tokens',total:tokenTotal,used:baseUsed,remaining:Math.max(0,tokenTotal-baseUsed),percentage:{value:100-Math.round((baseUsed/tokenTotal)*100),scale:'0_to_100'},authenticated:null,freshness:'unknown'
          },
          live:live?{
            source:'live_probe',accountAlias:alias,providerId:`account:${targetAcc?.provider??'zai'}-start-plan`,
            observedAtMs:now,storedAtMs:now,tier:'pro',tierName:'GLM Pro Plan',
            windows:[
              {id:'win-5h',name:'5小时周期',windowType:'hourly_window',total:100,used,remaining,percentageUsed:used,unit:'次',resetsAtMs:now+18000000,resetsLabel:'5小时后重置'},
              {id:`win-${alias}-live`,name:bucketName,windowType:'token_pool',total:tokenTotal,used:tokenUsed,remaining:tokenRemaining,percentageUsed:tokenPct,unit:'tokens',resetsAtMs:now+86400000,resetsLabel:'1天后重置'}
            ],
            generatedAt:null,serverTime:null,nextReset:null,unit:'requests',total:100,used,remaining,percentage:{value:remaining,scale:'0_to_100'},authenticated:true,freshness:'fresh'
          }:null,
          lastProbe:{state:live?'succeeded':'never',attemptedAtMs:live?now:null,errorCode:null},
          displayFreshnessWindowMs:120000
        });
      }
      case 'accounts.probeAll':{
        const accounts=f.overview.accounts.filter(a=>a.health==='available');
        for(const a of accounts)this.probeCounts.set(a.alias,(this.probeCounts.get(a.alias)??0)+1);
        return {probed:accounts.length};
      }
      case 'dispatch_task':{
        const prior=Object.values(f.details).find(d=>d.requestId===p.request_id);if(prior)return {task:this.compact(prior),created:false};
        if(this.policy().availableSlots===0)throw new HostError('POOL_CAPACITY_REACHED','并发已满或新任务已暂停；等待现有任务释放占用。');
        const workspace=f.overview.workspaces.find(w=>w.workspaceId===p.workspace_id);const worker=f.overview.workers.find(w=>w.workerId===p.worker_id);if(!workspace||!worker||workspace.activeTaskId)throw new HostError('WORKSPACE_BUSY','Mock resource is held.');
        const detail=structuredClone(f.details['task-approval']!);const taskId=`task-mock-${++this.revision}`;const commandId=p.request_id??'';const sessionId=`mock-session-${this.revision}`;
        Object.assign(detail,{taskId,workspaceId:workspace.workspaceId,workerId:worker.workerId,workspace:structuredClone(workspace),requestId:commandId,status:'running',revision:this.revision,createdAtMs:f.clock+this.revision,updatedAtMs:f.clock+this.revision,leaseHeld:true,executionStopped:false,cancelRequestedAtMs:null,diagnostic:null});
        detail.execution={dispatchAttemptedAtMs:f.clock,currentCommandId:commandId,sessionId,turnId:commandId,stopProof:null,attachment:'attached',finalizing:false};
        detail.attempts=[{index:0,commandId,sessionId,turnId:commandId,intentAtMs:f.clock,acknowledgedAtMs:f.clock,terminalState:null,stopProofKind:null,failureCategory:null,busyRetryEligible:false,continuationBlocked:false}];detail.currentAttemptIndex=0;
        detail.result={available:false,createdAtMs:null,summary:'',summaryTruncated:false,changedFileCount:0,artifactCount:0,verification:[],blockers:[],manifestState:'not_captured'};
        detail.approval={pendingCount:0,responsePending:false,stateKnown:true};detail.controls.cancel.available=true;detail.controls.reconcile.available=false;detail.controls.resume.available=false;
        const modelId=p.model_id??'';
        detail.selection={requestedWorkerId:worker.workerId,requestedSession:p.session??'continue',mode:p.mode??'build',requestedModelId:modelId,binding:{accountAlias:worker.accountAlias,providerId:`account:${f.overview.accounts.find(a=>a.alias===worker.accountAlias)?.provider??'zai'}-start-plan`,modelId}};
        const verifyCommands=p.verify_commands??[];
        detail.verificationPolicy.commands=verifyCommands.map((c:MockVerifyCommand)=>({command:c.command,args:c.args,timeoutMs:c.timeout_ms}));detail.verificationPolicy.defaultDiffCheck=!verifyCommands.length;detail.retry={used:0,max:null,reason:'model_busy'};
        f.details[taskId]=detail;workspace.activeTaskId=taskId;this.responseTicks.set(taskId,0);return {task:this.compact(detail),created:true};
      }
      case 'cancel_task':if(!task)throw new HostError('NOT_FOUND','Task not found.');task.cancelRequestedAtMs=f.clock;task.revision=++this.revision;task.controls.cancel.available=false;return {task:this.compact(task),cancelRequested:true,terminationConfirmed:false};
      case 'reconcile_task':if(!task)throw new HostError('NOT_FOUND','Task not found.');task.execution.attachment='not_attached';task.controls.resume.available=true;task.revision=++this.revision;return {task:this.compact(task),canResume:true,requiresInspection:false};
      case 'resume_task':if(!task)throw new HostError('NOT_FOUND','Task not found.');task.execution.attachment='attached';task.status='running';task.revision=++this.revision;this.responseTicks.set(task.taskId,2);return {task:this.compact(task),attached:true};
      case 'create_workspace':{const item={workspaceId:`workspace-${++this.revision}`,repositoryPath:p.repository??'',worktreePath:`/mock/worktrees/${this.revision}`,branch:`zcode/mock-${this.revision}`,baseCommit:p.base_ref??'HEAD',state:'active',activeTaskId:null};f.overview.workspaces.push(item);return item;}
      case 'start_worker':{const worker={workerId:p.worker_id??'',accountAlias:p.account_id??'',state:'ready',processOwned:true,runningTaskCount:0,version:'3.16.3'};f.overview.workers.push(worker);return worker;}
      case 'stop_worker':{const worker=f.overview.workers.find(w=>w.workerId===p.worker_id);if(worker)worker.state='stopped';return {workerId:p.worker_id,stopped:true};}
      case 'import_accounts':{
        const files=p.files??[];let recordCount=0;let duplicateCount=0;const importedSummaries:any[]=[];
        for(const filePath of files){
          try{
            const content=await readFile(filePath,'utf8');
            const data=JSON.parse(content);
            const list=Array.isArray(data)?data:(Array.isArray(data?.accounts)?data.accounts:[data]);
            for(const a of list){
              if(!a||typeof a!=='object')continue;
              recordCount++;
              const accHash=hash(String(a.email||a.user_id||a.id||JSON.stringify(a))).slice(0,12);
              const alias=a.alias||`account-${accHash}`;
              const email=a.email||a.user_info_raw?.email;
              const name=a.display_name??a.name;
              const provider=a.provider||'zai';
              const health=a.health||'available';
              const subList=Array.isArray(a.subscription_raw)?a.subscription_raw:(Array.isArray(a.quota?.subscription_raw)?a.quota.subscription_raw:[]);
              const plan=a.plan_type||subList[0]?.name||a.plan;
              const quota:Record<string,unknown>={
                total:a.quota_total??a.quota?.total,
                used:a.quota_used??a.quota?.used,
                remaining:a.quota_remaining??a.quota?.remaining,
                quota_raw:a.quota_raw??a.quota?.quota_raw,
                subscription_raw:a.subscription_raw??a.quota?.subscription_raw,
              };
              const accObj={alias,provider,health,...(plan?{plan}:{}),...(email?{email}:{}),...(name?{name}:{}),quota};
              const existingIdx=f.overview.accounts.findIndex(acc=>acc.alias===alias);
              if(existingIdx>=0){duplicateCount++;f.overview.accounts[existingIdx]=accObj;}else{f.overview.accounts.push(accObj);}
              importedSummaries.push({alias,provider,health,...(plan?{plan}:{}),...(email?{email}:{}),...(name?{name}:{})});
            }
          }catch{}
        }
        return {fileCount:files.length,recordCount,duplicateCount,summaries:importedSummaries.length>0?importedSummaries:f.overview.accounts.slice(0,1)};
      }
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
