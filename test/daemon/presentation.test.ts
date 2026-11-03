import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_COMPACT_TARGET_BYTES, MCP_MAX_TEXT_BYTES, presentMcpError,
  presentMcpResult, redactPresentationText, utf8Prefix, classifyMcpError,
} from '../../src/shared/presentation.js';

function view(method: string, value: unknown, args: Record<string, unknown> = {}) {
  const presented = presentMcpResult(method, value, args);
  assert.ok(Buffer.byteLength(presented.text, 'utf8') <= MCP_MAX_TEXT_BYTES);
  return { ...presented, value: JSON.parse(presented.text) as any };
}
function task(extra: Record<string, unknown> = {}) {
  return { taskId: 'task-1', workspaceId: 'workspace-1', workerId: 'worker-1', status: 'running', revision: 7, leaseHeld: true, ...extra };
}
const forbidden = 'PRIVATE-NATIVE-CONTEXT-'.repeat(20_000);

test('default polling views are whitelist projections and never repeat native context', () => {
  const native = { raw: forbidden, snapshot: forbidden, history: forbidden, prompt: forbidden, accessToken: forbidden };
  const value = view('overview', {
    ...native,
    accounts: [{ alias: 'account-1', provider: 'zai', health: 'available', ...native }],
    workers: [{ workerId: 'worker-1', accountAlias: 'account-1', state: 'ready', endpoint: { tokenFile: forbidden }, ...native }],
    workspaces: [{ workspaceId: 'workspace-1', branch: 'work', state: 'active', ...native }],
    tasks: [task({ ...native, detail: { summary: forbidden, toolName: 'Edit', arguments: forbidden } })],
  });
  assert.equal(value.isError, undefined);
  assert.ok(Buffer.byteLength(value.text) < 1024, 'small pools should cost far less than the hard budget');
  assert.doesNotMatch(value.text, /PRIVATE-NATIVE-CONTEXT|raw|snapshot|history|prompt|accessToken|tokenFile/);
  assert.equal(value.value.tasks[0].taskId, 'task-1');
  const waited = view('wait', { tasks: [task({ detail: { summary: forbidden, arguments: forbidden } })], changedTaskIds: ['task-1'], timedOut: false, revision: 7, ...native });
  assert.equal(waited.value.tasks[0].revision, 7);
  assert.doesNotMatch(waited.text, /PRIVATE-NATIVE-CONTEXT|summary|arguments/);
});

test('busy overview gives explicit omission counts and remains compact', () => {
  const overview = view('overview', {
    tasks: Array.from({ length: 200 }, (_, index) => task({ taskId: `task-${index}` })),
    workers: Array.from({ length: 100 }, (_, index) => ({ workerId: `worker-${index}`, accountAlias: 'account-1', state: 'ready' })),
  });
  assert.equal(overview.isError, undefined);
  assert.equal(overview.value.omitted.tasks, 190);
  assert.equal(overview.value.omitted.workers, 92);
  assert.equal(overview.value.tasks.at(-1).taskId, 'task-199');
  assert.match(overview.value.nextAction, /local CLI/);
  assert.ok(Buffer.byteLength(overview.text) < MCP_COMPACT_TARGET_BYTES);
});

test('result contains a short UTF-8 summary, exit codes, file counts and a small file preview', () => {
  const presented = view('get_result', {
    task: task({ prompt: forbidden }), result: {
      taskId: 'task-1', summary: '中文😀'.repeat(20_000), raw: forbidden,
      changedFiles: Array.from({ length: 1000 }, (_, index) => `文件-${index}.ts`),
      verification: [{ command: forbidden, exitCode: 0, summary: forbidden }, { exitCode: 1 }],
      artifacts: [{ kind: 'patch', path: forbidden, credentials: forbidden }],
      blockers: ['需要人工检查'],
    },
  });
  assert.equal(presented.isError, undefined);
  assert.ok(Buffer.byteLength(presented.value.result.summary) <= 768);
  assert.equal(presented.value.result.summaryTruncated, true);
  assert.equal(presented.value.result.changedFileCount, 1000);
  assert.equal(presented.value.result.changedFiles.length, 5);
  assert.deepEqual(presented.value.result.verification.map((entry: any) => entry.exitCode), [0, 1]);
  assert.equal(presented.value.result.patchAvailable, true);
  assert.doesNotMatch(presented.text, /PRIVATE-NATIVE-CONTEXT|"command"|"credentials"|"artifacts"/);
});

test('probe exposes only protocol/auth status and numeric quota, never the provider object', () => {
  const projected = view('probe_worker', {
    info: { adapterId: 'official', version: '3.16.3', protocolVersion: 3, authenticated: true, supported: true, raw: forbidden },
    quota: { authenticated: true, generatedAt: 1234, provider: { id: 'account:zai-start-plan', token: forbidden },
      remaining: { count: 500, percentage: 0.5, nextResetTime: 999, identity: forbidden },
      subscription: { identityMasked: forbidden }, context: forbidden, quota: forbidden },
  });
  assert.deepEqual(projected.value.quota.remaining, { count: 500, percentage: 0.5, nextResetTime: 999 });
  assert.doesNotMatch(projected.text, /provider|subscription|context|PRIVATE-NATIVE-CONTEXT/);
  assert.ok(Buffer.byteLength(projected.text) < 1024);
});

test('pool control and overview views expose only numeric policy fields within the MCP budget',()=>{
  const policy={maxConcurrentTasks:0,occupiedSlots:12,availableSlots:0};
  const hostile={...policy,raw:forbidden,prompt:forbidden,accounts:[{credentials:forbidden}]};
  for(const method of ['get_pool_policy','set_pool_policy']){
    const projected=view(method,hostile);
    assert.deepEqual(projected.value,policy);assert.ok(Buffer.byteLength(projected.text)<256);
  }
  assert.deepEqual(view('overview',{poolPolicy:hostile}).value.poolPolicy,policy);
  assert.deepEqual(view('get_pool_policy',{maxConcurrentTasks:null,occupiedSlots:2,availableSlots:null}).value,
    {maxConcurrentTasks:null,occupiedSlots:2,availableSlots:null});
  assert.equal(classifyMcpError(new Error('Pool concurrency limit reached; private diagnostic')),'POOL_CAPACITY_REACHED');
  const error=presentMcpError('POOL_CAPACITY_REACHED','dispatch_task',{request_id:'request',workspace_id:'workspace',worker_id:'worker'});
  assert.equal(JSON.parse(error.text).error,'POOL_CAPACITY_REACHED');
  assert.match(JSON.parse(error.text).message,/did not queue a task/);
  assert.match(JSON.parse(error.text).nextAction,/pool_control/);
  assert.match(JSON.parse(error.text).nextAction,/same request_id/);
});

test('approval controls survive compact polling; truncated persistence never claims full review', () => {
  const approvalId = '审批-😀-保留原样';
  const detail = { approvalId, kind: 'permission', toolName: 'Edit', summary: '需要审阅'.repeat(400),
    approvalLogCursor: 42, truncated: true, detail: { truncated: true, summary: forbidden } };
  const compact = view('wait', { tasks: [task({ status: 'waiting_approval', detail })], changedTaskIds: ['task-1'] });
  const pending = compact.value.tasks[0].pendingApprovals[0];
  assert.equal(pending.approvalId, approvalId);
  assert.equal(pending.kind, 'permission');
  assert.equal(pending.toolName, 'Edit');
  assert.ok(Buffer.byteLength(pending.summary) <= 384);
  assert.equal(pending.reviewComplete, false);
  assert.equal(pending.review.arguments.cursor, 42);
  assert.equal(pending.review.arguments.task_id, 'task-1');
  assert.doesNotMatch(compact.text, /PRIVATE-NATIVE-CONTEXT/);
  const logs = view('get_logs', { events: [{ taskId: 'task-1', revision: 43, type: 'approval_requested', status: 'waiting_approval', detail }] }, { task_id: 'task-1', cursor: 42 });
  assert.equal(logs.value.events[0].detail.approvalId, approvalId);
  assert.equal(logs.value.events[0].detail.reviewComplete, false);
  assert.equal(logs.value.events[0].detail.truncated, true);
  assert.equal(logs.value.nextCursor, 43);
});

test('explicit approval logs show a bounded operation preview without generic arguments or secrets', () => {
  const logs = view('get_logs', { events: [{ taskId: 'task-1', revision: 8, type: 'approval_requested', detail: {
    approvalId: 'approval-1', detail: { kind: 'permission', payload: {
      kind: 'permission', toolName: 'Bash', summary: 'Run a command',
      detail: { command: 'ACCESS_TOKEN=private-token execute', password: forbidden, prompt: forbidden, raw: forbidden },
      options: [{ optionId: 'allowOnce', kind: 'allowOnce', label: 'Allow once', response: { token: forbidden } }],
    } },
  } }] }, { task_id: 'task-1', cursor: 7 });
  const approval = logs.value.events[0].detail;
  assert.equal(approval.approvalId, 'approval-1');
  assert.match(approval.operation.command, /\[redacted\]/);
  assert.equal(approval.operation.omittedArgumentFields, 3);
  assert.equal(approval.reviewComplete, false);
  assert.equal(approval.truncated, true);
  assert.equal(approval.options[0].optionId, 'allowOnce');
  assert.doesNotMatch(logs.text, /PRIVATE-NATIVE-CONTEXT|private-token|"response"/);
});

test('a complete known approval operation remains reviewable through MCP without requiring a UI', () => {
  const logs = view('get_logs', { events: [{ taskId: 'task-1', revision: 8, type: 'approval_requested', detail: {
    approvalId: 'approval-1', kind: 'permission', toolName: 'Edit', detail: { payload: {
      kind: 'permission', toolName: 'Edit', summary: 'Edit a fixture',
      detail: { file_path: '/work/fixture.txt', old_string: 'before', new_string: 'after', replace_all: false },
      options: [{ optionId: 'once', kind: 'allowOnce', label: 'Allow once' }],
    } },
  } }] }, { task_id: 'task-1', cursor: 7 });
  assert.equal(logs.value.events[0].detail.reviewComplete, true);
  assert.equal(logs.value.events[0].detail.reviewHint, undefined);
  assert.equal(logs.value.events[0].detail.operation.new_string, 'after');
});

test('workspace control paths and branch are exact, or explicitly unavailable rather than shortened', () => {
  const branch = 'long-branch-'.repeat(30);
  const path = `/work/${'nested/'.repeat(100)}`;
  const complete = view('create_workspace', { workspaceId: 'workspace-1', branch, repositoryPath: path, worktreePath: `${path}worktree`, baseCommit: 'a'.repeat(40) });
  assert.equal(complete.value.branch, branch);
  assert.equal(complete.value.repositoryPath, path);
  assert.equal(complete.value.worktreePath, `${path}worktree`);
  const oversized = view('create_workspace', { workspaceId: 'workspace-1', branch, repositoryPath: `/${'x'.repeat(3000)}` });
  assert.equal(oversized.isError, true);
  assert.equal(oversized.value.controls.workspaceId, 'workspace-1');
  assert.match(oversized.value.nextAction, /may already have completed/);
});

test('recovery and cancellation views preserve control flags and the stopped task ID', () => {
  const resumed = view('resume_task', { task: task(), operationInProgress: true, finalizing: true, canResume: false, pendingApprovalCount: 100, pendingApprovalsTruncated: true });
  assert.equal(resumed.value.operationInProgress, true);
  assert.equal(resumed.value.finalizing, true);
  assert.equal(resumed.value.canResume, false);
  assert.equal(resumed.value.pendingApprovalCount, 100);
  assert.equal(resumed.value.pendingApprovalsTruncated, true);
  const cancelled = view('cancel_task', { task: task({ executionStopped: true }), cancelRequested: false, terminationConfirmed: true });
  assert.equal(cancelled.value.task.taskId, 'task-1');
  assert.equal(cancelled.value.terminationConfirmed, true);
});

test('resolved approval details retain the decision and ID without advertising a pending request', () => {
  const resolved = { approvalId: 'resolved-approval', decision: 'accept' };
  const waited = view('wait', { tasks: [task({ status: 'running', detail: resolved })], changedTaskIds: ['task-1'] });
  assert.equal(waited.value.tasks[0].pendingApprovals, undefined);
  assert.equal(waited.value.tasks[0].detail.approvalId, 'resolved-approval');
  assert.equal(waited.value.tasks[0].detail.decision, 'accept');
  const logs = view('get_logs', { events: [{ taskId: 'task-1', revision: 8, type: 'status_changed', status: 'running', detail: resolved }] }, { task_id: 'task-1', cursor: 7 });
  assert.deepEqual(logs.value.events[0].detail, resolved);
  assert.equal(logs.value.events[0].detail.reviewComplete, undefined);
});

test('polling retains the total pending approval count and native response acknowledgement flags', () => {
  const waited = view('wait', { tasks: [task({ status: 'waiting_approval', detail: {
    approvalId: 'first-approval', kind: 'permission', toolName: 'Edit',
    pendingApprovalCount: 30, pendingApprovalsTruncated: true,
    approvalResponsePending: true, awaitingNativeRevision: true,
  } })], changedTaskIds: ['task-1'] });
  const projected = waited.value.tasks[0];
  assert.equal(projected.pendingApprovalCount, 30);
  assert.equal(projected.pendingApprovalsTruncated, true);
  assert.equal(projected.pendingApprovals.length, 1, 'polling keeps a small preview and the full count');
  assert.equal(projected.approvalResponsePending, true);
  assert.equal(projected.awaitingNativeRevision, true);
  const response = view('respond_approval', { accepted: true, approvalResponsePending: true, awaitingNativeRevision: true, pendingApprovalCount: 2 }, { task_id: 'task-1', approval_id: 'first-approval' });
  assert.equal(response.value.approvalResponsePending, true);
  assert.equal(response.value.awaitingNativeRevision, true);
  assert.equal(response.value.pendingApprovalCount, 2);
  assert.equal(response.value.approvalId, 'first-approval');
});

test('approval acknowledgement logs retain the responded ID as audit data rather than a pending request', () => {
  const logs = view('get_logs', { events: [{ taskId: 'task-1', revision: 8, type: 'approval_response_sent', status: 'waiting_approval', detail: {
    respondedApprovalId: 'approval-response-1', decision: 'accept', raw: forbidden,
  } }] }, { task_id: 'task-1', cursor: 7 });
  assert.equal(logs.value.events[0].detail.respondedApprovalId, 'approval-response-1');
  assert.equal(logs.value.events[0].detail.decision, 'accept');
  assert.equal(logs.value.events[0].detail.reviewComplete, undefined);
  assert.equal(logs.value.nextCursor, 8);
  assert.doesNotMatch(logs.text, /PRIVATE-NATIVE-CONTEXT/);
});

test('persisted native errors give fixed actionable diagnostics without echoing the native message', () => {
  const logs = view('get_logs', { events: [{ taskId: 'task-1', revision: 8, type: 'error', detail: { category: 'auth_invalid', message: forbidden } }] }, { task_id: 'task-1', cursor: 7 });
  assert.equal(logs.value.events[0].diagnostic.code, 'AUTH_INVALID');
  assert.match(logs.value.events[0].diagnostic.message, /authentication/);
  assert.doesNotMatch(logs.text, /PRIVATE-NATIVE-CONTEXT/);
});

test('busy retry polling exposes only counts and the fixed reason in every task view', () => {
  const retry = { used: 2, max: null, reason: 'model_busy', error: forbidden, raw: forbidden, prompt: forbidden, context: forbidden, commandId: forbidden };
  const own = task({ retry, detail: { reason: forbidden, error: forbidden, category: 'model_busy', retry } });
  const responses = [
    view('overview', { tasks: [own] }),
    view('wait', { tasks: [own], changedTaskIds: ['task-1'] }),
    view('get_result', { task: own, result: null }),
    view('dispatch_task', { task: own, created: true }),
    view('resume_task', { task: own }), view('reconcile_task', { task: own }),
  ];
  for (const response of responses) {
    const projected = response.value.task ?? response.value.tasks[0];
    assert.deepEqual(projected.retry, { used: 2, max: null, reason: 'model_busy' });
    assert.equal(projected.diagnostic.code, 'MODEL_BUSY');
    assert.doesNotMatch(response.text, /PRIVATE-NATIVE-CONTEXT|"context"|"prompt"|"raw"|"commandId"/);
    assert.ok(Buffer.byteLength(response.text) < MCP_COMPACT_TARGET_BYTES);
  }
  assert.deepEqual(view('wait', { tasks: [task({ retry: { used: 400, max: 3, reason: 'transient_fault' } })] }).value.tasks[0].retry, { used: 400, max: null, reason: 'transient_fault' });
  const unused = view('wait', { tasks: [task()], changedTaskIds: [] });
  assert.equal(unused.value.tasks[0].retry, undefined);
  for (const invalid of [
    { used: -1, max: null, reason: 'model_busy' },
    { used: 1.5, max: null, reason: 'model_busy' }, { used: 1, max: null, reason: forbidden },
  ]) assert.equal(view('wait', { tasks: [task({ retry: invalid })] }).value.tasks[0].retry, undefined);
});

test('busy continuation logs retain counts without native context or failure text', () => {
  const logs = view('get_logs', { events: [{ taskId: 'task-1', revision: 8, type: 'busy_continue_intent', detail: {
    retry: { used: 1, max: null, reason: 'model_busy', raw: forbidden, context: forbidden },
    reason: forbidden, error: forbidden, previousCommandId: forbidden, commandId: forbidden,
  } }] }, { task_id: 'task-1', cursor: 7 });
  assert.deepEqual(logs.value.events[0].detail, { retry: { used: 1, max: null, reason: 'model_busy' } });
  assert.equal(logs.value.events[0].detailOmitted, true);
  assert.equal(logs.value.nextCursor, 8);
  assert.doesNotMatch(logs.text, /PRIVATE-NATIVE-CONTEXT|"context"|"raw"|"previousCommandId"|"commandId"/);
});

test('busy retry tasks retain fixed inspection guidance after recovery becomes uncertain', () => {
  const retry = { used: 1, max: null, reason: 'model_busy' };
  for (const detail of [
    { requiresInspection: true, reason: forbidden },
    { requiresInspection: true, reason: forbidden, message: forbidden },
  ]) {
    const waited = view('wait', { tasks: [task({ retry, detail })], changedTaskIds: ['task-1'] });
    const projected = waited.value.tasks[0];
    assert.equal(projected.detail.requiresInspection, true);
    assert.equal(projected.diagnostic.code, 'RECOVERY_REQUIRED');
    assert.match(projected.nextAction, /Inspect local task records/);
    assert.deepEqual(projected.retry, retry);
    assert.doesNotMatch(waited.text, /PRIVATE-NATIVE-CONTEXT/);
  }
  const failed = view('get_result', { task: task({ retry, detail: {
    requiresInspection: true, category: 'auth_invalid', message: forbidden, reason: forbidden,
  } }), result: null });
  assert.equal(failed.value.task.diagnostic.code, 'AUTH_INVALID');
  assert.match(failed.value.task.nextAction, /Inspect local task records/);
  assert.doesNotMatch(failed.text, /PRIVATE-NATIVE-CONTEXT/);
});

test('log budget returns only complete events and advances to the last delivered revision', () => {
  const sourceEvents = Array.from({ length: 12 }, (_, index) => ({ taskId: 'task-1', revision: index + 11, type: 'approval_requested', detail: {
    approvalId: `approval-${index}`, payload: { kind: 'permission', toolName: 'Edit', summary: 'Review change',
      detail: { old_string: '旧😀'.repeat(1000), new_string: '新😀'.repeat(1000), content: '文😀'.repeat(1000), command: 'a'.repeat(2000) } },
  } }));
  let cursor = 10;
  const seen: number[] = [];
  while (seen.length < sourceEvents.length) {
    const page = view('get_logs', { events: sourceEvents.filter(entry => entry.revision > cursor), nextCursor: 22 }, { task_id: 'task-1', cursor });
    assert.equal(page.isError, undefined);
    assert.ok(page.value.events.length > 0);
    const revisions = page.value.events.map((entry: any) => entry.revision);
    seen.push(...revisions);
    assert.equal(page.value.nextCursor, revisions.at(-1));
    if (seen.length < sourceEvents.length) {
      assert.equal(page.value.hasMore, true);
      assert.equal(page.value.nextAction.arguments.cursor, page.value.nextCursor);
    }
    cursor = page.value.nextCursor;
  }
  assert.deepEqual(seen, sourceEvents.map(entry => entry.revision));
});

test('diff byte pages preserve UTF-16 offsets, JSON escaping, emoji and the complete source', () => {
  const patch = '中文😀\\"\n'.repeat(4000);
  let offset = 0;
  let reconstructed = '';
  while (offset < patch.length) {
    const nativePage = patch.slice(offset, offset + 8000);
    const sourceNext = offset + nativePage.length < patch.length ? offset + nativePage.length : null;
    const page = view('get_diff', { available: true, text: nativePage, nextOffset: sourceNext, totalCharacters: patch.length }, { task_id: 'task-1', offset, limit: 8000 });
    assert.equal(page.isError, undefined);
    assert.ok(page.value.text.length > 0);
    assert.doesNotMatch(page.value.text, /[\uD800-\uDBFF]$/);
    assert.doesNotMatch(page.value.text, /^[\uDC00-\uDFFF]/);
    reconstructed += page.value.text;
    if (page.value.nextOffset === null) { offset = patch.length; break; }
    assert.equal(page.value.nextOffset, offset + page.value.text.length);
    assert.ok(page.value.nextOffset > offset);
    offset = page.value.nextOffset;
  }
  assert.equal(reconstructed, patch);
});

test('oversized control data gives an actionable error without shortening IDs or advancing cursors', () => {
  const hugeIds = Array.from({ length: 50 }, (_, index) => `任务${index}${'中'.repeat(145)}`);
  const waited = view('wait', { tasks: hugeIds.map(taskId => task({ taskId })), changedTaskIds: hugeIds });
  assert.equal(waited.isError, true);
  assert.equal(waited.value.error, 'OUTPUT_BUDGET_EXCEEDED');
  assert.match(waited.value.nextAction, /Split task_ids/);
  assert.match(waited.value.message, /No identifier.*shortened/);
  const logs = view('get_logs', { events: [{ revision: 8, taskId: 'task-1', type: 'approval_requested', detail: { approvalId: 'a'.repeat(100_000) } }] }, { task_id: 'task-1', cursor: 7 });
  assert.equal(logs.isError, true);
  assert.equal(logs.value.controls.cursor, 7);
  assert.equal(logs.value.controls.task_id, 'task-1');
  assert.match(logs.value.nextAction, /same cursor/);
});

test('unknown methods and error text never echo native errors or context', () => {
  const unknown = view('new_native_method', { raw: forbidden });
  assert.equal(unknown.isError, true);
  assert.equal(unknown.value.error, 'UNSUPPORTED_METHOD');
  const error = presentMcpError('REQUEST_FAILED', 'dispatch_task', { task_id: 'task-1', request_id: 'request-1', prompt: forbidden, raw: forbidden });
  assert.ok(Buffer.byteLength(error.text) <= MCP_MAX_TEXT_BYTES);
  assert.doesNotMatch(error.text, /PRIVATE-NATIVE-CONTEXT|prompt|raw/);
  assert.match(error.text, /request-1/);
  assert.match(error.text, /Never automatically resend/);
});

test('UTF-8 truncation and credential defense are deterministic', () => {
  assert.equal(utf8Prefix('中😀文', 6), '中');
  assert.equal(utf8Prefix('中😀文', 7), '中😀');
  const raw = 'Bearer private-token access_token="private-token" API_KEY=private-key password:private-password';
  const cleaned = redactPresentationText(raw);
  assert.doesNotMatch(cleaned, /private-token|private-key|private-password/);
  assert.equal(redactPresentationText(raw), cleaned);
});

 test('MCP pool account quotas identify stale imports without inferring time or usage units', () => {
  const projected = view('pool_control', { accounts: [{ alias: 'account-1', quota: { total: 500, remaining: 400, updatedAt: 1234, raw: forbidden } }] }, { action: 'read' });
  assert.deepEqual(projected.value.accounts[0].quota, { source: 'imported', freshness: 'stale', observedAtMs: null, unit: 'unknown', total: 500, remaining: 400, updatedAt: { value: 1234, unit: 'unknown' } });
  assert.doesNotMatch(projected.text, /PRIVATE-NATIVE-CONTEXT|"raw"/);
});
