import { z } from 'zod';
const id = z.string().min(1).max(150);
export const methods = {
  daemon_stop: {description:'Stop this daemon gracefully without stopping official workers.',schema:z.object({})},
  overview: {description:'List local account aliases, worker states and compact task summaries.', schema:z.object({})},
  import_accounts: {description:'Import local account export files into the encrypted local vault.', schema:z.object({files:z.array(z.string().min(1)).min(1).max(100)})},
  start_worker: {description:'Start an isolated official ZCode Server for one account.', schema:z.object({worker_id:id, account_id:id})},
  stop_worker: {description:'Stop an owned worker only when no active or uncertain task holds it.', schema:z.object({worker_id:id})},
  probe_worker: {description:'Read authenticated version/protocol status without starting a model turn.', schema:z.object({worker_id:id})},
  create_workspace: {description:'Create a dedicated git branch and worktree from a clean repository.', schema:z.object({repository:z.string().min(1),base_ref:z.string().min(1)})},
  dispatch_task: {description:'Dispatch once asynchronously to an explicit worker. Unknown execution is never automatically replayed.', schema:z.object({workspace_id:id,worker_id:id,prompt:z.string().min(1).max(100_000),request_id:id,session:z.enum(['continue','new']).default('continue'),mode:z.enum(['build','edit','plan','yolo','guarded']).default('build'),model_id:z.string().min(1).default('GLM-5.3-Flash'),verify_commands:z.array(z.object({command:z.string().min(1),args:z.array(z.string()).default([]),timeout_ms:z.number().int().min(100).max(300_000).default(60_000)})).max(10).default([])})},
  wait: {description:'Wait for persisted task revisions. Completed tasks return immediately. Maximum 25 seconds.', schema:z.object({task_ids:z.array(id).min(1).max(50),after_revision:z.union([z.number().int().nonnegative(),z.record(z.number().int().nonnegative())]).optional(),timeout_sec:z.number().min(0).max(25).default(25)})},
  get_result: {description:'Get compact immutable task results and verification status.',schema:z.object({task_id:id})},
  get_logs: {description:'Read a bounded page of persisted, redacted events.',schema:z.object({task_id:id,cursor:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(50).default(10)})},
  get_diff: {description:'Read a bounded page of the task snapshot patch; unavailable before snapshot.',schema:z.object({task_id:id,offset:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(8000).default(4000)})},
  reconcile_task: {description:'Inspect an uncertain task against a fresh native session snapshot. Never resends. Releases occupancy only when that exact turn is terminal and no native active work remains.',schema:z.object({task_id:id})},
  cancel_task: {description:'Request cancellation; occupancy remains until termination is observed.',schema:z.object({task_id:id})},
  respond_approval: {description:'Respond to a pending native approval in the executing task.',schema:z.object({task_id:id,approval_id:id,decision:z.enum(['accept','decline','cancel'])})},
} satisfies Record<string, {description:string;schema:z.ZodTypeAny}>;
export type MethodName = keyof typeof methods;
export function validateMethod(method:string, params:unknown): {name:MethodName;params:any} {
  if (!Object.hasOwn(methods,method)) throw new Error('Unknown method');
  const name = method as MethodName;
  const parsed = methods[name].schema.safeParse(params);
  if (!parsed.success) throw new Error(`Invalid parameters: ${parsed.error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return {name,params:parsed.data};
}
