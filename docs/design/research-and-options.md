# 调研依据与方案比较

[项目入口](../../README.md) · [方案总览](README.md)

更新日期：2026-11-01（北京时间）。本文为设计与调研记录，不代表功能已经实现。

## 证据与验证边界

### 本轮已核实的事实

核查对象为本机已安装的 **ZCode Server 3.16.3**，运行时位于：

```text
~/.zcode/server/releases/3.16.3-linux-x64-5062d871bd2a/runtime/
```

| 事项 | 证据 | 能得出的结论 |
| --- | --- | --- |
| 独立 Server 启动入口 | `~/.zcode/server/bin/zcode` 启动 Node 与 `server-cli.js` | 存在无需启动 Electron 的服务入口 |
| 服务生命周期 | `serve`、`--server-root`、`--daemon`、`status`、`stop`、`restart` 分支 | 可围绕官方服务构建实例管理 |
| 已有服务在线 | 本机进程存在，`GET /api/server-info` 返回版本 3.16.3、协议版本 1、需要鉴权 | 已有服务当时实际在线；不是新 Worker 执行验证 |
| 当前服务地址 | 本轮探测为 `127.0.0.1:38651` | 这是观测值，不是固定端口规范 |
| Server 支持 Start Plan 鉴权分支 | `AccountProviderRequestAuthService.resolveCurrent` 对 `start-plan` 读取 `zcodeJwtToken` | Server 存在对应实现；不等于云端已接受某个账号请求 |
| 内置 Start Plan 配置 | 包含 `account:zai-start-plan` 及模型配置 | 可据此检查实际会话的 provider 和模型选择 |
| 裸 Agent 的独立鉴权限制 | 本机 `zcode.cjs` 的 Standalone 分支要求 `individual-coding-plan` | 不能把裸 Agent CLI 与官方 Server 的账号能力混为一谈 |
| Cockpit 账号注入 | 写入加密凭据、用户资料和 provider 设置 | 可参考其实现，不需要加载整个 Cockpit GUI |
| 本地控制接口 | `/ws`、`/ws/host`、入口令牌、RPC 握手与连接作用域 | 需要协议适配器，不能仅连接端口后发送普通提示词 JSON |

### 前期资料中的记录

旧方案记载过以下现象，本轮未重新发起模型请求复现，也未对原始测试日志进行审计：

| 历史记录 | 本方案的处理方式 |
| --- | --- |
| 通用 API 返回 `1113 Insufficient balance` | 不把通用 API Key 作为活动额度接入主线 |
| 直接请求专属网关返回 `3012` 等错误 | 保留为历史现象；不据此断言所有失败均由特定 WAF 或签名原因造成 |
| 裸 CLI 返回 Standalone 身份无效 | 本机对应鉴权限制有代码依据，仍需区分版本和启动模式 |
| 官方常驻服务完成任务并扣减活动额度 | 作为验证线索，不当作新隔离实例和双账号并发已验收的证据 |

不再采用以下绝对表述：

- 官方服务“天然免受风控”。
- 每账号固定允许 1～2 个并发。
- 多个账号必然带来线性吞吐或固定倍数额度。
- 仅有 token 或启动进程就具备完整任务执行条件。

活动中的“5 亿额度”、适用模型、有效期、账号资格及剩余额度均应以账号当时的实际状态为准。第一版每账号只允许一个活动任务，这是调度策略，不是对云端并发上限的声明。

## 候选运行路径比较

本节比较 ZCode 侧以哪种方式执行任务。Codex 侧的接入形态（MCP、插件、侵入式等）见[系统架构](architecture.md#接入形态决策)。主线以外的可行路径都作为新的运行时适配器接入，不改动调度层。

| 方案 | 图形环境依赖 | 主要工作与限制 | 优先级 |
| --- | --- | --- | --- |
| 官方 Server 多实例 | 服务启动路径无需 Electron/Xvfb | 账号注入、RPC、会话续接、事件与额度验证 | A：首选 |
| 官方 Web 发行版 | 官方文档说明可无 Electron，并支持禁止打开浏览器 | 构建或安装对应发行版，验证接口及活动额度 | B：备选 |
| 社区 `zcode-webui` + 官方运行时 | 设计上可脱离桌面窗口 | 桥接层、运行时版本、多账号适配 | C：参考或备选 |
| 裸 Agent `app-server` / CLI + MCP | 无图形依赖 | 当前独立鉴权路径不能直接复用 Start Plan 结论 | 暂不作为主线 |
| Orca + ZCode TUI | TUI 无图形依赖 | 终端输入注入、账号启动器；仍需解决额度路径 | 参考调度设计 |
| 完整 Electron + 虚拟显示器 | 依赖虚拟图形环境 | 完整桌面运行及自动化适配 | 最后兜底 |

公开官方 README 在本次核查时标注 3.17.1，并描述 `zcode --web --workspace ... --port ... --no-open`。本机 Server 为 3.16.3，**不可直接把新发行版命令套到当前 `/usr/bin/zcode` 上**。实现前应区分桌面启动器、Server 启动器和 Agent CLI。

Xvfb 仅在实测证明任务能力依赖完整桌面环境时引入。它属于兜底适配器，不是系统基础依赖。

## 实现参考与资料来源

### 本地源码

以下行号基于本轮读取版本，升级后应重新定位函数。

| 文件或位置 | 参考内容 |
| --- | --- |
| `references/cockpit-tools/src-tauri/src/modules/zcode_account.rs:793` | 凭据加密写入 |
| `references/cockpit-tools/src-tauri/src/modules/zcode_account.rs:862` | 实例账号注入 |
| `references/cockpit-tools/src-tauri/src/modules/zcode_instance.rs:568` | 桌面隔离环境；主线仅复用适合 Server 的部分 |
| `runtime/server-cli.js:35790` | 服务目录与 dataBaseDir 推导 |
| `runtime/server-cli.js:38907` | proxy-stdio 字节转发 |
| `runtime/server-cli.js:39117` | serve、daemon 与核心进程启动 |
| `runtime/server-core.js:174473` | 当前账号与 Start Plan 校验 |
| `runtime/server-core.js:175262` | Start Plan JWT 鉴权分支 |
| `runtime/server-core.js:119988` | 连接作用域、握手与事件流 |
| `runtime/server-core.js:206242` | HTTP/WebSocket、入口鉴权与动态端口 |

表中 `runtime/` 均指本文“本轮已核实的事实”所列本机 3.16.3 运行时目录；`references/cockpit-tools/` 路径相对项目根目录。

### 公开资料（2026-11-01 核查）

- [ZCode 官方 README](https://github.com/zai-org/ZCode/blob/main/README.en.md)：Web/TUI 无 Electron 运行与发行版说明；不能替代本机版本验证。
- [官方远程开发说明](https://www.zcode.network/en/docs/remote-development/)：远端执行与桌面账号、配置职责；远程模式存在不等于所有桌面依赖已消失。
- [zcode-webui](https://github.com/windviki/zcode-webui/blob/main/README.en.md)：官方运行时的 Web 桥接与后台会话设计参考。
- [mnehmos.zcode.mcp](https://github.com/Mnehmos/mnehmos.zcode.mcp)：裸 Agent 协议、MCP 工具及完成事件处理参考；其运行路径不能直接证明活动额度可用。
- [Orca ZCode TUI 适配](https://github.com/stablyai/orca/blob/main/src/shared/tui-agent-config.ts)：通过运行后的终端输入派发提示词。
- [codex-zcode 架构](https://github.com/alexeygrigorev/codex-zcode/blob/main/ABOUT.md)：以 ZCode 为 Codex fork 后端，与多 Worker 调度目标不同。

公开项目说明和本地代码是选型依据，真实账号任务及额度验证是验收依据。当前方案不承诺固定工期、固定额度、免限流或所有桌面工具可在纯后台使用。

## 历史资料

[前期检索对话原始记录](../research/ChatGPT-检索ZCode解决方案-20261101-1341.md) 为本地归档，不纳入 Git，新克隆的仓库中不可用。保留原文，仅作溯源；其中的旧路径、推测与结论不作为当前实现规范。
