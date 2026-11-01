# 开发与运行

[项目入口](../README.md) · [架构设计](design/architecture.md)

当前代码为 Linux / Node.js 24 原型，已通过[本机真实任务与双账号并行验证](validation/2026-11-01.md)。官方适配器只接受已核对的 ZCode Server 3.16.3 / server protocol 1；其他版本拒绝自动兼容。任务只指定 Start Plan，不自动回退到付费 provider。

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

## 中断与恢复

MCP 关闭不会关闭 daemon；daemon 退出不会主动停止 Worker。重新启动 daemon 后，未确认的任务进入 interrupted，保留占用且不重新派发。

```bash
npm run cli -- reconcile_task '{"task_id":"替换为taskId"}'
```

对账使用新连接上的原生会话快照。只有匹配原命令的终止回合且没有活动执行时才释放占用。历史窗口没有该回合、服务不可达或缺少会话标识时继续保留现场。当前不自动恢复旧任务的实时事件泵，不因超时或 502 自动发送“继续”。

`cancel_task` 发起取消后仍需等待终止事件；`stop_worker` 在存在活动或未知执行任务时拒绝停止。守护服务单实例锁遇到崩溃遗留时会拒绝启动并给出检查提示，不自动删除可能仍被使用的 socket/锁。

## MCP 接入

先启动 daemon，再以项目根目录作为工作目录运行 MCP：

```bash
node --import tsx src/mcp/main.ts
```

stdio 仅承载 MCP 协议；诊断输出使用 stderr。实际 Codex 配置可将 node、tsx loader 和入口文件写为绝对路径；所有入口使用相同 `ZCODE_POOL_HOME`。本项目不会自动修改用户的 Codex 全局配置。

工具名以 `zcode_` 开头，当前包括 overview、start_worker、stop_worker、probe_worker、create_workspace、dispatch_task、wait、get_result、get_diff、get_logs、respond_approval、cancel_task、reconcile_task。

## 当前限制

- Linux `/proc` 用于核验 PID、启动时间、进程组、路径和实例标记；尚不支持 Windows/macOS 进程管理。
- 账号刷新、队列自动调度、跨账号交接、自动合并、后台任务重新附着仍需后续实现。
- 分支/worktree 防止无意覆盖，不构成文件访问沙箱。
- 原生会话快照是当前尾部窗口，不保证覆盖完整历史；无法证明停止时不释放占用。
- 帐号凭据、运行产物和日志只保存在本地忽略目录中；不要提交它们。
