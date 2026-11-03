import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { ConversationProjection, TopicAssembler, classifyError, redact } from '../../src/runtime/zcode-server/events.js';
import { FrameDecoder, decodeValues, encodeFrame, encodeValue } from '../../src/runtime/zcode-server/rpc.js';
import { ZCodeServerAdapter, SINGLE_AGENT_TOOL_DENYLIST, isEmptyInitialDraft } from '../../src/runtime/zcode-server/index.js';

test('official Initialize fixture decodes across socket fragmentation', () => {
  // SocketProtocol regular/type=1, 13-byte header, Channel Initialize [200], undefined body.
  const fixture = Buffer.from('01000000000000000000000006040106c80100', 'hex');
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.accept(fixture.subarray(0, 14)), []);
  assert.deepEqual(decoder.accept(fixture.subarray(14)), [[[200], undefined]]);
  assert.equal(encodeFrame([200]).toString('hex'), fixture.toString('hex'));
  assert.deepEqual(decodeValues(encodeValue([undefined, '中', 100, -1, new Uint8Array([1, 2])])), [[undefined, '中', 100, -1, new Uint8Array([1, 2])]]);
});

test('topic fragments are checksummed and sequence gaps cannot imply completion', () => {
  const frame = { topic: 'conversation/session', subscriptionId: 'sub', logEpoch: 'epoch', fromSeq: 0, toSeq: 0, payload: { kind: 'snapshot', snapshot: { sessionId: 'session', logEpoch: 'epoch', seq: 0, revision: 0, control: { phase: 'draft' }, rows: { window: [] } } } };
  const bytes = Buffer.from(JSON.stringify(frame));
  const checksum = { algorithm: 'crc32', value: crc32(bytes).toString(16).padStart(8, '0') };
  const fragment = (index: number, data: Buffer) => ({ wireVersion: 3, kind: 'fragment', logicalFrameId: 'f', logicalFrameOrdinal: 1, topic: frame.topic, subscriptionId: 'sub', fragmentIndex: index, fragmentCount: 2, logicalBytes: bytes.length, checksum, dataBase64: data.toString('base64') });
  const assembler = new TopicAssembler();
  assert.equal(assembler.accept(fragment(1, bytes.subarray(20))), undefined);
  assert.deepEqual(assembler.accept(fragment(0, bytes.subarray(0, 20))), frame);
  const corrupt = new TopicAssembler();
  corrupt.accept(fragment(0, bytes.subarray(0, 20)));
  assert.throws(() => corrupt.accept(fragment(1, Buffer.alloc(bytes.length - 20))), /checksum/);
  const events: any[] = [];
  const projection = new ConversationProjection('session', (event) => events.push(event));
  projection.apply(frame);
  assert.throws(() => projection.apply({ ...frame, fromSeq: 1, toSeq: 2, payload: { kind: 'deltas', deltas: [] } }), /sequence gap/);
  assert.equal(events.some((event) => event.type === 'turn_completed'), false);
});

test('risk/auth faults and secret-bearing output are handled conservatively', () => {
  assert.equal(classifyError({ status: 429 }), 'rate_limited');
  assert.equal(classifyError({ code: '3012', message: 'unusual activity' }), 'risk_blocked');
  assert.equal(classifyError(new Error('Invalid credential identity')), 'auth_invalid');
  assert.deepEqual(redact({ access_token: 'private', nested: { authorization: 'private', outputTokens: 42 }, text: 'Bearer private' }), { access_token: '[redacted]', nested: { authorization: '[redacted]', outputTokens: 42 }, text: 'Bearer [redacted]' });
});

test('recorded official snapshot uses the subscription epoch, with no outer logEpoch', async () => {
  const wire = JSON.parse(await readFile(new URL('./fixtures/official-draft-snapshot.json', import.meta.url), 'utf8'));
  assert.equal(wire.frame.logEpoch, undefined);
  const projection = new ConversationProjection('<session-id>', () => {});
  projection.apply(new TopicAssembler().accept(wire)!, '<log-epoch>');
  assert.equal(projection.snapshot?.control.phase, 'draft');
  assert.equal(projection.snapshot?.config.provider, 'account:zai-start-plan');
});

test('recorded permission/error normalize and terminal metadata updates do not complete twice', async () => {
  const wire = JSON.parse(await readFile(new URL('./fixtures/official-draft-snapshot.json', import.meta.url), 'utf8'));
  const permission = JSON.parse(await readFile(new URL('./fixtures/official-permission.json', import.meta.url), 'utf8'));
  const preparation = JSON.parse(await readFile(new URL('./fixtures/official-preparation-error.json', import.meta.url), 'utf8'));
  const received: any[] = [];
  const projection = new ConversationProjection('<session-id>', (event) => received.push(event));
  projection.apply(wire.frame, '<log-epoch>');
  const header = { kind: 'turnHeader', rowId: 1, turnId: 'product-turn', sourceCommandId: 'command', state: 'running', startedAt: 1 };
  projection.apply({ fromSeq: 0, toSeq: 1, payload: { kind: 'deltas', deltas: [{ op: 'row.appended', row: header }, { op: 'state.updated', patch: { pendingInteractions: [permission] } }] } }, '<log-epoch>');
  assert.equal(received.find((event) => event.type === 'approval_requested').data.approvalId, '<approval-id>');
  projection.apply({ fromSeq: 1, toSeq: 2, payload: { kind: 'deltas', deltas: [{ op: 'row.upserted', row: { ...header, state: 'failed' } }, { op: 'state.updated', patch: { control: { phase: 'error', lastError: preparation.error } } }] } }, '<log-epoch>');
  projection.apply({ fromSeq: 2, toSeq: 3, payload: { kind: 'deltas', deltas: [{ op: 'row.upserted', row: { ...header, state: 'failed', outputTokens: 0 } }] } }, '<log-epoch>');
  const failures = received.filter((event) => event.type === 'turn_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].turnId, 'command');
  assert.equal(failures[0].data.error, undefined, 'the recorded at:0 is redacted and cannot prove turn ownership');
  assert.equal(failures[0].data.errorAttribution, 'unattributed');
  assert.equal(failures[0].data.busyRetryEligible, false);
  assert.equal(received.find((event) => event.type === 'error').data.code, 'invalid_model_request');
  assert.equal(received.find((event) => event.type === 'error').turnId, undefined);
});

test('native failed occurrences count individual attempts without counting retry snapshots or terminal twice', () => {
  const received: any[] = [];
  const projection = new ConversationProjection('s', event => received.push(event));
  const header = { kind: 'turnHeader', rowId: 1, turnId: 'native-turn', sourceCommandId: 'command', state: 'running', startedAt: 1 };
  projection.apply({ toSeq: 0, payload: { kind: 'snapshot', snapshot: { sessionId: 's', logEpoch: 'e', seq: 0, revision: 0, rows: { window: [header] }, control: { phase: 'running', activeWorks: [{ sourceCommandId: 'command' }] } } } });
  const failed = Array.from({ length: 5 }, (_, i) => ({ sessionId: 's', eventId: `failure-${i}`, turnId: 'native-turn', seq: i + 1, timestamp: i + 2, type: 'session.updated', payload: {
    type: 'model_request_failed', requestId: 'request', attempt: i + 1, maxAttempts: 5, retryable: i < 4, reason: 'provider_overloaded', message: 'Provider is overloaded', statusCode: 529,
    requestHeaders: { Authorization: 'PRIVATE' }, responseHeaders: { 'Set-Cookie': 'PRIVATE', 'Retry-After': '7' },
  } }));
  const retry = { attempt: 4, maxAttempts: 5, nextRetryAt: 7006, reasonCode: 'fault.provider.serverError' };
  projection.apply({ fromSeq: 0, toSeq: 1, payload: { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { control: { phase: 'running', apiRetry: retry, activeWorks: [{ sourceCommandId: 'command' }] } } }] } }, 'e', failed.slice(0, 4));
  projection.apply({ fromSeq: 1, toSeq: 2, payload: { kind: 'deltas', deltas: [{ op: 'state.updated', patch: { control: { phase: 'running', apiRetry: retry, activeWorks: [{ sourceCommandId: 'command' }] } } }] } }, 'e', failed.slice(0, 4));
  const error = { code: 'model_overloaded', message: 'Provider is overloaded', at: 9, attribution: { source: 'provider', reason: 'provider_overloaded', statusCode: 529 } };
  projection.apply({ fromSeq: 2, toSeq: 3, payload: { kind: 'deltas', deltas: [{ op: 'row.upserted', row: { ...header, state: 'failed', endedAt: 9 } }, { op: 'state.updated', patch: { control: { phase: 'error', apiRetry: null, activeWorks: [], lastError: error } } }] } }, 'e', [failed[4], { sessionId: 's', eventId: 'terminal', turnId: 'native-turn', type: 'turn.failed', payload: { error } }]);
  const occurrences = received.filter(event => event.data.origin === 'native_model_request');
  assert.equal(occurrences.length, 5);
  assert(occurrences.every(event => event.turnId === 'command' && event.data.category === 'model_busy' && event.data.retryAfterMs === 7000));
  assert.equal(received.filter(event => event.type === 'runtime_status' && event.data.kind === 'api_retry').length, 1);
  assert.equal(received.find(event => event.type === 'turn_failed').data.occurrenceKey, 'native-model:failure-4');
  assert.equal(received.at(-1).data.occurrenceKey, 'native-model:failure-4');
  assert.equal(new Set(received.filter(event => event.type === 'error').map(event => event.data.occurrenceKey)).size, 5);
  assert(!JSON.stringify(received).includes('PRIVATE'));
});

test('native failures without the original native turn identity stay unattributed', () => {
  const received: any[] = [];
  const projection = new ConversationProjection('s', event => received.push(event));
  projection.apply({ toSeq: 0, payload: { kind: 'snapshot', snapshot: { sessionId: 's', logEpoch: 'e', seq: 0, rows: { window: [] }, control: {} } } }, 'e', [{ sessionId: 's', eventId: 'failure', type: 'session.updated', payload: { type: 'model_request_failed', requestId: 'r', attempt: 1, statusCode: 503 } }]);
  const failure = received.find(event => event.type === 'error');
  assert.equal(failure.turnId, undefined);
  assert.equal(failure.data.errorAttribution, 'unattributed');
  assert.equal(failure.data.occurrenceKey, 'native-model:failure');
});

test('error statistics prove only continuously observed turns complete', () => {
  const received: any[] = [], old: any[] = [];
  const snapshot = { sessionId: 's', logEpoch: 'e', seq: 0, rows: { window: [] as any[] }, control: {} };
  const header = { kind: 'turnHeader', rowId: 1, turnId: 'native', sourceCommandId: 'command', startedAt: Date.now() - 20, endedAt: Date.now(), state: 'completedSuccess' };
  const live = new ConversationProjection('s', event => received.push(event));
  live.apply({ toSeq: 0, payload: { kind: 'snapshot', snapshot } });
  live.apply({ fromSeq: 0, toSeq: 1, payload: { kind: 'deltas', deltas: [{ op: 'row.appended', row: { ...header, state: 'running' } }] } }, 'e');
  live.apply({ fromSeq: 1, toSeq: 2, payload: { kind: 'deltas', deltas: [{ op: 'row.upserted', row: header }] } }, 'e', [], true);
  assert.equal(received.find(event => event.data.kind === 'native_error_observation').data.complete, true);
  const cold = new ConversationProjection('s', event => old.push(event));
  cold.apply({ toSeq: 0, payload: { kind: 'snapshot', snapshot: { ...snapshot, rows: { window: [header] } } } }, 'e', [], true);
  assert.equal(old.find(event => event.data.kind === 'native_error_observation').data.complete, null);
  assert.equal(old.find(event => event.data.kind === 'native_error_observation').data.reason, 'attached_history_unverified');
});

test('admission rejection proof requires a complete unchanged initial draft', () => {
  const initial = { revision: 0, seq: 0, rows: { window: [] }, control: { phase: 'draft', activeWorks: [] }, queue: { items: [] }, pendingCommands: [], backgroundWorks: [], pendingInteractions: [], subagents: { running: [], childSessionIds: [], endedTotal: 0 } };
  assert.equal(isEmptyInitialDraft(initial), true);
  for (const changed of [ { ...initial, revision: 1 }, { ...initial, seq: 1 }, { ...initial, pendingCommands: undefined }, { ...initial, queue: { items: [{ dispatch: { state: 'promoting' } }] } }, { ...initial, rows: { window: [{ kind: 'turnHeader' }] } }, { ...initial, backgroundWorks: [{ status: 'resultPending' }] } ]) assert.equal(isEmptyInitialDraft(changed), false);
});

test('adapter creates a deferred restricted session before V4 admission and waits for authoritative terminal', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/server-info');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '3.16.3', protocolVersion: 1, authRequired: false, serverId: 'isolated-test' }));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  let hello = false;
  let initialized = false;
  let seq = 0;
  let sessionId = 'uncreated';
  let subscriptions = 0;
  let selected = { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' };
  const commandTypes: string[] = [];
  wss.on('connection', (socket) => {
    socket.send(Buffer.from('01000000000000000000000006040106c80100', 'hex'));
    const decoder = new FrameDecoder();
    let eventId: number | undefined;
    const event = (payload: unknown, fromSeq: number, toSeq: number) => {
      assert.notEqual(eventId, undefined);
      socket.send(encodeFrame([204, eventId], { wireVersion: 3, kind: 'complete', deliveryKind: 'online', logicalFrameId: String(toSeq), logicalFrameOrdinal: toSeq + 1, topic: `conversation/${sessionId}`, subscriptionId: 'sub-test', frame: { topic: `conversation/${sessionId}`, subscriptionId: 'sub-test', logEpoch: 'epoch-test', fromSeq, toSeq, payload } }));
    };
    socket.on('message', (raw) => {
      for (const [rawHeader, body] of decoder.accept(raw as Buffer)) {
        const [type, id, channel, method] = rawHeader as any[];
        if (type === 103) continue;
        if (type === 102) { assert.equal(method, 'onDynamicConversationFrame'); eventId = id; continue; }
        if (type !== 100) continue;
        const [params] = body as any[];
        let result: any;
        if (channel === 'project' && method === 'readProjects') result = [];
        else if (channel === 'project' && method === 'saveProject') { assert.deepEqual(params.roots, ['/isolated/workspace']); result = { id: 'project-test', roots: [{ rootPath: '/isolated/workspace' }] }; }
        else if (method === 'helloConversationV4') { hello = true; result = { protocolVersion: 3, clientMode: 'web-remote-replayable', deliveryProfile: 'replayable' }; }
        else if (method === 'initializeConversationV4') { assert.equal(hello, true); assert.equal(params.kind, 'clientHello'); initialized = true; }
        else if (channel === 'model-selection' && method === 'getView') result = { preferredSelection: { ...selected, options: { reasoningLevel: 'max' } } };
        else if (method === 'createSession') {
          assert.equal(params.projectId, 'project-test');
          assert.deepEqual(params.toolDenylist, [...SINGLE_AGENT_TOOL_DENYLIST]);
          assert.equal(params.thoughtLevel, 'max');
          assert.equal(params.titleGenerationEnabled, false);
          assert.equal(params.persistence, 'deferred');
          assert.match(params.sessionId, /^session_zcode_pool_v1_/);
          selected = params.model; sessionId = params.sessionId;
          commandTypes.push('createSession'); result = { session: { sessionId } };
        }
        else if (method === 'sendConversationCommandV4') {
          assert.equal(initialized, true);
          commandTypes.push(params.envelope.type);
          const envelope = params.envelope;
            assert.equal(envelope.type, 'sendText');
            assert.deepEqual(envelope.payload.toolDisallowlist, [...SINGLE_AGENT_TOOL_DENYLIST]);
            assert.equal(envelope.payload.modelSelection.options.reasoningLevel, 'max');
            result = { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0, result: { type: 'inputAccepted', delivery: 'startNow', inputId: 'input' } };
            // All events arrive before command ACK: the public iterator must still return them.
            const header = { kind: 'turnHeader', rowId: 1, turnId: 'product-turn', sourceCommandId: envelope.commandId, state: 'running', startedAt: Date.now() };
            event({ kind: 'deltas', deltas: [{ op: 'row.appended', row: header }] }, seq, ++seq);
            event({ kind: 'deltas', deltas: [{ op: 'row.appended', row: { kind: 'assistantText', rowId: 2, turnId: 'product-turn', text: 'Actual response', state: 'complete' } }] }, seq, ++seq);
            event({ kind: 'deltas', deltas: [{ op: 'row.upserted', row: { ...header, state: 'completedSuccess', endedAt: Date.now() } }, { op: 'state.updated', patch: { control: { phase: 'completedSuccess', activeWorks: [] } } }] }, seq, ++seq);
        } else if (method === 'subscribeConversationV4') {
          subscriptions++;
          assert.equal(params.sessionId, sessionId);
          event({ kind: 'snapshot', snapshot: { sessionId, logEpoch: 'epoch-test', seq, revision: subscriptions, config: { provider: selected.providerId, model: selected.modelId, thought: 'max', mode: 'build' }, control: { phase: 'draft', activeWorks: [] }, queue: { items: [], autoDrain: true }, pendingCommands: [], backgroundWorks: [], pendingInteractions: [], usage: {}, rows: { window: [] } } }, 0, seq);
          result = { ack: { subscriptionId: 'sub-test', mode: 'snapshot', logEpoch: 'epoch-test' } };
        } else if (method === 'unsubscribeConversationV4') result = undefined;
        else if (method === 'readSessionDebug') {
          // Accounting-source failure cannot erase a confirmed execution terminal.
          socket.send(encodeFrame([202, id], { message: 'Native network debug unavailable' }));
          continue;
        }
        else throw new Error(`Unexpected mock method ${method}`);
        socket.send(encodeFrame([201, id], result));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  let connection;
  try {
    const adapter = new ZCodeServerAdapter({ rpcTimeoutMs: 2000 });
    connection = await adapter.connect({ baseUrl: `http://127.0.0.1:${address.port}` });
    const session = await connection.openSession({ workspacePath: '/isolated/workspace', modelSelection: selected });
    const turn = await connection.sendTurn(session, { prompt: 'small task', requestId: 'stable-command', modelSelection: selected });
    assert.equal(turn.turnId, 'stable-command');
    const received = [];
    for await (const event of connection.events(session)) {
      received.push(event);
      if (event.type === 'turn_completed') break;
    }
    assert.equal(received.find((entry) => entry.type === 'turn_started')?.turnId, turn.turnId);
    assert.equal(received.at(-1)?.turnId, turn.turnId);
    assert(received.some(event => event.type === 'runtime_status' && event.data.kind === 'native_error_observation' && event.data.complete === null && event.data.reason === 'source_read_failed'));
    assert.equal((await connection.syncHistory(session)).summary, 'Actual response');
    const before = (await connection.syncHistory(session)).revision;
    const fresh = await connection.freshReadSession(session);
    assert.equal(fresh.revision, before + 1, 'a fresh reader must obtain a new initial snapshot');
    assert.equal((await connection.syncHistory(session)).revision, before, 'the existing connection still holds its own projection');
    assert.deepEqual(commandTypes, ['createSession', 'sendText'], 'fresh read never creates, resumes, or dispatches work');
  } finally {
    await connection?.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  }
});
