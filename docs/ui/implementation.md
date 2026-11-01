# VS Code 扩展：运行与测试

代码位于 `extensions/vscode`，使用原生任务/资源侧栏、状态栏和编辑区工作台。daemon 独立运行；扩展首次打开、F5、关闭窗口均不会启动或停止模型任务。

## 在当前项目按 F5

先在项目根目录安装依赖：

```bash
npm ci
npm --prefix extensions/vscode ci
npm --prefix extensions/vscode run build
```

用 VS Code 打开**项目根目录**，在“运行和调试”选择 **ZCode Pool: Mock UI (no daemon)**，按 F5。会打开一个 Extension Development Host 窗口。打开 Activity Bar 的 ZCode Pool，或执行 **ZCode Pool: Open Workbench**，再点“连接已有 daemon”。Mock 中此按钮只连接内存模拟服务，页面常驻“演示模式”标记。

Mock 可体验任务、完整审批、账号/Worker、不可变 Diff、核验、任务派发、取消和恢复；不读取真实账号/pool，不启动真实 Worker、不发模型请求。重载调试窗口重置演示数据。缺失或损坏 fixture 会报初始化失败，不转连真实服务。

修改代码后重新 F5 会先构建。需要持续构建时运行 `npm --prefix extensions/vscode run watch`，并按 `.vscode/tasks.json` 中的 watch 任务配置调试；不要同时让两个构建进程写 `dist`。Host 可打断点；Webview 用 **Developer: Open Webview Developer Tools** 检查。

## 连接真实 daemon

真实运行要求 Linux 执行侧、Node 24 和独立 daemon。Remote SSH/WSL 时扩展与 pool 都在 Linux workspace host；界面显示执行侧和 pool 路径。纯 Windows/macOS 本地 workspace 不支持当前 daemon。

可使用[独立安装包](../distribution.md)，开发时也可以在单独终端显式启动：

```bash
ZCODE_POOL_HOME=/绝对路径/测试池 npm run daemon
```

选择 **ZCode Pool: Real daemon (explicit connect)** 按 F5，输入同一个绝对 pool 路径。在调试窗口点连接后才会读取 daemon。也可点“选择连接目录”直接修改执行侧路径，无需离开工作台查找设置。预先启动已有服务不会自动派发任务、导入账号、probe 额度或恢复观察。首次测试建议使用空测试池与单独的小 Git 仓库。

安装版通过 User/Remote Settings 的 `zcodePool.poolHome` 指定 pool，生产模式忽略所有调试 Mock 环境变量。F5 输入只提供初始目录，随后通过工作台或 User/Remote Settings 修改目录会覆盖本次 F5 初始值，无需重启。切换目录后需要重新连接。受限工作区只允许读取，写操作由 Host 再检查 Workspace Trust。

任务列表优先定位活动文件对应的已登记项目；单根且能唯一确定时默认该项目，否则显示整个池。已有手动筛选或同池恢复值不会被自动覆盖。

典型操作顺序：资源页导入执行侧 OAuth JSON → 显式启动 Worker → 从干净 Git 仓库创建任务 workspace → 新任务中选择 workspace/Worker、输入提示词并检查模型/会话/核验命令 → 派发 → 审批/核验 → 查看固定交付 Diff。

账号导入仅支持原有 OAuth JSON 格式，不是 `.zsb` 备份。导入由原生文件选择器完成，凭据及导入源路径不进入 Webview。同 alias 导入可能替换既有记录，不会自动启动 Worker。

后台已按[独立安装说明](../distribution.md)安装时，可点“启动后台并连接”。此动作先连接已有服务；服务不可达时使用已安装 CLI 启动后台，再连接。启动需要已信任的 Linux 执行侧，不会启动执行器或模型；关闭界面也不会停止后台。

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

生成 `extensions/vscode/zcode-pool-0.1.0.vsix`。在目标 VS Code 窗口使用 **Extensions: Install from VSIX...** 安装；SSH/WSL 选择执行侧。扩展包不包含 daemon、Node 24、账号或开发 fixture，仍须单独安装服务。未发布 Marketplace。

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

`test:smoke` 下载所选 VS Code 版本并使用隔离用户配置。`test:installed` 需要已构建 VSIX 和 daemon tgz，在 checkout 外安装两者，再验证生产模式连接真实空池。Xvfb 仅为无图形会话的自动化宿主测试提供显示器，运行 daemon/Worker 不需要它。这些默认测试不发真实模型请求。

具体执行版本、结果及未验证环境见[实现验收记录](../validation/2026-11-01-vscode.md)。设计基线保留在本目录，其“阶段”表示原实施划分；实际运行入口以本文和代码为准。
