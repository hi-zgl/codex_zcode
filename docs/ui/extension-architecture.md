# VS Code 扩展架构

本文保留实现前的设计基线（`21d4663`）。下文阶段、拟议文件与接口用于说明设计约束，不代表当前开发状态；已落地代码、运行方法及验证边界以[运行与测试指南](implementation.md)和[验收记录](../validation/2026-11-01-vscode.md)为准。

## 运行位置与目录

采用 `extensions/vscode/` 独立 package、lockfile、TypeScript 配置和构建；技术为 TypeScript + esbuild + 原生 Webview DOM，拆分现原型组件。

```text
extensions/vscode/
  package.json / package-lock.json / tsconfig.{host,webview}.json
  scripts/build.mjs                  # host、webview 两个独立构建
  src/extension.ts                   # activate / deactivate、注册与释放
  src/host/{connection,router,actions,polling,projection}.ts
  src/host/{taskTree,resourceTree,workbench,diffProvider}.ts
  src/webview/{main,state,bridge,components}.ts
  media/{styles.css,zcode-pool.svg}
  test/{unit,integration,smoke,fixtures}/
  dist/{host/extension.cjs,webview/main.js,webview/styles.css}
src/shared/ui-contract.ts             # 待新增：纯 DTO/schema，无 Node/daemon 依赖
```

共享 schema 构建后固化在 bundle，不在运行时依赖源码。基于 `methods.ts` 补响应校验与 UI 投影，不直接导出 `core.Task`。Host 禁止导入 coordinator/store/vault/supervisor/`node:sqlite`。

`extensionKind: ["workspace"]` 使 socket 客户端与远端 workspace 位于同一机器；Webview 仍由用户 UI 侧显示，资源经 `asWebviewUri`，不能从页面 fetch 远端 `localhost` 或 Unix socket。[官方 Remote Development](https://code.visualstudio.com/api/advanced-topics/remote-extensions)、[Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)。

首版验证 Linux 本机、Remote SSH Linux 与 WSL；远端扩展、Node 24、pool、Worker、仓库在同侧。Windows/macOS 纯本机 daemon 不支持。Codespaces/Container 须验证 `/proc`、abstract socket、runtime、存储和生命周期；无远端 Node Host 的 vscode.dev/github.dev 不支持，不提供 `browser` 入口。

Host Node 由 VS Code 决定，不能由终端版本推断；daemon 用明确绝对路径的外部 Node 24，禁止用 Host `process.execPath` 替代。M2 只连接已有服务，不自动安装/启动/systemd。[原生模块与远端差异](https://code.visualstudio.com/api/advanced-topics/remote-extensions#using-native-nodejs-modules)。

## Manifest 与注册约定

以下是未来 manifest 模板。拟议本地 VSIX 身份 `zcode-pool.zcode-pool`，Marketplace 名称未注册核验。API 下限拟为 1.95，使用对应 `@types/vscode`，测试最低版与稳定版。[Manifest](https://code.visualstudio.com/api/references/extension-manifest)。

```json
{
  "name": "zcode-pool",
  "publisher": "zcode-pool",
  "displayName": "ZCode Pool",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "engines": { "vscode": "^1.95.0" },
  "categories": ["Other"],
  "main": "./dist/host/extension.cjs",
  "extensionKind": ["workspace"],
  "activationEvents": ["onView:zcodePool.tasks", "onView:zcodePool.resources"],
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited",
      "description": "Restricted Mode only permits explicit read-only connections; execution and account changes require trust."
    },
    "virtualWorkspaces": { "supported": false }
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "watch": "node scripts/build.mjs --watch",
    "typecheck": "node scripts/typecheck.mjs",
    "test:unit": "node scripts/test-unit.mjs",
    "test:integration": "node scripts/test-integration.mjs",
    "test:smoke": "node scripts/test-smoke.mjs",
    "vscode:prepublish": "npm run build",
    "package:vsix": "vsce package --no-dependencies"
  },
  "contributes": {
    "viewsContainers": {
      "activitybar": [{ "id": "zcodePool", "title": "ZCode Pool", "icon": "media/zcode-pool.svg" }]
    },
    "views": {
      "zcodePool": [
        { "id": "zcodePool.tasks", "name": "Tasks" },
        { "id": "zcodePool.resources", "name": "Resources" }
      ]
    },
    "commands": [
      { "command": "zcodePool.openWorkbench", "title": "ZCode Pool: Open Workbench" },
      { "command": "zcodePool.connect", "title": "ZCode Pool: Connect" },
      { "command": "zcodePool.disconnect", "title": "ZCode Pool: Disconnect", "enablement": "zcodePool.connected" },
      { "command": "zcodePool.refresh", "title": "ZCode Pool: Refresh", "enablement": "zcodePool.connected" },
      { "command": "zcodePool.openTask", "title": "ZCode Pool: Open Task", "enablement": "zcodePool.connected" },
      { "command": "zcodePool.newTask", "title": "ZCode Pool: New Task", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.createWorkspace", "title": "ZCode Pool: Create Workspace", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.importAccounts", "title": "ZCode Pool: Import Accounts", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.startWorker", "title": "ZCode Pool: Start Worker", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.stopWorker", "title": "ZCode Pool: Stop Worker", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.probeWorker", "title": "ZCode Pool: 查询认证与额度", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.cancelTask", "title": "ZCode Pool: Request Cancellation", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.reconcileTask", "title": "ZCode Pool: 核对执行状态", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.resumeTask", "title": "ZCode Pool: 恢复观察", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.respondApproval", "title": "ZCode Pool: Review Approval", "enablement": "zcodePool.canMutate" },
      { "command": "zcodePool.openSettings", "title": "ZCode Pool: Open Settings" }
    ],
    "menus": {
      "view/title": [
        { "command": "zcodePool.openWorkbench", "when": "view == zcodePool.tasks", "group": "navigation@1" },
        { "command": "zcodePool.refresh", "when": "view == zcodePool.tasks", "group": "navigation@2" },
        { "command": "zcodePool.newTask", "when": "view == zcodePool.tasks && zcodePool.canMutate", "group": "navigation@3" },
        { "command": "zcodePool.connect", "when": "view == zcodePool.resources && !zcodePool.connected", "group": "navigation" },
        { "command": "zcodePool.openSettings", "when": "view == zcodePool.resources", "group": "configuration" }
      ],
      "view/item/context": [
        { "command": "zcodePool.openTask", "when": "view == zcodePool.tasks && viewItem =~ /^task\\./", "group": "inline@1" },
        { "command": "zcodePool.cancelTask", "when": "view == zcodePool.tasks && viewItem == task.active && zcodePool.canMutate", "group": "task@1" },
        { "command": "zcodePool.reconcileTask", "when": "view == zcodePool.tasks && viewItem == task.uncertain && zcodePool.canMutate", "group": "task@2" },
        { "command": "zcodePool.probeWorker", "when": "view == zcodePool.resources && viewItem == worker.ready && zcodePool.canMutate", "group": "worker@1" }
      ]
    },
    "configuration": {
      "title": "ZCode Pool",
      "properties": {
        "zcodePool.poolHome": {
          "type": "string", "default": "", "scope": "machine",
          "description": "Absolute pool path on the extension host machine. Empty uses that user's ~/.zcode_pool."
        },
        "zcodePool.overviewIntervalSeconds": {
          "type": "integer", "default": 30, "minimum": 15, "maximum": 300, "scope": "window",
          "description": "Visible-view discovery interval; does not probe quota or dispatch tasks."
        }
      }
    }
  }
}
```

实施时独立锁定 esbuild/TypeScript/`@types/vscode`/Host Node 类型/zod/`@vscode/test-electron`/`@vscode/vsce`；类型与 target 按最低 Host 选取，不继承根 `@types/node@24`。

1.74 起 contributed command/view 能隐式激活；显式 `onView` 保留以便审计，无 `*`、`onStartupFinished` 或仓库扫描激活。M2 不注册 panel serializer；`viewType` 固定 `zcodePool.workbench`，每窗口一个 panel，关闭后仅由用户再次打开。[Activation Events](https://code.visualstudio.com/api/references/activation-events)。

Tasks 为任务树；Resources 分 Workers/Accounts/Workspaces。`contextValue` 为 `task.active / task.uncertain / task.finished / worker.ready / worker.other / account / workspace`。命令缺参数则 QuickPick，有参数则重新校验。`canMutate` 仅是菜单提示，Host 仍逐项检查 capability、revision、归属和 trust。

`poolHome` 为 machine scope，只接受 Host User/Remote Settings。空值按 Host home 解析；Connect 前显示主机/绝对路径，只读规范化不创建 pool。M2 无 Node/loader 配置；未来启动入口也必须为 machine scope。[配置 scope](https://code.visualstudio.com/api/references/contribution-points#contributes.configuration)、[Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)。

## Host、Webview 与协议

`activate` 只注册 UI/router，默认未连接。Connect 后先协商能力；旧 daemon 仅 `legacy-readonly`，不降级旧审批。状态栏显示连接、已载入需处理数、旧数据；`openWorkbench` 聚焦需处理，不自动执行。

工作台分为 `ConnectionBanner / TaskFilters / TaskList / TaskDetail / EventPager / ApprovalReview / Delivery / ResourceInspector / TaskComposer`。DOM state reducer 不调用 VS Code API；`bridge` 是唯一消息出口。Webview 只有浏览器 API，无 Node、socket、shell、vault、原生 ingress 或通用 RPC 方法入口。

消息为 strict 区分联合 `Request={v:1,id,generation,type,payload}`；type 覆盖 ready、draft.change、列表/详情/分页、派发/取消/核对/恢复、审批、资源动作、工件 Diff，每种 payload 独立校验。返回 `Response={v:1,id,generation,ok,data|error}`；推送带 type 与 DTO。拒绝未知字段及任意 `method/command/path/transport`；pool/transport 仅 Host 决定。

Router 顺序为消息 schema → 当前 panel/generation → trust/capability → 目标归属与状态 → typed action → RPC response schema → UI 白名单投影。Webview、TreeView 和 command palette 复用同一 ActionService，禁止各自写派发代码。文件选择、URI canonical path 和原生 Diff provider 都留在 Host；工件按 task/manifest/file 身份读取，不接受页面传任意磁盘路径。

Typed client 为 `call<K>(method:K,params:Params[K],signal):Promise<Result[K]>`，校验双向 schema。沿用 JSON-RPC 2.0、换行 framing、随机 ID、1 MiB 限制与每请求独立 socket；在现 `rpcCall` 上补 AbortSignal、错误分类和清理。只读 deadline 10 秒；wait 25 秒/socket 30 秒。写超时显示结果未知，不推断执行停止。

同一表单确认一次即生成稳定 `request_id`；Host 对 submit token 去重并锁住按钮，重复消息复用同一 in-flight promise。超时/断连保留 ID、payload hash、资源目标至 Host storage，不持久化 prompt；按 `ui_get_task_detail {request_id}` 查询恢复，`NOT_FOUND` 也不授权自动重发。原 payload 仍在内存且用户明确重试时，才允许同 ID/同 payload；不能悄悄换 ID。审批按 task/approval/hash/revision 串行，答复后待原生 revision 更新，不能乐观显示已批准；跨窗口竞争仍由 daemon 拒绝。

## revision、可见性与释放

连接 generation、选择/筛选 sequence 淘汰旧响应；断开/换 pool/换任务即 abort 旧读取。仅合并同 store/instance 且 revision 不倒退的快照；分页不能串任务。instance 变更重协商/清游标，store 变更清缓存/审阅关联。加载、空、未连接、旧数据、拒绝、不兼容、请求失败分别呈现；断线不改 task status。

每 pool/窗口一个 PollCoordinator，仅相关视图可见时运行：一个 wait，最多 50 个已知 ID、逐 task `after_revision` map，合并后才前移；默认 30 秒 overview 发现新任务，single-flight 并合并手动刷新。M1 最近 50 条反转创建顺序，无 updatedAt/完整总数；仅筛选已载入窗口。patch 分页按 UTF-16 offset 拼接后渲染，保留跨页代理对。

所有视图隐藏即停止 timer、abort 当前 wait，不再续开；现 daemon 未实现客户端断开取消 store waiter，残余只读 waiter 最长仍存活本轮 25 秒。重新可见先取新快照再续等。网络错误采用有上限的退避与抖动；无变化长轮询不忙循环，写操作绝不自动重试。

`retainContextWhenHidden:false`；`getState/setState` 只存 tab/filter/selection，草稿仅 Host 内存，敏感正文/日志不持久化。关闭/deactivate 释放 handlers/socket/abort/timer/Diff缓存，不发 `daemon_stop/stop_worker/cancel_task`。审阅标记存 Host `workspaceState`，key 绑定 authority、pool/store、task、manifest hash，hash 变化失效。[生命周期](https://code.visualstudio.com/api/extension-guides/webview#persistence)。

nonce 脚本、`default-src 'none' / connect-src 'none'`，`localResourceRoots` 仅扩展静态目录，输出按文本渲染。Restricted Mode 只读，每动作检查 `isTrusted`；不自动运行仓库/日志命令。UI 不注册 MCP/Chat/模型工具，不自动向 Codex 发送文件、prompt、账号或输出；MCP 白名单/16 KiB 独立。[Webview 安全](https://code.visualstudio.com/api/extension-guides/webview#security)、[Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust#contribution-points)。

## 构建与 VSIX 边界

Host 输出 `dist/host/extension.cjs`，external `vscode`/Node builtin；Webview 为 IIFE/CSS，无 Node polyfill/CDN。开发有 sourcemap，发布排除开发 map；import graph 检查 Host 不引 daemon/store、Webview 不引 Node；zod/schema 均 bundle。[Bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)。

VSIX 是可独立安装的 **UI 客户端**，不内置 Node、daemon、官方 runtime、账号或 pool；`--no-dependencies` 仅在所有 JS 依赖已 bundle 后使用。包内白名单为 manifest、README/CHANGELOG、许可证、dist、必要 media；排除 src/test/fixture、node_modules、references、runtime、源码仓库、`.env`、vault 和开发 sourcemap。用 `vsce ls` 和解包检查验证，不依赖 `.vscodeignore` 的猜测。

连接同机独立 daemon，不查找 `../../src/daemon/main.ts` 或调用工作区 npm。独立 daemon 安装物/兼容说明是普通用户 M2 交付依赖；缺失时只能声明需自行启动开发 daemon。首版只打包/安装，不发布 Marketplace。[Packaging](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#packaging-extensions)。
