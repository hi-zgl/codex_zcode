import {randomUUID} from 'node:crypto';
import {uiMethods,UI_LIMITS,uiPermissionReviewSchema,uiIdSchema,type UiMethodName,type UiTaskSummary,type UiTaskDetail,type UiQuota,type UiQuotaSnapshot,type UiApprovalReview,type UiApprovalPreview} from '../shared/ui-contract.js';
import {CoreError,type Task,type PersistedTaskResult} from '../core/types.js';
import type {DurableTaskStore} from '../core/store.js';
import {startPlanProviderId,type AccountSummary} from '../accounts/index.js';
import {record,redact} from '../runtime/zcode-server/events.js';
import type {SessionSnapshot} from '../runtime/types.js';
import {loadManifest,manifestView,publicArtifactFile,readSavedFile} from './artifacts.js';
import {bounded,canonicalJson,digest,UiCursors,UiRpcError} from './ui-support.js';
import {resolveQuotaSnapshot} from './quota-resolver.js';
import type {WorkView, Commander, ErrorStats} from '../shared/work-contract.js';
import type {PoolPolicy} from '../core/types.js';

export interface UiApprovalObservation {snapshot:SessionSnapshot;approvals:Record<string,unknown>[];nativeTurnId:string;sourceComplete:boolean;stablePermissionIds:boolean;unattributedCount:number}
export interface UiBackend {
 attachment(taskId:string):boolean;
 observeApprovals(task:Task):Promise<UiApprovalObservation|null>;
 serialApproval<T>(taskId:string,action:()=>Promise<T>):Promise<T>;
 canAcceptApproval(task:Task):Promise<boolean>;
 sendApproval(task:Task,approvalId:string,optionId:string):Promise<void>;
 accounts():Promise<AccountSummary[]>;
 probeQuota(target:{workerId?:string;accountAlias?:string}):Promise<{accountAlias:string;providerId:string;quota:Record<string,unknown>}>;
 workOverview?(filter:{repositoryPath?:string;workId?:string}):{works:WorkView[];commanders:Commander[];poolPolicy:PoolPolicy};
 errorStats?(filter:{accountAlias?:string;taskId?:string;workId?:string;fromMs?:number;toMs?:number}):ErrorStats;
}
interface StoredReview {descriptor:UiApprovalReview;snapshotKey:string|null}
interface ActionReceipt {taskId:string;approvalId:string;actionId:string;ownerKey:string;decision:string;responseState:'intent_recorded'|'awaiting_native'|'resolved_unattributed'|'unknown';nativeRevisionAtCheck:number;taskRevision:number;intentAtMs:number}
const FINAL=new Set(['succeeded','failed','cancelled']);
const FRESH=120_000;
const nativePermissionId=/^perm_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function stateOfManifest(result:PersistedTaskResult|null):UiTaskDetail['result']['manifestState']{return result?.artifacts.some(a=>a.kind==='file_manifest')?'available':result?.artifacts.some(a=>a.kind==='patch')?'legacy_patch_only':'not_captured';}

/** UI-specific projections; legacy CLI/MCP methods and their output whitelist are unchanged. */
export class UiService {
 readonly instanceId=randomUUID();
 readonly cursors:UiCursors;
 private readonly live=new Map<string,{snapshot:UiQuotaSnapshot|null;lastProbe:UiQuota['lastProbe']}>();
 constructor(readonly root:string,readonly store:DurableTaskStore,readonly backend:UiBackend){this.cursors=new UiCursors(store.storeId,this.instanceId);store.markUiApprovalActionsUnknown();}
 /** Called before the legacy safeDetail/log projection can discard decision bytes. */
 captureApprovals(task:Task,observation:UiApprovalObservation):void {
  this.noteObservedApprovalSet(task,observation.approvals,observation.nativeTurnId);
  for(const approval of observation.approvals){const id=approval.interactionId??approval.approvalId??approval.id;if(uiIdSchema.safeParse(id).success)this.fixReview(task,observation,id as string);}
 }
 /** Native disappearance proves resolution, never which client's decision was adopted. */
 noteObservedApprovalSet(task:Task,approvals:Record<string,unknown>[],nativeTurnId:string):void {
  if(this.store.getTask(task.taskId).currentCommandId!==task.currentCommandId)return;
  const ids=new Set(approvals.map(a=>a.interactionId??a.approvalId??a.id));
  for(const a of this.store.listUiApprovalActions<ActionReceipt>(task.taskId))if(['intent_recorded','awaiting_native','unknown'].includes(a.responseState)&&!ids.has(a.approvalId)&&a.ownerKey===digest(canonicalJson({taskId:task.taskId,approvalId:a.approvalId,owner:{attemptIndex:this.store.getCurrentAttempt(task.taskId)?.index??0,commandId:task.currentCommandId,sessionId:task.sessionId,nativeTurnId}})))this.store.updateUiApprovalAction(a.actionId,{...a,responseState:'resolved_unattributed'});
 }
 private envelope(data:unknown){return {meta:{apiVersion:1,instanceId:this.instanceId,storeId:this.store.storeId,servedAtMs:Date.now()},data};}
 async call(method:string,input:Record<string,unknown>):Promise<unknown>{
  if(!Object.hasOwn(uiMethods,method))throw new UiRpcError('UNKNOWN_METHOD');
  const name=method as UiMethodName;
  try{
   let inputJson:string;try{inputJson=canonicalJson(input);}catch{throw new UiRpcError('INVALID_ARGUMENT');}
   if(Buffer.byteLength(inputJson)+Buffer.byteLength(method)+1024>UI_LIMITS.requestBytes)throw new UiRpcError('INVALID_ARGUMENT');
   const parsed=uiMethods[name].params.safeParse(input);if(!parsed.success)throw new UiRpcError('INVALID_ARGUMENT');
   const action=()=>this.handle(name,parsed.data);
   const raw=name==='ui_respond_approval'?await this.backend.serialApproval((parsed.data as {task_id:string}).task_id,action):await action();
   const validated=uiMethods[name].result.safeParse(raw);if(!validated.success)throw new UiRpcError('UNSUPPORTED_SCHEMA');
   if(Buffer.byteLength(JSON.stringify(validated.data))+1024>UI_LIMITS.responseBytes)throw new UiRpcError('OUTPUT_BUDGET_EXCEEDED',{outcome:name==='ui_respond_approval'||name==='ui_probe_quota'?'may_have_applied':'read_only'});
   return validated.data;
  }catch(e){
   if(e instanceof UiRpcError){if(name==='ui_respond_approval'&&e.data?.outcome==='read_only')throw new UiRpcError(e.data.kind,{...e.data,outcome:'not_started'});throw e;}
   if(e instanceof CoreError){const kind=({TASK_NOT_FOUND:'NOT_FOUND',WORKSPACE_NOT_FOUND:'NOT_FOUND',ACTION_CONFLICT:'ACTION_CONFLICT',APPROVAL_RESPONSE_PENDING:'APPROVAL_RESPONSE_PENDING',IDEMPOTENCY_CONFLICT:'REQUEST_CONFLICT',WORKSPACE_BUSY:'WORKSPACE_BUSY',WORKER_BUSY:'WORKER_BUSY'} as const)[e.code as 'TASK_NOT_FOUND'];if(kind)throw new UiRpcError(kind,{outcome:name==='ui_respond_approval'?'not_started':'read_only'});}
   throw new UiRpcError('INTERNAL_ERROR',{outcome:name==='ui_respond_approval'?'may_have_applied':'read_only'});
  }
 }
 private summary(task:Task,observedActions?:ActionReceipt[]):UiTaskSummary{
  const detail=record(task.detail),policy=record(task.executionPolicy);const actions=observedActions??this.store.listUiApprovalActions<ActionReceipt>(task.taskId);
  return {taskId:task.taskId,workspaceId:task.workspaceId,workerId:task.workerId,status:task.status,revision:task.revision,createdAtMs:task.createdAt,updatedAtMs:task.updatedAt,
   leaseHeld:task.leaseHeld,executionStopped:task.executionStopped,cancelRequestedAtMs:task.cancelRequestedAt,
   approval:{pendingCount:Number.isSafeInteger(detail.pendingApprovalCount)&&detail.pendingApprovalCount>=0?detail.pendingApprovalCount:task.executionStopped?0:null,
    responsePending:detail.approvalResponsePending===true||actions.some(a=>['intent_recorded','awaiting_native','unknown'].includes(a.responseState)),stateKnown:task.executionStopped||this.backend.attachment(task.taskId)&&Number.isSafeInteger(detail.pendingApprovalCount)},
   retry:{used:task.busyRetryCount,max:null,reason:'model_busy'}};
 }
 private detail(task:Task):UiTaskDetail{
  const ws=this.store.getWorkspace(task.workspaceId),result=this.store.getResult(task.taskId),policy=record(task.executionPolicy),binding=record(task.runtimeBinding);
  const commands=policy.verifyCommands??[];const shape=Array.isArray(commands)&&commands.length<=10&&commands.every(c=>c&&typeof c.command==='string'&&c.command&&Array.isArray(c.args)&&c.args.every((a:unknown)=>typeof a==='string')&&Number.isSafeInteger(c.timeout_ms)&&c.timeout_ms>=100&&c.timeout_ms<=300000);
  const complete=shape&&Buffer.byteLength(JSON.stringify(commands))<=32768&&canonicalJson(redact(commands))===canonicalJson(commands);
  const summary=bounded(String(redact(result?.summary??'')),8192);const attempts=this.store.listAttempts(task.taskId);
  const controls=(available:boolean,reason:string,effects:string[])=>({available,reason:available?null:reason,effects});
  const canRecover=task.leaseHeld&&!FINAL.has(task.status);const hasPolicy=complete&&!this.store.hasEnteredVerification(task.taskId);
  return {...this.summary(task),requestId:task.requestId,workspace:{workspaceId:ws.workspaceId,repositoryPath:ws.repositoryPath,worktreePath:ws.worktreePath,branch:ws.branch,baseCommit:ws.baseCommit,state:ws.state},
   execution:{dispatchAttemptedAtMs:task.dispatchAttemptedAt,currentCommandId:task.currentCommandId,sessionId:task.sessionId,turnId:task.turnId,
    stopProof:task.stopProof?{kind:task.stopProof.kind,observedAtMs:task.stopProof.observedAt??null,evidenceSummary:bounded(String(redact(task.stopProof.evidence)),512).text}:null,
    attachment:this.backend.attachment(task.taskId)?'attached':task.executionStopped?'not_attached':'unknown',finalizing:task.status==='verifying'},
   selection:{requestedWorkerId:task.requestedWorkerId,requestedSession:task.session,mode:['build','edit','plan','yolo','guarded'].includes(policy.mode)?policy.mode:'build',requestedModelId:typeof policy.modelId==='string'?policy.modelId:'GLM-5.3-Flash',
    binding:typeof binding.accountAlias==='string'&&typeof binding.providerId==='string'&&typeof binding.modelId==='string'?{accountAlias:binding.accountAlias,providerId:binding.providerId,modelId:binding.modelId}:null},
   verificationPolicy:{complete,defaultDiffCheck:shape&&commands.length===0,commands:complete?commands.map(c=>({command:c.command,args:c.args,timeoutMs:c.timeout_ms})):[],unavailableReason:complete?null:'verification_policy_not_safely_presentable'},
   attempts:attempts.slice(-25).map(a=>({index:a.index,commandId:a.commandId,sessionId:a.sessionId,turnId:a.turnId,intentAtMs:a.intentAt,acknowledgedAtMs:a.acknowledgedAt,terminalState:a.terminalState,stopProofKind:a.stopProof?.kind??null,failureCategory:a.failureCategory,busyRetryEligible:a.busyRetryEligible,continuationBlocked:a.continuationBlocked})),attemptCount:attempts.length,currentAttemptIndex:attempts.at(-1)?.index??null,
   controls:{cancel:controls(canRecover&&!task.executionStopped&&task.cancelRequestedAt===null,'task_stopped_cancel_pending_or_final',['persist_cancel_intent','request_native_stop','retain_lease_until_stop_proof']),
    reconcile:controls(canRecover&&!this.backend.attachment(task.taskId),'already_attached_or_no_lease',['observe_native_execution','update_task_records','may_release_proved_stopped_lease']),
    resume:controls(canRecover&&!this.backend.attachment(task.taskId)&&hasPolicy,'policy_incomplete_verification_interrupted_or_already_attached',['reattach_current_command','may_run_existing_verification','may_continue_eligible_model_busy_attempt'])},
   result:{available:!!result,createdAtMs:result?.createdAt??null,summary:summary.text,summaryTruncated:summary.truncated,changedFileCount:result?.changedFiles.length??0,artifactCount:result?.artifacts.length??0,
    verification:result?.verification.map(v=>{const s=bounded(String(redact(v.summary??'')),2048);return {commandDisplay:String(redact(v.command)),exitCode:v.exitCode,summary:s.text,summaryTruncated:s.truncated};})??[],blockers:(result?.blockers??[]).map(b=>String(redact(b))),manifestState:stateOfManifest(result)},
   diagnostic:record(task.detail).requiresInspection===true?{code:'RECOVERY_REQUIRED',message:'Execution needs inspection; occupancy is retained until stop is proved.'}:null};
 }
 private async quota(accountAlias:string):Promise<UiQuota>{
  const account=(await this.backend.accounts()).find(a=>a.alias===accountAlias);if(!account)throw new UiRpcError('NOT_FOUND');
  const q=account.quota;const cache=this.live.get(accountAlias);const now=Date.now();let live=cache?.snapshot??null;
  if(live){
   const freshness=cache?.lastProbe.state==='failed'?'stale':(live.observedAtMs===null||now<live.observedAtMs?'unknown':now-live.observedAtMs<=FRESH?'fresh':'stale');
   live={...live,freshness};
  }
  const rawQuota:Record<string,unknown>={...(q?{...q}:{}),quota_raw:account.quotaRaw,subscription_raw:account.subscriptionRaw,plan_type:account.plan};
  const hasImported=!!(q||account.quotaRaw!==undefined||account.subscriptionRaw!==undefined||account.plan);
  const imported:UiQuotaSnapshot|null=hasImported?resolveQuotaSnapshot({source:'imported_snapshot',accountAlias,providerId:startPlanProviderId(account.provider),observedAtMs:null,storedAtMs:null,rawQuota,authenticated:null,freshness:'unknown'}):null;
  return {accountAlias,imported,live,lastProbe:cache?.lastProbe??{state:'never',attemptedAtMs:null,errorCode:null},displayFreshnessWindowMs:FRESH};
 }
 private actionFor(taskId:string,approvalId:string,owner:UiApprovalReview['owner']):ActionReceipt|undefined{
  const key=digest(canonicalJson({taskId,approvalId,owner}));return this.store.listUiApprovalActions<ActionReceipt>(taskId).find(a=>a.ownerKey===key);
 }
 private fallbackReview(task:Task,approvalId:string,state:'unknown'|'gone'):UiApprovalReview{
  const previous=this.store.listUiRecords<StoredReview>('approval_review',task.taskId).filter(r=>r.descriptor.approvalId===approvalId).sort((a,b)=>b.descriptor.observedAtMs-a.descriptor.observedAtMs)[0]?.descriptor;
  const owner=previous?.owner??{attemptIndex:this.store.getCurrentAttempt(task.taskId)?.index??0,commandId:task.currentCommandId,sessionId:task.sessionId??'unavailable',nativeTurnId:'unavailable'};
  const action=this.actionFor(task.taskId,approvalId,owner);
  return {taskId:task.taskId,approvalId,reviewId:previous?.reviewId??randomUUID(),owner,state,approvalRevision:previous?.approvalRevision??digest(canonicalJson({owner,approvalId,state})),nativeRevision:previous?.nativeRevision??0,observedAtMs:Date.now(),expiresAtMs:Date.now(),content:null,redactions:[],decisions:[],readOnlyReason:state==='gone'?'approval_no_longer_pending':'safe_native_source_unavailable',
   response:{actionId:action?.actionId??null,decision:action?.decision??null,state:action?.responseState??'none'}};
 }
 private fixReview(task:Task,observation:UiApprovalObservation,approvalId:string):UiApprovalReview{
  const source=observation.approvals.find(a=>(a.interactionId??a.approvalId??a.id)===approvalId);if(!source)return this.fallbackReview(task,approvalId,'gone');
  const owner={attemptIndex:this.store.getCurrentAttempt(task.taskId)?.index??0,commandId:task.currentCommandId,sessionId:task.sessionId!,nativeTurnId:observation.nativeTurnId};
  const action=this.actionFor(task.taskId,approvalId,owner);let reason:string|null=null,content:string|null=null;const redactions:UiApprovalReview['redactions']=[];
  try{
   const document={schema:'permission-review/1',taskId:task.taskId,approvalId,owner,workspacePath:this.store.getWorkspace(task.workspaceId).worktreePath,interaction:source};
   const original=canonicalJson(document);
   if(Buffer.byteLength(original)>UI_LIMITS.approvalSnapshotBytes)reason='approval_snapshot_too_large';
   else if(!observation.sourceComplete)reason='source_incomplete';
   else if(!uiPermissionReviewSchema.safeParse(document).success)reason='unsupported_permission_schema';
   else if(canonicalJson(redact(document))!==original){reason='decision_relevant_redaction';redactions.push({category:'credential_or_sensitive_decision_content',decisionRelevant:true});}
   else content=original;
  }catch{reason='unsupported_permission_schema';}
  const options=record(record(source).payload).options;
  const allow=Array.isArray(options)?options.filter(o=>o.kind==='allowOnce'):[];const deny=Array.isArray(options)?options.filter(o=>o.kind==='deny'):[];
  const safeResponse=(o:any,decision:string)=>o&&uiIdSchema.safeParse(o.optionId).success&&record(o.response).decision===decision&&Object.keys(record(o.response)).every(k=>['decision','reason'].includes(k));
  if(content&&(!observation.stablePermissionIds||!nativePermissionId.test(approvalId)))reason='native_interaction_stability_unverified';
  if(content&&(allow.length!==1||deny.length!==1||!safeResponse(allow[0],'allow')||!safeResponse(deny[0],'deny')||new Set(options.map((o:any)=>o.optionId)).size!==options.length))reason='unsupported_option_mapping';
  const sha256=content===null?null:digest(content);const revision=digest(canonicalJson({taskId:task.taskId,approvalId,owner,sha256,nativeRevision:observation.snapshot.revision,response:action?.responseState??'none'}));
  const old=this.store.listUiRecords<StoredReview>('approval_review',task.taskId).map(v=>v.descriptor).find(v=>v.approvalId===approvalId&&v.approvalRevision===revision&&v.expiresAtMs>Date.now());if(old)return old;
  const now=Date.now();const descriptor:UiApprovalReview={taskId:task.taskId,approvalId,reviewId:randomUUID(),owner,state:action?'response_pending':'pending',approvalRevision:revision,nativeRevision:observation.snapshot.revision,observedAtMs:now,expiresAtMs:now+300000,
   content:content!==null?{mediaType:'application/json',encoding:'utf8',totalBytes:Buffer.byteLength(content),sha256:sha256!,schema:'permission-review/1',sourceComplete:true}:null,redactions,
   decisions:!reason&&!action?[{decision:'accept',label:'Allow once',nativeOptionId:allow[0].optionId},{decision:'decline',label:'Deny',nativeOptionId:deny[0].optionId}]:[],readOnlyReason:action?'approval_response_already_recorded':reason,
   response:{actionId:action?.actionId??null,decision:action?.decision??null,state:action?.responseState??'none'}};
  if(content!==null)this.store.putUiImmutableRecord('approval_snapshot',sha256!,task.taskId,{taskId:task.taskId,owner,approvalId,content});
  this.store.putUiImmutableRecord('approval_review',descriptor.reviewId,task.taskId,{descriptor,snapshotKey:sha256} satisfies StoredReview);return descriptor;
 }
 private async observe(task:Task):Promise<UiApprovalObservation|null>{
  try{
   const o=await this.backend.observeApprovals(task);if(!o)return null;
   if(!Number.isSafeInteger(o.snapshot.revision)||o.snapshot.revision<0||!uiIdSchema.safeParse(o.nativeTurnId).success)throw new UiRpcError('UNSUPPORTED_SCHEMA');
   this.noteObservedApprovalSet(task,o.approvals,o.nativeTurnId);
   return o;
  }catch(e){if(e instanceof UiRpcError)throw e;throw new UiRpcError('NATIVE_UNAVAILABLE');}
 }
 private async currentReview(task:Task,approvalId:string){const o=await this.observe(task);return {observation:o,review:o?this.fixReview(task,o,approvalId):this.fallbackReview(task,approvalId,'unknown')};}
 private receipt(a:ActionReceipt){return {taskId:a.taskId,approvalId:a.approvalId,actionId:a.actionId,responseState:a.responseState==='intent_recorded'?'unknown':a.responseState,nativeRevisionAtCheck:a.nativeRevisionAtCheck,taskRevision:a.taskRevision};}
 private async handle(name:UiMethodName,p:any):Promise<unknown>{
  if(name==='ui_capabilities'){
   if(!p.supportedApiMajors.includes(1))throw new UiRpcError('INCOMPATIBLE_API',{outcome:'not_started'});
   return {selectedApiVersion:{major:1,minor:0},daemonVersion:'0.1.0',instanceId:this.instanceId,storeId:this.store.storeId,servedAtMs:Date.now(),
    capabilities:{...Object.fromEntries(['taskDetail','taskLookupByRequest','taskList','quotaSnapshots','quotaProbe','approvalRead','approvalRespondFingerprint','artifactSnapshots','dispatchTask','createWorkspace','importAccounts','startWorker','stopWorker','reconcileTask','resumeTask','cancelTask','poolPolicy','poolLifecycle'].map(k=>[k,{version:1}])),workOverview:{version:this.backend.workOverview?1:0},errorStats:{version:this.backend.errorStats?1:0},workTodos:{version:this.backend.workOverview?1:0},commanderQuota:{version:this.backend.workOverview?1:0},accountEnabled:{version:this.backend.workOverview?1:0}},limits:UI_LIMITS,runtime:{platform:process.platform,supportedOfficialVersions:['3.16.3']}};
  }
  if(name==='ui_get_work_overview'){
   if(!this.backend.workOverview)throw new UiRpcError('CAPABILITY_UNAVAILABLE');
   const overview=this.backend.workOverview({repositoryPath:p.repository_path,workId:p.work_id});
   const all=overview.works.sort((a,b)=>b.updatedAt-a.updatedAt);const works=all.slice(0,p.limit);
   const accountErrors=this.backend.errorStats?Object.fromEntries((await this.backend.accounts()).map(account=>{const {total,categories,complete,incompleteTaskCount}=this.backend.errorStats!({accountAlias:account.alias});return [account.alias,{total,categories,complete,incompleteTaskCount}];})):{};
   const data={...overview,works,total:all.length,observedAtMs:Date.now(),truncated:works.length<all.length,accountErrors};
   while(data.works.length>1&&Buffer.byteLength(JSON.stringify(data))>UI_LIMITS.responseBytes-2048){data.works.pop();data.truncated=true;}
   return this.envelope(data);
  }
  if(name==='ui_get_error_stats'){
   if(!this.backend.errorStats)throw new UiRpcError('CAPABILITY_UNAVAILABLE');
   if(p.from_ms!==undefined&&p.to_ms!==undefined&&p.from_ms>p.to_ms)throw new UiRpcError('INVALID_ARGUMENT');
   return this.envelope(this.backend.errorStats({accountAlias:p.account_alias,taskId:p.task_id,workId:p.work_id,fromMs:p.from_ms,toMs:p.to_ms}));
  }
  if(name==='ui_get_task_detail'){
   return this.envelope(this.store.readSnapshot(()=>{const task=p.task_id?this.store.getTask(p.task_id):this.store.findTaskByRequestId(p.request_id);if(!task)throw new UiRpcError('NOT_FOUND');return this.detail(task);}));
  }
  if(name==='ui_list_tasks'){
   const filter={...(p.filter??{}),...(p.filter?.statuses?{statuses:[...new Set(p.filter.statuses)].sort()}:{}),...(p.filter?.query!==undefined?{query:p.filter.query.toLowerCase()}: {})};
   const binding={filter,sort:p.sort,limit:p.limit};const c=p.cursor?this.cursors.decode(p.cursor,name,binding):null;const snapshot=this.store.readTaskListSnapshot();
   if(c&&c.revision!==snapshot.revision)throw new UiRpcError('CURSOR_STALE');
   const workspaces=new Map(snapshot.workspaces.map(w=>[w.workspaceId,w]));
   const matching=snapshot.tasks.filter(t=>{const w=workspaces.get(t.workspaceId)!;return (filter.repository_path===undefined||w.repositoryPath===filter.repository_path)&&(filter.workspace_id===undefined||t.workspaceId===filter.workspace_id)&&(filter.worker_id===undefined||t.workerId===filter.worker_id)&&(filter.statuses===undefined||filter.statuses.includes(t.status))&&(filter.lease_held===undefined||t.leaseHeld===filter.lease_held)&&(filter.query===undefined||[t.taskId,t.workspaceId,t.workerId??'',w.repositoryPath,w.branch].some(s=>s.toLowerCase().includes(filter.query)));}).sort((a,b)=>b.createdAt-a.createdAt||(a.taskId<b.taskId?-1:a.taskId>b.taskId?1:0));
   const key=c?.key as {createdAtMs:number;taskId:string}|undefined;
   if(key&&(!Number.isSafeInteger(key.createdAtMs)||!uiIdSchema.safeParse(key.taskId).success))throw new UiRpcError('CURSOR_INVALID');
   const remaining=key?matching.filter(t=>t.createdAt<key.createdAtMs||t.createdAt===key.createdAtMs&&t.taskId>key.taskId):matching;
   const page=remaining.slice(0,p.limit),last=page.at(-1);
   return this.envelope({items:page.map(t=>this.summary(t,(snapshot.approvalActions[t.taskId]??[]) as unknown as ActionReceipt[])),total:matching.length,nextCursor:remaining.length>page.length&&last?this.cursors.encode(name,binding,{createdAtMs:last.createdAt,taskId:last.taskId},60000,snapshot.revision):null,listRevision:snapshot.revision,observedAtMs:Date.now(),scope:'all_matching_tasks'});
  }
  if(name==='ui_get_quota')return this.envelope(await this.quota(p.account_id));
  if(name==='ui_probe_quota'){
   const attempted=Date.now();let accountAlias:string|undefined=p.account_id;
   try{
    const target=p.worker_id?{workerId:p.worker_id}:{accountAlias:p.account_id};
    const result=await this.backend.probeQuota(target);
    accountAlias=result.accountAlias;
    const q=result.quota;
    if(record(q.provider).id&&record(q.provider).id!==result.providerId)throw new UiRpcError('AUTH_INVALID');
    const observed=Date.now();
    const snapshot=resolveQuotaSnapshot({source:'live_probe',accountAlias,providerId:result.providerId,observedAtMs:observed,storedAtMs:observed,rawQuota:q,authenticated:typeof q.authenticated==='boolean'?q.authenticated:null,freshness:'fresh'});
    this.live.set(accountAlias,{snapshot,lastProbe:{state:'succeeded',attemptedAtMs:attempted,errorCode:null}});
    return this.envelope(await this.quota(accountAlias));
   }catch(e){
    const alias=accountAlias??(e as {accountAlias?:string}).accountAlias??p.account_id;
    if(alias){
     const previous=this.live.get(alias);
     let staleSnapshot:UiQuotaSnapshot|null=previous?.snapshot?{...previous.snapshot,freshness:'stale'}:null;
     if(!staleSnapshot){
      try{
       const acc=(await this.backend.accounts()).find(a=>a.alias===alias);
       if(acc){
        const hasImported=!!(acc.quota||acc.quotaRaw!==undefined||acc.subscriptionRaw!==undefined||acc.plan);
        if(hasImported){
         staleSnapshot=resolveQuotaSnapshot({source:'imported_snapshot',accountAlias:alias,providerId:startPlanProviderId(acc.provider),observedAtMs:null,storedAtMs:null,rawQuota:{...(acc.quota?{...acc.quota}:{}),quota_raw:acc.quotaRaw,subscription_raw:acc.subscriptionRaw,plan_type:acc.plan},authenticated:null,freshness:'stale'});
        }
       }
      }catch{}
     }
     this.live.set(alias,{snapshot:staleSnapshot,lastProbe:{state:'failed',attemptedAtMs:attempted,errorCode:e instanceof UiRpcError?e.data?.kind??'NATIVE_UNAVAILABLE':'NATIVE_UNAVAILABLE'}});
    }
    throw e instanceof UiRpcError?e:new UiRpcError('NATIVE_UNAVAILABLE',{outcome:'may_have_applied'});
   }
  }
  const task=this.store.getTask(p.task_id);
  if(name==='ui_get_artifact_manifest'){const result=this.store.getResult(task.taskId);return this.envelope(manifestView(task.taskId,this.store.getWorkspace(task.workspaceId).baseCommit,result,await loadManifest(this.root,task.taskId,result)));}
  if(name==='ui_list_artifact_files'||name==='ui_read_artifact_file'){
   const result=this.store.getResult(task.taskId);const loaded=await loadManifest(this.root,task.taskId,result);
   if(!loaded)throw new UiRpcError('ARTIFACT_UNAVAILABLE');if(loaded.sha256!==p.manifest_sha256)throw new UiRpcError(p.cursor?'CURSOR_STALE':'ARTIFACT_UNAVAILABLE');
   const {document,sha256}=loaded;
   if(name==='ui_list_artifact_files'){
    const binding={taskId:task.taskId,manifest:sha256,limit:p.limit};const c=p.cursor?this.cursors.decode(p.cursor,name,binding):null;
    let offset=0;if(c){offset=document.files.findIndex(f=>f.fileId===c.key)+1;if(offset===0)throw new UiRpcError('CURSOR_INVALID');}
    const files=document.files.slice(offset,offset+p.limit),last=files.at(-1);
    return this.envelope({items:files.map(publicArtifactFile),total:document.files.length,nextCursor:offset+files.length<document.files.length&&last?this.cursors.encode(name,binding,last.fileId,600000):null,manifestSha256:sha256});
   }
   const file=document.files.find(f=>f.fileId===p.file_id);if(!file)throw new UiRpcError('ARTIFACT_UNAVAILABLE');const data=await readSavedFile(this.root,task.taskId,file,p.side);if(p.offset_bytes>data.length)throw new UiRpcError('INVALID_ARGUMENT');const chunk=data.subarray(p.offset_bytes,p.offset_bytes+p.limit_bytes);
   return this.envelope({manifestSha256:sha256,fileId:file.fileId,side:p.side,offsetBytes:p.offset_bytes,dataBase64:chunk.toString('base64'),byteLength:chunk.length,nextOffsetBytes:p.offset_bytes+chunk.length<data.length?p.offset_bytes+chunk.length:null,totalBytes:data.length,fileSha256:file[p.side as 'base'|'final'].sha256,chunkSha256:digest(chunk),encoding:file[p.side as 'base'|'final'].encoding});
  }
  if(name==='ui_list_approvals'){
   const observation=await this.observe(task);let reviews:UiApprovalReview[]=[];
   if(observation){const ids=observation.approvals.map(a=>a.interactionId??a.approvalId??a.id).filter((id):id is string=>uiIdSchema.safeParse(id).success);if(ids.length!==observation.approvals.length||new Set(ids).size!==ids.length)throw new UiRpcError('UNSUPPORTED_SCHEMA');reviews=ids.sort().map(id=>this.fixReview(task,observation,id));}
   else{const ids=[...new Set(this.store.listUiRecords<StoredReview>('approval_review',task.taskId).map(r=>r.descriptor.approvalId))];reviews=ids.sort().map(id=>this.fallbackReview(task,id,'unknown'));}
   const revision=digest(canonicalJson({commandId:task.currentCommandId,nativeRevision:observation?.snapshot.revision??null,items:reviews.map(r=>({approvalId:r.approvalId,revision:r.approvalRevision,state:r.state}))}));const binding={taskId:task.taskId,commandId:task.currentCommandId,limit:p.limit};const c=p.cursor?this.cursors.decode(p.cursor,name,binding):null;if(c&&c.revision!==revision)throw new UiRpcError('CURSOR_STALE');
   const remaining=c?reviews.filter(r=>r.approvalId>(c.key as string)):reviews,page=remaining.slice(0,p.limit);const last=page.at(-1);
   const items:UiApprovalPreview[]=page.map(r=>{const source=observation?.approvals.find(a=>(a.interactionId??a.approvalId??a.id)===r.approvalId);const payload=record(source?.payload),summary=bounded(String(redact(payload.summary??'')),384);return {approvalId:r.approvalId,kind:bounded(source?.kind??'unknown',80).text,toolName:typeof payload.toolName==='string'?bounded(payload.toolName,100).text:null,summary:summary.text,truncated:summary.truncated,sourceComplete:r.content?.sourceComplete??false,responseState:r.response.state,readOnlyReason:r.readOnlyReason};});
   return this.envelope({items,total:observation?reviews.length:null,nextCursor:remaining.length>page.length&&last?this.cursors.encode(name,binding,last.approvalId,60000,revision):null,approvalSetRevision:revision,stateKnown:!!observation,unattributedCount:observation?.unattributedCount??0});
  }
  if(name==='ui_get_approval')return this.envelope((await this.currentReview(task,p.approval_id)).review);
  if(name==='ui_read_approval'){
   const saved=this.store.getUiRecord<StoredReview>('approval_review',p.review_id);if(!saved||saved.descriptor.taskId!==task.taskId||saved.descriptor.approvalId!==p.approval_id)throw new UiRpcError('APPROVAL_CHANGED');
   const current=(await this.currentReview(task,p.approval_id)).review;if(current.state==='gone')throw new UiRpcError('APPROVAL_GONE');if(current.state!=='pending'||current.approvalRevision!==saved.descriptor.approvalRevision||saved.descriptor.expiresAtMs<Date.now())throw new UiRpcError('APPROVAL_CHANGED');
   if(!saved.snapshotKey||!saved.descriptor.content)throw new UiRpcError('APPROVAL_READ_ONLY');const snapshot=this.store.getUiRecord<{taskId:string;approvalId:string;content:string}>('approval_snapshot',saved.snapshotKey);
   if(!snapshot||snapshot.taskId!==task.taskId||snapshot.approvalId!==p.approval_id||digest(snapshot.content)!==saved.descriptor.content.sha256)throw new UiRpcError('INTEGRITY_MISMATCH');const data=Buffer.from(snapshot.content);if(p.offset_bytes>data.length)throw new UiRpcError('INVALID_ARGUMENT');const chunk=data.subarray(p.offset_bytes,p.offset_bytes+p.limit_bytes);
   return this.envelope({reviewId:p.review_id,offsetBytes:p.offset_bytes,dataBase64:chunk.toString('base64'),byteLength:chunk.length,nextOffsetBytes:p.offset_bytes+chunk.length<data.length?p.offset_bytes+chunk.length:null,totalBytes:data.length,contentSha256:digest(data)});
  }
  if(name==='ui_respond_approval'){
   const fingerprint=digest(canonicalJson(p));const existing=this.store.getUiApprovalAction<ActionReceipt>(p.action_id);if(existing){if(existing.fingerprint!==fingerprint)throw new UiRpcError('ACTION_CONFLICT',{outcome:'not_started'});return this.envelope(this.receipt(existing.payload));}
   const saved=this.store.getUiRecord<StoredReview>('approval_review',p.review_id);if(!saved||saved.descriptor.taskId!==task.taskId||saved.descriptor.approvalId!==p.approval_id||saved.descriptor.expiresAtMs<Date.now())throw new UiRpcError('APPROVAL_CHANGED',{outcome:'not_started'});
   const {review}=await this.currentReview(task,p.approval_id);if(review.state==='gone')throw new UiRpcError('APPROVAL_GONE',{outcome:'not_started'});if(review.response.state!=='none')throw new UiRpcError('APPROVAL_RESPONSE_PENDING',{outcome:'not_started'});
   if(review.approvalRevision!==p.expected_approval_revision||review.nativeRevision!==p.expected_native_revision||review.content?.sha256!==p.expected_content_sha256||review.approvalRevision!==saved.descriptor.approvalRevision)throw new UiRpcError('APPROVAL_CHANGED',{outcome:'not_started'});
   const option=review.decisions.find(d=>d.decision===p.decision);if(!option||!review.content?.sourceComplete||review.readOnlyReason)throw new UiRpcError('APPROVAL_READ_ONLY',{outcome:'not_started'});
   if(p.decision==='accept'&&(task.status==='blocked'||task.cancelRequestedAt!==null||!await this.backend.canAcceptApproval(task)))throw new UiRpcError('RISK_BLOCKED',{outcome:'not_started'});
   const latest=this.store.getTask(task.taskId);if(latest.currentCommandId!==review.owner.commandId||latest.sessionId!==review.owner.sessionId||latest.executionStopped||!latest.leaseHeld||p.decision==='accept'&&(latest.cancelRequestedAt!==null||latest.status==='blocked'))throw new UiRpcError('APPROVAL_CHANGED',{outcome:'not_started'});
   const ownerKey=digest(canonicalJson({taskId:task.taskId,approvalId:p.approval_id,owner:review.owner}));let receipt:ActionReceipt={taskId:task.taskId,approvalId:p.approval_id,actionId:p.action_id,ownerKey,decision:p.decision,responseState:'intent_recorded',nativeRevisionAtCheck:review.nativeRevision,taskRevision:latest.revision,intentAtMs:Date.now()};
   this.store.recordUiApprovalIntent(p.action_id,ownerKey,task.taskId,fingerprint,receipt);
   try{await this.backend.sendApproval(latest,p.approval_id,option.nativeOptionId);this.store.appendEvent(task.taskId,'ui_approval_response_sent',{approvalId:p.approval_id,actionId:p.action_id,decision:p.decision});receipt={...receipt,responseState:'awaiting_native',taskRevision:this.store.getTask(task.taskId).revision};this.store.updateUiApprovalAction(p.action_id,receipt);receipt=this.store.getUiApprovalAction<ActionReceipt>(p.action_id)!.payload;}
   catch{receipt={...receipt,responseState:'unknown',taskRevision:this.store.getTask(task.taskId).revision};this.store.updateUiApprovalAction(p.action_id,receipt);throw new UiRpcError('OUTCOME_UNKNOWN',{outcome:'may_have_applied',taskId:task.taskId,approvalId:p.approval_id,actionId:p.action_id});}
   return this.envelope(this.receipt(receipt));
  }
  throw new UiRpcError('UNKNOWN_METHOD');
 }
}
