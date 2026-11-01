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
import { presentMcpResult } from '../../src/shared/presentation.js';
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
      raw: { sessionId: session.sessionId, control: { phase: this.nativeState, activeWorks: this.activeWorks }, rows: { window: [
        { kind: 'turnHeader', rowId: 1, turnId: 'product-turn', sourceCommandId: this.sourceCommandId ?? this.current?.commandId ?? 'request', state: this.nativeState },
        { kind: 'assistantText', rowId: 2, turnId: 'product-turn', text: 'Fixture completed' },
      ] } },
    };
  }

  async queryCommand(): Promise<'unknown'> { return 'unknown'; }
  async quota(): Promise<Record<string, unknown>> { return {}; }
  async respondApproval(_turn: TurnRef, _approvalId: string, _decision: unknown): Promise<void> {}
  async cancel(_turn: TurnRef): Promise<void> {}
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
  Object.defineProperty(coordinator.vault, 'load', { value: async () => ({ alias: 'account-fixture', provider: 'zai', health: 'available' }), configurable: true });
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

test('a failed history read preserves terminal proof and retains verification occupancy for inspection', async (t) => {
  const { store, coordinator, fake } = await fixture(t);
  fake.historyError = new Error('History unavailable after authoritative completion');
  const result = await dispatch(coordinator);
  const task = await completed(store, coordinator, result.task.taskId);
  assert.equal(task.status, 'interrupted');
  assert.equal(task.executionStopped, true);
  assert.equal(task.stopProof!.kind, 'runtime_terminal');
  assert.equal(task.leaseHeld, true);
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

test('RPC pool policy is shared by overview and admission and lowering it never stops a running task', async t => {
  const {root,store,coordinator,fake}=await fixture(t);
  const original=store.getWorkspace('workspace');
  store.registerWorkspace({...original,workspaceId:'second',worktreePath:join(root,'second'),branch:'second'});
  const capabilities=await coordinator.call('ui_capabilities',{bootstrapVersion:1,client:{name:'test',version:'1'},supportedApiMajors:[1]}) as any;
  assert.equal(capabilities.capabilities.poolPolicy.version,1);
  assert.deepEqual(await coordinator.call('get_pool_policy',{}),{maxConcurrentTasks:null,occupiedSlots:0,availableSlots:null});
  await coordinator.call('set_pool_policy',{max_concurrent_tasks:1});fake.hold();
  const first=await dispatch(coordinator);await waitFor(()=>store.getTask(first.task.taskId).status==='running');
  const running=store.getTask(first.task.taskId);
  const paused={maxConcurrentTasks:0,occupiedSlots:1,availableSlots:0};
  assert.deepEqual(await coordinator.call('set_pool_policy',{max_concurrent_tasks:0}),paused);
  assert.deepEqual(store.getTask(running.taskId),running);assert.equal(fake.closed,false);
  assert.equal((await dispatch(coordinator)).created,false);
  await assert.rejects(dispatch(coordinator,{request_id:'second',workspace_id:'second',worker_id:'second'}),
    (error:unknown)=>error instanceof CoreError&&error.code==='POOL_CAPACITY_REACHED');
  assert.equal(store.listTasks().length,1);assert.equal(fake.sendCalls,1);
  assert.deepEqual((await coordinator.call('overview',{}) as any).poolPolicy,paused);
  await assert.rejects(coordinator.call('set_pool_policy',{max_concurrent_tasks:65}),/Invalid parameters/);
  await assert.rejects(coordinator.call('set_pool_policy',{}),/Invalid parameters/);
  fake.release();assert.equal((await completed(store,coordinator,running.taskId)).status,'succeeded');
  assert.deepEqual(await coordinator.call('get_pool_policy',{}),{maxConcurrentTasks:0,occupiedSlots:0,availableSlots:0});
  assert.deepEqual(await coordinator.call('set_pool_policy',{max_concurrent_tasks:null}),{maxConcurrentTasks:null,occupiedSlots:0,availableSlots:null});
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

class RecoveryFake extends BufferedFake {
  pending: Record<string, unknown>[] = [];
  readonly replies: {approvalId: string; decision: unknown}[] = [];
  readonly cancellations: TurnRef[] = [];
  readonly cursors: (string | undefined)[] = [];
  snapshotPatch?: (snapshot: SessionSnapshot) => void;
  private serial = 0;
  private queued: RuntimeEvent[] = [];
  private wake?: () => void;
  constructor() {
    super();
    this.nativeState = 'running';
    this.sourceCommandId = 'request';
    this.activeWorks = [{sourceCommandId:'request',turnId:'product-turn',foregroundExecutionId:'foreground'}];
  }
  override async syncHistory(session: SessionRef): Promise<SessionSnapshot> {
    const snapshot = await super.syncHistory(session);
    snapshot.cursor = String(this.serial);
    snapshot.pendingApprovals = this.pending;
    (snapshot.raw.rows as any).window.push({kind:'toolCall',rowId:3,turnId:'product-turn',toolName:'Edit'});
    this.snapshotPatch?.(snapshot);
    return snapshot;
  }
  emit(type: RuntimeEvent['type'], data: Record<string, unknown> = {}, commandId: string | undefined = 'request'): void {
    if (commandId === 'request' && ['turn_completed','turn_failed','turn_cancelled'].includes(type)) {
      this.nativeState = type==='turn_completed'?'completedSuccess':type==='turn_failed'?'failed':'completedInterrupted';
      this.activeWorks = [];
      this.pending = [];
    }
    const cursor = String(++this.serial);
    this.queued.push({id:`recovered:${cursor}`,cursor,type,data,sessionId:'native-session',turnId:commandId,timestamp:Date.now()});
    this.wake?.();
  }
  override async *events(_session?: SessionRef, cursor?: string): AsyncIterable<RuntimeEvent> {
    this.cursors.push(cursor);
    let after = Number(cursor ?? 0);
    while (!this.closed) {
      const events = this.queued.filter(event=>Number(event.cursor)>after);
      for (const event of events) {after=Number(event.cursor);yield event;}
      if (this.closed) break;
      await new Promise<void>(resolve=>{this.wake=resolve;if(this.closed||this.queued.some(event=>Number(event.cursor)>after))resolve();});
    }
  }
  override async respondApproval(_turn: TurnRef, approvalId: string, decision: unknown): Promise<void> {
    this.replies.push({approvalId,decision});
    this.pending = this.pending.filter(value=>value.interactionId!==approvalId);
  }
  override async cancel(turn: TurnRef): Promise<void> {this.cancellations.push(turn);}
  override async close(): Promise<void> {await super.close();this.wake?.();}
}

function interruptedTask(store: DurableTaskStore, verifyCommands: {command:string;args:string[];timeout_ms:number}[] = []) {
  const task = store.dispatch({requestId:'request',workspaceId:'workspace',workerId:'worker',prompt:'Original task only',executionPolicy:{mode:'build',modelId:'GLM-5.3-Flash',verifyCommands}}).task;
  store.beginDispatch(task.taskId);
  store.bindSession(task.taskId,'native-session');
  store.recoverInterruptedTasks();
  return store.getTask(task.taskId);
}
function recoveryConnection(coordinator: Coordinator, fake: RuntimeConnection) {
  Object.defineProperty(coordinator.adapter,'connect',{value:async()=>fake,configurable:true});
}

test('startup recovery restores only original approvals, supports reply and targeted cancellation, and never sends again', async t => {
  const {store,coordinator} = await fixture(t);
  const fake = new RecoveryFake();
  const longSummary = '审批摘要🙂'.repeat(3000);
  fake.pending = [{interactionId:'approval-original',kind:'permission',anchorRowId:3,payload:{toolName:'Edit',summary:longSummary,detail:{file_path:'/fixture/file',new_string:'large'.repeat(3000)}}}];
  recoveryConnection(coordinator,fake);
  const task = interruptedTask(store);
  const [recovered] = await coordinator.recoverTasks();
  assert.equal(recovered!.attached,true);
  assert.equal(store.getTask(task.taskId).status,'waiting_approval');
  assert.equal(store.getTask(task.taskId).leaseHeld,true);
  const approval = recovered!.pendingApprovals![0]!;
  assert.equal(approval.approvalId,'approval-original');
  assert.ok(Buffer.byteLength(approval.summary!)<=384);
  assert.equal(approval.truncated,true);
  assert.equal(approval.reviewComplete,false);
  assert.equal((store.getTask(task.taskId).detail as any).approvalId,'approval-original');
  const logs = store.listEvents(task.taskId,{afterRevision:approval.approvalLogCursor!,limit:1});
  assert.equal((logs[0]!.detail as any).approvalId,'approval-original','large native args cannot erase the actionable ID');
  assert.equal((logs[0]!.detail as any).detail.truncated,true);
  assert.equal(store.listEvents(task.taskId).some(event=>event.type==='assistant_message'),false,'initial historical content is not replayed');
  await coordinator.call('respond_approval',{task_id:task.taskId,approval_id:'approval-original',decision:'accept'});
  assert.deepEqual(fake.replies,[{approvalId:'approval-original',decision:'accept'}]);
  const cancellation = await coordinator.call('cancel_task',{task_id:task.taskId}) as {terminationConfirmed:boolean};
  assert.equal(cancellation.terminationConfirmed,false);
  assert.equal(fake.cancellations[0]!.commandId,'request');
  assert.equal(store.getTask(task.taskId).leaseHeld,true,'cancellation ACK is not stop proof');
  fake.emit('turn_cancelled');
  assert.equal((await completed(store,coordinator,task.taskId)).status,'cancelled');
  assert.equal(store.getTask(task.taskId).leaseHeld,false);
  assert.equal(fake.sendCalls,0);
  assert.deepEqual(fake.opened,[{workspacePath:store.getWorkspace('workspace').worktreePath,sessionId:'native-session'}]);
  assert.deepEqual(fake.cursors,['0']);
});

test('a recovered event stream ignores another command and completes verification and immutable snapshot once', async t => {
  const {root,repo,store,coordinator} = await fixture(t);
  const fake = new RecoveryFake();
  recoveryConnection(coordinator,fake);
  const marker = join(root,'verification-count');
  const task = interruptedTask(store,[{command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(marker)},'once\\n')`],timeout_ms:1000}]);
  assert.equal((await coordinator.call('resume_task',{task_id:task.taskId}) as any).attached,true);
  await writeFile(join(repo,'code.txt'),'after recovery\n');
  fake.emit('turn_completed',{},'foreign-command');
  await delay(10);
  assert.equal(store.getTask(task.taskId).status,'running');
  assert.equal(store.getTask(task.taskId).leaseHeld,true);
  fake.snapshotPatch = snapshot => {
    (snapshot.raw.rows as any).window.push({kind:'assistantText',rowId:50,turnId:'foreign-product-turn',text:'Do not leak a different task history'});
    snapshot.summary='Do not leak a different task history';
  };
  fake.emit('turn_completed');
  fake.emit('turn_completed');
  assert.equal((await completed(store,coordinator,task.taskId)).status,'succeeded');
  const result = store.getResult(task.taskId)!;
  assert.equal(result.summary,'Fixture completed');
  assert.equal(await readFile(marker,'utf8'),'once\n');
  assert.match(await readFile(result.artifacts[0]!.path,'utf8'),/\+after recovery/);
  const revision = store.getTask(task.taskId).revision;
  await Promise.all([coordinator.call('resume_task',{task_id:task.taskId}),coordinator.call('reconcile_task',{task_id:task.taskId})]);
  assert.equal(store.getTask(task.taskId).revision,revision);
  assert.deepEqual(store.getResult(task.taskId),result);
  assert.equal(store.listEvents(task.taskId).filter(event=>event.type==='task_completed').length,1);
  assert.equal(fake.sendCalls,0);
});

test('terminal recovery holds its lease through verification and concurrent resume/reconcile cannot finish it twice', async t => {
  const {root,store,coordinator} = await fixture(t);
  const fake = new RecoveryFake();
  fake.nativeState='completedSuccess';fake.activeWorks=[];
  recoveryConnection(coordinator,fake);
  const marker=join(root,'verification-count');const gate=join(root,'release-verification');
  const command=`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(marker)},'once\\n');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))clearInterval(timer)},5);setTimeout(()=>process.exit(2),2000).unref()`;
  const task=interruptedTask(store,[{command:process.execPath,args:['-e',command],timeout_ms:3000}]);
  const recovery=await coordinator.call('resume_task',{task_id:task.taskId}) as any;
  assert.equal(recovery.finalizing,true);
  await waitFor(()=>store.getTask(task.taskId).status==='verifying');
  await waitFor(()=>store.listEvents(task.taskId).some(event=>event.status==='verifying'));
  const concurrently=await Promise.all([coordinator.call('resume_task',{task_id:task.taskId}),coordinator.call('reconcile_task',{task_id:task.taskId})]) as any[];
  assert.equal(concurrently.every(result=>result.operationInProgress===true),true);
  assert.equal(store.getTask(task.taskId).leaseHeld,true);
  await assert.rejects(dispatch(coordinator,{request_id:'too-soon'}),error=>error instanceof CoreError&&error.code==='WORKSPACE_BUSY');
  await writeFile(gate,'');
  assert.equal((await completed(store,coordinator,task.taskId)).status,'succeeded');
  assert.equal(await readFile(marker,'utf8'),'once\n');
  assert.equal(store.listEvents(task.taskId).filter(event=>event.type==='task_completed').length,1);
  assert.equal(fake.sendCalls,0);
});

test('recovery refuses missing, conflicting, or ambiguous native identities without freeing occupancy', async t => {
  const cases: {name:string;patch:(fake:RecoveryFake)=>void}[] = [
    {name:'another command header',patch:fake=>{fake.sourceCommandId='foreign';}},
    {name:'another active work',patch:fake=>{fake.activeWorks=[{sourceCommandId:'foreign',turnId:'foreign-turn'}];}},
    {name:'conflicting product turn',patch:fake=>{fake.activeWorks=[{sourceCommandId:'request',turnId:'foreign-turn'}];}},
    {name:'missing active work proof',patch:fake=>{fake.snapshotPatch=snapshot=>{delete (snapshot.raw.control as any).activeWorks;};}},
    {name:'ambiguous command header',patch:fake=>{fake.snapshotPatch=snapshot=>{(snapshot.raw.rows as any).window.push({...((snapshot.raw.rows as any).window[0]),rowId:9});};}},
    {name:'snapshot session mismatch',patch:fake=>{fake.snapshotPatch=snapshot=>{snapshot.sessionId='foreign-session';};}},
    {name:'snapshot workspace mismatch',patch:fake=>{fake.snapshotPatch=snapshot=>{snapshot.workspacePath='/foreign/workspace';};}},
    {name:'openSession identity mismatch',patch:fake=>{fake.openSession=async input=>({sessionId:'foreign-session',workspacePath:input.workspacePath});}},
  ];
  for(const scenario of cases) await t.test(scenario.name,async child=>{
    const {store,coordinator}=await fixture(child);const fake=new RecoveryFake();scenario.patch(fake);recoveryConnection(coordinator,fake);
    const task=interruptedTask(store);
    const result=await coordinator.call('resume_task',{task_id:task.taskId}) as any;
    assert.equal(result.requiresInspection,true);assert.equal(result.attached,false);
    assert.equal(store.getTask(task.taskId).leaseHeld,true);assert.equal(fake.sendCalls,0);assert.equal(fake.closed,true);
    await assert.rejects(coordinator.call('stop_worker',{worker_id:'worker'}),/active or uncertain/);
  });
});

test('unattributed and blocked approvals cannot be accepted while safe cancellation remains available', async t => {
  const {store,coordinator}=await fixture(t);const fake=new RecoveryFake();recoveryConnection(coordinator,fake);
  fake.pending=[{interactionId:'unattributed',kind:'permission',payload:{toolName:'Edit'}},{interactionId:'foreign',sourceCommandId:'other',anchorRowId:3},{interactionId:'owned',kind:'permission',anchorRowId:3}];
  Object.defineProperty(coordinator.vault,'load',{value:async()=>({alias:'account-fixture',provider:'zai',health:'blocked'}),configurable:true});
  const task=interruptedTask(store);const result=await coordinator.call('resume_task',{task_id:task.taskId}) as any;
  assert.equal(result.attached,true);assert.equal(result.requiresInspection,true);assert.equal(result.task.status,'blocked');
  assert.deepEqual(result.pendingApprovals.map((value:any)=>value.approvalId),['owned']);
  for(const approvalId of ['unattributed','foreign','owned']) await assert.rejects(coordinator.call('respond_approval',{task_id:task.taskId,approval_id:approvalId,decision:'accept'}),/attributed|blocked/);
  assert.equal(fake.replies.length,0);
  await coordinator.call('respond_approval',{task_id:task.taskId,approval_id:'owned',decision:'decline'});
  await coordinator.call('cancel_task',{task_id:task.taskId});
  assert.equal(fake.replies[0]!.decision,'decline');assert.equal(fake.cancellations.length,1);assert.equal(store.getTask(task.taskId).leaseHeld,true);
});

test('verification inspection survives repeated recovery even after its original restart detail is replaced', async t => {
  const {store,coordinator}=await fixture(t);const fake=new RecoveryFake();recoveryConnection(coordinator,fake);
  const task=interruptedTask(store);
  store.transitionTask(task.taskId,'verifying',{executionStopped:{kind:'history_stopped',evidence:'Exact turn stopped before crash'}});
  store.recoverInterruptedTasks();
  for(let restart=0;restart<2;restart++) {
    const [resumed,reconciled]=await Promise.all([coordinator.call('resume_task',{task_id:task.taskId}),coordinator.call('reconcile_task',{task_id:task.taskId})]) as any[];
    assert.equal(resumed.requiresInspection,true);assert.equal(reconciled.requiresInspection,true);
    assert.equal(store.getTask(task.taskId).leaseHeld,true);assert.equal(store.hasEnteredVerification(task.taskId),true);
    store.recoverInterruptedTasks();
  }
  assert.equal(fake.opened.length,0);assert.equal(fake.sendCalls,0);assert.equal(store.getResult(task.taskId),null);
});

test('read-only reconciliation and explicit attachment serialize without closing the attached connection', async t => {
  const {store,coordinator}=await fixture(t);const connections:RecoveryFake[]=[];
  Object.defineProperty(coordinator.adapter,'connect',{value:async()=>{const fake=new RecoveryFake();connections.push(fake);return fake;},configurable:true});
  const task=interruptedTask(store);
  const [reconciled,resumed]=await Promise.all([coordinator.call('reconcile_task',{task_id:task.taskId}),coordinator.call('resume_task',{task_id:task.taskId})]) as any[];
  assert.equal(reconciled.canResume,true);assert.equal(resumed.attached,true);assert.equal(connections.length,2);
  assert.equal(connections[0]!.closed,true);assert.equal(connections[1]!.closed,false);
  const again=await coordinator.call('reconcile_task',{task_id:task.taskId}) as any;
  assert.equal(again.attached,true);assert.equal(connections[1]!.closed,false);assert.equal(store.getTask(task.taskId).leaseHeld,true);
});

test('unmarked native exception text cannot cross the successful recovery or MCP presentation boundary', async t => {
  const {store,coordinator}=await fixture(t);
  const secret='PRIVATE_NATIVE_PROMPT_WITH_UNMARKED_SECRET';
  Object.defineProperty(coordinator.adapter,'connect',{value:async()=>{throw new Error(secret);},configurable:true});
  const task=interruptedTask(store);
  const result=await coordinator.call('resume_task',{task_id:task.taskId}) as any;
  assert.equal(result.requiresInspection,true);assert.equal(store.getTask(task.taskId).leaseHeld,true);
  assert.equal(JSON.stringify(result).includes(secret),false);
  assert.equal(presentMcpResult('resume_task',result,{task_id:task.taskId}).text.includes(secret),false);
});

test('multiple approvals preserve the next pending item, wait for native removal, and serialize concurrent replies', async t => {
  const {store,coordinator}=await fixture(t);const fake=new RecoveryFake();recoveryConnection(coordinator,fake);
  fake.pending=[{interactionId:'first',kind:'permission',anchorRowId:3,payload:{toolName:'Edit',summary:'First edit'}},{interactionId:'second',kind:'permission',anchorRowId:3,payload:{toolName:'Edit',summary:'Second edit'}}];
  const task=interruptedTask(store);await coordinator.call('resume_task',{task_id:task.taskId});
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  fake.respondApproval=async(_turn,approvalId,decision)=>{fake.replies.push({approvalId,decision});await gate;};
  const first=coordinator.call('respond_approval',{task_id:task.taskId,approval_id:'first',decision:'accept'});
  await waitFor(()=>fake.replies.length===1);
  const duplicate=coordinator.call('respond_approval',{task_id:task.taskId,approval_id:'first',decision:'accept'});
  const conflicting=coordinator.call('respond_approval',{task_id:task.taskId,approval_id:'first',decision:'decline'});
  const replies=Promise.allSettled([first,duplicate,conflicting]);
  await delay(10);assert.equal(fake.replies.length,1);release();
  const results=await replies;
  assert.equal(results[0]!.status,'fulfilled');assert.equal(results[1]!.status,'fulfilled');assert.equal(results[2]!.status,'rejected');
  assert.equal((results[0] as PromiseFulfilledResult<any>).value.awaitingNativeRevision,true);
  assert.equal(store.getTask(task.taskId).status,'waiting_approval');
  assert.equal((store.getTask(task.taskId).detail as any).approvalId,'first');
  assert.equal((store.getTask(task.taskId).detail as any).approvalResponsePending,true);
  assert.equal((store.getTask(task.taskId).detail as any).pendingApprovalCount,2);
  fake.pending=fake.pending.slice(1);
  await waitFor(()=>(store.getTask(task.taskId).detail as any).approvalId==='second');
  assert.equal(store.getTask(task.taskId).status,'waiting_approval');
  const detail=store.getTask(task.taskId).detail as any;
  assert.equal(detail.pendingApprovalCount,1);assert.equal(detail.approvalResponsePending,false);assert.equal(detail.summary,'Second edit');
  assert.equal((store.listEvents(task.taskId,{afterRevision:detail.approvalLogCursor,limit:1})[0]!.detail as any).approvalId,'second');
  fake.respondApproval=async(_turn,approvalId,decision)=>{fake.replies.push({approvalId,decision});fake.pending=[];};
  await coordinator.call('respond_approval',{task_id:task.taskId,approval_id:'second',decision:'decline'});
  assert.equal(store.getTask(task.taskId).status,'running');assert.equal((store.getTask(task.taskId).detail as any).approvalId,undefined);
  assert.equal((store.getTask(task.taskId).detail as any).pendingApprovalCount,0);
  assert.deepEqual(fake.replies.map(value=>[value.approvalId,value.decision]),[['first','accept'],['second','decline']]);
  await coordinator.close();const revision=store.getTask(task.taskId).revision;await delay(150);assert.equal(store.getTask(task.taskId).revision,revision);
});


test('finish work rejects every held task before stopping any Worker',async t=>{
 const {store,coordinator}=await fixture(t);let stops=0;
 Object.defineProperty(coordinator.supervisor,'stop',{value:async()=>{stops++;return {stopped:true};}});
 store.dispatch({requestId:'held',workspaceId:'workspace',workerId:'worker',prompt:'fixture'});
 await assert.rejects(coordinator.call('shutdown_pool',{}),/active or uncertain/);assert.equal(stops,0);
 assert.ok(await coordinator.call('get_pool_policy',{}),'failed shutdown keeps daemon available');
});

test('finish work gates concurrent dispatch and Worker starts, preserves data, then remains draining',async t=>{
 const {store,coordinator}=await fixture(t);let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);t.after(()=>release());
 Object.defineProperty(coordinator.supervisor,'list',{value:async()=>[{workerId:'worker',state:'ready'},{workerId:'old',state:'stopped'}]});
 const stopped:string[]=[];
 Object.defineProperty(coordinator.supervisor,'stop',{value:async(id:string)=>{stopped.push(id);entered();await gate;return {workerId:id,stopped:true};}});
 const finishing=coordinator.call('shutdown_pool',{});await started;
 await assert.rejects(coordinator.call('start_worker',{worker_id:'new',account_id:'account'}),/shutdown in progress/);
 await assert.rejects(coordinator.call('dispatch_task',{request_id:'late',workspace_id:'workspace',prompt:'late'}),/shutdown in progress/);
 release();assert.deepEqual(await finishing,{stopping:true,workersStopped:true,stoppedWorkers:1});
 assert.deepEqual(stopped,['worker']);assert.equal(store.listWorkspaces().length,1);assert.equal(store.listTasks().length,0);
 await assert.rejects(coordinator.call('shutdown_pool',{}),/shutdown in progress/);
});

test('partial Worker stop failure keeps daemon available and never forces termination',async t=>{
 const {coordinator}=await fixture(t);const stopped:string[]=[];
 Object.defineProperty(coordinator.supervisor,'list',{value:async()=>[{workerId:'a',state:'ready'},{workerId:'b',state:'unknown'}]});
 Object.defineProperty(coordinator.supervisor,'stop',{value:async(id:string,options:unknown)=>{assert.equal(options,undefined);stopped.push(id);if(id==='b')throw new Error('native unknown');return {workerId:id,stopped:true};}});
 await assert.rejects(coordinator.call('shutdown_pool',{}),/shutdown incomplete/);assert.deepEqual(stopped,['a','b']);
 assert.ok(await coordinator.call('get_pool_policy',{}));
});
