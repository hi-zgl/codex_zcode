/// <reference lib="dom" />
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { WebviewBridge, type VsCodeApi } from '../../src/webview/bridge.js';
import { WorkbenchApp } from '../../src/webview/main.js';
import { applySnapshot, createState } from '../../src/webview/state.js';
import { renderApp } from '../../src/webview/components.js';
import {
  computeBarTheme,
  shouldInFill,
  renderQuotaBar,
  formatResetTime,
  renderTierBadge,
  formatQuotaNumber,
  renderQuotaWindow,
  renderQuota
} from '../../src/webview/components/views/resources/index.js';
import type { UiSnapshot } from '../../src/host/types.js';
import type { WebviewRequest } from '../../src/host/protocol.js';
import type { UiQuota } from '../../../../src/shared/ui-contract.js';

const fixture = JSON.parse(readFileSync(join(process.cwd(), process.cwd().endsWith('/extensions/vscode') ? 'test/fixtures/pool-demo.json' : 'extensions/vscode/test/fixtures/pool-demo.json'), 'utf8'));
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

function snapshot(): UiSnapshot {
  return {
    projects:[],
    connection: {
      state: 'connected', mode: 'mock', generation: 1, host: 'SSH: isolated-host',
      poolHome: '/mock/pool', trusted: true, lastReceivedAtMs: Date.now(), stale: false,
      storeId: 'mock-store', instanceId: 'mock-instance', daemonVersion: '0.1.0',
      capabilities: structuredClone(fixture.capabilities.capabilities), error: null
    },
    tasks: [], scope: 'recent_50_loaded', total: null, listNextCursor: null,
    selectedTaskId: null, detail: null,
    resources: {
      accounts: structuredClone(fixture.overview.accounts),
      workers: fixture.overview.workers.map((w: object) => ({ ...w, leaseTaskIds: [] })),
      workspaces: structuredClone(fixture.overview.workspaces),
      quotas: {}
    },
    approvals: null, delivery: { manifest: null, files: [], nextCursor: null, reviewed: false },
    draft: { workspaceId: 'workspace-demo', workerId: 'worker-demo', prompt: '', session: 'continue', mode: 'build', modelId: 'GLM-5.3-Flash', verifyCommands: [], submitToken: 'draft-token' },
    actions: [], overviewIntervalSeconds: 30, poolPolicy: null, notice: null,
  };
}

function harness(initial = snapshot()) {
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

test('quota-bar 3-color safety tiers and in-fill contrast text inversion', () => {
  assert.equal(computeBarTheme(20), 'normal');
  assert.equal(computeBarTheme(69.9), 'normal');
  assert.equal(computeBarTheme(70), 'warn');
  assert.equal(computeBarTheme(89.9), 'warn');
  assert.equal(computeBarTheme(90), 'danger');
  assert.equal(computeBarTheme(100), 'danger');

  assert.equal(shouldInFill(60), true);
  assert.equal(shouldInFill(58), true);
  assert.equal(shouldInFill(57.9), false);
  assert.equal(shouldInFill(20), false);

  const normalBar = renderQuotaBar({ percentageUsed: 25, remainingPercentage: 75 });
  assert.equal(normalBar.className.includes('warn'), false);
  assert.equal(normalBar.className.includes('danger'), false);
  assert.ok(normalBar.querySelector('.qbar-pct')?.classList.contains('in-fill'));

  const warnBar = renderQuotaBar({ percentageUsed: 75, remainingPercentage: 25 });
  assert.ok(warnBar.className.includes('warn'));
  assert.equal(warnBar.querySelector('.qbar-pct')?.classList.contains('in-fill'), false);

  const dangerBar = renderQuotaBar({ percentageUsed: 95, remainingPercentage: 5 });
  assert.ok(dangerBar.className.includes('danger'));
  assert.equal(dangerBar.querySelector('.qbar-pct')?.classList.contains('in-fill'), false);
});

test('tier badges render expected class names for all subscription tiers', () => {
  const tiers = ['max', 'pro', 'lite', 'start', 'trial', 'free'] as const;
  for (const tier of tiers) {
    const el = renderTierBadge(tier);
    assert.ok(el.classList.contains('tier-b'));
    assert.ok(el.classList.contains(tier));
    assert.equal(el.textContent, tier.toUpperCase());
  }
  const unknownEl = renderTierBadge('unknown');
  assert.ok(unknownEl.classList.contains('other'));
  assert.equal(unknownEl.textContent, '等级未知');
});

test('formatResetTime formats human-friendly countdown with tabular figures', () => {
  const now = 1700000000000;
  assert.equal(formatResetTime(now - 1000, now), '重置时间已到，待刷新');
  assert.equal(formatResetTime(now + 120_000, now), '2分钟后重置');
  assert.equal(formatResetTime(now + 3_600_000 * 2 + 15 * 60_000, now), '2小时15分后重置');
  assert.equal(formatResetTime(now + 86_400_000 * 3, now), '3天后重置');
  assert.equal(formatResetTime(null, now), '—');
  assert.equal(formatResetTime(now + 120_000, now, 'expires'), '2分钟后到期');
  assert.equal(formatResetTime(now - 1000, now, 'expires'), '已到期');
  // Rounding boundaries: never "0小时59分" or "0天".
  assert.equal(formatResetTime(now + 59.5 * 60_000, now), '1小时后重置');
  assert.equal(formatResetTime(now + (24 * 60 - 0.5) * 60_000, now), '1天后重置');
});

test('direct account probe triggers account.probe action and suppresses rapid double-clicks', async () => {
  const h = harness();
  const s = snapshot();
  h.push(s);
  await h.app.action('page', { page: 'resources' });

  const accountCard = h.root.querySelector('.account-card');
  assert.ok(accountCard, 'account-card must be rendered');

  const probeBtn = accountCard.querySelector('[data-action="account.probe"]') as unknown as HTMLButtonElement;
  assert.ok(probeBtn, 'account.probe button must exist on account card toolbar');
  assert.equal(probeBtn.dataset.accountAlias, 'account-demo');

  h.reply(request => {
    if (request.type === 'account.probe') {
      const alias = (request.payload as { accountAlias: string }).accountAlias;
      const now = Date.now();
      const quota: UiQuota = {
        accountAlias: alias,
        imported: null,
        live: {
          source: 'live_probe', accountAlias: alias, providerId: 'zai',
          observedAtMs: now, storedAtMs: now, tier: 'pro', tierName: 'Pro Tier',
          windows: [{
            id: '5h', name: '5小时周期', windowType: 'hourly_window',
            total: 100, used: 25, remaining: 75, percentageUsed: 25,
            unit: '次', resetsAtMs: now + 3600_000 * 3, resetsLabel: '3小时后重置'
          }],
          generatedAt: null, serverTime: null, nextReset: null, unit: 'requests',
          total: 100, used: 25, remaining: 75, percentage: { value: 25, scale: '0_to_100' },
          authenticated: true, freshness: 'fresh'
        },
        lastProbe: { state: 'succeeded', attemptedAtMs: now, errorCode: null },
        displayFreshnessWindowMs: 120_000
      };
      s.resources.quotas[alias] = quota;
      h.push(s);
      return quota;
    }
    return {};
  });

  // First probe click
  probeBtn.click();
  await new Promise(resolve => setTimeout(resolve, 20));

  const probeRequests = h.sent.filter(r => r.type === 'account.probe');
  assert.equal(probeRequests.length, 1);
  assert.deepEqual(probeRequests[0]!.payload, { accountAlias: 'account-demo' });

  // Rapid second click within 1 second should be debounced and suppressed
  probeBtn.click();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.sent.filter(r => r.type === 'account.probe').length, 1);
});

test('quota-panel renders multi-window grid and stale cache degradation alert on failure', () => {
  const s = snapshot();
  const alias = 'account-demo';
  const now = Date.now();
  s.resources.quotas[alias] = {
    accountAlias: alias,
    imported: {
      source: 'imported_snapshot', accountAlias: alias, providerId: 'zai',
      observedAtMs: now - 600_000, storedAtMs: now - 600_000, tier: 'max', tierName: 'Max Super Plan',
      windows: [
        {
          id: 'w-5h', name: '5小时限制', windowType: 'hourly_window',
          total: 100, used: 85, remaining: 15, percentageUsed: 85,
          unit: '次', resetsAtMs: now + 7200_000, resetsLabel: '2小时后重置'
        },
        {
          id: 'w-token', name: 'Token 余量', windowType: 'token_pool',
          total: 1_000_000, used: 950_000, remaining: 50_000, percentageUsed: 95,
          unit: 'tokens', resetsAtMs: now + 86400_000, resetsLabel: '1天后重置'
        }
      ],
      generatedAt: null, serverTime: null, nextReset: null, unit: 'requests',
      total: 100, used: 85, remaining: 15, percentage: { value: 85, scale: '0_to_100' },
      authenticated: true, freshness: 'stale'
    },
    live: null,
    lastProbe: { state: 'failed', attemptedAtMs: now - 30_000, errorCode: 'NETWORK_TIMEOUT' },
    displayFreshnessWindowMs: 120_000
  };

  const state = createState();
  applySnapshot(state, s);
  state.page = 'resources';
  state.expandedAccounts.add(alias);

  const dom = renderApp({ state, action: () => {} });

  // Quota panel expanded container
  const panel = dom.querySelector('.quota-panel');
  assert.ok(panel, 'quota-panel should be present when expanded');

  // Multi-window 3-column rows
  const winRows = panel.querySelectorAll('.q-win');
  assert.ok(winRows.length >= 2, 'should render 2 quota window rows');
  assert.match(winRows[0]!.textContent!, /5小时限制/);
  assert.match(winRows[1]!.textContent!, /Token 余量/);

  // Stale cache warning alert with retry action
  const warning = panel.querySelector('.quota-cache-warning');
  assert.ok(warning, 'stale cache warning should be rendered');
  assert.match(warning.textContent!, /当前展示历史快照/);
  const retryBtn = warning.querySelector('.quota-cache-warning-btn');
  assert.ok(retryBtn, 'retry button should be present inside cache warning');
});

test('formatQuotaNumber handles null, undefined, standard numbers and compact large tokens', () => {
  assert.equal(formatQuotaNumber(null), '未知');
  assert.equal(formatQuotaNumber(undefined), '未知');
  assert.equal(formatQuotaNumber(NaN), '未知');
  assert.equal(formatQuotaNumber(Infinity), '未知');

  // Standard numbers with thousand separators
  assert.equal(formatQuotaNumber(0), '0');
  assert.equal(formatQuotaNumber(100), '100');
  assert.equal(formatQuotaNumber(1234), '1,234');
  assert.equal(formatQuotaNumber(500_000_000), '500,000,000');
  assert.equal(formatQuotaNumber(400_000_000), '400,000,000');

  // Compact formatting for high-density slots / large token pools
  assert.equal(formatQuotaNumber(500_000_000, true), '500M');
  assert.equal(formatQuotaNumber(400_000_000, true), '400M');
  assert.equal(formatQuotaNumber(1_500_000, true), '1.5M');
  assert.equal(formatQuotaNumber(50_000, true), '50K');
  assert.equal(formatQuotaNumber(100, true), '100');
  assert.equal(formatQuotaNumber(0, true), '0');
});

test('renderQuotaWindow and renderQuota format large numbers and token pools correctly', () => {
  // Test renderQuotaWindow with 500,000,000 token pool
  const win = {
    id: 'win-glm',
    name: 'GLM-5.3-Flash',
    windowType: 'token_pool' as const,
    total: 500_000_000,
    used: 100_000_000,
    remaining: 400_000_000,
    percentageUsed: 20,
    unit: 'tokens',
    resetsAtMs: Date.now() + 86400_000,
    resetsLabel: '1天后重置'
  };

  const row = renderQuotaWindow(win, Date.now());
  assert.equal(row.querySelector('.q-win-label')?.textContent, 'GLM-5.3-Flash');
  const barPct = row.querySelector('.qbar-pct');
  assert.ok(barPct, 'qbar-pct must exist');
  assert.equal(barPct.textContent, '400M / 500M');
  const bar = row.querySelector('.qbar') as HTMLElement;
  assert.ok(bar.title.includes('余量 400,000,000 / 总量 500,000,000 tokens'));

  // Test renderQuota source display
  const snapshotItem = {
    source: 'live_probe' as const,
    accountAlias: 'account-demo',
    providerId: 'zai',
    observedAtMs: Date.now(),
    storedAtMs: Date.now(),
    tier: 'pro' as const,
    tierName: 'Pro Tier',
    windows: [win],
    generatedAt: null,
    serverTime: null,
    nextReset: null,
    unit: 'tokens' as const,
    total: 500_000_000,
    used: 100_000_000,
    remaining: 400_000_000,
    percentage: { value: 20, scale: '0_to_100' as const },
    authenticated: true,
    freshness: 'fresh' as const
  };

  const quotaNode = renderQuota('在线查询快照', snapshotItem, 120_000);
  assert.ok(quotaNode.textContent?.includes('400,000,000'));
  assert.ok(quotaNode.textContent?.includes('500,000,000 / 100,000,000'));
});
