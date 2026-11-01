# VS Code 扩展：使用、开发与验证

安装版 VSIX 包含任务监控界面、调度后台、CLI 和 MCP。后台独立于界面运行，首次打开、F5 和关闭窗口均不启动或停止模型任务。日常由 Codex 调度 ZCode；面板显示进度、额度、审批和交付，并允许人工干预。

## 安装后的普通使用流程

1. 在目标 VS Code 窗口使用 **Extensions: Install from VSIX...** 安装；Remote SSH/WSL 安装到 Linux 执行侧。执行侧需有 Node.js 24+ 和官方 ZCode 运行环境。扩展捆绑本项目后台，无需另装 daemon 包或保留开发 checkout。
2. 打开 Activity Bar 的 ZCode Pool，或执行 **ZCode Pool: Open Workbench**。确认运行环境及连接目录。默认 `~/.zcode_pool`；“选择连接目录”可填写执行侧绝对路径。
3. 点击“启动后台并连接”。已有后台时复用；否则准备扩展捆绑后台并启动。此动作不启动执行器或模型。已运行后台也可直接点“连接”读取状态。
4. 在“额度与资源”导入执行侧 OAuth JSON、启动执行器，从干净 Git 仓库创建独立任务目录。账号导入不是 `.zsb` 备份；同名账号可能覆盖已有记录。
5. 点击“连接 Codex / 生成 MCP 配置”，按打开的文档将配置一次添加到同一执行侧的 Codex，再重新连接 Codex。以 Codex 调用 `zcode_overview` 后看到同一池的账号和任务为连接依据。生成配置不会自动改写 Codex 设置，也不显示未经验证的“已连接 Codex”。
6. 在 Codex 中说明目标、可修改范围和验收方式，由 Codex 拆分、派发并验收。面板默认打开“任务监控”，按需查看“额度与资源”、处理必要审批并检查交付 Diff。手动派发表单位于任务页“高级操作”。

MCP 与面板引用同一执行侧的共享连接资料。切换连接目录后需重新连接面板；后续 MCP 工具调用自动读取新目录，无需重复添加 Codex 服务器。旧目录中的已有任务继续留在旧目录，切换不会迁移或停止它们。关闭面板或 MCP 入口后任务继续；“断开连接”不会取消任务。Codex 的精简输出与 UI 按需读取独立，完整审批和文件正文不会自动加入 Codex 上下文。

升级扩展或生成 MCP 配置不会自动重启旧 daemon。需要新功能时先检查当前任务，再显式停止旧服务并启动新后台。新后台会将旧 schema 1/2/3 数据库迁移到 schema 4，迁移后不要混用旧程序。

### 额度与并发

账号卡片可读取已有额度快照，无网络请求；“查询认证与额度”会通过对应执行器连接官方服务。界面保留来源、观测时间及查询失败记录，不把导入快照当作实时余额。

“设置 → 并发任务”显示当前上限、占用槽位和可用槽位。上限范围 `0–64`，留空不限制；`0` 暂停新派发，已有任务继续。降低上限不会停止任务，超限派发直接拒绝而不自动排队。等待审批、核验和执行状态未知但仍占用资源的任务均占槽位。MCP 与面板遵守同一上限。

## 在当前项目按 F5

先在项目根目录安装依赖：

```bash
npm ci
npm --prefix extensions/vscode ci
npm --prefix extensions/vscode run build
```

用 VS Code 打开**项目根目录**，在“运行和调试”选择 **ZCode Pool: Mock UI (no daemon)**，按 F5。会打开一个 Extension Development Host 窗口。打开 Activity Bar 的 ZCode Pool，或执行 **ZCode Pool: Open Workbench**，再点“连接监控”。Mock 中只连接内存模拟服务，页面常驻“演示模式”标记。

Mock 可体验任务、完整审批、账号/Worker、额度、并发设置、不可变 Diff、核验、手动派发、取消和恢复；不读取真实账号/pool，不启动真实 Worker、不发模型请求。“连接 Codex / 生成 MCP 配置”在 Mock 中不可用。重载调试窗口重置演示数据。缺失或损坏 fixture 会报初始化失败，不转连真实服务。

修改代码后重新 F5 会先构建。需要持续构建时运行 `npm --prefix extensions/vscode run watch`，并按 `.vscode/tasks.json` 中的 watch 任务配置调试；不要同时让两个构建进程写 `dist`。Host 可打断点；Webview 用 **Developer: Open Webview Developer Tools** 检查。

## 连接真实 daemon

真实运行要求 Linux 执行侧及 Node 24。Remote SSH/WSL 时扩展与 pool 都在 Linux workspace host；界面显示执行侧和 pool 路径。纯 Windows/macOS 本地 workspace 不支持当前 daemon。

安装版使用捆绑后台。开发时也可以使用[独立安装包](../distribution.md)，或在单独终端显式启动：

```bash
ZCODE_POOL_HOME=/绝对路径/测试池 npm run daemon
```

选择 **ZCode Pool: Real daemon (explicit connect)** 按 F5，输入同一个绝对 pool 路径。在调试窗口点连接后才会读取 daemon。也可点“选择连接目录”直接修改执行侧路径，无需离开工作台查找设置。预先启动已有服务不会自动派发任务、导入账号、probe 额度或恢复观察。首次测试建议使用空测试池与单独的小 Git 仓库。

安装版通过 User/Remote Settings 的 `zcodePool.poolHome` 指定 pool，生产模式忽略所有调试 Mock 环境变量。F5 输入只提供初始目录，随后通过工作台或 User/Remote Settings 修改目录会覆盖本次 F5 初始值，无需重启。切换目录后需要重新连接。受限工作区只允许读取，写操作由 Host 再检查 Workspace Trust。

任务列表优先定位活动文件对应的已登记项目；单根且能唯一确定时默认该项目，否则显示整个池。已有手动筛选或同池恢复值不会被自动覆盖。

手动派发用于高级操作：展开任务页“高级操作” → 选择任务目录与执行器 → 检查模型、模式、会话和核验命令 → 提交。默认保留普通运行模式，不默认使用 `yolo`。日常由 Codex 调度时无需填写此表单。

账号导入仅支持原有 OAuth JSON 格式，不是 `.zsb` 备份。导入由原生文件选择器完成，凭据及导入源路径不进入 Webview。同 alias 导入可能替换既有记录，不会自动启动 Worker。

“启动后台并连接”先连接已有服务；不可达时使用扩展捆绑后台，再连接。启动和生成 MCP 配置需要已信任的 Linux 执行侧，不会启动执行器或模型；关闭界面也不会停止后台。`zcodePool.daemonNodePath` 可指定 Node 24+ 的绝对路径；留空从执行侧 PATH 查找。`zcodePool.daemonCliPath` 仅供高级用户选择已有外部后台 CLI；默认无需填写。整个流程不下载或执行工作区脚本。

### F5 或连接遇到问题

- 没有调试配置：在 Remote SSH 窗口打开本项目根目录，而不是仅打开 `extensions/vscode`。
- 出现 `INVALID_POOL_HOME` 或 `Set an absolute pool path`：点击“选择连接目录”，输入 Linux 执行侧的绝对路径，不加引号、反引号或 `~`；也可修改 User/Remote Settings 的 `zcodePool.poolHome`。修改后重新连接即可，无需重启 F5。
- 工作台打开但连接失败：记录界面显示的执行侧、pool 路径和完整错误文字；确认 daemon 使用同一个 pool。已有任务不因界面断开而停止，不要为排查连接问题再次派发任务。

## 操作含义

- 模型繁忙继续使用同一账号、模型与会话，默认初次派发后最多立即继续 3 次；没有延迟队列或自动换账号。
- “核对执行状态”不发模型命令，但会更新本地记录，证实停止后可能释放占用。“恢复观察”可能继续已有核验或符合条件的繁忙续跑。
- 取消请求不代表已停止；状态未知时仍保留占用，禁止强行复用。
- 审批必须有完整、可信的来源和当前归属；点击“查看完整操作”后一次加载描述与全文；完整校验成功后核对内容，再批准。未知交互类型、旧截断记录、敏感字段无法完整呈现等情况只读。当前支持经核实的普通 permission 单次批准/拒绝，不承诺原生 CAS；审批消失也不代表本窗口答复已被采用。
- Diff 来自完成时保存的 base/final 字节，包含未跟踪文件清单。相对任务 workspace 的 baseCommit 累计比较，可能包含之前任务的改动。旧任务缺快照时明确不可用，不拿当前磁盘内容替代。
- “本客户端已审阅”只保存本地 manifest 绑定标记，不自动合并、不修改 daemon 的成功状态。UI 阅读不会自动发送给 Codex；MCP 仍保持精简输出限制。

## 安装 VSIX

```bash
npm --prefix extensions/vscode run package:vsix
npm --prefix extensions/vscode run package:check
```

生成 `extensions/vscode/zcode-pool-0.1.0.vsix`。包内包含编译后的 daemon、CLI 和 MCP 及完整运行依赖；首次显式启动/生成配置时准备到执行侧扩展存储目录，不依赖开发 checkout。包内不含 Node 24、官方 ZCode 运行环境、账号或开发 fixture。未发布 Marketplace。

## 验证命令

```bash
npm run typecheck
npm test
npm --prefix extensions/vscode run build
npm --prefix extensions/vscode run test:unit
npm --prefix extensions/vscode run test:integration
npm --prefix extensions/vscode run test:browser
xvfb-run -a env ZCODE_POOL_VSCODE_VERSION=1.95.3 npm --prefix extensions/vscode run test:smoke
xvfb-run -a env ZCODE_POOL_VSCODE_VERSION=1.95.3 ZCODE_POOL_SMOKE_RESTRICTED=1 npm --prefix extensions/vscode run test:smoke
npm run test:daemon-package
xvfb-run -a npm --prefix extensions/vscode run test:installed
```

`test:browser` 默认使用 `/usr/bin/google-chrome`，可通过 `ZCODE_POOL_CHROME_PATH` 指定本机 Chrome/Chromium。测试用真实浏览器、实际 Host/router 和内存 Mock 验证页面；截图与报告保存在忽略的 `.test-browser/`。它不代替真实 VS Code 宿主测试。

`test:smoke` 下载所选 VS Code 版本并使用隔离用户配置。`test:installed` 使用已构建 VSIX，在 checkout 外安装并验证捆绑后台、生产模式和真实空池连接；独立 daemon tgz 由 `test:daemon-package` 单独检查。Xvfb 仅为无图形会话的自动化宿主测试提供显示器，运行 daemon/Worker 不需要它。这些默认测试不发真实模型请求。

具体执行版本、结果及未验证环境见[实现验收记录](../validation/2026-11-01-vscode.md)。设计基线保留在本目录，其“阶段”表示原实施划分；实际运行入口以本文和代码为准。

## 启动、断开与收工

“启动后台并连接”只启动管理后台，Worker 在额度与资源中单独启动。“断开面板”只停止观察，不影响任务。“收工：停止实例与后台”检查整个 pool：存在任何任务占用则拒绝；无占用时依次停止 Worker，全部成功后后台退出。数据不会删除，操作不会强制取消任务。部分实例停止失败时后台保留运行，应刷新检查。

Codex 可使用 `zcode_daemon_start` 和 `zcode_shutdown_pool` 执行同样的管理。MCP 查询不会自动重启后台；再次使用需明确启动。旧后台若未提供 `poolLifecycle` 能力，收工入口禁用，需在处理完当前任务后升级后台。
