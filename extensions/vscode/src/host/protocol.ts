import { z } from 'zod';
const id = z.string().min(1).max(150).refine(value=>!value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const empty = z.object({}).strict();
export const draftSchema = z.object({
  workspaceId: z.string().max(150), workerId: z.string().max(150), prompt: z.string().max(100_000),
  session: z.enum(['continue', 'new']), mode: z.enum(['build', 'edit', 'plan', 'yolo', 'guarded']),
  modelId: z.string().min(1).max(200), busyRetryLimit: z.number().int().min(0).max(10),
  verifyCommands: z.array(z.object({ command: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(100), timeoutMs: z.number().int().min(100).max(300_000) }).strict()).max(10),
  submitToken: id,
}).strict();
const task = z.object({ taskId: id }).strict();
const page = z.object({ taskId: id, cursor: z.number().int().nonnegative().optional() }).strict();
export const requestPayloads = {
  ready: empty, connect: empty, disconnect: empty, refresh: empty,
  'connection.configure': empty, 'daemon.start': empty,
  'connection.codexSetup': empty,
  'pool.policy.set':z.object({maxConcurrentTasks:z.number().int().min(0).max(64).nullable()}).strict(),
  'tasks.list': z.object({ filter: z.object({ repositoryId:id.optional(),workspaceId:id.optional(),workerId:id.optional(),statuses:z.array(z.enum(['queued','dispatching','running','waiting_approval','verifying','succeeded','failed','cancelled','blocked','interrupted'])).max(10).optional(),leaseHeld:z.boolean().optional(),query:z.string().max(200).optional() }).strict().optional(),cursor:z.string().max(2048).optional() }).strict(), 'task.select': task,
  'draft.change': z.object({ draft: draftSchema }).strict(),
  dispatch: z.object({ submitToken: id }).strict(),
  'dispatch.lookup': z.object({ requestId: id }).strict(),
  cancel: task, reconcile: task, resume: task,
  'events.read': page,
  'patch.read': z.object({ taskId: id, offset: z.number().int().nonnegative().optional() }).strict(),
  'approvals.list': z.object({ taskId: id, cursor: z.string().max(2048).optional() }).strict(),
  'approval.open': z.object({ taskId: id, approvalId: id }).strict(),
  'approval.read': z.object({ taskId: id, approvalId: id, reviewId: id }).strict(),
  'approval.respond': z.object({ taskId: id, approvalId: id, reviewId: id, contentSha256: hash, approvalRevision: z.string().min(1).max(200), nativeRevision: z.number().int().nonnegative(), decision: z.enum(['accept', 'decline', 'cancel']) }).strict(),
  'resources.refresh': empty, 'accounts.import': empty,
  'workspace.create': z.object({ baseRef: z.string().min(1).max(300) }).strict(),
  'worker.start': z.object({ workerId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/), accountAlias: id }).strict(),
  'worker.stop': z.object({ workerId: id }).strict(), 'worker.probe': z.object({ workerId: id }).strict(),
  'quota.read': z.object({ accountAlias: id }).strict(),
  'artifacts.list': z.object({ taskId: id, cursor: z.string().max(2048).optional() }).strict(),
  'diff.open': z.object({ taskId: id, manifestSha256: hash, fileId: id }).strict(),
  'file.current.open': z.object({ taskId: id, manifestSha256: hash, fileId: id }).strict(),
  'artifact.read': z.object({ taskId: id, manifestSha256: hash, fileId: id, side: z.enum(['base', 'final']), offsetBytes: z.number().int().nonnegative().optional() }).strict(),
  'review.set': z.object({ taskId: id, manifestSha256: hash, reviewed: z.boolean() }).strict(),
  'settings.open': empty,
  'settings.save': z.object({ overviewIntervalSeconds: z.number().int().min(15).max(300) }).strict(),
  'diagnostics.copy': empty,
  'guidance.open': z.object({ topic: z.enum(['connection', 'approval', 'workspace', 'recovery']) }).strict(),
};
export type RequestType = keyof typeof requestPayloads;
export type RequestPayload<K extends RequestType> = z.infer<(typeof requestPayloads)[K]>;
export type WebviewRequest = { [K in RequestType]: { v: 1; id: string; generation: number; type: K; payload: RequestPayload<K> } }[RequestType];
const base = z.object({ v: z.literal(1), id: z.string().min(1).max(150), generation: z.number().int().nonnegative(), type: z.string(), payload: z.unknown() }).strict();
export function parseRequest(value: unknown): WebviewRequest {
  if (new TextEncoder().encode(JSON.stringify(value) ?? '').byteLength > 524288) throw new Error('INVALID_MESSAGE');
  const envelope = base.parse(value);
  if (!Object.hasOwn(requestPayloads, envelope.type)) throw new Error('INVALID_MESSAGE');
  const type = envelope.type as RequestType;
  const payload = requestPayloads[type].parse(envelope.payload);
  return { ...envelope, type, payload } as WebviewRequest;
}
