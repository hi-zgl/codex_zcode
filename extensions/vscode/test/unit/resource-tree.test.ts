import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import type { UiSnapshot } from '../../src/host/types.js';

const root = resolve(__dirname, '../..');

/**
 * Builds and loads ResourceTree class in an isolated VM context with stubbed VS Code API.
 */
async function loadResourceTree(): Promise<new (snapshot: () => UiSnapshot) => any> {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/host/resourceTree.ts'],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode']
  });

  const vscode = {
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    MarkdownString: class {
      constructor(readonly value: string) {}
    },
    TreeItem: class {
      id?: string;
      description?: string;
      contextValue?: string;
      iconPath?: unknown;
      tooltip?: unknown;
      command?: { command: string; title: string };
      constructor(public label: string, public collapsibleState = 0) {}
    },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    }
  };

  const module = { exports: {} as any };
  runInNewContext(result.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: (name: string) => {
      if (name === 'vscode') return vscode;
      throw new Error(`Unexpected require: ${name}`);
    }
  });

  return module.exports.ResourceTree;
}

function mockSnapshot(accounts: any[] = [], workers: any[] = [], workspaces: any[] = []): UiSnapshot {
  return {
    connection: {
      state: 'connected', mode: 'mock', generation: 1, host: 'test-host',
      poolHome: '/mock/pool', trusted: true, lastReceivedAtMs: Date.now(), stale: false,
      storeId: 'store-1', instanceId: 'inst-1', daemonVersion: '0.1.0',
      capabilities: {}, error: null
    },
    tasks: [], scope: 'recent_50_loaded', total: null, listNextCursor: null,
    selectedTaskId: null, detail: null,
    resources: {
      accounts,
      workers,
      workspaces,
      quotas: {}
    },
    approvals: null, delivery: { manifest: null, files: [], nextCursor: null, reviewed: false },
    draft: { workspaceId: 'w1', workerId: 'wrk1', prompt: '', session: 'continue', mode: 'build', modelId: 'GLM', busyRetryLimit: 1, verifyCommands: [], submitToken: 'token' },
    actions: [], overviewIntervalSeconds: 30, poolPolicy: null, notice: null
  };
}

test('ResourceTree root items render Workers, Accounts, and Workspaces categories', async () => {
  const ResourceTreeClass = await loadResourceTree();
  const tree = new ResourceTreeClass(() => mockSnapshot());

  const roots = tree.getChildren();
  assert.equal(roots.length, 3);
  assert.equal(roots[0].id, 'Workers');
  assert.equal(roots[0].label, '执行器');
  assert.equal(roots[1].id, 'Accounts');
  assert.equal(roots[1].label, '账号');
  assert.equal(roots[2].id, 'Workspaces');
  assert.equal(roots[2].label, '任务目录');
});

test('ResourceTree account items prioritize email as label and retain alias in description', async () => {
  const ResourceTreeClass = await loadResourceTree();
  const accounts = [
    { alias: 'acc-hash-1', email: 'developer@example.com', provider: 'zai', health: 'available', plan: 'Max' },
    { alias: 'acc-hash-2', provider: 'zai', health: 'cooling' }
  ];
  const tree = new ResourceTreeClass(() => mockSnapshot(accounts));

  const items = tree.getChildren({ id: 'Accounts' });
  assert.equal(items.length, 2);

  // First account has email: email is label, description contains alias and plan
  assert.equal(items[0].label, 'developer@example.com');
  assert.ok(items[0].description.includes('acc-hash-1'));
  assert.ok(items[0].description.includes('zai'));
  assert.ok(items[0].description.includes('Max'));
  assert.ok(items[0].description.includes('可用'));
  assert.equal(items[0].command?.command, 'zcodePool.openWorkbench');
  assert.equal(items[0].command?.title, '打开工作台');

  // Second account has no email: fallback to alias as label
  assert.equal(items[1].label, 'acc-hash-2');
  assert.ok(!items[1].description.startsWith('acc-hash-2'));
  assert.ok(items[1].description.includes('冷却中'));
  assert.equal(items[1].command?.command, 'zcodePool.openWorkbench');
  assert.equal(items[1].command?.title, '打开工作台');
});

test('ResourceTree worker and workspace items bind openWorkbench command for single-click opening', async () => {
  const ResourceTreeClass = await loadResourceTree();
  const workers = [
    { workerId: 'wrk-01', accountAlias: 'acc-1', state: 'ready', processOwned: true, runningTaskCount: 0, leaseTaskIds: [] }
  ];
  const workspaces = [
    { workspaceId: 'ws-main', repositoryPath: '/repo', worktreePath: '/wt', branch: 'feat/quota', baseCommit: 'abc', state: 'ready', activeTaskId: null }
  ];
  const tree = new ResourceTreeClass(() => mockSnapshot([], workers, workspaces));

  // Worker item verification
  const workerItems = tree.getChildren({ id: 'Workers' });
  assert.equal(workerItems.length, 1);
  assert.equal(workerItems[0].workerId, 'wrk-01');
  assert.equal(workerItems[0].contextValue, 'worker.ready');
  assert.equal(workerItems[0].command?.command, 'zcodePool.openWorkbench');
  assert.equal(workerItems[0].command?.title, '打开工作台');

  // Workspace item verification
  const wsItems = tree.getChildren({ id: 'Workspaces' });
  assert.equal(wsItems.length, 1);
  assert.equal(wsItems[0].id, 'workspace:ws-main');
  assert.equal(wsItems[0].command?.command, 'zcodePool.openWorkbench');
  assert.equal(wsItems[0].command?.title, '打开工作台');

  tree.dispose();
});
