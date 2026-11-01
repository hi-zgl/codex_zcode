# Codex 调度多账号 ZCode

本项目用于构建由 Codex 统一调度、多个独立账号的 ZCode Worker 执行开发任务的本地系统。

已开始实现 Linux / Node.js 24 原型，包含独立调度服务、CLI、MCP 入口、账号与实例管理、持久化任务核心及 ZCode 协议适配器。首选路径为 **官方 ZCode Server 多实例 + 常驻调度服务 + MCP 薄入口**，不修改 ZCode 安装包。目标是纯后台无弹窗、账号和工作目录隔离，以及仅向 Codex 返回精简结果。已在本机跑通真实 Start Plan 任务、同会话续接及双账号并行；生产化能力与边界见实测记录。

## 当前交付状态

**首版可运行原型已完成，完整生产版尚未完成。**

| 范围 | 当前状态 |
| --- | --- |
| 无窗口官方 Server、多账号隔离、真实 Start Plan 任务 | 已实现并实测 |
| CLI、MCP、daemon、状态持久化、测试核验、差异快照 | 已实现；本地自动测试与双账号 daemon 实测通过 |
| 同会话续接、审批、未知执行状态保留与显式对账 | 已实现；真实续接和审批恢复已验证 |
| 自动合并/清理、账号续期、自动队列调度、完整跨账号交接 | 尚未实现 |
| daemon 重启后自动恢复事件订阅、长任务和大规模稳定性 | 尚未完成；当前不自动重放未知任务 |

## 开发入口

[安装、运行与当前限制](docs/development.md) · [首版实测记录](docs/validation/2026-11-01.md) · `npm run typecheck` · `npm test`

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
