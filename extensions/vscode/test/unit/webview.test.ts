/// <reference lib="dom" />
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { WebviewBridge, BridgeError, type VsCodeApi } from '../../src/webview/bridge.js';
import { WorkbenchApp } from '../../src/webview/main.js';
import { applySnapshot, approvalDisabled, connectionIdentity, createState, filterTasks, mutationReason, needsAttention, persistedUi, selectedTask, validateDraft } from '../../src/webview/state.js';
import { renderApp } from '../../src/webview/components.js';
import type { UiSnapshot } from '../../src/host/types.js';
import type { WebviewRequest } from '../../src/host/protocol.js';
import type { UiApprovalReview, UiTaskDetail, UiArtifactManifest, UiArtifactFile } from '../../../../src/shared/ui-contract.js';

const fixture = JSON.parse(readFileSync(join(process.cwd(), process.cwd().endsWith('/extensions/vscode') ? 'test/fixtures/pool-demo.json' : 'extensions/vscode/test/fixtures/pool-demo.json'), 'utf8'));
let browser: Window;
const apps: WorkbenchApp[] = [];
const bridges: WebviewBridge[] = [];
beforeEach(() => {
  browser = new Window({ url: 'https://webview.example/' });
  Object.assign(globalThis, { window: browser, document: browser.document, HTMLElement: browser.HTMLElement, HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement, HTMLSelectElement: browser.HTMLSelectElement });
});
afterEach(async () => { for (const app of apps.splice(0)) app.dispose(); for (const bridge of bridges.splice(0)) bridge.dispose(); await browser.happyDOM.close(); });
function snapshot(selected = 'task-approval'): UiSnapshot {
  const details = structuredClone(fixture.details) as Record<string, UiTaskDetail>;
  const detail = details[selected] ?? null;
  const manifest = selected === 'task-complete' ? structuredClone(fixture.manifests[selected]) as UiArtifactManifest : null;
  return {
    connection: { state: 'connected', mode: 'mock', generation: 1, host: 'SSH: isolated-host', poolHome: '/mock/pool', trusted: true, lastReceivedAtMs: Date.now(), stale: false, storeId: 'mock-store', instanceId: 'mock-instance', daemonVersion: '0.1.0', capabilities: structuredClone(fixture.capabilities.capabilities), error: null },
    tasks: Object.values(details), scope: 'recent_50_loaded', total: null, listNextCursor: null, selectedTaskId: detail?.taskId ?? null, detail,
    resources: { accounts: structuredClone(fixture.overview.accounts), workers: fixture.overview.workers.map((worker: object) => ({ ...worker, leaseTaskIds: [] })), workspaces: structuredClone(fixture.overview.workspaces), quotas: {} },
    approvals: null, delivery: { manifest, files: manifest?.manifestSha256 ? structuredClone(fixture.files[manifest.manifestSha256]) as UiArtifactFile[] : [], nextCursor: null, reviewed: false },
    draft: { workspaceId: 'workspace-demo', workerId: 'worker-demo', prompt: '', session: 'continue', mode: 'build', modelId: 'GLM-5.3-Flash', busyRetryLimit: 3, verifyCommands: [], submitToken: 'draft-token' }, actions: [], overviewIntervalSeconds: 30, poolPolicy: null, notice: null,
  };
}
function review(): UiApprovalReview { const value = structuredClone(fixture.reviews['approval-demo']) as UiApprovalReview; value.expiresAtMs = Date.now() + 300_000; return value; }
function harness(initial = snapshot()) {
  let current = structuredClone(initial); const sent: WebviewRequest[] = []; const saved: unknown[] = [];
  let handler: ((request: WebviewRequest) => unknown | Promise<unknown>) | undefined;
  const api: VsCodeApi = { getState: () => null, setState: value => saved.push(structuredClone(value)), postMessage: request => {
    sent.push(structuredClone(request));
    if (handler) queueMicrotask(() => { void Promise.resolve().then(() => handler!(request)).then(data => bridge.receive({ v: 1, id: request.id, generation: current.connection.generation, ok: true, data }), error => bridge.receive({ v: 1, id: request.id, generation: current.connection.generation, ok: false, error: error instanceof BridgeError ? error.detail : { code: 'TEST_ERROR', message: String(error) } })); });
  } };
  const bridge = new WebviewBridge(api, browser as unknown as Window & globalThis.Window); bridges.push(bridge);
  const root = browser.document.createElement('div'); root.id = 'app'; browser.document.body.append(root);
  const app = new WorkbenchApp(root as unknown as HTMLElement, bridge); apps.push(app);
  return { app, root, bridge, sent, saved,
    push: (value = current) => { current = structuredClone(value); bridge.receive({ v: 1, type: 'state', generation: current.connection.generation, data: current }); },
    reply: (fn: (request: WebviewRequest) => unknown | Promise<unknown>) => { handler = fn; },
  };
}
function choose(root: ParentNode, action: string, decision?: string): HTMLButtonElement { const element = root.querySelector(`[data-action="${action}"]${decision ? `[data-decision="${decision}"]` : ''}`); assert.ok(element, `missing ${action}/${decision ?? ''}`); return element as HTMLButtonElement; }

test('bootstrap and explicit connection do not turn generation changes into failed actions', async () => {
  const initial = snapshot(); initial.connection.state = 'disconnected'; initial.connection.generation = 0; initial.connection.storeId = null; initial.tasks = []; initial.detail = null; initial.selectedTaskId = null;
  const h = harness(initial); h.reply(request => request.type === 'ready' ? initial : {}); await h.app.start();
  assert.deepEqual(h.sent.map(request => request.type), ['ready']);
  assert.match(h.root.textContent!, /连接任务工作台/);
  const connected = snapshot();
  h.reply(request => { assert.equal(request.type, 'connect'); h.push(connected); return connected; });
  await h.app.action('connect');
  assert.equal(h.app.state.snapshot!.connection.state, 'connected');
  assert.equal(h.app.state.errors.size, 0);
  assert.deepEqual(h.sent.map(request => request.type), ['ready', 'connect']);
});

test('connection generation evicts old business reads but accepts its own disconnect ACK', async () => {
  const h = harness(); h.push();
  const read = h.bridge.request('events.read', { taskId: 'task-approval' }).catch(error => error);
  const disconnected = snapshot(); disconnected.connection.generation = 2; disconnected.connection.state = 'disconnected';
  h.reply(request => { h.push(disconnected); return disconnected; });
  await h.app.action('disconnect');
  assert.equal((await read as BridgeError).detail.code, 'STALE_CONNECTION');
  assert.equal(h.app.state.errors.has('disconnect'), false);
  assert.equal(h.app.state.snapshot!.connection.generation, 2);
});

test('directory selection and explicit daemon start accept their own connection generation changes', async () => {
  for (const action of ['connection.configure', 'daemon.start'] as const) {
    const h = harness(); h.push();
    const oldRead = h.bridge.request('events.read', { taskId: 'task-approval' }).catch(error => error);
    const next = snapshot(); next.connection.generation = 2;
    if (action === 'connection.configure') { next.connection.poolHome = '/chosen/pool'; next.connection.state = 'disconnected'; next.connection.storeId = null; }
    h.reply(request => { assert.equal(request.type, action); h.push(next); return {}; });
    await h.app.action(action);
    assert.equal((await oldRead as BridgeError).detail.code, 'STALE_CONNECTION');
    assert.equal(h.app.state.errors.has(action), false);
    assert.equal(h.app.state.snapshot!.connection.generation, 2);
    h.bridge.receive({ v: 1, type: 'state', generation: 1, data: snapshot() });
    assert.equal(h.app.state.snapshot!.connection.generation, 2, 'an old Host cannot roll the connection back');
    assert.deepEqual(h.sent.filter(request => request.type !== 'events.read').map(request => request.type), [action]);
  }
});

test('disconnected welcome exposes direct directory selection and gates explicit real daemon start', () => {
  const s = snapshot(); s.connection.state = 'disconnected'; s.tasks = []; s.selectedTaskId = null; s.detail = null;
  const state = createState(); applySnapshot(state, s);
  let dom = renderApp({ state, action: () => {} });
  assert.ok(choose(dom, 'connection.configure'));
  assert.equal(dom.querySelector('[data-action="daemon.start"]'), null, 'mock mode cannot start a daemon');
  s.connection.mode = 'real'; applySnapshot(state, s); dom = renderApp({ state, action: () => {} });
  assert.equal(choose(dom, 'daemon.start').disabled, false);
  s.connection.trusted = false; applySnapshot(state, s); dom = renderApp({ state, action: () => {} });
  assert.equal(choose(dom, 'daemon.start').disabled, true);
  assert.match(choose(dom, 'daemon.start').getAttribute('aria-label')!, /信任/);
  s.connection.trusted = true; s.connection.supported = false; applySnapshot(state, s); dom = renderApp({ state, action: () => {} });
  assert.equal(choose(dom, 'daemon.start').disabled, true);
});

test('task monitoring leads with Codex setup and keeps manual dispatch under advanced actions', () => {
  const s = snapshot(); s.connection.mode = 'real'; const state = createState(); applySnapshot(state, s);
  const dom = renderApp({ state, action: () => {} });
  assert.ok(choose(dom, 'connection.codexSetup').classList.contains('primary'));
  const manual = choose(dom, 'compose.open');
  assert.equal(manual.classList.contains('primary'), false);
  const advanced = manual.closest('details'); assert.ok(advanced); assert.equal(advanced.open, false);
  assert.match(dom.textContent!, /由 Codex 拆分、派发和验收任务/);
  assert.match(dom.textContent!, /额度与资源/);
});

test('Codex setup is explicit and generates configuration without claiming a connected Codex', async () => {
  const s = snapshot(); s.connection.mode = 'real'; s.connection.state = 'disconnected'; s.tasks = []; s.detail = null; s.selectedTaskId = null;
  const h = harness(s); h.push(s);
  assert.equal(h.sent.length, 0);
  assert.equal(choose(h.root as unknown as ParentNode, 'connection.codexSetup').disabled, false, 'daemon connection is not needed to generate setup');
  let finish!: (value: unknown) => void;
  h.reply(request => { assert.equal(request.type, 'connection.codexSetup'); assert.deepEqual(request.payload, {}); return new Promise(resolve => { finish = resolve; }); });
  const generating = h.app.action('connection.codexSetup');
  await h.app.action('connection.codexSetup');
  assert.equal(h.sent.length, 1, 'pending setup is not duplicated');
  finish({ opened: true }); await generating;
  assert.equal(h.app.state.snapshot!.connection.state, 'disconnected');
  assert.match(h.app.state.message, /已生成 MCP 配置.*在 Codex 中启用/);
  assert.doesNotMatch(h.app.state.message, /已连接/);
  assert.equal(h.sent.some(request => ['connect', 'daemon.start', 'dispatch'].includes(request.type)), false);
  h.app.state.message = ''; h.reply(() => ({ cancelled: true })); await h.app.action('connection.codexSetup');
  assert.equal(h.app.state.message, '', 'a cancelled native setup does not claim success');
});

test('Codex setup is unavailable for mock, untrusted and unsupported execution hosts', () => {
  for (const reason of ['mock', 'untrusted', 'unsupported'] as const) {
    const s = snapshot(); s.connection.mode = 'real';
    if (reason === 'mock') s.connection.mode = 'mock';
    if (reason === 'untrusted') s.connection.trusted = false;
    if (reason === 'unsupported') s.connection.supported = false;
    const state = createState(); applySnapshot(state, s);
    const dom = renderApp({ state, action: () => {} }); assert.equal(choose(dom, 'connection.codexSetup').disabled, true, reason);
  }
});

test('concurrency settings validate explicit limits and send only the shared pool policy', async () => {
  const s = snapshot(); s.poolPolicy = { maxConcurrentTasks: null, occupiedSlots: 2, availableSlots: null }; s.connection.capabilities.poolPolicy = { version: 1 };
  const h = harness(s); h.push(s); await h.app.action('page', { page: 'settings' });
  const setLimit = (value: string) => {
    const control = h.root.querySelector('[data-field="settingsConcurrency"]') as unknown as HTMLInputElement;
    control.value = value; control.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
  };
  h.reply(request => {
    assert.equal(request.type, 'pool.policy.set');
    const value = (request.payload as { maxConcurrentTasks: number | null }).maxConcurrentTasks;
    s.poolPolicy = { maxConcurrentTasks: value, occupiedSlots: 2, availableSlots: value === null ? null : Math.max(0, value - 2) };
    h.push(s); return { policy: s.poolPolicy };
  });
  for (const invalid of ['-1', '1.5', '65']) { setLimit(invalid); await h.app.action('pool.policy.set'); assert.equal(h.sent.length, 0); assert.ok(h.app.state.validation.settingsConcurrency); }
  for (const [input, value] of [['0', 0], ['3', 3], ['', null]] as const) {
    setLimit(input); await h.app.action('pool.policy.set');
    assert.deepEqual(h.sent.at(-1)!.payload, { maxConcurrentTasks: value });
    assert.equal(h.app.state.settingsConcurrency, input);
    assert.equal(h.app.state.policyDirty, false);
  }
  assert.equal(h.sent.length, 3);
  assert.ok(h.sent.every(request => request.type === 'pool.policy.set'));
  assert.match(h.root.textContent!, /降低上限不会停止已有任务/);
  assert.equal(h.app.state.snapshot!.poolPolicy!.occupiedSlots, 2);
});

test('refreshes preserve an unsaved concurrency limit, and policy writes require a current capable trusted connection', async () => {
  const s = snapshot(); s.poolPolicy = { maxConcurrentTasks: 4, occupiedSlots: 2, availableSlots: 2 }; s.connection.capabilities.poolPolicy = { version: 1 };
  const h = harness(s); h.push(s); await h.app.action('page', { page: 'settings' });
  const control = h.root.querySelector('[data-field="settingsConcurrency"]') as unknown as HTMLInputElement;
  control.value = '1'; control.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
  h.push(s); assert.equal(h.app.state.settingsConcurrency, '1'); assert.equal(h.app.state.policyDirty, true);
  for (const reason of ['capability', 'trust', 'stale', 'policy'] as const) {
    const changed = structuredClone(s);
    if (reason === 'capability') delete changed.connection.capabilities.poolPolicy;
    if (reason === 'trust') changed.connection.trusted = false;
    if (reason === 'stale') changed.connection.stale = true;
    if (reason === 'policy') changed.poolPolicy = null;
    h.push(changed); assert.equal(choose(h.root as unknown as ParentNode, 'pool.policy.set').disabled, true, reason);
  }
  const changedPool = structuredClone(s); changedPool.connection.poolHome = '/another/pool'; h.push(changedPool);
  assert.equal(h.app.state.settingsConcurrency, '4'); assert.equal(h.app.state.policyDirty, false);
});

test('one approval click opens and validates the complete content without sending a decision', async () => {
  const h = harness(); h.push(); const descriptor = review();
  h.app.state.tab = 'approvals';
  h.app.state.snapshot!.approvals = { items: [{ approvalId: descriptor.approvalId, kind: 'permission', toolName: 'Write', summary: 'Write src/demo.ts', truncated: true, sourceComplete: true, responseState: 'none', readOnlyReason: null }], total: 1, nextCursor: null, approvalSetRevision: 'set', stateKnown: true, unattributedCount: 0 };
  let release!: (value: unknown) => void;
  h.reply(request => request.type === 'approval.open' ? descriptor : new Promise(resolve => { assert.equal(request.type, 'approval.read'); release = resolve; }));
  const opening = h.app.action('approval.open', { taskId: descriptor.taskId, approvalId: descriptor.approvalId });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.sent.map(request => request.type), ['approval.open', 'approval.read']);
  assert.equal(h.app.state.reviews.get(descriptor.approvalId)!.loading, true);
  assert.equal(choose(h.root as unknown as ParentNode, 'approval.respond', 'accept').disabled, true);
  assert.equal(h.root.querySelector('[data-action="approval.read"]'), null, 'complete reading has no extra click');
  await h.app.action('approval.open', { taskId: descriptor.taskId, approvalId: descriptor.approvalId });
  assert.equal(h.sent.length, 2, 'a duplicate click does not create a second review');
  release({ review: descriptor, loadedComplete: true, text: fixture.approvalContents[descriptor.reviewId] }); await opening;
  assert.equal(h.app.state.reviews.get(descriptor.approvalId)!.loadedComplete, true);
  assert.equal(choose(h.root as unknown as ParentNode, 'approval.respond', 'accept').disabled, false);
  assert.equal(h.sent.some(request => request.type === 'approval.respond'), false);
});

test('combined approval reading rejects changed ownership and hashes, and retries from a fresh review', async () => {
  for (const mismatch of ['hash', 'owner', 'task'] as const) {
    const h = harness(); h.push(); const descriptor = review(); let fail = true;
    h.reply(request => {
      if (request.type === 'approval.open') return descriptor;
      assert.equal(request.type, 'approval.read'); const changed = structuredClone(descriptor);
      if (fail) { if (mismatch === 'hash') changed.content!.sha256 = 'a'.repeat(64); else if (mismatch === 'owner') changed.owner.commandId = 'other-command'; else changed.taskId = 'other-task'; }
      return { review: changed, loadedComplete: true, text: fixture.approvalContents[descriptor.reviewId] };
    });
    const data = { taskId: descriptor.taskId, approvalId: descriptor.approvalId };
    await h.app.action('approval.open', data);
    let entry = h.app.state.reviews.get(descriptor.approvalId)!;
    assert.equal(entry.loadedComplete, false, mismatch); assert.equal(entry.loading, false, mismatch); assert.equal(entry.text, null, mismatch);
    assert.match(h.app.state.errors.get(`approval:${descriptor.approvalId}`)!, /INTEGRITY_MISMATCH/);
    assert.ok(approvalDisabled(h.app.state, entry, 'accept'));
    fail = false; await h.app.action('approval.open', data); entry = h.app.state.reviews.get(descriptor.approvalId)!;
    assert.equal(entry.loadedComplete, true); assert.equal(h.app.state.errors.has(`approval:${descriptor.approvalId}`), false);
    assert.deepEqual(h.sent.map(request => request.type), ['approval.open', 'approval.read', 'approval.open', 'approval.read']);
  }
});

test('a task change during combined review loading discards the old content', async () => {
  const h = harness(); h.push(); const descriptor = review(); let release!: (value: unknown) => void;
  h.reply(request => request.type === 'approval.open' ? descriptor : new Promise(resolve => { release = resolve; }));
  const opening = h.app.action('approval.open', { taskId: descriptor.taskId, approvalId: descriptor.approvalId });
  await new Promise(resolve => setImmediate(resolve));
  h.push(snapshot('task-complete'));
  release({ review: descriptor, loadedComplete: true, text: fixture.approvalContents[descriptor.reviewId] }); await opening;
  assert.equal(h.app.state.reviews.size, 0); assert.equal(h.root.textContent!.includes('Complete approval content'), false);
  assert.equal(h.sent.some(request => request.type === 'approval.respond'), false);
});

test('approval acceptance needs complete validated content; decline does not need read-all', () => {
  const state = createState(); applySnapshot(state, snapshot());
  const entry = { review: review(), text: null as string | null, loadedComplete: false, loading: false, error: null, locked: false };
  state.reviews.set(entry.review.approvalId, entry); state.tab = 'approvals';
  assert.match(approvalDisabled(state, entry, 'accept')!, /尚未读齐/);
  assert.equal(approvalDisabled(state, entry, 'decline'), null);
  entry.text = fixture.approvalContents[entry.review.reviewId]; entry.loadedComplete = true;
  assert.equal(approvalDisabled(state, entry, 'accept'), null);
  entry.review.content!.sourceComplete = false;
  assert.match(approvalDisabled(state, entry, 'accept')!, /可信来源/);
  assert.match(approvalDisabled(state, entry, 'decline')!, /可信来源/);
});

test('approval response sends a bound single decision and keeps ACK pending without changing task status', async () => {
  const h = harness(); h.push(); const descriptor = review();
  h.app.state.tab = 'approvals'; h.app.state.snapshot!.approvals = { items: [{ approvalId: descriptor.approvalId, kind: 'permission', toolName: 'Write', summary: '<img src=x onerror=alert(1)>', truncated: true, sourceComplete: true, responseState: 'none', readOnlyReason: null }], total: 1, nextCursor: null, approvalSetRevision: 'set-1', stateKnown: true, unattributedCount: 0 };
  h.app.state.reviews.set(descriptor.approvalId, { review: descriptor, text: fixture.approvalContents[descriptor.reviewId], loadedComplete: true, loading: false, error: null, locked: false });
  h.reply(request => {
    assert.equal(request.type, 'approval.respond');
    return { taskId: descriptor.taskId, approvalId: descriptor.approvalId, actionId: 'action-once', responseState: 'awaiting_native', nativeRevisionAtCheck: descriptor.nativeRevision, taskRevision: 99 };
  });
  await h.app.action('approval.respond', { taskId: descriptor.taskId, approvalId: descriptor.approvalId, decision: 'accept' });
  const request = h.sent[0]!; assert.equal(request.type, 'approval.respond');
  assert.deepEqual(request.payload, { taskId: descriptor.taskId, approvalId: descriptor.approvalId, decision: 'accept', reviewId: descriptor.reviewId, contentSha256: descriptor.content!.sha256, approvalRevision: descriptor.approvalRevision, nativeRevision: descriptor.nativeRevision });
  assert.equal(h.app.state.snapshot!.detail!.status, 'waiting_approval');
  assert.match(h.root.textContent!, /等待确认|等待后台确认/);
  assert.equal(choose(h.root as unknown as ParentNode, 'approval.respond', 'accept').disabled, true);
  assert.equal(choose(h.root as unknown as ParentNode, 'approval.respond', 'decline').disabled, true);
  assert.equal(h.root.querySelector('img'), null, 'projected approval text must never become markup');
  assert.ok(h.saved.every(value => !JSON.stringify(value).includes('Complete approval content')));
});

test('changed approval discards old complete text and requires a new descriptor', async () => {
  const h = harness(); h.push(); const descriptor = review();
  h.app.state.reviews.set(descriptor.approvalId, { review: descriptor, text: 'complete private body', loadedComplete: true, loading: false, error: null, locked: false });
  h.reply(() => { throw new BridgeError({ code: 'APPROVAL_CHANGED', message: 'Reload current review.' }); });
  await h.app.action('approval.respond', { taskId: descriptor.taskId, approvalId: descriptor.approvalId, decision: 'accept' });
  const entry = h.app.state.reviews.get(descriptor.approvalId)!;
  assert.equal(entry.text, null); assert.equal(entry.loadedComplete, false);
  assert.equal(entry.review.readOnlyReason, 'APPROVAL_CHANGED');
  assert.ok(approvalDisabled(h.app.state, entry, 'decline'));
});

test('approval presentation exposes every decision field with readable newlines, and folds technical fingerprints', () => {
  const state = createState(); applySnapshot(state, snapshot()); state.tab = 'approvals';
  const descriptor = review(); state.snapshot!.approvals = { items: [{ approvalId: descriptor.approvalId, kind: 'permission', toolName: 'Write', summary: 'Write src/demo.ts', truncated: true, sourceComplete: true, responseState: 'none', readOnlyReason: null }], total: 1, nextCursor: null, approvalSetRevision: 'set', stateKnown: true, unattributedCount: 0 };
  state.reviews.set(descriptor.approvalId, { review: descriptor, text: fixture.approvalContents[descriptor.reviewId], loadedComplete: true, loading: false, error: null, locked: false });
  const dom = renderApp({ state, action: () => {} });
  assert.match(dom.textContent!, /本次请求的操作/); assert.match(dom.textContent!, /src\/demo.ts/);
  const parameter = dom.querySelector('[aria-label$="参数 content"]'); assert.ok(parameter);
  assert.match(parameter.textContent!, /\nexport const example/);
  const canonical = dom.querySelector('.review-canonical code')!;
  assert.match(canonical.textContent!, /\n  "schema"/);
  assert.equal(dom.querySelector('details.review-identity')?.hasAttribute('open'), false);
});

test('late event pages and approval bodies never appear in a newly selected task', async () => {
  const h = harness(); h.push();
  let release!: (value: unknown) => void;
  h.reply(() => new Promise(resolve => { release = resolve; }));
  const read = h.app.action('events.read', { taskId: 'task-approval', cursor: '0' });
  await new Promise(resolve => setTimeout(resolve, 0));
  h.push(snapshot('task-complete'));
  release({ events: [{ revision: 8, type: 'OLD TASK PRIVATE EVENT' }], nextCursor: 8 }); await read;
  assert.equal(h.app.state.events.length, 0);
  assert.ok(!h.root.textContent!.includes('OLD TASK PRIVATE EVENT'));
});

test('event and patch paging follow cursors and preserve split UTF-16 surrogate pairs', async () => {
  const h = harness(); h.push();
  h.reply(request => request.type === 'events.read' ? { events: [], nextCursor: 42 } : request.type === 'patch.read' && !request.payload.offset ? { available: true, text: 'first\ud83d', nextOffset: 6 } : { available: true, text: '\ude00last', nextOffset: null });
  await h.app.action('events.read', { taskId: 'task-approval', cursor: '0' });
  assert.equal(h.app.state.eventsCursor, 42, 'empty pages do not invent EOF');
  await h.app.action('patch.read', { taskId: 'task-approval', offset: '0' });
  assert.equal(h.app.state.patchNextOffset, 6);
  await h.app.action('patch.read', { taskId: 'task-approval', offset: '6' });
  assert.equal(h.app.state.patch, 'first😀last'); assert.equal(h.app.state.patchNextOffset, null);
});

test('verifying is active, recent-window filters are literal, and stale cache disables writes', () => {
  const s = snapshot(); s.tasks.push({ ...s.tasks[0]!, taskId: 'verify-only', status: 'verifying', leaseHeld: true });
  const task = s.tasks.at(-1)!;
  assert.equal(needsAttention(task, s), false);
  const state = createState(); applySnapshot(state, s); state.filters.status = 'active';
  assert.ok(filterTasks(s, state.filters).some(item => item.taskId === 'verify-only'));
  state.filters.query = '.*'; assert.equal(filterTasks(s, state.filters).length, 0, 'search is literal, not regex');
  s.connection.stale = true; assert.match(mutationReason(s, 'dispatchTask')!, /缓存/);
  const dom = renderApp({ state, action: () => {} }); assert.match(dom.textContent!, /历史总数未知/);
});

test('draft validation names resource occupancy and field errors without persisting prompt', () => {
  const s = snapshot(); const state = createState(); applySnapshot(state, s);
  const draft = state.draft!; draft.prompt = 'PRIVATE DRAFT'; draft.busyRetryLimit = 11; draft.verifyCommands = [{ command: '', args: [], timeoutMs: 99 }];
  const errors = validateDraft(s, draft); assert.match(errors.busyRetryLimit!, /0–10/); assert.ok(errors['verify.0.command']); assert.ok(errors['verify.0.timeoutMs']);
  const worker = s.resources.workers.find(item => item.workerId === draft.workerId)!; worker.leaseTaskIds = ['outside-recent-window'];
  assert.match(validateDraft(s, draft).workerId!, /outside-recent-window/);
  const persisted = JSON.stringify(persistedUi(state)); assert.equal(persisted.includes('PRIVATE DRAFT'), false); assert.equal(persisted.includes('verifyCommands'), false);
});

test('manifest or connection identity changes clear inspected files and sensitive review memory', () => {
  const state = createState(); const s = snapshot('task-complete'); applySnapshot(state, s);
  state.inspectedFiles.add('file-old'); state.reviews.set('approval-demo', { review: review(), text: 'PRIVATE', loadedComplete: true, loading: false, error: null, locked: false });
  const changed = structuredClone(s); changed.delivery.manifest!.manifestSha256 = 'a'.repeat(64); applySnapshot(state, changed); assert.equal(state.inspectedFiles.size, 0);
  changed.connection.storeId = 'other-store'; changed.connection.generation++; applySnapshot(state, changed);
  assert.equal(state.reviews.size, 0); assert.equal(state.draftDirty, false); assert.equal(state.filters.project, '');
});

test('tab keyboard arrows and End update selection and maintain accessible tab/tabpanel identities', async () => {
  const h = harness(); const s = snapshot(); s.connection.capabilities.approvalRead!.version = 0; s.connection.capabilities.artifactSnapshots!.version = 0; h.push(s);
  h.reply(request => request.type === 'events.read' ? { events: [], nextCursor: null } : {});
  let tab = h.root.querySelector('[role="tab"][aria-selected="true"]')!; (tab as unknown as HTMLElement).focus();
  tab.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(h.app.state.tab, 'approvals'); assert.equal(browser.document.activeElement?.id, 'tab-approvals');
  tab = h.root.querySelector('#tab-approvals')!; tab.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(h.app.state.tab, 'events'); assert.equal(browser.document.activeElement?.id, 'tab-events');
  assert.equal(h.root.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby'), 'tab-events');
});

test('invalid command args are preserved as entered and block dispatch', async () => {
  const h = harness(); h.push(); await h.app.action('compose.open'); await h.app.action('verify.add');
  const args = h.root.querySelector('[data-field="verify.0.args"]')!;
  (args as unknown as HTMLInputElement).value = '["unfinished'; args.dispatchEvent(new browser.Event('input', { bubbles: true })); args.dispatchEvent(new browser.Event('change', { bubbles: true }));
  assert.equal((h.root.querySelector('[data-field="verify.0.args"]') as unknown as HTMLInputElement).value, '["unfinished');
  await h.app.action('dispatch'); assert.ok(h.app.state.validation['verify.0.args']); assert.equal(h.sent.some(request => request.type === 'dispatch'), false);
});

test('quota zero, unknown timestamps and failed live probe remain different facts', () => {
  const s = snapshot(); const alias = s.resources.accounts[0]!.alias;
  s.resources.quotas[alias] = { accountAlias: alias, imported: { source: 'imported_snapshot', accountAlias: alias, providerId: 'provider', observedAtMs: null, storedAtMs: null, tier: 'unknown', tierName: null, windows: [], generatedAt: { value: 1793491000, unit: 'unknown', atMs: null }, serverTime: null, nextReset: null, unit: 'unknown', total: null, used: null, remaining: 0, percentage: { value: 80, scale: 'unknown' }, authenticated: null, freshness: 'unknown' }, live: null, lastProbe: { state: 'failed', attemptedAtMs: Date.now(), errorCode: 'NATIVE_UNAVAILABLE' }, displayFreshnessWindowMs: 120000 };
  const state = createState(); applySnapshot(state, s); state.page = 'resources'; state.expandedAccounts.add(alias);
  const dom = renderApp({ state, action: () => {} });
  assert.equal(dom.querySelector('.quota-value')?.firstChild?.textContent, '0');
  assert.match(dom.textContent!, /单位 unknown，不推测日期/); assert.match(dom.textContent!, /失败 NATIVE_UNAVAILABLE；保留上次成功值/);
  assert.equal(dom.querySelector('progress'), null, 'unknown percentage scale is not a progress bar');
});

test('pending disappearance preserves an unattributed receipt and clears complete approval text', () => {
  const state = createState(); const s = snapshot(); applySnapshot(state, s); const descriptor = review();
  descriptor.response = { actionId: 'sent-once', decision: 'accept', state: 'awaiting_native' };
  state.reviews.set(descriptor.approvalId, { review: descriptor, text: 'PRIVATE COMPLETE CONTENT', loadedComplete: true, loading: false, error: null, locked: true });
  s.approvals = { items: [], total: 0, nextCursor: null, approvalSetRevision: 'set-new', stateKnown: true, unattributedCount: 0 }; applySnapshot(state, structuredClone(s));
  const entry = state.reviews.get(descriptor.approvalId)!;
  assert.equal(entry.text, null); assert.equal(entry.review.response.state, 'resolved_unattributed'); assert.equal(entry.locked, true);
  assert.match(entry.error!, /无法确认采用/);
  s.approvals.stateKnown = false; applySnapshot(state, s);
  assert.match(approvalDisabled(state, entry, 'decline')!, /归属未知/);

  s.actions = [{ key: 'dispatch:req-toast', phase: 'succeeded', message: 'Task dispatch was acknowledged.', requestId: 'req-toast', taskId: 'task-complete' }];
  applySnapshot(state, s);
  const toastDom = renderApp({ state, action: (name, data) => { if (name === 'dismiss-action-receipt') state.dismissedActions.add(data?.key ?? ''); } });
  const receipt = toastDom.querySelector('.action-receipt.succeeded');
  assert.ok(receipt);
  assert.equal(receipt.getAttribute('role'), 'status');
  assert.match(receipt.querySelector('strong')!.textContent!, /已收到回执/);
  assert.match(receipt.querySelector('code')!.textContent!, /request: req-toast/);
  const dismissBtn = receipt.querySelector('[data-action="dismiss-action-receipt"]') as unknown as HTMLButtonElement;
  assert.ok(dismissBtn);
  assert.equal(dismissBtn.getAttribute('aria-label'), '关闭回执');
  dismissBtn.click();
  const dismissedDom = renderApp({ state, action: () => {} });
  assert.equal(dismissedDom.querySelector('.action-receipt'), null);
});

test('navigation restoration survives initial disconnected state and is isolated by store identity', () => {
  const s = snapshot(); const persisted = { version: 1, identity: connectionIdentity(s), page: 'tasks', tab: 'delivery', filters: { project: '/demo/project', status: 'attention', worker: '', workspace: '', query: '' }, selectedTaskId: 'task-complete' };
  const state = createState(persisted); const disconnected = structuredClone(s); disconnected.connection.storeId = null; disconnected.connection.state = 'disconnected'; disconnected.connection.generation = 0;
  applySnapshot(state, disconnected); assert.equal(persistedUi(state), null, 'initial connection screen must not overwrite established UI identity');
  applySnapshot(state, s); assert.equal(state.tab, 'delivery'); assert.equal(state.filters.project, '/demo/project');
  const different = structuredClone(s); different.connection.storeId = 'other-store'; different.connection.generation++;
  applySnapshot(state, different); assert.equal(state.filters.project, ''); assert.equal(state.tab, 'overview');
});

test('native text blur and Host pushes cannot remove a submit button in an active pointer gesture', async () => {
  const h = harness(); h.push(); await h.app.action('compose.open');
  const prompt = h.root.querySelector('[data-field="draft.prompt"]')! as unknown as HTMLTextAreaElement;
  prompt.value = 'explicit mock task'; prompt.dispatchEvent(new browser.Event('input', { bubbles: true }) as unknown as Event);
  const submit = choose(h.root as unknown as ParentNode, 'dispatch');
  submit.dispatchEvent(new browser.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event);
  prompt.dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event);
  h.push();
  assert.equal(submit.isConnected, true, 'blur and asynchronous state must not swallow the real click');
  let resolveDispatch!: () => void;
  const dispatched = new Promise<void>(resolve => { resolveDispatch = resolve; });
  h.reply(request => { if (request.type === 'dispatch') resolveDispatch(); return {}; });
  submit.click(); browser.dispatchEvent(new browser.PointerEvent('pointerup', { bubbles: true }));
  await dispatched;
  assert.equal(h.sent.filter(request => request.type === 'dispatch').length, 1);
});

test('legacy known-ID results are readable outside the recent list and unsupported Host disables first connect', () => {
  const s = snapshot(); const known = s.detail!; s.detail = null; s.tasks = []; s.connection.state = 'legacy-readonly'; s.connection.storeId = null;
  s.legacyResult = { task: known, result: { summary: 'Older immutable result', verification: [{ command: 'git diff --check', exitCode: null }] } };
  const state = createState(); applySnapshot(state, s); state.tab = 'delivery';
  assert.equal(selectedTask(state)?.taskId, known.taskId);
  assert.match(renderApp({ state, action: () => {} }).textContent!, /Older immutable result/);
  s.connection.state = 'disconnected'; s.connection.supported = false; s.connection.environmentReason = 'Use a Linux workspace host.'; applySnapshot(state, s);
  const dom = renderApp({ state, action: () => {} }); assert.equal(choose(dom, 'connect').disabled, true); assert.match(dom.textContent!, /Use a Linux workspace host/);
});

test('the initial Host-preferred repository selects the project once and filters by registered ID', async () => {
  const h = harness(); h.reply(() => ({}));
  const s = snapshot(); s.preferredRepositoryId = 'workspace-unknown'; h.push(s);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.app.state.filters.project, '/demo/other');
  const select = h.root.querySelector('[data-filter="project"]') as unknown as HTMLSelectElement; assert.equal(select.value, '/demo/other');
  const requests = h.sent.filter(request => request.type === 'tasks.list');
  assert.equal(requests.length, 1); assert.deepEqual(requests[0]!.payload, { filter: { repositoryId: 'workspace-unknown' } });
  assert.ok(!JSON.stringify(requests[0]).includes('/demo/other'), 'Webview sends the registered identity, never a filesystem path');
  s.preferredRepositoryId = 'workspace-demo'; h.push(s);
  assert.equal(h.app.state.filters.project, '/demo/other', 'later active-editor changes cannot overwrite the initial selection');
  assert.equal(h.sent.filter(request => request.type === 'tasks.list').length, 1);
});

test('user project choices and explicit whole-pool selection survive later preference snapshots', async () => {
  const h = harness(); h.reply(() => ({})); const s = snapshot(); s.preferredRepositoryId = 'workspace-unknown'; h.push(s);
  const select = h.root.querySelector('[data-filter="project"]')! as unknown as HTMLSelectElement;
  select.value = '/demo/project'; select.dispatchEvent(new browser.Event('change', { bubbles: true }) as unknown as Event);
  h.push(s); assert.equal(h.app.state.filters.project, '/demo/project');
  await h.app.action('filters.clear'); h.push(s); assert.equal(h.app.state.filters.project, '');
});

test('same-store restored filters override Host preference, while M1 uses the default locally', () => {
  const s = snapshot(); s.preferredRepositoryId = 'workspace-unknown';
  for (const project of ['', '/demo/project']) {
    const state = createState({ version: 1, identity: connectionIdentity(s), page: 'tasks', tab: 'overview', filters: { project, status: 'all', worker: '', workspace: '', query: '' }, selectedTaskId: null });
    assert.equal(applySnapshot(state, s), false); assert.equal(state.filters.project, project, 'restored whole-pool is a real user choice too');
  }
  const legacy = structuredClone(s); legacy.connection.storeId = null; legacy.connection.state = 'legacy-readonly'; legacy.connection.capabilities = {};
  const state = createState(); assert.equal(applySnapshot(state, legacy), true); assert.equal(state.filters.project, '/demo/other');
  assert.ok(filterTasks(legacy, state.filters).every(task => task.workspaceId === 'workspace-unknown'));
  const invalid = createState(); s.preferredRepositoryId = '/arbitrary/unregistered/path'; assert.equal(applySnapshot(invalid, s), false); assert.equal(invalid.filters.project, '');
});

test('finish-work stays separate from disconnect and accepts the Host generation change',async()=>{
 const initial=snapshot();const h=harness(initial);h.push();
 const finish=choose(h.root as unknown as ParentNode,'pool.shutdown');assert.equal(finish.disabled,false);
 assert.match(h.root.textContent??'',/断开面板/);
 h.reply(request=>{if(request.type==='pool.shutdown'){const next=structuredClone(initial);next.connection.state='disconnected';next.connection.generation++;h.push(next);return {stopping:true,workersStopped:true,stoppedWorkers:1};}return {};});
 finish.click();
 assert.equal(h.sent.some(r=>r.type==='pool.shutdown'),false,'first activation only arms the confirmation');
 const confirmGroup=h.root.querySelector('.confirm-group');assert.ok(confirmGroup);assert.match(confirmGroup.textContent??'',/账号与任务数据会保留/);
 const cancelConfirm=choose(h.root as unknown as ParentNode,'confirm.cancel');cancelConfirm.click();
 assert.equal(h.root.querySelector('.confirm-group'),null);assert.equal(h.sent.some(r=>r.type==='pool.shutdown'),false);
 choose(h.root as unknown as ParentNode,'pool.shutdown').click();
 h.root.dispatchEvent(new browser.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 assert.equal(h.root.querySelector('.confirm-group'),null,'Escape disarms');
 choose(h.root as unknown as ParentNode,'pool.shutdown').click();
 const accept=choose(h.root as unknown as ParentNode,'pool.shutdown');assert.equal(accept.dataset.confirm,undefined);assert.match(accept.textContent??'',/确认收工/);
 accept.click();await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(h.sent.filter(r=>r.type==='pool.shutdown').length,1);assert.equal(h.sent.some(r=>r.type==='cancel'||r.type==='daemon.start'),false);
 assert.match(h.root.textContent??'',/实例已停止，后台正在退出/);
});

test('action feedback: visible flash, persistent live regions and urgent failed receipts',async()=>{
 const initial=snapshot();const h=harness(initial);h.push();
 const live=()=>Array.from(browser.document.querySelectorAll('[data-live]')) as unknown as HTMLElement[];
 assert.equal(live().filter(node=>node.parentElement===h.root.parentElement).length>=2,true,'live regions sit outside the re-rendered root');
 h.reply(()=>({}));
 await h.app.action('diagnostics.copy');
 const flash=h.root.querySelector('.flash');assert.ok(flash);assert.match(flash.textContent??'',/已复制脱敏诊断/);
 const polite=live().find(node=>node.dataset.live==='polite'&&node.textContent?.includes('已复制脱敏诊断'));assert.ok(polite,'success is announced politely');
 choose(h.root as unknown as ParentNode,'message.dismiss').click();assert.equal(h.root.querySelector('.flash'),null);
 const failed=structuredClone(initial);failed.actions=[{key:'cancel:task-x',phase:'failed',message:'Cancel refused.'}];h.push(failed);
 assert.equal(h.root.querySelector('.action-receipt.failed')?.getAttribute('role'),'alert');
 assert.ok(live().some(node=>node.dataset.live==='assertive'&&node.textContent?.includes('Cancel refused.')));
 h.app.dispose();assert.equal(live().some(node=>node.textContent?.includes('Cancel refused.')),false,'dispose removes live regions');
});

test('task list supports arrow-key roving focus without selecting',async()=>{
 const h=harness();h.push();
 const rows=()=>Array.from(h.root.querySelectorAll('.task-list .task-row')) as unknown as HTMLButtonElement[];
 assert.ok(rows().length>=2);
 rows()[0].focus();
 rows()[0].dispatchEvent(new browser.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}) as unknown as Event);
 assert.equal(browser.document.activeElement,rows()[1] as unknown);
 rows()[1].dispatchEvent(new browser.KeyboardEvent('keydown',{key:'End',bubbles:true}) as unknown as Event);
 assert.equal(browser.document.activeElement,rows().at(-1) as unknown);
 rows().at(-1)!.dispatchEvent(new browser.KeyboardEvent('keydown',{key:'Home',bubbles:true}) as unknown as Event);
 assert.equal(browser.document.activeElement,rows()[0] as unknown);
 assert.equal(h.sent.some(r=>r.type==='task.select'),false,'moving focus does not select');
});
