# Linux 用户后台服务

[开发与运行](development.md) · [项目入口](../README.md)

本项目提供 systemd `--user` unit 生成和安装命令，适用于 Linux、Node.js 24 及已执行 `npm ci` 的固定项目目录。安装命令只写 unit 文件，不调用 `systemctl`，不启用服务，不修改 Codex 配置、linger 或 logind 策略。下面的启用和停止操作由操作者按需执行。

## 普通使用的启动与收工

使用 VS Code 扩展时，点击“启动后台并连接”启动管理后台；在资源页单独启动 Worker。日常由指挥按[使用约定](codex-workflow.md)通过 `zcode_pool_control` 的 `start` 明确开工，高层交办自动准备 Worker。状态查询不会启动后台。

本轮 Work 验收并确认完成后，指挥自动尝试 `shutdown`，传 `only_if_idle: true`。程序关闭新工作准入，等待已接纳的交办或推进操作完成，再检查全部 Task 占用与全库活动 Work，覆盖其他指挥及待资源、验收、待决定的工作。存在占用或活动 Work 时拒绝，恢复正常服务，不停止 Worker；自动收工不得改传 `false` 绕过拒绝。

用户明确停工、面板“收工：停止实例与后台”和 CLI `shutdown-pool` 保持原手工语义，`only_if_idle` 省略或为 `false` 时不要求所有 Work 已完成，但仍拒绝任何实际或未知 Task 占用，不自动取消。无占用才依次停止 Worker，全部成功后关闭后台。账号、任务及工作区保留，未完成 Work 在下次明确启动后续接。部分实例无法停止时后台继续运行，应刷新检查。

关闭 VS Code、断开面板或指挥异常退出都不表示完工，后台不会据此自动收工，也没有新增空闲超时退出机制。升级扩展不会让旧 daemon 自动加载新规则；旧后台不支持新参数时会拒绝请求，应先安全收工，再明确启动新版。未提供 `poolLifecycle` 能力的旧后台仍需先在空闲时升级。

`daemon-stop` 是高级的“仅停止调度后台”，仍保留 Worker，与收工不同。以下 systemd 方式仍是可选高级部署，不需要为了普通启动/收工额外安装服务。

## 生成并检查

在项目根目录执行：

```bash
node --import tsx src/cli/main.ts service-generate > /tmp/zcode-pool.service
systemd-analyze verify --user /tmp/zcode-pool.service
cat /tmp/zcode-pool.service
```

unit 固定生成时使用的 Node 可执行文件、tsx loader、daemon 入口、项目工作目录和 pool 绝对路径；无需登录 shell、nvm 初始化或当前终端的工作目录。默认 pool 是 `ZCODE_POOL_HOME`，未设置时为 `~/.zcode_pool`。CLI、MCP 与服务必须使用同一个 pool。

可显式覆盖所有路径，例如：

```bash
node --import tsx src/cli/main.ts service-generate \
  --name zcode-pool.service \
  --node /绝对路径/node \
  --loader /绝对路径/项目/node_modules/tsx/dist/loader.mjs \
  --entry /绝对路径/项目/src/daemon/main.ts \
  --working-directory /绝对路径/项目 \
  --pool-home /绝对路径/pool
```

相对参数在生成时转换为绝对路径。路径中的空格、引号、百分号、美元符号和 Unicode 按 systemd 各指令的解析规则处理；loader 使用编码后的 `file:` URL。`ExecStart` 的 `:` 前缀关闭环境变量展开，`%` 以 `%%` 保存。`WorkingDirectory` 不使用 shell 引号，末尾 `/.` 保留路径末尾的空格或反斜杠。systemd 不接受可执行文件路径中的引号或反斜杠，Node ES module 路径也不接受反斜杠，因此对应参数会明确拒绝；控制字符及超长 Unix socket 路径同样拒绝。pool 路径应尽量简短，最终 socket 路径最多 107 字节。

unit 直接以前台方式运行 `src/daemon/main.ts`，由 systemd 跟踪主进程。`Type=exec` 表示 Node 已成功执行；RPC 完成初始化以 `overview` 成功为准。`Restart=on-failure` 在异常退出后等待 3 秒重启，60 秒内最多启动 5 次；正常停止不自动重启。日志进入用户 journal，文件权限掩码为 `0077`。

systemd 的 journal 保留由系统配置决定；`daemon-start` 文件日志、Worker 受管日志及只读 `storage-status` 的范围见[存储布局](storage-layout.md#日志保留与只读统计)。

## 安装与启用

先写入临时目录检查安装结果也可以：

```bash
node --import tsx src/cli/main.ts service-install --unit-dir /tmp/zcode-pool-units
systemd-analyze verify --user /tmp/zcode-pool-units/zcode-pool.service
```

写入当前用户的 unit 目录：

```bash
node --import tsx src/cli/main.ts service-install
```

默认目录是 `$XDG_CONFIG_HOME/systemd/user`，未设置 `XDG_CONFIG_HOME` 时为 `~/.config/systemd/user`。安装时核验 Node、loader、入口文件和工作目录存在且可访问，以 `0600` 原子写入 unit。目标存在时拒绝覆盖；确认更新后使用 `service-install --replace` 原子替换普通文件。目标是符号链接或其他非普通文件时，即使指定 `--replace` 也拒绝。`--unit-dir` 可指定部署目标目录，`--name` 可为不同 pool 使用不同服务名。

检查 unit 后，操作者执行：

```bash
systemctl --user daemon-reload
systemctl --user enable --now zcode-pool.service
systemctl --user status zcode-pool.service
node --import tsx src/cli/main.ts overview
journalctl --user -u zcode-pool.service -f
```

若使用自定义 pool，运行客户端前同样设置 `ZCODE_POOL_HOME`。每个 pool 只选一种管理方式；启用 systemd 后，通过 `systemctl --user start/restart/stop` 管理 daemon。`daemon-start` 仍可用于手动模式，且从其他工作目录调用时也使用绝对 loader、入口与固定项目工作目录。

更新 Node 版本、移动项目目录或更改 pool 后，重新生成或安装 unit，并执行 `daemon-reload` 和 `restart`。达到启动次数限制后，先排查 journal 中的失败原因，处理后可执行 `systemctl --user reset-failed zcode-pool.service` 再启动。

停止与禁用：

```bash
systemctl --user stop zcode-pool.service
systemctl --user disable zcode-pool.service
```

`daemon-stop` 也会正常退出 daemon，因退出码为零，`Restart=on-failure` 不会将其立即拉起。删除服务时只删除安装输出中的确切 unit 文件，再执行 `daemon-reload`；不要删除 pool 中的账户、任务数据库或 Worker 目录。

## Worker 与用户会话

daemon 停止或崩溃不会主动终止官方 Worker。为保持这一语义，unit 使用 `KillMode=process`，只向 daemon 主进程发信号。systemd 可能对该设置提示其不符合完整控制进程组的推荐方式；Worker 的停止仍通过核验进程身份后的 `stop_worker` 完成。

`KillMode=process` 不能保证 Worker 跨用户 manager 退出、注销、系统重启或 logind 清理存活；后台常驻还取决于该机器的用户会话和 linger 策略。项目不会自动修改这些系统设置。生产化若需由 systemd 完整管理所有进程，应进一步把 Worker 划分为独立的受管服务或 scope。

## 崩溃遗留锁恢复

新 daemon 在 `scheduler/daemon.lock` 中记录 PID、Linux `/proc` 启动时刻、随机实例标识，以及绑定 socket 的设备号、inode 和 ctime。一个按 pool 真实绝对路径哈希命名的 Linux abstract Unix socket 在内核中维持互斥，覆盖整个 daemon 生命周期；进程被 `SIGKILL` 后该互斥自动释放，不产生新的锁文件遗留。不同符号链接路径指向同一 pool 时仍竞争同一个互斥。

只有原 PID 的 `/proc` 项已消失、`kill(pid, 0)` 同样确认不存在、socket 文件身份匹配且连接明确返回 `ECONNREFUSED` 时，后继 daemon 才在互斥下重新核验并清理遗留 socket 和锁。并发启动只能有一个 owner。正常关闭同样核对锁文件身份和完整内容，保留外部替换的锁。socket 被外部替换时拒绝执行会触发 libuv 路径删除的关闭操作，保留替换的 socket 和锁供检查；原监听句柄在进程退出时由内核释放。

以下情况保留现场并拒绝自动回收：

- 原 PID 仍存在，包括 PID 已复用但启动时刻不同的情况；权限不足或无法确定进程状态。
- socket 仍可连接、连接状态不确定，或 socket 身份与锁内记录不同。
- 无锁的预存 socket、指向普通文件的 socket 路径、损坏或未完整写入的锁。
- 旧格式 `{pid,start}` 遗留锁同时带有 socket，或初始化中断后无法证明 socket 所有权。旧格式锁在 PID 确认不存在且没有 socket 时可恢复。

遇到这些错误时，先停止对应服务的重试，检查 journal、锁记录、相关 `/proc/PID/stat` 与 socket 的监听者，并确认 pool 路径及管理者。只有人工确认锁和 socket 均已无主后，才处理报告中的确切遗留文件；不要按报错提示批量清理整个 scheduler 目录。上述互斥用于同一 Linux 主机上的本地 pool，不提供跨主机共享文件系统协调，也不能防御同一用户下恶意进程任意改写运行文件。

本轮验证使用临时目录、真实本地 daemon 的 SIGKILL/重启及多进程竞争，无需调用模型；未启用本机 systemd 服务或改写用户全局配置。
