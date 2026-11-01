# Codex 调度多账号 ZCode

本项目用于构建由 Codex 统一调度、多个独立账号的 ZCode Worker 执行开发任务的本地系统。

已实现 Linux / Node.js 24 原型，包含调度服务、CLI、MCP、账号与实例管理、持久化任务核心及 ZCode 协议适配器。使用 **官方 ZCode Server 多实例 + 常驻调度服务 + MCP 薄入口**，不修改 ZCode 安装包。Codex 负责拆分、派发与验收，VS Code 面板用于监控、查看额度和人工干预。已在本机跑通真实 Start Plan 任务、同会话续接及双账号并行；生产化能力与边界见实测记录。

## 日常使用

1. 在 Linux 执行侧安装 ZCode Pool VSIX，准备 Node.js 24+ 和官方 ZCode 运行环境。扩展已捆绑调度后台、CLI 与 MCP，无需另装本项目的 daemon 包或保留开发 checkout。
2. 打开 **ZCode Pool: Open Workbench**，确认运行环境和连接目录，按需“启动后台并连接”。在“额度与资源”中导入账号、启动执行器并创建独立任务目录。
3. 点击“连接 Codex / 生成 MCP 配置”，按打开的说明一次添加到同一执行侧的 Codex，并重新连接 Codex。配置生成不会自动写入 Codex 设置，也不代表 Codex 已连接。MCP 与面板引用共享连接资料，后续切换目录不用重复添加服务器。
4. 在 Codex 中说明目标、可修改范围和验收方式，由 Codex 调用 MCP 调度 ZCode。面板默认显示任务监控；需要时查看额度、处理原生审批、检查交付 Diff，或在设置中调整并发上限。

并发上限由后台统一执行，MCP 和面板共享。`0` 暂停新派发，留空表示不限制；降低上限不停止已有任务，超限请求也不会自动排队。手动派发表单位于任务页“高级操作”。关闭工作台后，后台任务继续运行。

升级扩展不会自动重启已有旧 daemon；需先处理当前任务，再显式停止旧服务并启动新后台。当前数据库为 schema 4，旧库由新后台迁移，迁移后不混用旧程序。

安装与完整操作见 [VS Code 使用指南](docs/ui/implementation.md)，Codex 调度规则见 [主会话调度约定](docs/codex-workflow.md)。

## 当前交付状态

**首版可运行原型已完成，完整生产版尚未完成。**

| 范围 | 当前状态 |
| --- | --- |
| 无窗口官方 Server、多账号隔离、真实 Start Plan 任务 | 已实现并实测 |
| CLI、MCP、daemon、状态持久化、测试核验、差异快照 | 已实现；本地自动测试与双账号 daemon 实测通过 |
| 一体 VSIX 后台交付、MCP 配置生成、共享并发上限 | 已实现；扩展包含调度后台，生成配置后仍需在 Codex 启用 |
| 同会话续接、审批、未知执行状态保留与显式对账 | 已实现；真实续接和审批恢复已验证 |
| 自动合并/清理、账号续期、自动队列调度、完整跨账号交接 | 尚未实现 |
| 模型繁忙后原会话立即续跑 | 已实现有界续跑；发送状态不明时不重发，见 [处理规则](docs/busy-recovery.md) |
| 原任务重新附着、MCP 输出预算、systemd 用户服务配置 | 已实现；恢复不重发提示词，具体边界见运行指南 |
| 长任务、大规模并发及真实异常恢复验证 | 尚未完成 |

## 开发入口

[安装、运行与当前限制](docs/development.md) · [主会话调度约定](docs/codex-workflow.md) · [上下文输出策略](docs/context-policy.md) · [首版实测记录](docs/validation/2026-11-01.md) · [恢复与上下文验证](docs/validation/2026-11-01-recovery-context.md) · [续跑验证（136 项测试）](docs/validation/2026-11-01-busy-continuation.md) · `npm run typecheck` · `npm test`

## VS Code 可视化扩展

已实现原生任务/资源侧栏、任务监控工作台、额度来源、并发干预、MCP 配置入口、审批与不可变 Diff。扩展捆绑后台并在显式操作时准备/启动服务；也可连接同一执行侧已有 daemon。见[使用、F5 与测试指南](docs/ui/implementation.md)、[实现验收记录](docs/validation/2026-11-01-vscode.md)及[设计规格](docs/ui/README.md)。不用 VS Code 时，也可使用[独立安装包](docs/distribution.md)。

## 阅读入口

- [方案总览](docs/design/README.md)：先了解目标与架构。
- [系统架构与模块划分](docs/design/architecture.md)：接入形态决策、进程拓扑和模块边界。
- [调研依据与方案比较](docs/design/research-and-options.md)：查看已证实能力与待验证事项。
- [账号隔离与实例运行](docs/design/worker-runtime.md)：准备 Worker 时使用。
- [任务调度与代码集成](docs/design/task-orchestration.md)：实现协议适配、MCP 和开发闭环时使用。
- [实施路线与验收标准](docs/design/validation-roadmap.md)：按阶段验证与推进。

## 目录说明

```text
codex_zcode/
├── README.md                 # 项目入口与交付状态
├── package.json              # 开发命令与依赖
├── package-lock.json         # 锁定依赖版本
├── tsconfig.json             # TypeScript 配置
├── .gitignore                # 账号、运行产物、依赖和参考克隆忽略规则
├── bin/                      # 独立安装包 CLI 启动器
├── extensions/vscode/        # VS Code 扩展源码、构建与测试
├── .vscode/                  # F5 Mock / 真实连接调试配置
├── src/                      # daemon、MCP、CLI、协议与账号管理
├── test/                     # 自动测试与脱敏 fixtures，不主动消耗额度
├── scripts/                  # 显式运行的真实任务验证脚本
├── docs/
│   ├── development.md        # 安装、运行与限制
│   ├── design/               # 目标架构与设计
│   ├── validation/           # 实测报告
│   └── research/             # 本地历史研究对话原文（不纳入 Git）
├── references/
│   ├── README.md             # 外部源码用途及版本记录
│   └── cockpit-tools/        # 独立参考仓库，不参与运行
├── data/accounts/            # 本地账号导出，不纳入 Git
├── runtime/                  # 本地实例、worktree 和原始测试证据
└── node_modules/             # npm 安装的依赖
```

`references/cockpit-tools/` 已从根目录迁入参考目录，保留原 Git 仓库；调度器不依赖它运行。`runtime/` 内含绝对路径和 worktree 元数据，保留原位，不直接移动或删除。

账号导出由原根目录移动到 `data/accounts/`，文件名和内容保持不变。使用时传入新路径；该目录仅供本地账号导入使用，不作为 Worker 的共享运行目录。

原根目录的 `ZCode-多账号多开与Codex调度方案.md` 已拆分到 `docs/design/`。历史研究记录保留原文，其中的旧路径和结论以当前设计文档为准。

版本管理包含源码、测试、脚本、依赖锁文件与维护文档。`references/`、`data/accounts/`、`runtime/`、`node_modules/` 和 `docs/research/` 为本地资料或生成内容，不纳入 Git；新克隆的仓库不包含这些目录。
