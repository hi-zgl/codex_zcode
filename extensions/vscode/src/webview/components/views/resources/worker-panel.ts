import type { UiSnapshot } from '../../../../host/types.js';
import { sortAccountsByQuota } from '../../../../../../../src/shared/account-sort.js';
import { mutationReason } from '../../../state.js';
import { icon } from '../../../icons.js';
import type { RenderContext } from '../../types.js';
import { el, section, kv, field, input, select } from '../../dom.js';
import { badge, pulseDot } from '../../primitives.js';
import { button, actionWithReason } from '../../button.js';
import { emptyCard, messageFor } from '../../feedback.js';
import { resourceState } from './account-card.js';

/**
 * Computes whether starting a worker is blocked and returns the disabled reason.
 */
function computeWorkerStartReason(
  ctx: RenderContext,
  snapshot: UiSnapshot,
  selectedAccountAlias: string
): string | null {
  const baseReason = mutationReason(snapshot, 'startWorker');
  if (baseReason) return baseReason;

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(ctx.state.workerId)) {
    return '名称须为 1–64 个字母、数字、下划线或连字符。';
  }
  if (!selectedAccountAlias) {
    return '请选择账号。';
  }

  const selectedAccount = snapshot.resources.accounts.find(a => a.alias === selectedAccountAlias);
  if (!selectedAccount) {
    return '请选择有效的账号。';
  }

  const hasRunning = snapshot.resources.workers.some(
    w => w.accountAlias === selectedAccount.alias && w.state !== 'stopped'
  );
  if (hasRunning) {
    return '此账号已有未停止的执行器，请先检查其状态。';
  }

  if (['blocked', 'invalid', 'cooling'].includes(selectedAccount.health)) {
    return '此账号当前状态不允许启动。';
  }

  return null;
}

/**
 * Renders an individual worker instance card.
 */
function renderWorkerCard(
  ctx: RenderContext,
  snapshot: UiSnapshot,
  worker: UiSnapshot['resources']['workers'][number]
): HTMLElement {
  const occupied = worker.leaseTaskIds.length > 0 ||
    worker.runningTaskCount === undefined ||
    worker.runningTaskCount !== 0;

  const stopReason = mutationReason(snapshot, 'stopWorker') ?? (
    !worker.processOwned
      ? '尚未确认此执行器属于当前连接目录。'
      : worker.state !== 'ready'
      ? '执行器尚未就绪，暂不能从这里停止。'
      : occupied
      ? '执行器仍在运行、状态未知或有任务占用，暂不能停止。'
      : null
  );

  const probeReason = mutationReason(snapshot, 'quotaProbe') ?? (
    worker.state !== 'ready' ? '执行器就绪后可查询额度。' : null
  );

  const isOnline = worker.state === 'ready' || worker.state === 'running';
  const workerBadge = badge(
    isOnline ? [pulseDot(), ` ${resourceState(worker.state)}`] : resourceState(worker.state),
    worker.state === 'ready' ? 'success' : worker.state === 'running' ? 'running' : 'attention'
  );

  const boundAccount = snapshot.resources.accounts.find(a => a.alias === worker.accountAlias);
  const boundAccountLabel = boundAccount?.email
    ? `${boundAccount.email} (${worker.accountAlias})`
    : worker.accountAlias;

  const card = el('article', 'resource-card worker-card',
    el('div', 'section-toolbar', el('h4', '', worker.workerId), workerBadge),
    kv([
      ['绑定账号', boundAccountLabel],
      ['运行版本', worker.version],
      ['正在运行的操作数', worker.runningTaskCount === undefined ? '未知' : worker.runningTaskCount],
      ['占用任务', worker.leaseTaskIds.length ? worker.leaseTaskIds.join('、') : '无已知占用'],
      ['管理归属', worker.processOwned ? '属于当前连接目录' : '尚未确认']
    ])
  );

  for (const taskId of worker.leaseTaskIds) {
    card.append(button(ctx, `查看占用任务 ${taskId}`, 'task.select', { taskId }, { icon: icon('go-to-file', { size: 12 }) }));
  }

  const actions = el('div', 'resource-actions',
    actionWithReason(
      ctx,
      '查询认证与额度',
      'worker.probe',
      { workerId: worker.workerId },
      probeReason,
      false,
      `worker:${worker.workerId}:probe`,
      { icon: icon('pulse', { size: 12 }) }
    ),
    actionWithReason(
      ctx,
      '停止空闲执行器',
      'worker.stop',
      { workerId: worker.workerId },
      stopReason,
      false,
      `worker:${worker.workerId}:stop`,
      { variant: 'danger', icon: icon('stop-circle', { size: 12 }), confirm: { prompt: `停止执行器 ${worker.workerId}？`, confirmLabel: '确认停止' } }
    )
  );

  card.append(
    actions,
    el('p', 'field-hint', '查询会连接官方服务，更新账号认证与额度。执行器就绪后仍可能被任务占用。'),
    messageFor(ctx, `worker:${worker.workerId}`) ?? ''
  );

  return card;
}

/**
 * Renders the full Worker Management section.
 */
export function renderWorkerSection(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const workerIdInput = input(ctx.state.workerId, 'workerId');
  workerIdInput.placeholder = '例如 wrk-01';

  const sortedAccounts = sortAccountsByQuota(
    snapshot.resources.accounts,
    snapshot.resources.quotas,
    'quota_first'
  );

  const accountOptions: [string, string][] = [
    ['', '请选择账号'],
    ...sortedAccounts.map(acc => {
      const optionLabel = acc.email ? `${acc.email} (${acc.alias})` : acc.alias;
      return [
        acc.alias,
        `${optionLabel} · ${acc.provider} · ${resourceState(acc.health)}`
      ] as [string, string];
    })
  ];

  const accountSelect = select(ctx.state.workerAccount, 'workerAccount', accountOptions);
  const startReason = computeWorkerStartReason(ctx, snapshot, ctx.state.workerAccount);

  const form = el('div', 'worker-start-form',
    field('执行器名称', workerIdInput),
    field('绑定账号', accountSelect),
    actionWithReason(ctx, '启动执行器', 'worker.start', {}, startReason, true, 'worker.start', { icon: icon('play', { size: 12 }) })
  );

  const sec = section(
    '执行器',
    el('p', 'field-hint', '执行器是绑定一个账号的 ZCode 实例，每个账号同时使用一个。日常交办由指挥自动准备；以下手动管理用于检查和调试。'),
    form,
    messageFor(ctx, 'worker.start')
  );

  if (!snapshot.resources.workers.length) {
    sec.append(emptyCard(
      '尚无执行器',
      '填写名称并选择账号后启动。',
      { icon: 'cpu', hint: '每个就绪执行器独立绑定单个账号并隔离执行进程。' }
    ));
  } else {
    for (const worker of snapshot.resources.workers) {
      sec.append(renderWorkerCard(ctx, snapshot, worker));
    }
  }

  return sec;
}
