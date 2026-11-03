# 文件与存储布局

[项目入口](../README.md) · [运行时隔离](design/worker-runtime.md)

源码、私人账号导出与运行状态分开。普通 VSIX 使用不依赖保留开发 checkout。

| 内容 | 位置与管理 |
| --- | --- |
| 源码、脱敏测试与当前说明 | 仓库 `src/`、`test/`、`docs/`，Git 跟踪 |
| 共享账号池 | 默认 `~/.zcode_pool/`，可在面板选择执行侧绝对路径 |
| SQLite、socket、锁和日志 | `<pool>/scheduler/`，由后台统一维护 |
| 加密账号库与密钥 | `<pool>/accounts/`，仅当前用户可读；密钥与库一起备份 |
| 独立官方 Server 数据与会话 | `<pool>/workers/<worker>/`，与默认官方客户端隔离 |
| 工作目录与固定交付 | 后台创建的 worktree 与关联工件目录；含绝对路径和恢复引用，不随意搬动 |
| 原始账号导出 | 建议仓库外 `~/.local/share/zcode-pool/imports/`，目录 0700、文件 0600 |
| 扩展后台与共享连接资料 | 当前 Linux 执行侧的 VS Code 扩展 globalStorage，由扩展维护 |
| 开发截图、原始测试产物与依赖缓存 | `runtime/`、扩展 `.test-browser/` 等忽略目录；只将必要脱敏结论写入当前验证说明 |

`references/`、`data/accounts/`、`runtime/`、`node_modules/` 等本地资料与生成内容不纳入 Git。忽略规则不替代文件权限。文档不堆积过程日志、旧报告或归档副本。

切换面板连接目录只是选择另一个池，不迁移旧任务。已有任务、worktree 元数据、Worker 启动参数与会话可能引用绝对路径；不要简单移动仍在使用的池。当前没有完整池迁移工具。

备份应覆盖账号库与密钥、调度状态及关联交付。运行中的 SQLite 需一致性备份，不只复制 `state.db` 而遗漏 WAL。删除或移动运行数据前先确认相关任务和进程已停止；本文不授权清理用户已有池。
