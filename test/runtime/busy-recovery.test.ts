import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyError, classifyTurnFailure, ConversationProjection, extractRetryAfterMs } from '../../src/runtime/zcode-server/events.js';
import type { RuntimeEvent } from '../../src/runtime/types.js';

const start = 1_793_491_200_000;
const header = (command = 'command-1', rowId = 1, endedAt = start + 100) => ({
  kind: 'turnHeader', rowId, turnId: `product-${command}`, sourceCommandId: command,
  state: 'failed', startedAt: endedAt - 100, endedAt,
});
const busy = (at = start + 100, extra: Record<string, unknown> = {}) => ({
  code: 'model_request_failed', message: 'The model is currently busy. Please try again.',
  recoverable: true, at, source: 'provider', attribution: { statusCode: 503 }, ...extra,
});
const snapshot = (rows: unknown[], lastError?: unknown) => ({
  sessionId: 'session', logEpoch: 'epoch', seq: 0, revision: 0,
  control: { phase: 'error', activeWorks: [], lastError: lastError ?? null }, rows: { window: rows },
});
function project(initial: ReturnType<typeof snapshot>) {
  const events: RuntimeEvent[] = [];
  const projection = new ConversationProjection('session', event => events.push(event));
  projection.apply({ fromSeq: 0, toSeq: 0, payload: { kind: 'snapshot', snapshot: initial } });
  let seq = 0;
  return { events, projection, apply(deltas: unknown[]) {
    projection.apply({ fromSeq: seq, toSeq: ++seq, payload: { kind: 'deltas', deltas } });
  } };
}

test('only explicit model/service busy errors are classified as model_busy', () => {
  for (const error of [
    busy(), { message: '模型繁忙，请稍后再试', source: 'provider' },
    { message: '系统当前繁忙，请稍后重试', source: 'runtime' },
    { code: 'provider_overloaded' }, { code: 'overloaded_error' },
    { message: 'The service is overloaded', status: 503 },
    { message: 'Server is at capacity', status: 429 },
    { message: 'Model execution failed', underlyingErrorMessage: 'The model is busy', attribution: { source: 'provider', statusCode: 503 } },
  ]) assert.equal(classifyError(error), 'model_busy', JSON.stringify(error));
  for (const error of [
    { message: 'busy' }, { message: 'The task updates a busy status column' }, { message: 'Device or resource busy' },
    { kind: 'assistantText', text: '模型繁忙，请继续' },
    { kind: 'toolCall', status: 'error', error: { message: 'The model is busy' } },
    { source: 'tool', message: 'The model is busy' },
    { message: 'Tool failed', detail: { output: 'The model is busy' } },
    { message: 'Request failed', prompt: '模型繁忙', output: 'The model is busy', data: { prompt: 'The model is busy' } },
  ]) assert.equal(classifyError(error), 'unknown', JSON.stringify(error));
});

test('risk, authentication, quota and explicit wait instructions override busy hints', () => {
  assert.equal(classifyError({ ...busy(), error: { code: 3012, message: 'Unusual activity' } }), 'risk_blocked');
  assert.equal(classifyError({ ...busy(), error: { status: 401, message: 'Expired token' } }), 'auth_invalid');
  assert.equal(classifyError({ ...busy(), attribution: { statusCode: 403 }, detail: '风控异常活动' }), 'risk_blocked');
  assert.equal(classifyError(new Error('Invalid credential identity')), 'auth_invalid');
  for (const error of [
    { ...busy(), code: 'insufficient_quota' }, { ...busy(), detail: 'Quota exceeded' },
    { ...busy(), detail: '额度已耗尽' }, { ...busy(), retryAfter: 5 },
    { ...busy(), headers: { 'retry-after': '5' } }, { ...busy(), detail: 'Retry after 5 seconds' },
  ]) assert.equal(classifyError(error), 'rate_limited', JSON.stringify(error));
  assert.equal(classifyError({ status: 429 }), 'rate_limited');
  assert.equal(classifyError({ message: 'Concurrency limit exceeded' }), 'rate_limited');
  assert.equal(classifyError({ status: 503, message: 'Service unavailable' }), 'server_error');
  assert.equal(classifyError({ statusCode: 502 }), 'server_error');
  assert.equal(classifyError({ message: 'Unrecognized native failure' }), 'unknown');
});

test('official same-event timestamps attribute busy to exactly one failed command', () => {
  const own = header();
  const old = header('previous', 2, start - 1000);
  const raw = snapshot([old, own], busy());
  const classified = classifyTurnFailure(raw, own);
  assert.equal(classified.category, 'model_busy');
  assert.equal(classified.errorAttribution, 'turn');
  assert.equal(classified.busyRetryEligible, true);
  assert.equal(classifyTurnFailure(raw, old).busyRetryEligible, false);
  assert.equal(classifyTurnFailure(snapshot([own], busy(0)), own).errorAttribution, 'unattributed');
  for (const invalid of [
    { ...own, startedAt: Number.NaN }, { ...own, endedAt: Number.POSITIVE_INFINITY },
    { ...own, startedAt: own.endedAt + 1 }, { ...own, endedAt: undefined },
    { ...own, startedAt: 0, endedAt: 0 },
  ]) assert.equal(classifyTurnFailure(snapshot([invalid], busy()), invalid).busyRetryEligible, false);
  assert.equal(classifyTurnFailure(snapshot([own, header('collision', 3)], busy()), own).busyRetryEligible, false);
});

test('explicit identities must agree and tool errors never authorize continuation', () => {
  const own = header();
  const error = { ...busy(), sourceCommandId: own.sourceCommandId, turnId: own.turnId };
  assert.equal(classifyTurnFailure(snapshot([own], error), own).busyRetryEligible, true);
  for (const conflict of [
    { ...error, sourceCommandId: 'another-command' }, { ...error, turnId: 'another-turn' },
    { ...error, attribution: { turnId: 'another-turn' } },
    { ...error, source: 'tool' },
  ]) assert.equal(classifyTurnFailure(snapshot([own], conflict), own).busyRetryEligible, false);
  const tool = { kind: 'toolCall', rowId: 2, turnId: own.turnId, status: 'error', error: busy() };
  assert.equal(classifyTurnFailure(snapshot([own, tool]), own).busyRetryEligible, false);
  const text = { kind: 'assistantText', rowId: 3, turnId: own.turnId, text: '模型繁忙' };
  assert.equal(classifyTurnFailure(snapshot([own, text]), own).busyRetryEligible, false);
  const rowError = { kind: 'error', rowId: 4, turnId: own.turnId, message: '模型繁忙', source: 'provider' };
  assert.equal(classifyTurnFailure(snapshot([own, rowError]), own).busyRetryEligible, true);
  const auth = { ...rowError, rowId: 5, code: 401, message: 'Invalid token' };
  assert.equal(classifyTurnFailure(snapshot([own, rowError, auth]), own).category, 'auth_invalid');
  const unknown = { ...rowError, rowId: 6, message: 'Unrecognized native failure' };
  assert.equal(classifyTurnFailure(snapshot([own, rowError, unknown]), own).busyRetryEligible, false);
});

test('whole-batch projection sees the terminal error regardless of delta order', () => {
  for (const reverse of [false, true]) {
    const own = header();
    const live = project(snapshot([{ ...own, state: 'running', endedAt: undefined }]));
    const deltas = [
      { op: 'row.upserted', row: own },
      { op: 'state.updated', patch: { control: { phase: 'error', activeWorks: [], lastError: busy() } } },
    ];
    live.apply(reverse ? deltas.reverse() : deltas);
    const terminal = live.events.find(event => event.type === 'turn_failed')!;
    assert.equal(terminal.turnId, own.sourceCommandId);
    assert.equal(terminal.data.busyRetryEligible, true);
    assert.equal(live.projection.snapshot?.control.lastError.at, own.endedAt);
    assert.equal(live.events.find(event => event.type === 'error')?.turnId, own.sourceCommandId);
  }
});

test('deferred batch events preserve turn attribution, order and the text before each delta', () => {
  const own = header();
  const live = project(snapshot([]));
  live.apply([
    { op: 'row.appended', row: { ...own, state: 'running', endedAt: undefined } },
    { op: 'row.appended', row: { kind: 'assistantText', rowId: 2, turnId: own.turnId, text: 'First' } },
    { op: 'row.delta', rowId: 2, path: 'text', append: ' second' },
    { op: 'row.delta', rowId: 2, path: 'text', append: ' third' },
  ]);
  const emitted = live.events.filter(event => event.type !== 'session_snapshot');
  assert.deepEqual(emitted.map(event => event.type), ['turn_started', 'assistant_message', 'assistant_message', 'assistant_message']);
  assert.ok(emitted.every(event => event.turnId === own.sourceCommandId));
  assert.deepEqual(emitted.slice(1).map(event => event.data.text), ['First', ' second', ' third']);
  assert.equal(live.projection.snapshot?.rows.window[1].text, 'First second third');
});

test('historical lastError stays with its failed turn across snapshots and later failures', () => {
  const old = header('previous', 1);
  const next = header('next', 2, start + 1000);
  const initial = project(snapshot([old, next], busy()));
  const failed = initial.events.filter(event => event.type === 'turn_failed');
  assert.equal(failed.find(event => event.turnId === 'previous')?.data.busyRetryEligible, true);
  assert.equal(failed.find(event => event.turnId === 'next')?.data.busyRetryEligible, false);
  assert.equal(initial.events.find(event => event.type === 'error')?.turnId, 'previous');
  const live = project(snapshot([old], busy()));
  live.apply([{ op: 'row.appended', row: { ...next, state: 'running', endedAt: undefined } }]);
  live.apply([{ op: 'row.upserted', row: next }, { op: 'state.updated', patch: { control: { phase: 'error', lastError: busy() } } }]);
  const terminal = live.events.find(event => event.type === 'turn_failed' && event.turnId === 'next')!;
  assert.equal(terminal.data.errorAttribution, 'unattributed');
  assert.equal(terminal.data.busyRetryEligible, false);
  assert.equal(terminal.data.error, undefined);
});

test('clearing error resets deduplication and a split error-before-terminal is still attributed', () => {
  const old = header('previous', 1);
  const next = header('next', 2, start + 1000);
  const live = project(snapshot([old], busy()));
  live.apply([
    { op: 'row.appended', row: { ...next, state: 'running', endedAt: undefined } },
    { op: 'state.updated', patch: { control: { phase: 'running', lastError: null } } },
  ]);
  live.apply([{ op: 'state.updated', patch: { control: { phase: 'error', lastError: busy(next.endedAt) } } }]);
  const error = live.events.filter(event => event.type === 'error').at(-1)!;
  assert.equal(error.turnId, undefined, 'a timestamp alone cannot bind to a still-running header');
  live.apply([{ op: 'row.upserted', row: next }]);
  const terminal = live.events.find(event => event.type === 'turn_failed' && event.turnId === 'next')!;
  assert.equal(terminal.data.busyRetryEligible, true);
  assert.equal(terminal.data.category, 'model_busy');
  const unowned = { message: 'Unrecognized failure' };
  const same = project(snapshot([], unowned));
  same.apply([{ op: 'state.updated', patch: { control: { lastError: null } } }]);
  same.apply([{ op: 'state.updated', patch: { control: { lastError: unowned } } }]);
  assert.equal(same.events.filter(event => event.type === 'error').length, 2);
});


test('provider retry delays respect units and do not read arbitrary output', () => {
  assert.equal(extractRetryAfterMs({ data: { retryAfterMs: 1500 } }), 1500);
  assert.equal(extractRetryAfterMs({ response: { headers: { 'Retry-After': '2' } } }), 2000);
  assert.equal(extractRetryAfterMs({ retryDelayMs: 500, data: { retry_after: 3 } }), 3000);
  assert.equal(extractRetryAfterMs({ headers: { 'retry-after': 'Tue, 03 Nov 2026 00:00:10 GMT' } }, Date.parse('2026-11-03T00:00:00Z')), 10000);
  assert.equal(extractRetryAfterMs({ data: { retryAfter: -1 }, nextRetryAt: 999999 }), undefined);
  assert.equal(extractRetryAfterMs({ kind: 'assistantText', text: 'retry after 99 seconds', retryAfterMs: 99000 }), undefined);
});
