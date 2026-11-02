/// <reference lib="dom" />
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { WebviewBridge, type VsCodeApi } from '../../src/webview/bridge.js';
import { WorkbenchApp } from '../../src/webview/main.js';
import type { UiSnapshot } from '../../src/host/types.js';
import type { WebviewRequest } from '../../src/host/protocol.js';

let browser: Window;
const apps: WorkbenchApp[] = [];
const bridges: WebviewBridge[] = [];

beforeEach(() => {
  browser = new Window({ url: 'https://webview.example/' });
  Object.assign(globalThis, {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    HTMLInputElement: browser.HTMLInputElement,
    HTMLTextAreaElement: browser.HTMLTextAreaElement,
    HTMLSelectElement: browser.HTMLSelectElement,
  });
});

afterEach(async () => {
  for (const app of apps.splice(0)) app.dispose();
  for (const bridge of bridges.splice(0)) bridge.dispose();
  await browser.happyDOM.close();
});

function createSnapshot(): UiSnapshot {
  return {
    connection: {
      state: 'connected', mode: 'mock', generation: 1, host: 'SSH: isolated-host',
      poolHome: '/mock/pool', trusted: true, lastReceivedAtMs: Date.now(), stale: false,
      storeId: 'mock-store', instanceId: 'mock-instance', daemonVersion: '0.1.0',
      capabilities: { quotaProbe: { version: 1 } }, error: null
    },
    tasks: [], scope: 'recent_50_loaded', total: null, listNextCursor: null,
    selectedTaskId: null, detail: null,
    resources: {
      accounts: [
        {
          alias: 'acc-hash-88',
          email: 'architect@zcode.ai',
          name: 'Lead Architect',
          provider: 'zai',
          health: 'available',
          plan: 'Max'
        },
        {
          alias: 'acc-raw-99',
          provider: 'zai',
          health: 'available'
        }
      ],
      workers: [
        {
          workerId: 'wrk-01',
          accountAlias: 'acc-hash-88',
          state: 'ready',
          processOwned: true,
          runningTaskCount: 0,
          leaseTaskIds: []
        }
      ],
      workspaces: [],
      quotas: {
        'acc-hash-88': {
          accountAlias: 'acc-hash-88', imported: null,
          live: {
            source: 'live_probe', accountAlias: 'acc-hash-88', providerId: 'zai',
            observedAtMs: Date.now(), storedAtMs: Date.now(), tier: 'max', tierName: 'Max',
            windows: [], generatedAt: null, serverTime: null, nextReset: null, unit: 'tokens',
            total: 100, used: 20, remaining: 80, percentage: { value: 20, scale: '0_to_100' },
            authenticated: true, freshness: 'fresh'
          },
          lastProbe: { state: 'succeeded', attemptedAtMs: Date.now(), errorCode: null },
          displayFreshnessWindowMs: 120_000
        }
      }
    },
    approvals: null, delivery: { manifest: null, files: [], nextCursor: null, reviewed: false },
    draft: { workspaceId: 'ws-1', workerId: 'wrk-01', prompt: '', session: 'continue', mode: 'build', modelId: 'GLM', busyRetryLimit: 1, verifyCommands: [], submitToken: 'tok' },
    actions: [], overviewIntervalSeconds: 30, poolPolicy: null, notice: null
  };
}

function harness(initial = createSnapshot()) {
  let current = structuredClone(initial);
  const sent: WebviewRequest[] = [];
  let handler: ((request: WebviewRequest) => unknown | Promise<unknown>) | undefined;
  const api: VsCodeApi = {
    getState: () => null,
    setState: () => {},
    postMessage: request => {
      sent.push(structuredClone(request));
      if (handler) {
        queueMicrotask(() => {
          void Promise.resolve()
            .then(() => handler!(request))
            .then(data => bridge.receive({ v: 1, id: request.id, generation: current.connection.generation, ok: true, data }))
            .catch(error => bridge.receive({ v: 1, id: request.id, generation: current.connection.generation, ok: false, error: { code: 'TEST_ERROR', message: String(error) } }));
        });
      }
    }
  };
  const bridge = new WebviewBridge(api, browser as unknown as Window & globalThis.Window);
  bridges.push(bridge);
  const root = browser.document.createElement('div');
  root.id = 'app';
  browser.document.body.append(root);
  const app = new WorkbenchApp(root as unknown as HTMLElement, bridge);
  apps.push(app);
  return {
    app, root, bridge, sent,
    push: (value = current) => {
      current = structuredClone(value);
      bridge.receive({ v: 1, type: 'state', generation: current.connection.generation, data: current });
    },
    reply: (fn: (request: WebviewRequest) => unknown | Promise<unknown>) => { handler = fn; }
  };
}

test('account cards prioritize email in header title and display alias in soft badge', async () => {
  const h = harness();
  h.push();
  await h.app.action('page', { page: 'resources' });

  const accountCards = h.root.querySelectorAll('.account-card');
  assert.equal(accountCards.length, 2);

  // First card has email: title must display email, and alias must be preserved in soft badge
  const card1Title = accountCards[0]!.querySelector('h4');
  assert.equal(card1Title?.textContent, 'architect@zcode.ai');

  const card1AliasBadge = accountCards[0]!.querySelector('.badge.idle');
  assert.equal(card1AliasBadge?.textContent, 'acc-hash-88');

  // Second card has no email: fallback to alias in h4, no redundant soft badge
  const card2Title = accountCards[1]!.querySelector('h4');
  assert.equal(card2Title?.textContent, 'acc-raw-99');
  const card2AliasBadge = accountCards[1]!.querySelector('.badge.idle');
  assert.equal(card2AliasBadge, null);
});

test('worker panel displays email in bound account label and dropdown select options', async () => {
  const h = harness();
  h.push();
  await h.app.action('page', { page: 'resources' });

  // Worker card "绑定账号" metadata row
  const workerCard = h.root.querySelector('.worker-card');
  assert.ok(workerCard, 'worker-card should exist');
  assert.match(workerCard.textContent!, /architect@zcode\.ai \(acc-hash-88\)/);

  // New worker creation account select options
  const select = h.root.querySelector('select[data-field="workerAccount"]') as unknown as HTMLSelectElement;
  assert.ok(select, 'account select element must exist');

  const options = Array.from(select.querySelectorAll('option'));
  const optionTexts = options.map(o => o.textContent);
  assert.ok(optionTexts.some(t => t?.includes('architect@zcode.ai (acc-hash-88)')));
});

test('header probe-all button triggers accounts.probeAll action', async () => {
  const h = harness();
  h.push();
  await h.app.action('page', { page: 'resources' });

  // Probe all button in heading
  const probeAllBtn = h.root.querySelector('[data-action="accounts.probeAll"]') as unknown as HTMLButtonElement;
  assert.ok(probeAllBtn, 'accounts.probeAll button must be present in resources heading');
  assert.equal(probeAllBtn.textContent?.trim(), '全量探查额度');

  h.reply(request => {
    if (request.type === 'accounts.probeAll') {
      return { probed: true };
    }
    return {};
  });

  probeAllBtn.click();
  await new Promise(resolve => setTimeout(resolve, 20));

  const probeRequests = h.sent.filter(r => r.type === 'accounts.probeAll');
  assert.equal(probeRequests.length, 1);
});

test('account hint text provides direct probe guide and auto-refresh notice', async () => {
  const h = harness();
  h.push();
  await h.app.action('page', { page: 'resources' });

  const hints = Array.from(h.root.querySelectorAll('.field-hint'));
  const accountHint = hints.find(hint => hint.textContent?.includes('直接探测'));

  assert.ok(accountHint, 'updated direct probe hint must exist');
  assert.ok(!accountHint.textContent?.includes('通过下方执行器发起'), 'old obsolete executor wording must be removed');
  assert.match(accountHint.textContent!, /60 秒自动/);
});

