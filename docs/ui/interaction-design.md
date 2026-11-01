# VS Code 可视化与交互设计

状态：设计提案，尚未实现 VS Code 扩展或下述新增接口。核对日期：2026-11-01；本仓库核对基线：`ac55e71818d1b13c5a210f43abf870d2625d7958`。本文只规划界面，未实现部分的运行边界和 API 缺口见 [集成契约](integration-contract.md)。

## 推荐形态

主要在 VS Code 中使用 Codex，优先做 **VS Code workspace extension**：用原生侧栏和状态栏掌握任务，用按需打开的 `WebviewPanel` 审阅详情、审批和管理资源。daemon 继续独立运行，扩展只作为客户端。关闭面板、重载窗口或关闭 VS Code 都不能解释为取消任务。

侧栏负责索引和状态，Webview 补充复杂审阅，保留现有 CLI、MCP 和 daemon 的边界。VS Code 官方建议数据列表优先采用 Tree View，并以 Webview 补充复杂详情；GitHub Pull Request 的列表加详情也是其列出的示例。[Views 指南](https://code.visualstudio.com/api/ux-guidelines/views)、[Webviews UX 指南](https://code.visualstudio.com/api/ux-guidelines/webviews)

| 方案 | 对当前使用方式的价值 | 必须承担的工作 | 建议 |
| --- | --- | --- | --- |
| 原生 VS Code 扩展，Tree View + Status Bar + WebviewPanel | 随代码查看任务、跳转文件、使用原生 Diff；Remote SSH / WSL 能与项目同机连接 daemon | 扩展消息桥、主题和键盘适配、远程兼容测试 | 首选；原生组件做日常入口，Webview 做详情 |
| 独立 Web 管理台 | 浏览器可看，未来适合跨编辑器使用 | 浏览器不能直接连接 Unix socket；需另建 HTTP/WebSocket 桥、认证、来源校验及远程访问策略 | 后续复用界面组件时再考虑；静态原型不能充当可操作管理台 |
| 独立桌面应用，例如 Tauri | 不开编辑器也能管理，适合托盘入口 | 应用打包更新、桌面权限和本地/远程桥接；当前 Linux daemon 仍需单独部署 | 暂无必要；参考项目使用 Tauri 不构成本项目选它的理由 |

## 视觉参考与布局原则

参考 [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch) 的 [commit f34225686dfef05d84c256a56f868719248f15ff](https://github.com/pjpv/zcode-switch/tree/f34225686dfef05d84c256a56f868719248f15ff)，包括其 [截图](https://github.com/pjpv/zcode-switch/blob/f34225686dfef05d84c256a56f868719248f15ff/docs/screenshot.png)和 [MIT 许可](https://github.com/pjpv/zcode-switch/blob/f34225686dfef05d84c256a56f868719248f15ff/LICENSE)。版权标注为 `Copyright (c) 2026 zcode-switch contributors`。本地克隆为可选参考：[截图](../../references/zcode-switch/docs/screenshot.png)、[样式](../../references/zcode-switch/src/styles.css)、[LICENSE](../../references/zcode-switch/LICENSE)。

借鉴的仅是视觉语言：深色中性底、细分隔线、克制的琥珀强调色、清晰的状态标签、等宽数字、紧凑资源行和就地展开。本文不复制其源码、图标、品牌或页面布局；若未来实际复用代码或素材，应保留对应版权和 MIT 许可声明。

参考工具围绕账号切换；本项目围绕多个项目的隔离任务，因此主页面以任务为中心。账号列表属于资源管理，不使用“当前唯一账号”作为全局主视觉，也不提供改变共享官方登录身份的“切换”按钮。

生产扩展应优先使用 `--vscode-*` 主题色、编辑器字体和 Codicon。琥珀只用于需要注意的状态或一个主要操作，成功、错误同时带文字和图标。浅色、高对比度与键盘导航必须可用；不照搬固定黑色背景、字体尺寸或荧光效果。以上是本项目的设计取舍；主题和可访问性要求参见 [Webviews UX 指南](https://code.visualstudio.com/api/ux-guidelines/webviews)。

## 信息结构

### 日常入口

一个 `ZCode Pool` View Container，默认放原生侧栏，用户可以移动到辅助侧栏。内部最多两个原生 Tree View：

- **任务**：按“需要处理 / 执行中 / 最近结束”分组，默认筛选当前项目，提供“整个池”切换。每行展示任务短 ID、项目、状态和必要提醒，选中后打开详情。标题栏只放刷新与打开管理面板，更多动作放上下文菜单。
- **资源**：账户 → 对应 Worker，另列 workspace。显示容量与占用的来源；可展开查看关联任务。资源不是固定属于当前 VS Code 窗口。

Activity Bar 点击打开这些视图，不直接弹出编辑区 Webview。树行代表实际对象；操作使用行内动作或上下文菜单，每行最多三个常用动作，符合 [Views 指南](https://code.visualstudio.com/api/ux-guidelines/views)。

状态栏只放一个工作区级入口，例如 `ZCode · 2 执行 · 1 待处理`。断连时改成 `ZCode · 连接中断`，保留最近快照时间；不把所有账户余额塞进状态栏，也不持续用醒目自定义底色。点击定位任务视图。长度和数量控制依据 [Status Bar 指南](https://code.visualstudio.com/api/ux-guidelines/status-bar)。

### 详情与管理面板

按用户操作打开一个可复用的编辑区 `WebviewPanel`。从任务视图进入时保留选中的 task ID；从命令面板进入时恢复上次的筛选。页面结构为：

1. 顶部上下文：连接主机、pool、项目筛选、最近同步时间；明确区分 `SSH: host-a`、`WSL: Ubuntu` 与本机。
2. 工作区级摘要：执行、待审批、需检查、占用未知。计数的范围必须与筛选一致，并注明是否只是最近 50 条。
3. 主列表：项目 / workspace、任务状态、Worker、更新时间、续跑次数；选中任务后在详情区审阅。
4. 详情页签：概况、审批、交付与核验、事件。事件和补丁均按需分页读取，不默认拉取原生会话全文。
5. 资源管理入口：账号与 Worker、workspace。使用同一详情框架，不重复一套侧边导航。

宽面板可呈现列表与详情双列；窄面板改成列表 → 详情返回，保持选择和滚动位置。不要按桌面应用的固定宽度压缩到账户卡片中。面板只保存筛选、task ID、页签和游标；执行状态以 daemon 为准，凭据、审批全文不写入 Webview 持久状态。

## 主要用户流程

### 看当前项目与整个池

打开侧栏先看当前项目的任务，需要时切到整个 pool。同一 pool 的 CLI、Codex MCP 和多个 VS Code 窗口共享状态；切换筛选不改变任务或账号绑定。多根 workspace 显式选择仓库，任务执行的隔离 worktree 与当前 VS Code 窗口分别标识。

日常读任务状态，需要解释时再打开详情、事件或交付。当前只有最近 50 个任务的概览，界面应显示范围，不能用本地搜索伪装完整历史。账户额度区分导入快照、未查询、查询失败和过期，不能画成持续实时更新的云端余额。

### 处理审批与未知占用

待审批行打开对应交互，先看操作参数、目标和完整度，再按已有授权决定。摘要、完整详情、审阅不完整与答复待原生确认分别显示。参数被截断或无法归属时明确提示缺失，不能凭短摘要批准；当前也不支持任意原生选项表单或批量批准。

提交批准、拒绝或原生交互取消后，保留“等待原生确认”；其他客户端已处理时刷新当前卡片。取消整个任务另用任务动作。连接断开、超时或无事件不代表任务已停止；“占用未知”继续挡住 Worker/workspace 复用，提供对账和检查入口，不提供强制解锁。完整状态和审批契约见 [集成契约](integration-contract.md)。

### 模型繁忙与取消

展示“模型繁忙，原会话已继续 1/3 次”。默认首次派发后最多再继续三次；配置允许 0–10，0 关闭。daemon 只有确认当前回合因明确模型繁忙失败且无活动执行后，才立即在同账号、模型和会话发送“继续”。界面不显示退避倒计时、不重发原任务，也不自动换资源。次数不会因刷新清零；耗尽后保留原任务失败记录。详见 [繁忙恢复](../busy-recovery.md)。

点击取消后显示“取消请求已记录，等待终止确认”，阻止后续自动续跑，保留资源占用直到确认停止。无法定位原回合时提示需检查；关闭面板不能当成取消，也不能退化为停止整个 Worker。

### 审阅交付

结束后先看总结、变更文件和核验结果，需要时再翻阅补丁。只配置 `git diff --check` 时标明仍需功能验收。现有 patch 是相对 workspace baseCommit 的累计变更，并不包含未跟踪文件内容；原生历史 Diff 需要先补工件读取能力。

Codex 与面板是并列客户端。打开 Dashboard、展开日志和审批详情都不会自动把内容送进 Codex；MCP 继续按需返回精简结果。

## 分阶段落地

### 阶段一：只读面板

实现 Node workspace extension、原生任务/资源视图、单个状态栏入口、按需详情面板及安全消息桥。只连接已有 daemon；先用 `overview` + 已知 task IDs 的 `wait`，按需读 `get_result/get_logs/get_diff`。不自动调用 probe、resume、reconcile、dispatch 或任何启停方法。

对最近 50 条、无完整停止标志、额度快照和 patch 范围显式标记。静态视觉原型中的示例数字和状态均标为演示；没有动作适配器时不显示伪成功。只读阶段的交付是可靠看见已有状态，不以补齐所有后台新接口为前提。

### 阶段二：动作与审批

先补详情、完整审阅和动作绑定的必要契约，再加入对账、恢复观察、取消、单项审批和 Worker 启停。界面说明恢复可能启动既有核验或有界续跑；批准依赖完整操作审阅和现有授权，拒绝/取消保留各自语义。未知占用继续禁止复用，无强制解锁。

验收需覆盖：其他客户端先处理审批、ACK 早于 pending 更新、审批参数截断、恢复时不能归属、取消后不再续跑、繁忙 3 次耗尽、发送 ACK 丢失、daemon 重启和窗口重载。必须证明这些场景不会重发未知任务、重复答复或释放不明占用。

### 阶段三：workspace、Diff 与账号导入

补受限工件读取和更完整的列表/额度 read model，集成原生 `vscode.diff`。加入明确选择源仓库/base ref、创建 worktree、任务派发和本机 OAuth JSON 导入；导入通过 Host 的文件选择与 daemon 完成，敏感文件内容不穿过 Webview。新任务表单展示实际执行目录、Worker/账号、模型、session 策略、繁忙上限及核验命令；不自动从仓库提取命令运行。

对不可用 API 保持禁用并写明原因，例如合并、清理 workspace、账号删除/改名/登录。后续是否做独立 Web 或桌面客户端，按实际跨编辑器需求再决定，不影响 daemon 与 MCP 的独立性。

各阶段都不自动更改 Codex 配置、共享官方登录、系统服务或启动策略。部署、启用服务和新增 MCP 连接保留为清楚的独立操作，沿用 [开发运行](../development.md)、[后台服务](../service.md) 和 [上下文预算](../context-policy.md) 的现有边界。
