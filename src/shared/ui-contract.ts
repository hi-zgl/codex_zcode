import { z } from 'zod';

/** Wire-only schemas. This module deliberately has no Node, daemon, store or VS Code imports. */
export const UI_API_VERSION = 1 as const;
export const UI_LIMITS = { requestBytes: 524288, responseBytes: 262144, chunkBytes: 65536,
  taskPageItems: 100, approvalPageItems: 50, artifactPageItems: 100,
  approvalSnapshotBytes: 8388608, editorFileBytes: 2097152 } as const;
const bytes = (value: string) => new TextEncoder().encode(value).length;
export const uiIdSchema = z.string().min(1).max(150).refine(v => bytes(v) <= 600 && !v.includes('\0'));
export const uiHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const uint = z.number().int().nonnegative().safe();
const time = uint.nullable();
const text = z.string();
const cursor = z.string().min(1).refine(v => bytes(v) <= 2048);
const version = z.literal(1);
export const uiTaskStatusSchema = z.enum(['queued','dispatching','running','waiting_approval','verifying','succeeded','failed','cancelled','blocked','interrupted']);
export const uiMetaSchema = z.object({apiVersion:version,instanceId:uiIdSchema,storeId:uiIdSchema,servedAtMs:uint});
export function uiEnvelopeSchema<T extends z.ZodTypeAny>(data: T) { return z.object({meta:uiMetaSchema,data}); }
export type UiEnvelope<T> = {meta:z.infer<typeof uiMetaSchema>; data:T};
const capability = z.object({version:uint,reason:text.optional()}).default({version:0,reason:'not_advertised'});
export const uiCapabilitiesSchema = z.object({
  selectedApiVersion:z.object({major:version,minor:uint}),daemonVersion:text,instanceId:uiIdSchema,storeId:uiIdSchema,servedAtMs:uint,
  capabilities:z.object({taskDetail:capability,taskLookupByRequest:capability,taskList:capability,quotaSnapshots:capability,quotaProbe:capability,
    approvalRead:capability,approvalRespondFingerprint:capability,artifactSnapshots:capability,dispatchTask:capability,createWorkspace:capability,
    importAccounts:capability,startWorker:capability,stopWorker:capability,reconcileTask:capability,resumeTask:capability,cancelTask:capability,poolPolicy:capability,poolLifecycle:capability}),
  limits:z.object({requestBytes:uint,responseBytes:uint,chunkBytes:uint,taskPageItems:uint,approvalPageItems:uint,artifactPageItems:uint,approvalSnapshotBytes:uint,editorFileBytes:uint}),
  runtime:z.object({platform:text,supportedOfficialVersions:z.array(text)}),
});
export const uiTaskSummarySchema = z.object({taskId:uiIdSchema,workspaceId:uiIdSchema,workerId:uiIdSchema.nullable(),status:uiTaskStatusSchema,
  revision:uint,createdAtMs:uint,updatedAtMs:uint,leaseHeld:z.boolean(),executionStopped:z.boolean(),cancelRequestedAtMs:time,
  approval:z.object({pendingCount:uint.nullable(),responsePending:z.boolean(),stateKnown:z.boolean()}),
  retry:z.object({used:uint,max:uint,reason:z.literal('model_busy')})});
export const uiAttemptSchema = z.object({index:uint,commandId:uiIdSchema,sessionId:uiIdSchema.nullable(),turnId:uiIdSchema.nullable(),intentAtMs:uint,
  acknowledgedAtMs:time,terminalState:z.enum(['completedSuccess','failed','completedInterrupted']).nullable(),stopProofKind:text.nullable(),
  failureCategory:text.nullable(),busyRetryEligible:z.boolean(),continuationBlocked:z.boolean()});
const control = z.object({available:z.boolean(),reason:text.nullable(),effects:z.array(text)});
export const uiTaskDetailSchema = uiTaskSummarySchema.extend({requestId:uiIdSchema,
  workspace:z.object({workspaceId:uiIdSchema,repositoryPath:text,worktreePath:text,branch:text,baseCommit:text,state:z.enum(['active','merged','abandoned'])}),
  execution:z.object({dispatchAttemptedAtMs:time,currentCommandId:uiIdSchema,sessionId:uiIdSchema.nullable(),turnId:uiIdSchema.nullable(),
    stopProof:z.object({kind:z.enum(['runtime_terminal','process_exited','history_stopped','not_dispatched']),observedAtMs:time,evidenceSummary:text}).nullable(),
    attachment:z.enum(['attached','not_attached','unknown']),finalizing:z.boolean()}),
  selection:z.object({requestedWorkerId:uiIdSchema.nullable(),requestedSession:z.enum(['continue','new']),mode:z.enum(['build','edit','plan','yolo','guarded']),requestedModelId:text,
    binding:z.object({accountAlias:uiIdSchema,providerId:text,modelId:text}).nullable()}),
  verificationPolicy:z.object({complete:z.boolean(),defaultDiffCheck:z.boolean(),commands:z.array(z.object({command:text,args:z.array(text),timeoutMs:uint})).max(10),unavailableReason:text.nullable()}),
  attempts:z.array(uiAttemptSchema).max(11),currentAttemptIndex:uint.nullable(),controls:z.object({cancel:control,reconcile:control,resume:control}),
  result:z.object({available:z.boolean(),createdAtMs:time,summary:text,summaryTruncated:z.boolean(),changedFileCount:uint,artifactCount:uint,
    verification:z.array(z.object({commandDisplay:text,exitCode:z.number().int().nullable(),summary:text,summaryTruncated:z.boolean()})),blockers:z.array(text),
    manifestState:z.enum(['available','legacy_patch_only','not_captured','unavailable'])}),diagnostic:z.object({code:text,message:text}).nullable()});
export const uiSourceTimeSchema = z.object({value:z.union([z.number().finite(),text]),unit:z.enum(['s','ms','iso8601','unknown']),atMs:time});
export const uiQuotaSnapshotSchema = z.object({source:z.enum(['imported_snapshot','live_probe']),accountAlias:uiIdSchema,providerId:text,observedAtMs:time,storedAtMs:time,
  generatedAt:uiSourceTimeSchema.nullable(),serverTime:uiSourceTimeSchema.nullable(),nextReset:uiSourceTimeSchema.nullable(),unit:z.enum(['credits','tokens','requests','unknown']),
  total:z.number().finite().nullable(),used:z.number().finite().nullable(),remaining:z.number().finite().nullable(),
  percentage:z.object({value:z.number().finite(),scale:z.enum(['0_to_100','0_to_1','unknown'])}).nullable(),authenticated:z.boolean().nullable(),freshness:z.enum(['fresh','stale','unknown'])});
export const uiQuotaSchema = z.object({accountAlias:uiIdSchema,imported:uiQuotaSnapshotSchema.nullable(),live:uiQuotaSnapshotSchema.nullable(),
  lastProbe:z.object({state:z.enum(['never','succeeded','failed']),attemptedAtMs:time,errorCode:text.nullable()}),displayFreshnessWindowMs:uint});
export const uiApprovalOwnerSchema = z.object({attemptIndex:uint,commandId:uiIdSchema,sessionId:uiIdSchema,nativeTurnId:uiIdSchema});
type ReviewJson = null|boolean|number|string|ReviewJson[]|{[key:string]:ReviewJson};
const reviewJson:z.ZodType<ReviewJson> = z.lazy(()=>z.union([z.null(),z.boolean(),z.number().finite(),z.string(),z.array(reviewJson),z.record(reviewJson)]));
const permissionOptionSchema=z.object({optionId:uiIdSchema,label:text,kind:z.enum(['allowOnce','allowAlways','deny','custom']),response:z.record(reviewJson).optional()}).strict();
const permissionPayloadSchema=z.object({kind:z.literal('permission'),toolCallId:uiIdSchema,toolName:z.enum(['Bash','Edit','Write','Read']),summary:text,detail:z.record(reviewJson),
 freeText:z.boolean().optional(),fullAccessOption:permissionOptionSchema.optional(),options:z.array(permissionOptionSchema).min(2).max(20)}).strict().superRefine((p,ctx)=>{
 const details={Bash:z.object({command:text.min(1),description:text.optional(),timeout:z.number().finite().optional(),run_in_background:z.boolean().optional(),dangerouslyDisableSandbox:z.boolean().optional()}).strict(),
 Edit:z.object({file_path:text.min(1),old_string:text,new_string:text,replace_all:z.boolean().optional()}).strict(),
 Write:z.object({file_path:text.min(1),content:text}).strict(),Read:z.object({file_path:text.min(1),offset:z.number().finite().optional(),limit:z.number().finite().optional(),pages:text.optional()}).strict()};
 if(!details[p.toolName].safeParse(p.detail).success)ctx.addIssue({code:z.ZodIssueCode.custom,message:'Unsupported decision parameters',path:['detail']});
});
export const uiPermissionInteractionSchema=z.object({interactionId:uiIdSchema,kind:z.literal('permission'),anchorRowId:uint.nullable().optional(),createdAt:z.number().finite().optional(),
 sourceCommandId:uiIdSchema.optional(),turnId:uiIdSchema.optional(),payload:permissionPayloadSchema}).strict();
/** Complete canonical document hashed and read by ui_read_approval. Never use a log preview in its place. */
export const uiPermissionReviewSchema=z.object({schema:z.literal('permission-review/1'),taskId:uiIdSchema,approvalId:uiIdSchema,owner:uiApprovalOwnerSchema,
 workspacePath:text,interaction:uiPermissionInteractionSchema}).strict();
export type UiPermissionReview = z.infer<typeof uiPermissionReviewSchema>;
export const uiApprovalDecisionSchema = z.object({decision:z.enum(['accept','decline','cancel']),label:text,nativeOptionId:uiIdSchema});
export const uiApprovalResponseSchema = z.object({actionId:uiIdSchema.nullable(),decision:text.nullable(),state:z.enum(['none','intent_recorded','awaiting_native','confirmed','resolved_unattributed','unknown'])});
export const uiApprovalReviewSchema = z.object({taskId:uiIdSchema,approvalId:uiIdSchema,reviewId:uiIdSchema,owner:uiApprovalOwnerSchema,
  state:z.enum(['pending','response_pending','gone','unknown']),approvalRevision:text,nativeRevision:uint,observedAtMs:uint,expiresAtMs:uint,
  content:z.object({mediaType:z.literal('application/json'),encoding:z.literal('utf8'),totalBytes:uint,sha256:uiHashSchema,schema:z.literal('permission-review/1'),sourceComplete:z.boolean()}).nullable(),
  redactions:z.array(z.object({category:text,decisionRelevant:z.boolean()})),decisions:z.array(uiApprovalDecisionSchema),readOnlyReason:text.nullable(),response:uiApprovalResponseSchema});
export const uiApprovalPreviewSchema = z.object({approvalId:uiIdSchema,kind:text,toolName:text.nullable(),summary:text,truncated:z.boolean(),
  sourceComplete:z.boolean(),responseState:uiApprovalResponseSchema.shape.state,readOnlyReason:text.nullable()});
export const uiFileSideSchema = z.object({state:z.enum(['available','absent','unavailable']),reason:text.nullable(),kind:z.enum(['regular','symlink','gitlink','unknown']),mode:text.nullable(),
  sha256:uiHashSchema.nullable(),sizeBytes:uint.nullable(),encoding:z.enum(['utf8','binary','unknown'])});
export const uiArtifactFileSchema = z.object({fileId:uiIdSchema,relativePath:text.nullable(),displayPath:text,basePath:text.nullable(),finalPath:text.nullable(),
  change:z.enum(['added','modified','deleted','renamed','type_changed','untracked','unknown']),base:uiFileSideSchema,final:uiFileSideSchema,nativeDiff:z.object({available:z.boolean(),reason:text.nullable()})});
export const uiArtifactManifestSchema = z.object({taskId:uiIdSchema,state:z.enum(['available','legacy_patch_only','not_captured','unavailable']),schemaVersion:version,manifestSha256:uiHashSchema.nullable(),
  scope:z.literal('workspace_base_cumulative'),baseCommit:text,sourceScope:z.literal('git_tracked_plus_nonignored_untracked'),captureStartedAtMs:time,captureCompletedAtMs:time,
  consistency:z.enum(['lease_held_non_atomic','legacy_unknown']),fileCount:uint.nullable(),availableFileCount:uint,unavailableFileCount:uint,fileListComplete:z.boolean(),
  patch:z.object({available:z.boolean(),sha256:uiHashSchema.nullable(),sizeBytes:uint.nullable()}),unavailableReason:text.nullable()});
export const uiErrorKinds = ['INCOMPATIBLE_API','CAPABILITY_UNAVAILABLE','NOT_FOUND','CURSOR_INVALID','CURSOR_STALE','OUTPUT_BUDGET_EXCEEDED','UNSUPPORTED_SCHEMA',
  'APPROVAL_CHANGED','APPROVAL_GONE','APPROVAL_READ_ONLY','APPROVAL_RESPONSE_PENDING','ACTION_CONFLICT','ARTIFACT_UNAVAILABLE','INTEGRITY_MISMATCH','PATH_REJECTED',
  'WORKSPACE_BUSY','WORKER_BUSY','REQUEST_CONFLICT','WORKER_UNAVAILABLE','RECOVERY_REQUIRED','AUTH_INVALID','RISK_BLOCKED','MODEL_SELECTION_MISMATCH','NATIVE_UNAVAILABLE','OUTCOME_UNKNOWN','INTERNAL_ERROR'] as const;
export const uiErrorDataSchema = z.object({kind:z.enum(uiErrorKinds),retryable:z.boolean(),outcome:z.enum(['not_started','may_have_applied','read_only']),
  taskId:uiIdSchema.optional(),approvalId:uiIdSchema.optional(),actionId:uiIdSchema.optional(),refresh:z.enum(['task','approval','artifacts','resources','connection']).optional()});
const v = {apiVersion:version};
const task = {...v,task_id:uiIdSchema};
const approval = {...task,approval_id:uiIdSchema};
const manifest = {...task,manifest_sha256:uiHashSchema};
const chunkParams = {offset_bytes:uint,limit_bytes:uint.min(1).max(UI_LIMITS.chunkBytes).default(UI_LIMITS.chunkBytes)};
const chunkResult = {offsetBytes:uint,dataBase64:text,byteLength:uint,nextOffsetBytes:uint.nullable(),totalBytes:uint};
export const uiMethods = {
  ui_capabilities:{params:z.object({bootstrapVersion:version,client:z.object({name:text.min(1).max(100),version:text.min(1).max(100)}).strict(),supportedApiMajors:z.array(uint.positive()).min(1).max(10)}).strict(),result:uiCapabilitiesSchema},
  ui_get_task_detail:{params:z.object({...v,task_id:uiIdSchema.optional(),request_id:uiIdSchema.optional()}).strict().refine(p=>!!p.task_id!==!!p.request_id),result:uiEnvelopeSchema(uiTaskDetailSchema)},
  ui_list_tasks:{params:z.object({...v,filter:z.object({repository_path:text.max(4096).optional(),workspace_id:uiIdSchema.optional(),worker_id:uiIdSchema.optional(),statuses:z.array(uiTaskStatusSchema).max(10).optional(),lease_held:z.boolean().optional(),query:text.max(200).optional()}).strict().optional(),sort:z.literal('created_desc').default('created_desc'),limit:uint.min(1).max(100).default(50),cursor:cursor.optional()}).strict(),
    result:uiEnvelopeSchema(z.object({items:z.array(uiTaskSummarySchema),total:uint,nextCursor:cursor.nullable(),listRevision:uint,observedAtMs:uint,scope:z.literal('all_matching_tasks')}))},
  ui_get_quota:{params:z.object({...v,account_id:uiIdSchema}).strict(),result:uiEnvelopeSchema(uiQuotaSchema)},
  ui_probe_quota:{params:z.object({...v,worker_id:uiIdSchema}).strict(),result:uiEnvelopeSchema(uiQuotaSchema)},
  ui_list_approvals:{params:z.object({...task,limit:uint.min(1).max(50).default(20),cursor:cursor.optional()}).strict(),result:uiEnvelopeSchema(z.object({items:z.array(uiApprovalPreviewSchema),total:uint.nullable(),nextCursor:cursor.nullable(),approvalSetRevision:text,stateKnown:z.boolean(),unattributedCount:uint}))},
  ui_get_approval:{params:z.object(approval).strict(),result:uiEnvelopeSchema(uiApprovalReviewSchema)},
  ui_read_approval:{params:z.object({...approval,review_id:uiIdSchema,...chunkParams}).strict(),result:uiEnvelopeSchema(z.object({...chunkResult,reviewId:uiIdSchema,contentSha256:uiHashSchema}))},
  ui_respond_approval:{params:z.object({...approval,review_id:uiIdSchema,expected_approval_revision:text.min(1).max(200),expected_native_revision:uint,expected_content_sha256:uiHashSchema,decision:z.enum(['accept','decline','cancel']),action_id:uiIdSchema}).strict(),
    result:uiEnvelopeSchema(z.object({taskId:uiIdSchema,approvalId:uiIdSchema,actionId:uiIdSchema,responseState:z.enum(['awaiting_native','confirmed','resolved_unattributed','unknown']),nativeRevisionAtCheck:uint,taskRevision:uint}))},
  ui_get_artifact_manifest:{params:z.object(task).strict(),result:uiEnvelopeSchema(uiArtifactManifestSchema)},
  ui_list_artifact_files:{params:z.object({...manifest,limit:uint.min(1).max(100).default(50),cursor:cursor.optional()}).strict(),result:uiEnvelopeSchema(z.object({items:z.array(uiArtifactFileSchema),total:uint,nextCursor:cursor.nullable(),manifestSha256:uiHashSchema}))},
  ui_read_artifact_file:{params:z.object({...manifest,file_id:uiIdSchema,side:z.enum(['base','final']),...chunkParams}).strict(),result:uiEnvelopeSchema(z.object({...chunkResult,manifestSha256:uiHashSchema,fileId:uiIdSchema,side:z.enum(['base','final']),fileSha256:uiHashSchema,chunkSha256:uiHashSchema,encoding:z.enum(['utf8','binary','unknown'])}))},
} as const;
export type UiMethodName = keyof typeof uiMethods;
export type UiRpcParams<M extends UiMethodName> = z.input<(typeof uiMethods)[M]['params']>;
export type UiRpcResult<M extends UiMethodName> = z.infer<(typeof uiMethods)[M]['result']>;
export type UiCapabilities = z.infer<typeof uiCapabilitiesSchema>;
export type UiTaskSummary = z.infer<typeof uiTaskSummarySchema>;
export type UiTaskDetail = z.infer<typeof uiTaskDetailSchema>;
export type UiQuota = z.infer<typeof uiQuotaSchema>;
export type UiQuotaSnapshot = z.infer<typeof uiQuotaSnapshotSchema>;
export type UiApprovalReview = z.infer<typeof uiApprovalReviewSchema>;
export type UiApprovalPreview = z.infer<typeof uiApprovalPreviewSchema>;
export type UiArtifactManifest = z.infer<typeof uiArtifactManifestSchema>;
export type UiArtifactFile = z.infer<typeof uiArtifactFileSchema>;
export type UiFileSide = z.infer<typeof uiFileSideSchema>;
export type UiErrorKind = (typeof uiErrorKinds)[number];
export type UiErrorData = z.infer<typeof uiErrorDataSchema>;
