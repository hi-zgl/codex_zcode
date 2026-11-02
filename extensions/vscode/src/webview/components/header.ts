import type { UiSnapshot } from '../../host/types.js';
import { icon, type IconName } from '../icons.js';
import { mutationReason } from '../state.js';
import type { RenderContext } from './types.js';
import { el, date, kv, heading } from './dom.js';
import { badge, notice } from './primitives.js';
import { button, actionWithReason } from './button.js';
import { messageFor } from './feedback.js';

export function connectReason(snapshot: UiSnapshot): string | null {
  return snapshot.connection.supported === false || ['UNSUPPORTED_ENVIRONMENT', 'UNSUPPORTED_PLATFORM'].includes(snapshot.connection.error?.code ?? '')
    ? snapshot.connection.environmentReason ?? '此执行环境不受支持，请使用 Linux、Remote SSH 到 Linux 或 WSL。'
    : null;
}

export function connectionBusy(ctx: RenderContext, snapshot: UiSnapshot): boolean {
  return snapshot.connection.state === 'connecting' || ['connect', 'daemon.start', 'connection.configure', 'connection.codexSetup'].some(action => ctx.state.pending.has(action));
}

export function startDaemonReason(snapshot: UiSnapshot): string | null {
  return connectReason(snapshot) ?? (!snapshot.connection.trusted ? '请先在 VS Code 中信任此工作区。' : null);
}

export function codexSetupReason(snapshot: UiSnapshot): string | null {
  return connectReason(snapshot) ?? (snapshot.connection.mode === 'mock' ? '演示模式不生成真实 Codex MCP 配置。' : !snapshot.connection.trusted ? '请先在 VS Code 中信任此工作区。' : null);
}

export function codexSetup(ctx: RenderContext, snapshot: UiSnapshot, primary = false): HTMLElement {
  return actionWithReason(ctx, '连接 Codex / 生成 MCP 配置', 'connection.codexSetup', {}, codexSetupReason(snapshot) ?? (connectionBusy(ctx, snapshot) && !ctx.state.pending.has('connection.codexSetup') ? '请等待当前连接操作完成。' : null), primary, 'connection.codexSetup', { icon: icon('plug', { size: 12 }) });
}

export function renderHeader(ctx: RenderContext): HTMLElement {
  const skip = el('a', 'skip-link', '跳到主要内容');
  skip.href = '#main-content';
  return el('header', 'app-header',
    skip,
    el('div', 'brand', el('span', 'brand-mark', 'Z'), el('strong', '', 'ZCODE')),
    el('span', 'header-description', 'Codex 调度 · 任务监控'),
    ctx.state.snapshot?.connection.mode === 'mock' ? badge('演示模式 · 模拟数据', 'demo') : badge('本地 / 远程服务', 'quiet')
  );
}

export function renderConnection(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const connection = snapshot.connection;
  const names = { disconnected: '未连接', connecting: '连接中', connected: '已连接', 'legacy-readonly': '只读连接', error: '连接中断' };
  const indicator = el('span', `connection-indicator ${connection.state === 'connected' ? 'online' : ''}`);
  indicator.setAttribute('aria-hidden', 'true');
  const scope = el('div', 'execution-context',
    el('div', 'connection-status',
      indicator,
      el('strong', '', connection.supported === false ? '不受支持' : connection.stale && connection.state !== 'disconnected' ? '连接状态待确认' : names[connection.state]),
      !connection.trusted && badge([icon('shield', { size: 12 }), '受限模式'], 'attention')
    ),
    el('span', 'host-label', `运行环境：${connection.host}`),
    el('code', 'pool-path', connection.poolHome)
  );
  const actions = el('div', 'inline-actions');
  if (['connected', 'legacy-readonly'].includes(connection.state) || (connection.state === 'error' && snapshot.tasks.length)) {
    actions.append(
      button(ctx, '刷新', 'refresh', {}, { busy: ctx.state.pending.has('refresh'), icon: icon('refresh', { size: 12 }) }),
      button(ctx, '断开面板', 'disconnect', {}, { variant: 'ghost', icon: icon('debug-disconnect', { size: 12 }) }),
      actionWithReason(ctx, '收工：停止实例与后台', 'pool.shutdown', {}, mutationReason(snapshot, 'poolLifecycle'), false, 'pool.shutdown', { icon: icon('stop-circle', { size: 12 }), confirm: { prompt: '停止所有空闲执行器并退出后台？账号与任务数据会保留。', confirmLabel: '确认收工' } })
    );
  } else {
    actions.append(
      button(ctx, connection.state === 'error' ? '重新连接' : '连接', 'connect', {}, {
        primary: true,
        busy: connectionBusy(ctx, snapshot),
        reason: connectReason(snapshot),
        icon: icon(connection.state === 'error' ? 'refresh' : 'plug', { size: 12 })
      })
    );
  }
  const node = el('section', 'connection-banner', scope,
    el('div', 'connection-trailing',
      el('span', 'sync-time', connection.stale ? `缓存 · 最后同步 ${date(connection.lastReceivedAtMs)}` : connection.lastReceivedAtMs ? `同步于 ${date(connection.lastReceivedAtMs)}` : '尚未同步'),
      actions
    )
  );
  if (connection.stale && connection.state !== 'disconnected') {
    actions.prepend(button(ctx, '重新连接', 'connect', {}, { busy: ctx.state.pending.has('connect'), icon: icon('refresh', { size: 12 }) }));
  }
  node.setAttribute('aria-label', '连接与运行环境');
  if (connection.error) {
    node.append(notice(`${connection.error.code} · ${connection.error.message}`, 'warning'));
  } else if (connectReason(snapshot)) {
    node.append(notice(connectReason(snapshot)!, 'warning'));
  }
  if (connection.state === 'legacy-readonly') {
    node.append(notice('当前后台服务版本仅支持查看，暂不能审批、提交任务或管理资源。', 'warning'));
  }
  const shutdownMessage = messageFor(ctx, 'pool.shutdown');
  if (shutdownMessage) node.append(shutdownMessage);
  return node;
}

export function renderNavigation(ctx: RenderContext): HTMLElement {
  const node = el('nav', 'page-nav');
  node.setAttribute('aria-label', '工作台页面');
  const pages: readonly (readonly [string, string, IconName])[] = [['tasks', '任务监控', 'tasklist'], ['resources', '额度与资源', 'dashboard'], ['settings', '设置', 'settings-gear']];
  for (const [id, label, iconName] of pages) {
    const b = button(ctx, label, 'page', { page: id }, { icon: icon(iconName, { size: 14 }) });
    if (ctx.state.page === id || (id === 'tasks' && ctx.state.page === 'compose')) b.setAttribute('aria-current', 'page');
    node.append(b);
  }
  return node;
}

export function renderWelcome(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const actions = el('div', 'inline-actions',
    codexSetup(ctx, snapshot, true),
    button(ctx, '连接监控', 'connect', {}, { busy: connectionBusy(ctx, snapshot), reason: connectReason(snapshot), icon: icon('plug', { size: 12 }) }),
    button(ctx, '选择连接目录', 'connection.configure', {}, { busy: ctx.state.pending.has('connection.configure'), reason: connectionBusy(ctx, snapshot) ? '请等待当前连接操作完成。' : null, icon: icon('folder', { size: 12 }) })
  );
  if (snapshot.connection.mode === 'real' && !['connected', 'legacy-readonly'].includes(snapshot.connection.state)) {
    actions.append(actionWithReason(ctx, '启动后台并连接', 'daemon.start', {}, startDaemonReason(snapshot) ?? (connectionBusy(ctx, snapshot) ? '请等待当前连接操作完成。' : null), false, 'daemon.start', { icon: icon('play', { size: 12 }) }));
  }
  return el('div', 'welcome',
    heading('ZCODE / 开始', '连接任务工作台', '在 Codex 中描述目标并调度任务，在这里监控进度、额度与交付。'),
    el('div', 'welcome-card',
      el('span', 'welcome-symbol', icon('rocket', { size: 40, className: 'welcome-icon' })),
      el('h2', '', snapshot.connection.error ? '暂时无法连接' : '让 Codex 使用同一后台'),
      el('p', '', '先生成 MCP 配置并在 Codex 中启用。工作台与 Codex 共享当前连接目录的账号、任务和并发设置。'),
      kv([
        ['运行环境', snapshot.connection.host],
        ['连接目录', snapshot.connection.poolHome],
        ['工作区信任', snapshot.connection.trusted ? '已信任' : '受限模式 · 仅可查看']
      ]),
      actions,
      el('p', 'field-hint', snapshot.connection.mode === 'mock' ? '演示模式使用模拟数据，可点击“连接监控”查看。' : '生成配置不会自动连接 Codex；启用配置后需重新连接 Codex。后台负责运行任务，关闭工作台后任务继续。'),
      button(ctx, '连接帮助', 'guidance.open', { topic: 'connection' })
    ),
    messageFor(ctx, 'connect'),
    messageFor(ctx, 'connection.configure'),
    messageFor(ctx, 'connection.codexSetup'),
    messageFor(ctx, 'daemon.start')
  );
}
