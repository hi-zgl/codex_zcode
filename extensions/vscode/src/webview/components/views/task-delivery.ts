import type { UiSnapshot, UiTask } from '../../../host/types.js';
import type { UiArtifactFile } from '../../../../../../src/shared/ui-contract.js';
import { mutationReason, safeDetail } from '../../state.js';
import { icon, type IconName } from '../../icons.js';
import type { RenderContext } from '../types.js';
import { el, date, bytes, section, kv, code } from '../dom.js';
import { badge, notice } from '../primitives.js';
import { button, actionWithReason } from '../button.js';
import { emptyCard, messageFor } from '../feedback.js';

export function renderDelivery(ctx: RenderContext, snapshot: UiSnapshot, task: UiTask): HTMLElement {
  const detail = safeDetail(snapshot);
  const result = detail?.result;
  const node = el('div', 'delivery');
  if (!result?.available) {
    const legacy = snapshot.legacyResult?.result;
    if (legacy) {
      node.append(
        section('交付摘要（旧接口）',
          el('p', '', legacy.summary),
          legacy.verification && section('核验记录', ...legacy.verification.map(item => el('div', 'verification-row', el('code', '', item.command), badge(item.exitCode === null ? '退出码未知' : `退出码 ${item.exitCode}`), item.summary && code(item.summary, '旧接口核验摘要')))),
          legacy.blockers && section('Blockers', el('ul', '', ...legacy.blockers.map(item => el('li', '', item))))
        )
      );
    } else {
      node.append(emptyCard('交付尚未生成', '结果为空不能证明没有修改，也不表示已通过核验。', {
        icon: 'git-commit',
        tone: 'info',
        hint: '可在下方加载不可变交付快照或读取累计 patch 文字以核实工作区变更。'
      }));
    }
  } else {
    node.append(
      section('交付总结', el('p', 'delivery-summary', result.summary || '没有摘要。'), result.summaryTruncated && badge('摘要已截断', 'attention'))
    );
    if (result.blockers.length) node.append(section('仍需处理', el('ul', 'blockers', ...result.blockers.map(blocker => el('li', '', blocker)))));
    const verification = el('div', 'verification-list');
    for (const item of result.verification) {
      const exitSuccess = item.exitCode === 0;
      const exitFailed = item.exitCode !== 0 && item.exitCode !== null;
      const exitBadge = item.exitCode === 0
        ? badge([icon('check', { size: 11 }), ' 退出码 0 · 成功'], 'success')
        : item.exitCode === null
        ? badge('退出码未知', 'idle')
        : badge([icon('x-circle', { size: 11 }), ` 退出码 ${item.exitCode} · 失败`], 'danger attention');

      const cmdHeader = el('div', 'section-toolbar verification-header',
        el('div', 'terminal-cmd-wrap',
          el('span', 'terminal-prompt', icon('terminal', { size: 13 })),
          el('code', 'terminal-cmd', item.commandDisplay)
        ),
        exitBadge
      );

      verification.append(
        el('article', `verification-row terminal-receipt ${exitSuccess ? 'receipt-success' : exitFailed ? 'receipt-failed' : ''}`,
          cmdHeader,
          item.summary && code(item.summary, '核验输出摘要'),
          item.summaryTruncated && badge('输出摘要已截断', 'attention')
        )
      );
    }
    node.append(section('核验事实', result.verification.length ? verification : el('p', 'muted', '当前结果没有核验记录。'), notice('命令退出码仅说明这些检查的执行结果，仍需功能验收。')));
  }
  const manifest = snapshot.delivery.manifest;
  node.append(section('不可变交付快照',
    el('div', 'inline-actions',
      button(ctx, manifest ? '刷新文件清单' : '加载快照与文件清单', 'artifacts.list', { taskId: task.taskId }, { busy: ctx.state.pending.has(`task:${task.taskId}:artifacts`), icon: manifest ? icon('refresh', { size: 12 }) : undefined }),
      button(ctx, ctx.state.patchLoaded ? '重新读取 patch' : '读取 patch 文字', 'patch.read', { taskId: task.taskId, offset: '0' }, { busy: ctx.state.pending.has(`task:${task.taskId}:patch`) })
    )
  ));
  if (manifest) {
    node.append(kv([
      ['快照状态', manifest.state],
      ['起始提交', manifest.baseCommit],
      ['比较范围', '相对任务目录起始提交的累计变化，可能包含先前任务'],
      ['文件范围', 'Git 已跟踪文件与未忽略的未跟踪文件'],
      ['捕获开始', date(manifest.captureStartedAtMs)],
      ['捕获结束', date(manifest.captureCompletedAtMs)],
      ['一致性', manifest.consistency === 'lease_held_non_atomic' ? '保存期间保留资源占用，逐文件捕获；各文件的保存时间可能不同' : '旧数据一致性未知'],
      ['交付清单 SHA-256', manifest.manifestSha256],
      ['文件计数', manifest.fileCount === null ? '未知' : `${manifest.fileCount} 项（可用 ${manifest.availableFileCount}，缺口 ${manifest.unavailableFileCount}）`]
    ]));
    if (manifest.unavailableReason || manifest.state !== 'available') {
      node.append(notice(manifest.unavailableReason ?? '此任务没有完整历史文件快照；不能使用当前 worktree 冒充历史 Diff。', 'warning'));
    }
    const files = el('div', 'artifact-files');
    if (!snapshot.delivery.files.length) {
      files.append(emptyCard('快照与基线一致，无文件变更', '此任务交付快照与起始基线完全一致，未产生任何文件变更。', {
        icon: 'file-diff',
        tone: 'success',
        hint: '已核对 Git 跟踪文件及未忽略的未跟踪文件。'
      }));
    } else {
      for (const file of snapshot.delivery.files as UiArtifactFile[]) files.append(renderArtifactFile(ctx, task, file, manifest.manifestSha256));
    }
    node.append(files);
    if (snapshot.delivery.nextCursor) {
      node.append(button(ctx, '继续读取文件清单', 'artifacts.list', { taskId: task.taskId, cursor: snapshot.delivery.nextCursor }, { busy: ctx.state.pending.has(`task:${task.taskId}:artifacts`) }));
    }
    const canReview = manifest.state === 'available' && !!manifest.manifestSha256 && manifest.fileListComplete && !snapshot.delivery.nextCursor && snapshot.delivery.files.length === manifest.fileCount && ctx.state.deliveryVisited;
    const unopenedFiles = snapshot.delivery.files.filter(file => file.nativeDiff.available && !ctx.state.inspectedFiles.has(file.fileId));
    const reason = mutationReason(snapshot, 'artifactSnapshots') ?? (!canReview ? '需要完整交付清单、文件列表，以及已查看的交付与核验信息。' : task.status === 'verifying' ? '核验尚未结束。' : !snapshot.delivery.reviewed && unopenedFiles.length ? `请先打开 ${unopenedFiles.length} 个尚未查看的不可变文件 Diff。` : null);
    node.append(section('本窗口审阅',
      el('p', '', snapshot.delivery.reviewed ? [icon('check-circle', { size: 13 }), ' 本窗口已标记审阅这份交付。'] : '完成变更检查与功能验收后，可记录本窗口的审阅结果。'),
      actionWithReason(ctx, snapshot.delivery.reviewed ? '撤销已审阅标记' : '标记已审阅', 'review.set', { taskId: task.taskId, manifestSha256: manifest.manifestSha256 ?? '', reviewed: String(!snapshot.delivery.reviewed) }, reason, true),
      el('p', 'field-hint', '标记仅用于当前窗口，绑定本任务的这份交付。代码合并与其他客户端的验收需分别进行。')
    ));
  }
  if (ctx.state.patchLoaded) {
    node.append(section(
      ctx.state.patchNextOffset === null ? '完整 patch 文字' : '部分 patch · 尚未完整载入',
      code(ctx.state.patch || '此可用 patch 为空。', '累计 patch 文字'),
      ctx.state.patchNextOffset !== null && button(ctx, '继续读取 patch（UTF-16 offset）', 'patch.read', { taskId: task.taskId, offset: String(ctx.state.patchNextOffset) }, { busy: ctx.state.pending.has(`task:${task.taskId}:patch`) }),
      el('p', 'field-hint', 'patch 不包含未跟踪文件内容；分页 offset 单位为 UTF-16 code units。')
    ));
  }
  const artifact = ctx.state.artifact;
  if (artifact) {
    node.append(section(
      `${artifact.file.displayPath} · ${artifact.side === 'base' ? 'Base' : '交付'}固定文本${artifact.file[artifact.side].kind === 'symlink' ? '（符号链接目标文字）' : ''}`,
      el('p', 'scope-note', `已载入 ${bytes(artifact.loadedBytes)} / ${bytes(artifact.totalBytes)} · ${artifact.complete ? '全文已读齐' : '尚未完整载入'}`),
      code(artifact.text, '不可变工件文本'),
      artifact.error && notice(artifact.error, 'error'),
      artifact.nextOffsetBytes !== null && button(ctx, '继续读取工件文本', 'artifact.read', { taskId: task.taskId, manifestSha256: manifest?.manifestSha256 ?? '', fileId: artifact.file.fileId, side: artifact.side, offsetBytes: String(artifact.nextOffsetBytes) }, { busy: ctx.state.pending.has(`artifact:${artifact.file.fileId}`) })
    ));
  }
  node.append(messageFor(ctx, `task:${task.taskId}:artifacts`) ?? '', messageFor(ctx, `task:${task.taskId}:patch`) ?? '');
  return node;
}

export function renderArtifactFile(ctx: RenderContext, task: UiTask, file: UiArtifactFile, manifestSha256: string | null): HTMLElement {
  const changeMeta: Readonly<Record<string, { readonly tone: string; readonly iconName: IconName; readonly text: string }>> = {
    added: { tone: 'success', iconName: 'file-plus', text: '新增' },
    modified: { tone: 'attention', iconName: 'file-diff', text: '修改' },
    deleted: { tone: 'failed attention', iconName: 'file-minus', text: '删除' },
    renamed: { tone: 'running', iconName: 'arrow-right', text: '重命名' },
    mode_changed: { tone: 'attention', iconName: 'git-commit', text: '权限变更' },
    type_changed: { tone: 'attention', iconName: 'git-commit', text: '类型变更' },
    untracked: { tone: 'idle', iconName: 'info', text: '未跟踪' },
    unknown: { tone: 'idle', iconName: 'dot', text: '未知' }
  };
  const meta = changeMeta[file.change] ?? { tone: 'idle', iconName: 'dot' as IconName, text: file.change };
  const changeBadge = badge([el('span', 'change-symbol', icon(meta.iconName, { size: 11 })), ` ${meta.text}`], `${meta.tone} change-badge`);
  changeBadge.dataset.change = file.change;

  const header = el('div', 'section-toolbar',
    el('div', 'file-path-wrap',
      icon(meta.iconName, { size: 13, className: 'file-icon' }),
      el('strong', 'file-path', file.displayPath)
    ),
    changeBadge
  );

  const node = el('article', `artifact-file file-change-${file.change}`,
    header,
    el('p', 'field-hint',
      `Base: ${file.base.state} · ${file.base.kind} · ${bytes(file.base.sizeBytes)} `,
      icon('arrow-right', { size: 11, className: 'inline-arrow-icon' }),
      ` 交付: ${file.final.state} · ${file.final.kind} · ${bytes(file.final.sizeBytes)}`
    )
  );
  node.dataset.change = file.change;
  if (file.change === 'untracked') node.append(el('p', 'field-hint', '未跟踪工件 · 不包含在 patch 中'));
  const readReason = !manifestSha256 ? '缺少已验证的 manifest 身份。' : file.nativeDiff.available ? null : file.nativeDiff.reason ?? '不可用的文件类型或历史字节。';
  node.append(actionWithReason(ctx, '打开原生 Diff', 'diff.open', { taskId: task.taskId, manifestSha256: manifestSha256 ?? '', fileId: file.fileId }, readReason));
  const contentActions = el('div', 'inline-actions');
  for (const side of ['base', 'final'] as const) {
    if (file[side].state === 'available' && file[side].encoding === 'utf8') {
      contentActions.append(button(ctx, `读取${side === 'base' ? ' Base ' : '交付'}工件文本`, 'artifact.read', { taskId: task.taskId, manifestSha256: manifestSha256 ?? '', fileId: file.fileId, side, offsetBytes: '0' }, { reason: !manifestSha256 ? '缺少 manifest 身份。' : null, busy: ctx.state.pending.has(`artifact:${file.fileId}`) }));
    }
  }
  node.append(contentActions, kv([['Base SHA-256', file.base.sha256], ['Final SHA-256', file.final.sha256]]));
  node.append(actionWithReason(ctx, '打开当前文件（当前磁盘版本）', 'file.current.open', { taskId: task.taskId, manifestSha256: manifestSha256 ?? '', fileId: file.fileId }, ctx.state.snapshot?.connection.mode === 'mock' ? '演示模式没有真实的当前磁盘文件。' : !manifestSha256 || !file.relativePath ? '缺少受限的文件身份或可安全映射的相对路径。' : null, false, `artifact:${file.fileId}`));
  node.append(el('p', 'field-hint', '当前磁盘文件可能已被后续任务修改；历史交付仍以上方的不可变快照 Diff 为准。'));
  if (file.final.encoding === 'binary' || file.base.encoding === 'binary') {
    node.append(el('p', 'field-hint', '二进制文件：仅显示类型、大小、摘要与存在性，不作为文本解码。'));
  }
  node.append(messageFor(ctx, `artifact:${file.fileId}`) ?? '');
  return node;
}
