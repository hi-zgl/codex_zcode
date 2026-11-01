# MCP 上下文预算与按需读取

MCP 是本地调度器的精简控制面。Codex 接收任务状态、必要控制标识和按需交付信息；ZCode 会话全文留在本地。所有投影均为确定性代码，不调用模型生成摘要，也不产生额外模型费用。

## 输出预算

- 每次工具调用只返回一个文本块。成功、参数错误、未知工具、daemon 错误和预算错误的最终 JSON 文本均最多 **16,384 UTF-8 字节**，计入 JSON 转义和提示字段。
- 16 KiB 是保护上限，不是默认输出量。少量任务的 `overview`、`wait` 和 `probe_worker` 通常只有几百字节到 1–2 KiB。拥挤的 `overview` 以 6 KiB 为目标，最多预览 8 个账号、8 个 worker、5 个 workspace 和最近 10 个任务。
- `overview` 省略行会给出 `omitted` 计数与本地 CLI 查看提示；计数只针对这次 daemon 响应中额外省略的行。daemon 自身仅返回最近 50 个任务，因此它不是完整历史清单。CLI 可查看较完整的原始 overview（任务仍为最近 50 个）；完整历史需查本地状态库或持久记录。
- `wait` 保留本次请求各任务的控制数据。推荐每批 1–10 个任务，以 `after_revision` 增量等待，避免重复轮询整个池。如果大量或异常长的控制标识无法装入 16 KiB，返回明确的 `OUTPUT_BUDGET_EXCEEDED` 并要求拆分批次。
- 任务、审批等标识以及 `create_workspace` 返回的分支、路径不会截成另一个可操作值。单项控制字符串超过 2,048 UTF-8 字节时，明确返回预算错误。成功变更后的预算错误仍可能表示变更已经完成，应先检查本地状态。

字节上限针对工具文本内容；MCP 的协议包络与 `tools/list` 的静态输入 schema 不计入这个文本预算。它不是 token 数量估计。

## 默认可见信息

| 工具 | 默认输出 |
| --- | --- |
| `overview` / `wait` | 任务 ID、状态、revision、占用/停止标志，以及必要的 worker/workspace 关联和精简控制状态。不会重复 assistant 正文或完整工具参数。 |
| `get_result` | 最多 768 UTF-8 字节的交付总结、变更文件总数和前 5 个文件、验证数量和前 10 个退出码、少量 blocker、是否可取 patch。不会回传验证命令全文、stdout/stderr 或 artifact 路径。 |
| `probe_worker` | 协议版本、认证/兼容状态、余额数字、比例和重置时间。native provider、subscription、context 及 quota 明细对象不回传。 |
| `reconcile_task` / `resume_task` | 任务控制状态、附着/恢复结果、停止证明状态、检查/恢复提示与有限的待审批预览。不会返回用于恢复判断的原始快照。 |
| `get_logs` | 完整事件的有界分页，保留任务 ID、revision、类型和状态。普通事件仅公开选定控制字段；原生错误转成固定诊断类别。审批事件可展开已知操作字段。 |
| `get_diff` | 显式请求的 patch 页，按最终 UTF-8 JSON 预算裁剪，保留继续读取的位置。 |

公开边界按白名单投影，新增 daemon 字段不会自动进入 MCP。原始 `raw`、snapshot、session history、prompt、凭据对象和通用 native payload 从不作为对象透传。允许的少量人类可读字段额外掩码 Bearer、JWT 和常见凭据赋值形式。无法可靠地从任意自然语言识别所有秘密，因此本地持久化和运行时仍应保持原有脱敏边界。

未知的 daemon 方法不会自动注册为 MCP 工具。未知工具与非法参数会在 RPC 之前拒绝；错误文本不会复制参数值、schema 的巨大错误列表或原生异常。已知错误会转成 workspace/worker 占用、请求 ID 冲突、对象不存在、需恢复、审批已失效、认证异常、限流等固定诊断，并指向下一步检查。

## 审批按需审阅

轮询中的审批预览保留完整 `approvalId`、操作类型、工具名和最多 384 UTF-8 字节的摘要，并提供定位 `get_logs` 的参数。摘要的 `reviewComplete` 为 `false`，表示尚未展示操作参数；它不是新的授权门槛。

显式读取审批日志后，已知的 `permission` 操作（Bash、Edit、Write、Read）在所需参数齐全、没有截断、没有脱敏或未知参数时，可以返回 `reviewComplete: true`。每个已知操作文本字段最多展示 1,024 UTF-8 字节。选项只显示必要的 ID、kind 和 label，不透传 native response 对象。

出现未知操作、参数缺失、持久化已先行截断、字段被省略或敏感内容被掩码时，返回 `reviewComplete: false` 和具体的缺失提示。使用本地 CLI、持久日志或原生审批记录补齐信息后，再按已有授权回应；不要求为每次正常短审批启动 GUI，也不根据短摘要自动批准。

## 分页约定

`get_logs` 的 `cursor` 是持久化 revision。MCP 只返回完整事件，`nextCursor` 永远等于实际返回的最后一条事件 revision；空页保留请求 cursor。预算限制导致少返回事件时会明确标记 `hasMore` / `pageTruncated`，并给出下一次调用参数。单条事件的控制数据都无法容纳时返回错误并保留原 cursor，不跳过事件。

`get_diff` 的 `offset` / `nextOffset` 是 JavaScript UTF-16 字符位置，沿用 daemon 定义，**不是 UTF-8 字节位置**。客户端应直接使用返回的 `nextOffset`。按字节裁剪时不会拆开 emoji 的代理对，也不会在文本里插入省略号。涉及凭据脱敏时，`sourceCharacters` 表示本页消耗的原始 UTF-16 字符数，游标依此推进；此时输出文本长度可能与原文不同。

## 推荐调用流程

1. 开始时读一次 `overview`，选定 workspace、worker 和本次 `request_id`。
2. `dispatch_task` 后保存 task ID 和 revision；使用指定 task ID 的 `wait`，传入上次 revision。正常等待无需反复读取 `overview` 或 `get_logs`。
3. 等待审批时，使用预览给出的日志定位读取操作详情，按现有授权作出决定；仅在需要排障时继续读取日志页。
4. 任务结束后读取一次 `get_result`。需要检查变更时再逐页读取 `get_diff`，无需加载会话历史。
5. 连接中断或 daemon 重启后，使用 `reconcile_task` / `resume_task` 检查既有任务。错误或超时不证明任务已停止；不要因文本超预算或响应不确定而自动重新 dispatch。

这些限制保护 Codex 的上下文和控制准确性，不提供会话全文导出接口。需要完整原生记录或被省略的大对象时，在本地查看。
