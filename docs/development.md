# 源码开发与运行

[项目入口](../README.md) · [架构](design/architecture.md) · [当前验证](validation/current.md)

普通使用安装一体 VSIX，见[工作台指南](ui/implementation.md)。本页仅供源码开发和高级 CLI。执行侧为 Linux / Node.js 24+，官方 Server 3.16.3 / protocol 1；其他版本不自动兼容。

## 安装与本地检查

```bash
npm ci
npm run typecheck
npm test
npm run cli -- help
```

扩展独立安装依赖和构建，命令见[UI 开发](ui/implementation.md#源码与-f5)。默认测试使用脱敏 fixture、临时目录和 fake runtime，不发送模型请求；真实模型检查需要明确选择账号与测试目标。

## 明确启动与本地 CLI

```bash
npm run cli -- daemon-start
npm run cli -- overview
npm run cli -- storage-status
npm run cli -- import-accounts /绝对路径/账号导出.json
npm run cli -- get_pool_policy '{}'
```

默认池为 `~/.zcode_pool`。手动 CLI 和源码 daemon 可用 `ZCODE_POOL_HOME` 指定池。安装版 MCP 使用 `ZCODE_POOL_CONNECTION_FILE` 共享连接资料；显式资料文件优先，缺失或损坏直接报错，不回退默认池。

`storage-status` 是无需 daemon 的只读本地统计，输出逻辑字节数和保留策略；统计边界与日志轮转见[存储布局](storage-layout.md#日志保留与只读统计)。

CLI 接受方法名和 JSON 参数，参数合同在 `src/shared/methods.ts`。日常高层方法为 `submit_work`、`wait_work`、`advance_work`，按需查看用 `inspect`，池控制用 `pool_control`。账号、Worker、目录、逐次派发、审批、取消与恢复等高级方法保留给本地操作，不要求指挥每次逐项调用。

```bash
npm run cli -- set_pool_policy '{"max_concurrent_tasks":2}'
npm run cli -- set_pool_policy '{"retry_interval_ms":5000,"recovery_wait_ms":120000,"silence_check_ms":900000}'
```

全池上限 0 暂停新派发，`null` 不限制，降低不停止已有执行。高层工作进入公平资源队列；高级 `dispatch_task` 达到上限时拒绝，不应创建重复任务绕过限制。资源不足必须取得用户确认后才能少量推进。

隔离目录依赖已有 Git 基线；程序封装 worktree、账号选择、固定交付和整合。默认核验只执行 `git diff --check`，功能测试由指挥明确指定，验收和阶段完成另行确认。

停止单个 daemon 用 `daemon-stop`，可能仍留下官方 Worker；收工用 `shutdown-pool`，有活动或未知占用则拒绝。可选 systemd 部署见[后台服务](service.md)，每个池只用一种进程管理方式。

## MCP 源码入口

先明确启动同一池的 daemon，再运行：

```bash
node --import tsx src/mcp/main.ts
```

stdio 只承载 MCP，诊断走 stderr。手动配置用绝对 Node、loader 和入口路径，保持相同执行侧与池；本项目不自动修改 Codex 全局配置。五个日常工具及责任见[指挥约定](codex-workflow.md)，返回预算见[上下文策略](context-policy.md)。

## 升级与存储

现有执行数据库 schema 4，新增总任务、指挥、设置与错误表由当前后台准备。新程序会迁移早期库，保留执行、审批和交付；缺失旧快照不补造。不要让旧版后台与当前版本交替管理同一池。

升级扩展、重新连接或生成配置不会自动重启旧 daemon；先处理现有任务，再显式切换。运行数据含绝对路径、worktree 和会话引用，迁移与备份见[存储布局](storage-layout.md)。长任务与真实异常边界以[当前验证](validation/current.md)为准。
