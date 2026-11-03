/// <reference lib="dom" />
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { WebviewBridge, type VsCodeApi } from '../../src/webview/bridge.js';
import { WorkbenchApp } from '../../src/webview/main.js';
import type { UiSnapshot } from '../../src/host/types.js';
import type { UiQuota } from '../../../../src/shared/ui-contract.js';

let browser: Window;
const apps: WorkbenchApp[] = [];
const bridges: WebviewBridge[] = [];
const rootPath = resolve(__dirname, '../..');

beforeEach(() => {
  browser = new Window({ url: 'https://webview.example/' });
  Object.assign(globalThis, {
    window: browser, document: browser.document,
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

function createMockQuota(alias: string, remaining: number): UiQuota {
  return {
    accountAlias: alias, imported: null,
    live: {
      source: 'live_probe', accountAlias: alias, providerId: 'zai',
      observedAtMs: Date.now(), storedAtMs: Date.now(), tier: 'pro', tierName: 'Pro',
      windows: [{ id: 'w1', name: 'Tokens', windowType: 'token_pool', total: 1000, used: 1000 - remaining, remaining, percentageUsed: ((1000 - remaining) / 1000) * 100, unit: 'tokens', resetsAtMs: null, resetsLabel: null }],
      generatedAt: null, serverTime: null, nextReset: null, unit: 'tokens',
      total: 1000, used: 1000 - remaining, remaining, percentage: { value: 50, scale: '0_to_100' },
      authenticated: true, freshness: 'fresh'
    },
    lastProbe: { state: 'succeeded', attemptedAtMs: Date.now(), errorCode: null },
    displayFreshnessWindowMs: 120_000
  };
}

function createSortingSnapshot(): UiSnapshot {
  return {
    projects:[],
    connection: {
      state: 'connected', mode: 'mock', generation: 1, host: 'test-host',
      poolHome: '/mock/pool', trusted: true, lastReceivedAtMs: Date.now(), stale: false,
      storeId: 'store-1', instanceId: 'inst-1', daemonVersion: '0.1.0',
      capabilities: { quotaProbe: { version: 1 } }, error: null
    },
    tasks: [], scope: 'recent_50_loaded', total: null, listNextCursor: null,
    selectedTaskId: null, detail: null,
    resources: {
      accounts: [
        { alias: 'acc-zero', email: 'zero@example.com', provider: 'zai', health: 'available' },
        { alias: 'acc-probed', email: 'probed@example.com', provider: 'zai', health: 'available' },
        { alias: 'acc-unprobed', email: 'unprobed@example.com', provider: 'zai', health: 'available' },
        { alias: 'acc-blocked', email: 'blocked@example.com', provider: 'zai', health: 'blocked' }
      ],
      workers: [], workspaces: [],
      quotas: {
        'acc-zero': createMockQuota('acc-zero', 0),
        'acc-probed': createMockQuota('acc-probed', 500)
      }
    },
    approvals: null, delivery: { manifest: null, files: [], nextCursor: null, reviewed: false },
    draft: { workspaceId: 'w1', workerId: '', prompt: '', session: 'continue', mode: 'build', modelId: 'GLM', verifyCommands: [], submitToken: 't' },
    actions: [], overviewIntervalSeconds: 30, poolPolicy: null, notice: null
  };
}

function harness(initial = createSortingSnapshot()) {
  let current = structuredClone(initial);
  const api: VsCodeApi = {
    getState: () => null, setState: () => {},
    postMessage: req => {
      queueMicrotask(() => {
        bridge.receive({ v: 1, id: req.id, generation: current.connection.generation, ok: true, data: {} });
      });
    }
  };
  const bridge = new WebviewBridge(api, browser as unknown as Window & globalThis.Window);
  bridges.push(bridge);
  const root = browser.document.createElement('div');
  root.id = 'app';
  browser.document.body.append(root);
  const app = new WorkbenchApp(root as unknown as HTMLElement, bridge);
  apps.push(app);
  bridge.receive({ v: 1, type: 'state', generation: current.connection.generation, data: current });
  return { app, root, bridge };
}

async function loadResourceTree(): Promise<new (snapshot: () => UiSnapshot) => any> {
  const result = await build({
    absWorkingDir: rootPath, entryPoints: ['src/host/resourceTree.ts'], bundle: true,
    write: false, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode']
  });
  const vscode = {
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(readonly id: string) {} },
    MarkdownString: class { constructor(readonly value: string) {} },
    TreeItem: class {
      id?: string; description?: string; contextValue?: string;
      constructor(public label: string, public collapsibleState = 0) {}
    },
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {}; dispose() {} }
  };
  const mod = { exports: {} as any };
  runInNewContext(result.outputFiles[0]!.text, {
    module: mod, exports: mod.exports,
    require: (name: string) => name === 'vscode' ? vscode : (() => { throw new Error(name); })()
  });
  return mod.exports.ResourceTree;
}

test('workbench renders accounts in quota-first order by default', async () => {
  const h = harness();
  await h.app.action('page', { page: 'resources' });

  const cards = h.root.querySelectorAll('.account-card');
  assert.equal(cards.length, 4);

  // Default quota_first: probed (500) > unprobed > zero (0) > blocked
  const titles = Array.from(cards).map(c => c.querySelector('h4')?.textContent);
  assert.deepEqual(titles, ['probed@example.com', 'unprobed@example.com', 'zero@example.com', 'blocked@example.com']);

  const sortBtn = h.root.querySelector('.btn-sort-toggle');
  assert.ok(sortBtn?.textContent?.includes('额度优先'));
  assert.ok(sortBtn?.classList.contains('active'));
});

test('toggling account.sort button switches between quota_first and default mode', async () => {
  const h = harness();
  await h.app.action('page', { page: 'resources' });

  // Toggle to default mode
  await h.app.action('account.sort', { mode: 'default' });
  let cards = h.root.querySelectorAll('.account-card');
  let titles = Array.from(cards).map(c => c.querySelector('h4')?.textContent);
  assert.deepEqual(titles, ['zero@example.com', 'probed@example.com', 'unprobed@example.com', 'blocked@example.com']);

  let sortBtn = h.root.querySelector('.btn-sort-toggle');
  assert.ok(sortBtn?.textContent?.includes('导入顺序'));
  assert.equal(sortBtn?.classList.contains('active'), false);

  // Toggle back to quota_first mode
  await h.app.action('account.sort', { mode: 'quota_first' });
  cards = h.root.querySelectorAll('.account-card');
  titles = Array.from(cards).map(c => c.querySelector('h4')?.textContent);
  assert.deepEqual(titles, ['probed@example.com', 'unprobed@example.com', 'zero@example.com', 'blocked@example.com']);
});

test('worker panel dropdown prioritizes accounts with available quota', async () => {
  const h = harness();
  await h.app.action('page', { page: 'resources' });

  const selectEl = h.root.querySelector('select[data-field="workerAccount"]') as unknown as HTMLSelectElement;
  assert.ok(selectEl);
  const options = Array.from(selectEl.querySelectorAll('option'));
  const firstValue = options[1]?.value;
  assert.equal(firstValue, 'acc-probed', 'First selectable account must be acc-probed');
});

test('ResourceTree account category sorts accounts by quota first', async () => {
  const TreeClass = await loadResourceTree();
  const tree = new TreeClass(() => createSortingSnapshot());
  const items = tree.getChildren({ id: 'Accounts' });
  assert.equal(items.length, 4);

  const labels = items.map((it: any) => it.label);
  assert.deepEqual(labels, ['probed@example.com', 'unprobed@example.com', 'zero@example.com', 'blocked@example.com']);
  tree.dispose();
});
