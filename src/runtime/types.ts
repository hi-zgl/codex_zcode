export type ErrorCategory = 'model_busy' | 'rate_limited' | 'server_error' | 'risk_blocked' | 'auth_invalid' | 'unknown';

/** The ingress secret is read locally and never included in returned status. */
export interface WorkerEndpoint {
  baseUrl: string;
  serverRoot?: string;
  tokenFile?: string;
}

export interface RuntimeInfo {
  adapterId: string;
  version: string;
  protocolVersion: number;
  conversationProtocolVersion?: number;
  authRequired: boolean;
  authenticated: boolean;
  serverId?: string;
  supported: boolean;
}

export interface ModelSelection {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}
export type ExecutionMode = 'build' | 'edit' | 'plan' | 'yolo' | 'guarded';

export interface SessionRef { sessionId: string; workspacePath: string }
export interface OpenSessionInput {
  workspacePath: string;
  sessionId?: string;
  modelSelection?: ModelSelection;
  mode?: ExecutionMode;
}
export interface TurnInput {
  prompt: string;
  /** Reuse after a timeout only after querying history; the official server deduplicates this command ID. */
  requestId?: string;
  modelSelection?: ModelSelection;
  mode?: ExecutionMode;
}
/** turnId is our stable command ID; data.runtimeTurnId carries the official product turn ID. */
export interface TurnRef extends SessionRef { turnId: string; commandId: string }

export type RuntimeEventType = 'session_snapshot' | 'turn_started' | 'assistant_message' |
  'tool_call' | 'tool_result' | 'approval_requested' | 'usage' | 'error' |
  'turn_completed' | 'turn_failed' | 'turn_cancelled' | 'runtime_status';
export interface RuntimeEvent {
  id: string;
  cursor: string;
  type: RuntimeEventType;
  sessionId: string;
  turnId?: string;
  timestamp: number;
  data: Record<string, unknown>;
}
export interface SessionSnapshot extends SessionRef {
  phase: string;
  revision: number;
  cursor: string;
  summary: string;
  modelSelection?: ModelSelection;
  pendingApprovals: Array<Record<string, unknown>>;
  /** Redacted current tail window, not a promise of complete conversation history. */
  raw: Record<string, unknown>;
}
/** Private, pre-redaction approval input. Only the daemon's strict review schema may project it. */
export interface ApprovalSourceSnapshot {
 snapshot: SessionSnapshot;
 pendingApprovals: Array<Record<string,unknown>>;
 sourceComplete: boolean;
 stablePermissionIds: boolean;
}
export type ApprovalDecision = 'accept' | 'decline' | 'cancel' | { optionId?: string; freeText?: string; action?: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };

export interface RuntimeConnection {
  readonly info: RuntimeInfo;
  openSession(input: OpenSessionInput): Promise<SessionRef>;
  sendTurn(session: SessionRef, input: TurnInput): Promise<TurnRef>;
  events(session: SessionRef, cursor?: string): AsyncIterable<RuntimeEvent>;
  respondApproval(turn: TurnRef, approvalId: string, decision: ApprovalDecision): Promise<void>;
  cancel(turn: TurnRef): Promise<void>;
  syncHistory(session: SessionRef): Promise<SessionSnapshot>;
  readApprovalSnapshot?(session: SessionRef): Promise<ApprovalSourceSnapshot>;
  queryCommand(session: SessionRef, commandId: string): Promise<Record<string, unknown> | 'unknown'>;
  /** Official billing read; no local estimates of cloud balance. */
  quota(providerId: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export interface RuntimeAdapter {
  readonly id: string;
  supports(info: Pick<RuntimeInfo, 'version' | 'protocolVersion'>): boolean;
  probe(endpoint: WorkerEndpoint): Promise<RuntimeInfo>;
  connect(endpoint: WorkerEndpoint): Promise<RuntimeConnection>;
}
