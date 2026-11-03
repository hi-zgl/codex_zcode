# 安装与交付

普通使用安装一个 VSIX 即可获得面板、调度后台、CLI 和 MCP；无需另装本项目的 daemon tgz 或保留开发 checkout。执行侧仍需提供 **Linux、Node.js 24+ 和官方 ZCode 运行环境**，启动执行器前准备账号。扩展不包含 Node、官方 ZCode 或账号。

## 一体 VSIX

开发者构建：

```bash
npm ci
npm --prefix extensions/vscode ci
npm --prefix extensions/vscode run package:vsix
npm --prefix extensions/vscode run package:check
```

生成 `extensions/vscode/zcode-pool-0.1.0.vsix`。使用 **Extensions: Install from VSIX...** 安装到 Linux workspace host；Remote SSH/WSL 时选择执行侧。包内包含编译后的 daemon、CLI、MCP 和运行依赖。显式启动后台或生成 MCP 配置时，扩展校验并准备捆绑运行文件到执行侧扩展存储目录；此过程不运行 npm、不联网下载后台、不执行工作区脚本。

打开 **ZCode Pool: Open Workbench**，确认运行环境及连接目录。默认 `~/.zcode_pool`；可点击“选择连接目录”修改。需要监控时点击“启动后台并连接”：先连接已有服务，只有服务不可达时才启动后台。它不启动执行器或模型；关闭 VS Code 不停止后台或正在运行的任务。

点击“连接 Codex / 生成 MCP 配置”，将生成的 STDIO 配置**一次添加**到同一执行侧的 Codex，再重新连接 Codex。扩展只打开配置说明，不自动写入 Codex 设置，也不能据此断言 Codex 已连接。生成的配置引用共享连接资料文件；面板切换连接目录后，后续 MCP 工具调用会读取新目录，无需重复添加服务器。原目录中的已有任务仍在那里运行，切目录不会迁移任务。通过捆绑入口调用 `zcode_pool_control` 的 `start` 才会明确启动后台。状态查询和任务操作不会自动启动已关闭的后台。

`zcodePool.daemonNodePath` 可指定 Node 24+ 的绝对路径；留空从执行侧 PATH 的绝对目录查找。`zcodePool.daemonCliPath` 留空使用捆绑后台，高级用户可选择已有独立安装的 CLI。完整普通流程见 [VS Code 使用指南](ui/implementation.md)。

## 升级与已有后台

安装或升级扩展不会停止、重启或替换已经运行的旧 daemon。服务仍可连接时会复用原进程；新功能以该后台实际提供的能力为准。需要启用新后台时，先检查和处理当前任务，再由用户显式停止旧 daemon 并启动新后台，不把界面重连当作后台升级。

当前执行存储为 schema 4，总任务、指挥、恢复设置与错误记录由当前后台准备；默认不设全池上限。新 daemon 首次打开 schema 1/2/3 数据库时迁移并保留已有任务、attempt、审批与结果。旧程序无法读取 schema 4；迁移后不要混用旧版后台。历史缺失的文件快照不会补猜。后台停止不会证明原生执行器任务已停止，执行状态未知时仍保留占用；恢复规则见 [任务恢复](recovery.md)。

## 高级选项：独立 daemon 包

不用 VS Code 时，仍可独立安装 CLI、MCP 和调度服务。tgz 使用 Node.js 24 和包内安装的 tsx 加载源码；安装后不需要开发 checkout 或全局 tsx。

开发者在仓库根目录运行 `npm ci`、`npm run typecheck`、`npm test`，然后运行：

```bash
npm run package:daemon
```

生成 `dist/releases/zcode-pool-0.1.0.tgz`。构建不会启动 daemon、模型或 systemd，也不包含账号、运行数据、参考仓库、测试或扩展。包内直接依赖使用构建时 lock 中的精确版本。

把 tgz 复制到 Linux 执行侧，用 Node 24 对应的 npm 安装到固定目录。例如：

```bash
mkdir -p "$HOME/.local/share/zcode-pool-app"
npm install --prefix "$HOME/.local/share/zcode-pool-app" --omit=dev --ignore-scripts /绝对路径/zcode-pool-0.1.0.tgz
"$HOME/.local/share/zcode-pool-app/node_modules/.bin/zcode-pool" --help
```

这里安装运行依赖需要 npm registry 网络，不是自包含离线二进制。生成的安装 lock 应保留，用于后续 `npm ci` 复现。不要把账号或 pool 存入安装目录。

### 独立包启动与连接

先选择本机 pool，在前台启动：

```bash
export ZCODE_POOL_HOME="$HOME/.zcode_pool"
"$HOME/.local/share/zcode-pool-app/node_modules/.bin/zcode-pool" daemon
```

如需使用 VS Code 监控，在执行侧设置相同绝对 pool 路径，再点连接。也可配置外部 CLI 后用“启动后台并连接”，仅在服务不可达时调用该 CLI 的 `daemon-start`。另一个终端使用相同 `ZCODE_POOL_HOME` 可以调用 `overview`、`get_pool_policy`、`set_pool_policy`、`daemon-stop` 等 CLI 命令。

上例将独立包安装到 `~/.local/share/zcode-pool-app`。需要面板使用此安装时，在执行侧 User/Remote Settings 配置 `zcodePool.daemonCliPath`，指向安装包的 `bin/zcode-pool.mjs` 或 npm `.bin/zcode-pool`。这是高级覆盖项，不是普通 VSIX 安装的前置步骤。

长期运行时，安装后的 CLI 也提供 `service-generate` 和 `service-install`，生成的 unit 固定实际 Node、包内 tsx、daemon 入口和安装目录的绝对路径。它们只生成/写入 unit，不会启用服务。审阅 unit 后再按需使用 systemd 用户服务；每个 pool 只选择一种管理方式，不混用手工后台进程和 systemd。升级、迁移安装目录或 Node 后重新生成 unit。

MCP 入口为同一 CLI 的 `mcp` 子命令，使用标准输入输出。手动配置独立包时可设置相同 `ZCODE_POOL_HOME`；也可通过 `ZCODE_POOL_CONNECTION_FILE` 引用共享连接资料。显式设置资料文件后，它优先于 `ZCODE_POOL_HOME`；文件缺失或损坏会报错，不会回退到默认池。UI 读取和 MCP 精简输出边界独立，扩展不会自动改写 Codex 配置。

## 安装包验收

`npm --prefix extensions/vscode run package:check` 检查 VSIX 白名单和捆绑运行文件；`test:installed` 在 checkout 外安装实际 VSIX，验证内置后台、共享连接和生成的 MCP 配置。独立包使用 `npm run test:daemon-package`，在临时目录安装实际 tgz，检查 CLI、unit 绝对路径、无账号 daemon RPC 与正常退出。这些检查不导入账号、不启动 Worker、不发送模型请求，不写用户 Codex 配置；测试安装在结束后清理。
