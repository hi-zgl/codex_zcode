import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { crc32 } from 'node:zlib';
import { WebSocketServer } from 'ws';
import { ConversationProjection, TopicAssembler, classifyError, redact } from '../../src/runtime/zcode-server/events.js';
import { FrameDecoder, decodeValues, encodeFrame, encodeValue } from '../../src/runtime/zcode-server/rpc.js';
import { ZCodeServerAdapter } from '../../src/runtime/zcode-server/index.js';

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

test('adapter follows official handshake, buffers events, and waits for authoritative terminal', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/api/server-info');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '3.16.3', protocolVersion: 1, authRequired: false, serverId: 'isolated-test' }));
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  let hello = false;
  let initialized = false;
  let seq = 0;
  let eventId: number | undefined;
  let selected = { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' };
  const commandTypes: string[] = [];
  wss.on('connection', (socket) => {
    socket.send(Buffer.from('01000000000000000000000006040106c80100', 'hex'));
    const decoder = new FrameDecoder();
    const event = (payload: unknown, fromSeq: number, toSeq: number) => {
      assert.notEqual(eventId, undefined);
      socket.send(encodeFrame([204, eventId], { wireVersion: 3, kind: 'complete', deliveryKind: 'online', logicalFrameId: String(toSeq), logicalFrameOrdinal: toSeq + 1, topic: 'conversation/session-test', subscriptionId: 'sub-test', frame: { topic: 'conversation/session-test', subscriptionId: 'sub-test', logEpoch: 'epoch-test', fromSeq, toSeq, payload } }));
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
        else if (method === 'sendConversationCommandV4') {
          assert.equal(initialized, true);
          commandTypes.push(params.envelope.type);
          const envelope = params.envelope;
          if (envelope.type === 'createSession') {
            assert.equal(params.projectId, 'project-test');
            selected = envelope.payload.config.modelSelection;
            result = { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0, result: { type: 'createSession', sessionId: 'session-test' } };
          } else {
            assert.equal(envelope.type, 'sendText');
            assert.equal(envelope.payload.modelSelection.options.reasoningLevel, 'max');
            result = { commandId: envelope.commandId, status: 'accepted', revisionAtDecision: 0, result: { type: 'inputAccepted', delivery: 'startNow', inputId: 'input' } };
            // All events arrive before command ACK: the public iterator must still return them.
            const header = { kind: 'turnHeader', rowId: 1, turnId: 'product-turn', sourceCommandId: envelope.commandId, state: 'running', startedAt: Date.now() };
            event({ kind: 'deltas', deltas: [{ op: 'row.appended', row: header }] }, seq, ++seq);
            event({ kind: 'deltas', deltas: [{ op: 'row.appended', row: { kind: 'assistantText', rowId: 2, turnId: 'product-turn', text: 'Actual response', state: 'complete' } }] }, seq, ++seq);
            event({ kind: 'deltas', deltas: [{ op: 'row.upserted', row: { ...header, state: 'completedSuccess', endedAt: Date.now() } }, { op: 'state.updated', patch: { control: { phase: 'completedSuccess', activeWorks: [] } } }] }, seq, ++seq);
          }
        } else if (method === 'subscribeConversationV4') {
          event({ kind: 'snapshot', snapshot: { sessionId: 'session-test', logEpoch: 'epoch-test', seq, revision: 0, config: { provider: selected.providerId, model: selected.modelId, thought: 'max', mode: 'build' }, control: { phase: 'draft', activeWorks: [] }, pendingInteractions: [], usage: {}, rows: { window: [] } } }, 0, seq);
          result = { ack: { subscriptionId: 'sub-test', mode: 'snapshot', logEpoch: 'epoch-test' } };
        } else if (method === 'unsubscribeConversationV4') result = undefined;
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
    assert.equal((await connection.syncHistory(session)).summary, 'Actual response');
    assert.deepEqual(commandTypes, ['createSession', 'sendText']);
  } finally {
    await connection?.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => server.close(() => resolve())));
  }
});
