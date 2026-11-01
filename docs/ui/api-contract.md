# 拟议 UI API 契约 v1

状态：**设计，尚未实现**；核对基线与现有 API 事实见 [集成边界](integration-contract.md)。本文的 TypeScript/JSON 是拟议 wire schema 示例，不是已存在的导出类型或数据库迁移。扩展、CLI、MCP 并列；`ui_*` 仅新增 daemon 方法，必须继续被 MCP 工具白名单排除。

目标是让可操作首版具有可靠的控制状态、完整审批和不可变历史文件 Diff；不要求一次重写 scheduler。M1 可以先使用旧接口做只读最近 50 条。M2 必须实现下列审批、详情、工件依赖后才能称为可操作首版；稳定全历史列表可在 M3 实现，但不能用前端筛选冒充它。

## 1. 连接、版本和能力

沿用本机 Unix socket、单行 JSON-RPC 2.0，无 HTTP、WebSocket 管理端口或浏览器直连。Host 固定当前连接目标；Webview 不提交 socket、pool、可执行文件或通用 RPC 方法。当前目录/socket 权限用于同用户本机访问，没有 RPC 登录、角色或跨用户授权。Workspace Trust 在 Host handler 处检查，daemon 不信任客户端声称的 `trusted` 标志。同用户恶意进程不在这一隔离承诺内。

### `ui_capabilities`

bootstrap 不要求已协商版本；输入严格校验，拒绝未知字段：

```json
{"jsonrpc":"2.0","id":"c1","method":"ui_capabilities","params":{
  "bootstrapVersion":1,"client":{"name":"vscode","version":"0.1.0"},"supportedApiMajors":[1]
}}
```

```json
{"jsonrpc":"2.0","id":"c1","result":{
  "selectedApiVersion":{"major":1,"minor":0},"daemonVersion":"0.1.0",
  "instanceId":"daemon-uuid","storeId":"store-uuid","servedAtMs":1793491200000,
  "capabilities":{
    "taskDetail":{"version":1},"taskLookupByRequest":{"version":1},
    "taskList":{"version":0,"reason":"not_implemented"},
    "quotaSnapshots":{"version":1},"quotaProbe":{"version":1},
    "approvalRead":{"version":1},"approvalRespondFingerprint":{"version":1},
    "artifactSnapshots":{"version":1},
    "dispatchTask":{"version":1},"createWorkspace":{"version":1},"importAccounts":{"version":1},
    "startWorker":{"version":1},"stopWorker":{"version":1},
    "reconcileTask":{"version":1},"resumeTask":{"version":1},"cancelTask":{"version":1}
  },
  "limits":{"requestBytes":524288,"responseBytes":262144,"chunkBytes":65536,
    "taskPageItems":100,"approvalPageItems":50,"artifactPageItems":100,
    "approvalSnapshotBytes":8388608,"editorFileBytes":2097152},
  "runtime":{"platform":"linux","supportedOfficialVersions":["3.16.3"]}
}}
```

- 选择双方最高共同 major；无共同 major 返回 `INCOMPATIBLE_API`，不执行控制。minor 只能加可选字段；破坏字段含义、单位、必填条件或动作语义必须升 major。能力项的 `version` 独立协商；缺失或 0 都表示不可用，不以 daemon 包版本猜测能力。
- `instanceId` 每次 daemon 启动变化；`storeId` 是新增持久 store 身份，不从窗口 ID/路径推导。Host 以 remote authority + 规范化 pool + storeId 识别连接，切池/换 store 清除旧选择、cursor、审阅状态和待控制上下文。重连重新握手；旧请求 generation 的晚到响应不能覆盖新连接。
- 能力表示协议存在，**不保证某个任务/账号当前可执行**。任务级动作仍由最新详情及 daemon 写前检查决定；runtime 不支持时相应能力或具体对象动作须给出固定 reason。
- 旧 daemon 返回 Unknown method 时，Host 仅把该 bootstrap 的旧式 `-32000/Unknown method` 或标准 `-32601` 识别为 legacy；进入 M1 只读模式。任意错误不一律归为 legacy。旧实现不能返回 `ui_*` DTO，更不能回退 `respond_approval` 绕过 fingerprint。

除 bootstrap 外，所有新方法要求 `apiVersion:1`。输出统一 `UiEnvelope<T>`：

```ts
type UiEnvelope<T> = {
  meta: { apiVersion: 1; instanceId: string; storeId: string; servedAtMs: number };
  data: T;
};
```

Host 校验响应 schema、ID、分页进展、大小、meta 身份；未知可选字段丢弃，缺少控制必填字段则拒绝使用该响应。协议不同于前端消息版本；前端 router 只暴露固定 `task.detail`、`approval.read` 等联合类型，不能透传 `ui_*` 字符串。

## 2. 通用值、预算、错误和取消等待

| 值 | v1 规则 |
| --- | --- |
| ID | 非空、最多 150 JS UTF-16 单元且最多 600 UTF-8 字节；不裁剪控制 ID；hash 为 64 位小写 hex；cursor 不透明、最多 2048 字节 |
| 时间 | 新生成的 `*AtMs` 一律 Unix epoch 毫秒、有限安全整数；未知为 null。原生/导入单位未知的时间走 `SourceTime`，不依据位数猜单位 |
| revision | 非负安全整数或明确的 opaque token；task revision 是 store 全局事件序号在该 task 上的最后值，不是该 task 的连续计数 |
| JSON | 参数对象严格拒绝额外键、非有限数、超深嵌套与超限字符串；默认最大嵌套 32。不把 native 对象作为 `unknown` 直接返回 |
| 帧/页 | 旧 transport 硬上限 1 MiB。新 request 最多 512 KiB，完整编码后的 response 最多 256 KiB；一个原始字节 chunk 最多 64 KiB。计入 JSON escaping/base64，不对序列化 JSON 直接切片 |
| 超预算 | 返回 `OUTPUT_BUDGET_EXCEEDED` 和固定诊断；不截断 ID/hash/cursor。长正文用 chunk API，摘要可截断但附 `truncated:true`，不能把摘要当完整正文 |
| 并发 | 每 pool/窗口一个已知 task 集的 `wait`；详情/正文按需，Host 最多 4 个并发只读请求。控制请求按对象串行，禁用双击；这不是 daemon 权威检查的替代 |

新 `ui_*` 的 JSON-RPC 协议错误使用 `-32700/-32600/-32601/-32602`；领域错误统一 `-32010`，`message` 为固定文本，结构化 `data` 如下。现有旧方法的 `-32000` 不因本文自动改变；Host 适配旧错误时保守映射，不能从自然语言猜出副作用一定未发生。typed client 须保留 error 对象，现有 `rpcCall` 会丢弃 code/data，不能直接满足此契约。

```json
{"jsonrpc":"2.0","id":"a4","error":{"code":-32010,
  "message":"Approval changed; load the current review before responding.",
  "data":{"kind":"APPROVAL_CHANGED","retryable":false,"outcome":"not_started",
    "taskId":"task-1","approvalId":"approval-1","refresh":"approval"}}}
```

| `data.kind` | 含义 / Host 行为 |
| --- | --- |
| `INCOMPATIBLE_API / CAPABILITY_UNAVAILABLE` | 协议或能力不符，禁用对应操作，不降级成更弱写路径 |
| `NOT_FOUND` | 该读取事务没找到对象；不是任何在途派发绝未发生的证明 |
| `CURSOR_INVALID / CURSOR_STALE` | 非法、过期、跨方法/过滤/store/instance 或 revision 改变；丢弃该分页链，按本节规则刷新 |
| `OUTPUT_BUDGET_EXCEEDED / UNSUPPORTED_SCHEMA` | 明示大小或类型缺口；不得接受截断正文来批准 |
| `APPROVAL_CHANGED / APPROVAL_GONE / APPROVAL_READ_ONLY` | 内容/归属/revision 变化、已不再 pending、无法完整安全审阅；清空本地完成标志并更新卡片 |
| `APPROVAL_RESPONSE_PENDING / ACTION_CONFLICT` | 相同审批已有待确认答复，或 action ID 被不同内容复用；不发送第二次 |
| `ARTIFACT_UNAVAILABLE / INTEGRITY_MISMATCH / PATH_REJECTED` | 无快照/缺字节/摘要不符/不合法文件；不回退 live worktree |
| `WORKSPACE_BUSY / WORKER_BUSY / REQUEST_CONFLICT / WORKER_UNAVAILABLE` | 沿现有互斥、派发幂等和就绪语义；刷新相关对象 |
| `RECOVERY_REQUIRED / AUTH_INVALID / RISK_BLOCKED / MODEL_SELECTION_MISMATCH` | 沿现有恢复/账号/绑定限制；不能换资源绕过 |
| `NATIVE_UNAVAILABLE / OUTCOME_UNKNOWN / INTERNAL_ERROR` | 使用固定诊断及已知控制 ID；不回传原生 exception、路径、prompt、token 或原始 payload |

`outcome` 为 `not_started | may_have_applied | read_only`；只有副作用前明确验证失败才用 `not_started`。native 发送后丢 ACK、RPC 超时、连接断开、response 超预算都不能证明未执行。只读请求可有限重试；写请求不自动重放。Host 关闭一次 socket/AbortSignal 仅停止本窗口等待或丢弃响应，不能转成 `cancel_task`。当前 daemon store waiter 可能直到原最长 25 秒 timeout 才释放；后续可优化 waiter 清理，不能承诺现在已支持 RPC cancel。

## 3. 任务列表与详情

### `ui_list_tasks` — M3，可延期但语义固定

```ts
type ListTaskParams = {
  apiVersion: 1;
  filter?: { repository_path?: string; workspace_id?: Id; worker_id?: Id;
    statuses?: TaskStatus[]; lease_held?: boolean; query?: string };
  sort?: 'created_desc'; // 唯一排序，默认该值
  limit?: number;        // 1..100，默认 50
  cursor?: string;
};
type TaskListPage = {
  items: UiTaskSummary[]; total: number; nextCursor: string | null;
  listRevision: number; observedAtMs: number; scope: 'all_matching_tasks';
};
```

filter 项之间 AND；statuses 内 OR，空数组无匹配；空 filter 查询整个 pool。`repository_path` 精确匹配已登记的规范化源仓库路径，不读取任意目录；不存在的过滤 ID 返回空集。`query` 最多 200 UTF-16 单元，按固定 Unicode 大小写折叠做 literal substring，仅查 task/workspace/worker ID、仓库路径和分支，不搜索 prompt、日志或 native 正文。条件在服务器执行，total 是同一条件下准确总数；不以 loaded count 代替。

排序为 `createdAtMs DESC, taskId ASC`，ID 为稳定兜底；cursor 使用 keyset，不使用会漂移的 offset。**最小实现选择 revision gate，不保留长 SQLite 事务**：每页同一短读事务先取全局 task event revision、计数和行；首个 revision 写入 cursor，后续页若当前 revision 不相同，整页 `CURSOR_STALE`，不混合新旧状态。任何 task 事件都会失效该链，哪怕与当前过滤无关；future MVCC snapshot cache 可用新 capability 改善，但不能暗改 v1 语义。

cursor 内容绑定方法、api major、storeId、instanceId、规范化 filter+sort+limit hash、listRevision、最后 key、60 秒到期时间；以每次 daemon 启动的私有 HMAC key 签名。伪造/条件不符为 CURSOR_INVALID，合法但过期/instance 或 revision 变化为 CURSOR_STALE。cursor 是协议完整性检查，**不是身份认证或文件授权**，不防同用户恶意进程。

客户端遇到失效清除后续页和“完整列表”标志，从第一页重载，不拼接去重后假称完整。高频更新时可以只显示第一页及“列表持续变化，尚未载全”；按用户翻页最多重新起一次链，不能无界轮询。`nextCursor:null` 才表示该 revision 下已穷尽；`total:0` 只在该观察时点有效。

M1/M2 没有此 capability 时继续 overview 最近 50 条，明确 `scope:recent_50_loaded`；筛选、计数只针对已载入集合。`wait` 不会发现其他客户端新任务，低频概览重读可发现近期任务，不称全池订阅。

### `ui_get_task_detail` — M2 必需

参数为 `{apiVersion:1,task_id}` **异或** `{apiVersion:1,request_id}`。后者必须按已有唯一派发幂等键精确查找，支持原 `dispatch_task` 响应丢失后找回 task。两者同时提供或都缺少为 INVALID_ARGUMENT。返回 `UiEnvelope<UiTaskDetail>`；读取不连接 Worker、不恢复、不 probe、不执行核验。

```ts
type UiTaskSummary = {
  taskId: Id; workspaceId: Id; workerId: Id | null; status: TaskStatus;
  revision: number; createdAtMs: number; updatedAtMs: number;
  leaseHeld: boolean; executionStopped: boolean;
  cancelRequestedAtMs: number | null;
  approval: { pendingCount: number | null; responsePending: boolean; stateKnown: boolean };
  retry: { used: number; max: number; reason: 'model_busy' };
};
type UiTaskDetail = UiTaskSummary & {
  requestId: Id;
  workspace: { workspaceId: Id; repositoryPath: string; worktreePath: string;
    branch: string; baseCommit: string; state: 'active'|'merged'|'abandoned' };
  execution: { dispatchAttemptedAtMs: number | null; currentCommandId: Id;
    sessionId: Id | null; turnId: Id | null;
    stopProof: { kind: 'runtime_terminal'|'process_exited'|'history_stopped'|'not_dispatched';
      observedAtMs: number | null; evidenceSummary: string } | null;
    attachment: 'attached'|'not_attached'|'unknown'; finalizing: boolean };
  selection: { requestedWorkerId: Id | null; requestedSession: 'continue'|'new';
    mode: 'build'|'edit'|'plan'|'yolo'|'guarded'; requestedModelId: string;
    binding: { accountAlias: Id; providerId: string; modelId: string } | null };
  verificationPolicy: { complete: boolean; defaultDiffCheck: boolean;
    commands: { command: string; args: string[]; timeoutMs: number }[];
    unavailableReason: string | null };
  attempts: UiAttempt[]; currentAttemptIndex: number | null;
  controls: Record<'cancel'|'reconcile'|'resume',
    { available: boolean; reason: string | null; effects: string[] }>;
  result: { available: boolean; createdAtMs: number | null; summary: string;
    summaryTruncated: boolean; changedFileCount: number; artifactCount: number;
    verification: { commandDisplay: string; exitCode: number | null; summary: string;
      summaryTruncated: boolean }[]; blockers: string[];
    manifestState: 'available'|'legacy_patch_only'|'not_captured'|'unavailable' };
  diagnostic: { code: string; message: string } | null;
};
type UiAttempt = {
  index: number; commandId: Id; sessionId: Id | null; turnId: Id | null;
  intentAtMs: number; acknowledgedAtMs: number | null;
  terminalState: 'completedSuccess'|'failed'|'completedInterrupted'|null;
  stopProofKind: string | null; failureCategory: string | null;
  busyRetryEligible: boolean; continuationBlocked: boolean;
};
```

以上是字段白名单，**不是 `Task` 或 `detail/runtimeBinding/executionPolicy` 的序列化**。prompt、assistant 全文、native raw、endpoint、token、邮箱、vault 源文件路径不返回。binding 在原始派发前锁定，未绑定时 null；不能用当前 Worker 账号反填旧任务。`turnId` 沿当前适配器是本项目 command ID；不误称原生产品 turnHeader ID。attempt 从 index 0 开始，当前策略最多 11 条；没有 ACK 的 intent 也必须显示，不能丢弃为“没运行”。

summary 最多 8 KiB、evidenceSummary 最多 512 字节、核验摘要每项最多 2 KiB；截断都显式标记。核验命令最多 10 项；若整个策略不能在 32 KiB 内完整安全呈现，`complete:false`、commands 为空并说明原因，不能用截断命令确认恢复执行。result 只含计数，文件清单走工件 API；正文或 blocker 预算不足返回明确缺口而非漏掉未标记项。控制提示是该 revision 下的建议，写时仍重新检查。

Host 连接/过期状态另存为 `{connectionState,lastReceivedAtMs}`，不能改写 daemon status。取消意图从 daemon 获取，重载窗口后仍显示；`executionStopped:true` 不保证 lease 已释放；attachment 缺失也不证明停止。`reconcile` 的 effects 包含更新记录/可能释放占用；`resume` 包含可能核验/繁忙继续，不用“刷新”命名。

`request_id` 查询 NOT_FOUND 只证明查询时未持久化；可能仍有原派发在途。Host 持久保存原 request ID、payload hash、目标 ID、连接身份等非正文恢复元数据，不保存 prompt。超时不创建新 ID、不自动重发。只有原完整 payload 仍可取得且用户明确重试时，才可使用既有同 ID 同 payload 幂等接口；不得用重建/缺失 payload 猜测重试。core 仍是幂等和资源占用权威。

## 4. 额度：导入与 live 分开

### `ui_get_quota` / `ui_probe_quota`

`ui_get_quota {apiVersion:1,account_id}` 只读导入摘要及 daemon 已有 live 缓存；无网络、无自动启动 Worker。`ui_probe_quota {apiVersion:1,worker_id}` 是用户显式认证网络读取，要求 ready Worker，并按 Worker 真正绑定的 alias/provider 查询；不接受 Webview 传任意 provider 或账号来替换绑定。沿现有 probe 不发模型回合，可将 unknown health 升 available；该副作用必须列入动作说明。

```ts
type SourceTime = { value: number|string; unit: 's'|'ms'|'iso8601'|'unknown'; atMs: number|null };
type UiQuotaSnapshot = {
  source: 'imported_snapshot'|'live_probe'; accountAlias: Id; providerId: string;
  observedAtMs: number|null; storedAtMs: number|null;
  generatedAt: SourceTime|null; serverTime: SourceTime|null; nextReset: SourceTime|null;
  unit: 'credits'|'tokens'|'requests'|'unknown';
  total: number|null; used: number|null; remaining: number|null;
  percentage: { value: number; scale: '0_to_100'|'0_to_1'|'unknown' } | null;
  authenticated: boolean|null; freshness: 'fresh'|'stale'|'unknown';
};
type UiQuota = {
  accountAlias: Id; imported: UiQuotaSnapshot|null; live: UiQuotaSnapshot|null;
  lastProbe: { state: 'never'|'succeeded'|'failed'; attemptedAtMs: number|null;
    errorCode: string|null }; displayFreshnessWindowMs: number;
};
```

`usage_updated_at` 当前只是 raw 数字，没有可靠单位；旧导入的 observed/stored 时间未知，必须为 null，不拿 vault mtime 或当前打开时间伪装观察时间。live 的 observedAtMs 是本机成功读取完成时刻；generatedAt/serverTime/nextReset 来自原生，仅在已验证 provider/runtime 契约给出单位时转换，否则 `unit:unknown,atMs:null`。额度 count 不自动叫 token、积分或请求次数；百分比范围未知不画百分比条。

live 默认显示新鲜期 120 秒，这是 UI 缓存提示而非云端余额保证。仅 observedAtMs 可靠且本机时钟一致时判断 fresh/stale，时间倒退为 unknown。probe 失败保留上一份 snapshot 并记录 lastProbe failed，不把 remaining 置 0；未查询、失败、陈旧、数值 0 分开表达。live 缓存 M2 可仅在 daemon 内存中，重启后为 null，不写回导入 raw quota、不自动 probe；无 quota 订阅或余额自动分配算法。

## 5. 完整审批：来源、读取和答复

### 完整性前提

现 `safeDetail`/MCP 日志不能恢复截断前参数。M2 必须在该裁剪**之前**，为可支持的审批持久保存一个私有、不可变、按任务+attempt+interaction 归属的完整决策快照；或从仍存在的原生交互重取完整内容并立即固定快照。已有适配器的 snapshot 是脱敏的 tail window，不是完整历史承诺；来源已经丢失、被上游截断、归属不明、schema 不支持、超 8 MiB，均返回只读原因。

快照采用有版本 schema 的 canonical UTF-8 JSON（对象 key 排序，数组保留次序，不改字符串和数值），至少包含 kind、工具、操作目标、cwd/路径、**全部决策相关参数**、可用选项及其映射、task/attempt/command/session/原生 interaction 身份。SHA-256 覆盖这些字节；未知字段不能静默省略后声称完整。身份 token/凭据不进入 UI；若脱敏隐藏了执行命令等决策相关内容，该审批不可操作。只有已验证可安全省去的非决策元数据可脱敏，并在 redactions 明列类别。

v1 可操作 schema 先限受支持官方 runtime 的 `permission` 交互，已验证的 Bash/Edit/Write/Read 参数形式；未知工具、额外决策字段或交互类型只读。**这是新的 UI schema 校验，不是沿用 MCP 的几个已知字段就视为完整。** `workspaceHookReview`、自由文本、任意 option/content 表单和批量批准延期。permission 只展示“允许一次/拒绝”：accept 精确映射 allowOnce option，decline 映射 deny；现适配器把 permission cancel 也映射 deny，因此 UI 不虚构第三个原生取消选项。取消整个任务永远是单独动作。

### `ui_list_approvals`

参数 `{apiVersion:1,task_id,limit?:1..50,cursor?}`，默认 20。对原 task 的 current attempt 做新鲜原生观察并核对 session、command、原生 turn/anchor；不自动 `resume_task`、不启动模型回合或核验。没有可安全读取 attachment 时返回 stateKnown:false/RECOVERY_REQUIRED，用户另行决定核对或恢复。

返回 `{items:UiApprovalPreview[],total:number|null,nextCursor:string|null,approvalSetRevision:string,stateKnown:boolean}`。preview 只含完整 approval ID、kind/toolName、最多 384 字节摘要、完整度、responseState、readOnlyReason；摘要永远不是审阅正文。按 approval ID 升序分页；cursor 绑定 task/currentCommandId/native revision 和 60 秒有效期，期间集合或归属变化为 CURSOR_STALE。无法归属的原生交互计入 `unattributedCount`，不得塞入本 task 清单；total 为 null 时不能声称全部已知。

### `ui_get_approval` / `ui_read_approval`

`ui_get_approval {apiVersion:1,task_id,approval_id}` 创建或返回当前固定 review；不答复、不恢复执行。返回：

```ts
type UiApprovalReview = {
  taskId: Id; approvalId: Id; reviewId: Id;
  owner: { attemptIndex: number; commandId: Id; sessionId: Id; nativeTurnId: string };
  state: 'pending'|'response_pending'|'gone'|'unknown';
  approvalRevision: string; nativeRevision: number; observedAtMs: number; expiresAtMs: number;
  content: { mediaType: 'application/json'; encoding: 'utf8'; totalBytes: number;
    sha256: string; schema: 'permission-review/1'; sourceComplete: boolean } | null;
  redactions: { category: string; decisionRelevant: boolean }[];
  decisions: { decision: 'accept'|'decline'|'cancel'; label: string; nativeOptionId: string }[];
  readOnlyReason: string|null;
  response: { actionId: Id|null; decision: string|null;
    state: 'none'|'intent_recorded'|'awaiting_native'|'confirmed'|'resolved_unattributed'|'unknown' };
};
```

reviewId 绑定固定内容和 owner，默认 5 分钟可答复期；完整私有内容保存不因 review token 过期而被误称丢失，重新 get 可生成新 token。`approvalRevision` 是 daemon 对该 owner/审批内容/选项/状态版本的 opaque token，不能拿 task event revision 代替。gone/unknown/unavailable 时 content 可 null、decisions 为空且整个卡片只读；旧任务已存在但无正文不回 NOT_FOUND 冒充从未有审批。

`ui_read_approval {apiVersion:1,task_id,approval_id,review_id,offset_bytes,limit_bytes?}` 按固定 review 的 canonical 字节分页，默认/最大 64 KiB；不因重复读取去拼接一个变化中的原生对象。返回 `{reviewId,offsetBytes,dataBase64,byteLength,nextOffsetBytes,totalBytes,contentSha256}`；offset 范围 0..total，base64 避免 UTF-8 字符边界歧义，末尾 nextOffsetBytes:null。review 或 owner 失效返回 APPROVAL_CHANGED/GONE，读取旧正文只能另提供明确历史只读能力，不能复用答复 token。

Host 必须读齐 `[0,totalBytes)`、检查总长度和 SHA-256、按 UTF-8 严格解码并按 permission-review/1 校验后，才有 `loadedComplete:true` 并允许 accept。来源完整但尚未读全时，decline 可在已展示明确拒绝选项、来源归属可信的前提下使用 descriptor 的 hash/revision；仍须全部写前检查。来源本身不完整时整个卡片只读，不能借 decline/cancel 绕过。`sourceComplete`、`loadedComplete`、用户读过/授权是三件事；hash 只绑定所见内容，不能证明人已读或原先授权充分。审批全文只按需进入当前 Webview 内存，不写 `setState`、workspaceState、日志、遥测或 Codex；结束/换 task/失效后清除正文。

### `ui_respond_approval` — 新增的强前置条件写接口

```json
{"apiVersion":1,"task_id":"task-1","approval_id":"approval-1","review_id":"review-1",
 "expected_approval_revision":"approval-version-7","expected_native_revision":412,
 "expected_content_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
 "decision":"accept","action_id":"action-uuid"}
```

不扩展现 `respond_approval` 的弱参数，也不让 UI 调用它作 fallback。Host 先确认连接 generation、trusted workspace、完整来源及当前 hash/revision、明确单次操作和当前用户授权；accept 另须完整正文已载入并校验，decline 沿上一节门槛；daemon 以 task 为串行键，在 native 发送前重新检查：

1. 当前 task、attempt index、command/session、未停止执行和审批归属与 review owner 一致；审批仍 pending，未存在未知或待确认答复，review 未过期。
2. 完整新鲜原生快照的 native revision、内容 hash、approvalRevision、选项映射与 expected 值相符；native revision 变化即 APPROVAL_CHANGED，即使正文看似相同也要求重新读取，不把旧点击迁移到新快照。
3. schema 和完整度仍可操作；决定确实对应此次 option。accept 不得绕过 blocked/invalid/cooling 账号、blocked task 或已有取消意图；具体拒绝/取消也须重新核对归属和支持语义。
4. 持久记录 `action_id + 请求fingerprint + owner + decision + send-intent` 后才允许一次原生发送；正文不写入该动作记录。相同 action ID 同请求返回已有 receipt，禁止再次发送；不同请求复用为 ACTION_CONFLICT。该持久记录是 M2 新增要求，不能依赖现 active 内存 map 跨重启防重。

返回 `{taskId,approvalId,actionId,responseState:'awaiting_native'|'confirmed'|'resolved_unattributed'|'unknown',nativeRevisionAtCheck,taskRevision}`。native ACK 仅表示发送受理，仍保留卡片并禁用重复动作。只有能关联到本 action/decision 的原生确认依据才能标记 confirmed；仅 pending revision 变化或交互消失时标记 resolved_unattributed，显示“已不再待处理，无法确认采用了哪次答复”。当前适配器没有提供可靠的答复归属字段，因此首版不能仅靠 pending 消失产出 confirmed。即使取得关联确认也不等于任务成功或资源已释放。APPROVAL_GONE 只说明已不再 pending，不能无证据断言是其他客户端处理；内容变化则重新审阅，不能悄悄使用旧 decision。

记录 intent 后崩溃或 ACK 丢失为 unknown，恢复时读取 receipt 和新鲜 native 状态，不重放该 intent。尚无法证明旧答复结果时保持只读，保留核对/任务取消入口；不自动生成新 action ID 绕过。UI 断开后旧方法/其他客户端仍可改变状态，不能假设持有面板就独占审批。

**上游竞态限制：** 当前适配器 `resolveInteraction` 只有 interactionId/answer，没有已验证的 revision/CAS 参数。本方案能保证本地串行、将用户看到的内容绑定到本次 daemon 检查，并拒绝已观察到的失效；**不能原子保证检查到发送之间原生状态绝不变化**。可操作 kind 必须在受支持 runtime 验证 interaction ID 生命周期内的不可复用/稳定语义及选项归属；若同 ID 内容可无约束改变，或无法验证该语义，该 kind 保持 readonly，等待原生条件答复支持。不得虚构 native CAS，亦不得宣称 hash 消除了所有多客户端竞态。

## 6. 不可变产物、文件清单与 Diff

### 捕获范围与旧数据

现有 patch 是相对 workspace.baseCommit 的**累计变化**，不是本任务开始时的增量；base/final Diff 保持同样语义并常驻显示 base commit。M2 不为“本次增量”偷偷新增任务起始树，也不从 mutable worktree 倒推旧历史。

新完成链路在持有 lease、核验后、发布不可变 result/释放 lease **之前**保存一个版本化 manifest：patch hash、每个变化路径、base/final 文件 mode/kind/大小/hash/保存对象、未跟踪路径映射、捕获时间区间和每个缺口。base 字节来自明确的 baseCommit Git object；final 字节在这次捕获时保存为私有内容寻址 blob。tracked/untracked 都需映射；删除/新增的一侧是 absent，空文件是 available 且 size 0，两者不可混淆。

manifest 也保存为不可变私有工件并登记 hash，可复用现 ArtifactMetadata 的 kind/path/hash/size 结构，不要求为 UI 重建全部 task 表。完整 manifest/file read model 是新代码；当前 result 路径不直接透给 Webview。捕获保留 git mode、regular/symlink/gitlink 类型；symlink 保存链接文本且不跟随，子模块/gitlink 先元数据只读，未知类型明确 unavailable。rename 可记录，也可保守表示删+增；不得靠 display path 猜 fileId。

独占 scheduler lease 不能阻止用户或外部进程写 worktree，不是原子文件系统快照。记录 captureStartedAtMs/captureCompletedAtMs、`consistency:'lease_held_non_atomic'`；单文件读前后检测到变化则标 `unstable_capture`，不把不同时间的现文件补成历史。保存成功的 bytes/hash 是该任务的固定审阅证据；不宣称整个目录在同一瞬间被原子冻结。

默认捕获上限每文件 64 MiB、每任务总 256 MiB；超限/缺失/编码未知的文件仍在清单并注明原因，不能静默漏掉。ignored 文件不在当前 git changes 范围，显示 scope `git_tracked_plus_nonignored_untracked`，不称扫描了所有磁盘文件。现有原生失败/取消/恢复记录可能未走快照链路；首版允许 not_captured，不因 UI 需求自动重跑任务或核验。

旧任务只有 patch 时返回 legacy_patch_only：可读旧 patch，changedFiles 可作为不完整提示，但缺 tracked base/final、untracked 路径映射时历史文件 Diff 不可用。不能把现 worktree、现 HEAD、同 hash 猜出的路径、未经验证重建 patch 当作完整历史。离线校验后补建快照属于独立未来迁移，不纳入首版隐式行为。

### `ui_get_artifact_manifest`

参数 `{apiVersion:1,task_id}`；返回 `UiEnvelope<UiArtifactManifest>`：

```ts
type UiArtifactManifest = {
  taskId: Id; state: 'available'|'legacy_patch_only'|'not_captured'|'unavailable';
  schemaVersion: 1; manifestSha256: string|null;
  scope: 'workspace_base_cumulative'; baseCommit: string;
  sourceScope: 'git_tracked_plus_nonignored_untracked';
  captureStartedAtMs: number|null; captureCompletedAtMs: number|null;
  consistency: 'lease_held_non_atomic'|'legacy_unknown';
  fileCount: number|null; availableFileCount: number; unavailableFileCount: number;
  fileListComplete: boolean;
  patch: { available: boolean; sha256: string|null; sizeBytes: number|null };
  unavailableReason: string|null;
};
```

manifestSha256 覆盖 canonical manifest 全部文件记录和 blob 摘要（排除自身摘要字段），不是当前目录摘要。文件内容或清单变化须是新 digest；合法已有任务的完整 result 不应被 UI 改写。manifest 不含 vault/worker 路径，文件页只给任务相对路径和 opaque file ID。

### `ui_list_artifact_files`

参数 `{apiVersion:1,task_id,manifest_sha256,limit?:1..100,cursor?}`，默认 50。返回 `{items:UiArtifactFile[],total,nextCursor,manifestSha256}`；固定 manifest 内按 relative path 的 UTF-8 字节序 + fileId 排序。cursor 签名绑定 task/manifest/order/limit、store/instance，10 分钟到期；任务别的事件不失效不可变清单，manifest 改变/缺失或重启则 CURSOR_STALE。total 是该固定清单总数，缺口条目也计入，不能只数可打开文件。

```ts
type FileSide = {
  state: 'available'|'absent'|'unavailable'; reason: string|null;
  kind: 'regular'|'symlink'|'gitlink'|'unknown'; mode: string|null;
  sha256: string|null; sizeBytes: number|null;
  encoding: 'utf8'|'binary'|'unknown';
};
type UiArtifactFile = {
  fileId: Id; relativePath: string|null; displayPath: string;
  basePath: string|null; finalPath: string|null;
  change: 'added'|'modified'|'deleted'|'renamed'|'type_changed'|'untracked'|'unknown';
  base: FileSide; final: FileSide;
  nativeDiff: { available: boolean; reason: string|null };
};
```

文件路径只作显示与范围说明，不作为随后读取的地址。非 UTF-8 Git 路径首版转义显示且内容不可打开，reason `unsupported_path_encoding`，不以替换字符构造另一个路径；unknown/unsupported 条目照样可看元数据。untracked 的 base 为 absent，final 来自已保存 blob；任何未知映射都显示 unavailable。

### `ui_read_artifact_file`

参数 `{apiVersion:1,task_id,manifest_sha256,file_id,side:'base'|'final',offset_bytes,limit_bytes?}`；默认/最大 64 KiB。**不接受绝对路径、worktree 路径、relativePath、URI 或任意 artifact.path**。返回 `{manifestSha256,fileId,side,offsetBytes,dataBase64,byteLength,nextOffsetBytes,totalBytes,fileSha256,chunkSha256,encoding}`。offset 是源字节位置，0..size；nextOffsetBytes:null 表示 EOF。不存在一侧返回 ARTIFACT_UNAVAILABLE/absent 元信息，Host 可为 Diff 构造带 absent 标记的空文档；不能读磁盘“补上”。

读取端必须从该 task 的已登记 manifest 解析 blob；检查 task/result/manifest/file/side 归属、digest 与 size，限制在规范化私有 artifact 根目录；拒绝 NUL、绝对/逃逸路径、`..` 路径分量、非法 digest、非预期文件类型。对实际文件用真实路径归属检查、lstat 和不跟随最终 symlink 的打开方式，不从页面字符串拼接 filesystem 路径。读取已保存的 symlink **文本 blob**，不打开它指向的目标。摘要不符返回 INTEGRITY_MISMATCH，不继续展示冒充原结果。

这些校验阻止不可信 UI/任务路径把读取扩大到任意文件，并检测损坏；不承诺对可同时改写 manifest/blob 的同用户恶意进程提供可信取证。Host 使用只读 `zcodePool-artifact:` 内容提供器，URI 只编码连接身份+task+manifest+fileId+side；读取仍经 daemon 白名单。不能交给通用 `file:` URI、shell 或以日志链接启动命令。

Host 读齐并校验 whole-file SHA-256、严格 UTF-8 解码后才调用 `vscode.diff`。原生 Diff 默认每侧最多 2 MiB；较大文本显示大小和可按需分页读取的文本视图，明确“尚未完整载入”，不拿前 2 MiB 冒充完整 Diff。binary 先显示类型/大小/hash和双方是否存在；不解码成文本、不启动外部处理器。binary 下载/外部 Diff、超大文件完整编辑器、gitlink 和未知类型支持可延期。文本内容按原始代码字节审阅，可能含仓库自身的敏感文本；不要宣称 artifact 有完备 DLP，内容不送遥测或 MCP。

人工“已审阅”只存 Host workspaceState，key 为 authority + 规范化 pool/storeId + taskId + manifestSha256，值仅标记/本地时间；不保存正文。manifest/hash 改变即失效，不是 daemon 状态，不修改 `succeeded` 或云端任务，不代表 Codex、其他窗口或其他客户端已验收。无新 daemon review API。

## 7. 已有写操作与能力门槛

除 `ui_respond_approval` 的 fingerprint/receipt、`ui_probe_quota` 的投影缓存外，不重复创建一套 ui 写 API。M2 Host handler 校验固定 UI 消息、schema、trust、具体目标和当前 generation 后，适配现 daemon 方法并投影响应；仍受现 core/native 权威规则约束。不能从 UI 传通用 `method/params`。

| 能力 / 后台接口 | M2 语义与 UI 前提 |
| --- | --- |
| dispatchTask / `dispatch_task` | 显式 workspace、Worker、prompt、request ID、session、mode、model、busy limit、核验命令。保持默认 model/mode/session/busy 3 与 0–10 上限，不新增自动重调度；展示真实执行目录。满足现 100000 UTF-16 prompt 上限并检查整个 512 KiB request，超限直接拒绝、不裁剪 |
| createWorkspace / `create_workspace` | Host 显式选择源仓库/base ref，展示源仓库与新 worktree 的区别；由 daemon 再检查干净仓库；不附带 merge/cleanup |
| importAccounts / `import_accounts` | Host 原生文件选择，1–100 OAuth JSON 路径直传 daemon；正文/源路径不进入 Webview。受信任动作，错误固定化；不写 Codex 配置/官方默认登录 |
| startWorker/stopWorker | 明确 Worker 与 alias；stop 由 daemon 拒绝活动或未知占用，没有 force；账户健康和资源选择不靠旧额度条决定 |
| reconcileTask / `reconcile_task` | “核对执行状态”，不发模型回合、不跑核验，但可更新记录/释放有证明的占用；不能作为 M1 自动刷新 |
| resumeTask / `resume_task` | 恢复原 command 观察，可能执行既有核验或立即消耗剩余繁忙继续次数；策略完整可见后明确操作，不包装成只读；中断核验仍不自动重跑 |
| cancelTask / `cancel_task` | 先持久取消意图；UI 显示等待终止。ACK 不切 cancelled，不释放 lease；重载后读 detail 恢复取消中 |
| approvalRespondFingerprint / `ui_respond_approval` | 完整来源+hash/revision+合法 owner/option；accept 需读全，decline 沿拒绝门槛；独立受信任 handler，不回退旧方法 |
| quotaProbe / `ui_probe_quota` | 用户显式 live 认证网络读取/可能 health 更新；不作为后台轮询 |

多个窗口/CLI/MCP 可同时动作；按钮状态只是快照，所有冲突以 daemon 返回与随后 read model 为准。成功回执后重读 detail；错误或响应丢失先按原 task/request/action 身份检查，不能乐观解锁、自动新建任务或换账号。服务启停、登录管理、账号删除改名、workspace 合并删除、任意执行控制和全局审计工作流均不由本契约顺带增加。

## 8. 实施门槛与契约验收

| 里程碑 | 可交付能力 | 不可跳过的门槛 |
| --- | --- | --- |
| M0 | 当前设计与静态 mock；可据架构做未连接 F5 骨架 | 不把 mock 数字/成功提示当 daemon 功能 |
| M1 | legacy 最近 50 条只读，已知任务 wait、结果、事件20/页、旧 patch4000 UTF-16/页 | 明示已载入范围、停止字段缺失、审批 readonly；不自动 probe/reconcile/resume/启动 |
| M2 | **可信可操作首版**：真实资源/任务动作、额度来源、完整审批、不可变历史文件 Diff | capabilities+taskDetail/request 查回；完整审批私有来源/按需读取/fingerprint+持久动作receipt；artifact manifest+base/final blobs+受限读取。缺能力按项禁用；不能用旧弱审批/当前 worktree 宣称完成首版 |
| M3 | ui_list_tasks 稳定全历史过滤/分页/总数、可选全池发现 feed，后续体验完善 | 未实现前保留 recent50 标签；feed 另立版本/预算/恢复契约，不在此假造已有方法 |

实施时至少验证以下边界；它们是未来契约测试/集成验收，不表示本次已运行：

- 旧 daemon、major 不兼容、缺单项能力、切 pool/store、重启 instance、未知响应字段、超帧/超预算；过期连接响应不能影响当前面板。
- 列表同时间排序、过滤后 total、翻页期间任一 task 变化、cursor 条件篡改/跨 pool/过期；不能重/漏行后仍称载全。
- 派发先持久化后丢响应、查回 request ID、NOT_FOUND 与在途派发竞态；不生成新 ID 或自动重发。
- 审批超过旧 4000 字符及 MCP16KiB、未知参数、决策相关脱敏、来源已丢、wrong attempt、其他客户端先处理、native revision 更新、检查后上游竞态、ACK 早于 pending 更新、intent 后崩溃；均不得变成盲批/重复发送。
- live/imported 时间单位未知、无单位 count、真实 0、probe 失败保留旧值、daemon 重启无 live 缓存；不把失败画成额度耗尽。
- 一个 workspace 连续两任务改同文件，旧 task Diff 仍为旧 bytes；累计 base 范围清楚；tracked/untracked、增删空文件、symlink、binary、超大/未知编码、损坏 blob、路径逃逸、失败/取消无快照都诚实降级。
- 取消未确认、未知 lease、核验中断、合格繁忙立即继续与 3 次耗尽；UI 不新增 scheduler 重试、强停、自动解锁或额外模型回合。
