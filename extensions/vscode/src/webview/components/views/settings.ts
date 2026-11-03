import { icon } from '../../icons.js';
import type { UiSnapshot } from '../../../host/types.js';
import { mutationReason } from '../../state.js';
import type { RenderContext } from '../types.js';
import { el, section, kv, field, input, code, heading } from '../dom.js';
import { button, actionWithReason } from '../button.js';
import { messageFor } from '../feedback.js';
import { codexSetup } from '../header.js';

export function renderSettings(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const connection = snapshot.connection;
  const interval = input(ctx.state.settingsInterval, 'settingsInterval', 'number');
  interval.min = '15';
  interval.max = '300';
  const valid = Number.isInteger(Number(ctx.state.settingsInterval)) && Number(ctx.state.settingsInterval) >= 15 && Number(ctx.state.settingsInterval) <= 300;
  const concurrency = input(ctx.state.settingsConcurrency, 'settingsConcurrency', 'number');
  concurrency.min = '0';
  concurrency.max = '64';
  concurrency.step = '1';
  concurrency.placeholder = '不限制';
  concurrency.disabled = ctx.state.pending.has('pool.policy.set');
  const rawConcurrency = ctx.state.settingsConcurrency.trim();
  const numericConcurrency = Number(rawConcurrency);
  const validConcurrency = rawConcurrency === '' || (Number.isInteger(numericConcurrency) && numericConcurrency >= 0 && numericConcurrency <= 64);
  const policy = snapshot.poolPolicy;
  const setting = (key:string, fallback:number, min:string, max:string, step='1') => {
    const control = input(ctx.state.rawFields.get(`policy.${key}`) ?? String(fallback), `policy.${key}`, 'number');
    control.min = min; control.max = max; control.step = step; return control;
  };
  const retry = setting('retrySeconds', (policy?.retryIntervalMs ?? 5000) / 1000, '1', '86400');
  const recovery = setting('recoveryMinutes', (policy?.recoveryWaitMs ?? 120000) / 60000, '0.017', '1440', 'any');
  const silence = setting('silenceMinutes', (policy?.silenceCheckMs ?? 900000) / 60000, '0.017', '1440', 'any');
  const low = setting('lowQuotaPercent', policy?.lowQuotaThresholdPercent ?? 5, '0', '100', 'any');
  const defaultQuota = setting('defaultQuota', policy?.defaultCommanderQuota ?? 2, '0', '64');
  const policyReason = mutationReason(snapshot, 'poolPolicy') ?? (!policy ? '并发设置尚未读取，请刷新连接。' : !validConcurrency ? '请输入 0–64 的整数，或留空不限制。' : null);
  const diagnostic = {
    host: connection.host,
    pool: connection.poolHome,
    mode: connection.mode,
    state: connection.state,
    storeId: connection.storeId,
    instanceId: connection.instanceId,
    daemonVersion: connection.daemonVersion,
    error: connection.error?.code,
    taskId: snapshot.selectedTaskId,
    revision: snapshot.detail?.revision
  };
  const diagnostics = el('details', 'settings-diagnostics',
    el('summary', '', '高级：诊断信息'),
    el('p', 'field-hint', '复制内容包括连接身份、状态、版本与错误码，以及当前任务 ID。审批正文、提示词和凭据不会附在诊断中。'),
    code(JSON.stringify(diagnostic, null, 2), '待复制的脱敏诊断预览'),
    button(ctx, '复制脱敏诊断', 'diagnostics.copy', {}, { icon: icon('copy', { size: 12 }) }),
    messageFor(ctx, 'diagnostics.copy')
  );
  diagnostics.dataset.details = 'settings-diagnostics';
  return el('div', 'settings-page',
    heading('ZCODE / 设置', '设置', 'Codex 与工作台共享连接目录和并发上限。'),
    section('连接 Codex',
      el('p', 'field-hint', '生成当前连接目录的 MCP 配置，在 Codex 中启用后重新连接 Codex。配置生成不代表 Codex 已连接。'),
      codexSetup(ctx, snapshot, true),
      messageFor(ctx, 'connection.codexSetup')
    ),
    section('并发任务',
      policy && kv([
        ['当前上限', policy.maxConcurrentTasks === null ? '不限制' : policy.maxConcurrentTasks === 0 ? '0 · 暂停新派发' : policy.maxConcurrentTasks],
        ['占用槽位', policy.occupiedSlots],
        ['可用槽位', policy.availableSlots === null ? '不限制' : policy.availableSlots]
      ]),
      field('并发任务上限', concurrency, '0–64；留空不限制。设为 0 暂停新派发，降低上限不会停止已有任务。', ctx.state.validation.settingsConcurrency),
      actionWithReason(ctx, '保存并发上限', 'pool.policy.set', {}, policyReason, true),
      messageFor(ctx, 'pool.policy.set')
    ),
    section('重试、让号与静默核查',
      el('div', 'form-grid',
        field('基础重试间隔（秒）', retry, '默认 5 秒；官方明确要求等待时优先遵守。', ctx.state.validation['policy.retrySeconds']),
        field('连续恢复等待让号（分钟）', recovery, '默认 2 分钟；仅确认未实际执行且原执行已停止时归还账号。', ctx.state.validation['policy.recoveryMinutes']),
        field('执行静默只读核查（分钟）', silence, '默认 15 分钟；不发送提示词，不凭静默判定失败。', ctx.state.validation['policy.silenceMinutes']),
        field('低额度阈值（剩余 %）', low, '默认 5%；不打断正常执行，后续派发换号。', ctx.state.validation['policy.lowQuotaPercent']),
        field('新指挥默认账号配额', defaultQuota, '本次任务明确申请的配额临时覆盖默认值；0 暂停此范围新派发。', ctx.state.validation['policy.defaultQuota'])
      ),
      el('p', 'field-hint', '重试次数只累计统计，不设置总次数上限；恢复执行不清空历史错误。未知执行状态保留账号并核实。'),
      actionWithReason(ctx, '保存恢复与配额设置', 'pool.execution.set', {}, mutationReason(snapshot, 'poolPolicy'), true),
      messageFor(ctx, 'pool.execution.set')
    ),
    ...(snapshot.workOverview?.commanders.length ? [section('各指挥默认配额',
      ...snapshot.workOverview.commanders.map(commander => {
        const control = input(ctx.state.rawFields.get(`commanderQuota:${commander.commanderId}`) ?? String(commander.defaultQuota), `commanderQuota:${commander.commanderId}`, 'number');
        control.min = '0'; control.max = '64'; control.step = '1';
        return el('div', 'commander-quota-row', field(commander.label || commander.commanderId, control, '本次任务结束后恢复采用此默认值。'), actionWithReason(ctx, '保存配额', 'commander.quota.set', {commanderId:commander.commanderId}, mutationReason(snapshot, 'commanderQuota')));
      })
    )] : []),
    section('后台连接',
      el('p', 'field-hint', '断开面板只停止观察。收工会检查整个池，无任务占用才停止所有执行器与后台；账号和任务数据保留。下次使用需明确启动后台。'),
      kv([
        ['运行环境', connection.host],
        ['连接目录', connection.poolHome],
        ['连接模式', connection.mode === 'mock' ? '演示（模拟数据）' : '后台服务'],
        ['工作区信任', connection.trusted ? '已信任' : '受限模式']
      ]),
      el('div', 'inline-actions',
        button(ctx, '选择连接目录', 'connection.configure', {}, { busy: ctx.state.pending.has('connection.configure'), icon: icon('folder', { size: 12 }) }),
        button(ctx, '更多 VS Code 设置', 'settings.open', {}, { icon: icon('settings-gear', { size: 12 }) }),
        button(ctx, '连接帮助', 'guidance.open', { topic: 'connection' }, { icon: icon('question', { size: 12 }) })
      ),
      el('p', 'field-hint', '切换目录后面板需重新连接；Codex 后续调用使用新目录，原目录任务保留。切换远程计算环境请使用 VS Code Remote 窗口。'),
      messageFor(ctx, 'connection.configure')
    ),
    section('自动刷新',
      field('刷新间隔（秒）', interval, '默认 30 秒，范围 15–300 秒；工作台可见时自动发现新任务。', ctx.state.validation.settingsInterval),
      actionWithReason(ctx, '保存刷新间隔', 'settings.save', {}, valid ? null : '请输入 15–300 的整数。', true),
      messageFor(ctx, 'settings.save')
    ),
    diagnostics
  );
}
