# 文件存放与运行数据整理

源码、账号和运行状态分开放置。普通使用时不需要保留本项目 checkout；VSIX 内置的后台由扩展维护。以下长期目录是建议，不表示已迁移现有数据。

| 内容 | 建议位置 | 管理方式 |
| --- | --- | --- |
| 源码、测试、脱敏说明与验收结论 | 项目仓库 `src/`、`test/`、`docs/` | Git 跟踪；过程日志不混入文档 |
| 正式 pool：账号库、任务数据库、Worker 数据、交付记录 | 默认 `~/.zcode_pool/`；多个独立 pool 可用 `~/.local/share/zcode-pool/pools/<名称>/` | 由后台管理；面板选择绝对目录，Codex 读取共享连接资料 |
| 原始账号导出文件 | `~/.local/share/zcode-pool/imports/` | 仅供导入/恢复，目录 `0700`、文件 `0600`；不提交 Git、不放源码或模型任务 workspace |
| 已导入账号 | `<pool>/accounts/` | 程序加密保存；`.secret` 是解密依赖，不移动单个文件或单独丢弃密钥 |
| 任务工作目录 | 后台创建的隔离 worktree | 与业务源码和任务记录关联；按任务生命周期处理，不当临时缓存清理 |
| 日常任务日志与交付物 | `<pool>/scheduler/` 及后台所管理的工件目录 | 与 task ID、审批和恢复关联，不手工重排 |
| 本项目开发测试日志 | `runtime/logs/development/` | 本地保留，Git 忽略；有价值的结论脱敏写入 `docs/validation/` |
| 历史开发实验 | `runtime/archive/<日期>/` | 保留目录结构和迁移记录；归档不等于可公开或可随意删除 |
| 下载缓存、测试程序 | `~/.cache/zcode-pool/development/` | 可重新下载的内容；确认无进程使用后再清理 |
| 扩展后台运行文件、共享连接资料 | VS Code 当前执行侧的扩展 globalStorage | 扩展管理；不要存放账号导出。Remote SSH 的这些文件在远程机器上 |

账号原始导出与 pool 中的加密账号库用途不同。导入后，运行使用后台账号库；原始导出是否保留取决于恢复需要。现有仓库 `data/accounts/` 已被忽略，本轮未搬动或读取其中凭据；今后建议将新导出放在上述独立私有目录。Git 忽略不会替代文件权限或备份保护。

## 当前机器整理结果（2026-11-01）

```text
runtime/
├── README.md
├── p1/                         # 当前使用的 pool，原路径保留
├── logs/development/           # 两份开发测试日志
└── archive/2026-11-01/
    ├── moves.json              # 原路径与新路径对照（本地，不入 Git）
    ├── ui-preview/             # 历史原型检查及依赖
    └── isolated-test-pool/     # 历史隔离测试数据
```

原 `runtime/vscode-download/` 整体移动到 `~/.cache/zcode-pool/development/vscode-download/`，没有删除下载包、程序或实验数据。约 1.4 GB 的主要缓存移出仓库目录，磁盘总占用并未因此下降。后台和 Worker a 仍使用 `runtime/p1/`。整理时，池中三个已有任务均为 `succeeded` 且未持有 lease；这不意味着可以直接搬走仍在运行的 Worker 数据。

## 现有 pool 的迁移边界

面板“选择连接目录”只是选另一个 pool，不会迁移旧目录。当前任务数据库、Git worktree 元数据、Worker 启动参数与会话可能包含绝对路径；因此不能简单 `mv runtime/p1 ~/.zcode_pool`，也不要通过目录链接掩盖迁移。

当前项目尚无完整 pool 迁移工具。最简单的长期方案是：保留旧 pool 供历史查询；未来在仓库外创建新 pool，重新导入账号并按顺序重新绑定 Worker。相同账号切换前，先确认旧任务已停止并停止旧 Worker。若需要保留所有历史及继续会话，应单独执行迁移，核对路径、工作树、任务恢复与连接配置后再启用。

备份也应覆盖账号库与密钥、调度数据库和关联数据。不要仅复制运行中的 SQLite `state.db` 而遗漏 WAL；采用一致性备份或停止相关进程后备份。
