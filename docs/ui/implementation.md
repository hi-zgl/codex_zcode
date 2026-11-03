# 工作台使用与开发

[项目入口](../../README.md) · [界面与接口设计](design.md) · [当前验证](../validation/current.md)

## 一次配置

1. 在 VS Code 使用 **Extensions: Install from VSIX...** 安装 ZCode Pool；Remote SSH/WSL 选择 Linux 执行侧。执行侧需要 Node.js 24+ 和官方 ZCode Server 3.16.3。
2. 打开 **ZCode Pool: Open Workbench**，确认执行侧与连接目录。默认 `~/.zcode_pool`；“选择连接目录”填写执行侧绝对路径。
3. 点击“启动后台并连接”。复用已有后台，服务不可达才显式启动捆绑后台；此动作不发起模型回合。在“额度与资源”导入 OAuth JSON。
4. 点击“连接 Codex / 生成 MCP 配置”，将说明中的配置一次添加到同一执行侧的 Codex，再重新连接。生成配置不修改 Codex 设置，不代表已连接；使用池读取工具确认同一连接目录。

VSIX 已包含本项目后台、CLI 与 MCP，无需另装 daemon 或保留 checkout。`zcodePool.daemonNodePath` 可指定 Node 24+ 的绝对路径；留空从执行侧 PATH 查找。`daemonCliPath` 留空使用捆绑后台，只供高级用户覆盖。

MCP 与面板使用共享连接资料。切换目录后重新连接面板，后续 MCP 调用读取新目录；原池已有任务不迁移或停止。升级扩展不会自动替换或重启旧后台，处理当前任务后才显式切换。

## 日常操作

在指挥入口说明目标、项目与验收要求。高层交办自动准备账号、执行器和任务目录；日常不必手动逐项建立环境。执行器是绑定一个账号的独立 ZCode 实例；任务目录是任务修改和核验代码的位置，可共享项目目录或使用独立 worktree，与保存账号的池目录不同。手动执行器、任务目录和派发保留在资源详情或“高级操作”，主要供检查和调试。

任务页可切换共享池和当前项目，查看并列摘要、集中待办及总任务阶段图。展开阶段查看子任务和账号；进入执行详情按需读取审批、日志和固定交付。实施完成不等于验收通过，阶段点亮来自指挥确认，返工会取消完成显示。

共享列表有界；选择项目会重新查询该项目，通知按总任务 ID 定位，窗口外目标不会只因共享池最近列表而被漏掉。账号不足且尚未创建工作目录时，也可从当前 VS Code 项目查看已登记的待办，无需先准备执行环境。

账号不足时，待办显示申请数和实际可用数；用户明确确认使用数量后才部分推进。全部账号低额度时暂停新派发，可查看额度与账号、处理后重新检查。语义决定通过当前指挥入口说明。需要用户决定的待办会发 VS Code 通知，普通自动恢复错误只记录。

额度与资源页的账号、执行器、任务目录可分别收起。账号默认显示身份、状态、额度、当前指挥任务及分类错误摘要，按需展开详细额度和高级操作；常规刷新保留展开状态，切换账号池后重置。

额度页保留官方来源、查询时间、各窗口用量与到期/重置性质。“全量探查额度”覆盖全部已导入账号，包括状态未知或尚无执行器的账号，无需先启动执行器；也可从账号卡片单独查询。可见时每 60 秒自动查询，批量结果分别报告成功与失败；查询失败保留旧值并提示，导入快照不等于实时余额。未知比例、等级和时间均显示未知。

“设置”可修改全池并发上限、指挥默认配额及恢复设置：默认 5 秒重试、2 分钟连续恢复等待让号、15 分钟静默只读核查、低额度 5%。界面时长保存为后台毫秒；重试次数没有总上限。全池或相应配额设为 0 暂停新派发，已有执行继续。

“断开面板”停止查询，不取消任务；关闭 VS Code 也不表示完工。日常开工与完成后的自动收尾由指挥按[使用约定](../codex-workflow.md)处理。手动“收工：停止实例与后台”在全池无活动或未知执行占用时才停止 Worker 和后台，保留账号、任务及未完成待办；存在占用则拒绝。再次使用需明确启动。

## 源码与 F5

在项目根目录：

```bash
npm ci
npm --prefix extensions/vscode ci
npm --prefix extensions/vscode run build
```

Remote SSH 调试时，从另一台电脑连接这台 Linux，打开远程项目根目录。F5 会自动构建；新的 Extension Development Host 窗口显示在当前电脑，扩展和后台仍在同一台 Linux 执行，新窗口默认打开远程 fixture 子目录。

用 VS Code 打开项目根目录，在“运行和调试”选择 **ZCode Pool: Mock UI (no daemon)** 按 F5；调试窗口中打开工作台并连接监控。Mock 使用内存样例，始终标注演示模式，不连接真实池、账号或模型。样例损坏会报错，不转连真实服务。重载窗口重置数据。

真实开发连接选择 **ZCode Pool: Real daemon (explicit connect)**，直接复用已保存的账号池目录，无需每次选择；未配置时默认使用当前 Linux 用户的 `~/.zcode_pool`。进入新窗口后点击“启动后台并连接”，无需提前启动后台。

生产包忽略 Mock 调试环境变量。Host 可打断点，Webview 使用 **Developer: Open Webview Developer Tools**。持续构建使用 `npm --prefix extensions/vscode run watch`，避免两个进程同时写 `dist`。

受限工作区只读，写动作须通过 Host 的 Workspace Trust、能力及连接新鲜度检查。账号导入仅支持 OAuth JSON；原生选择器处理路径与凭据，Webview 不接收它们。

## 检查与打包

```bash
npm run typecheck
npm test
npm --prefix extensions/vscode run build
npm --prefix extensions/vscode run test:unit
npm --prefix extensions/vscode run test:integration
npm --prefix extensions/vscode run test:browser
npm --prefix extensions/vscode run package:vsix
npm --prefix extensions/vscode run package:check
```

`test:browser` 使用实际 Host/router 与真实 Webview bundle、隔离内存 Mock，默认 Chrome 路径 `/usr/bin/google-chrome`，可用 `ZCODE_POOL_CHROME_PATH` 覆盖。截图和报告在 `.test-browser/`。覆盖实际串并行依赖、展开、确认、返工、窄宽屏、主题与审批/交付操作，不能代替真实账号或 VS Code 宿主验收。

宿主测试使用隔离 VS Code 用户目录；无图形会话可用 Xvfb：

```bash
xvfb-run -a env ZCODE_POOL_VSCODE_VERSION=1.95.3 npm --prefix extensions/vscode run test:smoke
xvfb-run -a env ZCODE_POOL_VSCODE_VERSION=1.95.3 ZCODE_POOL_SMOKE_RESTRICTED=1 npm --prefix extensions/vscode run test:smoke
xvfb-run -a npm --prefix extensions/vscode run test:installed
npm run test:daemon-package
```

这些默认检查不发送真实模型任务。`test:real-model` 是独立显式启用入口，可能消耗所选账号额度；不要以常规回归为由运行。实际执行结果与客观限制只在[当前验证](../validation/current.md)维护。

## 连接排查

没有 F5 配置时确认打开的是项目根目录。路径错误时使用“选择连接目录”，填写不带引号、反引号或 `~` 的执行侧绝对路径；修改后重连，无需重新 F5。连接失败先核对界面显示的执行侧、池路径与错误，不要为排查再次派发原任务。

未知占用先核对原执行；完整审批、不可变 Diff 和不确定写结果的处理见[工作台合同](design.md)，恢复规则见[恢复说明](../recovery.md)。
