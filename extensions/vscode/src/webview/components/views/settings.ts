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
    button(ctx, '复制脱敏诊断', 'diagnostics.copy'),
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
    section('后台连接',
      el('p', 'field-hint', '断开面板只停止观察。收工会检查整个池，无任务占用才停止所有执行器与后台；账号和任务数据保留。下次使用需明确启动后台。'),
      kv([
        ['运行环境', connection.host],
        ['连接目录', connection.poolHome],
        ['连接模式', connection.mode === 'mock' ? '演示（模拟数据）' : '后台服务'],
        ['工作区信任', connection.trusted ? '已信任' : '受限模式']
      ]),
      el('div', 'inline-actions',
        button(ctx, '选择连接目录', 'connection.configure', {}, { busy: ctx.state.pending.has('connection.configure') }),
        button(ctx, '更多 VS Code 设置', 'settings.open'),
        button(ctx, '连接帮助', 'guidance.open', { topic: 'connection' })
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
