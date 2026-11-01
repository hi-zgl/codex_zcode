# VS Code 可视化与交互设计

本文保留实现前的设计基线（`21d4663`）。下文阶段、拟议文件与接口用于说明设计约束，不代表当前开发状态；已落地代码、运行方法及验证边界以[运行与测试指南](implementation.md)和[验收记录](../validation/2026-11-01-vscode.md)为准。

阅读顺序：[流程与状态](flows-and-states.md) → [集成契约](integration-contract.md) → [扩展架构](extension-architecture.md) → [开发与验收](development-and-acceptance.md)。本文负责形态、屏幕和交互原则；按钮条件与异常反馈见流程文档。

## 产品形态

优先做 **workspace extension：原生侧栏 + 一个状态栏入口 + 按需打开的编辑区 WebviewPanel**。daemon 继续在 Linux 上用独立 Node.js 24 运行；扩展只是客户端。关闭面板、重载窗口、断开 UI 或退出 VS Code 都不取消任务。

| 形态 | 适用价值 | 当前选择 |
| --- | --- | --- |
| VS Code 原生视图 + 详情 Webview | 代码旁跟踪任务，复用文件导航、主题、键盘和原生 Diff；SSH/WSL 与 daemon 同侧运行 | 首选 |
| 独立 Web 管理台 | 跨编辑器访问 | 暂缓；浏览器到 Unix socket 还需认证和桥接 |
| 独立桌面应用 | 离开编辑器管理 | 暂缓；多一套打包、更新和远程连接，不解决现有 Linux 边界 |

日常索引用 Tree View，复杂审阅用 Webview；Activity Bar 只打开视图容器，不直接弹出编辑区。这个组合符合 VS Code 对数据列表和 Webview 的分工建议。[Views 指南](https://code.visualstudio.com/api/ux-guidelines/views)、[Webview API](https://code.visualstudio.com/api/extension-guides/webview)

## 视觉参考

参考 [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch/tree/f34225686dfef05d84c256a56f868719248f15ff) 的固定版本 `f34225686dfef05d84c256a56f868719248f15ff`：[截图](https://github.com/pjpv/zcode-switch/blob/f34225686dfef05d84c256a56f868719248f15ff/docs/screenshot.png)、[MIT 许可](https://github.com/pjpv/zcode-switch/blob/f34225686dfef05d84c256a56f868719248f15ff/LICENSE)，版权为 `Copyright (c) 2026 zcode-switch contributors`。可选本地参考保留在 `references/zcode-switch/`；不纳入主项目 Git。

借鉴中性底色、细分隔线、克制的琥珀强调、紧凑资源行、清楚的标签和等宽数字。主页面围绕多项目任务，不照搬账号切换工具的布局、品牌、图标或源码。若未来复用实际素材或代码，保留对应许可。

**生产样式跟随 VS Code**：使用 `--vscode-*` 主题色、编辑器字体与 Codicon；固定深色仅是静态原型的参考外观。注意状态同时带文字/图标，浅色、高对比度、屏幕阅读器和减少动画模式都要可用。[主题与可访问性 API](https://code.visualstudio.com/api/extension-guides/webview#theming-webview-content)

## 公共名词与入口

pool 是同一主机、用户和规范化路径下的资源池；项目按源仓库归组；**任务 workspace** 是 pool 创建的隔离 git worktree，区别于 VS Code 工作区窗口。Worker 绑定一个账号，`ready` 只说明可连接，不能等同空闲。任务身份是 `taskId`，繁忙续跑不会创建另一个任务。

| 入口 | 固定 ID | 内容与操作 |
| --- | --- | --- |
| Activity Bar 容器 | `zcodePool` | 标题 ZCode Pool；打开原生视图 |
| 任务 Tree View | `zcodePool.tasks` | 项目/状态筛选下的任务索引；需要处理、执行中、最近结束分组 |
| 资源 Tree View | `zcodePool.resources` | Workers / Accounts / Workspaces 三组，定位关联任务 |
| 编辑区面板 | `zcodePool.workbench` | 同窗口复用一个面板；恢复选中 task、页签和筛选 |
| 状态栏 | 一个工作区级 item | `ZCode · 未连接`、`ZCode · 近期 2 执行 · 1 需处理` 或连接中断；点击打开工作台并聚焦需要处理 |

状态栏计数与当前项目/列表范围一致，tooltip 说明主机、pool、快照时间和“最近 50 条”限制；不显示无法证明的全池总数或多个账号余额，不持续使用自定义醒目背景。[Status Bar 指南](https://code.visualstudio.com/api/ux-guidelines/status-bar)

命令统一使用 `zcodePool.*`：`openWorkbench`、`connect`、`disconnect`、`refresh`、`openSettings`、`openTask`、`newTask`、`cancelTask`、`reconcileTask`、`resumeTask`、`respondApproval`、`importAccounts`、`startWorker`、`stopWorker`、`probeWorker`、`createWorkspace`。完整参数和 menu 条件以[扩展架构](extension-architecture.md)为准；命令 ID 不是 daemon RPC 名。

## 屏幕清单与区块

顶部始终标明执行侧，例如 `SSH: host-a · ~/.zcode_pool`；项目筛选不改变账号或任务绑定。工作台以任务列表/详情为主，资源和设置由同一面板入口打开，不再复制一套应用侧栏。

| 屏幕 | 区块与默认内容 | 主要操作 | 次要操作 |
| --- | --- | --- | --- |
| 首次连接 / 连接异常 | Host 类型、pool 路径、支持边界、连接结果、脱敏诊断；未连接不显示伪造业务空态 | 连接已有 daemon | 修改设置、运行指引、复制诊断 |
| 任务列表 | 主机/pool、项目选择、来源范围、筛选、任务行、已载入计数、详情区域 | 打开任务；M2 新任务 | 刷新、清除筛选；M3 加载历史 |
| 任务详情 / 审批 | 身份和状态、账号/Worker/实际执行目录、概况/审批/交付与核验/事件四页签、占用与动作反馈 | 当前上下文唯一主动作，如审阅审批或查看交付 | 取消任务、核对执行状态、恢复观察；条件见状态表 |
| 交付与核验 | 总结、blockers、命令与退出码、不可变快照身份、baseCommit、文件列表、Diff/工件内容 | 打开原生 Diff；完成后标记本客户端已审阅 | 加载 patch、读取未跟踪工件、打开当前文件 |
| 资源管理 | 账号来源/健康/额度、Worker 状态与两类占用、workspace 仓库/分支/baseCommit、关联任务 | 按对象启动/探测/创建/导入 | 停止空闲 Worker、查看关联任务；不提供账号切换、合并、删除 |
| 新任务 / 创建 workspace | 明确仓库与 base ref，实际 worktree、Worker/账号、提示词、模型、session、mode、续跑上限、核验命令 | 创建 workspace 或派发任务 | 保存本次非敏感选择、回到任务；不自动读仓库命令执行 |
| 设置 | Host 环境说明、pool 路径、概览发现间隔、脱敏诊断；Node/loader 只属于未来启动能力，M2 无该设置 | 保存设置；连接是独立操作 | 查看运行指引；不自动修改 Codex/MCP/systemd |

原生任务行显示短 ID、状态、项目/任务 workspace、Worker、续跑提醒；标题栏保留刷新和打开工作台，常用行内动作最多三个，其余放上下文菜单。M1 缺少安全标题/时间字段时用 task ID 和“—”，不截取 prompt 造标题。

宽工作台按“列表 | 详情”布局；小于 760px 切换为“列表 → 详情 → 返回”，保持筛选、选中和滚动位置。小于 480px 元数据改成单列，动作换行，审批参数和代码仅在自身区域横向滚动。原生侧栏不嵌整页工作台。完整键盘和反馈规格见[流程与状态](flows-and-states.md#键盘窄屏与反馈)。

## 必须保持的交互语义

- 第一次打开/F5 仅初始化“未连接”；点击连接后才协商并读数据。连接已有 daemon，不隐式启动 daemon、Worker、模型、核验、探测或系统服务。
- 后台状态、连接新鲜度、占用、人工审阅是四个独立维度。`verifying` 只叫“核验中”；`succeeded` 可显示“已完成 · 待人工审阅”。本地审阅标记不更改 daemon 状态，也不宣称其他客户端已审阅。
- 审批预览不等于完整内容，读全不等于取得授权。没有完整来源时整个审批只读；有来源但未读全时不能批准。答复 ACK 后保留“等待原生确认”，不乐观移除审批。
- 默认繁忙恢复是初次派发后最多 3 次原会话立即发送“继续”，范围 0–10。没有退避倒计时，不换账号/模型、不重发原提示词；取消请求阻止后续续跑。
- 取消 ACK、断连或没有事件都不证明停止。占用未知继续阻止 Worker/workspace 复用，只提供检查和对账，不提供强制解锁。
- “核对执行状态”不发模型命令、不运行核验，但会更新本地任务记录，并可能释放已证实停止的占用；“恢复观察”可能运行后续核验或有界续跑。两者都不是普通刷新，M1 不自动调用。
- 交付 patch 是相对 workspace `baseCommit` 的累计变更，未跟踪文件内容另存工件。原生 Diff 必须读不可变 base/final，不能用当前磁盘冒充历史交付。
- 普通查看、筛选、刷新、连接、对账、探测、单次审批、取消和停止空闲 Worker 不额外弹一层确认。把目标、范围和效果写在动作旁，最终点击即提交；不以每次勾选免责声明代替完整审阅。

## 阶段与交付边界

| 阶段 | 能力与验收门槛 |
| --- | --- |
| M0 本轮设计 | 设计文档 + 已有本地静态原型；无扩展清单、launch.json、真实连接、账号导入或服务修改 |
| M1 legacy 只读兼容 | 用户显式连接；近期 50 条、已知任务 wait、结果、事件 20 条/页、patch 4000 UTF-16 单元/页；只读投影必须安全，写动作和本地审阅按钮不可用 |
| M2 可信可操作首版 | 先补 capability、安全详情、完整审批读取/内容绑定答复、额度来源和不可变文件快照；按独立能力及信任门槛开放取消/恢复/审批、Worker、workspace、Host 导入与派发；原生 Diff 和本地审阅此时可用 |
| M3 扩展规模 | 稳定全历史列表、服务器筛选/分页、全池变更 feed 等；不作为 M1 可用的前提 |

M2 的能力缺失可按项降级，不把不完整 daemon 宣称为全部可操作首版。审批不回退旧 `respond_approval` 绕过审阅绑定，旧任务缺文件快照时原生 Diff 明确不可用。[接口门槛](integration-contract.md)与[开发验收](development-and-acceptance.md)共同定义完成标准。

原型已演示任务筛选、单项审批结果、繁忙续跑、对账/显式恢复、静态差异与核验、账号展开、本地审阅和窄侧栏；原型“只读对账”等标签的生产语义差距，以及首次连接、分页、完整审批/ACK/并发、取消未知、真实额度/导入、创建/派发和主题适配，见[流程文档覆盖及验收索引](flows-and-states.md#原型覆盖与验收索引)。
