import type { RequestPayload } from '../host/protocol.js';
import type { TaskDraft } from '../host/types.js';
import type { UiApprovalReview, UiArtifactFile, UiRpcResult } from '../../../../src/shared/ui-contract.js';
import { BridgeError } from './bridge.js';
import type { ArtifactChunk, LocalState, ReviewContent } from './state.js';

export interface Frame {
  readonly focus: string | undefined;
  readonly selection: readonly [number | null, number | null] | null;
  readonly scroll: ReadonlyMap<string, number>;
  readonly details: ReadonlyMap<string, boolean>;
}

export interface FormUpdateCallbacks {
  readonly render: () => void;
  readonly scheduleDraft: () => void;
  readonly triggerFilter: (debounced: boolean) => void;
}

export function captureFrame(root: HTMLElement): Frame {
  const active = document.activeElement as HTMLInputElement | null;
  const selection = active && (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && ['text', 'search'].includes(active.type)))
    ? ([active.selectionStart, active.selectionEnd] as const)
    : null;
  return {
    focus: active?.dataset.focus,
    selection,
    scroll: new Map(Array.from(root.querySelectorAll<HTMLElement>('[data-scroll]')).map(node => [node.dataset.scroll!, node.scrollTop])),
    details: new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>('[data-details]')).map(node => [node.dataset.details!, node.open]))
  };
}

export function restoreFrame(root: HTMLElement, frame: Frame, focusAfterRender: string | null): void {
  for (const node of Array.from(root.querySelectorAll<HTMLElement>('[data-scroll]'))) {
    node.scrollTop = frame.scroll.get(node.dataset.scroll!) ?? 0;
  }
  for (const node of Array.from(root.querySelectorAll<HTMLDetailsElement>('[data-details]'))) {
    node.open = frame.details.get(node.dataset.details!) ?? false;
  }
  if (frame.focus) {
    const target = Array.from(root.querySelectorAll<HTMLElement>('[data-focus]')).find(node => node.dataset.focus === frame.focus);
    if (target && !('disabled' in target && target.disabled)) {
      target.focus({ preventScroll: true });
      if (frame.selection && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
        target.setSelectionRange(frame.selection[0], frame.selection[1]);
      }
    }
  }
  if (focusAfterRender) {
    root.querySelector<HTMLElement>(focusAfterRender)?.focus();
  }
}

export function updateInput(state: LocalState, event: Event, changed: boolean, callbacks: FormUpdateCallbacks): void {
  const target = event.target as HTMLInputElement;
  if (!target || !('value' in target)) return;
  const filter = target.dataset.filter;
  if (filter && Object.hasOwn(state.filters, filter)) {
    if (filter === 'project') state.projectDefaultApplied = true;
    state.filters[filter as keyof typeof state.filters] = target.value;
    callbacks.render();
    callbacks.triggerFilter(filter === 'query' && !changed);
    return;
  }
  const key = target.dataset.field;
  if (!key) return;
  if (key.startsWith('draft.') && state.draft) {
    const field = key.slice(6) as keyof TaskDraft;
    if (field === 'busyRetryLimit') state.draft.busyRetryLimit = Number(target.value);
    else if (field === 'workspaceId') state.draft.workspaceId = target.value;
    else if (field === 'workerId') state.draft.workerId = target.value;
    else if (field === 'prompt') state.draft.prompt = target.value;
    else if (field === 'session' && (target.value === 'continue' || target.value === 'new')) state.draft.session = target.value;
    else if (field === 'mode' && ['build', 'edit', 'plan', 'yolo', 'guarded'].includes(target.value)) state.draft.mode = target.value as TaskDraft['mode'];
    else if (field === 'modelId') state.draft.modelId = target.value;
    state.draftDirty = true;
    delete state.validation[field];
    callbacks.scheduleDraft();
    if (changed || ['workspaceId', 'workerId'].includes(field)) callbacks.render();
    return;
  }
  if (key.startsWith('verify.') && state.draft) {
    const [, indexText, field] = key.split('.');
    const command = state.draft.verifyCommands[Number(indexText)];
    if (!command) return;
    delete state.validation[key];
    if (field === 'command') command.command = target.value;
    if (field === 'timeoutMs') command.timeoutMs = Number(target.value);
    if (field === 'args') {
      state.rawFields.set(key, target.value);
      try {
        const args: unknown = JSON.parse(target.value);
        if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error();
        command.args = args;
      } catch {
        state.validation[key] = '请输入有效的 JSON 字符串数组。';
      }
    }
    state.draftDirty = true;
    callbacks.scheduleDraft();
    if (changed) callbacks.render();
    return;
  }
  if (key === 'settingsConcurrency') state.policyDirty = true;
  if (key === 'workerId') state.workerId = target.value;
  else if (key === 'workerAccount') state.workerAccount = target.value;
  else if (key === 'baseRef') state.baseRef = target.value;
  else if (key === 'settingsInterval') state.settingsInterval = target.value;
  else if (key === 'settingsConcurrency') state.settingsConcurrency = target.value;
  else if (key === 'taskLookup') state.taskLookup = target.value;
  else return;
  delete state.validation[key];
  callbacks.render();
}

export function canFlushDraft(state: LocalState): TaskDraft | null {
  if (!state.draft || !state.draftDirty) return null;
  if (Object.keys(state.validation).some(key => key.endsWith('.args'))) return null;
  const draft = structuredClone(state.draft);
  // Incomplete executable fields remain in this Webview until valid, never silently truncated.
  if (draft.verifyCommands.some(command => !command.command.trim()) || !draft.modelId.trim() || !Number.isInteger(draft.busyRetryLimit) || draft.busyRetryLimit < 0 || draft.busyRetryLimit > 10) {
    return null;
  }
  return draft;
}

export function buildListPayload(state: LocalState): RequestPayload<'tasks.list'> {
  const snapshot = state.snapshot;
  const filters = state.filters;
  const repository = snapshot?.resources.workspaces.find(workspace => workspace.repositoryPath === filters.project);
  const statuses = (
    filters.status === 'active'
      ? ['queued', 'dispatching', 'running', 'waiting_approval', 'verifying']
      : filters.status === 'finished'
      ? ['succeeded', 'failed', 'cancelled', 'blocked', 'interrupted']
      : !['all', 'attention'].includes(filters.status)
      ? [filters.status]
      : undefined
  ) as NonNullable<RequestPayload<'tasks.list'>['filter']>['statuses'];
  return {
    filter: {
      ...(repository ? { repositoryId: repository.workspaceId } : {}),
      ...(filters.workspace ? { workspaceId: filters.workspace } : {}),
      ...(filters.worker ? { workerId: filters.worker } : {}),
      ...(statuses ? { statuses } : {}),
      ...(filters.query.trim() ? { query: filters.query.trim() } : {})
    }
  };
}

export function applyVerifiedApprovalRead(
  taskId: string,
  approvalId: string,
  entry: ReviewContent,
  response: { readonly review: UiApprovalReview; readonly loadedComplete: boolean; readonly text: string }
): void {
  const descriptor = entry.review;
  const review = response.review;
  if (
    review.taskId !== taskId ||
    review.approvalId !== approvalId ||
    review.reviewId !== descriptor.reviewId ||
    review.content?.sha256 !== descriptor.content?.sha256 ||
    review.content?.totalBytes !== descriptor.content?.totalBytes ||
    review.approvalRevision !== descriptor.approvalRevision ||
    review.nativeRevision !== descriptor.nativeRevision ||
    Object.keys(descriptor.owner).some(key => review.owner[key as keyof typeof review.owner] !== descriptor.owner[key as keyof typeof descriptor.owner])
  ) {
    throw new BridgeError({ code: 'INTEGRITY_MISMATCH', message: '审批内容或归属已变化，请重新查看完整操作。' });
  }
  if (entry.locked || entry.review.readOnlyReason || entry.review.state !== 'pending' || entry.review.response.state !== 'none') return;
  entry.review = review;
  entry.text = response.text;
  entry.loadedComplete = response.loadedComplete === true;
}

export function applyApprovalRespondSuccess(
  entry: ReviewContent,
  decision: 'accept' | 'decline',
  response: UiRpcResult<'ui_respond_approval'>['data']
): void {
  entry.review.response = { actionId: response.actionId, decision, state: response.responseState };
  entry.review.state = 'response_pending';
  entry.error =
    response.responseState === 'resolved_unattributed'
      ? '此审批已不再待处理，无法确认采用了哪次答复。'
      : response.responseState === 'confirmed'
      ? null
      : '答复已发送，等待后台确认。任务状态与资源占用继续以后台为准。';
}

export function applyApprovalRespondError(entry: ReviewContent, error: unknown): void {
  if (error instanceof BridgeError && error.detail.code === 'APPROVAL_CHANGED') {
    entry.text = null;
    entry.loadedComplete = false;
    entry.locked = false;
    entry.error = '审批已变化，请重新查看完整操作。';
    entry.review.readOnlyReason = 'APPROVAL_CHANGED';
  } else {
    entry.locked = true;
    entry.error =
      error instanceof BridgeError && error.detail.code === 'APPROVAL_GONE'
        ? '审批已不再待处理或已失效；无法确认由谁、采用何种答复。'
        : '答复结果待确认。请读取当前审批或核对执行状态，不会自动重发。';
  }
}

export function appendArtifactChunk(
  state: LocalState,
  file: UiArtifactFile,
  side: 'base' | 'final',
  manifestSha256: string,
  offsetBytes: number,
  page: ArtifactChunk
): void {
  if (page.fileId !== file.fileId || page.side !== side || page.manifestSha256 !== manifestSha256 || page.offsetBytes !== offsetBytes || page.encoding !== 'utf8') {
    throw new Error('identity');
  }
  if (offsetBytes === 0) {
    state.artifact = { file, side, text: '', loadedBytes: 0, totalBytes: page.totalBytes, nextOffsetBytes: 0, decoder: new TextDecoder('utf-8', { fatal: true }), complete: false, error: null };
  }
  const artifact = state.artifact;
  if (!artifact || artifact.file.fileId !== file.fileId || artifact.side !== side || artifact.loadedBytes !== offsetBytes) return;
  const chunk = Uint8Array.from(atob(page.dataBase64), char => char.charCodeAt(0));
  artifact.text += artifact.decoder.decode(chunk, { stream: page.nextOffsetBytes !== null });
  artifact.loadedBytes += chunk.byteLength;
  artifact.totalBytes = page.totalBytes;
  artifact.nextOffsetBytes = page.nextOffsetBytes;
  artifact.complete = page.nextOffsetBytes === null && artifact.loadedBytes === page.totalBytes;
}
