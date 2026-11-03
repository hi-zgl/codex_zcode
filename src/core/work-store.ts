import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CoreError,
  type Task,
  type PersistedTaskResult,
  type PoolPolicy,
} from "./types.js";
import {
  workSchema,
  commanderSchema,
  type Work,
  type Commander,
  type WorkView,
  type WorkItem,
  type SubmitWorkInput,
  type AdvanceWorkInput,
  type ExecutionFacts,
  type ErrorStats,
} from "./work-types.js";

export const DEFAULT_EXECUTION_SETTINGS = {
  retryIntervalMs: 5_000,
  recoveryWaitMs: 120_000,
  silenceCheckMs: 900_000,
  lowQuotaThresholdPercent: 5,
  defaultCommanderQuota: 2,
};
export type ExecutionSettings = typeof DEFAULT_EXECUTION_SETTINGS;
interface Reads {
  getTask(id: string): Task;
  getResult(id: string): PersistedTaskResult | null;
  getPoolPolicy(): PoolPolicy;
}
function fail(code: string, message: string): never {
  throw new CoreError(code, message);
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
}

/** Semantic decisions live here; runtime statuses remain in the original Task records. */
export class WorkStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly write: <T>(action: () => T) => T,
    private readonly now: () => number,
    private readonly reads: Reads,
  ) {
    db.exec(`
   CREATE TABLE IF NOT EXISTS work_records(work_id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,input TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS work_events(revision INTEGER PRIMARY KEY AUTOINCREMENT,work_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT;
   CREATE INDEX IF NOT EXISTS work_events_work ON work_events(work_id,revision);
   CREATE TABLE IF NOT EXISTS commanders(commander_id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS work_actions(request_id TEXT PRIMARY KEY,work_id TEXT NOT NULL,input TEXT NOT NULL,state TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS work_integrations(request_id TEXT PRIMARY KEY,before_commit TEXT NOT NULL,after_commit TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS pool_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS account_settings(account_alias TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN(0,1))) STRICT;
   CREATE TABLE IF NOT EXISTS task_execution(task_id TEXT PRIMARY KEY REFERENCES tasks(task_id),payload TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS execution_errors(error_id INTEGER PRIMARY KEY AUTOINCREMENT,task_id TEXT NOT NULL REFERENCES tasks(task_id),work_id TEXT,account_alias TEXT,
     command_id TEXT NOT NULL,category TEXT NOT NULL,occurrence_key TEXT NOT NULL DEFAULT 'terminal',occurred_at INTEGER NOT NULL,recovered_at INTEGER,summary TEXT NOT NULL,UNIQUE(task_id,command_id,category,occurrence_key)) STRICT;
   CREATE INDEX IF NOT EXISTS execution_errors_filter ON execution_errors(occurred_at,account_alias,work_id);
  `);
  }
  settings(): ExecutionSettings {
    const row = this.db
      .prepare("SELECT value FROM pool_settings WHERE key=?")
      .get("execution") as { value: string } | undefined;
    return {
      ...DEFAULT_EXECUTION_SETTINGS,
      ...(row ? JSON.parse(row.value) : {}),
    };
  }
  setSettings(input: Partial<ExecutionSettings>): ExecutionSettings {
    const next = { ...this.settings(), ...input };
    for (const key of [
      "retryIntervalMs",
      "recoveryWaitMs",
      "silenceCheckMs",
    ] as const)
      if (
        !Number.isSafeInteger(next[key]) ||
        next[key] < 1_000 ||
        next[key] > 86_400_000
      )
        fail("INVALID_ARGUMENT", `${key} must be between 1000 and 86400000`);
    if (
      !Number.isFinite(next.lowQuotaThresholdPercent) ||
      next.lowQuotaThresholdPercent < 0 ||
      next.lowQuotaThresholdPercent > 100
    )
      fail("INVALID_ARGUMENT", "Invalid low quota threshold");
    if (
      !Number.isSafeInteger(next.defaultCommanderQuota) ||
      next.defaultCommanderQuota < 0 ||
      next.defaultCommanderQuota > 64
    )
      fail("INVALID_ARGUMENT", "Invalid commander quota");
    this.write(() =>
      this.db
        .prepare(
          "INSERT INTO pool_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run("execution", canonical(next)),
    );
    return next;
  }
  commanders(): Commander[] {
    return (
      this.db
        .prepare("SELECT payload FROM commanders ORDER BY commander_id")
        .all() as { payload: string }[]
    ).map((row) => commanderSchema.parse(JSON.parse(row.payload)));
  }
  commander(commanderId: string): Commander {
    return (
      this.commanders().find((c) => c.commanderId === commanderId) ?? {
        commanderId,
        label: commanderId,
        defaultQuota: this.settings().defaultCommanderQuota,
        lastGrantedAt: 0,
      }
    );
  }
  setCommanderQuota(commanderId: string, defaultQuota: number): Commander {
    const c = commanderSchema.parse({
      ...this.commander(commanderId),
      defaultQuota,
    });
    this.write(() => this.saveCommander(c));
    return c;
  }
  private saveCommander(c: Commander): void {
    this.db
      .prepare(
        "INSERT INTO commanders(commander_id,payload) VALUES(?,?) ON CONFLICT(commander_id) DO UPDATE SET payload=excluded.payload",
      )
      .run(c.commanderId, canonical(c));
  }
  granted(commanderId: string): void {
    this.write(() =>
      this.saveCommander({
        ...this.commander(commanderId),
        lastGrantedAt: this.now(),
      }),
    );
  }
  enabled(accountAlias: string): boolean {
    const row = this.db
      .prepare("SELECT enabled FROM account_settings WHERE account_alias=?")
      .get(accountAlias) as { enabled: number } | undefined;
    return row?.enabled !== 0;
  }
  setAccountEnabled(accountAlias: string, enabled: boolean): void {
    this.write(() =>
      this.db
        .prepare(
          "INSERT INTO account_settings(account_alias,enabled) VALUES(?,?) ON CONFLICT(account_alias) DO UPDATE SET enabled=excluded.enabled",
        )
        .run(accountAlias, enabled ? 1 : 0),
    );
  }
  list(): Work[] {
    return (
      this.db
        .prepare("SELECT payload FROM work_records ORDER BY rowid")
        .all() as { payload: string }[]
    ).map((row) => workSchema.parse(JSON.parse(row.payload)));
  }
  get(workId: string): Work {
    const row = this.db
      .prepare("SELECT payload FROM work_records WHERE work_id=?")
      .get(workId) as { payload: string } | undefined;
    return row
      ? workSchema.parse(JSON.parse(row.payload))
      : fail("WORK_NOT_FOUND", "Work was not found");
  }
  private persist(work: Work, type: string, detail: unknown = {}): Work {
    const at = this.now();
    const event = this.db
      .prepare(
        "INSERT INTO work_events(work_id,type,payload,created_at) VALUES(?,?,?,?)",
      )
      .run(work.workId, type, canonical(detail), at);
    work.revision = Number(event.lastInsertRowid);
    work.updatedAt = at;
    this.db
      .prepare("UPDATE work_records SET payload=? WHERE work_id=?")
      .run(canonical(workSchema.parse(work)), work.workId);
    return work;
  }
  update(
    workId: string,
    action: (work: Work) => void,
    type = "work_changed",
    detail: unknown = {},
  ): Work {
    return this.write(() => {
      const work = this.get(workId);
      action(work);
      this.validate(work);
      return this.persist(work, type, detail);
    });
  }
  updateQuiet(workId: string, action: (work: Work) => void): Work {
    return this.write(() => {
      const work = this.get(workId);
      action(work);
      this.validate(work);
      this.db
        .prepare("UPDATE work_records SET payload=? WHERE work_id=?")
        .run(canonical(workSchema.parse(work)), workId);
      return work;
    });
  }
  /** Called only inside the Task admission transaction, before a native job starts. */
  linkTaskInTransaction(
    workId: string,
    itemId: string,
    taskId: string,
    workspaceId: string,
  ): void {
    const work = this.get(workId),
      item = work.items.find((i) => i.itemId === itemId);
    if (!item || item.queueAt === null)
      fail("INVALID_TRANSITION", "Work item is no longer queued");
    item.taskId = taskId;
    item.workspaceId = workspaceId;
    item.queueAt = null;
    if (item.runIndex)
      this.db
        .prepare("UPDATE work_records SET payload=? WHERE work_id=?")
        .run(canonical(workSchema.parse(work)), workId);
    else this.persist(work, "work_dispatched", { itemId, taskId });
  }
  requeueTaskInTransaction(
    workId: string,
    taskId: string,
    notBefore: number,
  ): void {
    const work = this.get(workId),
      item = work.items.find((i) => i.taskId === taskId);
    if (!item || item.queueAt !== null)
      fail("INVALID_TRANSITION", "The item cannot be requeued twice");
    item.handoffTaskId = taskId;
    item.queueAt = notBefore;
    item.runIndex++;
    item.attentionKey = null;
    this.db
      .prepare("UPDATE work_records SET payload=? WHERE work_id=?")
      .run(canonical(workSchema.parse(work)), workId);
  }
  create(input: SubmitWorkInput): { work: Work; created: boolean } {
    return this.write(() => {
      const found = this.db
        .prepare("SELECT input,payload FROM work_records WHERE request_id=?")
        .get(input.request_id) as
        { input: string; payload: string } | undefined;
      if (found) {
        if (found.input !== canonical(input))
          fail(
            "IDEMPOTENCY_CONFLICT",
            "request_id has different work parameters",
          );
        return {
          work: workSchema.parse(JSON.parse(found.payload)),
          created: false,
        };
      }
      const at = this.now();
      const work: Work = {
        workId: `work_${randomUUID()}`,
        requestId: input.request_id,
        commanderId: input.commander_id,
        controlVersion: 1,
        repositoryPath: input.repository,
        goal: input.goal,
        criteria: input.criteria,
        status: "active",
        quotaOverride: input.accounts ?? null,
        partialApproval: null,
        stages: input.stages.map((s) => ({
          ...s,
          confirmation: null,
          rework: false,
          blockedReason: null,
        })),
        items: input.items.map((i) => this.newItem(i, at)),
        deliveries: [],
        acceptances: [],
        todos: [],
        integratedDeliveryIds: [],
        integrationRevision: null,
        finalAcceptance: null,
        next: input.next,
        revision: 0,
        createdAt: at,
        updatedAt: at,
      };
      this.validate(work);
      this.saveCommander(this.commander(input.commander_id));
      this.db
        .prepare(
          "INSERT INTO work_records(work_id,request_id,input,payload) VALUES(?,?,?,?)",
        )
        .run(work.workId, input.request_id, canonical(input), canonical(work));
      return {
        work: this.persist(work, "work_submitted", { goal: work.goal }),
        created: true,
      };
    });
  }
  newItem(
    input: AdvanceWorkInput["add_items"][number],
    at = this.now(),
  ): WorkItem {
    return {
      ...input,
      kind: "implementation",
      targetDeliveryId: null,
      acceptanceId: null,
      workspaceId: null,
      taskId: null,
      handoffTaskId: null,
      runIndex: 0,
      queueAt: at,
      blockedReason: null,
      attentionKey: null,
      cancelled: false,
      createdAt: at,
    };
  }
  owned(work: Work, commanderId: string, controlVersion: number): void {
    if (
      work.commanderId !== commanderId ||
      work.controlVersion !== controlVersion
    )
      fail(
        "CONTROL_TRANSFERRED",
        `Work belongs to ${work.commanderId}; read its current control version before making decisions`,
      );
  }
  beginAction(input: AdvanceWorkInput): "new" | "pending" | "done" {
    return this.write(() => {
      const work = this.get(input.work_id);
      const row = this.db
        .prepare("SELECT input,state FROM work_actions WHERE request_id=?")
        .get(input.request_id) as
        { input: string; state: "pending" | "done" } | undefined;
      if (row && row.input !== canonical(input))
        fail(
          "IDEMPOTENCY_CONFLICT",
          "request_id has different advance parameters",
        );
      const completedTakeover =
        row?.state === "done" &&
        input.takeover &&
        work.commanderId === input.commander_id &&
        work.controlVersion === input.control_version + 1;
      if (!completedTakeover) this.decisionOwner(work, input);
      if (row) return row.state;
      this.db
        .prepare(
          "INSERT INTO work_actions(request_id,work_id,input,state) VALUES(?,?,?,?)",
        )
        .run(input.request_id, input.work_id, canonical(input), "pending");
      return "new";
    });
  }
  finishAction(input: AdvanceWorkInput, action: (work: Work) => void): Work {
    return this.write(() => {
      const work = this.get(input.work_id);
      this.decisionOwner(work, input);
      action(work);
      this.validate(work);
      this.saveCommander(this.commander(work.commanderId));
      this.db
        .prepare("UPDATE work_actions SET state=? WHERE request_id=?")
        .run("done", input.request_id);
      return this.persist(work, "commander_decision", {
        requestId: input.request_id,
      });
    });
  }
  decisionOwner(work: Work, input: AdvanceWorkInput): void {
    if (!input.takeover) {
      this.owned(work, input.commander_id, input.control_version);
      return;
    }
    if (!input.user_requested_takeover)
      fail(
        "TAKEOVER_REQUIRES_USER",
        "Taking control requires an explicit user request",
      );
    if (work.controlVersion !== input.control_version)
      fail(
        "CONTROL_TRANSFERRED",
        "The work control version changed before takeover",
      );
  }
  abandonAction(requestId: string): void {
    this.write(() =>
      this.db
        .prepare("DELETE FROM work_actions WHERE request_id=? AND state=?")
        .run(requestId, "pending"),
    );
  }
  integrationIntent(
    requestId: string,
  ): { before: string; after: string } | null {
    const row = this.db
      .prepare(
        "SELECT before_commit,after_commit FROM work_integrations WHERE request_id=?",
      )
      .get(requestId) as
      { before_commit: string; after_commit: string } | undefined;
    return row ? { before: row.before_commit, after: row.after_commit } : null;
  }
  saveIntegrationIntent(
    requestId: string,
    before: string,
    after: string,
  ): void {
    this.write(() =>
      this.db
        .prepare(
          "INSERT INTO work_integrations(request_id,before_commit,after_commit) VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE SET before_commit=excluded.before_commit,after_commit=excluded.after_commit",
        )
        .run(requestId, before, after),
    );
  }
  validate(work: Work): void {
    const stages = new Set(work.stages.map((s) => s.stageId)),
      items = new Set(work.items.map((i) => i.itemId));
    if (stages.size !== work.stages.length || items.size !== work.items.length)
      fail("INVALID_ARGUMENT", "Stage and work item IDs must be unique");
    for (const stage of work.stages)
      if (stage.dependsOn.some((id) => !stages.has(id) || id === stage.stageId))
        fail("INVALID_ARGUMENT", "Unknown or self stage dependency");
    for (const item of work.items)
      if (
        !stages.has(item.stageId) ||
        item.dependsOn.some((id) => !items.has(id) || id === item.itemId)
      )
        fail("INVALID_ARGUMENT", "Unknown stage or item dependency");
    function acyclic(
      ids: Set<string>,
      dependencies: (id: string) => string[],
    ): void {
      const path = new Set<string>(),
        seen = new Set<string>();
      const visit = (id: string) => {
        if (path.has(id))
          fail("INVALID_ARGUMENT", "Dependencies must not contain a cycle");
        if (seen.has(id)) return;
        path.add(id);
        for (const dep of dependencies(id)) visit(dep);
        path.delete(id);
        seen.add(id);
      };
      for (const id of ids) visit(id);
    }
    acyclic(
      stages,
      (id) => work.stages.find((s) => s.stageId === id)!.dependsOn,
    );
    acyclic(items, (id) => work.items.find((i) => i.itemId === id)!.dependsOn);
  }
  requestedAccounts(work: Work): number {
    return work.quotaOverride ?? this.commander(work.commanderId).defaultQuota;
  }
  effectiveAccounts(work: Work): number {
    const requested = this.requestedAccounts(work);
    return Math.min(requested, work.partialApproval ?? requested);
  }
  itemStatus(work: Work, item: WorkItem): string {
    if (item.cancelled)
      return item.taskId && this.reads.getTask(item.taskId).leaseHeld
        ? "cancelling"
        : "cancelled";
    if (item.blockedReason) return "blocked";
    if (item.queueAt !== null) return "queued";
    if (!item.taskId) return "queued";
    try {
      return this.reads.getTask(item.taskId).status;
    } catch {
      return "blocked";
    }
  }
  view(workId: string): WorkView {
    const work = this.get(workId);
    const items = work.items.map((item) => {
      const { prompt, ...rest } = item;
      let task: Task | null = null;
      try {
        if (item.taskId) task = this.reads.getTask(item.taskId);
      } catch {}
      return {
        ...rest,
        status: this.itemStatus(work, item),
        accountAlias:
          typeof (task?.runtimeBinding as any)?.accountAlias === "string"
            ? (task!.runtimeBinding as any).accountAlias
            : null,
        workerId: task?.workerId ?? null,
        execution: task ? this.execution(task.taskId) : null,
      };
    });
    const stages = work.stages.map((stage) => {
      const children = items.filter((i) => i.stageId === stage.stageId);
      const status: WorkView["stages"][number]["status"] = stage.confirmation
        ? "completed"
        : stage.rework
          ? "rework"
          : stage.blockedReason ||
              children.some((i) =>
                ["blocked", "failed", "interrupted"].includes(i.status),
              )
            ? "blocked"
            : children.some((i) => i.taskId !== null || i.status === "running")
              ? "running"
              : "not_started";
      return {
        ...stage,
        status,
        accountAliases: [
          ...new Set(
            children.map((i) => i.accountAlias).filter((v): v is string => !!v),
          ),
        ],
      };
    });
    return {
      ...work,
      items,
      stages,
      requestedAccounts: this.requestedAccounts(work),
      effectiveAccounts: this.effectiveAccounts(work),
    };
  }
  overview(filter: { repositoryPath?: string; workId?: string } = {}): {
    works: WorkView[];
    commanders: Commander[];
    poolPolicy: PoolPolicy;
  } {
    return {
      works: this.list()
        .filter(
          (w) =>
            (!filter.workId || w.workId === filter.workId) &&
            (!filter.repositoryPath ||
              w.repositoryPath === filter.repositoryPath),
        )
        .slice(-50)
        .map((w) => this.view(w.workId)),
      commanders: this.commanders(),
      poolPolicy: this.reads.getPoolPolicy(),
    };
  }
  briefView(workId: string) {
    const work = this.view(workId);
    const counts: Record<string, number> = {};
    for (const item of work.items)
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    const { total, categories, complete, incompleteTaskCount } =
      this.errorStats({ workId });
    return {
      ...work,
      errors: {
        observedCount: total,
        categories,
        complete,
        incompleteTaskCount,
      },
      goal: work.goal.slice(0, 600),
      next: work.next.slice(0, 600),
      criteria: work.criteria.slice(0, 5).map((c) => c.slice(0, 300)),
      items: [],
      counts,
      itemCount: work.items.length,
      stageCount: work.stages.length,
      deliveryCount: work.deliveries.length,
      acceptanceCount: work.acceptances.length,
      todoCount: work.todos.length,
      stages: work.stages.slice(0, 20).map((s) => ({
        ...s,
        criteria: s.criteria.slice(0, 5).map((c) => c.slice(0, 300)),
        confirmation: s.confirmation
          ? {
              ...s.confirmation,
              summary: s.confirmation.summary.slice(0, 400),
            }
          : null,
      })),
      deliveries: work.deliveries.slice(-6).map((d) => ({
        ...d,
        summary: d.summary.slice(0, 600),
        changedFiles: [],
      })),
      acceptances: work.acceptances
        .slice(-6)
        .map((a) => ({ ...a, summary: a.summary.slice(0, 400), evidence: [] })),
      todos: work.todos
        .slice(0, 10)
        .map((t) => ({ ...t, summary: t.summary.slice(0, 600) })),
    };
  }
  events(
    workId: string,
    afterRevision: number,
  ): Array<{
    revision: number;
    type: string;
    detail: unknown;
    createdAt: number;
  }> {
    return (
      this.db
        .prepare(
          "SELECT revision,type,payload,created_at FROM work_events WHERE work_id=? AND revision>? ORDER BY revision LIMIT 50",
        )
        .all(workId, afterRevision) as {
        revision: number;
        type: string;
        payload: string;
        created_at: number;
      }[]
    ).map((r) => ({
      revision: r.revision,
      type: r.type,
      detail: JSON.parse(r.payload),
      createdAt: r.created_at,
    }));
  }
  todo(
    workId: string,
    kind: Work["todos"][number]["kind"],
    summary: string,
    itemIds: string[] = [],
    availableAccounts: number | null = null,
  ): void {
    const work = this.get(workId);
    const old = work.todos.find(
      (t) => t.kind === kind && canonical(t.itemIds) === canonical(itemIds),
    );
    if (old?.summary === summary) return;
    this.update(
      workId,
      (w) => {
        if (old) {
          Object.assign(
            w.todos.find((t) => t.todoId === old.todoId)!,
            { summary, availableAccounts },
          );
        } else
          w.todos.push({
            todoId: `todo_${randomUUID()}`,
            kind,
            summary,
            itemIds,
            availableAccounts,
            createdAt: this.now(),
          });
      },
      "decision_required",
      { kind, summary },
    );
  }
  clearTodos(workId: string, kind: Work["todos"][number]["kind"]): void {
    if (this.get(workId).todos.some((t) => t.kind === kind))
      this.update(
        workId,
        (w) => {
          w.todos = w.todos.filter((t) => t.kind !== kind);
        },
        "decision_resolved",
        { kind },
      );
  }
  execution(taskId: string): ExecutionFacts {
    const row = this.db
      .prepare("SELECT payload FROM task_execution WHERE task_id=?")
      .get(taskId) as { payload: string } | undefined;
    const defaults: ExecutionFacts = {
      taskId,
      waitingSince: null,
      retryAt: null,
      lastVisibleActivityAt: this.reads.getTask(taskId).createdAt,
      lastObservedAt: null,
      executionCommandId: null,
      nativeErrorsComplete: null,
      nativeErrorsReason: "not_observed",
      observation: "unknown",
      errorCount: 0,
      recoveredAt: null,
    };
    return row ? { ...defaults, ...JSON.parse(row.payload) } : defaults;
  }
  updateExecution(
    taskId: string,
    changes: Partial<Omit<ExecutionFacts, "taskId">>,
  ): ExecutionFacts {
    return this.write(() => {
      const value = { ...this.execution(taskId), ...changes };
      this.db
        .prepare(
          "INSERT INTO task_execution(task_id,payload) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload",
        )
        .run(taskId, canonical(value));
      return value;
    });
  }
  noteActivity(taskId: string, at = this.now()): void {
    const current = this.execution(taskId);
    this.updateExecution(taskId, {
      lastVisibleActivityAt: Math.max(at, current.lastVisibleActivityAt),
      executionCommandId: this.reads.getTask(taskId).currentCommandId,
      waitingSince: null,
      retryAt: null,
      observation: "executing",
      ...(current.waitingSince !== null ? { recoveredAt: this.now() } : {}),
    });
    if (current.waitingSince !== null)
      this.write(() =>
        this.db
          .prepare(
            "UPDATE execution_errors SET recovered_at=? WHERE task_id=? AND recovered_at IS NULL",
          )
          .run(this.now(), taskId),
      );
    const work = this.list().find((w) =>
      w.items.some((i) => i.taskId === taskId),
    );
    const item = work?.items.find((i) => i.taskId === taskId);
    if (work && item) {
      const prefix = `${work.workId}:${item.itemId}:`;
      this.write(() =>
        this.db
          .prepare(
            "UPDATE execution_errors SET recovered_at=? WHERE recovered_at IS NULL AND task_id IN (SELECT task_id FROM tasks WHERE substr(request_id,1,length(?))=?)",
          )
          .run(this.now(), prefix, prefix),
      );
    }
  }
  recordError(
    taskId: string,
    commandId: string,
    category: string,
    summary: string,
    occurrenceKey = "terminal",
    observation: { occurredAt?: number; accountAlias?: string } = {},
  ): void {
    const { occurredAt } = observation;
    const officialAt =
      Number.isSafeInteger(occurredAt) && occurredAt! >= 0 ? occurredAt! : null;
    const task = this.reads.getTask(taskId);
    const work = this.list().find((w) =>
      w.items.some((i) => i.taskId === taskId),
    );
    const accountAlias =
      (task.runtimeBinding as any)?.accountAlias ??
      observation.accountAlias ??
      null;
    this.write(() => {
      if (
        occurrenceKey === "terminal" &&
        this.db
          .prepare(
            "SELECT error_id FROM execution_errors WHERE task_id=? AND command_id=? AND category=? AND occurrence_key LIKE 'native-model:%' LIMIT 1",
          )
          .get(taskId, commandId, category)
      )
        return;
      if (occurrenceKey.startsWith("native-model:")) {
        const placeholder = this.db
          .prepare(
            "SELECT error_id FROM execution_errors WHERE task_id=? AND command_id=? AND category=? AND occurrence_key='terminal'",
          )
          .get(taskId, commandId, category) as { error_id: number } | undefined;
        if (placeholder) {
          this.db
            .prepare(
              "UPDATE execution_errors SET occurrence_key=?,summary=?,occurred_at=COALESCE(?,occurred_at) WHERE error_id=?",
            )
            .run(
              occurrenceKey,
              summary.slice(0, 1200),
              officialAt,
              placeholder.error_id,
            );
          return;
        }
      }
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO execution_errors(task_id,work_id,account_alias,command_id,category,occurrence_key,occurred_at,summary) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          taskId,
          work?.workId ?? null,
          accountAlias,
          commandId,
          category,
          occurrenceKey,
          officialAt ?? this.now(),
          summary.slice(0, 1200),
        );
      if (result.changes) {
        const facts = this.execution(taskId);
        facts.errorCount++;
        this.db
          .prepare(
            "INSERT INTO task_execution(task_id,payload) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload",
          )
          .run(taskId, canonical(facts));
      }
    });
  }
  errorStats(
    filter: {
      accountAlias?: string;
      taskId?: string;
      workId?: string;
      fromMs?: number;
      toMs?: number;
    } = {},
  ): ErrorStats {
    const where =
      "(? IS NULL OR account_alias=?) AND (? IS NULL OR task_id=?) AND (? IS NULL OR work_id=?) AND occurred_at>=? AND occurred_at<=?";
    const params = [
      filter.accountAlias ?? null,
      filter.accountAlias ?? null,
      filter.taskId ?? null,
      filter.taskId ?? null,
      filter.workId ?? null,
      filter.workId ?? null,
      filter.fromMs ?? 0,
      filter.toMs ?? Number.MAX_SAFE_INTEGER,
    ];
    const groups = this.db
      .prepare(
        `SELECT category,count(*) AS count FROM execution_errors WHERE ${where} GROUP BY category`,
      )
      .all(...params) as { category: string; count: number }[];
    const rows = this.db
      .prepare(
        `SELECT * FROM execution_errors WHERE ${where} ORDER BY error_id DESC LIMIT 100`,
      )
      .all(...params) as any[];
    const work = filter.workId
      ? this.list().find((w) => w.workId === filter.workId)
      : null;
    const relevant = (
      this.db
        .prepare("SELECT task_id FROM tasks WHERE (? IS NULL OR task_id=?)")
        .all(filter.taskId ?? null, filter.taskId ?? null) as {
        task_id: string;
      }[]
    )
      .map((r) => this.reads.getTask(r.task_id))
      .filter(
        (task) =>
          (!filter.accountAlias ||
            (task.runtimeBinding as any)?.accountAlias ===
              filter.accountAlias) &&
          (!work || task.requestId.startsWith(work.workId + ":")) &&
          task.createdAt <= (filter.toMs ?? Number.MAX_SAFE_INTEGER) &&
          task.updatedAt >= (filter.fromMs ?? 0),
      );
    const incompleteTaskCount = relevant.filter(
      (task) => this.execution(task.taskId).nativeErrorsComplete !== true,
    ).length;
    return {
      total: groups.reduce((n, g) => n + g.count, 0),
      categories: Object.fromEntries(groups.map((g) => [g.category, g.count])),
      complete: incompleteTaskCount ? null : true,
      incompleteTaskCount,
      events: rows.map((r) => ({
        errorId: r.error_id,
        taskId: r.task_id,
        workId: r.work_id,
        accountAlias: r.account_alias,
        commandId: r.command_id,
        category: r.category,
        occurrenceKey: r.occurrence_key,
        occurredAt: r.occurred_at,
        recoveredAt: r.recovered_at,
        summary: r.summary,
      })),
    };
  }
}
