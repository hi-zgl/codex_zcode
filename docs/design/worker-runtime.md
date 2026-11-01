# 账号隔离与实例运行

[项目入口](../../README.md) · [方案总览](README.md)

更新日期：2026-11-01（北京时间）。本文为设计与调研记录，不代表功能已经实现。

## 账号与实例隔离

### 账号池

`data/accounts/` 为动态账号导入目录。以导入时的去重结果和官方运行时探测为准，不根据文件名、文件数量或导出余额快照判定当前可用性。开发验证结果另记，避免方案固定某次导出清单。

导入要求：

1. 支持多个文件，按 provider 与稳定用户标识去重。
2. 保留 provider、用户资料、`access_token`、`zcode_jwt_token`，以及导出中实际存在的刷新与过期字段。
3. 凭据由 daemon 的 `accounts` 模块处理并加密保存，MCP 仅返回不含凭据的账号别名、健康状态与必要额度信息。
4. 启动任务前检查账号归属、provider 与可用模型；不能静默回退到付费 provider。
5. 一个账号默认绑定一个活动 Worker；账号变更应在任务停止后完成，并明确处理原会话归属。

账号健康状态：

| 状态 | 含义 | 是否参与调度 |
| --- | --- | --- |
| `available` | 凭据有效，最近无异常 | 是 |
| `cooling` | 近期出现限流或服务端错误，冷却截止时间未到 | 否，冷却结束后恢复 |
| `blocked` | 出现风控响应 | 否，需人工解除 |
| `invalid` | 凭据失效或身份无效 | 否，需重新导入 |
| `unknown` | 尚未验证 | 仅允许验证类任务 |

状态转换规则见[故障分类与处理](task-orchestration.md#故障分类与处理)。按账号限制请求速率，避免多个任务的重试在短时间内集中打到同一账号。

### 持久目录

采用持久目录，避免 `/tmp` 清理导致会话或状态丢失：

```text
~/.zcode_pool/
├── config.toml                   # 全局配置：限流、退避、超时、返回大小上限
├── scheduler/
│   ├── state.db                  # SQLite 状态库
│   ├── daemon.sock               # JSON-RPC 本地接口，权限 0600
│   ├── daemon.lock               # 单实例锁
│   ├── daemon.log
│   └── events/                   # 每个任务一份归一化事件 JSONL
├── accounts/                     # 加密后的账号凭据，权限 0700
├── workers/
│   └── worker-a/
│       ├── data/
│       │   └── .zcode/
│       │       ├── v2/
│       │       │   ├── credentials.json
│       │       │   └── setting.json
│       │       └── server/
│       │           └── run/      # 状态、锁、入口令牌、control.sock
│       ├── logs/                 # Server 标准输出与诊断日志
│       └── artifacts/            # 摘要、核验记录、补丁、交接摘要
└── workspaces/
    └── <workspace_id>/           # git worktree，与账号凭据分开
```

上述为关键目录示意；其余会话数据库、缓存等由运行时创建，实测记录其落盘位置，检查是否串写真实主目录。项目级配置（核验命令、执行策略、自动批准规则）由 daemon 在创建 Workspace 时从目标仓库或全局配置读取，具体文件位置在实现时确定。

**路径必须配对：**

```text
ZCODE_DATA_BASE_DIR = <worker_root>/data
--server-root      = <worker_root>/data/.zcode/server
```

本机 `inferDataBaseDir` 遇到 `.zcode/server` 结构会推导出上层 data 目录；否则返回 server root 本身。启动核心进程时又会用该结果设置 `ZCODE_DATA_BASE_DIR`。因此不能随意把 `--server-root` 指向 `<worker_root>`，同时假设凭据仍从 `<worker_root>/data` 读取。

### 凭据与配置

参考 Cockpit 的 `inject_to_instance_root`、`write_account_to_credentials_path` 和 `write_auth_mode_to_settings_path`：

- 同时写入 OAuth token、ZCode JWT、用户资料与 provider 激活设置。
- 凭据加密和运行时解密必须采用一致的密钥派生条件。
- 若显式使用 `ZCODE_CREDENTIAL_SECRET`，由启动器通过子进程环境传入，并与写入端保持一致；不要输出到日志。
- 主线不默认重定向 `HOME`，先验证专用数据变量覆盖范围；如果必须重定向，则同步处理密钥、缓存和工具配置依赖。
- 纯 Server 模式无需创建 Electron profile；仅在桌面兜底方案中设置 `ZCODE_DESKTOP_*` 变量。
- 凭据目录设为仅当前用户可访问，凭据文件不得写入项目提交或任务摘要。

## 服务启动与协议接入

### 启动形式

以下只展示已核实的启动参数组合。执行前须完成目录准备、账号注入、匹配的凭据密钥配置以及运行时资源可用性检查；它不是已验收的双账号启动脚本。

```bash
worker_root="/home/zgl/.zcode_pool/workers/worker-a"

ZCODE_DATA_BASE_DIR="$worker_root/data" \
  /home/zgl/.zcode/server/bin/zcode serve \
  --server-root "$worker_root/data/.zcode/server"
```

该形式在调用进程中常驻，无需终端窗口，由 daemon 的 `supervisor` 模块启动和管理。

也可使用 `--daemon`，但默认路径可能注册系统用户服务。本机代码支持 `ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1` 选择非服务注册路径；是否采用应由原型验证决定，避免调度服务与系统服务管理器重复管理同一实例。

### 进程管理与对账

- `supervisor` 以独立进程组启动 `zcode serve`，标准输出写入该 Worker 的 `logs/`，并在状态库登记 PID、进程启动时间和 server root。
- 判断进程身份时同时比对 PID 与进程启动时间，防止 PID 复用导致误判或误杀。
- daemon 启动时逐个对账：进程存活且 `server-info` 版本在适配器白名单内，就接管；进程存活但版本不符，就停止派发并上报；进程不存在，就把 Worker 标为已停止，其上的活动任务进入对账流程。
- Worker 异常退出后按上限自动重启；重启后先用 `syncHistory` 核对会话状态，再恢复事件订阅。
- 健康检查只用于发现故障，不作为任务完成依据。
- 停止 Worker 前要求其上没有活动任务；强制停止要显式指定，并把任务标为 `interrupted`。

独立 server root 的发布信息、Agent 资源定位与升级行为需要验证，不能假定仅创建空目录就一定完成全部初始化。不要在验证过程中覆盖现有默认服务或自动升级全局运行时。

### 连接发现与鉴权

- 从该 Worker 的 `run/status.json` 或控制接口读取实际 host、port 与状态，再以实时请求确认服务就绪。
- 不把 38651、38652 写死；保存的端口、PID 或状态文件都可能过期。
- 入口令牌只用于本地连接，不返回给 Codex。
- `/ws` 和 `/ws/host` 的角色不同，后者还有 host capability 校验；根据任务所需能力选择连接模式，遵循对应握手。
- `proxy-stdio` 是到服务端口的字节转发，不应误认成现成的 MCP 或裸 Agent JSONL 接口。

### 协议适配器

适配器负责：版本检查、握手、工作区绑定、创建或续接会话、发送任务、订阅事件、处理审批、取消任务、断线恢复与历史同步，并把原始协议消息转换为归一化事件和错误分类。接口草案见[系统架构](architecture.md#运行时适配器接口)。

阶段 1 实现适配器时，同步录制真实协议交互（握手、正常回合、审批、限流、取消、断线），脱敏后作为 Fake 适配器的回放样本和协议契约测试的基准。

须明确区分：

- 服务进程 ready；
- 任务被接收；
- 模型回合完成；
- 开发任务通过验收。

命令被接收不能作为任务完成依据。只有终止事件和可核验结果才能驱动完成状态。浏览器、系统交互等可能依赖额外服务的工具，应在所需任务中单独验证，不能由纯代码任务成功推断全部桌面能力可用。
