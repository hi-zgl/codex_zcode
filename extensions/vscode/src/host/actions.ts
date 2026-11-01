import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { uiPermissionReviewSchema, type UiMethodName, type UiRpcParams, type UiRpcResult, type UiApprovalReview, type UiTaskDetail, type UiArtifactFile } from '../../../../src/shared/ui-contract.js';
import { TypedClient, HostError, safeError, type Transport } from './client.js';
import { PollCoordinator } from './polling.js';
import { resolvePreferredRepositoryId, type ProjectContext } from './project-context.js';
import type { RouterTarget } from './router.js';
import type { WebviewRequest, RequestPayload } from './protocol.js';
import type { UiSnapshot, TaskDraft, UiActionState } from './types.js';

export interface NativeAdapter {
  trusted(): boolean;
  getState<T>(key: string, fallback: T): T;
  setState(key: string, value: unknown): Promise<void>;
  pickAccountFiles(host: string): Promise<string[] | undefined>;
  pickRepository(host: string): Promise<string | undefined>;
  openDiff(taskId: string, manifestSha256: string, file: UiArtifactFile, read: (side: 'base'|'final') => Promise<string>): Promise<void>;
  openCurrentFile?(worktreePath:string,relativePath:string):Promise<void>;
  openSettings(): Promise<void>;
  configureConnection?(): Promise<void>;
  startDaemon?(): Promise<void>;
  saveInterval(value: number): Promise<void>;
  copyDiagnostics(value: string): Promise<void>;
  guidance(topic: string): Promise<void>;
}
export interface ServiceOptions {
  mode: 'mock'|'real'; poolHome: string; host: string; authority: string;
  createTransport(): Promise<Transport>;
  native: NativeAdapter;
  onSnapshot(snapshot: UiSnapshot): void;
  overviewIntervalSeconds?: number;
  initialGeneration?: number;
  supported?: boolean; environmentReason?: string;
  configurationError?: HostError;
  projectContext?():ProjectContext;
}
interface Recovery { requestId: string; payloadHash: string; workspaceId: string; workerId: string; poolKey: string; taskId?: string }
const blankDraft = (): TaskDraft => ({workspaceId:'',workerId:'',prompt:'',session:'continue',mode:'build',modelId:'GLM-5.3-Flash',busyRetryLimit:3,verifyCommands:[],submitToken:randomUUID()});
const sha256 = (value: string|Buffer): string => createHash('sha256').update(value).digest('hex');
export class ActionService implements RouterTarget {
  readonly state: UiSnapshot;
  private client?: TypedClient;
  private disposed = false;
  private readonly rootAbort = new AbortController();
  private connectionAbort = new AbortController();
  private selectionAbort = new AbortController();
  private selectionSequence = 0;
  private listSequence = 0;
  private listFilter: RequestPayload<'tasks.list'>['filter'];
  private historicalPagesLoaded=false;
  private readonly taskCache = new Map<string,UiTaskDetail>();
  private readonly reviews = new Map<string,{review:UiApprovalReview;loadedComplete:boolean;text?:string}>();
  private readonly submissions = new Map<string,{hash:string;generation:number;promise:Promise<unknown>}>();
  private readonly operations = new Map<string,Promise<unknown>>();
  private readonly approvalReceipts = new Map<string,{fingerprint:string;promise:Promise<unknown>}>();
  private readonly deliveryOpened = new Set<string>();
  private readonly viewedFiles = new Set<string>();
  private poll: PollCoordinator;
  private visible = false;
  constructor(private readonly options: ServiceOptions) {
    this.state = {
      connection:{state:options.configurationError?'error':'disconnected',mode:options.mode,generation:options.initialGeneration??0,host:options.host,poolHome:options.poolHome,trusted:options.native.trusted(),lastReceivedAtMs:null,stale:false,storeId:null,instanceId:null,daemonVersion:null,capabilities:{},error:options.configurationError?safeError(options.configurationError):null,supported:options.supported??true,environmentReason:options.environmentReason??null},
      tasks:[],scope:'recent_50_loaded',total:null,listNextCursor:null,selectedTaskId:null,detail:null,
      resources:{accounts:[],workers:[],workspaces:[],quotas:{}},approvals:null,delivery:{manifest:null,files:[],nextCursor:null,reviewed:false},draft:blankDraft(),actions:[],overviewIntervalSeconds:options.overviewIntervalSeconds??30,notice:null,
    };
    this.poll = new PollCoordinator(signal=>this.refreshSnapshot(signal),signal=>this.wait(signal),()=>this.state.overviewIntervalSeconds*1000,error=>{this.state.connection.stale=true;this.state.connection.error=safeError(error);this.emit();});
  }
  generation(): number {return this.state.connection.generation;}
  snapshot(): UiSnapshot {this.state.connection.trusted=this.options.native.trusted();this.state.preferredRepositoryId=this.options.projectContext?resolvePreferredRepositoryId(this.options.projectContext(),this.state.resources.workspaces):null;return this.state;}
  private emit(): void {if (!this.disposed) this.options.onSnapshot(this.snapshot());}
  setVisible(visible: boolean): void {this.visible=visible;this.poll.setVisible(visible&&!!this.client);}
  setOverviewInterval(seconds:number): void {if(this.state.overviewIntervalSeconds===seconds)return;this.state.overviewIntervalSeconds=seconds;this.poll.intervalChanged();this.emit();}
  trustChanged(): void {this.emit();}
  private requireConnection(): TypedClient {if(!this.client)throw new HostError('NOT_CONNECTED','Connect explicitly to the selected host and pool.');return this.client;}
  private requireCapability(name: string, mutate = false): void {
    this.requireConnection();
    if(mutate&&!this.options.native.trusted())throw new HostError('WORKSPACE_UNTRUSTED','Trust this workspace before execution or account changes.');
    if(mutate&&this.state.connection.stale)throw new HostError('STALE_DATA','Refresh this connection before changing resources or execution.');
    if(this.state.connection.state==='legacy-readonly'||!this.state.connection.capabilities[name]?.version)throw new HostError('CAPABILITY_UNAVAILABLE','This daemon does not provide the capability required for this action.');
  }
  private assertCurrent(generation: number): void {if(this.disposed||generation!==this.generation())throw new HostError('STALE_CONNECTION','The connection changed while this request was loading.');}
  private async ui<K extends UiMethodName>(method: K, params: UiRpcParams<K>, signal=this.connectionAbort.signal): Promise<UiRpcResult<K>> {
    const generation=this.generation();const result=await this.requireConnection().call(method,params,signal);this.assertCurrent(generation);
    if(method!=='ui_capabilities'&&'meta' in result){
      if(result.meta.storeId!==this.state.connection.storeId||result.meta.instanceId!==this.state.connection.instanceId){
        this.disconnect();throw new HostError('CONNECTION_CHANGED','The daemon or store identity changed. Connect again to negotiate current capabilities.');
      }
    }
    this.state.connection.lastReceivedAtMs=Date.now();this.state.connection.stale=false;this.state.connection.error=null;return result;
  }
  async connect(): Promise<UiSnapshot> {
    if(this.options.configurationError)throw this.options.configurationError;
    if(this.state.connection.supported===false)throw new HostError('UNSUPPORTED_PLATFORM',this.state.connection.environmentReason??'This host does not support real daemon connections.');
    if(this.state.connection.state==='connecting')return this.state;
    this.disconnect(false);const generation=this.generation();
    this.state.connection.state='connecting';this.emit();
    try{
      const transport=await this.options.createTransport();this.assertCurrent(generation);this.client=new TypedClient(transport);
      try{
        const capabilities=await this.ui('ui_capabilities',{bootstrapVersion:1,client:{name:'vscode',version:'0.1.0'},supportedApiMajors:[1]});
        this.state.connection={...this.state.connection,state:'connected',storeId:capabilities.storeId,instanceId:capabilities.instanceId,daemonVersion:capabilities.daemonVersion,capabilities:capabilities.capabilities,lastReceivedAtMs:Date.now()};
      }catch(error){
        if(error instanceof HostError&&error.code==='METHOD_NOT_FOUND')this.state.connection.state='legacy-readonly';else throw error;
      }
      await this.refresh();
      await this.recoverDispatches();
      this.poll.setVisible(this.visible);this.emit();return this.state;
    }catch(error){if(generation===this.generation()){this.client?.dispose();this.client=undefined;this.state.connection.state='error';this.state.connection.error=safeError(error);this.emit();}throw error;}
  }
  disconnect(emit=true): void {
    this.poll.setVisible(false);this.poll.reset();this.connectionAbort.abort();this.selectionAbort.abort();this.connectionAbort=new AbortController();this.selectionAbort=new AbortController();this.client?.dispose();this.client=undefined;
    this.state.connection={...this.state.connection,state:this.options.configurationError?'error':'disconnected',generation:this.generation()+1,stale:this.state.tasks.length>0,error:this.options.configurationError?safeError(this.options.configurationError):null,storeId:null,instanceId:null,capabilities:{}};
    this.state.detail=null;this.state.selectedTaskId=null;this.state.legacyResult=null;this.state.approvals=null;this.state.delivery={manifest:null,files:[],nextCursor:null,reviewed:false};this.state.resources.quotas={};this.reviews.clear();this.taskCache.clear();this.deliveryOpened.clear();this.viewedFiles.clear();this.listSequence++;this.selectionSequence++;
    this.state.tasks=[];this.state.total=null;this.state.listNextCursor=null;this.historicalPagesLoaded=false;this.listFilter=undefined;
    if(emit)this.emit();
  }
  refresh(signal=this.connectionAbort.signal): Promise<void> {return this.poll.requestRefresh(false,signal);}
  private async refreshSnapshot(signal:AbortSignal): Promise<void> {
    const generation=this.generation();const overview=await this.requireConnection().legacy('overview',{},signal);this.assertCurrent(generation);
    const detailRequests=new Map<string,Promise<UiTaskDetail>>();
    const detailFor=(taskId:string):Promise<UiTaskDetail>=>{
      let pending=detailRequests.get(taskId);
      if(!pending){pending=this.ui('ui_get_task_detail',{apiVersion:1,task_id:taskId},signal).then(value=>value.data);detailRequests.set(taskId,pending);}
      return pending;
    };
    this.state.resources.accounts=overview.accounts;
    this.state.resources.workspaces=overview.workspaces;
    this.state.resources.workers=overview.workers.map(worker=>({...worker,leaseTaskIds:overview.tasks.filter(task=>task.workerId===worker.workerId&&task.leaseHeld).map(task=>task.taskId)}));
    if(this.state.connection.capabilities.taskList?.version){
      if(!this.historicalPagesLoaded)await this.listTasks({filter:this.listFilter},signal);
      else this.state.notice='Loaded history is retained. Refresh the task list explicitly to discover a new list revision.';
    }
    else{
      this.state.tasks=overview.tasks.slice(-50).reverse();this.state.scope='recent_50_loaded';this.state.total=null;this.state.listNextCursor=null;
      if(this.state.connection.capabilities.taskDetail?.version){
        const details=await Promise.all(overview.tasks.map(task=>detailFor(task.taskId)));
        this.assertCurrent(generation);for(const detail of details)this.mergeDetail(detail,false);
      }
    }
    // Workspace occupancy is authoritative across the whole pool, including tasks older
    // than the overview window. Resolve every held workspace before showing worker controls.
    if(this.state.connection.capabilities.taskDetail?.version){
      const held=[...new Set(overview.workspaces.map(w=>w.activeTaskId).filter((id):id is string=>!!id))];
      const details=await Promise.all(held.map(detailFor));
      for(const detail of details)this.mergeDetail(detail,false);
      for(const worker of this.state.resources.workers)worker.leaseTaskIds=[...new Set([...worker.leaseTaskIds,...details.filter(t=>t.workerId===worker.workerId&&t.leaseHeld).map(t=>t.taskId)])];
    }
    if(this.state.selectedTaskId&&this.state.connection.capabilities.taskDetail?.version)this.mergeDetail(await detailFor(this.state.selectedTaskId));
    this.state.connection.lastReceivedAtMs=Date.now();this.state.connection.stale=false;this.state.connection.error=null;this.emit();
  }
  async listTasks(payload: RequestPayload<'tasks.list'>,signal=this.connectionAbort.signal): Promise<unknown> {
    if(!this.state.connection.capabilities.taskList?.version){if(payload.cursor)throw new HostError('CAPABILITY_UNAVAILABLE','Only the recent 50-task window is available.');return {items:this.state.tasks,scope:this.state.scope,total:null,nextCursor:null};}
    const sequence=++this.listSequence;const filter=payload.filter??this.listFilter;
    const repository=filter?.repositoryId?this.state.resources.workspaces.find(w=>w.workspaceId===filter.repositoryId):undefined;
    if(filter?.repositoryId&&!repository)throw new HostError('NOT_FOUND','Choose a registered repository from the current resource list.');
    const wireFilter=filter?{...(repository?{repository_path:repository.repositoryPath}:{}),...(filter.workspaceId?{workspace_id:filter.workspaceId}:{}),...(filter.workerId?{worker_id:filter.workerId}:{}),...(filter.statuses?{statuses:filter.statuses}:{}),...(filter.leaseHeld!==undefined?{lease_held:filter.leaseHeld}:{}),...(filter.query?{query:filter.query}:{})}:undefined;
    let page;
    try{page=(await this.ui('ui_list_tasks',{apiVersion:1,limit:50,sort:'created_desc',filter:wireFilter,...(payload.cursor?{cursor:payload.cursor}:{})},signal)).data;}
    catch(error){if(error instanceof HostError&&['CURSOR_STALE','CURSOR_INVALID'].includes(error.code)){this.state.listNextCursor=null;this.state.total=null;this.state.notice='The task list changed. These loaded rows are retained; reload the first page for a current list.';this.emit();}throw error;}
    if(sequence!==this.listSequence)throw new HostError('STALE_SELECTION','A newer task filter is active.');
    this.listFilter=filter;
    this.historicalPagesLoaded=!!payload.cursor;
    this.state.tasks=payload.cursor?[...this.state.tasks,...page.items]:page.items;
    this.state.scope=page.scope;this.state.total=page.total;this.state.listNextCursor=page.nextCursor;this.emit();return page;
  }
  private mergeDetail(detail: UiTaskDetail, add=true): void {
    const previous=this.taskCache.get(detail.taskId);if(previous&&previous.revision>detail.revision){if(this.state.selectedTaskId===detail.taskId)this.state.detail=previous;return;}
    this.taskCache.set(detail.taskId,detail);
    if(detail.executionStopped||detail.cancelRequestedAtMs!==null||detail.approval.pendingCount===0){for(const entry of this.reviews.values())if(entry.review.taskId===detail.taskId){entry.loadedComplete=false;delete entry.text;}}
    const index=this.state.tasks.findIndex(task=>task.taskId===detail.taskId);
    const priorReview=index>=0?this.state.tasks[index]!.deliveryReview:undefined;
    const summary={...detail,deliveryReview:detail.result.available?(priorReview==='reviewed'?'reviewed':'pending'):'unknown'} as const;
    if(index>=0){if(this.state.tasks[index]!.revision<=detail.revision)this.state.tasks[index]=summary;}else if(add)this.state.tasks.unshift(summary);
    if(this.state.selectedTaskId===detail.taskId){this.state.detail=detail;}
  }
  async selectTask(taskId: string, reset=true): Promise<unknown> {
    this.requireConnection();
    const sequence=++this.selectionSequence;this.selectionAbort.abort();this.selectionAbort=new AbortController();
    this.state.selectedTaskId=taskId;
    if(reset){this.state.detail=null;this.state.approvals=null;this.state.delivery={manifest:null,files:[],nextCursor:null,reviewed:false};this.reviews.clear();this.emit();}
    if(this.state.connection.state==='legacy-readonly'){
      const value=await this.requireConnection().legacy('get_result',{task_id:taskId},this.selectionAbort.signal);
      if(sequence!==this.selectionSequence)throw new HostError('STALE_SELECTION','A newer task is selected.');
      this.state.legacyResult=value;
      this.state.notice='Legacy daemon: read-only recent window. Stop proof, complete approvals and immutable file diffs are unavailable.';this.emit();return value;
    }
    this.requireCapability('taskDetail');const detail=(await this.ui('ui_get_task_detail',{apiVersion:1,task_id:taskId},this.selectionAbort.signal)).data;
    if(sequence!==this.selectionSequence)throw new HostError('STALE_SELECTION','A newer task is selected.');
    this.mergeDetail(detail);this.emit();return detail;
  }
  private async freshTask(taskId: string): Promise<UiTaskDetail> {this.requireCapability('taskDetail');const detail=(await this.ui('ui_get_task_detail',{apiVersion:1,task_id:taskId})).data;this.mergeDetail(detail);return detail;}
  private async wait(signal: AbortSignal): Promise<boolean|'idle'> {
    if(!this.client)return 'idle';
    const tasks=this.state.tasks.filter(task=>task.leaseHeld||!['succeeded','failed','cancelled'].includes(task.status)).slice(0,50);
    if(!tasks.length)return 'idle';
    const generation=this.generation();const started=Date.now();
    const result=await this.client.legacy('wait',{task_ids:tasks.map(task=>task.taskId),after_revision:Object.fromEntries(tasks.map(task=>[task.taskId,task.revision])),timeout_sec:25},signal);this.assertCurrent(generation);
    for(const task of result.tasks){
      const current=this.state.tasks.find(t=>t.taskId===task.taskId);if(current&&task.revision>=current.revision)Object.assign(current,task);
      if(this.state.connection.capabilities.taskDetail?.version&&result.changedTaskIds.includes(task.taskId))this.mergeDetail((await this.ui('ui_get_task_detail',{apiVersion:1,task_id:task.taskId},signal)).data,false);
    }
    this.state.connection.stale=false;this.state.connection.lastReceivedAtMs=Date.now();this.emit();return Date.now()-started>1000;
  }
  private poolKey(): string {return `${this.options.authority}|${this.options.poolHome}|${this.state.connection.storeId}`;}
  private async recoverDispatches(): Promise<void> {
    if(!this.state.connection.capabilities.taskLookupByRequest?.version)return;
    for(const record of this.options.native.getState<Recovery[]>('dispatchRecovery',[]).filter(r=>r.poolKey===this.poolKey())){
      try{const task=(await this.ui('ui_get_task_detail',{apiVersion:1,request_id:record.requestId})).data;this.mergeDetail(task);this.action({key:`dispatch:${record.requestId}`,phase:'succeeded',message:'The original dispatch was found by its request ID.',requestId:record.requestId,taskId:task.taskId});}
      catch(error){this.action({key:`dispatch:${record.requestId}`,phase:'unknown',message:'The original dispatch is unresolved. No new request was sent.',requestId:record.requestId,error:safeError(error)});}
    }
  }
  private action(value: UiActionState): void {const i=this.state.actions.findIndex(action=>action.key===value.key);if(i<0)this.state.actions.push(value);else this.state.actions[i]=value;this.emit();}
  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing=this.operations.get(key);if(existing)return existing as Promise<T>;
    const promise=operation().finally(()=>{if(this.operations.get(key)===promise)this.operations.delete(key);});this.operations.set(key,promise);return promise;
  }
  private async mutate<T>(key: string, operation: () => Promise<T>,taskId?:string): Promise<T> {
    const generation=this.generation();
    return this.serialize(`${generation}:${key}`,async()=>{
      this.assertCurrent(generation);
      this.action({key,phase:'pending',message:'Submitting the explicit operation; waiting for daemon state.',taskId});
      try{const result=await operation();this.assertCurrent(generation);this.action({key,phase:'succeeded',message:key.startsWith('cancel:')?'Cancellation was requested. Occupancy remains until termination is confirmed.':'The daemon acknowledged this operation. Current task state remains authoritative.',taskId});await this.poll.requestRefresh(true,this.connectionAbort.signal);this.assertCurrent(generation);return result;}
      catch(error){const safe=safeError(error);if(generation===this.generation())this.action({key,phase:safe.unknownOutcome?'unknown':'failed',message:safe.message,taskId,error:safe});throw error;}
    });
  }
  private dispatch(submitToken: string): Promise<unknown> {
    this.requireCapability('dispatchTask',true);const draft=this.state.draft;
    const generation=this.generation();const client=this.requireConnection();const signal=this.connectionAbort.signal;
    if(draft.submitToken!==submitToken)throw new HostError('ACTION_CONFLICT','This submission belongs to an earlier draft.');
    const payload={workspace_id:draft.workspaceId,worker_id:draft.workerId,prompt:draft.prompt,session:draft.session,mode:draft.mode,model_id:draft.modelId,busy_retry_limit:draft.busyRetryLimit,verify_commands:draft.verifyCommands.map(c=>({command:c.command,args:c.args,timeout_ms:c.timeoutMs}))};
    const fingerprint=sha256(JSON.stringify(payload));const existing=this.submissions.get(submitToken);
    if(existing){if(existing.hash!==fingerprint)throw new HostError('REQUEST_CONFLICT','This submit token is already bound to different task content.');if(existing.generation!==generation)throw new HostError('STALE_CONNECTION','This submission belongs to the original connection. Query its request ID; it was not resent.');return existing.promise;}
    const workspace=this.state.resources.workspaces.find(w=>w.workspaceId===draft.workspaceId);const worker=this.state.resources.workers.find(w=>w.workerId===draft.workerId);
    if(!workspace||workspace.state!=='active'||workspace.activeTaskId||!worker||worker.state!=='ready'||worker.leaseTaskIds.length)throw new HostError('RESOURCE_UNAVAILABLE','Choose a current active workspace and a ready worker without known or uncertain occupancy.');
    const account=this.state.resources.accounts.find(a=>a.alias===worker.accountAlias);if(!account||['blocked','invalid','cooling'].includes(account.health))throw new HostError('AUTH_INVALID','The selected worker account is unavailable.');
    if(!draft.prompt.trim())throw new HostError('INVALID_ARGUMENT','Enter a task prompt.');
    const requestId=randomUUID();
    const promise=(async()=>{
      const record:Recovery={requestId,payloadHash:fingerprint,workspaceId:draft.workspaceId,workerId:draft.workerId,poolKey:this.poolKey()};
      const recovery=this.options.native.getState<Recovery[]>('dispatchRecovery',[]);await this.options.native.setState('dispatchRecovery',[...recovery.filter(r=>r.requestId!==requestId),record].slice(-100));
      this.assertCurrent(generation);this.requireCapability('dispatchTask',true);
      this.action({key:`dispatch:${requestId}`,phase:'pending',message:'Dispatch submitted with a stable request ID.',requestId});
      try{
        const result=await client.legacy('dispatch_task',{...payload,request_id:requestId},signal);this.assertCurrent(generation);
        this.action({key:`dispatch:${requestId}`,phase:'succeeded',message:'Task dispatch was acknowledged.',requestId,taskId:result.task.taskId});
        await this.poll.requestRefresh(true,signal);this.assertCurrent(generation);await this.selectTask(result.task.taskId);return {...result,requestId};
      }catch(error){const safe=safeError(error);if(generation===this.generation())this.action({key:`dispatch:${requestId}`,phase:'unknown',message:'Dispatch result is unresolved. Query this request ID before an explicit retry.',requestId,error:safe});throw error;}
    })();
    this.submissions.set(submitToken,{hash:fingerprint,generation,promise});return promise;
  }
  private async control(type:'cancel'|'reconcile'|'resume',taskId:string):Promise<unknown>{
    this.requireCapability(`${type}Task`,true);
    const generation=this.generation();const client=this.requireConnection();const signal=this.connectionAbort.signal;
    return this.mutate(`${type}:${taskId}`,async()=>{
      const task=await this.freshTask(taskId);const control=task.controls[type];if(!control.available)throw new HostError('ACTION_UNAVAILABLE',control.reason??'This action is unavailable for the current task.');
      if(type==='resume'&&!task.verificationPolicy.complete)throw new HostError('RECOVERY_REQUIRED','The complete verification policy is unavailable. Inspect this task before resuming.');
      const method={cancel:'cancel_task',reconcile:'reconcile_task',resume:'resume_task'}[type] as 'cancel_task'|'reconcile_task'|'resume_task';
      this.assertCurrent(generation);this.requireCapability(`${type}Task`,true);
      return client.legacy(method,{task_id:taskId},signal);
    },taskId);
  }
  private reviewKey(taskId:string,approvalId:string):string{return `${this.poolKey()}|${taskId}|${approvalId}`;}
  private async openApproval(taskId:string,approvalId:string):Promise<UiApprovalReview>{
    this.requireCapability('approvalRead');await this.freshTask(taskId);
    const review=(await this.ui('ui_get_approval',{apiVersion:1,task_id:taskId,approval_id:approvalId})).data;
    if(review.taskId!==taskId||review.approvalId!==approvalId)throw new HostError('INVALID_RESPONSE','Approval ownership did not match the selected task.');
    this.reviews.set(this.reviewKey(taskId,approvalId),{review,loadedComplete:false});return review;
  }
  private async readApproval(taskId:string,approvalId:string,reviewId:string):Promise<unknown>{
    this.requireCapability('approvalRead');const entry=this.reviews.get(this.reviewKey(taskId,approvalId));const review=entry?.review;
    if(!entry||!review||review.reviewId!==reviewId||!review.content||!review.content.sourceComplete||review.readOnlyReason)throw new HostError('APPROVAL_READ_ONLY','This approval has no complete supported review source.');
    if(review.content.totalBytes>8388608)throw new HostError('OUTPUT_BUDGET_EXCEEDED','Approval content exceeds the complete-review limit.');
    const chunks:Buffer[]=[];let offset=0;
    do{
      const page=(await this.ui('ui_read_approval',{apiVersion:1,task_id:taskId,approval_id:approvalId,review_id:reviewId,offset_bytes:offset,limit_bytes:65536},this.selectionAbort.signal)).data;
      const chunk=decodeChunk(page,offset,review.content.totalBytes);
      if(page.reviewId!==reviewId||page.contentSha256!==review.content.sha256)throw new HostError('INTEGRITY_MISMATCH','The approval page identity changed.');
      chunks.push(chunk);if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes;
    }while(true);
    const bytes=Buffer.concat(chunks);if(bytes.length!==review.content.totalBytes||sha256(bytes)!==review.content.sha256)throw new HostError('INTEGRITY_MISMATCH','The complete approval digest does not match.');
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);const data:unknown=JSON.parse(text);validatePermissionContent(data,review);}catch(error){if(error instanceof HostError)throw error;throw new HostError('UNSUPPORTED_SCHEMA','This approval content is not valid supported permission-review JSON.');}
    if(this.reviews.get(this.reviewKey(taskId,approvalId))!==entry)throw new HostError('APPROVAL_CHANGED','Select and load the current approval again.');
    entry.loadedComplete=true;entry.text=text;return {review,loadedComplete:true,text};
  }
  private respondApproval(payload:RequestPayload<'approval.respond'>):Promise<unknown>{
    this.requireCapability('approvalRespondFingerprint',true);const key=this.reviewKey(payload.taskId,payload.approvalId);const entry=this.reviews.get(key);const review=entry?.review;
    const generation=this.generation();
    if(!entry||!review||review.reviewId!==payload.reviewId||!review.content?.sourceComplete||review.readOnlyReason||review.redactions.some(r=>r.decisionRelevant)||review.state!=='pending'||review.response.state!=='none'||review.expiresAtMs<Date.now()||review.content.sha256!==payload.contentSha256||review.approvalRevision!==payload.approvalRevision||review.nativeRevision!==payload.nativeRevision||!review.decisions.some(d=>d.decision===payload.decision))throw new HostError('APPROVAL_CHANGED','This approval is stale, read-only, or no longer supports this decision. Load its current review.');
    if(payload.decision==='accept'&&!entry.loadedComplete)throw new HostError('APPROVAL_NOT_LOADED','Load and verify all approval content before allowing this operation.');
    const fingerprint=sha256(JSON.stringify(payload));const previous=this.approvalReceipts.get(key);if(previous){if(previous.fingerprint!==fingerprint)throw new HostError('APPROVAL_RESPONSE_PENDING','The previous response result must be checked before another decision.');return previous.promise;}
    const actionId=randomUUID();
    const promise=this.mutate(`approval:${key}`,async()=>{
      const task=await this.freshTask(payload.taskId);
      if(payload.decision==='accept'){
        const account=this.state.resources.accounts.find(a=>a.alias===task.selection.binding?.accountAlias);
        if(task.cancelRequestedAtMs!==null||task.status==='blocked'||!account||['blocked','invalid','cooling'].includes(account.health))throw new HostError('AUTH_INVALID','This task or account cannot accept an approval.');
      }
      const receipts=this.options.native.getState<unknown[]>('approvalReceipts',[]);await this.options.native.setState('approvalReceipts',[...receipts,{actionId,taskId:payload.taskId,approvalId:payload.approvalId,contentSha256:payload.contentSha256,poolKey:this.poolKey()}].slice(-100));
      this.assertCurrent(generation);this.requireCapability('approvalRespondFingerprint',true);
      review.response={actionId,decision:payload.decision,state:'intent_recorded'};
      const result=(await this.ui('ui_respond_approval',{apiVersion:1,task_id:payload.taskId,approval_id:payload.approvalId,review_id:payload.reviewId,expected_approval_revision:payload.approvalRevision,expected_native_revision:payload.nativeRevision,expected_content_sha256:payload.contentSha256,decision:payload.decision,action_id:actionId})).data;
      review.response.state=result.responseState;review.state='response_pending';entry.loadedComplete=false;delete entry.text;return result;
    },payload.taskId).catch(error=>{
      entry.loadedComplete=false;delete entry.text;
      if(error instanceof HostError&&(['APPROVAL_CHANGED','APPROVAL_GONE','APPROVAL_READ_ONLY'].includes(error.code)||review.response.state==='none'&&!error.unknownOutcome)){
        this.reviews.delete(key);this.approvalReceipts.delete(key);
      }else if(review.response.state==='intent_recorded')review.response.state='unknown';
      throw error;
    });
    this.approvalReceipts.set(key,{fingerprint,promise});return promise;
  }
  private async artifacts(taskId:string,cursor?:string):Promise<unknown>{
    this.requireCapability('artifactSnapshots');await this.freshTask(taskId);
    const manifest=(await this.ui('ui_get_artifact_manifest',{apiVersion:1,task_id:taskId},this.selectionAbort.signal)).data;
    if(manifest.taskId!==taskId)throw new HostError('INVALID_RESPONSE','The artifact manifest belongs to a different task.');
    if(this.state.selectedTaskId!==taskId)throw new HostError('STALE_SELECTION','Select the task before reading its delivery.');
    if(cursor&&this.state.delivery.manifest?.manifestSha256!==manifest.manifestSha256)throw new HostError('CURSOR_STALE','The artifact manifest changed.');
    this.state.delivery.manifest=manifest;
    if(manifest.state!=='available'||!manifest.manifestSha256){this.state.delivery.files=[];this.state.delivery.nextCursor=null;this.emit();return {manifest,items:[],nextCursor:null};}
    const page=(await this.ui('ui_list_artifact_files',{apiVersion:1,task_id:taskId,manifest_sha256:manifest.manifestSha256,...(cursor?{cursor}:{}),limit:50},this.selectionAbort.signal)).data;
    if(page.manifestSha256!==manifest.manifestSha256)throw new HostError('INTEGRITY_MISMATCH','Artifact list identity changed.');
    this.state.delivery.files=cursor?[...this.state.delivery.files,...page.items]:page.items;this.state.delivery.nextCursor=page.nextCursor;
    this.state.delivery.reviewed=this.options.native.getState<boolean>(this.reviewStorageKey(taskId,manifest.manifestSha256),false);
    const summary=this.state.tasks.find(task=>task.taskId===taskId);if(summary)summary.deliveryReview=this.state.delivery.reviewed?'reviewed':'pending';
    this.deliveryOpened.add(`${taskId}|${manifest.manifestSha256}`);this.emit();return {manifest,...page};
  }
  private artifactFile(taskId:string,manifestSha256:string,fileId:string):UiArtifactFile{
    if(this.state.selectedTaskId!==taskId||this.state.delivery.manifest?.manifestSha256!==manifestSha256)throw new HostError('ARTIFACT_UNAVAILABLE','Load the selected task manifest before opening a file.');
    const file=this.state.delivery.files.find(f=>f.fileId===fileId);if(!file)throw new HostError('ARTIFACT_UNAVAILABLE','The file does not belong to the loaded immutable manifest.');return file;
  }
  private async readArtifact(taskId:string,manifestSha256:string,fileId:string,side:'base'|'final',offsetBytes=0):Promise<UiRpcResult<'ui_read_artifact_file'>['data']>{
    this.requireCapability('artifactSnapshots');const file=this.artifactFile(taskId,manifestSha256,fileId);const expected=file[side];
    if(expected.state!=='available'||expected.sizeBytes===null||!expected.sha256)throw new HostError('ARTIFACT_UNAVAILABLE',expected.reason??'This immutable file side is absent or unavailable.');
    const page=(await this.ui('ui_read_artifact_file',{apiVersion:1,task_id:taskId,manifest_sha256:manifestSha256,file_id:fileId,side,offset_bytes:offsetBytes,limit_bytes:65536},this.selectionAbort.signal)).data;
    const chunk=decodeChunk(page,offsetBytes,expected.sizeBytes);
    if(page.manifestSha256!==manifestSha256||page.fileId!==fileId||page.side!==side||page.fileSha256!==expected.sha256||sha256(chunk)!==page.chunkSha256)throw new HostError('INTEGRITY_MISMATCH','The immutable file page failed identity or hash verification.');return page;
  }
  private async fullArtifact(taskId:string,hash:string,file:UiArtifactFile,side:'base'|'final'):Promise<string>{
    const expected=file[side];if(expected.state==='absent')return '';
    if(expected.state!=='available'||expected.encoding!=='utf8'||expected.sizeBytes===null||expected.sizeBytes>2097152||expected.kind==='gitlink'||expected.kind==='unknown')throw new HostError('ARTIFACT_UNAVAILABLE','Native Diff requires a complete UTF-8 snapshot of at most 2 MiB per side.');
    const chunks:Buffer[]=[];let offset=0;do{const page=await this.readArtifact(taskId,hash,file.fileId,side,offset);chunks.push(Buffer.from(page.dataBase64,'base64'));if(page.nextOffsetBytes===null)break;offset=page.nextOffsetBytes;}while(true);
    const bytes=Buffer.concat(chunks);if(bytes.length!==expected.sizeBytes||sha256(bytes)!==expected.sha256)throw new HostError('INTEGRITY_MISMATCH','The complete immutable file hash does not match.');
    try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new HostError('ARTIFACT_UNAVAILABLE','The immutable file does not contain strict UTF-8 text.');}
  }
  private reviewStorageKey(taskId:string,hash:string):string{return `review:${sha256(`${this.poolKey()}|${taskId}|${hash}`)}`;}
  async execute(request:WebviewRequest):Promise<unknown>{
    if(this.disposed)throw new HostError('DISPOSED','This workbench has closed.');
    if(request.type!=='ready'&&request.generation!==this.generation())throw new HostError('STALE_CONNECTION','Reload the current workbench state.');
    switch(request.type){
      case 'ready':this.emit();return this.snapshot();
      case 'connection.configure':{
        if(!this.options.native.configureConnection)throw new HostError('ACTION_UNAVAILABLE','Connection configuration is unavailable in this Host.');
        await this.options.native.configureConnection();return {configured:true};
      }
      case 'daemon.start':{
        if(!this.options.native.trusted())throw new HostError('WORKSPACE_UNTRUSTED','Trust this workspace before starting the daemon.');
        if(this.options.mode!=='real')throw new HostError('ACTION_UNAVAILABLE','Daemon startup is available only for a real connection.');
        if(this.state.connection.supported===false)throw new HostError('UNSUPPORTED_PLATFORM',this.state.connection.environmentReason??'This host does not support real daemon connections.');
        if(this.options.configurationError)throw this.options.configurationError;
        if(!this.options.native.startDaemon)throw new HostError('ACTION_UNAVAILABLE','Daemon startup is unavailable in this Host.');
        await this.options.native.startDaemon();return {started:true};
      }
      case 'connect':return this.connect();
      case 'disconnect':this.disconnect();return this.state;
      case 'refresh':case 'resources.refresh':await this.refresh();return this.state;
      case 'tasks.list':return this.listTasks(request.payload);
      case 'task.select':return this.selectTask(request.payload.taskId);
      case 'draft.change':this.state.draft=request.payload.draft;this.emit();return {saved:true};
      case 'dispatch':return this.dispatch(request.payload.submitToken);
      case 'dispatch.lookup':{this.requireCapability('taskLookupByRequest');const detail=(await this.ui('ui_get_task_detail',{apiVersion:1,request_id:request.payload.requestId})).data;this.mergeDetail(detail);this.emit();return detail;}
      case 'cancel':case 'reconcile':case 'resume':return this.control(request.type,request.payload.taskId);
      case 'events.read':{const page=await this.requireConnection().legacy('get_logs',{task_id:request.payload.taskId,cursor:request.payload.cursor??0,limit:20},this.selectionAbort.signal);if(page.events.some(e=>e.taskId!==request.payload.taskId)||page.events.length&&page.nextCursor<=(request.payload.cursor??0))throw new HostError('INVALID_RESPONSE','Event pagination did not advance for the selected task.');return page;}
      case 'patch.read':{const offset=request.payload.offset??0;const page=await this.requireConnection().legacy('get_diff',{task_id:request.payload.taskId,offset,limit:4000},this.selectionAbort.signal);if(page.available&&page.nextOffset!==null&&page.nextOffset!==undefined&&page.nextOffset<=offset)throw new HostError('INVALID_RESPONSE','Patch pagination did not advance.');return {...page,offset,offsetUnit:'utf16'};}
      case 'approvals.list':{this.requireCapability('approvalRead');const page=(await this.ui('ui_list_approvals',{apiVersion:1,task_id:request.payload.taskId,...(request.payload.cursor?{cursor:request.payload.cursor}:{}),limit:20},this.selectionAbort.signal)).data;if(this.state.selectedTaskId===request.payload.taskId){this.state.approvals=request.payload.cursor&&this.state.approvals?{...page,items:[...this.state.approvals.items,...page.items]}:page;this.emit();}return page;}
      case 'approval.open':return this.openApproval(request.payload.taskId,request.payload.approvalId);
      case 'approval.read':return this.readApproval(request.payload.taskId,request.payload.approvalId,request.payload.reviewId);
      case 'approval.respond':return this.respondApproval(request.payload);
      case 'accounts.import':{
        this.requireCapability('importAccounts',true);const generation=this.generation();const client=this.requireConnection();const signal=this.connectionAbort.signal;const files=await this.options.native.pickAccountFiles(this.options.host);if(!files?.length)return {cancelled:true};if(files.length>100)throw new HostError('INVALID_ARGUMENT','Select between 1 and 100 OAuth JSON files.');
        this.assertCurrent(generation);this.requireCapability('importAccounts',true);
        return this.mutate('accounts.import',()=>client.legacy('import_accounts',{files},signal));
      }
      case 'workspace.create':{
        this.requireCapability('createWorkspace',true);const generation=this.generation();const client=this.requireConnection();const signal=this.connectionAbort.signal;const repository=await this.options.native.pickRepository(this.options.host);if(!repository)return {cancelled:true};
        this.assertCurrent(generation);this.requireCapability('createWorkspace',true);
        return this.mutate('workspace.create',()=>client.legacy('create_workspace',{repository,base_ref:request.payload.baseRef},signal));
      }
      case 'worker.start':{
        this.requireCapability('startWorker',true);const {workerId,accountAlias}=request.payload;const account=this.state.resources.accounts.find(a=>a.alias===accountAlias);
        if(!account||['blocked','invalid','cooling'].includes(account.health)||this.state.resources.workers.some(w=>(w.workerId===workerId||w.accountAlias===accountAlias)&&w.state!=='stopped'))throw new HostError('WORKER_BUSY','Choose an available account without another live or uncertain worker.');
        return this.mutate(`worker:${workerId}`,()=>this.requireConnection().legacy('start_worker',{worker_id:workerId,account_id:accountAlias},this.connectionAbort.signal));
      }
      case 'worker.stop':{
        this.requireCapability('stopWorker',true);const worker=this.state.resources.workers.find(w=>w.workerId===request.payload.workerId);
        if(!worker||!worker.processOwned||worker.leaseTaskIds.length||worker.runningTaskCount!==0)throw new HostError('WORKER_BUSY','Only an owned worker with confirmed zero native tasks and no daemon lease can be stopped.');
        return this.mutate(`worker:${worker.workerId}`,()=>this.requireConnection().legacy('stop_worker',{worker_id:worker.workerId},this.connectionAbort.signal));
      }
      case 'worker.probe':{
        this.requireCapability('quotaProbe',true);const worker=this.state.resources.workers.find(w=>w.workerId===request.payload.workerId);if(!worker||worker.state!=='ready')throw new HostError('WORKER_UNAVAILABLE','Choose a currently ready worker.');
        return this.mutate(`probe:${worker.workerId}`,async()=>{const quota=(await this.ui('ui_probe_quota',{apiVersion:1,worker_id:worker.workerId})).data;this.state.resources.quotas[quota.accountAlias]=quota;return quota;});
      }
      case 'quota.read':{this.requireCapability('quotaSnapshots');if(!this.state.resources.accounts.some(a=>a.alias===request.payload.accountAlias))throw new HostError('NOT_FOUND','The account is not in the current pool.');const quota=(await this.ui('ui_get_quota',{apiVersion:1,account_id:request.payload.accountAlias})).data;this.state.resources.quotas[quota.accountAlias]=quota;this.emit();return quota;}
      case 'artifacts.list':return this.artifacts(request.payload.taskId,request.payload.cursor);
      case 'artifact.read':return this.readArtifact(request.payload.taskId,request.payload.manifestSha256,request.payload.fileId,request.payload.side,request.payload.offsetBytes);
      case 'diff.open':{const {taskId,manifestSha256,fileId}=request.payload;const file=this.artifactFile(taskId,manifestSha256,fileId);if(!file.nativeDiff.available)throw new HostError('ARTIFACT_UNAVAILABLE',file.nativeDiff.reason??'This file has no complete immutable Diff.');await this.options.native.openDiff(taskId,manifestSha256,file,side=>this.fullArtifact(taskId,manifestSha256,file,side));this.viewedFiles.add(`${taskId}|${manifestSha256}|${fileId}`);return {opened:true};}
      case 'file.current.open':{
        const {taskId,manifestSha256,fileId}=request.payload;const file=this.artifactFile(taskId,manifestSha256,fileId);const path=file.finalPath??file.relativePath;
        if(!path||path.startsWith('/')||path.includes('\\')||path.includes('\0')||path.split('/').some(part=>part==='..'||part==='.'||!part))throw new HostError('PATH_REJECTED','This artifact does not have a safe current-worktree path.');
        if(this.options.mode==='mock')throw new HostError('MOCK_READ_ONLY','Mock mode does not read the fixture workspace or current disk files.');
        const detail=await this.freshTask(taskId);if(!this.options.native.openCurrentFile)throw new HostError('CAPABILITY_UNAVAILABLE','This Host cannot open current disk files.');await this.options.native.openCurrentFile(detail.workspace.worktreePath,path);return {opened:true,version:'current_disk'};
      }
      case 'review.set':{
        const {taskId,manifestSha256,reviewed}=request.payload;const manifest=this.state.delivery.manifest;
        if(this.state.selectedTaskId!==taskId||manifest?.manifestSha256!==manifestSha256||manifest.state!=='available'||!manifest.fileListComplete||this.state.delivery.nextCursor||!this.deliveryOpened.has(`${taskId}|${manifestSha256}`))throw new HostError('REVIEW_INCOMPLETE','Load the complete immutable delivery list, summary and verification before marking it reviewed.');
        if(reviewed&&this.state.delivery.files.some(f=>f.nativeDiff.available&&!this.viewedFiles.has(`${taskId}|${manifestSha256}|${f.fileId}`)))throw new HostError('REVIEW_INCOMPLETE','Open each available immutable file Diff before marking the delivery reviewed.');
        await this.options.native.setState(this.reviewStorageKey(taskId,manifestSha256),reviewed);this.state.delivery.reviewed=reviewed;const summary=this.state.tasks.find(task=>task.taskId===taskId);if(summary)summary.deliveryReview=reviewed?'reviewed':'pending';this.emit();return {reviewed};
      }
      case 'settings.open':await this.options.native.openSettings();return {opened:true};
      case 'settings.save':await this.options.native.saveInterval(request.payload.overviewIntervalSeconds);this.setOverviewInterval(request.payload.overviewIntervalSeconds);return {saved:true};
      case 'diagnostics.copy':{const c=this.state.connection;const value=JSON.stringify({host:c.host,pool:c.poolHome,mode:c.mode,state:c.state,storeId:c.storeId,instanceId:c.instanceId,daemonVersion:c.daemonVersion,error:c.error?.code,taskId:this.state.selectedTaskId,revision:this.state.detail?.revision},null,2);await this.options.native.copyDiagnostics(value);return {copied:true};}
      case 'guidance.open':await this.options.native.guidance(request.payload.topic);return {opened:true};
    }
  }
  dispose():void{if(this.disposed)return;this.disposed=true;this.poll.dispose();this.rootAbort.abort();this.connectionAbort.abort();this.selectionAbort.abort();this.client?.dispose();this.client=undefined;this.reviews.clear();this.taskCache.clear();this.state.draft=blankDraft();}
  closePanel():void{this.selectionAbort.abort();this.selectionAbort=new AbortController();this.selectionSequence++;this.reviews.clear();}
}
function decodeChunk(page:{offsetBytes:number;dataBase64:string;byteLength:number;nextOffsetBytes:number|null;totalBytes:number},offset:number,total:number):Buffer{
  const chunk=Buffer.from(page.dataBase64,'base64');
  if(chunk.toString('base64')!==page.dataBase64||page.offsetBytes!==offset||page.totalBytes!==total||chunk.length!==page.byteLength||chunk.length>65536||offset+chunk.length>total||(page.nextOffsetBytes!==null&&(page.nextOffsetBytes!==offset+chunk.length||page.nextOffsetBytes<=offset))||(page.nextOffsetBytes===null&&offset+chunk.length!==total))throw new HostError('INTEGRITY_MISMATCH','A content page failed length, position or encoding verification.');return chunk;
}
function validatePermissionContent(data:unknown,review:UiApprovalReview):void{
  const parsed=uiPermissionReviewSchema.safeParse(data);if(!parsed.success)throw new HostError('UNSUPPORTED_SCHEMA','This permission review contains an unsupported decision schema.');
  const value=parsed.data;
  if(value.taskId!==review.taskId||value.approvalId!==review.approvalId||JSON.stringify(value.owner)!==JSON.stringify(review.owner))throw new HostError('APPROVAL_CHANGED','The permission review belongs to another interaction or attempt.');
  // Official 3.16.3 freeText only enables optional feedback on deny. Fixed option
  // IDs remain usable without feedback; only their mapped responses need checking.
  const options=value.interaction.payload.options;
  if(value.interaction.interactionId!==review.approvalId||new Set(options.map(option=>option.optionId)).size!==options.length||review.decisions.some(decision=>{
    const option=options.find(item=>item.optionId===decision.nativeOptionId);
    if(!option||decision.decision==='accept'&&option.kind!=='allowOnce'||decision.decision==='decline'&&option.kind!=='deny'||decision.decision==='cancel')return true;
    const response=option.response;
    return response!==undefined&&(response.decision!==(decision.decision==='accept'?'allow':'deny')||Object.keys(response).some(key=>!['decision','reason'].includes(key))||response.reason!==undefined&&typeof response.reason!=='string');
  }))throw new HostError('UNSUPPORTED_SCHEMA','This interaction does not provide supported allow-once and deny decisions.');
}
