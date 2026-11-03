import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const time = 1793491200000;

const caps = Object.fromEntries(
  ['poolPolicy', 'poolLifecycle', 'taskDetail', 'taskLookupByRequest', 'taskList',
   'quotaSnapshots', 'quotaProbe', 'approvalRead', 'approvalRespondFingerprint',
   'artifactSnapshots', 'dispatchTask', 'createWorkspace', 'importAccounts',
   'startWorker', 'stopWorker', 'reconcileTask', 'resumeTask', 'cancelTask',
   'workOverview', 'errorStats', 'workTodos', 'commanderQuota', 'accountEnabled'
  ].map((k) => [k, { version: 1 }])
);

const workspaces = [
  ['workspace-demo', '/demo/project', '/demo/pool/worktrees/demo', 'zcode/demo', 'abc123', null],
  ['workspace-review', '/demo/project', '/demo/pool/worktrees/review', 'zcode/review', 'abc123', 'task-approval'],
  ['workspace-unknown', '/demo/other', '/demo/pool/worktrees/unknown', 'zcode/unknown', 'def456', 'task-unknown'],
].map(([workspaceId, repositoryPath, worktreePath, branch, baseCommit, activeTaskId]) => ({
  workspaceId, repositoryPath, worktreePath, branch, baseCommit, activeTaskId, state: 'active',
}));

const worker = (workerId, accountAlias, n = 0) => ({
  workerId, accountAlias, state: 'ready', processOwned: true, runningTaskCount: n, version: '3.16.3',
});

const quotaRaw = [{
  available_units: 500000000,
  bucket_id: 'bucket_2116409240354062336',
  capabilities: ['model:glm-5.3-flash'],
  entitlement_id: 'ent-zcode-v3-start-plan-1030-wk-1',
  entitlement_priority: 101,
  expires_at: 1793581200,
  meter: 'model_usage',
  period_end: 1793581200,
  period_start: 1793371312,
  plan_id: 'zcode-v3-start-plan-1030-wk',
  plan_priority: 101,
  priority: 101,
  remaining_units: 500000000,
  show_name: 'GLM-5.3-Flash',
  total_units: 500000000,
  unit_type: 'token',
  used_units: 0,
  user_plan_id: 'upl_2116178779393183744',
}];

const subscriptionRaw = [{
  description: '',
  ends_at: 1793581200,
  entitlements: [{
    capabilities: ['model:glm-5.3-flash'],
    effective_at: 1793372400,
    entitlement_id: 'ent-zcode-v3-start-plan-1030-wk-1',
    grant_units: 500000000,
    meter: 'model_usage',
    period: 'one_time',
    priority: 101,
    show_name: 'GLM-5.3-Flash',
    unit_type: 'token',
  }],
  name: 'ZCODE WEEKEND BUILD',
  plan_id: 'zcode-v3-start-plan-1030-wk',
  priority: 101,
  starts_at: 1793371312,
  status: 'active',
  user_plan_id: 'upl_2116178779393183744',
}];

const accounts = [
  {
    alias: 'account-demo',
    provider: 'zai',
    health: 'available',
    plan: 'ZCODE WEEKEND BUILD',
    email: 'builder@example.invalid',
    name: 'builder@example.invalid',
    quota: {
      total: 500000000,
      used: 0,
      remaining: 500000000,
      updatedAt: time,
      quota_raw: quotaRaw,
      subscription_raw: subscriptionRaw,
    },
  },
  {
    alias: 'account-review',
    provider: 'zai',
    health: 'available',
    plan: 'ZCode 1024 Dev Day',
    email: 'reviewer@example.invalid',
    name: 'Reviewer',
  },
  {
    alias: 'account-unknown',
    provider: 'bigmodel',
    health: 'unknown',
    email: 'observer@example.invalid',
    name: 'Observer',
  },
];

const workers = [
  worker('worker-demo', 'account-demo'),
  worker('worker-review', 'account-review', 1),
  worker('worker-unknown', 'account-unknown', 0),
];

function detail(taskId, workspaceId, workerId, status, revision, leaseHeld = false) {
  return {
    taskId, workspaceId, workerId, status, revision,
    createdAtMs: time - revision * 1000, updatedAtMs: time,
    leaseHeld, executionStopped: !leaseHeld, cancelRequestedAtMs: null,
    approval: { pendingCount: status === 'waiting_approval' ? 1 : 0, responsePending: false, stateKnown: status !== 'interrupted' },
    retry: { used: status === 'interrupted' ? 1 : 0, max: null, reason: 'model_busy' },
    requestId: `request-${taskId}`,
    workspace: workspaces.find((w) => w.workspaceId === workspaceId),
    execution: {
      dispatchAttemptedAtMs: time - 10000, currentCommandId: `command-${taskId}`, sessionId: `session-${taskId}`, turnId: `command-${taskId}`,
      stopProof: leaseHeld ? null : { kind: 'runtime_terminal', observedAtMs: time, evidenceSummary: 'The exact native execution was observed terminal.' },
      attachment: status === 'interrupted' ? 'unknown' : leaseHeld ? 'attached' : 'not_attached', finalizing: false,
    },
    selection: {
      requestedWorkerId: workerId, requestedSession: 'continue', mode: 'build', requestedModelId: 'GLM-5.3-Flash',
      binding: { accountAlias: workers.find((w) => w.workerId === workerId).accountAlias, providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' },
    },
    verificationPolicy: { complete: true, defaultDiffCheck: true, commands: [], unavailableReason: null },
    attempts: [{
      index: 0, commandId: `command-${taskId}`, sessionId: `session-${taskId}`, turnId: `command-${taskId}`,
      intentAtMs: time - 10000, acknowledgedAtMs: time - 9000, terminalState: leaseHeld ? null : 'completedSuccess',
      stopProofKind: leaseHeld ? null : 'runtime_terminal', failureCategory: status === 'interrupted' ? 'model_busy' : null,
      busyRetryEligible: false, continuationBlocked: false,
    }],
    currentAttemptIndex: 0,
    controls: {
      cancel: { available: leaseHeld, reason: leaseHeld ? null : 'Execution already stopped.', effects: ['Persists cancellation intent; keeps occupancy until stopped.'] },
      reconcile: { available: status === 'interrupted', reason: status === 'interrupted' ? null : 'No uncertain execution.', effects: ['Reads native state; may update task records and release proved stopped occupancy.'] },
      resume: { available: status === 'interrupted', reason: status === 'interrupted' ? null : 'No observation recovery needed.', effects: ['May run configured verification or a qualified remaining busy continuation.'] },
    },
    result: {
      available: !leaseHeld, createdAtMs: leaseHeld ? null : time,
      summary: leaseHeld ? '' : 'Implemented the demo change. Functional acceptance is still required.',
      summaryTruncated: false, changedFileCount: leaseHeld ? 0 : 2, artifactCount: leaseHeld ? 0 : 1,
      verification: leaseHeld ? [] : [{ commandDisplay: 'git diff --check', exitCode: 0, summary: 'No whitespace errors. Functional tests were not configured.', summaryTruncated: false }],
      blockers: [], manifestState: leaseHeld ? 'not_captured' : 'available',
    },
    diagnostic: status === 'interrupted' ? { code: 'RECOVERY_REQUIRED', message: 'Native execution cannot yet be proved stopped; occupancy remains.' } : null,
  };
}

const details = [
  detail('task-complete', 'workspace-demo', 'worker-demo', 'succeeded', 8),
  detail('task-approval', 'workspace-review', 'worker-review', 'waiting_approval', 7, true),
  detail('task-unknown', 'workspace-unknown', 'worker-unknown', 'interrupted', 6, true),
];

const owner = { attemptIndex: 0, commandId: 'command-task-approval', sessionId: 'session-task-approval', nativeTurnId: 'native-turn-demo' };

const permission = {
  schema: 'permission-review/1', taskId: 'task-approval', approvalId: 'approval-demo', owner, workspacePath: '/demo/pool/worktrees/review',
  interaction: {
    interactionId: 'approval-demo', kind: 'permission', sourceCommandId: 'command-task-approval', turnId: 'native-turn-demo',
    payload: {
      kind: 'permission', toolCallId: 'tool-demo', toolName: 'Write', summary: 'Write a demonstration file (complete content exceeds the old log preview).',
      detail: { file_path: 'src/demo.ts', content: '// Complete approval content\n' + 'export const example = "review safely 😀";\n'.repeat(150) },
      options: [{ optionId: 'allow-once', label: 'Allow once', kind: 'allowOnce' }, { optionId: 'deny', label: 'Deny', kind: 'deny' }],
    },
  },
};

const approvalText = JSON.stringify(permission);
const review = {
  taskId: 'task-approval', approvalId: 'approval-demo', reviewId: 'review-demo', owner, state: 'pending', approvalRevision: 'approval-revision-1', nativeRevision: 41, observedAtMs: time, expiresAtMs: time + 315360000000,
  content: { mediaType: 'application/json', encoding: 'utf8', totalBytes: Buffer.byteLength(approvalText), sha256: hash(approvalText), schema: 'permission-review/1', sourceComplete: true },
  redactions: [], decisions: [{ decision: 'accept', label: '只批准本次操作', nativeOptionId: 'allow-once' }, { decision: 'decline', label: '拒绝本次操作', nativeOptionId: 'deny' }],
  readOnlyReason: null, response: { actionId: null, decision: null, state: 'none' },
};

const content = {
  'file-demo:base': 'export const answer = 41;\n',
  'file-demo:final': 'export const answer = 42; // 😀\n',
  'file-new:final': 'A nonignored untracked immutable artifact.\n',
};

const side = (key) =>
  key
    ? { state: 'available', reason: null, kind: 'regular', mode: '100644', sha256: hash(content[key]), sizeBytes: Buffer.byteLength(content[key]), encoding: 'utf8' }
    : { state: 'absent', reason: null, kind: 'regular', mode: null, sha256: null, sizeBytes: 0, encoding: 'utf8' };

const files = [
  { fileId: 'file-demo', relativePath: 'src/demo.ts', displayPath: 'src/demo.ts', basePath: 'src/demo.ts', finalPath: 'src/demo.ts', change: 'modified', base: side('file-demo:base'), final: side('file-demo:final'), nativeDiff: { available: true, reason: null } },
  { fileId: 'file-new', relativePath: 'notes.txt', displayPath: 'notes.txt', basePath: null, finalPath: 'notes.txt', change: 'untracked', base: side(null), final: side('file-new:final'), nativeDiff: { available: true, reason: null } },
];

const manifestHash = hash(JSON.stringify(files));
const patch = 'diff --git a/src/demo.ts b/src/demo.ts\n--- a/src/demo.ts\n+++ b/src/demo.ts\n@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42; // 😀\n' + '// UTF-16 patch page 😀\n'.repeat(220);

const manifest = {
  taskId: 'task-complete', state: 'available', schemaVersion: 1, manifestSha256: manifestHash, scope: 'workspace_base_cumulative', baseCommit: 'abc123',
  sourceScope: 'git_tracked_plus_nonignored_untracked', captureStartedAtMs: time - 500, captureCompletedAtMs: time, consistency: 'lease_held_non_atomic',
  fileCount: 2, availableFileCount: 2, unavailableFileCount: 0, fileListComplete: true,
  patch: { available: true, sha256: hash(patch), sizeBytes: Buffer.byteLength(patch) }, unavailableReason: null,
};

const poolPolicy={maxConcurrentTasks:null,occupiedSlots:2,availableSlots:null,retryIntervalMs:5000,recoveryWaitMs:120000,silenceCheckMs:900000,lowQuotaThresholdPercent:5,defaultCommanderQuota:2};
const stage=(stageId,title,dependsOn,status,accountAliases=[],confirmation=null)=>({stageId,title,dependsOn,status,accountAliases,confirmation,rework:false,blockedReason:null,criteria:[`${title}达到指挥确认的完成标准`]});
const item=(itemId,stageId,title,taskId)=>{
  const task=details.find(detail=>detail.taskId===taskId);
  return {itemId,stageId,title,taskId,dependsOn:[],workspace:'isolated',verifyCommands:[],mode:'build',modelId:'GLM-5.3-Flash',kind:'implementation',targetDeliveryId:null,acceptanceId:null,workspaceId:task?.workspaceId??null,handoffTaskId:null,runIndex:0,queueAt:null,blockedReason:null,cancelled:false,createdAt:time,status:task?.status??'pending',accountAlias:task?.selection.binding.accountAlias??null,workerId:task?.workerId??null,execution:null};
};
const work={
  workId:'work-demo',requestId:'work-request-demo',commanderId:'commander-demo',controlVersion:1,repositoryPath:'/demo/project',goal:'交付共享账号池工作台：任务流程与额度一眼可见',criteria:['真实依赖阶段图、实施与验收分离'],status:'active',quotaOverride:null,partialApproval:null,requestedAccounts:2,effectiveAccounts:2,
  stages:[
    stage('plan','确认目标与计划',[],'completed',[],{summary:'目标与可观察的验收条件已明确',deliveryIds:[],acceptanceIds:[],confirmedAt:time-600000}),
    stage('api','实现调度接口',['plan'],'running',['account-review']),
    stage('ui','实现工作台界面',['plan'],'running',['account-demo']),
    stage('integrate','整合与最终验收',['api','ui'],'not_started')
  ],
  items:[item('item-api','api','实现共享池接口','task-approval'),item('item-ui','ui','实现任务与阶段展示','task-complete')],
  deliveries:[{deliveryId:'delivery-ui',itemId:'item-ui',taskId:'task-complete',workspaceId:'workspace-demo',manifestSha256:manifestHash,summary:'工作台界面已实施，等待独立验收',changedFiles:['src/demo.ts','notes.txt'],createdAt:time}],
  acceptances:[{acceptanceId:'acceptance-ui',deliveryId:'delivery-ui',executor:{kind:'external',name:'独立浏览器验收'},status:'running',itemId:null,workspaceId:'acceptance-ui-workspace',workspacePath:'/demo/pool/acceptance/work-demo/ui',summary:'正在检查固定交付版本的页面行为',evidence:[],startedAt:time,completedAt:null}],
  todos:[],integratedDeliveryIds:[],integrationRevision:null,finalAcceptance:null,next:'接口与工作台并行推进；验收完成后由指挥确认阶段，再整合。',revision:100,createdAt:time-600000,updatedAt:time
};
const fixture = {
  version: 1,
  clock: time,
  workOverview:{works:[work],commanders:[{commanderId:'commander-demo',label:'项目指挥',defaultQuota:2,lastGrantedAt:time}],poolPolicy,total:1,observedAtMs:time,truncated:false,accountErrors:{}},
  errorRecords:Array.from({length:5},(_,index)=>({errorId:index+1,taskId:'task-complete',workId:'work-demo',accountAlias:'account-demo',category:'model_busy',commandId:`busy-command-${index}`,occurrenceKey:`mock-busy-${index}`,occurredAt:time-60000+index*5000,recoveredAt:time,summary:'模型繁忙；此回合已明确未执行，恢复后继续完成。'})),
  nativeErrorCoverage:{'task-complete':true,'task-approval':true,'task-unknown':null},
  capabilities: {
    selectedApiVersion: { major: 1, minor: 0 }, daemonVersion: '0.1.0-mock', instanceId: 'mock-instance', storeId: 'mock-store', servedAtMs: time,
    capabilities: caps,
    limits: { requestBytes: 524288, responseBytes: 262144, chunkBytes: 65536, taskPageItems: 100, approvalPageItems: 50, artifactPageItems: 100, approvalSnapshotBytes: 8388608, editorFileBytes: 2097152 },
    runtime: { platform: 'linux', supportedOfficialVersions: ['3.16.3'] },
  },
  overview: {
    accounts, workers, workspaces,
    tasks: details.map(({ taskId, workspaceId, workerId, status, revision, leaseHeld, retry }) => ({
      taskId, workspaceId, workerId, status, revision, leaseHeld, retry,
    })),
  },
  details: Object.fromEntries(details.map((d) => [d.taskId, d])),
  reviews: { 'approval-demo': review },
  approvalContents: { 'review-demo': approvalText },
  manifests: { 'task-complete': manifest },
  files: { [manifestHash]: files },
  fileContents: content,
  patches: { 'task-complete': patch },
  events: details.flatMap((d) => [{ taskId: d.taskId, revision: d.revision, type: 'status', status: d.status, createdAt: time }]),
};

await writeFile(new URL('../test/fixtures/pool-demo.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
