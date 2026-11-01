# 独立 daemon 安装包

daemon 与 VS Code 扩展分别安装。daemon 包包含 CLI、MCP 和调度服务，使用 Node.js 24 及包内安装的 tsx 加载源码；安装后不需要开发 checkout 或全局 tsx。官方 ZCode runtime 仍须在执行侧单独安装，启动 Worker 前准备账号。

## 构建与安装

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

## 启动与连接

先选择本机 pool，在前台启动：

```bash
export ZCODE_POOL_HOME="$HOME/.zcode_pool"
"$HOME/.local/share/zcode-pool-app/node_modules/.bin/zcode-pool" daemon
```

在 VS Code 扩展的执行侧设置同一个绝对 pool 路径，再点连接。扩展不替你启动服务。另一个终端使用相同 `ZCODE_POOL_HOME` 可以调用 `overview`、`daemon-stop` 等 CLI 命令。关闭 VS Code 不停止 daemon。

长期运行时，安装后的 CLI 也提供 `service-generate` 和 `service-install`，生成的 unit 固定实际 Node、包内 tsx、daemon 入口和安装目录的绝对路径。它们只生成/写入 unit，不会启用服务。审阅 unit 后再按需使用 systemd 用户服务；每个 pool 只选择一种管理方式，不混用手工后台进程和 systemd。升级、迁移安装目录或 Node 后重新生成 unit。

MCP 入口为同一 CLI 的 `mcp` 子命令，使用标准输入输出。UI 读取和 MCP 精简输出边界独立，扩展不会自动改写 Codex 配置。

## 安装包验收

开发者运行 `npm run test:daemon-package`，在 checkout 外的临时目录安装实际 tgz，检查 CLI、unit 绝对路径、无账号临时 daemon 的 RPC 与正常退出。测试不导入账号、不启动 Worker、不发送模型请求，不写用户全局配置；临时安装在测试结束后清理。
