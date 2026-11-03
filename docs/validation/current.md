# 当前验证与限制

[项目入口](../../README.md) · [需求说明](../requirements.md) · [未决事项](../open-items.md)

本页只保留当前有效的验证结论与客观边界，不累积逐轮历史日志。实现存在、隔离自动检查和官方真实闭环是不同层级。

本轮按需启停调整在仓库根执行类型检查与核心全套，264/264 通过；收工检查与既有调度、等待、日志和存储统计检查均纳入该全套。此前的 252 项全套属于局部架构优化时的证据。扩展资源与批量额度的聚焦检查是既有证据，在 `extensions/vscode` 下统一以 `node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.host.json --test` 启动，下表列出其参数。本轮未重跑 UI 行为、浏览器、宿主、安装、真实账号闭环或资源基准。

## 当前检查

| 范围 | 当前证据 |
| --- | --- |
| 扩展 Host/Webview 类型、fixture 完整性与运行包构建 | 资源与批量额度调整时 `npm run typecheck`、`npm run build` 通过；本次最终打包再次通过类型、fixture 校验与构建 |
| 扩展单元与 DOM 检查 | 既有 `--test-name-pattern='quota\|probe\|resources' test/unit/host.test.ts` 7/7；`test/unit/resources-view.test.ts test/unit/resources-email-probe.test.ts test/unit/resources-sort.test.ts` 18/18；最终摘要调整后 `--test-name-pattern='resource sections' test/unit/resources-view.test.ts` 1/1，与上述 18 项重叠。覆盖全量账号探测、并发与合流、部分失败、旧连接隔离、资源折叠与刷新保留。既有全量 `test:unit` 145/145 |
| 真实 Chrome + 实际 Host/router + 内存 Mock | 既有 `node .test-browser/resources-focused.mjs` 通过：15 个账号，1280/360 像素下资源折叠、刷新保留、摘要可见、无文字截断或横向溢出；页面高度分别从 5206.6/7103.1 降至 329.4/385.4 像素，最终四张截图已人工检查。既有 `test:browser` 13 组及 280–2560 像素、主题和审批/交付覆盖 |
| 核心总任务、调度与恢复自动测试 | 本轮最终冻结源码 `npm run typecheck && npm test` 通过，264/264，失败、取消、跳过及待办均为 0，约 32.784 秒。覆盖收工、验收完成约束、混合目录依赖、公平批次、发送前恢复、耗尽判断及错误发生时间；日志为 `/tmp/zcode-optimization/lifecycle-final-tests.log`。此前 76 项聚焦与 15 项最终合同检查均被此全套覆盖，不另加数量 |
| 按需启停与安全收工 | 上述全套覆盖其他指挥、待资源、待验收与待决定 Work 的保活、全库活动检查、实际及未知 Task 占用拒绝、终态无占用收工、手工收工保留待办、已接纳交办与重新开启操作的收工竞态，以及停止准备期间不误写永久受阻。MCP 仍恰好 5 个入口；省略 `only_if_idle` 时不向 RPC 注入该键，显式 `true` 才启用自动收工保护，拒绝信息禁止降级为 `false` |
| 调度读取与等待 | 既有 `node --import tsx --test test/daemon/work-efficiency.test.ts test/daemon/work.test.ts` 25/25，本轮也纳入上述全套。24 组历史 Work/Task/Result 加 1 个活动 Work，连续 2 次 pump 仅解析 2 次活动 Work，完整 Task、Result 和全量历史列表读取均为 0；SQLite 仍执行必要 JSON 引用扫描。未变 Work 等待只读轻量头；Task 等待在未变与无关更新时不读完整 Task 或全局游标，返回时各读 1 次并保持同一快照。覆盖本地通知、跨连接更新、接管、关闭、终态保留占用、迟到交付和活动验收目录保护，不代表长期负载基准 |
| 受管日志与只读存储统计 | 既有 `npx tsx --test test/maintenance/*.test.ts test/supervisor/supervisor.test.ts` 9/9，本轮也纳入上述全套。临时目录覆盖超大日志分片、三份有界备份、继承 append FD 的 inode 保留、危险目标拒绝、I/O 失败仅静态报告一次，以及 `storage-status` 分组逻辑字节、不跟随符号链接、无 daemon 和无池数据创建；daemon 定时复制/截断仍有软限额与并发诊断丢失边界，见[存储布局](../storage-layout.md#日志保留与只读统计) |
| 账号跨次导入与直接消费 | 既有 `npx tsx --test test/accounts/accounts.test.ts` 11/11；`npx tsx --test test/supervisor/supervisor.test.ts test/daemon/quota-resolver.test.ts` 14/14，根 `npm run typecheck` 通过；全部使用 fixture/mock，独立复核通过，未读真实凭据、启动服务或发送模型请求 |
| 官方运行时与双账号隔离闭环 | 既有同一总任务完整通过：两个实际回合并行 29,798 毫秒，每账号恰好一个任务；受控会话无子 Agent、后台、排队或待执行工作。程序生成固定外部验收副本，修改实施源后副本仍通过；实际整合项目的 2 项测试及 `git diff --check` 通过，最终验收、总任务完成与 MCP 收工成功，占用归零、2 个测试 Worker 正常停止 |
| 官方协议与清理 | 既有协议检查 10/10、类型检查通过；实际 stdio MCP 恰好提供 5 个入口，交办、等待、分页检查、推进、固定验收、整合、完成、收工均成功。只读核查只订阅原会话；观察修复后未再发送模型任务。临时凭据与测试进程已清理，12 份脱敏证据/日志扫描零泄露命中，当时既有服务保持 ready 且任务数为 0 |
| 原生单回合内部错误次数 | 唯一来源为 `readSessionDebug.networkEntries` 的实际失败条目，以稳定 `eventKey` 去重并按 `queryId` 绑定原命令；协议 10/10 与核心回归覆盖连续观察、冷接手未知、重复事件和原发生时间。实际云端成功回合没有触发内部繁忙，不能冒称真实繁忙次数验收 |
| 统一 VSIX 包内容 | 本轮冻结源码运行 `npm --prefix extensions/vscode run package:vsix`（自动构建与类型检查）和 `npm --prefix extensions/vscode run package:check` 各一次，均通过；`extensions/vscode/zcode-pool-0.1.0.vsix` 为 17 个文件、780330 字节（762.04 KiB），15 项白名单全部符合，daemon/CLI/MCP 校验和匹配，不含源码、source map、凭据或 fixtures |
| 本机管理进程资源基准 | 既有 Linux、20 逻辑核、30.70 GiB、Node 24.21.0 样本，使用当时生产 bundle；隔离临时池，0 账号、0 Worker、0 执行 Task。预热后各采样约 12 秒，场景与结果见下表；本机临时证据为 [JSON](/tmp/zcode-optimization/resource-benchmark-8crvBK/report.json) |
| 真实 VS Code 宿主 | 既有 VS Code 1.95.3 的可信和受限工作区 `test:smoke` 均通过；使用独立 profile 与内存 Mock，检查命令、连接、资源选择、固定 Diff 和受限写入拒绝 |
| 已安装 VSIX | 既有 `test:installed` 通过：临时 profile 安装生产包，显式启动两个独立空池，验证后台独立生命周期；移除临时扩展目录后稳定 CLI/MCP 仍可运行，停止后只读不重启、明确启动才恢复；不需要另装 npm runtime |

以下管理进程与官方多实例样本均来自局部架构优化及本轮启停调整前的 bundle，本轮没有重测，不能据此量化当前变更的性能改善。

| 资源基准场景 | 采样秒数 | RSS（MiB） | PSS（MiB） | CPU（100%=1 核） |
| --- | ---: | ---: | ---: | ---: |
| 空 daemon 待机 | 11.999 | 64.871–64.945 | 34.572–34.646 | 0.083% |
| daemon + MCP stdio 待机，仅完成 `tools/list` | 12.001 | 135.711 | 71.052 | 本窗口 0 tick |
| 1 个待资源 Work + 实际挂起的 `wait_work` | 12.004 | 140.938–142.836 | 75.765–77.663 | 0.666% |

资源合计仅含 daemon/MCP；SDK 驱动 RSS 约 77–80 MiB 另计。RSS 重复计算共享页，PSS 分摊共享页；CPU 为 10 毫秒粒度，0 tick 不代表长期零开销。`tools/list` 不建立 daemon RPC，第三场景的真实等待在 14.004 秒后正常超时。池文件逻辑大小在各采样窗口稳定，由空池约 0.33 MB 到提交后 0.38 MB，退出 checkpoint 后为 0.19 MB；自建进程已正常停止，既有池和进程未操作。此基准不查询额度或调用模型，不覆盖 VS Code、官方 Worker、构建、并发吞吐或长期增长。

同机（Linux、20 逻辑核、30.70 GiB）的官方多实例空闲样本使用独立私有临时池，同批账号逐步增至 1/2/4/6 个实例；0 档保留 daemon 和测量驱动。官方 Server 3.16.3 使用原装嵌入 Node 22.16.0，daemon/驱动使用 Node 24.21.0；每档预热 2.5 秒后约 12 秒采样 13 次。下表统计完整官方 Worker 进程树，daemon 与驱动另计；本机临时证据为[完整脱敏报告](/tmp/zcode-optimization/multi-instance-benchmark-20261103T085427Z/report.md)。

| 空闲官方实例数 | 完整官方树进程数 | Worker RSS 均值（MiB） | Worker PSS 均值（MiB） | Worker CPU（100%=1 核） |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | 0.0 | 0.0 | 0.00% |
| 1 | 2 | 329.9 | 238.8 | 1.08% |
| 2 | 4 | 630.6 | 440.0 | 2.50% |
| 4 | 8 | 1226.5 | 828.3 | 2.50% |
| 6 | 12 | 1805.7 | 1195.4 | 4.08% |

daemon PSS 按 0/1/2/4/6 档分别为 34.7/41.0/53.5/56.1/57.3 MiB，测量驱动 PSS 为 45.6–46.1 MiB。RSS 重复计算共享页，PSS 按比例分摊；CPU 为 10 毫秒粒度，短窗口包含官方正常后台行为。启动过程保留官方 provider、套餐余额、配置等后台初始化 HTTP，未额外执行余额或认证探测；未创建 session、发送模型回合或执行真实 Task，各档开始和结束均为 ready 且 `runningTaskCount=0`。自建 6 个 Worker 与 daemon 已正常停止，临时凭据副本、密钥和 HOME 已清理，既有实例未操作。结果只代表本机短窗口空闲样本，不表示模型负载峰值、长期增长或最大可运行实例数。

浏览器截图保存在扩展忽略目录 `.test-browser/`；资源与批量额度检查报告为 `resources-focused-report.json`，截图为 `resources-{summary,folded}-{1280,360}.png`。该检查不连接真实账号或发起模型请求。

真实闭环本机脱敏证据：[完整结果](/tmp/ze1103/live-evidence.json)、[并发与无派生核查](/tmp/zrt-1103/live-concurrency-evidence.json)、[清理核查](/tmp/zrt-1103/cleanup-evidence.json)。这些是临时核验证据，不是运行依赖；真实闭环和本地边界检查分别证明各自范围。

本轮代码检查使用临时目录与 Mock，经核心全套及独立复核；检查与打包未启动官方 Worker、查询真实额度或发送模型请求。用户固定池本次已安全收工，之后未重启。既有资源与批量额度、真实账号闭环、宿主、安装和资源样本仍只证明各自范围；官方多实例空闲样本的启动与联网范围见上文。指挥的语义判断责任和下列客观边界仍然保留。最终包构建与检查日志分别位于本机 `/tmp/zcode-optimization/lifecycle-package-final.log`、`/tmp/zcode-optimization/lifecycle-package-check-final.log`。

## 有效边界

- 当前执行侧为 Linux / Node.js 24+，官方 Server 3.16.3 / protocol 1。Windows/macOS 本地 daemon、纯浏览器 VS Code 不受支持；WSL 实机与完整人工屏幕阅读器流程尚未验收。
- 本轮没有在云端真实触发繁忙、限流、额度耗尽、2 分钟让号或 15 分钟静默；这些规则由本地可控故障/时钟测试和官方只读方法检查覆盖。
- 官方原生历史是尾部窗口；缺少原命令、身份或停止依据时保留未知占用。已有不受控旧会话不能热加禁止派生策略，允许只读，拒绝发送新任务。
- Start Plan 与 Coding Plan 额度不能互相替代；未知或失败不当作零或满额。一次性额度到期不代表自动恢复。
- 账号导出时间只表示快照新旧线索，不保证凭据签发新旧；等时或缺少更新时间的新凭据保留已有值，详见[存储规则](../storage-layout.md)。
- 原生审批没有已验证的原子 CAS；本地指纹/串行校验仍需接受上游竞态边界。未知交互只读。
- 官方 API 重试状态不等于失败计数。实际失败来自原生网络调试源的最近 100 条窗口；前后窗口不重叠、来源不可读或归属未核实时，完整性保持未知。长期离线不能补造遗漏次数；计数源故障本身不推翻已独立证实的执行终态。
- 不可变文件工件保存时持有占用，但不是原子文件系统快照；缺失的旧快照不补猜。当前磁盘版本不能替代固定待验收版本。
- 核验中断不自动重跑可能有副作用的命令；账号续期、完整池迁移和无限规模对象读取没有完整交付承诺。
- MCP 等待依赖宿主能力，没有无限等待或可靠主动推送的保证；VS Code 需要用户决定时提供通知和持久待办。
- 日常完成后的自动收工由指挥发起，没有新增空闲超时退出机制；关闭 VS Code 或指挥异常离线不会自动判定完工。明确停工可保留无执行占用的待办数据，实际或未知占用仍不能强停。
