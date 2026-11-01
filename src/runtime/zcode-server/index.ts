import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { ApprovalDecision, ModelSelection, OpenSessionInput, RuntimeAdapter, RuntimeConnection, RuntimeEvent, RuntimeInfo, SessionRef, SessionSnapshot, TurnInput, TurnRef, WorkerEndpoint } from '../types.js';
import { ChannelRpc, type ProtocolMessageRecord } from './rpc.js';
import { classifyError, ConversationProjection, record, redact, TopicAssembler } from './events.js';

const AGENT = 'zcode-agent';
export const ZCODE_SERVER_ADAPTER_ID = 'zcode-server/3.16.3/proto-1-wire-3';

export class RuntimeFault extends Error {
  readonly category;
  readonly executionUncertain: boolean;
  constructor(message: string, options: { cause?: unknown; executionUncertain?: boolean } = {}) {
    super(redact(message), { cause: options.cause });
    this.name = 'RuntimeFault'; this.category = classifyError(options.cause ?? message); this.executionUncertain = options.executionUncertain ?? false;
  }
}

function endpointUrl(endpoint: WorkerEndpoint): URL {
  const url = new URL(endpoint.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Official runtime endpoints must be loopback HTTP origins');
  return url;
}
async function readToken(endpoint: WorkerEndpoint): Promise<string | undefined> {
  const path = endpoint.tokenFile ?? (endpoint.serverRoot ? join(endpoint.serverRoot, 'run', 'ingress-token') : undefined);
  if (!path) return;
  const token = (await readFile(path, 'utf8')).trim();
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Invalid local ingress token file');
  return token;
}
function selectionFromSnapshot(snapshot: Record<string, any>): ModelSelection | undefined {
  const config = record(snapshot.config);
  if (typeof config.provider !== 'string' || !config.provider || typeof config.model !== 'string' || !config.model) return;
  return { providerId: config.provider, modelId: config.model, ...(config.thought ? { options: { reasoningLevel: config.thought } } : {}) };
}
function accepted(ack: Record<string, any>, operation: string): void {
  if (!['accepted', 'duplicate', 'noop'].includes(ack.status)) throw new RuntimeFault(`Official ${operation} ${ack.status ?? 'failed'}: ${ack.reasonCode ?? ''} ${ack.message ?? ''}`);
}

interface SessionState {
  ref: SessionRef;
  projection: ConversationProjection;
  assembler: TopicAssembler;
  subscriptionId?: string;
  logEpoch?: string;
  release: () => void;
  wake: Set<() => void>;
  initial: Promise<void>;
  resolveInitial: () => void;
  rejectInitial: (error: Error) => void;
  initialTimer: NodeJS.Timeout;
  failure?: Error;
}

export class ZCodeServerAdapter implements RuntimeAdapter {
  readonly id = ZCODE_SERVER_ADAPTER_ID;
  constructor(private readonly options: { rpcTimeoutMs?: number; fetchTimeoutMs?: number; onProtocolMessage?: (message: ProtocolMessageRecord) => void } = {}) {}
  supports(info: Pick<RuntimeInfo, 'version' | 'protocolVersion'>): boolean { return info.version === '3.16.3' && info.protocolVersion === 1; }

  async probe(endpoint: WorkerEndpoint): Promise<RuntimeInfo> {
    const url = endpointUrl(endpoint);
    const token = await readToken(endpoint);
    const response = await fetch(new URL('/api/server-info', url), { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(this.options.fetchTimeoutMs ?? 5000) });
    if (!response.ok) throw new RuntimeFault(`Official server-info HTTP ${response.status}`);
    const raw = record(await response.json());
    if (typeof raw.version !== 'string' || typeof raw.protocolVersion !== 'number' || typeof raw.authRequired !== 'boolean') throw new RuntimeFault('Invalid official server-info response');
    return {
      adapterId: this.id, version: raw.version, protocolVersion: raw.protocolVersion,
      authRequired: raw.authRequired, authenticated: typeof raw.serverId === 'string',
      ...(typeof raw.serverId === 'string' ? { serverId: raw.serverId } : {}), supported: this.supports(raw as RuntimeInfo),
    };
  }

  async connect(endpoint: WorkerEndpoint): Promise<ZCodeServerConnection> {
    const info = await this.probe(endpoint);
    if (!info.supported) throw new RuntimeFault(`Unsupported ZCode Server ${info.version} protocol ${info.protocolVersion}; only verified 3.16.3/protocol 1 is enabled`);
    if (info.authRequired && !info.authenticated) throw new RuntimeFault('Official server ingress authentication required or invalid');
    const connection = new ZCodeServerConnection(info, this.options.rpcTimeoutMs ?? 30_000, this.options.onProtocolMessage);
    try {
      await connection.initialize(endpointUrl(endpoint), await readToken(endpoint));
      return connection;
    } catch (error) {
      await connection.close();
      throw new RuntimeFault(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }
}

export class ZCodeServerConnection implements RuntimeConnection {
  private readonly clientId = `zcode-pool-${randomUUID()}`;
  private readonly rpc: ChannelRpc;
  private readonly sessions = new Map<string, SessionState>();
  private closed = false;
  constructor(readonly info: RuntimeInfo, private readonly timeoutMs: number, onProtocolMessage?: (message: ProtocolMessageRecord) => void) {
    this.rpc = new ChannelRpc(timeoutMs, (error) => {
      if (this.closed) return;
      this.closed = true;
      for (const session of this.sessions.values()) this.sessionFailure(session, error);
    }, onProtocolMessage ? (message) => onProtocolMessage(redact(message)) : undefined);
  }

  async initialize(url: URL, token?: string): Promise<void> {
    const ws = new URL('/ws', url); ws.protocol = 'ws:';
    await this.rpc.connect(ws.toString(), token);
    const hello = record(await this.rpc.call(AGENT, 'helloConversationV4'));
    if (hello.protocolVersion !== 3 || hello.clientMode !== 'web-remote-replayable' || hello.deliveryProfile !== 'replayable') throw new Error('Unsupported official conversation handshake');
    await this.rpc.call(AGENT, 'initializeConversationV4', { kind: 'clientHello', protocolVersion: 3, clientId: this.clientId, clientKind: 'web', appVersion: 'zcode-pool/0.1.0', capabilities: { workspaceHookReviewUi: false } });
    this.info.conversationProtocolVersion = 3;
  }

  /** Read-only provider catalog for choosing an explicit account-bound model. */
  async modelCatalog(): Promise<Record<string, unknown>> { return redact(record(await this.rpc.call('model-selection', 'getView'))); }
  /** Includes official availability/rejection reasons that the selectable model catalog omits. */
  async providerStatus(refresh = false): Promise<Record<string, unknown>> {
    return redact(record(await this.rpc.call('provider-settings', refresh ? 'refresh' : 'getView', ...(refresh ? ['pool-probe'] : []))));
  }

  private async command(session: SessionRef | { workspacePath: string; sessionId: null }, type: string, payload: unknown, commandId: string = randomUUID(), projectId?: string): Promise<Record<string, any>> {
    try {
      const ack = record(await this.rpc.call(AGENT, 'sendConversationCommandV4', { workspacePath: session.workspacePath, ...(projectId ? { projectId } : {}), envelope: { commandId, clientId: this.clientId, sessionId: session.sessionId, type, payload, issuedAt: Date.now() } }));
      accepted(ack, type); return ack;
    } catch (error) {
      throw error instanceof RuntimeFault ? error : new RuntimeFault(error instanceof Error ? error.message : String(error), { cause: error, executionUncertain: /timed out|closed|WebSocket/i.test(error instanceof Error ? error.message : String(error)) });
    }
  }

  async openSession(input: OpenSessionInput): Promise<SessionRef> {
    if (!isAbsolute(input.workspacePath)) throw new Error('Workspace path must be absolute');
    const workspacePath = resolve(input.workspacePath);
    let sessionId = input.sessionId;
    if (!sessionId) {
      // Standalone Server enforces remote single-root project ownership before session reservation.
      const projects = await this.rpc.call<Array<Record<string, any>>>('project', 'readProjects');
      if (!Array.isArray(projects)) throw new RuntimeFault('Invalid official project list');
      let project = projects.find((entry) => !entry.deleted && entry.roots?.length === 1 && entry.roots[0]?.rootPath === workspacePath);
      if (!project) project = record(await this.rpc.call('project', 'saveProject', { roots: [workspacePath], primaryRoot: workspacePath, name: basename(workspacePath) }));
      if (typeof project.id !== 'string' || !project.id) throw new RuntimeFault('Official workspace project has no ID');
      const ack = await this.command({ workspacePath, sessionId: null }, 'createSession', { workspaceId: workspacePath, config: { ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}), mode: input.mode ?? 'build' } }, randomUUID(), project.id);
      sessionId = ack.result?.sessionId;
      if (typeof sessionId !== 'string' || !sessionId) throw new RuntimeFault('Official createSession accepted without a session ID; reconcile before retrying', { executionUncertain: true });
    }
    const ref = { workspacePath, sessionId };
    await this.ensureSubscribed(ref);
    if (input.modelSelection) this.assertSelection(ref, input.modelSelection);
    return ref;
  }

  private key(session: SessionRef): string { return `${session.workspacePath}\0${session.sessionId}`; }
  private sessionFailure(state: SessionState, error: Error): void {
    if (state.failure) return;
    state.failure = error; clearTimeout(state.initialTimer); state.rejectInitial(error); state.projection.fault(error);
    for (const wake of state.wake) wake();
  }
  private async ensureSubscribed(ref: SessionRef): Promise<SessionState> {
    const key = this.key(ref);
    const existing = this.sessions.get(key);
    if (existing) { await existing.initial; if (existing.failure) throw existing.failure; return existing; }
    if (this.closed) throw new Error('Runtime connection is closed');
    let resolveInitial!: () => void;
    let rejectInitial!: (error: Error) => void;
    const initial = new Promise<void>((resolvePromise, rejectPromise) => { resolveInitial = resolvePromise; rejectInitial = rejectPromise; });
    void initial.catch(() => {});
    const wake = new Set<() => void>();
    const state: SessionState = { ref, projection: new ConversationProjection(ref.sessionId, () => { for (const callback of wake) callback(); }), assembler: new TopicAssembler(), wake, release: () => {}, initial, resolveInitial, rejectInitial, initialTimer: setTimeout(() => this.sessionFailure(state, new Error('Official conversation snapshot timed out')), this.timeoutMs) };
    this.sessions.set(key, state);
    const early: unknown[] = [];
    const accept = (wire: unknown) => {
      const raw = record(wire);
      if (raw.topic !== `conversation/${ref.sessionId}`) return;
      if (!state.subscriptionId) { if (early.length >= 128) this.sessionFailure(state, new Error('Initial conversation frame overflow')); else early.push(wire); return; }
      if (raw.subscriptionId !== state.subscriptionId) return;
      try {
        const frame = state.assembler.accept(wire);
        if (!frame) return;
        state.projection.apply(frame, state.logEpoch);
        if (state.projection.snapshot) { clearTimeout(state.initialTimer); state.resolveInitial(); }
      } catch (error) { this.sessionFailure(state, error instanceof Error ? error : new Error(String(error))); }
    };
    try {
      state.release = await this.rpc.listen(AGENT, 'onDynamicConversationFrame', { workspacePath: ref.workspacePath }, accept, (error) => this.sessionFailure(state, error));
      const response = record(await this.rpc.call(AGENT, 'subscribeConversationV4', { ...ref, visibility: 'background' }));
      state.subscriptionId = response.ack?.subscriptionId;
      state.logEpoch = response.ack?.logEpoch;
      if (!state.subscriptionId || !state.logEpoch) throw new Error('Official subscription did not return an ID/epoch');
      for (const wire of early.splice(0)) accept(wire);
      await initial;
      return state;
    } catch (error) {
      this.sessionFailure(state, error instanceof Error ? error : new Error(String(error)));
      state.release(); throw error;
    }
  }

  private assertSelection(session: SessionRef, requested: ModelSelection): void {
    const snapshot = this.sessions.get(this.key(session))?.projection.snapshot;
    const effective = snapshot && selectionFromSnapshot(snapshot);
    if (!effective || effective.providerId !== requested.providerId || effective.modelId !== requested.modelId || (requested.options?.reasoningLevel && requested.options.reasoningLevel !== effective.options?.reasoningLevel)) throw new RuntimeFault('Official session selected a different provider/model/reasoning level; dispatch refused');
  }
  async sendTurn(session: SessionRef, input: TurnInput): Promise<TurnRef> {
    if (!input.prompt.trim()) throw new Error('Task prompt cannot be empty');
    const state = await this.ensureSubscribed(session);
    if (state.projection.snapshot?.control?.activeWorks?.length) throw new RuntimeFault('Session already has active work; wait or cancel before dispatching');
    if (input.modelSelection) this.assertSelection(session, input.modelSelection);
    const currentSelection = selectionFromSnapshot(state.projection.snapshot!);
    const requestedSelection = input.modelSelection;
    const modelSelection = requestedSelection ? { ...requestedSelection, ...(currentSelection?.options || requestedSelection.options ? { options: { ...currentSelection?.options, ...requestedSelection.options } } : {}) } : undefined;
    const commandId = input.requestId ?? randomUUID();
    await this.command(session, 'sendText', { text: input.prompt, requestedDelivery: 'startNow', ...(modelSelection ? { modelSelection } : {}), ...(input.mode ? { mode: input.mode } : {}) }, commandId);
    return { ...session, turnId: commandId, commandId };
  }

  async *events(session: SessionRef, cursor?: string): AsyncIterable<RuntimeEvent> {
    const state = await this.ensureSubscribed(session);
    let after = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid runtime event cursor');
    while (true) {
      const oldest = state.projection.history[0];
      if (oldest && after < Number(oldest.cursor) - 1) throw new RuntimeFault('Runtime event cursor expired; use persisted events and syncHistory to reconcile');
      const batch = state.projection.history.filter((event) => Number(event.cursor) > after);
      for (const event of batch) { after = Number(event.cursor); yield event; }
      if (this.closed || state.failure) return;
      let resolveWake!: () => void;
      const changed = new Promise<void>((resolvePromise) => { resolveWake = resolvePromise; });
      state.wake.add(resolveWake);
      try {
        // Check after installing the waiter so an event cannot be lost between the read and await.
        if (Number(state.projection.cursor) <= after && !this.closed && !state.failure) await changed;
      } finally { state.wake.delete(resolveWake); }
    }
  }

  async syncHistory(session: SessionRef): Promise<SessionSnapshot> {
    const state = await this.ensureSubscribed(session);
    const raw = state.projection.snapshot!;
    const summary = (raw.rows?.window ?? []).filter((row: any) => row.kind === 'assistantText').map((row: any) => row.text).filter((text: unknown) => typeof text === 'string').at(-1) ?? '';
    return { ...session, phase: raw.control?.phase ?? 'unknown', revision: raw.revision ?? 0, cursor: state.projection.cursor, summary: redact(summary), modelSelection: selectionFromSnapshot(raw), pendingApprovals: redact(raw.pendingInteractions ?? []), raw: redact(structuredClone(raw)) };
  }
  async queryCommand(session: SessionRef, commandId: string): Promise<Record<string, unknown> | 'unknown'> {
    const response = record(await this.rpc.call(AGENT, 'queryConversationCommandsV4', { workspacePath: session.workspacePath, commands: [{ sessionId: session.sessionId, commandId }] }));
    return response.results?.[0]?.result === 'unknown' ? 'unknown' : redact(record(response.results?.[0]?.result));
  }

  async respondApproval(turn: TurnRef, approvalId: string, decision: ApprovalDecision): Promise<void> {
    const state = await this.ensureSubscribed(turn);
    const interaction = (state.projection.snapshot?.pendingInteractions ?? []).find((entry: any) => entry.interactionId === approvalId);
    if (!interaction) throw new RuntimeFault('Approval is no longer pending; sync history before responding');
    if (interaction.kind === 'workspaceHookReview') throw new RuntimeFault('Workspace hook review requires a dedicated reviewed decision; generic approval is unsupported');
    let answer: Record<string, unknown>;
    if (typeof decision === 'object') answer = decision;
    else if (interaction.kind === 'permission') {
      const kind = decision === 'accept' ? 'allowOnce' : 'deny';
      const option = interaction.payload?.options?.find((entry: any) => entry.kind === kind);
      if (!option) throw new RuntimeFault('Permission does not offer the requested decision; choose a supplied option ID');
      answer = { optionId: option.optionId };
    } else answer = { action: decision };
    await this.command(turn, 'resolveInteraction', { interactionId: approvalId, answer });
  }
  async cancel(turn: TurnRef): Promise<void> {
    const state = await this.ensureSubscribed(turn);
    const work = (state.projection.snapshot?.control?.activeWorks ?? []).find((entry: any) => entry.sourceCommandId === turn.commandId);
    if (!work) {
      const header = (state.projection.snapshot?.rows?.window ?? []).find((entry: any) => entry.kind === 'turnHeader' && entry.sourceCommandId === turn.commandId);
      if (header && header.state !== 'running') return;
      throw new RuntimeFault('Cannot identify this turn as current foreground work; stop refused to avoid cancelling a later turn', { executionUncertain: true });
    }
    if (!work.foregroundExecutionId) throw new RuntimeFault('Official runtime did not expose a foreground execution ID; safe targeted stop unavailable');
    await this.command(turn, 'stop', { expectedForegroundExecutionId: work.foregroundExecutionId });
    // The caller must observe turn_cancelled or reconcile activeWorks; this ACK alone is not cancellation proof.
  }
  async quota(providerId: string): Promise<Record<string, unknown>> {
    if (!['account:zai-start-plan', 'account:bigmodel-start-plan'].includes(providerId)) throw new Error('This adapter quota probe only supports explicit Start Plan providers');
    const accountType = providerId === 'account:zai-start-plan' ? 'zai' : 'bigmodel';
    return redact(record(await this.rpc.call('usage-stats', 'getEntitlementSnapshot', { preferredProviderId: providerId, accountAccess: { type: 'zhipu-account', accountType, mode: 'start-plan' }, requirePreferredProvider: true, allowEnvApiKey: false, invalidateBalanceCache: true })));
  }
  async close(): Promise<void> {
    if (this.closed) return;
    for (const state of this.sessions.values()) {
      state.release();
      // Closing a replayable connection never means stopping its model turn.
      if (state.subscriptionId) await this.rpc.call(AGENT, 'unsubscribeConversationV4', { ...state.ref, subscriptionId: state.subscriptionId }).catch(() => {});
    }
    this.closed = true; this.rpc.close();
    for (const state of this.sessions.values()) { clearTimeout(state.initialTimer); for (const wake of state.wake) wake(); }
  }
}

export { classifyError, redact } from './events.js';
