import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test, { type TestContext } from 'node:test';
import { CoreError, DurableTaskStore, type Task } from '../../src/core/index.js';
import { Coordinator } from '../../src/daemon/coordinator.js';
import type {
  OpenSessionInput, RuntimeConnection, RuntimeEvent, RuntimeInfo, SessionRef,
  SessionSnapshot, TurnInput, TurnRef,
} from '../../src/runtime/types.js';

const exec = promisify(execFile);

class BufferedFake implements RuntimeConnection {
  readonly info: RuntimeInfo = {
    adapterId: 'fake', version: '3.16.3', protocolVersion: 1,
    authRequired: false, authenticated: true, supported: true,
  };
  sendCalls = 0;
  closed = false;
  terminalBufferedBeforeAck = false;
  terminal: 'turn_completed' | 'turn_failed' | 'turn_cancelled' | null = 'turn_completed';
  sendError?: Error;
  historyError?: Error;
  onSend?: (session: SessionRef, input: TurnInput) => void | Promise<void>;
  onHistory?: () => void;
  private buffered: RuntimeEvent[] = [];
  private current?: TurnRef;
  private releaseGate!: () => void;
  private gate: Promise<void> | undefined;
  nativeState = 'completedSuccess';
  activeWorks: Record<string, unknown>[] = [];
  sourceCommandId?: string;
  readonly opened: OpenSessionInput[] = [];

  hold(): void { this.gate = new Promise<void>((resolve) => { this.releaseGate = resolve; }); }
  release(): void { this.releaseGate?.(); }

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    this.opened.push(input);
    return { sessionId: input.sessionId ?? 'native-session', workspacePath: input.workspacePath };
  }

  async sendTurn(session: SessionRef, input: TurnInput): Promise<TurnRef> {
    this.sendCalls++;
    await this.onSend?.(session, input);
    this.current = { ...session, turnId: input.requestId!, commandId: input.requestId! };
    if (this.sendError) throw this.sendError;
    this.buffered = [this.event('turn_started')];
    if (this.terminal !== null) this.buffered.push(this.event(this.terminal));
    this.terminalBufferedBeforeAck = this.terminal !== null;
    await Promise.resolve();
    return this.current;
  }

  private event(type: RuntimeEvent['type']): RuntimeEvent {
    return {
      id: `event-${type}`, cursor: String(this.buffered.length + 1), type,
      sessionId: this.current!.sessionId, turnId: this.current!.turnId,
      timestamp: Date.now(), data: {},
    };
  }

  async *events(): AsyncIterable<RuntimeEvent> {
    for (const event of this.buffered) {
      if (event.type !== 'turn_started' && this.gate) await this.gate;
      yield event;
    }
  }

  async syncHistory(session: SessionRef): Promise<SessionSnapshot> {
    this.onHistory?.();
    if (this.historyError) throw this.historyError;
    return {
      ...session, phase: this.nativeState, revision: 1, cursor: '2', summary: 'Fixture completed', pendingApprovals: [],
      raw: { control: { phase: this.nativeState, activeWorks: this.activeWorks }, rows: { window: [
        { kind: 'turnHeader', sourceCommandId: this.sourceCommandId ?? this.current?.commandId ?? 'request', state: this.nativeState },
      ] } },
    };
  }

  async queryCommand(): Promise<'unknown'> { return 'unknown'; }
  async quota(): Promise<Record<string, unknown>> { return {}; }
  async respondApproval(): Promise<void> {}
  async cancel(): Promise<void> {}
  async close(): Promise<void> { this.closed = true; this.release(); }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zcode-coordinator-'));
  const repo = join(root, 'repo');
  await mkdir(repo);
  await exec('git', ['init', '-b', 'trunk', repo]);
  await writeFile(join(repo, 'code.txt'), 'before\n');
  await exec('git', ['-C', repo, 'add', 'code.txt']);
  await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline']);
  const baseCommit = (await exec('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim();
  const store = new DurableTaskStore(join(root, 'scheduler', 'state.db'), { pollIntervalMs: 5 });
  store.registerWorkspace({ workspaceId: 'workspace', repositoryPath: repo, worktreePath: repo, branch: 'trunk', baseCommit });
  const coordinator = new Coordinator(root, store);
  const fake = new BufferedFake();
  Object.defineProperty(coordinator.supervisor, 'status', { value: async () => ({ workerId: 'worker', accountAlias: 'account-fixture', state: 'ready', endpoint: { baseUrl: 'http://127.0.0.1:1' } }), configurable: true });
  Object.defineProperty(coordinator.vault, 'load', { value: async () => ({ alias: 'account-fixture', provider: 'zai', health: 'available' }) });
  Object.defineProperty(coordinator.adapter, 'connect', { value: async () => fake, configurable: true });
  t.after(async () => {
    fake.release();
    await coordinator.close();
    await waitFor(() => coordinator.active.size === 0);
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, repo, store, coordinator, fake };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture condition did not settle');
    await delay(5);
  }
}

async function dispatch(coordinator: Coordinator, extra: Record<string, unknown> = {}) {
  const result = await coordinator.call('dispatch_task', {
    workspace_id: 'workspace', worker_id: 'worker', request_id: 'request', prompt: 'Change the fixture',
    verify_commands: [{ command: process.execPath, args: ['-e', 'process.exit(0)'], timeout_ms: 1000 }],
    ...extra,
  }) as { task: { taskId: string; revision: number }; created: boolean };
  return result;
}

async function completed(store: DurableTaskStore, coordinator: Coordinator, taskId: string): Promise<Task> {
  await waitFor(() => ['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'].includes(store.getTask(taskId).status) && !coordinator.active.has(taskId));
  return store.getTask(taskId);
}

test('coordinator consumes terminal events buffered before ACK and publishes a verified immutable snapshot', async (t) => {
  const { repo, store, coordinator, fake } = await fixture(t);
  fake.onSend = async (session) => {
    const task = store.listTasks()[0]!;
    assert.equal(task.status, 'dispatching');
    assert.equal(task.sessionId, session.sessionId, 'session must survive an ACK loss');
    await writeFile(join(repo, 'code.txt'), 'after\n');
  };
  fake.onHistory = () => {
    const task = store.listTasks()[0]!;
    assert.equal(task.status, 'verifying', 'persist terminal proof before an awaited history read');
    assert.equal(task.executionStopped, true);
    assert.equal(task.leaseHeld, true);
  };
  const dispatched = await dispatch(coordinator);
  const task = await completed(store, coordinator, dispatched.task.taskId);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.leaseHeld, false);
  assert.equal(fake.sendCalls, 1);
  assert.equal(fake.terminalBufferedBeforeAck, true);
  const result = store.getResult(task.taskId)!;
  assert.equal(result.summary, 'Fixture completed');
  assert.equal(result.verification[0]!.exitCode, 0);
  assert.deepEqual(result.changedFiles, ['code.txt']);
  assert.match(await readFile(result.artifacts[0]!.path, 'utf8'), /\+after/);
  const duplicate = await dispatch(coordinator);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.taskId, task.taskId);
  assert.equal(fake.sendCalls, 1);
});

test('preflight failure releases queued occupancy without ever sending a turn', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  Object.defineProperty(coordinator.supervisor, 'status', { value: async () => ({ state: 'stopped' }) });
  const result = await dispatch(coordinator);
  const task = await completed(store, coordinator, result.task.taskId);
  assert.equal(task.status, 'failed');
  assert.equal(task.dispatchAttemptedAt, null);
  assert.equal(task.stopProof!.kind, 'not_dispatched');
  assert.equal(task.leaseHeld, false);
  assert.equal(fake.sendCalls, 0);
  assert.equal(store.getWorkspace('workspace').activeTaskId, null);
});

test('coordinator rejects a second workspace mutation while waiting and wait sees committed progress', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  fake.hold();
  const result = await dispatch(coordinator);
  await waitFor(() => store.getTask(result.task.taskId).status === 'running');
  await assert.rejects(dispatch(coordinator, { request_id: 'second-request' }), (error: unknown) => error instanceof CoreError && error.code === 'WORKSPACE_BUSY');
  const task = store.getTask(result.task.taskId);
  const pending = coordinator.call('wait', { task_ids: [task.taskId], after_revision: task.revision, timeout_sec: 1 });
  fake.release();
  const waited = await pending as { timedOut: boolean; changedTaskIds: string[] };
  assert.equal(waited.timedOut, false);
  assert.deepEqual(waited.changedTaskIds, [task.taskId]);
  assert.equal((await completed(store, coordinator, task.taskId)).status, 'succeeded');
  assert.equal(fake.sendCalls, 1);
});

test('a send timeout retains native session identity, retains occupancy, and never replays', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  fake.sendError = new Error('sendText RPC timed out after possible acceptance');
  const result = await dispatch(coordinator);
  const task = await completed(store, coordinator, result.task.taskId);
  assert.equal(task.status, 'interrupted');
  assert.equal(task.sessionId, 'native-session');
  assert.equal(task.leaseHeld, true);
  assert.equal(task.executionStopped, false);
  assert.equal((await dispatch(coordinator)).created, false);
  assert.equal(fake.sendCalls, 1);
  fake.nativeState = 'running';
  const unknown = await coordinator.call('reconcile_task', { task_id: task.taskId }) as { executionStopped: boolean };
  assert.equal(unknown.executionStopped, false);
  assert.equal(store.getTask(task.taskId).leaseHeld, true);
  fake.nativeState = 'completedSuccess';
  const recovered = await coordinator.call('reconcile_task', { task_id: task.taskId }) as { executionStopped: boolean };
  assert.equal(recovered.executionStopped, true);
  assert.equal(store.getTask(task.taskId).status, 'interrupted');
  assert.equal(store.getTask(task.taskId).leaseHeld, false);
  assert.equal(store.getResult(task.taskId)!.verification.length, 0);
  assert.equal(fake.sendCalls, 1);
});

test('a stream ending without a terminal event becomes interrupted and retains occupancy', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  fake.terminal = null;
  const result = await dispatch(coordinator);
  const task = await completed(store, coordinator, result.task.taskId);
  assert.equal(task.status, 'interrupted');
  assert.equal(task.leaseHeld, true);
  assert.equal(task.executionStopped, false);
  assert.equal(fake.sendCalls, 1);
});

test('a failed history read preserves the terminal stop observation', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  fake.historyError = new Error('History unavailable after authoritative completion');
  const result = await dispatch(coordinator);
  const task = await completed(store, coordinator, result.task.taskId);
  assert.equal(task.status, 'interrupted');
  assert.equal(task.executionStopped, true);
  assert.equal(task.stopProof!.kind, 'runtime_terminal');
  assert.equal(task.leaseHeld, false);
});

test('different workspaces cannot dispatch concurrent tasks to the same worker', async (t) => {
  const { root, store, coordinator, fake } = await fixture(t);
  const original = store.getWorkspace('workspace');
  store.registerWorkspace({ ...original, workspaceId: 'second', worktreePath: join(root, 'second'), branch: 'second' });
  fake.hold();
  const first = await dispatch(coordinator);
  await waitFor(() => store.getTask(first.task.taskId).status === 'running');
  await assert.rejects(dispatch(coordinator, { request_id: 'another', workspace_id: 'second' }),
    (error: unknown) => error instanceof CoreError && error.code === 'WORKER_BUSY');
  assert.equal(store.getWorkspace('second').activeTaskId, null);
  assert.equal(store.listTasks().length, 1);
  fake.release();
  assert.equal((await completed(store, coordinator, first.task.taskId)).status, 'succeeded');
  assert.equal(fake.sendCalls, 1);
});

test('dispatch waits for a pending worker stop before acquiring occupancy or sending', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  let releaseStop!: () => void;
  const gate = new Promise<void>((resolve) => { releaseStop = resolve; });
  let stopping = false;
  let stopped = false;
  Object.defineProperty(coordinator.supervisor, 'stop', { value: async () => {
    stopping = true;
    await gate;
    stopped = true;
    return { workerId: 'worker', stopped: true };
  } });
  Object.defineProperty(coordinator.supervisor, 'status', { value: async () => stopped
    ? { state: 'stopped' }
    : { workerId: 'worker', accountAlias: 'account-fixture', state: 'ready', endpoint: { baseUrl: 'http://127.0.0.1:1' } } });
  const stop = coordinator.call('stop_worker', { worker_id: 'worker' });
  await waitFor(() => stopping);
  const dispatching = dispatch(coordinator);
  t.after(async () => { releaseStop(); await Promise.allSettled([stop, dispatching]); });
  await delay(15);
  assert.equal(fake.sendCalls, 0);
  assert.equal(store.listTasks().length, 0);
  releaseStop();
  await stop;
  const result = await dispatching;
  assert.equal((await completed(store, coordinator, result.task.taskId)).status, 'failed');
  assert.equal(fake.sendCalls, 0);
});

test('read-only recovery never restarts a worker and requires the exact terminal turn with no active work', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  const task = store.dispatch({ requestId: 'request', workspaceId: 'workspace', workerId: 'worker', prompt: 'Unknown acceptance' }).task;
  store.beginDispatch(task.taskId);
  store.bindSession(task.taskId, 'native-session');
  store.markInterrupted(task.taskId);
  let starts = 0;
  Object.defineProperty(coordinator.supervisor, 'start', { value: async () => { starts++; throw new Error('Unexpected start'); } });
  Object.defineProperty(coordinator.supervisor, 'status', { value: async () => ({ state: 'stopped' }), configurable: true });
  const unavailable = await coordinator.call('reconcile_task', { task_id: task.taskId }) as { requiresInspection: boolean };
  assert.equal(unavailable.requiresInspection, true);
  assert.equal(store.getTask(task.taskId).leaseHeld, true);
  Object.defineProperty(coordinator.supervisor, 'status', { value: async () => ({ state: 'ready', endpoint: { baseUrl: 'http://127.0.0.1:1' } }) });
  fake.sourceCommandId = 'another-task';
  assert.equal((await coordinator.call('reconcile_task', { task_id: task.taskId }) as { executionStopped: boolean }).executionStopped, false);
  fake.sourceCommandId = task.requestId;
  fake.activeWorks = [{ sourceCommandId: 'later-task', foregroundExecutionId: 'active' }];
  assert.equal((await coordinator.call('reconcile_task', { task_id: task.taskId }) as { executionStopped: boolean }).executionStopped, false);
  assert.equal(store.getTask(task.taskId).leaseHeld, true);
  fake.activeWorks = [];
  assert.equal((await coordinator.call('reconcile_task', { task_id: task.taskId }) as { executionStopped: boolean }).executionStopped, true);
  assert.equal(store.getTask(task.taskId).leaseHeld, false);
  assert.equal(starts, 0);
  assert.equal(fake.sendCalls, 0);
  assert.equal(fake.opened.length, 3);
  assert.equal(fake.opened.every((input) => input.sessionId === 'native-session'), true);
});

test('successive task snapshots include cumulative workspace delivery and preserve earlier artifacts', async (t) => {
  const { repo, store, coordinator, fake } = await fixture(t);
  fake.onSend = async () => {
    await writeFile(join(repo, 'code.txt'), 'committed by first task\n');
    await exec('git', ['-C', repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-am', 'worker commit']);
  };
  const first = await dispatch(coordinator);
  assert.equal((await completed(store, coordinator, first.task.taskId)).status, 'succeeded');
  const firstResult = store.getResult(first.task.taskId)!;
  const firstPatch = await readFile(firstResult.artifacts[0]!.path, 'utf8');
  assert.match(firstPatch, /\+committed by first task/);
  fake.onSend = async () => { await writeFile(join(repo, 'second.txt'), 'untracked by second task\n'); };
  const second = await dispatch(coordinator, { request_id: 'second' });
  assert.equal((await completed(store, coordinator, second.task.taskId)).status, 'succeeded');
  const secondResult = store.getResult(second.task.taskId)!;
  assert.deepEqual(secondResult.changedFiles, ['code.txt', 'second.txt']);
  assert.match(await readFile(secondResult.artifacts.find((artifact) => artifact.kind === 'patch')!.path, 'utf8'), /\+committed by first task/);
  assert.equal(await readFile(secondResult.artifacts.find((artifact) => artifact.kind === 'untracked')!.path, 'utf8'), 'untracked by second task\n');
  assert.equal(await readFile(firstResult.artifacts[0]!.path, 'utf8'), firstPatch);
  assert.deepEqual(store.getResult(first.task.taskId), firstResult);
  assert.equal(fake.sendCalls, 2);
  assert.equal(fake.opened[1]!.sessionId, 'native-session');
});
