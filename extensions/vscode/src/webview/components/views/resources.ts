import type { UiSnapshot } from '../../../host/types.js';
import type { UiQuotaSnapshot, UiQuota } from '../../../../../../src/shared/ui-contract.js';
import { mutationReason } from '../../state.js';
import { icon } from '../../icons.js';
import type { RenderContext } from '../types.js';
import { el, date, section, kv, field, input, select, heading } from '../dom.js';
import { badge, pulseDot, notice } from '../primitives.js';
import { button, actionWithReason } from '../button.js';
import { emptyCard, messageFor } from '../feedback.js';

export function resourceState(value: string): string {
  return ({ ready: '就绪', starting: '启动中', stopped: '已停止', active: '可用', archived: '已归档', available: '可用', unknown: '未确认', blocked: '受阻', invalid: '无效', cooling: '冷却中', error: '异常' } as Record<string, string>)[value] ?? value;
}

export function renderResources(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const node = el('div', 'resources-page', heading('ZCODE / 额度', '额度与资源', '查看账号额度与可用资源，必要时人工调整；Codex 使用同一连接目录。', button(ctx, '刷新资源', 'resources.refresh', {}, { busy: ctx.state.pending.has('resources.refresh'), icon: icon('refresh', { size: 12 }) })));
  node.append(section('账号与额度', el('p', 'field-hint', `展开账号可读取额度快照；在线查询通过下方执行器发起。从 ${snapshot.connection.host} 导入 1–100 个 OAuth JSON 文件，同名账号可能覆盖已有记录。`), actionWithReason(ctx, '导入账号文件', 'accounts.import', {}, mutationReason(snapshot, 'importAccounts')), ctx.state.importSummary && notice(ctx.state.importSummary), !snapshot.resources.accounts.length && emptyCard('尚无账号', '导入账号后，可为它启动执行器。已有历史任务仍可查看。', { icon: 'shield', hint: '支持批量导入 1–100 个 OAuth JSON 凭据文件。' }), ...snapshot.resources.accounts.map(account => renderAccount(ctx, snapshot, account.alias))));
  const workerId = input(ctx.state.workerId, 'workerId'); workerId.placeholder = '例如 wrk-01';
  const accountSelect = select(ctx.state.workerAccount, 'workerAccount', [['', '请选择账号'], ...snapshot.resources.accounts.map(account => [account.alias, `${account.alias} · ${account.provider} · ${resourceState(account.health)}`] as [string, string])]);
  const selectedAccount = snapshot.resources.accounts.find(account => account.alias === ctx.state.workerAccount);
  const startReason = mutationReason(snapshot, 'startWorker') ?? (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(ctx.state.workerId) ? '名称须为 1–64 个字母、数字、下划线或连字符。' : !selectedAccount ? '请选择账号。' : snapshot.resources.workers.some(worker => worker.accountAlias === selectedAccount.alias && worker.state !== 'stopped') ? '此账号已有未停止的执行器，请先检查其状态。' : ['blocked', 'invalid', 'cooling'].includes(selectedAccount.health) ? '此账号当前状态不允许启动。' : null);
  node.append(section('执行器', el('p', 'field-hint', '执行器使用绑定账号运行任务；每个账号同时使用一个执行器。'), el('div', 'worker-start-form', field('执行器名称', workerId), field('绑定账号', accountSelect), actionWithReason(ctx, '启动执行器', 'worker.start', {}, startReason, true)), messageFor(ctx, 'worker.start'), !snapshot.resources.workers.length && emptyCard('尚无执行器', '填写名称并选择账号后启动。', { icon: 'cpu', hint: '每个就绪执行器独立绑定单个账号并隔离执行进程。' }), ...snapshot.resources.workers.map(worker => {
    const occupied = worker.leaseTaskIds.length > 0 || worker.runningTaskCount === undefined || worker.runningTaskCount !== 0;
    const stopReason = mutationReason(snapshot, 'stopWorker') ?? (!worker.processOwned ? '尚未确认此执行器属于当前连接目录。' : worker.state !== 'ready' ? '执行器尚未就绪，暂不能从这里停止。' : occupied ? '执行器仍在运行、状态未知或有任务占用，暂不能停止。' : null);
    const probeReason = mutationReason(snapshot, 'quotaProbe') ?? (worker.state !== 'ready' ? '执行器就绪后可查询额度。' : null);
    const isOnline = worker.state === 'ready' || worker.state === 'running';
    const workerBadge = badge(
      isOnline ? [pulseDot(), ` ${resourceState(worker.state)}`] : resourceState(worker.state),
      worker.state === 'ready' ? 'success' : worker.state === 'running' ? 'running' : 'attention'
    );
    return el('article', 'resource-card worker-card', el('div', 'section-toolbar', el('h4', '', worker.workerId), workerBadge), kv([['绑定账号', worker.accountAlias], ['运行版本', worker.version], ['正在运行的操作数', worker.runningTaskCount === undefined ? '未知' : worker.runningTaskCount], ['占用任务', worker.leaseTaskIds.length ? worker.leaseTaskIds.join('、') : '无已知占用'], ['管理归属', worker.processOwned ? '属于当前连接目录' : '尚未确认']]), ...worker.leaseTaskIds.map(taskId => button(ctx, `查看占用任务 ${taskId}`, 'task.select', { taskId })), el('div', 'resource-actions', actionWithReason(ctx, '查询认证与额度', 'worker.probe', { workerId: worker.workerId }, probeReason, false, `worker:${worker.workerId}:probe`), actionWithReason(ctx, '停止空闲执行器', 'worker.stop', { workerId: worker.workerId }, stopReason, false, `worker:${worker.workerId}:stop`, { variant: 'danger' })), el('p', 'field-hint', '查询会连接官方服务，更新账号认证与额度。执行器就绪后仍可能被任务占用。'), messageFor(ctx, `worker:${worker.workerId}`));
  })));
  const baseRef = input(ctx.state.baseRef, 'baseRef');
  node.append(section('任务目录', el('p', 'field-hint', '从干净的 Git仓库创建独立任务目录与新分支，供任务在其中修改和核验代码。'), el('div', 'workspace-create-form', field('起始分支或提交', baseRef, '如 HEAD、main 或提交 ID；点击按钮后选择源仓库。', ctx.state.validation.baseRef), actionWithReason(ctx, '选择仓库并创建任务目录', 'workspace.create', {}, mutationReason(snapshot, 'createWorkspace') ?? (!ctx.state.baseRef.trim() ? '请输入起始分支或提交。' : null), true)), messageFor(ctx, 'workspace.create'), !snapshot.resources.workspaces.length && emptyCard('尚无任务目录', '从源仓库创建任务目录后，即可提交任务。', { icon: 'branch', hint: '每个任务目录拥有独立 Git worktree 与专属分支。' }), ...snapshot.resources.workspaces.map(workspace => el('article', 'resource-card', el('div', 'section-toolbar', el('h4', '', workspace.workspaceId), badge(resourceState(workspace.state))), kv([['源仓库', workspace.repositoryPath], ['执行目录', workspace.worktreePath], ['分支', workspace.branch], ['起始提交', workspace.baseCommit], ['占用任务', workspace.activeTaskId ?? '无已知占用']]), workspace.activeTaskId && button(ctx, '查看关联任务', 'task.select', { taskId: workspace.activeTaskId })))));
  return node;
}

export function renderAccount(ctx: RenderContext, snapshot: UiSnapshot, alias: string): HTMLElement {
  const account = snapshot.resources.accounts.find(item => item.alias === alias)!;
  const expanded = ctx.state.expandedAccounts.has(alias);
  const quota = snapshot.resources.quotas[alias] as UiQuota | undefined;
  const toggle = button(ctx, expanded ? '收起额度来源' : '展开额度来源', 'account.toggle', { alias });
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-controls', `quota-${alias}`);
  const isAvailable = account.health === 'available';
  const healthBadge = badge(
    isAvailable ? [pulseDot(), ` ${resourceState(account.health)}`] : resourceState(account.health),
    ['blocked', 'invalid', 'cooling'].includes(account.health) ? 'attention' : isAvailable ? 'success' : ''
  );
  const node = el('article', 'resource-card account-card', el('div', 'section-toolbar', el('div', '', el('h4', '', alias), el('span', 'muted', `${account.provider}${account.plan ? ` · ${account.plan}` : ''}`)), healthBadge), toggle);
  if (expanded) {
    const content = el('div', 'quota-detail');
    content.id = `quota-${alias}`;
    content.append(button(ctx, '读取已有额度快照（无网络）', 'quota.read', { accountAlias: alias }, { busy: ctx.state.pending.has(`quota:${alias}`) }));
    if (!quota) {
      content.append(el('p', 'muted', '尚未读取额度记录。账号健康与额度分别判断，不使用旧额度自动派发。'));
    } else {
      content.append(el('div', 'quota-sources', renderQuota('在线查询快照', quota.live, quota.displayFreshnessWindowMs), renderQuota('导入快照', quota.imported, quota.displayFreshnessWindowMs)));
      content.append(el('p', quota.lastProbe.state === 'failed' ? 'field-error' : 'field-hint', `最近查询：${quota.lastProbe.state === 'never' ? '从未查询' : quota.lastProbe.state === 'failed' ? `失败 ${quota.lastProbe.errorCode ?? ''}；保留上次成功值` : '成功'}${quota.lastProbe.attemptedAtMs ? ` · ${date(quota.lastProbe.attemptedAtMs)}` : ''}`));
    }
    content.append(messageFor(ctx, `quota:${alias}`) ?? '');
    node.append(content);
  }
  return node;
}

export function renderQuota(title: string, quota: UiQuotaSnapshot | null, freshnessWindowMs: number): HTMLElement {
  const node = el('div', 'quota-source', el('h5', '', title));
  if (!quota) {
    node.append(el('p', 'muted', title.startsWith('在线') ? '未查询' : '没有导入额度快照'));
    return node;
  }
  const sourceTime = (time: UiQuotaSnapshot['generatedAt']): string => (time ? (time.atMs !== null ? date(time.atMs) : `${time.value}（单位 ${time.unit}，不推测日期）`) : '未知');
  let freshness = quota.freshness;
  if (quota.source === 'live_probe' && quota.observedAtMs !== null) {
    const age = Date.now() - quota.observedAtMs;
    freshness = age < 0 ? 'unknown' : age > freshnessWindowMs ? 'stale' : quota.freshness;
  }
  node.append(
    el('div', 'quota-value', quota.remaining === null ? '余量未知' : String(quota.remaining), el('span', '', quota.unit === 'unknown' ? '单位未知' : quota.unit)),
    kv([
      ['来源', quota.source === 'live_probe' ? '用户发起的在线查询' : '导入时快照'],
      ['总量 / 已用', `${quota.total === null ? '未知' : quota.total} / ${quota.used === null ? '未知' : quota.used}`],
      ['观测时间', date(quota.observedAtMs)],
      ['官方生成时间', sourceTime(quota.generatedAt)],
      ['官方服务器时间', sourceTime(quota.serverTime)],
      ['下次重置', sourceTime(quota.nextReset)],
      ['新鲜度', freshness === 'fresh' ? '近期观测（不保证云端余额）' : freshness === 'stale' ? '陈旧快照' : '未知']
    ])
  );
  const percentage = quota.percentage;
  if (percentage && percentage.scale !== 'unknown') {
    const value = percentage.scale === '0_to_1' ? percentage.value * 100 : percentage.value;
    if (value >= 0 && value <= 100) {
      const meter = el('progress');
      meter.max = 100;
      meter.value = value;
      meter.setAttribute('aria-label', `${title}百分比 ${value.toFixed(1)}%`);
      if (quota.remaining === 0 || value <= 15) {
        meter.className = 'meter-danger';
      } else if (value <= 30) {
        meter.className = 'meter-warning';
      } else {
        meter.className = 'meter-normal';
      }
      node.append(meter, el('span', 'field-hint', `原始百分比指标 ${value.toFixed(1)}%`));
    }
  }
  return node;
}
