# 开发、F5 与验收方案

状态：**仅设计**；扩展目录/manifest/launch/build/VSIX 尚未创建，当前 F5 不可用。JSON 是未来模板，未实跑。见 [架构](extension-architecture.md) 与 [API 边界](integration-contract.md)。

## 交付顺序与依赖

| 阶段 | 完成条件 | 不能冒称的能力 |
| --- | --- | --- |
| M0：本轮设计 | 文档、消息/API/状态与验收边界完整，JSON 示例可解析 | 原型不是已安装扩展，未经过真实 Webview/Host 测试 |
| M1：扩展骨架与旧服务只读 | 独立 package、build/watch、两套 F5；mock 完整演示；真实连接 legacy-readonly，仅 overview/get_result/get_logs/get_diff/wait 投影 | 只展示近期 50 条；无完整审批答复、不可变原生 Diff、全历史/总数；不调用 reconcile/resume/probe 或其他写方法 |
| M2：可信可操作首版 | 能力协商、安全任务详情、按 request_id 恢复查询、额度来源/时效、完整审批分块与 hash/revision 答复、不可变 base/final 工件读取；完整任务闭环与 standalone VSIX 验收 | 旧历史缺少完整审批/快照时明确 unavailable，不通过当前工作目录伪造历史；没有合并、强停、强制解锁 |
| M3：规模与维护 | 稳定全历史任务分页、过滤/变更发现扩展、资源分页；单独设计 daemon 启动管理或账户/workspace 维护 | 不能用本地过滤或重复 overview 宣称已具备服务端完整搜索 |

M2 含导入、创建 workspace、Worker 启停/probe、任务派发/核对/恢复/取消、审批和结果；均受 capability/trust/状态约束。核对不发模型/核验，但会更新记录并可能释放已证实停止的占用。普通动作以明确按钮确认，不重复弹窗；恢复观察附近写明可能运行核验/合格续跑。

依赖顺序：共享 schema/错误码/read model → typed client/fake transport → tree/工作台/router → 写动作/不可变 Diff → 真实/远端/VSIX 验收。完整审批保存、本地持久归属/hash 校验与 base/final 快照是 M2 后台必需工作。原生 `resolveInteraction` 没有已验证 CAS，快照到发送仍有竞态，不承诺上游原子批准。能力缺失则关闭相应动作。

源码现状：根项目 `engines.node >=24`，运行 `src/daemon/main.ts` 使用 tsx loader；未有独立 daemon 二进制/发行包。M2 面向普通用户发布前需提供独立安装物或明确受支持的外部 daemon 安装方案。VSIX 只连已有 daemon；开发期可以独立源码 daemon，但发布包不能把开发 checkout 当作隐含依赖。

## 可执行的工程约定

未来先在 `extensions/vscode` 安装并锁定构建/测试依赖；独立 Host/Webview tsconfig，Host 不继承根 Node 24 类型。`npm --prefix extensions/vscode run build` 必须串行完成两套 typecheck、Host/Webview bundle、CSS/图标复制、fixture 校验后才成功退出；输出与 manifest 的 `main` 一致。esbuild 本身不做 TypeScript 类型检查。[官方 Bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)。

`scripts/build.mjs` 的契约：Host `platform:node / format:cjs / outfile:dist/host/extension.cjs / external:vscode`；Webview `platform:browser / format:iife / outfile:dist/webview/main.js`；开发启用 sourcemap。target 以最低支持 Host/浏览器实测确定，不因构建机有 Node 24 就输出 Node 24 特有 API。所有产物、扩展 node_modules 与测试用户目录应在实施时加入相应 Git ignore，不能误打入库。

### 两套 F5 配置

以下未来放在仓库根 `.vscode/launch.json`，默认第一个配置为 mock。`extensionDevelopmentPath` 指向扩展目录，不是项目根；`runtimeExecutable:${execPath}` 是启动 VS Code 调试窗口，**不是 daemon 的 Node 路径**。标准 `extensionHost`、`outFiles` 与 `preLaunchTask` 用法依据 [官方调试测试示例](https://code.visualstudio.com/api/working-with-extensions/testing-extension#debugging-the-tests)。

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "ZCode Pool: Mock UI (no daemon)",
      "type": "extensionHost",
      "request": "launch",
      "runtimeExecutable": "${execPath}",
      "args": [
        "${workspaceFolder}/extensions/vscode/test/fixtures/workspace",
        "--disable-extensions",
        "--extensionDevelopmentPath=${workspaceFolder}/extensions/vscode"
      ],
      "env": {
        "ZCODE_POOL_EXTENSION_MODE": "mock",
        "ZCODE_POOL_UI_FIXTURE": "${workspaceFolder}/extensions/vscode/test/fixtures/pool-demo.json"
      },
      "outFiles": ["${workspaceFolder}/extensions/vscode/dist/host/**/*.cjs"],
      "preLaunchTask": "zcodePool:build"
    },
    {
      "name": "ZCode Pool: Real daemon (explicit connect)",
      "type": "extensionHost",
      "request": "launch",
      "runtimeExecutable": "${execPath}",
      "args": [
        "${workspaceFolder}",
        "--disable-extensions",
        "--extensionDevelopmentPath=${workspaceFolder}/extensions/vscode"
      ],
      "env": {
        "ZCODE_POOL_EXTENSION_MODE": "real",
        "ZCODE_POOL_DEBUG_POOL_HOME": "${input:zcodePoolDebugPool}"
      },
      "outFiles": ["${workspaceFolder}/extensions/vscode/dist/host/**/*.cjs"],
      "preLaunchTask": "zcodePool:build"
    }
  ],
  "inputs": [
    {
      "id": "zcodePoolDebugPool",
      "type": "promptString",
      "description": "Absolute pool path on the Linux extension host; service must already be running",
      "default": "/tmp/zcode-pool-ui-real"
    }
  ]
}
```

两者共用未来根 `.vscode/tasks.json`：

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "zcodePool:build",
      "type": "process",
      "command": "npm",
      "args": ["--prefix", "extensions/vscode", "run", "build"],
      "options": { "cwd": "${workspaceFolder}" },
      "problemMatcher": "$tsc",
      "group": { "kind": "build", "isDefault": true }
    },
    {
      "label": "zcodePool:watch",
      "type": "process",
      "command": "npm",
      "args": ["--prefix", "extensions/vscode", "run", "watch"],
      "options": { "cwd": "${workspaceFolder}" },
      "isBackground": true,
      "problemMatcher": {
        "base": "$tsc",
        "background": {
          "activeOnStart": true,
          "beginsPattern": "^\\[zcodePool-watch\\] build started$",
          "endsPattern": "^\\[zcodePool-watch\\] build finished$"
        }
      }
    }
  ]
}
```

`watch` 实现须在一轮 typecheck + 两个 bundle 全部成功后输出 `build finished`，失败不得发成功标记。需要持续开发时，可把两套配置的 `preLaunchTask` 改成 `zcodePool:watch`；不要同时用 build 和 watch 写同一 dist。默认有限 build 更容易诊断首次 F5，修改代码后重新构建并 Reload Extension Development Host；Webview 脚本用 Developer: Open Webview Developer Tools 调试，Host 断点绑定 `.cjs.map`。任务与 background matcher 规则见 [Tasks](https://code.visualstudio.com/docs/debugtest/tasks)。

### mock fixture 与真实连接隔离

`ExtensionMode.Development/Test` 才读取上述 debug env。mock transport 是 Host 内存里的确定性状态机，使用经过相同响应 schema 校验的 `test/fixtures/pool-demo.json`；包含正常结束、审批、占用未知、截断、分页、断线、恢复场景。`fixtures/workspace` 是不含凭据的静态小项目，mock 不读它的文件。fixture 用固定时钟/ID，操作仅更新内存；重置不删除用户目录。

mock 入口不实例化 `SocketTransport`，不读取真实 pool、不 spawn daemon/Worker、不导入账号、不连原生 runtime、不发模型请求。fixture 丢失/格式错误必须显示 mock 初始化失败，禁止 fallback real。Webview 消息、query 参数、`getState`、工作区 settings 不能选择 transport、fixture 路径或 pool。

Production 忽略所有 `ZCODE_POOL_EXTENSION_MODE / ZCODE_POOL_UI_FIXTURE / ZCODE_POOL_DEBUG_POOL_HOME` debug env，只采用 machine scope pool 设置，仍先显示未连接；生产包排除 fixtures。Developer 模式 real 的 pool input 也只是目标预选，**直到用户点 Connect 才建 socket**。Connect 只做能力协商和只读快照；不自动 probe、恢复观察、执行核验或派发。调试模式标识在 banner 常驻，防止把演示数据当真实结果。

真实连接前，在 Linux Host 单独用绝对 Node 24/loader/entry 启动服务；F5 不代启动。源码开发的命令形态如下，替换绝对路径，先确认 major=24；它不是 VSIX 安装依赖：

```bash
/opt/node24/bin/node --version
ZCODE_POOL_HOME=/tmp/zcode-pool-ui-real /opt/node24/bin/node --import /absolute/checkout/node_modules/tsx/dist/loader.mjs /absolute/checkout/src/daemon/main.ts
```

诊断分别显示 Host platform/VS Code、pool、协议/能力与服务状态。使用独立测试 pool、干净小仓库、隔离账号/Worker；已有 systemd 管理时沿原管理者启动，不另起实例。

Remote SSH / WSL 中在远端安装依赖/构建/F5，确认 workspace host；pool/Node/fixture 均用远端路径。Windows/macOS 本机仅测 mock，真实 daemon 须 Linux。Codespaces 须远端 Node Host，容器停止后的进程不保证存活；通过实测才列支持。[官方远端调试](https://code.visualstudio.com/api/advanced-topics/remote-extensions#debugging-extensions)。

## 测试矩阵与验收证据

以下是实施后的必跑范围，本轮未执行这些测试。schema、router 和错误恢复属于必要测试，不以原型 DOM 脚本检查替代。

| 层级 | 夹具/执行方式 | 必须证明的结果 |
| --- | --- | --- |
| Unit：schema + Host router | 无 VS Code 的 ActionService、fake transport、可控时钟；Host API 适配器 stub | 未知 type/额外字段/超限/任意路径、method、transport 均拒绝；合法消息只调用一个白名单方法；响应缺字段/错类型不流入页面；命令和 Webview 走同一实现 |
| Unit：并发与生命周期 | 交错 deferred promises、revision/store/instance 变化、重复 id、双击 | A 任务晚到数据不覆盖 B；旧 revision 不回退；一个 submit token 只派发一次；同 request_id 不换 payload；写请求超时不自动重发；审批重复/陈旧 hash 失败后重新审阅 |
| Unit：polling/dispose | mock timers、view visible/hidden、abort spy | 每 pool/窗口至多一个 wait 和一个 overview；revision map 正确前移；hidden 不续轮询；close/deactivate 释放资源且不调用 cancel/stop；只读退避有上限，断线保留任务真实状态 |
| Integration：临时 daemon | Linux + 绝对 Node 24；mkdtemp pool + SQLite + 真 Unix socket + Coordinator；复用现有测试 fake RuntimeConnection/Worker，仅测试入口允许注入 | framing/1 MiB/错误/abort、近期窗口、日志/UTF-16 Diff 分页、响应 schema、断线/重启、完整审批读取/本地校验拒绝、不可变工件哈希；模拟上游变更竞态；无真实账号/runtime，清理自己的进程 |
| Integration：未知派发结果 | fake 原生 send 后丢 ACK/丢 socket 响应，持久查询同 request_id；双窗口并发 | 只有一次原生命令；`NOT_FOUND` 不触发重发；恢复查询可找原任务；取消未确认仍持有占用；不因 UI timeout 强制解锁 |
| VS Code Host smoke | `@vscode/test-electron`，最低支持版+稳定版，独立用户数据/fixture workspace，禁用其他扩展 | 可 activate、两个 TreeView/全部 commands 注册、panel 打开与销毁、mock/real隔离；陌生命令参数和 Restricted Mode 不能绕过 Host 检查；重载不会自动建任务 |
| Webview 浏览器/UI | 浏览器自动化检查 DOM/bridge + 真实 Extension Development Host 手测 | 280/320px 窄布局、正常工作台、200% zoom，Dark/Light/High Contrast；VS Code theme tokens；键盘 Tab/Shift+Tab/Enter/Escape、焦点返回、屏幕阅读器标签、非颜色状态；无横向遮挡关键按钮 |
| 安全与数据边界 | 恶意日志/路径/审批内容、command URI、symlink、外链、Secret canary | 文本不执行、CSP 无远程请求；真实路径/工件归属受检查；token/邮箱/导入源路径/raw历史不进入 DOM、持久 UI 状态、输出日志或 VSIX；不自动发送文件/上下文给 Codex |
| 真实无模型连接 | 显式 real profile + 测试 pool，默认测试任务运行 | 不连接前零 socket；连接后仅协商/只读；probe 只能用户显式触发，标网络行为与额度来源；关闭 VS Code 不停止服务/Worker |
| 真实模型闭环（opt-in） | 单独 `test:real-model`；要求显式运行、`ZCODE_POOL_RUN_REAL_MODEL=1` 与人工选定账号/Worker/workspace/prompt/核验命令 | 默认 CI/F5/build/test:smoke 全跳过；确认后仅一次派发，经历审批/取消或完成、核验、不可变 Diff/未跟踪文件、人工审阅标记；记录资源与退出码，绝不自动切账号/追加无限续跑 |
| VSIX 与远端 | 打包后在无源码目录的干净用户配置安装；Linux本机、Remote SSH、WSL实测 | `vsce ls`/解包白名单通过；离开 checkout 仍可打开/连独立 daemon；无 Node24/store 混入 Host；路径由 workspace host 解析；Codespaces 单列未验证/已验证证据 |

Host smoke 通过官方 `@vscode/test-electron` 下载/选择测试 VS Code，给 `extensionDevelopmentPath` 与编译后的 `extensionTestsPath`；测试脚本先准备 fixture，再启动 Host，finally 清理自己的子进程。trusted/untrusted 使用分开的用户数据目录/运行，不在扩展测试里假装可以编程授予 trust。Linux CI 需要图形会话或 Xvfb；Webview 内部 DOM 与扩展 API smoke 分开验收，不能仅凭命令注册通过就宣称像素与键盘完成。[官方 Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)。

M2 完整链：显式连接 → 选仓库/创建隔离 workspace → 导入/选账号与 ready Worker → 审阅 worktree、模型、会话、续跑上限、核验命令 → 明确派发 → 事件/审批 → 核验/快照 → 不可变 Diff（含未跟踪）→ 本地审阅标记。另测取消待确认、中断核对/恢复及未知占用不可复用。证据标明 mock/真实、版本、Host、未覆盖项，不记录凭据/完整 prompt。

交付须通过根项目 typecheck/test、扩展 typecheck/unit/integration/smoke、UI 和独立 VSIX 检查；真实模型单列 opt-in，未测项明确标注。对照 [UX-01..15](flows-and-states.md#原型覆盖与验收索引)。本轮仅文档检查；打包不等于发布，不修改 Codex/MCP/systemd/账号/全局设置。[官方打包](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions)。
