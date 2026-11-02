import type { UiSnapshot } from '../../../../host/types.js';
import { mutationReason } from '../../../state.js';
import type { RenderContext } from '../../types.js';
import { el, section, kv, field, input } from '../../dom.js';
import { badge, pulseDot } from '../../primitives.js';
import { button, actionWithReason } from '../../button.js';
import { emptyCard, messageFor } from '../../feedback.js';
import { resourceState } from './account-card.js';

/**
 * Validates the base git reference string input.
 * Accepts standard git branch names, commit hashes, or HEAD references.
 */
export function validateBaseRefInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return '请输入起始分支或提交。';
  }
  if (trimmed.length > 300) {
    return '起始分支名称或提交不能超过 300 个字符。';
  }
  return null;
}

/**
 * Renders an accessible workspace status badge with semantic variant styling.
 */
function renderWorkspaceBadge(state: string): HTMLElement {
  const localized = resourceState(state);
  if (state === 'active') {
    return badge([pulseDot(), ` ${localized}`], 'success');
  }
  if (state === 'merged') {
    return badge(localized, 'neutral');
  }
  return badge(localized, 'attention');
}

/**
 * Renders an individual workspace directory card (.resource-card).
 * Displays Git worktree details, associated branch, and active task bindings.
 */
function renderWorkspaceCard(
  ctx: RenderContext,
  workspace: UiSnapshot['resources']['workspaces'][number]
): HTMLElement {
  const statusBadge = renderWorkspaceBadge(workspace.state);

  const card = el('article', 'resource-card workspace-card',
    el('div', 'section-toolbar',
      el('h4', '', workspace.workspaceId),
      statusBadge
    ),
    kv([
      ['源仓库', workspace.repositoryPath],
      ['执行目录', workspace.worktreePath],
      ['专属分支', workspace.branch],
      ['起始提交', workspace.baseCommit],
      ['占用任务', workspace.activeTaskId ?? '无已知占用']
    ])
  );

  if (workspace.activeTaskId) {
    card.append(
      button(ctx, `查看占用任务 ${workspace.activeTaskId}`, 'task.select', {
        taskId: workspace.activeTaskId
      })
    );
  }

  return card;
}

/**
 * Renders the Workspace Directory Management section.
 * Allows developers to create isolated git worktree environments for tasks.
 */
export function renderWorkspaceSection(ctx: RenderContext, snapshot: UiSnapshot): HTMLElement {
  const baseRefInput = input(ctx.state.baseRef, 'baseRef');
  baseRefInput.placeholder = '例如 HEAD、main 或 commit SHA';

  const validationError = ctx.state.validation.baseRef ?? validateBaseRefInput(ctx.state.baseRef);
  const createReason = mutationReason(snapshot, 'createWorkspace') ?? validationError;

  const form = el('div', 'workspace-create-form',
    field(
      '起始分支或提交',
      baseRefInput,
      '如 HEAD、main 或提交 ID；点击按钮后选择源仓库。',
      ctx.state.validation.baseRef
    ),
    actionWithReason(
      ctx,
      '选择仓库并创建任务目录',
      'workspace.create',
      {},
      createReason,
      true
    )
  );

  const sec = section(
    '任务目录',
    el('p', 'field-hint', '从干净的 Git 仓库创建独立任务目录与新分支，供任务在其中修改和核验代码。'),
    form,
    messageFor(ctx, 'workspace.create')
  );

  if (!snapshot.resources.workspaces.length) {
    sec.append(emptyCard(
      '尚无任务目录',
      '从源仓库创建任务目录后，即可提交任务。',
      { icon: 'branch', hint: '每个任务目录拥有独立 Git worktree 与专属分支。' }
    ));
  } else {
    for (const workspace of snapshot.resources.workspaces) {
      sec.append(renderWorkspaceCard(ctx, workspace));
    }
  }

  return sec;
}
