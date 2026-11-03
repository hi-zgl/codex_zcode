import { z } from "zod";

const id = z.string().min(1).max(150);
const text = z.string().max(12_000);
const time = z.number().int().nonnegative();
export const verificationCommandSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  timeout_ms: z.number().int().min(100).max(300_000).default(60_000),
});
export const stageInputSchema = z.object({
  stageId: id,
  title: z.string().min(1).max(300),
  dependsOn: z.array(id).max(30).default([]),
  criteria: z.array(z.string().min(1).max(1000)).max(20).default([]),
});
export const workItemInputSchema = z.object({
  itemId: id,
  stageId: id,
  title: z.string().min(1).max(300),
  prompt: z.string().min(1).max(40_000),
  dependsOn: z.array(id).max(50).default([]),
  workspace: z.enum(["shared", "isolated"]).default("isolated"),
  verifyCommands: z.array(verificationCommandSchema).max(10).default([]),
  mode: z.enum(["build", "edit", "plan", "yolo", "guarded"]).default("build"),
  modelId: id.default("GLM-5.3-Flash"),
});
export const stageConfirmationSchema = z.object({
  summary: text,
  deliveryIds: z.array(id).max(50),
  acceptanceIds: z.array(id).max(50).default([]),
  confirmedAt: time,
});
export const workStageSchema = stageInputSchema.extend({
  confirmation: stageConfirmationSchema.nullable(),
  rework: z.boolean(),
  blockedReason: text.nullable(),
});
export const workItemSchema = workItemInputSchema.extend({
  kind: z.enum(["implementation", "acceptance"]),
  targetDeliveryId: id.nullable(),
  acceptanceId: id.nullable(),
  workspaceId: id.nullable(),
  taskId: id.nullable(),
  handoffTaskId: id.nullable(),
  runIndex: time,
  queueAt: time.nullable(),
  blockedReason: text.nullable(),
  attentionKey: z.string().nullable().default(null),
  cancelled: z.boolean(),
  createdAt: time,
});
export const deliverySchema = z.object({
  deliveryId: id,
  itemId: id,
  taskId: id,
  workspaceId: id,
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: text,
  changedFiles: z.array(text).max(2000),
  createdAt: time,
});
export const acceptanceSchema = z.object({
  acceptanceId: id,
  deliveryId: id,
  executor: z.object({
    kind: z.enum(["external", "zcode"]),
    name: z.string().min(1).max(300),
  }),
  status: z.enum(["running", "passed", "failed"]),
  itemId: id.nullable(),
  workspaceId: id.nullable(),
  workspacePath: z.string().nullable(),
  summary: text,
  evidence: z.array(text).max(50),
  startedAt: time,
  completedAt: time.nullable(),
});
export const workTodoSchema = z.object({
  todoId: id,
  kind: z.enum([
    "resource_shortage",
    "all_accounts_low",
    "blocked",
    "integration_conflict",
    "decision",
  ]),
  summary: text,
  itemIds: z.array(id).max(100),
  availableAccounts: time.nullable(),
  createdAt: time,
});
export const workSchema = z.object({
  workId: id,
  requestId: id,
  commanderId: id,
  controlVersion: time,
  repositoryPath: z.string().min(1),
  goal: text,
  criteria: z.array(z.string().min(1).max(1000)).max(20),
  status: z.enum(["active", "completed", "cancelled"]),
  quotaOverride: z.number().int().min(0).max(64).nullable(),
  partialApproval: z.number().int().min(1).max(64).nullable(),
  stages: z.array(workStageSchema).max(100),
  items: z.array(workItemSchema).max(500),
  deliveries: z.array(deliverySchema).max(2000),
  acceptances: z.array(acceptanceSchema).max(1000),
  todos: z.array(workTodoSchema).max(100),
  integratedDeliveryIds: z.array(id).max(2000),
  integrationRevision: z.string().nullable(),
  finalAcceptance: z
    .object({
      revision: z.string(),
      summary: text,
      evidence: z.array(text).max(50),
      acceptedAt: time,
    })
    .nullable(),
  next: text,
  revision: time,
  createdAt: time,
  updatedAt: time,
});
export type Work = z.infer<typeof workSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type WorkStage = z.infer<typeof workStageSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export type Acceptance = z.infer<typeof acceptanceSchema>;
export type WorkTodo = z.infer<typeof workTodoSchema>;
export type WorkItemInput = z.infer<typeof workItemInputSchema>;
export const commanderSchema = z.object({
  commanderId: id,
  label: z.string().max(300),
  defaultQuota: z.number().int().min(0).max(64),
  lastGrantedAt: time,
});
export type Commander = z.infer<typeof commanderSchema>;
export const executionFactsSchema = z.object({
  taskId: id,
  waitingSince: time.nullable(),
  retryAt: time.nullable(),
  lastVisibleActivityAt: time,
  lastObservedAt: time.nullable(),
  executionCommandId: id.nullable(),
  nativeErrorsComplete: z.boolean().nullable(),
  nativeErrorsReason: z.string(),
  observation: z.enum([
    "executing",
    "silent",
    "unknown",
    "stopped",
    "recovering",
  ]),
  errorCount: time,
  recoveredAt: time.nullable(),
});
export type ExecutionFacts = z.infer<typeof executionFactsSchema>;
export const workItemViewSchema = workItemSchema
  .omit({ prompt: true })
  .extend({
    status: z.string(),
    accountAlias: id.nullable(),
    workerId: id.nullable(),
    execution: executionFactsSchema.nullable(),
  });
export const workViewSchema = workSchema
  .omit({ items: true })
  .extend({
    requestedAccounts: time,
    effectiveAccounts: time,
    items: z.array(workItemViewSchema),
    stages: z.array(
      workStageSchema.extend({
        status: z.enum([
          "not_started",
          "running",
          "blocked",
          "rework",
          "completed",
        ]),
        accountAliases: z.array(id),
      }),
    ),
  });
export type WorkView = z.infer<typeof workViewSchema>;
export const errorRecordSchema = z.object({
  errorId: time,
  taskId: id,
  workId: id.nullable(),
  accountAlias: id.nullable(),
  category: z.string(),
  commandId: id,
  occurrenceKey: z.string(),
  occurredAt: time,
  recoveredAt: time.nullable(),
  summary: text,
});
export const errorStatsSchema = z.object({
  total: time,
  categories: z.record(time),
  events: z.array(errorRecordSchema).max(100),
  complete: z.boolean().nullable(),
  incompleteTaskCount: time,
});
export type ErrorStats = z.infer<typeof errorStatsSchema>;
export const submitWorkSchema = z
  .object({
    request_id: id,
    commander_id: id,
    repository: z.string().min(1),
    goal: z.string().min(1).max(12_000),
    criteria: z.array(z.string().min(1).max(1000)).min(1).max(20),
    stages: z.array(stageInputSchema).min(1).max(100),
    items: z.array(workItemInputSchema).max(100).default([]),
    accounts: z.number().int().min(0).max(64).optional(),
    next: text.default(""),
  })
  .strict();
export const advanceWorkSchema = z
  .object({
    request_id: id,
    work_id: id,
    commander_id: id,
    control_version: time,
    takeover: z.boolean().default(false),
    user_requested_takeover: z.boolean().default(false),
    add_items: z.array(workItemInputSchema).max(100).default([]),
    add_stages: z.array(stageInputSchema).max(30).default([]),
    confirm_stages: z
      .array(
        z.object({
          stage_id: id,
          summary: text,
          delivery_ids: z.array(id).max(50),
          acceptance_ids: z.array(id).max(50).default([]),
        }),
      )
      .max(30)
      .default([]),
    rework_stages: z
      .array(z.object({ stage_id: id, reason: z.string().min(1).max(3000) }))
      .max(30)
      .default([]),
    start_acceptance: z
      .array(
        z.object({
          acceptance_id: id,
          delivery_id: id,
          executor: z.enum(["external", "zcode"]),
          name: z.string().min(1).max(300),
          item: workItemInputSchema.optional(),
        }),
      )
      .max(30)
      .default([]),
    acceptance_results: z
      .array(
        z.object({
          acceptance_id: id,
          status: z.enum(["passed", "failed"]),
          summary: text,
          evidence: z.array(text).max(50).default([]),
        }),
      )
      .max(30)
      .default([]),
    allow_partial_accounts: z.number().int().min(1).max(64).optional(),
    user_confirmed_partial: z.boolean().default(false),
    resolve_todos: z.array(id).max(50).default([]),
    block_items: z
      .array(z.object({ item_id: id, reason: text.nullable() }))
      .max(50)
      .default([]),
    integrate_delivery_ids: z.array(id).max(50).default([]),
    final_acceptance: z
      .object({
        revision: z.string().min(1),
        summary: text,
        evidence: z.array(text).max(50).default([]),
      })
      .optional(),
    approval_responses: z
      .array(
        z.object({
          task_id: id,
          approval_id: id,
          decision: z.enum(["accept", "decline", "cancel"]),
        }),
      )
      .max(30)
      .default([]),
    cancel_items: z.array(id).max(50).default([]),
    complete: z.boolean().default(false),
    cancel: z.boolean().default(false),
    next: text.optional(),
  })
  .strict();
export type SubmitWorkInput = z.infer<typeof submitWorkSchema>;
export type AdvanceWorkInput = z.infer<typeof advanceWorkSchema>;
