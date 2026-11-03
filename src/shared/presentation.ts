/**
 * Deterministic MCP views. Never serialize a daemon/native object directly here.
 * Text budgets count the final JSON in UTF-8, including escaping and notices.
 */
export const MCP_MAX_TEXT_BYTES = 16 * 1024;
export const MCP_COMPACT_TARGET_BYTES = 6 * 1024;
const MAX_CONTROL_BYTES = 2048;

export const MCP_PRESENTED_METHODS = new Set([
  "submit_work",
  "wait_work",
  "advance_work",
  "inspect",
  "pool_control",
  "daemon_start",
  "shutdown_pool",
  "overview",
  "get_pool_policy",
  "set_pool_policy",
  "start_worker",
  "stop_worker",
  "probe_worker",
  "create_workspace",
  "dispatch_task",
  "wait",
  "get_result",
  "get_logs",
  "get_diff",
  "reconcile_task",
  "resume_task",
  "cancel_task",
  "respond_approval",
]);

type Row = Record<string, unknown>;
export interface PresentedText {
  text: string;
  isError?: true;
}
class ControlBudgetError extends Error {}
function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** Defense in depth for the few human-readable fields permitted by the views. */
export function redactPresentationText(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("utf8")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(
      /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted JWT]",
    )
    .replace(
      /((?:["']?)(?:access[_-]?token|refresh[_-]?token|zcode[_-]?jwt[_-]?token|api[_-]?key|authorization|password|secret|cookie|ingressToken)(?:["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/gi,
      "$1[redacted]",
    );
}

/** No split UTF-8 sequence or surrogate pair, including for Chinese and emoji. */
export function utf8Prefix(value: string, maxBytes: number): string {
  let used = 0;
  let end = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character);
    if (used + size > maxBytes) break;
    used += size;
    end += character.length;
  }
  return value.slice(0, end);
}
function text(value: unknown, maxBytes = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = redactPresentationText(value);
  return Buffer.byteLength(cleaned) <= maxBytes
    ? cleaned
    : `${utf8Prefix(cleaned, maxBytes - 3)}…`;
}
function control(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  // Identifiers are never shortened: a changed ID is unsafe to use as a control.
  if (Buffer.byteLength(value) > MAX_CONTROL_BYTES)
    throw new ControlBudgetError("Identifier exceeds the presentation budget");
  return value;
}
function fields(
  source: Row,
  names: readonly string[],
  kind: "control" | "text" | "number" | "boolean" = "control",
): Row {
  const result: Row = {};
  for (const key of names) {
    const value =
      kind === "control"
        ? control(source[key])
        : kind === "text"
          ? text(source[key])
          : kind === "number"
            ? number(source[key])
            : boolean(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}
function logAction(taskId: unknown, cursor: unknown = 0): Row {
  return {
    tool: "zcode_inspect",
    arguments: {
      kind: "logs",
      task_id: control(taskId),
      cursor: integer(cursor) ?? 0,
      limit: 1,
    },
  };
}
function busyRetry(value: unknown): Row | undefined {
  const source = object(value);
  const used = integer(source.used);
  if (
    used === undefined ||
    (source.reason !== "model_busy" && source.reason !== "transient_fault")
  )
    return undefined;
  return { used, max: null, reason: source.reason };
}

function approval(
  value: unknown,
  taskId?: unknown,
  fallbackCursor?: unknown,
): Row | undefined {
  const source = object(value);
  const native = object(source.detail);
  const payload = object(source.payload ?? native.payload);
  const approvalId = control(
    source.approvalId ??
      source.interactionId ??
      native.approvalId ??
      native.interactionId,
  );
  if (!approvalId) return undefined;
  const summary = text(source.summary ?? payload.summary, 384);
  const originalSummary = source.summary ?? payload.summary;
  const cursor =
    integer(source.approvalLogCursor) ?? integer(fallbackCursor) ?? 0;
  return {
    approvalId,
    kind: text(source.kind ?? native.kind ?? payload.kind, 80),
    toolName: text(source.toolName ?? payload.toolName, 80),
    ...(summary ? { summary } : {}),
    ...(source.truncated === true ||
    (typeof originalSummary === "string" &&
      summary !== redactPresentationText(originalSummary))
      ? { truncated: true }
      : {}),
    reviewComplete: false,
    ...(taskId ? { review: logAction(taskId, cursor) } : {}),
    reviewHint:
      "Use the referenced log event to inspect the requested operation. The summary alone does not show all arguments.",
  };
}

function task(value: unknown, brief = false): Row {
  const source = object(value);
  const detail = object(source.detail);
  const taskId = control(source.taskId);
  const retry = busyRetry(source.retry ?? detail.retry);
  const projected: Row = {
    ...fields(source, [
      "taskId",
      ...(brief ? [] : ["workspaceId", "workerId"]),
    ]),
    ...fields(source, ["status"], "text"),
    ...fields(source, ["revision"], "number"),
    ...fields(source, ["leaseHeld", "executionStopped"], "boolean"),
    ...(retry ? { retry } : {}),
  };
  const pendingCount = integer(
    source.pendingApprovalCount ?? detail.pendingApprovalCount,
  );
  if (pendingCount !== undefined) projected.pendingApprovalCount = pendingCount;
  for (const key of [
    "pendingApprovalsTruncated",
    "approvalResponsePending",
    "awaitingNativeRevision",
  ]) {
    const value = boolean(source[key] ?? detail[key]);
    if (value !== undefined) projected[key] = value;
  }
  // Polling views intentionally omit assistant text, tool arguments and session history.
  const safeDetail = {
    ...(detail.decision !== undefined ? fields(detail, ["approvalId"]) : {}),
    ...fields(
      detail,
      ["category", "nativeState", "nativeTurnState", "decision"],
      "text",
    ),
    ...fields(
      detail,
      ["executionUncertain", "requiresInspection", "truncated"],
      "boolean",
    ),
    ...(retry
      ? detail.reason === "model_busy"
        ? { reason: "model_busy" }
        : {}
      : text(detail.reason, 160)
        ? { reason: text(detail.reason, 160) }
        : {}),
  };
  if (Object.keys(safeDetail).length) projected.detail = safeDetail;
  if (typeof detail.message === "string" || typeof detail.error === "string")
    projected.diagnostic = diagnostic(detail);
  if (retry && detail.requiresInspection === true) {
    if (
      !projected.diagnostic ||
      object(projected.diagnostic).code === "REQUEST_FAILED"
    ) {
      projected.diagnostic = {
        code: "RECOVERY_REQUIRED",
        message: ERROR_MESSAGES.RECOVERY_REQUIRED,
      };
    }
    projected.nextAction =
      "Inspect local task records and native session state before resuming. Do not dispatch the task again.";
  }
  const pending = array(source.pendingApprovals ?? detail.pendingApprovals);
  const one =
    detail.decision === undefined
      ? approval(detail, taskId, detail.approvalLogCursor)
      : undefined;
  const approvals = pending
    .map((entry) => approval(entry, taskId, detail.approvalLogCursor))
    .filter(Boolean);
  if (one && !approvals.some((entry) => entry?.approvalId === one.approvalId))
    approvals.unshift(one);
  if (approvals.length) projected.pendingApprovals = approvals;
  if (detail.truncated === true && !approvals.length) {
    projected.detailReview = logAction(taskId, detail.approvalLogCursor);
  }
  return projected;
}

function account(value: unknown): Row {
  const source = object(value);
  const quota = object(source.quota);
  return {
    ...fields(source, ["alias"]),
    ...fields(source, ["provider", "health", "plan"], "text"),
    ...(Object.keys(quota).length
      ? {
          quota: {
            source: "imported",
            freshness: "stale",
            observedAtMs: null,
            unit: "unknown",
            ...fields(quota, ["total", "used", "remaining"], "number"),
            ...(number(quota.updatedAt) !== undefined
              ? {
                  updatedAt: {
                    value: number(quota.updatedAt),
                    unit: "unknown",
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}
function worker(value: unknown): Row {
  const source = object(value);
  return {
    ...fields(source, ["workerId", "accountAlias"]),
    ...fields(source, ["state", "version"], "text"),
    ...fields(source, ["runningTaskCount"], "number"),
    ...fields(source, ["processOwned", "stopped"], "boolean"),
  };
}
function workspace(value: unknown, full = false): Row {
  const source = object(value);
  return {
    ...fields(source, [
      "workspaceId",
      "activeTaskId",
      "branch",
      ...(full ? ["repositoryPath", "worktreePath", "baseCommit"] : []),
    ]),
    ...fields(source, ["state"], "text"),
  };
}

function poolPolicy(value: unknown): Row {
  const source = object(value);
  return {
    maxConcurrentTasks:
      source.maxConcurrentTasks === null
        ? null
        : integer(source.maxConcurrentTasks),
    occupiedSlots: integer(source.occupiedSlots),
    availableSlots:
      source.availableSlots === null ? null : integer(source.availableSlots),
    ...fields(
      source,
      [
        "retryIntervalMs",
        "recoveryWaitMs",
        "silenceCheckMs",
        "lowQuotaThresholdPercent",
        "defaultCommanderQuota",
      ],
      "number",
    ),
  };
}

function overview(value: unknown): Row {
  const source = object(value);
  const result: Row = source.poolPolicy
    ? { poolPolicy: poolPolicy(source.poolPolicy) }
    : {};
  const omitted: Row = {};
  const collections = [
    ["accounts", 8, account],
    ["workers", 8, worker],
    ["workspaces", 5, (entry: unknown) => workspace(entry)],
    ["tasks", 10, (entry: unknown) => task(entry, true)],
  ] as const;
  for (const [key, limit, project] of collections) {
    const entries = array(source[key]);
    const selected =
      key === "tasks" ? entries.slice(-limit) : entries.slice(0, limit);
    result[key] = selected.map(project);
    if (entries.length > selected.length)
      omitted[key] = entries.length - selected.length;
  }
  // Busy pools remain compact. Removed rows are reported rather than hidden.
  while (bytes(result) > MCP_COMPACT_TARGET_BYTES - 512) {
    const key = ["tasks", "workspaces", "workers", "accounts"].find(
      (key) => array(result[key]).length > 1,
    );
    if (!key) break;
    if (key === "tasks") array(result[key]).shift();
    else array(result[key]).pop();
    omitted[key] = ((omitted[key] as number) ?? 0) + 1;
  }
  if (Object.keys(omitted).length) {
    result.omitted = omitted;
    result.nextAction =
      "Use inspect for known work/task IDs; the local CLI overview lists omitted pool rows.";
  }
  return result;
}

function result(value: unknown): Row | null {
  if (value === null || value === undefined) return null;
  const source = object(value);
  const files = array(source.changedFiles);
  const checks = array(source.verification);
  const blockers = array(source.blockers);
  const artifacts = array(source.artifacts);
  return {
    ...fields(source, ["taskId"]),
    summary: text(source.summary, 768) ?? "",
    changedFileCount: files.length,
    changedFiles: files
      .slice(0, 5)
      .map((entry) => text(entry, 192))
      .filter((entry) => entry !== undefined),
    verificationCount: checks.length,
    verification: checks.slice(0, 10).map((entry, index) => ({
      index,
      exitCode:
        object(entry).exitCode === null ? null : number(object(entry).exitCode),
    })),
    blockers: blockers
      .slice(0, 3)
      .map((entry) => text(entry, 256))
      .filter((entry) => entry !== undefined),
    artifactCount: artifacts.length,
    patchAvailable: artifacts.some((entry) => object(entry).kind === "patch"),
    ...(files.length > 5 || checks.length > 10 || blockers.length > 3
      ? {
          omitted: {
            changedFiles: Math.max(0, files.length - 5),
            verification: Math.max(0, checks.length - 10),
            blockers: Math.max(0, blockers.length - 3),
          },
          nextAction:
            "Use inspect with kind diff for the saved patch; local artifacts contain full checks and blockers.",
        }
      : {}),
    ...(typeof source.summary === "string" &&
    text(source.summary, 768) !== redactPresentationText(source.summary)
      ? {
          summaryTruncated: true,
          nextAction:
            "Use inspect with kind diff or local artifacts for full delivery details.",
        }
      : {}),
  };
}

function probe(value: unknown): Row {
  const source = object(value);
  const info = object(source.info);
  const quota = object(source.quota);
  const remaining = object(quota.remaining);
  return {
    info: {
      ...fields(info, ["adapterId", "version"], "text"),
      ...fields(
        info,
        ["protocolVersion", "conversationProtocolVersion"],
        "number",
      ),
      ...fields(
        info,
        ["authRequired", "authenticated", "supported"],
        "boolean",
      ),
    },
    quota: {
      ...fields(quota, ["authenticated"], "boolean"),
      ...fields(quota, ["generatedAt", "serverTime"], "number"),
      // In particular, the native provider/subscription/context objects stay local.
      remaining: fields(
        remaining,
        ["count", "percentage", "nextResetTime"],
        "number",
      ),
    },
  };
}

const REVIEW_TEXT_FIELDS = [
  "file_path",
  "path",
  "cwd",
  "command",
  "old_string",
  "new_string",
  "content",
  "description",
] as const;
function approvalReview(detail: Row, taskId: unknown, revision: unknown): Row {
  const projected = approval(
    detail,
    taskId,
    Math.max(0, (integer(revision) ?? 1) - 1),
  );
  if (!projected)
    return {
      omitted: true,
      reviewComplete: false,
      reviewHint:
        "Approval details were truncated before persistence. Inspect local persisted logs or the native approval before responding.",
    };
  const native = object(detail.detail);
  const payload = object(detail.payload ?? native.payload);
  const arguments_ = object(payload.detail);
  const review: Row = {};
  let incomplete = detail.truncated === true || native.truncated === true;
  for (const key of REVIEW_TEXT_FIELDS) {
    if (typeof arguments_[key] !== "string") continue;
    const displayed = text(arguments_[key], 1024);
    review[key] = displayed;
    if (displayed !== arguments_[key]) incomplete = true;
  }
  for (const key of ["replace_all", "recursive"]) {
    if (typeof arguments_[key] === "boolean") review[key] = arguments_[key];
  }
  // Unknown arguments and native response/permission update objects are not forwarded.
  const recognized = new Set<string>([
    ...REVIEW_TEXT_FIELDS,
    "replace_all",
    "recursive",
  ]);
  const omitted = Object.keys(arguments_).filter(
    (key) => !recognized.has(key),
  ).length;
  if (omitted) {
    review.omittedArgumentFields = omitted;
    incomplete = true;
  }
  if (Object.keys(review).length) projected.operation = review;
  if (!Object.keys(arguments_).length) incomplete = true;
  const options = array(payload.options);
  if (options.length)
    projected.options = options.slice(0, 6).map((entry) => ({
      ...fields(object(entry), ["optionId"]),
      ...fields(object(entry), ["kind", "label"], "text"),
    }));
  const requiredByTool: Record<string, readonly string[]> = {
    Bash: ["command"],
    Edit: ["file_path", "old_string", "new_string"],
    Write: ["file_path", "content"],
    Read: ["file_path"],
  };
  const toolName =
    typeof projected.toolName === "string" ? projected.toolName : "";
  const required = requiredByTool[toolName];
  const complete =
    projected.kind === "permission" &&
    !!required &&
    required.every((key) => typeof arguments_[key] === "string") &&
    !incomplete &&
    options.length <= 6;
  projected.reviewComplete = complete;
  if (incomplete || options.length > 6) projected.truncated = true;
  if (complete) delete projected.reviewHint;
  else
    projected.reviewHint =
      "Some operation details are unavailable in this view. Inspect local persisted logs or the native approval for the missing details.";
  delete projected.review;
  return projected;
}

function event(value: unknown): Row {
  const source = object(value);
  const detail = object(source.detail);
  const retry = busyRetry(detail.retry);
  const busyContinuation =
    retry !== undefined ||
    (typeof source.type === "string" &&
      source.type.startsWith("busy_continue_"));
  const projected = {
    ...fields(source, ["taskId"]),
    ...fields(source, ["revision", "createdAt"], "number"),
    ...fields(source, ["type", "status"], "text"),
  };
  if (
    source.type === "approval_requested" ||
    (detail.decision === undefined &&
      (detail.approvalId || detail.interactionId))
  ) {
    return {
      ...projected,
      detail: approvalReview(detail, source.taskId, source.revision),
    };
  }
  const safe = {
    ...(detail.decision !== undefined
      ? fields(detail, ["approvalId", "respondedApprovalId"])
      : {}),
    ...fields(
      detail,
      ["category", "nativeState", "nativeTurnState", "decision"],
      "text",
    ),
    ...fields(
      detail,
      ["executionUncertain", "requiresInspection", "truncated"],
      "boolean",
    ),
    ...(busyContinuation
      ? detail.reason === "model_busy"
        ? { reason: "model_busy" }
        : {}
      : text(detail.reason, 256)
        ? { reason: text(detail.reason, 256) }
        : {}),
    ...(retry ? { retry } : {}),
  };
  return {
    ...projected,
    ...(Object.keys(safe).length ? { detail: safe } : {}),
    ...(source.type === "error" ||
    typeof detail.message === "string" ||
    typeof detail.error === "string"
      ? { diagnostic: diagnostic(detail) }
      : {}),
    ...(Object.keys(detail).some((key) => !Object.hasOwn(safe, key))
      ? { detailOmitted: true }
      : {}),
  };
}

function logs(value: unknown, args: Row): Row {
  const source = object(value);
  const events: Row[] = [];
  const entries = array(source.events);
  const cursor = integer(args.cursor) ?? 0;
  const output: Row = {
    taskId: control(args.task_id),
    events,
    nextCursor: cursor,
  };
  for (const entry of entries) {
    const projected = event(entry);
    const revision = integer(projected.revision);
    if (revision === undefined || revision <= (output.nextCursor as number)) {
      throw new ControlBudgetError("Invalid log cursor");
    }
    const candidate = {
      ...output,
      events: [...events, projected],
      nextCursor: revision,
    };
    if (bytes(candidate) > MCP_MAX_TEXT_BYTES - 768) {
      if (!events.length)
        throw new ControlBudgetError(
          "One log event exceeds the presentation budget",
        );
      break;
    }
    events.push(projected);
    output.nextCursor = revision;
  }
  if (events.length < entries.length || source.hasMore === true) {
    output.hasMore = true;
    output.pageTruncated = events.length < entries.length;
    output.nextAction = {
      tool: "zcode_inspect",
      arguments: {
        kind: "logs",
        task_id: control(args.task_id),
        cursor: output.nextCursor,
        limit: args.limit ?? 10,
      },
    };
  }
  return output;
}

function prefixEnd(
  value: string,
  end: number,
  hasFollowingPage: boolean,
): number {
  // Native diff offsets are JavaScript UTF-16 indexes, not UTF-8 byte offsets.
  if (
    end > 0 &&
    /[\uD800-\uDBFF]/.test(value[end - 1]!) &&
    (end < value.length || hasFollowingPage)
  )
    return end - 1;
  return end;
}
function diff(value: unknown, args: Row): Row {
  const source = object(value);
  const taskId = control(args.task_id);
  const offset = integer(args.offset) ?? 0;
  if (source.available !== true) return { taskId, available: false };
  const patch = typeof source.text === "string" ? source.text : "";
  if (/^[\uDC00-\uDFFF]/.test(patch))
    throw new ControlBudgetError(
      "Diff offset splits a surrogate pair; retry the preceding UTF-16 offset",
    );
  const sourceNext =
    source.nextOffset === null ? null : integer(source.nextOffset);
  const totalCharacters = integer(source.totalCharacters);
  function page(end: number): Row {
    const consumed = prefixEnd(
      patch,
      end,
      sourceNext !== null && sourceNext !== undefined,
    );
    const original = patch.slice(0, consumed);
    const cleaned = redactPresentationText(original);
    const nextOffset =
      consumed < patch.length ? offset + consumed : (sourceNext ?? null);
    return {
      taskId,
      available: true,
      text: cleaned,
      nextOffset,
      totalCharacters,
      ...(cleaned !== original
        ? { redacted: true, sourceCharacters: consumed }
        : {}),
      ...(consumed < patch.length ? { pageTruncated: true } : {}),
    };
  }
  let low = 0;
  let high = patch.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(page(mid)) <= MCP_MAX_TEXT_BYTES) low = mid;
    else high = mid - 1;
  }
  const output = page(low);
  if (patch.length && (output.nextOffset === offset || !output.text)) {
    throw new ControlBudgetError(
      "Diff page cannot advance safely; inspect the patch locally",
    );
  }
  return output;
}

function workSummary(value: unknown, details = false): Row {
  const source = object(value);
  const items = array(source.items).map(object);
  const deliveries = array(source.deliveries).map(object);
  const todos = array(source.todos).map(object);
  const counts: Record<string, number> = {};
  for (const item of items) {
    const status = String(item.status ?? "queued");
    counts[status] = (counts[status] ?? 0) + 1;
  }
  for (const [key, value] of Object.entries(object(source.counts)))
    if (integer(value) !== undefined) counts[key] = value as number;
  const result: Row = {
    ...fields(source, ["workId", "commanderId", "integrationRevision"]),
    ...fields(
      source,
      ["controlVersion", "revision", "requestedAccounts", "effectiveAccounts"],
      "number",
    ),
    ...fields(source, ["status"], "text"),
    goal: text(source.goal, 400),
    next: text(source.next, 600),
    counts,
    stages: array(source.stages)
      .slice(0, details ? 50 : 12)
      .map((entry) => {
        const s = object(entry);
        return {
          ...fields(s, ["stageId"]),
          title: text(s.title, 120),
          status: text(s.status, 40),
          ...(s.confirmation ? { confirmed: true } : {}),
          ...(details
            ? {
                dependsOn: array(s.dependsOn).map(control),
                criteria: array(s.criteria)
                  .slice(0, 10)
                  .map((v) => text(v, 300)),
              }
            : {}),
        };
      }),
    pending: todos.slice(0, 8).map((t) => ({
      ...fields(t, ["todoId"]),
      kind: text(t.kind, 50),
      summary: text(t.summary, 600),
      availableAccounts: integer(t.availableAccounts),
    })),
    deliveries: deliveries.slice(-6).map((d) => ({
      ...fields(d, ["deliveryId", "taskId", "itemId", "manifestSha256"]),
      summary: text(d.summary, 600),
    })),
    acceptances: array(source.acceptances)
      .slice(-6)
      .map((entry) => {
        const a = object(entry);
        return {
          ...fields(a, [
            "acceptanceId",
            "deliveryId",
            "itemId",
            "workspaceId",
            "workspacePath",
          ]),
          status: text(a.status, 40),
          executor: {
            kind: text(object(a.executor).kind, 30),
            name: text(object(a.executor).name, 120),
          },
          summary: text(a.summary, 400),
        };
      }),
  };
  if (details)
    result.items = items.slice(-100).map((i) => ({
      ...fields(i, ["itemId", "taskId", "stageId", "accountAlias", "workerId"]),
      title: text(i.title, 160),
      status: text(i.status, 40),
      blockedReason: text(i.blockedReason, 300),
    }));
  if (
    integer(source.itemCount) !== undefined ||
    items.length > (details ? 100 : 0)
  )
    result.itemCount = integer(source.itemCount) ?? items.length;
  if (source.errors) {
    const errors = object(source.errors);
    result.errors = {
      observedCount: integer(errors.observedCount),
      complete: errors.complete === true ? true : null,
      incompleteTaskCount: integer(errors.incompleteTaskCount),
      categories: Object.fromEntries(
        Object.entries(object(errors.categories)).filter(
          ([, value]) => integer(value) !== undefined,
        ),
      ),
    };
  }
  for (const key of [
    "stageCount",
    "deliveryCount",
    "acceptanceCount",
    "todoCount",
  ])
    if (integer(source[key]) !== undefined) result[key] = source[key];
  if (deliveries.length > 6) result.olderDeliveryCount = deliveries.length - 6;
  if (todos.length > 8) result.additionalPendingCount = todos.length - 8;
  return result;
}

function project(method: string, value: unknown, args: Row): Row {
  const source = object(value);
  switch (method) {
    case "submit_work":
    case "advance_work":
      return {
        work: workSummary(source.work),
        ...fields(source, ["created", "applied"], "boolean"),
      };
    case "wait_work":
      return source.timedOut === true && !source.work
        ? {
            ...fields(source, ["workId"]),
            revision: integer(source.revision),
            status: text(source.status, 40),
            timedOut: true,
          }
        : {
            work: workSummary(source.work),
            ...fields(source, ["timedOut", "controlTransferred"], "boolean"),
            changes: array(source.events)
              .slice(-12)
              .map((entry) => {
                const e = object(entry);
                return {
                  revision: integer(e.revision),
                  type: text(e.type, 80),
                  ...fields(object(e.detail), [
                    "itemId",
                    "taskId",
                    "accountAlias",
                  ]),
                  summary: text(object(e.detail).summary, 500),
                };
              }),
          };
    case "pool_control":
      return source.stopping
        ? {
            stopping: true,
            workersStopped: boolean(source.workersStopped),
            stoppedWorkers: integer(source.stoppedWorkers),
          }
        : {
            ...overview(value),
            commanders: array(source.commanders)
              .slice(0, 20)
              .map((c) => ({
                ...fields(object(c), ["commanderId"]),
                ...fields(object(c), ["defaultQuota"], "number"),
              })),
            works: array(source.works)
              .slice(-10)
              .map((w) => ({
                ...fields(object(w), ["workId", "commanderId"]),
                goal: text(object(w).goal, 160),
                status: text(object(w).status, 40),
                revision: integer(object(w).revision),
              })),
          };
    case "inspect": {
      if (source.kind === "work_page") {
        const entries = array(source.entries);
        const output: Row = {
          workId: control(source.workId),
          section: text(source.section, 40),
          entries: [],
          total: integer(source.total),
          nextCursor:
            source.nextCursor === null ? null : integer(source.nextCursor),
        };
        for (const entry of entries) {
          const e = object(entry);
          const projected: Row = {
            ...fields(e, [
              "stageId",
              "itemId",
              "taskId",
              "deliveryId",
              "acceptanceId",
              "todoId",
              "manifestSha256",
              "workspaceId",
              "workspacePath",
              "accountAlias",
              "workerId",
            ]),
            ...fields(e, ["status", "kind"], "text"),
            title: text(e.title, 160),
            summary: text(e.summary, 600),
            criteria: array(e.criteria)
              .slice(0, 20)
              .map((c) => text(c, 200)),
            dependsOn: array(e.dependsOn).map(control),
            ...(e.confirmation
              ? {
                  confirmation: {
                    ...fields(object(e.confirmation), ["summary"], "text"),
                    deliveryIds: array(object(e.confirmation).deliveryIds).map(
                      control,
                    ),
                    acceptanceIds: array(
                      object(e.confirmation).acceptanceIds,
                    ).map(control),
                  },
                }
              : {}),
            ...(e.executor
              ? {
                  executor: fields(
                    object(e.executor),
                    ["kind", "name"],
                    "text",
                  ),
                }
              : {}),
            ...(e.evidence
              ? {
                  evidence: array(e.evidence)
                    .slice(0, 10)
                    .map((v) => text(v, 200)),
                }
              : {}),
          };
          if (e.execution) {
            const execution = object(e.execution);
            projected.execution = {
              ...fields(
                execution,
                [
                  "lastVisibleActivityAt",
                  "lastObservedAt",
                  "errorCount",
                  "recoveredAt",
                ],
                "number",
              ),
              observation: text(execution.observation, 30),
              nativeErrorsComplete:
                execution.nativeErrorsComplete === true ? true : null,
              nativeErrorsReason: text(execution.nativeErrorsReason, 80),
            };
          }
          if (
            array(output.entries).length &&
            bytes({
              ...output,
              entries: [...array(output.entries), projected],
            }) > MCP_COMPACT_TARGET_BYTES
          ) {
            output.nextCursor =
              Number(args.cursor ?? 0) + array(output.entries).length;
            break;
          }
          array(output.entries).push(projected);
        }
        return output;
      }
      if (source.kind === "work")
        return { work: workSummary(source.work, true) };
      if (source.kind === "result")
        return { task: task(source.task), result: result(source.result) };
      if (source.kind === "logs")
        return logs(value, {
          ...args,
          limit: Math.min(50, Number(args.limit ?? 10)),
        });
      return diff(value, {
        ...args,
        offset: args.cursor ?? 0,
        limit: args.limit ?? 4000,
      });
    }
    case "daemon_start":
      return { ready: source.ready === true };
    case "shutdown_pool":
      return {
        stopping: source.stopping === true,
        workersStopped: source.workersStopped === true,
        stoppedWorkers: integer(source.stoppedWorkers),
      };
    case "overview":
      return overview(value);
    case "get_pool_policy":
    case "set_pool_policy":
      return poolPolicy(value);
    case "probe_worker":
      return probe(value);
    case "start_worker":
    case "stop_worker":
      return worker(value);
    case "create_workspace":
      return workspace(value, true);
    case "dispatch_task":
      return { task: task(source.task), created: boolean(source.created) };
    case "wait":
      return {
        tasks: array(source.tasks).map((entry) => task(entry)),
        changedTaskIds: array(source.changedTaskIds).map(control),
        timedOut: boolean(source.timedOut),
        revision: integer(source.revision),
      };
    case "get_result":
      return { task: task(source.task), result: result(source.result) };
    case "get_logs":
      return logs(value, args);
    case "get_diff":
      return diff(value, args);
    case "reconcile_task":
    case "resume_task":
      return {
        task: task(source.task),
        ...fields(
          source,
          [
            "attached",
            "alreadyStopped",
            "requiresInspection",
            "executionStopped",
            "operationInProgress",
            "finalizing",
            "canResume",
            "pendingApprovalsTruncated",
            "approvalResponsePending",
            "awaitingNativeRevision",
          ],
          "boolean",
        ),
        ...fields(source, ["pendingApprovalCount"], "number"),
        ...fields(source, ["nativePhase", "nativeTurnState", "reason"], "text"),
        ...(Array.isArray(source.pendingApprovals)
          ? {
              pendingApprovals: source.pendingApprovals
                .map((entry) => approval(entry, object(source.task).taskId))
                .filter(Boolean),
            }
          : {}),
      };
    case "cancel_task":
      return source.taskId && source.cancelRequested === undefined
        ? task(value)
        : {
            ...(source.task
              ? { task: task(source.task) }
              : fields(source, ["taskId"])),
            ...fields(
              source,
              ["cancelRequested", "terminationConfirmed"],
              "boolean",
            ),
          };
    case "respond_approval":
      return {
        taskId: control(args.task_id),
        approvalId: control(args.approval_id),
        ...fields(
          source,
          [
            "accepted",
            "approvalResponsePending",
            "awaitingNativeRevision",
            "pendingApprovalsTruncated",
          ],
          "boolean",
        ),
        ...fields(source, ["pendingApprovalCount"], "number"),
        ...(source.task ? { task: task(source.task) } : {}),
      };
    default:
      throw new Error("Unsupported MCP presentation");
  }
}

function requestControls(args: Row): Row {
  return {
    ...Object.fromEntries(
      [
        "work_id",
        "commander_id",
        "task_id",
        "workspace_id",
        "worker_id",
        "request_id",
        "approval_id",
      ]
        .filter(
          (key) =>
            typeof args[key] === "string" &&
            Buffer.byteLength(args[key] as string) <= 600,
        )
        .map((key) => [key, args[key]]),
    ),
    ...fields(args, ["cursor", "offset"], "number"),
  };
}
function budgetFailure(
  method: string,
  args: Row,
  projected?: Row,
): PresentedText {
  const sourceTask = object(projected?.task ?? projected);
  const controls = {
    ...requestControls(args),
    ...Object.fromEntries(
      ["taskId", "workspaceId", "workerId"]
        .filter((key) => typeof sourceTask[key] === "string")
        .map((key) => [key, sourceTask[key]]),
    ),
  };
  const mutating = [
    "submit_work",
    "advance_work",
    "pool_control",
    "dispatch_task",
    "resume_task",
    "cancel_task",
    "respond_approval",
    "start_worker",
    "stop_worker",
    "create_workspace",
    "set_pool_policy",
  ].includes(method);
  return encode(
    {
      error: "OUTPUT_BUDGET_EXCEEDED",
      maxTextBytes: MCP_MAX_TEXT_BYTES,
      controls,
      message:
        "The safe view cannot fit its control data. No identifier or pagination cursor was shortened.",
      nextAction:
        method === "wait"
          ? "Split task_ids into smaller batches and call wait again."
          : method === "get_logs"
            ? "Keep the same cursor. Inspect this event in local ZCode or local persisted logs; reducing the page limit may help."
            : method === "get_diff"
              ? "Keep the same offset, reduce limit, and retry. Use the preceding offset if it splits an emoji."
              : mutating
                ? "The operation may already have completed. Inspect local state using the request/task IDs; do not automatically redispatch."
                : "Inspect the omitted control data using the local CLI, or request fewer tasks.",
    },
    true,
  );
}
function encode(value: Row, isError = false): PresentedText {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MCP_MAX_TEXT_BYTES) {
    // Only internal, fixed text reaches the final guard, never a slice of JSON.
    return {
      isError: true,
      text: JSON.stringify({
        error: "OUTPUT_BUDGET_EXCEEDED",
        message:
          "Control data exceeds the MCP text budget. Inspect local state; do not automatically repeat a mutation.",
        maxTextBytes: MCP_MAX_TEXT_BYTES,
      }),
    };
  }
  return { ...(isError ? { isError: true as const } : {}), text: serialized };
}

export function presentMcpResult(
  method: string,
  value: unknown,
  args: Row = {},
): PresentedText {
  if (!MCP_PRESENTED_METHODS.has(method))
    return presentMcpError("UNSUPPORTED_METHOD", method, args);
  let projected: Row | undefined;
  try {
    projected = project(method, value, args);
    if (bytes(projected) > MCP_MAX_TEXT_BYTES)
      return budgetFailure(method, args, projected);
    return encode(projected);
  } catch (error) {
    if (error instanceof ControlBudgetError)
      return budgetFailure(
        method,
        args,
        projected ?? safeReturnedControls(value),
      );
    return presentMcpError("PRESENTATION_FAILED", method, args);
  }
}

function safeReturnedControls(value: unknown): Row {
  const source = object(value);
  const returnedTask = object(source.task ?? source);
  return Object.fromEntries(
    ["taskId", "workspaceId", "workerId"]
      .filter(
        (key) =>
          typeof returnedTask[key] === "string" &&
          Buffer.byteLength(returnedTask[key] as string) <= MAX_CONTROL_BYTES,
      )
      .map((key) => [key, returnedTask[key]]),
  );
}

export type McpErrorKind =
  | "INVALID_ARGUMENT"
  | "UNSUPPORTED_METHOD"
  | "DAEMON_UNAVAILABLE"
  | "REQUEST_FAILED"
  | "PRESENTATION_FAILED"
  | "SHUTDOWN_INCOMPLETE"
  | "POOL_NOT_IDLE"
  | "WORKSPACE_BUSY"
  | "WORKER_BUSY"
  | "POOL_CAPACITY_REACHED"
  | "REQUEST_CONFLICT"
  | "NOT_FOUND"
  | "WORKER_UNAVAILABLE"
  | "APPROVAL_UNAVAILABLE"
  | "RECOVERY_REQUIRED"
  | "MODEL_BUSY"
  | "RATE_LIMITED"
  | "AUTH_INVALID"
  | "RISK_BLOCKED"
  | "NATIVE_SERVER_ERROR"
  | "MODEL_SELECTION_MISMATCH"
  | "CONTROL_TRANSFERRED";
const ERROR_MESSAGES: Record<McpErrorKind, string> = {
  CONTROL_TRANSFERRED:
    "Control of this work has transferred. Read it with inspect; the previous commander must not issue new decisions.",
  INVALID_ARGUMENT:
    "Invalid tool parameters. Check the tool input schema and retry.",
  UNSUPPORTED_METHOD:
    "This tool has no supported safe MCP view; no daemon request was made.",
  SHUTDOWN_INCOMPLETE:
    "Some Workers may have stopped. The daemon remains available; inspect remaining Workers. No force-stop was requested.",
  POOL_NOT_IDLE:
    "Automatic shutdown was refused because unfinished Work remains. No Workers were stopped. Continue work, recovery, acceptance or decisions; do not retry with only_if_idle false.",
  DAEMON_UNAVAILABLE:
    "The local daemon is unavailable. Use pool_control with action start to connect. Reads never restart a stopped pool.",
  REQUEST_FAILED:
    "The daemon request failed. Inspect local state; a timeout or connection loss does not prove that a task stopped.",
  PRESENTATION_FAILED:
    "The daemon replied but its safe view could not be produced. Inspect local state before repeating a mutation.",
  WORKSPACE_BUSY:
    "The workspace is held by an active or uncertain task. Inspect current work and wait for its account and directory to be released.",
  WORKER_BUSY:
    "The worker or account already has active or uncertain work. Inspect current work and wait for safe release.",
  POOL_CAPACITY_REACHED:
    "The pool concurrency limit is reached. Use pool_control to inspect settings or wait for running work. Advanced explicit dispatch did not queue a task.",
  REQUEST_CONFLICT:
    "This request ID belongs to a different dispatch payload. Inspect the existing task before deciding whether a distinct task is needed.",
  NOT_FOUND:
    "The requested task, workspace or worker was not found. Check its ID with overview or the local CLI.",
  WORKER_UNAVAILABLE:
    "The worker is not ready. Inspect its local status and probe it before dispatching.",
  APPROVAL_UNAVAILABLE:
    "The approval is no longer pending or does not support this decision. Refresh task state and inspect its current approval.",
  RECOVERY_REQUIRED:
    "The task lacks a confirmed live attachment or stopped execution. Automatic read-only recovery retains its account; inspect work before another decision.",
  MODEL_BUSY:
    "The native model reported temporary overload. Safe retries continue automatically; inspect work if a decision is pending.",
  RATE_LIMITED:
    "The native service reported a rate limit. Wait and inspect task state; do not automatically resend an uncertain dispatch.",
  AUTH_INVALID:
    "Native authentication is invalid or unavailable. Inspect local account health and credentials before dispatching.",
  RISK_BLOCKED:
    "The native service blocked the account for a risk check. Inspect local account health; do not rotate credentials to retry this task.",
  NATIVE_SERVER_ERROR:
    "The native service reported a server or transport error. Inspect task state and reconcile uncertain execution.",
  MODEL_SELECTION_MISMATCH:
    "The native session selected a different model/provider/reasoning configuration. Inspect the session before dispatching.",
};

/** Classify fixed diagnostics without copying any native exception text. */
export function classifyMcpError(value: unknown): McpErrorKind {
  const source = object(value);
  const code = typeof source.code === "string" ? source.code : "";
  const category = source.category;
  const message =
    value instanceof Error
      ? value.message.slice(0, 1024)
      : typeof source.message === "string"
        ? source.message.slice(0, 1024)
        : typeof source.error === "string"
          ? source.error.slice(0, 1024)
          : "";
  if (code === "POOL_NOT_IDLE" || /^Pool has unfinished work;/.test(message))
    return "POOL_NOT_IDLE";
  if (/^Pool has active or uncertain tasks/.test(message)) return "WORKER_BUSY";
  if (/^Pool shutdown incomplete;/.test(message)) return "SHUTDOWN_INCOMPLETE";
  if (/^Pool shutdown in progress/.test(message)) return "RECOVERY_REQUIRED";
  if (code === "ENOENT" || code === "ECONNREFUSED") return "DAEMON_UNAVAILABLE";
  if (code === "CONTROL_TRANSFERRED") return "CONTROL_TRANSFERRED";
  if (
    code === "WORKSPACE_BUSY" ||
    /^Workspace is held by task |^Cannot change workspace lifecycle while a task/.test(
      message,
    )
  )
    return "WORKSPACE_BUSY";
  if (
    code === "WORKER_BUSY" ||
    /^Worker .+ is held by task |^Worker has an active or uncertain task|^Account is already (?:assigned|bound)|^Worker or account startup is already in progress/.test(
      message,
    )
  )
    return "WORKER_BUSY";
  if (
    code === "POOL_CAPACITY_REACHED" ||
    /^Pool concurrency limit reached/.test(message)
  )
    return "POOL_CAPACITY_REACHED";
  if (
    code === "IDEMPOTENCY_CONFLICT" ||
    message === "requestId was already used with a different dispatch payload"
  )
    return "REQUEST_CONFLICT";
  if (
    ["TASK_NOT_FOUND", "WORKSPACE_NOT_FOUND"].includes(code) ||
    /^(?:Task|Workspace) .+ was not found$|^Worker has no ownership record$/.test(
      message,
    )
  )
    return "NOT_FOUND";
  if (
    message === "Worker not ready" ||
    /^Worker status is not ready/.test(message)
  )
    return "WORKER_UNAVAILABLE";
  if (
    /^Approval is no longer pending|^Approval cannot be attributed|^Permission does not offer|^Workspace hook review requires|^Task or account is blocked from accepting approvals/.test(
      message,
    )
  )
    return "APPROVAL_UNAVAILABLE";
  if (
    ["EXECUTION_NOT_STOPPED", "DISPATCH_ALREADY_ATTEMPTED"].includes(code) ||
    /^No live turn attachment|^Task has no (?:safely attached live turn|live turn attachment)|^Cannot identify this turn|^Official runtime did not expose a foreground/.test(
      message,
    )
  )
    return "RECOVERY_REQUIRED";
  if (/^Official session selected a different/.test(message))
    return "MODEL_SELECTION_MISMATCH";
  if (category === "risk_blocked") return "RISK_BLOCKED";
  if (
    category === "auth_invalid" ||
    /^Account (?:unavailable|is unavailable)|^Official server ingress authentication required/.test(
      message,
    )
  )
    return "AUTH_INVALID";
  if (category === "model_busy") return "MODEL_BUSY";
  if (category === "rate_limited") return "RATE_LIMITED";
  if (category === "server_error") return "NATIVE_SERVER_ERROR";
  return "REQUEST_FAILED";
}
function diagnostic(value: unknown): Row {
  const kind = classifyMcpError(value);
  return { code: kind, message: ERROR_MESSAGES[kind] };
}

export function presentMcpError(
  kind: McpErrorKind,
  method: string,
  args: Row = {},
): PresentedText {
  // Native exceptions may embed a prompt, raw snapshot, credentials or tool args.
  // They are deliberately never echoed, even after truncation/redaction.
  return encode(
    {
      error: kind,
      message: ERROR_MESSAGES[kind],
      ...requestControls(args),
      ...(kind === "POOL_CAPACITY_REACHED"
        ? {
            nextAction:
              "Read pool_control and wait for held tasks to finish. This request was not dispatched; retry with the same request_id when capacity is available.",
          }
        : method === "dispatch_task" || method === "resume_task"
          ? {
              nextAction:
                "Use inspect with the known task IDs or pool_control to read pool state. Never automatically resend a task after an uncertain response.",
            }
          : {}),
    },
    true,
  );
}
