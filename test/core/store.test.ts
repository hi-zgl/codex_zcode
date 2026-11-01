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
import { CoreError, DurableTaskStore, MAX_WAIT_MS, type DispatchInput, type TaskResult } from '../../src/core/index.js';

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
