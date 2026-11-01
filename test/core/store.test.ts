import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CoreError, DurableTaskStore, MAX_WAIT_MS, MAX_POOL_CONCURRENT_TASKS, type DispatchInput, type TaskResult } from '../../src/core/index.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'zcode-core-'));
  const databasePath = join(directory, 'state.db');
  const store = new DurableTaskStore(databasePath, { pollIntervalMs: 5 });
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  return { store, databasePath };
}

function workspace(store: DurableTaskStore, workspaceId = 'workspace') {
  return store.registerWorkspace({
    workspaceId, repositoryPath: '/repo', worktreePath: `/worktrees/${workspaceId}`,
    branch: `task/${workspaceId}`, baseCommit: '0123456789abcdef',
  });
}

function dispatch(store: DurableTaskStore, input: Partial<DispatchInput> = {}) {
  return store.dispatch({ requestId: 'request', workspaceId: 'workspace', workerId: 'worker', prompt: 'Change code', ...input }).task;
}

function code(expected: string) {
  return (error: unknown) => error instanceof CoreError && error.code === expected;
}

function child(databasePath: string, action: string, args: string[] = []) {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./child.ts', import.meta.url)), databasePath, action, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: process.stdout! })[Symbol.asyncIterator]();
  let errorOutput = '';
  process.stderr!.on('data', (chunk: Buffer) => { errorOutput += chunk.toString(); });
  return {
    process,
    line: async () => {
      const line = await lines.next();
      assert.equal(line.done, false, `Child exited unexpectedly: ${errorOutput}`);
      return line.value!;
    },
  };
}

async function kill(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  const exited = once(process, 'exit');
  process.kill('SIGKILL');
  await exited;
}

test('request IDs are durable, compare normalized payloads, and never create duplicate events', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  const input = { requestId: 'key', workspaceId: 'workspace', prompt: 'Implement', executionPolicy: { b: 2, a: 1 } } as const;
  const first = store.dispatch(input);
  assert.equal(first.created, true);
  assert.equal(store.dispatch({ ...input, session: 'continue', executionPolicy: { a: 1, b: 2 } }).created, false);
  assert.equal(store.listEvents(first.task.taskId).length, 1);
  assert.throws(() => store.dispatch({ ...input, prompt: 'Different work' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.dispatch({ ...input, workerId: 'different' }), code('IDEMPOTENCY_CONFLICT'));
  store.close();
  const reopened = new DurableTaskStore(databasePath);
  t.after(() => reopened.close());
  assert.equal(reopened.dispatch(input).task.taskId, first.task.taskId);
  assert.equal(reopened.listTasks().length, 1);
  assert.equal(reopened.getTask(first.task.taskId).revision, reopened.listEvents(first.task.taskId)[0]!.revision);
});

test('pool policy persists bounded limits and zero across reopen while null preserves unlimited admission', async t => {
  const {store,databasePath}=await fixture(t);
  assert.deepEqual(store.getPoolPolicy(),{maxConcurrentTasks:null,occupiedSlots:0,availableSlots:null});
  store.setPoolPolicy({maxConcurrentTasks:MAX_POOL_CONCURRENT_TASKS});
  assert.deepEqual(store.getPoolPolicy(),{maxConcurrentTasks:64,occupiedSlots:0,availableSlots:64});
  for(const invalid of [-1,0.5,MAX_POOL_CONCURRENT_TASKS+1,Infinity,NaN,undefined,'2']) {
    assert.throws(()=>store.setPoolPolicy({maxConcurrentTasks:invalid as number}),code('INVALID_ARGUMENT'));
  }
  store.setPoolPolicy({maxConcurrentTasks:0});store.close();
  const reopened=new DurableTaskStore(databasePath);t.after(()=>reopened.close());
  workspace(reopened);
  assert.deepEqual(reopened.getPoolPolicy(),{maxConcurrentTasks:0,occupiedSlots:0,availableSlots:0});
  assert.throws(()=>dispatch(reopened),code('POOL_CAPACITY_REACHED'));
  assert.equal(reopened.listTasks().length,0);
  reopened.setPoolPolicy({maxConcurrentTasks:null});dispatch(reopened);
  assert.deepEqual(reopened.getPoolPolicy(),{maxConcurrentTasks:null,occupiedSlots:1,availableSlots:null});
});

test('lowering the pool limit preserves queued, approval, verification and uncertain task leases without adding a queue', async t => {
  const {store}=await fixture(t);workspace(store);workspace(store,'second');workspace(store,'third');
  const one=dispatch(store);
  const two=dispatch(store,{requestId:'second',workspaceId:'second',workerId:'second'});
  store.beginDispatch(one.taskId);store.acknowledgeDispatch(one.taskId,{sessionId:'native-one',turnId:'request'});
  store.transitionTask(one.taskId,'waiting_approval');
  store.beginDispatch(two.taskId);store.markInterrupted(two.taskId);
  const before=store.listTasks(),revision=store.getRevision();
  assert.deepEqual(store.setPoolPolicy({maxConcurrentTasks:1}),{maxConcurrentTasks:1,occupiedSlots:2,availableSlots:0});
  assert.deepEqual(store.listTasks(),before);assert.equal(store.getRevision(),revision);
  const next={requestId:'third',workspaceId:'third',workerId:'third'};
  assert.throws(()=>dispatch(store,next),code('POOL_CAPACITY_REACHED'));
  store.setPoolPolicy({maxConcurrentTasks:0});
  assert.equal(store.dispatch({requestId:'request',workspaceId:'workspace',workerId:'worker',prompt:'Change code'}).created,false);
  assert.throws(()=>store.dispatch({requestId:'request',workspaceId:'workspace',workerId:'worker',prompt:'Different'}),code('IDEMPOTENCY_CONFLICT'));
  store.transitionTask(one.taskId,'verifying',{executionStopped:{kind:'runtime_terminal',evidence:'Observed exact terminal turn'}});
  assert.equal(store.getPoolPolicy().occupiedSlots,2);
  store.setPoolPolicy({maxConcurrentTasks:1});
  store.completeTask(one.taskId,{summary:'Verified'},{status:'succeeded'});
  assert.throws(()=>dispatch(store,next),code('POOL_CAPACITY_REACHED'));
  assert.equal(store.findTaskByRequestId('third'),null);assert.equal(store.getWorkspace('third').activeTaskId,null);
  store.transitionTask(two.taskId,'failed',{executionStopped:{kind:'history_stopped',evidence:'Exact original native turn stopped'}});
  const admitted=dispatch(store,next);
  assert.equal(admitted.status,'queued');
  assert.deepEqual(store.getPoolPolicy(),{maxConcurrentTasks:1,occupiedSlots:1,availableSlots:0});
  assert.throws(()=>dispatch(store,{requestId:'fourth',workspaceId:'workspace',workerId:'fourth'}),code('POOL_CAPACITY_REACHED'));
});

test('version-three migration preserves existing occupancy and defaults the new pool policy to unlimited',async t=>{
  const {store,databasePath}=await fixture(t);workspace(store);const task=dispatch(store);const storeId=store.storeId;store.close();
  const legacy=new DatabaseSync(databasePath);try{legacy.exec('DROP TABLE pool_policy; PRAGMA user_version = 3;');}finally{legacy.close();}
  const migrated=new DurableTaskStore(databasePath);t.after(()=>migrated.close());
  assert.equal(migrated.storeId,storeId);assert.equal(migrated.getTask(task.taskId).leaseHeld,true);
  assert.deepEqual(migrated.getPoolPolicy(),{maxConcurrentTasks:null,occupiedSlots:1,availableSlots:null});
});

function downgradeToVersionOne(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`BEGIN IMMEDIATE;
      DROP TABLE task_attempts;
      ALTER TABLE tasks DROP COLUMN current_command_id;
      ALTER TABLE tasks DROP COLUMN busy_retry_count;
      ALTER TABLE tasks DROP COLUMN cancel_requested_at;
      ALTER TABLE tasks DROP COLUMN runtime_binding;
      PRAGMA user_version = 1;
      COMMIT;`);
  } finally {database.close();}
}

test('version-one migration preserves leases, immutable results, original request payloads and safe legacy bindings',async t=>{
  const {store,databasePath}=await fixture(t);workspace(store);workspace(store,'finished-workspace');
  const policy={mode:'build',modelId:'GLM-5.3-Flash',verifyCommands:[]};
  const input={requestId:'legacy',workspaceId:'workspace',workerId:'worker',prompt:'Legacy original',executionPolicy:policy};
  const pending=store.dispatch(input).task;store.beginDispatch(pending.taskId);store.bindSession(pending.taskId,'native');
  const done=dispatch(store,{requestId:'finished',workspaceId:'finished-workspace',workerId:'finished-worker'});
  store.beginDispatch(done.taskId);store.transitionTask(done.taskId,'verifying',{executionStopped:{kind:'runtime_terminal',evidence:'Finished'}});
  store.completeTask(done.taskId,{summary:'Immutable old result'},{status:'succeeded'});const result=store.getResult(done.taskId);
  store.close();downgradeToVersionOne(databasePath);
  const raw=new DatabaseSync(databasePath);const before=raw.prepare('SELECT payload FROM tasks WHERE task_id = ?').get(pending.taskId);raw.close();
  const migrated=new DurableTaskStore(databasePath);t.after(()=>migrated.close());
  assert.equal(migrated.getTask(pending.taskId).leaseHeld,true);assert.equal(migrated.getTask(pending.taskId).currentCommandId,'legacy');
  assert.equal(migrated.getTask(pending.taskId).runtimeBinding,null);assert.equal(migrated.getCurrentAttempt(pending.taskId)!.commandId,'legacy');
  assert.deepEqual(migrated.getResult(done.taskId),result);assert.equal(migrated.getTask(done.taskId).leaseHeld,false);
  assert.equal(migrated.dispatch({...input,executionPolicy:{...policy,busyRetryLimit:3}}).created,false,'new default must not invalidate old request identity');
  assert.throws(()=>migrated.dispatch({...input,executionPolicy:{...policy,busyRetryLimit:0}}),code('IDEMPOTENCY_CONFLICT'));
  migrated.recordAttemptFailure(pending.taskId,'legacy',{category:'model_busy',busyRetryEligible:true});
  migrated.recordAttemptTerminal(pending.taskId,'legacy','failed',{kind:'history_stopped',evidence:'Exact stopped busy turn'});
  assert.throws(()=>migrated.beginBusyContinuation(pending.taskId,'legacy',3),code('INVALID_TRANSITION'),'legacy provider/account identity must never be guessed');
  const check=new DatabaseSync(databasePath);try{assert.deepEqual(check.prepare('SELECT payload FROM tasks WHERE task_id = ?').get(pending.taskId),before);}finally{check.close();}
});

test('concurrent processes recheck version one under the migration write lock',async t=>{
  const {store,databasePath}=await fixture(t);workspace(store);dispatch(store);store.close();downgradeToVersionOne(databasePath);
  const blocker=new DatabaseSync(databasePath);blocker.exec('BEGIN IMMEDIATE');
  const first=child(databasePath,'open');const second=child(databasePath,'open');
  t.after(async()=>{await kill(first.process);await kill(second.process);});
  await delay(100);blocker.exec('COMMIT');blocker.close();
  assert.deepEqual(JSON.parse(await first.line()),{tasks:1});assert.deepEqual(JSON.parse(await second.line()),{tasks:1});
  const migrated=new DurableTaskStore(databasePath);t.after(()=>migrated.close());assert.equal(migrated.listTasks().length,1);
});

test('busy continuation intent, attempt identity and cancellation survive reopen without releasing occupancy',async t=>{
  const {store,databasePath}=await fixture(t);workspace(store);
  const task=dispatch(store,{executionPolicy:{busyRetryLimit:3}});
  store.beginDispatch(task.taskId,{runtimeBinding:{accountAlias:'original',providerId:'account:zai-start-plan',modelId:'GLM-5.3-Flash'}});store.bindSession(task.taskId,'native');
  store.acknowledgeDispatch(task.taskId,{sessionId:'native',turnId:'request'});
  store.recordAttemptFailure(task.taskId,'request',{category:'model_busy',busyRetryEligible:true});
  store.recordAttemptTerminal(task.taskId,'request','failed',{kind:'history_stopped',evidence:'Current native failed with no active work'});
  const next=store.beginBusyContinuation(task.taskId,'request',3);assert.equal(next.requestId,'request');assert.notEqual(next.currentCommandId,'request');assert.equal(next.turnId,null);
  assert.equal(next.leaseHeld,true);assert.equal(store.hasEnteredVerification(task.taskId),false);assert.equal(store.getResult(task.taskId),null);
  assert.throws(()=>store.beginBusyContinuation(task.taskId,'request',3),code('RUNTIME_REFERENCE_CONFLICT'));
  store.requestCancellation(task.taskId);store.close();const reopened=new DurableTaskStore(databasePath);t.after(()=>reopened.close());reopened.recoverInterruptedTasks();
  const persisted=reopened.getTask(task.taskId);assert.equal(persisted.currentCommandId,next.currentCommandId);assert.equal(persisted.busyRetryCount,1);assert.notEqual(persisted.cancelRequestedAt,null);
  assert.equal(reopened.listAttempts(task.taskId).length,2);assert.equal(reopened.getCurrentAttempt(task.taskId)!.acknowledgedAt,null);assert.equal(persisted.leaseHeld,true);
  assert.throws(()=>reopened.beginDispatch(task.taskId),code('DISPATCH_ALREADY_ATTEMPTED'));
  reopened.recordAttemptFailure(task.taskId,next.currentCommandId,{category:'model_busy',busyRetryEligible:true});
  reopened.recordAttemptTerminal(task.taskId,next.currentCommandId,'failed',{kind:'history_stopped',evidence:'Exact continuation stopped'});
  assert.throws(()=>reopened.beginBusyContinuation(task.taskId,next.currentCommandId,3),code('CANCEL_REQUESTED'));
});

test('workspace and worker leases are transactional and uncertain tasks retain them', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  workspace(store, 'second');
  const task = dispatch(store);
  const other = new DurableTaskStore(databasePath);
  t.after(() => other.close());
  assert.throws(() => dispatch(other, { requestId: 'second', workerId: 'other' }), code('WORKSPACE_BUSY'));
  assert.throws(() => dispatch(other, { requestId: 'second', workspaceId: 'second' }), code('WORKER_BUSY'));
  store.beginDispatch(task.taskId);
  store.markBlocked(task.taskId, { category: 'risk_blocked' });
  assert.equal(other.getTask(task.taskId).leaseHeld, true);
  assert.throws(() => other.setWorkspaceState('workspace', 'abandoned'), code('WORKSPACE_BUSY'));
  assert.throws(() => store.observeExecutionStopped(task.taskId, { kind: 'not_dispatched', evidence: 'No response' }), code('INVALID_STOP_PROOF'));
  store.markInterrupted(task.taskId, { category: 'timeout' });
  assert.equal(other.getWorkspace('workspace').activeTaskId, task.taskId);
  assert.throws(() => store.transitionTask(task.taskId, 'cancelled'), code('EXECUTION_NOT_STOPPED'));
  store.observeExecutionStopped(task.taskId, { kind: 'process_exited', evidence: 'Matched PID and process start time are absent' });
  assert.equal(other.getWorkspace('workspace').activeTaskId, null);
  assert.equal(dispatch(other, { requestId: 'replacement' }).status, 'queued');
});

test('a committed dispatch intent survives SIGKILL and recovery never permits replay', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  store.close();
  const fixtureChild = child(databasePath, 'intent');
  t.after(() => kill(fixtureChild.process));
  const { taskId } = JSON.parse(await fixtureChild.line()) as { taskId: string };
  await kill(fixtureChild.process);
  const reopened = new DurableTaskStore(databasePath);
  t.after(() => reopened.close());
  assert.equal(reopened.getTask(taskId).status, 'dispatching');
  const recovered = reopened.recoverInterruptedTasks();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.status, 'interrupted');
  assert.equal(recovered[0]!.leaseHeld, true);
  assert.equal(reopened.recoverInterruptedTasks().length, 0);
  assert.throws(() => reopened.beginDispatch(taskId), code('DISPATCH_ALREADY_ATTEMPTED'));
  const duplicate = reopened.dispatch({ requestId: 'request', workspaceId: 'workspace', workerId: 'worker', prompt: 'Durability fixture' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.taskId, taskId);
  assert.deepEqual(reopened.listEvents(taskId).map((event) => event.type), ['task_created', 'dispatch_intent', 'recovery_interrupted']);
  assert.equal(reopened.getTask(taskId).revision, reopened.listEvents(taskId).at(-1)!.revision);
});

test('a committed continuation intent survives SIGKILL without replaying the stopped busy attempt',async t=>{
  const {store,databasePath}=await fixture(t);workspace(store);store.close();
  const fixtureChild=child(databasePath,'continue-intent');t.after(()=>kill(fixtureChild.process));
  const {taskId}=JSON.parse(await fixtureChild.line()) as {taskId:string};await kill(fixtureChild.process);
  const reopened=new DurableTaskStore(databasePath);t.after(()=>reopened.close());
  const before=reopened.getTask(taskId);assert.equal(before.status,'dispatching');assert.equal(before.requestId,'request');assert.notEqual(before.currentCommandId,'request');assert.equal(before.busyRetryCount,1);
  reopened.recoverInterruptedTasks();const task=reopened.getTask(taskId);
  assert.equal(task.currentCommandId,before.currentCommandId);assert.equal(task.leaseHeld,true);assert.equal(task.turnId,null);assert.equal(task.executionStopped,false);assert.equal(reopened.hasEnteredVerification(taskId),false);
  assert.equal(reopened.listAttempts(taskId).length,2);assert.equal(reopened.getCurrentAttempt(taskId)!.acknowledgedAt,null);assert.equal(reopened.getResult(taskId),null);
  assert.throws(()=>reopened.beginDispatch(taskId),code('DISPATCH_ALREADY_ATTEMPTED'));assert.throws(()=>reopened.beginBusyContinuation(taskId,'request',3),code('RUNTIME_REFERENCE_CONFLICT'));
  assert.equal(reopened.dispatch({requestId:'request',workspaceId:'workspace',workerId:'worker',prompt:'Durability fixture'}).created,false);
  assert.equal(reopened.listEvents(taskId).filter(event=>event.type==='busy_continue_intent').length,1);
});

test('racing processes can claim a workspace only once', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  const first = child(databasePath, 'race', ['workspace', 'worker-one', 'request-one']);
  const second = child(databasePath, 'race', ['workspace', 'worker-two', 'request-two']);
  t.after(async () => { await kill(first.process); await kill(second.process); });
  assert.equal(await first.line(), 'ready');
  assert.equal(await second.line(), 'ready');
  first.process.stdin!.write('go');
  second.process.stdin!.write('go');
  const results = await Promise.all([first.line(), second.line()]);
  assert.equal(results.map((line) => JSON.parse(line)).filter((value) => value.taskId).length, 1);
  assert.equal(results.map((line) => JSON.parse(line)).filter((value) => value.error === 'WORKSPACE_BUSY').length, 1);
  assert.equal(store.listTasks().length, 1);
  assert.equal(store.listEvents(store.listTasks()[0]!.taskId).length, 1);
});

test('racing processes on different workspaces share one durable pool admission limit', async t => {
  const {store,databasePath}=await fixture(t);workspace(store);workspace(store,'second');
  store.setPoolPolicy({maxConcurrentTasks:1});
  const first=child(databasePath,'race',['workspace','worker-one','request-one']);
  const second=child(databasePath,'race',['second','worker-two','request-two']);
  t.after(async()=>{await kill(first.process);await kill(second.process);});
  assert.equal(await first.line(),'ready');assert.equal(await second.line(),'ready');
  first.process.stdin!.write('go');second.process.stdin!.write('go');
  const results=(await Promise.all([first.line(),second.line()])).map(line=>JSON.parse(line));
  assert.equal(results.filter(value=>value.taskId).length,1);
  assert.equal(results.filter(value=>value.error==='POOL_CAPACITY_REACHED').length,1);
  assert.equal(store.listTasks().length,1);
  assert.deepEqual(store.getPoolPolicy(),{maxConcurrentTasks:1,occupiedSlots:1,availableSlots:0});
});

test('worker selection acquires its lease before recording a dispatch intent', async (t) => {
  const { store } = await fixture(t);
  workspace(store);
  workspace(store, 'second');
  const one = dispatch(store, { workerId: undefined });
  const two = dispatch(store, { requestId: 'two', workspaceId: 'second', workerId: undefined });
  store.beginDispatch(one.taskId, { workerId: 'chosen' });
  assert.throws(() => store.beginDispatch(two.taskId, { workerId: 'chosen' }), code('WORKER_BUSY'));
  assert.equal(store.getTask(two.taskId).status, 'queued');
  assert.equal(store.getTask(two.taskId).dispatchAttemptedAt, null);
  assert.equal(store.listEvents(two.taskId).length, 1);
  assert.equal(store.beginDispatch(two.taskId, { workerId: 'another' }).workerId, 'another');
});

test('native session identity is persisted before send and cannot be rebound', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  const task = dispatch(store);
  assert.throws(() => store.bindSession(task.taskId, 'native'), code('INVALID_TRANSITION'));
  store.beginDispatch(task.taskId);
  const bound = store.bindSession(task.taskId, 'native');
  assert.equal(bound.status, 'dispatching');
  assert.equal(bound.sessionId, 'native');
  assert.equal(store.bindSession(task.taskId, 'native').revision, bound.revision);
  assert.throws(() => store.bindSession(task.taskId, 'other'), code('RUNTIME_REFERENCE_CONFLICT'));
  store.close();
  const reopened = new DurableTaskStore(databasePath);
  t.after(() => reopened.close());
  assert.equal(reopened.recoverInterruptedTasks()[0]!.sessionId, 'native');
  assert.equal(reopened.getTask(task.taskId).leaseHeld, true);
});

test('verification holds both leases and final result metadata is immutable and durable', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  const task = dispatch(store);
  store.beginDispatch(task.taskId);
  store.acknowledgeDispatch(task.taskId, { sessionId: 'session', turnId: 'turn' });
  assert.throws(() => store.transitionTask(task.taskId, 'verifying'), code('EXECUTION_NOT_STOPPED'));
  store.transitionTask(task.taskId, 'verifying', { executionStopped: { kind: 'runtime_terminal', evidence: 'turn completed' } });
  assert.equal(store.getTask(task.taskId).leaseHeld, true);
  assert.throws(() => dispatch(store, { requestId: 'two' }), code('WORKSPACE_BUSY'));
  const result: TaskResult = {
    summary: 'Finished', changedFiles: ['src/code.ts'], verification: [{ command: 'npm test', exitCode: 0 }],
    artifacts: [{ kind: 'patch', path: '/artifacts/task.patch', sha256: 'b'.repeat(64), sizeBytes: 123 }],
  };
  assert.equal(store.completeTask(task.taskId, result, { status: 'succeeded' }).leaseHeld, false);
  const revision = store.getTask(task.taskId).revision;
  store.recordResult(task.taskId, result);
  assert.equal(store.getTask(task.taskId).revision, revision);
  assert.throws(() => store.recordResult(task.taskId, { ...result, summary: 'Replacement' }), code('RESULT_IMMUTABLE'));
  result.artifacts![0]!.sizeBytes = 900;
  assert.equal(store.getResult(task.taskId)!.artifacts[0]!.sizeBytes, 123);
  const raw = new DatabaseSync(databasePath);
  try { assert.throws(() => raw.prepare('UPDATE task_results SET payload = ? WHERE task_id = ?').run('{}', task.taskId), /immutable/); }
  finally { raw.close(); }
  store.close();
  const reopened = new DurableTaskStore(databasePath);
  t.after(() => reopened.close());
  assert.equal(reopened.getTask(task.taskId).status, 'succeeded');
  assert.equal(reopened.getResult(task.taskId)!.artifacts[0]!.sizeBytes, 123);
});

test('completed result and task state survive an abrupt process death together', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  store.close();
  const fixtureChild = child(databasePath, 'result');
  t.after(() => kill(fixtureChild.process));
  const { taskId } = JSON.parse(await fixtureChild.line()) as { taskId: string };
  await kill(fixtureChild.process);
  const reopened = new DurableTaskStore(databasePath);
  t.after(() => reopened.close());
  assert.equal(reopened.getTask(taskId).status, 'succeeded');
  assert.equal(reopened.getTask(taskId).leaseHeld, false);
  assert.equal(reopened.getResult(taskId)!.summary, 'Immutable delivery');
  assert.equal(reopened.recoverInterruptedTasks().length, 0);
});

test('failed completion rolls back both the result and event revision', async (t) => {
  const { store } = await fixture(t);
  workspace(store);
  const task = dispatch(store);
  store.beginDispatch(task.taskId);
  const before = store.getRevision();
  assert.throws(() => store.completeTask(task.taskId, { summary: 'Premature' }, { status: 'failed' }), code('EXECUTION_NOT_STOPPED'));
  assert.equal(store.getResult(task.taskId), null);
  assert.equal(store.getRevision(), before);
  assert.equal(store.getTask(task.taskId).revision, before);
  assert.throws(() => store.completeTask(task.taskId, { summary: 'Premature success' }, {
    status: 'succeeded', executionStopped: { kind: 'runtime_terminal', evidence: 'stopped' },
  }), code('INVALID_TRANSITION'));
  assert.equal(store.getResult(task.taskId), null);
  assert.equal(store.getTask(task.taskId).executionStopped, false);
});

test('wait observes a change committed before registration and a change immediately after registration', async (t) => {
  const { store } = await fixture(t);
  workspace(store);
  const task = dispatch(store);
  store.appendEvent(task.taskId, 'progress', { message: 'first' });
  const before = await store.wait({ taskIds: [task.taskId], afterRevision: task.revision, timeoutMs: 100 });
  assert.equal(before.timedOut, false);
  assert.deepEqual(before.changedTaskIds, [task.taskId]);
  const pending = store.wait({ taskIds: [task.taskId], afterRevision: before.tasks[0]!.revision, timeoutMs: 100 });
  const event = store.appendEvent(task.taskId, 'progress', { message: 'second' });
  const after = await pending;
  assert.equal(after.timedOut, false);
  assert.equal(after.tasks[0]!.revision, event.revision);
  assert.equal(after.revision, event.revision);
});

test('wait polls external commits, supports per-task cursors, and ignores unrelated changes', async (t) => {
  const { store, databasePath } = await fixture(t);
  workspace(store);
  workspace(store, 'second');
  const one = dispatch(store);
  const two = dispatch(store, { requestId: 'two', workspaceId: 'second', workerId: 'worker-two' });
  const other = new DurableTaskStore(databasePath);
  t.after(() => other.close());
  const input = { taskIds: [one.taskId, two.taskId], afterRevision: { [one.taskId]: one.revision, [two.taskId]: two.revision }, timeoutMs: 200 };
  const pending = store.wait(input);
  input.afterRevision[one.taskId] = 1_000_000;
  const event = other.appendEvent(one.taskId, 'progress', { message: 'outside writer' });
  const result = await pending;
  assert.deepEqual(result.changedTaskIds, [one.taskId]);
  assert.equal(result.tasks[0]!.revision, event.revision);
  const unrelated = store.wait({ taskIds: [one.taskId], afterRevision: event.revision, timeoutMs: 20 });
  other.appendEvent(two.taskId, 'progress', null);
  assert.equal((await unrelated).timedOut, true);
});

test('wait returns bounded snapshots, validates cursors, and closes pending waits', async (t) => {
  const { store } = await fixture(t);
  workspace(store);
  const task = dispatch(store);
  assert.equal((await store.wait({ taskIds: [task.taskId], timeoutMs: 0 })).timedOut, false);
  assert.equal((await store.wait({ taskIds: [task.taskId], afterRevision: task.revision, timeoutMs: 0 })).timedOut, true);
  assert.throws(() => store.wait({ taskIds: [task.taskId], timeoutMs: MAX_WAIT_MS + 1 }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.wait({ taskIds: [task.taskId], afterRevision: {} }), code('INVALID_ARGUMENT'));
  await assert.rejects(store.wait({ taskIds: ['missing'], timeoutMs: 10 }), code('TASK_NOT_FOUND'));
  const pending = store.wait({ taskIds: [task.taskId], afterRevision: task.revision, timeoutMs: 100 });
  const rejection = assert.rejects(pending, code('STORE_CLOSED'));
  store.close();
  await rejection;
});

test('queued cancellation proves it never dispatched, while recovery does not replay queued tasks', async (t) => {
  const { store } = await fixture(t);
  workspace(store);
  const task = dispatch(store);
  assert.equal(store.recoverInterruptedTasks().length, 0);
  const cancelled = store.transitionTask(task.taskId, 'cancelled');
  assert.equal(cancelled.executionStopped, true);
  assert.equal(cancelled.stopProof!.kind, 'not_dispatched');
  assert.equal(cancelled.leaseHeld, false);
  assert.throws(() => store.beginDispatch(task.taskId), code('INVALID_TRANSITION'));
  assert.equal(dispatch(store, { requestId: 'replacement' }).status, 'queued');
});

test('unsafe JSON and stale stop observations cannot partially mutate durable state', async (t) => {
  const { store } = await fixture(t);
  workspace(store);
  assert.throws(() => dispatch(store, { executionPolicy: { invalid: undefined } as never }), code('INVALID_ARGUMENT'));
  assert.throws(() => dispatch(store, { executionPolicy: { invalid: Number.NaN } }), code('INVALID_ARGUMENT'));
  assert.equal(store.listTasks().length, 0);
  const task = dispatch(store);
  store.beginDispatch(task.taskId);
  const before = store.getRevision();
  assert.throws(() => store.observeExecutionStopped(task.taskId, { kind: 'process_exited', evidence: 'old exit', observedAt: 1 }), code('INVALID_STOP_PROOF'));
  assert.equal(store.getRevision(), before);
  assert.equal(store.getTask(task.taskId).leaseHeld, true);
});
