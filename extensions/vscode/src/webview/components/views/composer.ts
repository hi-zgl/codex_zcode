import type { UiSnapshot } from '../../../host/types.js';
import { mutationReason, workerUnavailable } from '../../state.js';
import type { RenderContext } from '../types.js';
import { el, section, kv, field, input, select, code, heading } from '../dom.js';
import { notice } from '../primitives.js';
import { button, actionWithReason } from '../button.js';
import { messageFor } from '../feedback.js';
import { resourceState } from './resources/index.js';

export function renderComposer(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const draft = ctx.state.draft ?? snapshot.draft;
  const workspace = snapshot.resources.workspaces.find(item => item.workspaceId === draft.workspaceId);
  const worker = snapshot.resources.workers.find(item => item.workerId === draft.workerId);
  const account = snapshot.resources.accounts.find(item => item.alias === worker?.accountAlias);
  const node = el('div', 'composer-page', heading('ZCODE / 高级操作', '手动派发任务', '直接指定任务目录与执行器。日常可在 Codex 中描述目标，由 Codex 调度。草稿在关闭或重载窗口后可能丢失。', button(ctx, '返回任务列表', 'page', { page: 'tasks' })));
  node.append(el('p', 'field-hint', '任务目录是代码修改的位置；执行器决定使用哪个账号。'));
  const form = el('form', 'composer-form');
  form.noValidate = true;
  form.addEventListener('submit', event => {
    event.preventDefault();
    ctx.action('dispatch');
  });
  form.append(
    el('div', 'form-grid',
      field('任务目录', select(draft.workspaceId, 'draft.workspaceId', [['', '请选择任务目录'], ...snapshot.resources.workspaces.map(item => [item.workspaceId, `${item.workspaceId} · ${item.branch}${item.activeTaskId ? ' · 已占用' : ''}`] as [string, string])]), undefined, ctx.state.validation.workspaceId),
      field('执行器', select(draft.workerId, 'draft.workerId', [['', '请选择执行器'], ...snapshot.resources.workers.map(item => [item.workerId, `${item.workerId} · ${item.accountAlias} · ${resourceState(item.state)}`] as [string, string])]), undefined, ctx.state.validation.workerId)
    )
  );
  if (workspace) form.append(kv([['源仓库', workspace.repositoryPath], ['执行目录', workspace.worktreePath], ['分支', workspace.branch], ['起始提交', workspace.baseCommit]]));
  if (worker) {
    form.append(kv([['绑定账号', `${worker.accountAlias} / ${account?.provider ?? '服务商未知'}`], ['账号状态', account ? resourceState(account.health) : '未知'], ['正在运行的操作数', worker.runningTaskCount === undefined ? '未知' : worker.runningTaskCount], ['占用任务', worker.leaseTaskIds.join('、') || '无已知占用']]));
    const unavailable = workerUnavailable(snapshot, worker.workerId);
    if (unavailable) form.append(notice(unavailable, 'warning'));
  }
  if (account?.health === 'unknown') form.append(notice('账号认证状态尚未确认，可在“资源”页查询认证与额度。', 'warning'));
  const prompt = el('textarea');
  prompt.value = draft.prompt;
  prompt.rows = 9;
  prompt.maxLength = 100_001;
  prompt.dataset.field = 'draft.prompt';
  prompt.dataset.focus = 'draft.prompt';
  form.append(field('要完成的工作', prompt, '描述目标、要求和验收方式。内容只发送给所选执行器的当前任务。', ctx.state.validation.prompt));
  const model = input(draft.modelId, 'draft.modelId');
  const retries = input(String(draft.busyRetryLimit), 'draft.busyRetryLimit', 'number');
  retries.min = '0';
  retries.max = '10';
  retries.step = '1';
  form.append(el('div', 'form-grid',
    field('模型 ID', model, '后台会检查模型是否可用。', ctx.state.validation.modelId),
    field('运行模式', select(draft.mode, 'draft.mode', ['build', 'edit', 'plan', 'yolo', 'guarded'].map(mode => [mode, mode])), '由已安装的运行环境决定具体行为。'),
    field('会话', select(draft.session, 'draft.session', [['continue', '继续最近可复用会话'], ['new', '新会话']]), '仅复用同任务目录、同执行器且已停止的会话；没有则新建。'),
    field('模型繁忙时续跑次数', retries, '默认 3 次；0 关闭，最多 10 次。使用原会话发送“继续”。', ctx.state.validation.busyRetryLimit)
  ));
  const commands = section('核验命令', el('p', 'field-hint', '任务执行结束后运行这些命令检查结果，最多 10 项。'));
  for (const [index, command] of draft.verifyCommands.entries()) {
    const executable = input(command.command, `verify.${index}.command`);
    const args = input(ctx.state.rawFields.get(`verify.${index}.args`) ?? JSON.stringify(command.args), `verify.${index}.args`);
    const timeout = input(String(command.timeoutMs), `verify.${index}.timeoutMs`, 'number');
    timeout.min = '100';
    timeout.max = '300000';
    commands.append(el('div', 'verification-command',
      el('h4', '', `命令 ${index + 1}`),
      field('命令名称', executable, undefined, ctx.state.validation[`verify.${index}.command`]),
      field('参数（JSON 字符串数组）', args, '如 ["--test","test/example.test.ts"]；不经过 shell。', ctx.state.validation[`verify.${index}.args`]),
      field('超时（毫秒）', timeout, undefined, ctx.state.validation[`verify.${index}.timeoutMs`]),
      button(ctx, '移除此命令', 'verify.remove', { index: String(index) })
    ));
  }
  if (!draft.verifyCommands.length) commands.append(code('git diff --check', '未配置命令时使用此默认核验'));
  commands.append(button(ctx, '添加核验命令', 'verify.add', {}, { reason: draft.verifyCommands.length >= 10 ? '已达 10 项上限。' : null }));
  form.append(commands);
  const reason = mutationReason(snapshot, 'dispatchTask') ?? (ctx.state.submittedDraftToken === draft.submitToken ? '此草稿已提交，保留原请求身份。请检查回执或查询原请求；建立独立任务请返回列表使用“高级操作”。' : null);
  form.append(actionWithReason(ctx, '提交任务', 'dispatch', {}, reason, true), messageFor(ctx, 'dispatch') ?? '', el('p', 'field-hint', '提交后可在任务列表查看进度。若结果待确认，请通过回执查询原请求。'));
  node.append(form);
  return node;
}
