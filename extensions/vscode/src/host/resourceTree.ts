import * as vscode from 'vscode';
import type { UiSnapshot, UiAccount, UiWorker, UiWorkspace } from './types.js';
import { sortAccountsByQuota } from '../../../../src/shared/account-sort.js';

/**
 * Maps resource health or runtime state codes to user-friendly localized labels.
 */
function localizedResourceState(state: string): string {
  const map: Record<string, string> = {
    ready: '已就绪',
    starting: '启动中',
    stopped: '已停止',
    active: '可用',
    archived: '已归档',
    available: '可用',
    unknown: '未确认',
    blocked: '受阻',
    invalid: '无效',
    cooling: '冷却中',
    error: '异常'
  };
  return map[state] ?? state;
}

/**
 * Formats a user-facing description for an account node.
 * When email is present (used as label), description retains the technical alias and health.
 */
function formatAccountDescription(account: UiAccount): string {
  const stateLabel = localizedResourceState(account.health);
  const parts: string[] = [];

  if (account.email) {
    parts.push(account.alias);
  }
  parts.push(account.provider);
  if (account.plan) {
    parts.push(account.plan);
  }
  parts.push(stateLabel);

  return parts.join(' · ');
}

/**
 * Creates a TreeItem for an account node in the sidebar tree.
 * Prioritizes email over alias for clear user identification.
 */
function createAccountItem(account: UiAccount): vscode.TreeItem {
  const label = account.email || account.alias;
  const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

  item.id = `account:${account.alias}`;
  item.description = formatAccountDescription(account);
  item.contextValue = 'account';
  item.iconPath = new vscode.ThemeIcon('account');

  const tooltipParts = [
    `账号: ${account.alias}`,
    account.email ? `邮箱: ${account.email}` : null,
    account.name ? `姓名: ${account.name}` : null,
    `服务商: ${account.provider}`,
    account.plan ? `计划: ${account.plan}` : null,
    `状态: ${localizedResourceState(account.health)}`
  ].filter(Boolean);

  item.tooltip = new vscode.MarkdownString(
    tooltipParts.map(line => `- ${line}`).join('\n') + '\n\n*单击打开工作台与监控仪表盘*'
  );

  item.command = {
    command: 'zcodePool.openWorkbench',
    title: '打开工作台'
  };

  return item;
}

/**
 * Creates a TreeItem for an isolated worker execution node.
 */
function createWorkerItem(worker: UiWorker): vscode.TreeItem & { workerId: string } {
  const item = new vscode.TreeItem(
    worker.workerId,
    vscode.TreeItemCollapsibleState.None
  ) as vscode.TreeItem & { workerId: string };

  item.id = `worker:${worker.workerId}`;
  item.workerId = worker.workerId;
  item.contextValue = worker.state === 'ready' ? 'worker.ready' : 'worker.other';

  const stateLabel = localizedResourceState(worker.state);
  const running = worker.runningTaskCount ?? '待核对';
  const occupied = worker.leaseTaskIds.length;
  item.description = `${stateLabel} · 运行 ${running} · 占用 ${occupied}`;

  const tooltipLines = [
    `执行器: ${worker.workerId}`,
    `绑定账号: ${worker.accountAlias}`,
    `状态: ${stateLabel}`,
    `运行操作: ${running}`,
    `占用任务: ${occupied > 0 ? worker.leaseTaskIds.join(', ') : '无占用'}`,
    worker.processOwned ? '管理归属: 属于当前连接目录' : '管理归属: 尚未确认'
  ];

  item.tooltip = new vscode.MarkdownString(
    tooltipLines.map(line => `- ${line}`).join('\n') + '\n\n*单击打开工作台与监控仪表盘*'
  );

  item.iconPath = new vscode.ThemeIcon('server-process');
  item.command = {
    command: 'zcodePool.openWorkbench',
    title: '打开工作台'
  };

  return item;
}

/**
 * Creates a TreeItem for a workspace repository worktree node.
 */
function createWorkspaceItem(workspace: UiWorkspace): vscode.TreeItem {
  const item = new vscode.TreeItem(workspace.workspaceId, vscode.TreeItemCollapsibleState.None);

  item.id = `workspace:${workspace.workspaceId}`;
  item.description = `${workspace.branch}${workspace.activeTaskId ? ' · occupied' : ''}`;
  item.contextValue = 'workspace';
  item.iconPath = new vscode.ThemeIcon('repo');

  const tooltipLines = [
    `任务目录: ${workspace.workspaceId}`,
    `源码仓库: ${workspace.repositoryPath}`,
    `工作树: ${workspace.worktreePath}`,
    `分支: ${workspace.branch}`,
    `基准提交: ${workspace.baseCommit}`,
    `占用任务: ${workspace.activeTaskId ?? '无占用'}`
  ];

  item.tooltip = new vscode.MarkdownString(
    tooltipLines.map(line => `- ${line}`).join('\n') + '\n\n*单击打开工作台与监控仪表盘*'
  );

  item.command = {
    command: 'zcodePool.openWorkbench',
    title: '打开工作台'
  };

  return item;
}

/**
 * TreeDataProvider providing sidebar navigation for workers, accounts, and workspaces.
 * Bound to the primary activity bar resources view with single-click workbench opening.
 */
export class ResourceTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly snapshot: () => UiSnapshot) {}

  /**
   * Triggers a refresh of all tree items when resource state changes.
   */
  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: vscode.TreeItem): vscode.TreeItem[] {
    const { resources } = this.snapshot();

    if (!parent) {
      const categories: [string, string][] = [
        ['Workers', '执行器'],
        ['Accounts', '账号'],
        ['Workspaces', '任务目录']
      ];
      return categories.map(([id, label]) => {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = id;
        item.iconPath = new vscode.ThemeIcon(
          id === 'Workers' ? 'server-process' : id === 'Accounts' ? 'account' : 'repo'
        );
        return item;
      });
    }

    if (parent.id === 'Workers') {
      return resources.workers.map(createWorkerItem);
    }

    if (parent.id === 'Accounts') {
      const sorted = sortAccountsByQuota(resources.accounts, resources.quotas, 'quota_first');
      return sorted.map(createAccountItem);
    }

    if (parent.id === 'Workspaces') {
      return resources.workspaces.map(createWorkspaceItem);
    }

    return [];
  }

  dispose(): void {
    this.changed.dispose();
  }
}
