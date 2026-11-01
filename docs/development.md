# 开发与运行

[项目入口](../README.md) · [架构设计](design/architecture.md)

当前代码为 Linux / Node.js 24 原型，已通过[本机真实任务与双账号并行验证](validation/2026-11-01.md)。官方适配器只接受已核对的 ZCode Server 3.16.3 / server protocol 1；其他版本拒绝自动兼容。任务只指定 Start Plan，不自动回退到付费 provider。

可视化操作见 [VS Code 扩展运行与 F5 测试](ui/implementation.md)，不依赖开发 checkout 的后台安装见[独立 daemon 包](distribution.md)。扩展与 CLI/MCP 共享同一调度服务，UI 不会自动把完整审批或文件内容送入 Codex 上下文。

UI 功能将持久存储升级到 schema 3，保留原有任务/attempt，并增加 store 身份、完整审批记录和答复回执；旧任务缺失的文件快照不会补猜。新 daemon 首次打开旧 schema 1/2 数据库时迁移，旧版 daemon 无法读取 schema 3；升级后不要混用旧后台程序。

## 安装与检查

在项目根目录执行：

```bash
npm ci
npm run typecheck
npm test
npm run cli -- help
```

测试包含 SQLite 崩溃恢复与跨进程占用竞争、协议编码和事件解析、账号加密、工作树快照，以及真实 MCP stdio 到 daemon 的本地往返。Mock 协议测试通过不等于真实模型任务成功。

## 启动本地服务

```bash
npm run cli -- daemon-start
npm run cli -- overview
npm run cli -- import-accounts data/accounts/*.json
```

默认状态目录为 `~/.zcode_pool`。通过 `ZCODE_POOL_HOME` 可为整套调度器指定另一个目录，所有 CLI/MCP 入口需使用相同值。Unix socket 有长度限制，目录应简短。

账号导入只通过本地 CLI 暴露，不作为 MCP 工具。返回账号别名和导出快照中的额度；快照不是实时余额。

用 overview 中的账号别名启动实例：

```bash
npm run cli -- start_worker '{"worker_id":"worker-a","account_id":"account-替换为实际别名"}'
npm run cli -- probe_worker '{"worker_id":"worker-a"}'
```

该操作不启动 Electron，不使用显示器环境。启动成功只证明实例就绪，不能证明账号有效、模型可用或额度可用。`probe_worker` 会建立鉴权连接并读取官方 Start Plan 额度，不发起模型回合。

纯后台新目录还需要本机设备初始化状态：启动器仅复制当前真实机器已有的 deviceMid 到隔离目录，不创建或轮换设备身份，不修改默认客户端状态。如果本机尚无该状态，应先用官方客户端完成初始化。

## 工作区与任务

```bash
npm run cli -- create_workspace '{"repository":"/绝对路径/目标仓库","base_ref":"main"}'
```

仓库须已初始化、有提交且工作树干净；基线名称按实际仓库填写。创建后使用返回的 workspaceId：

```bash
npm run cli -- dispatch_task '{"workspace_id":"替换为workspaceId","worker_id":"worker-a","request_id":"unique-request-001","prompt":"检查项目并完成约定的小任务","session":"new","mode":"build","verify_commands":[{"command":"npm","args":["test"],"timeout_ms":60000}]}'
npm run cli -- wait '{"task_ids":["替换为taskId"],"timeout_sec":0}'
npm run cli -- get_result '{"task_id":"替换为taskId"}'
```

- 派发返回 taskId，不代表任务完成。同一 request_id 与相同参数重复调用返回原任务，参数变化则报错。
- mode 默认 build；审批由 `respond_approval` 回复，或使用项目明确授权的其他模式。程序不会自动批准全部请求。
- `wait` 可传 `after_revision`，单次最长等待 25 秒；省略 revision 为即时快照。
- `verify_commands` 是调用者明确选择的本地命令，无 shell 拼接。未提供时仅执行 `git diff --check`，不代表功能测试或项目验收通过。
- diff 快照固定为该任务结束时工作区相对 workspace 起始 commit 的累计差异；后续任务不会改写旧快照。未跟踪文件另存产物，不自动塞入 patch。
- 原型不提供自动合并或清理工具，代码集成仍由调用方审查并执行。

停止 daemon 可使用 `npm run cli -- daemon-stop`；它不会主动停止官方 Worker。

## 模型繁忙时立即继续

派发参数 `busy_retry_limit` 默认 3，可设为 0 关闭，上限 10。确认当前回合因模型繁忙终止且无活动执行后，调度器保留原会话、账号、模型及工作区，立即发送“继续”，不添加退避等待，也不重发原任务全文。频率限制、额度不足、风控、鉴权和未知错误不触发。发送状态不明时仅对账，不重复发送。见 [繁忙自动续跑](busy-recovery.md)。

## 中断与恢复

MCP 关闭不会关闭 daemon；daemon 退出不会主动停止 Worker。重新启动 daemon 后，未确认的任务先进入 interrupted，再尝试核对并重新订阅原回合；没有足够证据时保留占用且不重新派发。

```bash
npm run cli -- reconcile_task '{"task_id":"替换为taskId"}'
```

对账使用新连接上的原生会话快照。只有匹配原命令的终止回合且没有活动执行时才释放占用。历史窗口没有该回合、服务不可达或缺少会话标识时继续保留现场。`resume_task` 可以重新附着已核实的原活动回合；启动时也会尝试恢复。原回合已终止且从未进入本地核验时，可完成核验与快照。曾进入核验后中断的任务需检查本地进程与工作区，不自动重跑命令。详见 [任务恢复](recovery.md)。不因超时或 502 自动发送“继续”。

`cancel_task` 发起取消后仍需等待终止事件；`stop_worker` 在存在活动或未知执行任务时拒绝停止。守护服务仅在能证明旧进程已退出、socket 属于旧进程且没有活动监听时回收遗留锁；无法证明时拒绝启动并给出检查提示。后台部署支持生成与安装 systemd 用户 unit，见 [后台服务](service.md)。

## MCP 接入

先启动 daemon，再以项目根目录作为工作目录运行 MCP：

```bash
node --import tsx src/mcp/main.ts
```

stdio 仅承载 MCP 协议；诊断输出使用 stderr。实际 Codex 配置可将 node、tsx loader 和入口文件写为绝对路径；所有入口使用相同 `ZCODE_POOL_HOME`。本项目不会自动修改用户的 Codex 全局配置。

工具名以 `zcode_` 开头，当前包括 overview、start_worker、stop_worker、probe_worker、create_workspace、dispatch_task、wait、get_result、get_diff、get_logs、respond_approval、cancel_task、reconcile_task、resume_task。

MCP 返回独立的白名单精简视图，不直接回传 daemon 原始对象或完整会话。默认仅提供控制状态、简短结果和核验信息；日志与差异按需读取。具体预算见 [上下文输出策略](context-policy.md)，使用流程见 [主会话调度约定](codex-workflow.md)。

## 当前限制

- Linux `/proc` 用于核验 PID、启动时间、进程组、路径和实例标记；尚不支持 Windows/macOS 进程管理。
- 账号刷新、队列自动调度、跨账号交接与自动合并仍需后续实现；重启重新附着已有实现，真实长任务与异常恢复仍需进一步验证。
- 分支/worktree 防止无意覆盖，不构成文件访问沙箱。
- 原生会话快照是当前尾部窗口，不保证覆盖完整历史；无法证明停止时不释放占用。
- 帐号凭据、运行产物和日志只保存在本地忽略目录中；不要提交它们。
