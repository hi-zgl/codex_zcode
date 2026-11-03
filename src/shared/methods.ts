import { z } from "zod";
import { MAX_POOL_CONCURRENT_TASKS } from "./pool-policy.js";
import { submitWorkSchema, advanceWorkSchema } from "./work-contract.js";
export { MAX_POOL_CONCURRENT_TASKS } from "./pool-policy.js";
const id = z.string().min(1).max(150);
const poolLimit = z
  .number()
  .int()
  .min(0)
  .max(MAX_POOL_CONCURRENT_TASKS)
  .nullable();
const executionSettings = {
  retryIntervalMs: z.number().int().min(1000).max(86_400_000),
  recoveryWaitMs: z.number().int().min(1000).max(86_400_000),
  silenceCheckMs: z.number().int().min(1000).max(86_400_000),
  lowQuotaThresholdPercent: z.number().min(0).max(100),
  defaultCommanderQuota: z.number().int().min(0).max(64),
};
const poolUpdate = z
  .object({
    max_concurrent_tasks: poolLimit.optional(),
    retry_interval_ms: executionSettings.retryIntervalMs.optional(),
    recovery_wait_ms: executionSettings.recoveryWaitMs.optional(),
    silence_check_ms: executionSettings.silenceCheckMs.optional(),
    low_quota_threshold_percent:
      executionSettings.lowQuotaThresholdPercent.optional(),
    default_commander_quota: executionSettings.defaultCommanderQuota.optional(),
  })
  .strict();
export const poolPolicySchema = z.object({
  maxConcurrentTasks: poolLimit,
  occupiedSlots: z.number().int().nonnegative().safe(),
  availableSlots: z.number().int().nonnegative().safe().nullable(),
  ...executionSettings,
});
export const methods = {
  daemon_start: {
    description:
      "Explicitly start the selected pool daemon without starting Workers. Status reads never start a stopped daemon.",
    schema: z.object({}),
  },
  shutdown_pool: {
    description:
      "Finish work: refuse if any task still holds a lease, stop Workers, then shut down the daemon. Keeps accounts and task data; never cancels tasks.",
    schema: z.object({}),
  },
  daemon_stop: {
    description:
      "Stop this daemon gracefully without stopping official workers.",
    schema: z.object({}),
  },
  overview: {
    description:
      "List local account aliases, worker states and compact task summaries.",
    schema: z.object({}),
  },
  get_pool_policy: {
    description:
      "Read the persisted pool concurrency policy and held task slots. Occupancy includes approvals, verification and uncertain execution.",
    schema: z.object({}).strict(),
  },
  set_pool_policy: {
    description:
      "Set only explicitly requested pool settings. Zero concurrency pauses new dispatches; running work continues. Retry totals are statistics, never a limit.",
    schema: poolUpdate,
  },
  pool_control: {
    description:
      "Read or explicitly start the shared pool, batch user resource settings or finish the pool. Global concurrency changes require an explicit user instruction. Shutdown refuses active/uncertain tasks; reads never restart a stopped pool.",
    schema: z
      .object({
        action: z
          .enum(["read", "start", "configure", "shutdown"])
          .default("read"),
        policy: poolUpdate.optional(),
        user_requested_pool_change: z.boolean().default(false),
        commanders: z
          .array(
            z.object({
              commander_id: id,
              default_quota: z.number().int().min(0).max(64),
            }),
          )
          .max(50)
          .default([]),
        accounts: z
          .array(z.object({ account_id: id, enabled: z.boolean() }))
          .max(100)
          .default([]),
      })
      .strict(),
  },
  inspect: {
    description:
      "Read details only when needed: continuation overview or paged work sections (stages/items/deliveries/acceptances/todos), immutable task result, bounded logs or saved diff. Follow nextCursor for older references.",
    schema: z
      .object({
        kind: z.enum(["work", "result", "logs", "diff"]),
        section: z
          .enum([
            "overview",
            "stages",
            "items",
            "deliveries",
            "acceptances",
            "todos",
          ])
          .default("overview"),
        work_id: id.optional(),
        task_id: id.optional(),
        cursor: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(8000).optional(),
      })
      .strict(),
  },
  submit_work: {
    description:
      "Hand over a goal, observable criteria, stages and the explicitly authorized first batch. Automatically prepares directories and shared accounts. Missing resources require user confirmation before partial dispatch. ZCode instances cannot delegate subagents.",
    schema: submitWorkSchema,
  },
  wait_work: {
    description:
      "Wait for key changes or decisions; ordinary retries do not wake the commander. Pass the previous revision. Defaults to 45 seconds and returns only a cursor on unchanged timeout. Longer waits up to 300 seconds require host support; repeat bounded waits when there is no notification capability.",
    schema: z
      .object({
        work_id: id,
        commander_id: id,
        after_revision: z.number().int().nonnegative().optional(),
        timeout_sec: z.number().min(0).max(300).default(45),
      })
      .strict(),
  },
  advance_work: {
    description:
      "Record semantic decisions and advance in one call: start/finish fixed-version acceptance, confirm/reopen stages, integrate deliveries, assign the next batch or finish. Execution success never confirms a stage. Takeover needs an explicit user request.",
    schema: advanceWorkSchema,
  },
  get_work: {
    description:
      "Read the current compact plan, saved delivery references, decisions and next step for continuation or takeover.",
    schema: z.object({ work_id: id }).strict(),
  },
  set_commander_quota: {
    description:
      "Persist a commander default quota without interrupting current work. A work-specific account request temporarily overrides this default.",
    schema: z
      .object({
        commander_id: id,
        default_quota: z.number().int().min(0).max(64),
      })
      .strict(),
  },
  set_account_enabled: {
    description:
      "Enable or disable an account for future dispatches; active execution continues.",
    schema: z.object({ account_id: id, enabled: z.boolean() }).strict(),
  },
  resolve_work_todo: {
    description:
      "Apply an explicit user decision to a pending item. Confirming fewer accounts requires user_confirmed true and the available account count.",
    schema: z
      .object({
        work_id: id,
        todo_id: id,
        action: z.enum(["approve_partial", "retry", "resolve"]),
        available_accounts: z.number().int().min(1).max(64).optional(),
        user_confirmed: z.literal(true),
      })
      .strict(),
  },
  import_accounts: {
    description:
      "Import local account export files into the encrypted local vault.",
    schema: z.object({ files: z.array(z.string().min(1)).min(1).max(100) }),
  },
  start_worker: {
    description: "Start an isolated official ZCode Server for one account.",
    schema: z.object({ worker_id: id, account_id: id }),
  },
  stop_worker: {
    description:
      "Stop an owned worker only when no active or uncertain task holds it.",
    schema: z.object({ worker_id: id }),
  },
  probe_worker: {
    description:
      "Read authenticated version/protocol status without starting a model turn.",
    schema: z.object({ worker_id: id }),
  },
  create_workspace: {
    description:
      "Create a dedicated git branch and worktree from a clean repository.",
    schema: z.object({
      repository: z.string().min(1),
      base_ref: z.string().min(1),
    }),
  },
  dispatch_task: {
    description:
      "Advanced explicit-worker dispatch. Prefer submit_work for automatic account/workspace management. Safe transient failures retry continuously; uncertain commands are never replayed.",
    schema: z.object({
      workspace_id: id,
      worker_id: id,
      prompt: z.string().min(1).max(100_000),
      request_id: id,
      session: z.enum(["continue", "new"]).default("continue"),
      mode: z
        .enum(["build", "edit", "plan", "yolo", "guarded"])
        .default("build"),
      model_id: z.string().min(1).default("GLM-5.3-Flash"),
      verify_commands: z
        .array(
          z.object({
            command: z.string().min(1),
            args: z.array(z.string()).default([]),
            timeout_ms: z.number().int().min(100).max(300_000).default(60_000),
          }),
        )
        .max(10)
        .default([]),
    }),
  },
  wait: {
    description:
      "Wait for persisted task revisions. Completed tasks return immediately. Maximum 25 seconds.",
    schema: z.object({
      task_ids: z.array(id).min(1).max(50),
      after_revision: z
        .union([
          z.number().int().nonnegative(),
          z.record(z.number().int().nonnegative()),
        ])
        .optional(),
      timeout_sec: z.number().min(0).max(25).default(25),
    }),
  },
  get_result: {
    description: "Get compact immutable task results and verification status.",
    schema: z.object({ task_id: id }),
  },
  get_logs: {
    description: "Read a bounded page of persisted, redacted events.",
    schema: z.object({
      task_id: id,
      cursor: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(50).default(10),
    }),
  },
  get_diff: {
    description:
      "Read a bounded page of the task snapshot patch; unavailable before snapshot.",
    schema: z.object({
      task_id: id,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(8000).default(4000),
    }),
  },
  reconcile_task: {
    description:
      "Inspect an uncertain task against a fresh native session snapshot. Never resends. Releases occupancy only when that exact turn is terminal and no native active work remains.",
    schema: z.object({ task_id: id }),
  },
  resume_task: {
    description:
      "Restore observation of the current native attempt. Confirmed model-busy failures may use the remaining same-session continuations; uncertain sends and interrupted verification are never replayed.",
    schema: z.object({ task_id: id }),
  },
  cancel_task: {
    description:
      "Request cancellation; occupancy remains until termination is observed.",
    schema: z.object({ task_id: id }),
  },
  respond_approval: {
    description: "Respond to a pending native approval in the executing task.",
    schema: z.object({
      task_id: id,
      approval_id: id,
      decision: z.enum(["accept", "decline", "cancel"]),
    }),
  },
} satisfies Record<string, { description: string; schema: z.ZodTypeAny }>;
export type MethodName = keyof typeof methods;
export function validateMethod(
  method: string,
  params: unknown,
): { name: MethodName; params: any } {
  if (!Object.hasOwn(methods, method)) throw new Error("Unknown method");
  const name = method as MethodName;
  const parsed = methods[name].schema.safeParse(params);
  if (!parsed.success)
    throw new Error(
      `Invalid parameters: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  return { name, params: parsed.data };
}
