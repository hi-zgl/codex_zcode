# 构建与验证脚本

[项目入口](../README.md) · [运行指南](../docs/development.md)

`live-*.ts` 用于显式发起真实 ZCode 任务，会消耗所选账号额度，不由 `npm test` 执行。安装包脚本不导入账号、不启动 Worker，也不发模型请求。

| 脚本 | 用途 | 前置条件 |
| --- | --- | --- |
| `live-runtime.ts` | 单实例协议、审批、文件修改、同会话续接 | 设置 `ZCODE_POOL_LIVE=1`，显式传入 `--server-root`、`--workspace`、`--artifacts`；使用独立测试目录 |
| `live-coordinator.ts` | daemon 调度 a/b 两个 Worker 并行修改及外部测试 | 设置测试用 `ZCODE_POOL_HOME`，已有就绪 a/b 实例、已启动 daemon |
| `package-daemon.mjs` | 生成独立 daemon/CLI/MCP npm tgz | Node 24、已安装开发依赖；`npm run package:daemon` |
| `daemon-package-smoke.mjs` | 在 checkout 外安装实际 tgz，验证 CLI、服务路径、空池 RPC 与退出 | `npm run test:daemon-package`；安装运行依赖需要网络 |

脚本从项目根目录以 `node --import tsx scripts/<脚本名>.ts` 启动。重复运行前检查已有会话和工作区，不把生产代码目录当作测试 fixture。

常规不消耗模型额度的检查为 `npm run typecheck` 与 `npm test`。
