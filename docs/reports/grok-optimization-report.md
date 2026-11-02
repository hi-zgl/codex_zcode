# codex_zcode（zcode-pool）优化报告

- 仓库：https://github.com/hi-zgl/codex_zcode（本地克隆 `/workspace/codex_zcode`，分支 `grokbot/optimize`，基于 `main`）
- 补丁：`/workspace/codex_zcode-optimize.patch`（`git format-patch main --stdout`，21 个提交，65 个文件，+1200/−880（第一轮 13 个提交 21 个文件 +196/−113；第二轮 UI 8 个提交 46 个文件 +1004/−767）；已在干净克隆的 `main` 上 `git am` 验证，结果树与分支完全一致）
- 约束：未推送、未做 GitHub 认证、未开 PR；未改 node_modules；未新增依赖；未改变公开行为/CLI（仅修复真实 bug）。

## 1. 项目概览

zcode-pool 是一个 Node ≥24 / ESM / TypeScript 的 ZCode 多账号“工人池”：
- 守护进程通过 Unix socket JSON-RPC 对外服务。
- `Coordinator` 调度任务。
- `DurableTaskStore` 基于 node:sqlite 的 WAL 持久化。
- `WorkerSupervisor` 管理 ZCode server 进程，`ZCodeServerAdapter` 通过 WebSocket 二进制 RPC（`ChannelRpc`）与其通信。
- 同时提供 MCP server、CLI 和 systemd 服务。

`extensions/vscode` 是独立打包的 VS Code 扩展：
- 宿主侧：socket 客户端、轮询、动作路由、mock transport。
- Webview 侧：原生 DOM，`el()` 加整体 `replaceChildren` 重渲染；ITCSS 风格 CSS，约 4,081 行。
- 用 esbuild 构建，测试包括 unit / integration / browser（playwright-core）。

## 2. 主要问题（按严重度排序）

1. **【安全】配额原始数据未脱敏就发往 UI。** `resolveQuotaSnapshot()` 把整个 raw quota 原样放进 `rawSnapshot`，经 `ui_probe_quota`/overview 发送到 webview。`main` 上现有集成测试（WIRE_SECRET_CANARY）因此失败。已修复。
2. **【正确性】`daemon_start` 发到已运行的守护进程时返回 `undefined`。** JSON-RPC 响应缺 `result` 字段；方法 switch 也没有穷尽检查（`shutdown_pool` 同样会漏处理）。已修复。
3. **【正确性】`npm test` 的 glob 没有生效。** `test/**/*.test.ts` 交给 sh 展开，只匹配一层目录，导致部分测试可能被漏跑。已修复。
4. **【正确性】账号排序误判。** 没有数值的 quota 窗口被当作“已耗尽”，排到未探测账号之前。已修复。
5. **【正确性 / 可访问性】重置倒计时边界错误。** 会出现“0小时59分”“0天”。另外 progressbar 的 `aria-valuenow`（已用）和可见文案（剩余）含义相反。已修复。
6. **【可移植性】扩展导入对话框写死了作者的家目录 `/home/zgl/...`。** 已修复。
7. **【资源】`ChannelRpc.listen()` 在 send 抛错时泄漏监听器。** 已修复。
8. **【性能】SQLite 的 60 处 `prepare` 每次调用都重新编译 SQL；webview 在隐藏时仍每秒刷新并每 60 秒自动探测配额；zod schema 每次请求都重建。** 已修复。
9. **【可维护性】代码密度极高（类似压缩代码），`store.ts` 超过 1,000 行；重复逻辑（quota 探测、provider id 拼接、finally 块）；大量未使用的 import 和死代码。** 已部分清理。
10. **【工程】** 没有 linter；扩展的 `@types/node` 是 20，根项目是 24；单元测试依赖作者本机的私有文件。最后一项已改为缺文件时跳过。

## 3. 提交明细（由旧到新）

| # | 提交 | 领域 | 内容 |
|---|---|---|---|
| 1 | a627f67 perf(store) | 后端 | `DurableTaskStore` 增加 `sql()`，按连接缓存 `StatementSync`（SQL 均为静态文本），`close()` 时清空缓存 |
| 2 | 50dc411 refactor(daemon) | 后端 | 新增 `startPlanProviderId()`，统一 3 处拼接；`probeReadyWorker()` 和 `markObservationLost()` 消除重复分支；删除未使用的 import |
| 3 | b44aa90 fix(daemon) | 后端 | `daemon_start` 返回 `{ready:true}`，`shutdown_pool` 显式处理，`default` 用 `never` 做穷尽检查；新增测试 |
| 4 | 5c520af fix(runtime) | 后端 | 订阅帧发送失败时移除监听器；删除死代码 |
| 5 | b8b0951 build | 工程 | 测试 glob 加引号，交给 Node 测试运行器递归展开 |
| 6 | 6deccb3 fix(shared) | 后端 / 可视化 | 无数值的 quota 不再被算作耗尽（rank 2 → 3）；新增测试 |
| 7 | 5c9ec4a fix(vscode) | 扩展宿主 | 导入对话框默认路径改为 `~/.local/share/zcode-pool/imports` |
| 8 | 2f4b42e test(vscode) | 扩展测试 | 私有导出文件不存在时跳过对应测试，可用 `ZCODE_POOL_REAL_ACCOUNTS_FILE` 指定文件 |
| 9 | 45e1f63 perf(vscode) | 扩展宿主 | JSON-RPC 响应 schema 提升为模块常量 |
| 10 | e54e0db fix(webview/quota) | 可视化 / 可访问性 | 倒计时由向上取整后的分钟数推出小时和天数；进度条增加 `aria-valuetext`；新增测试 |
| 11 | 2d76541 style(webview) | UI / CSS | `prefers-reduced-motion` 下关闭骨架屏闪烁动画 |
| 12 | 71a9e8f perf(webview/resources) | 交互 | 页面隐藏时跳过倒计时 tick 和 60 秒自动探测 |
| 13 | f43b308 fix(security) | 后端 / 安全 | `rawSnapshot` 经过 `redact()`，去除 token/secret/authorization 等字段和 JWT；新增测试，修复 2 个原本失败的集成测试 |

## 4. 基线 vs 修改后

| 检查 | 基线（main） | 修改后 |
|---|---|---|
| 根项目 typecheck | 通过 | 通过 |
| 根项目测试 | 199/199 | **202/202**（新增 3 个） |
| test:daemon-package | 通过 | 通过 |
| 扩展 typecheck / build | 通过 | 通过 |
| 扩展 test:unit | 136/138（2 个依赖本机私有文件而失败） | 136 通过，2 跳过，0 失败 |
| 扩展 test:integration | 5/7（WIRE_SECRET_CANARY 泄漏） | **7/7** |
| 扩展 test:browser（多宽度几何和截图） | 10 PASS | 10 PASS |
| 扩展 package:check | 失败（需要先打出 VSIX，属环境问题） | 第二轮先 `package:vsix` 再检查：通过 |
| Lint | 仓库未配置 | — |

日志位置：
- 基线：`/workspace/baseline/*.log`
- 修改后：`/workspace/after/*.log`

## 5. 分领域

### 5.1 后端（src/：daemon、store、runtime、MCP、CLI）
- **发现**
  - 原始配额数据泄漏到 UI。
  - `daemon_start` 和 `shutdown_pool` 未处理。
  - SQL 重复 prepare。
  - 监听器泄漏。
  - quota 探测和 finally 块重复。
  - 大量未使用的 import。
  - `listTasks()` 每次全表加载，overview 再 `slice(-50)`。
  - 帧解码里反复 `Buffer.concat`。
- **修改**：提交 1–4、6、13。
- **建议**
  - `listTasks` 增加带 `LIMIT` 和过滤的查询，并为 `tasks(worker_id, lease_held)` 建索引（需要迁移）。
  - 帧解码改用分段缓冲加偏移量。
  - 把 `store.ts` 按聚合拆分。
  - `redact` 改为在 daemon → UI 边界统一执行一次（白名单字段比黑名单更安全）。

### 5.2 扩展宿主（extensions/vscode/src/host、extension.ts）
- **发现**：写死的作者路径；每次请求都重建 zod schema；`@types/node` 20 与运行时不一致。
- **修改**：提交 7、9。
- **建议**：统一 `@types/node` 为 24；socket 客户端加入请求超时和取消的统一封装。

### 5.3 前端 / Webview（media、src/webview）
- **发现**
  - 每次状态变化都整体 `replaceChildren`，一次动作会触发多次 render，导致焦点和滚动位置可能丢失，也有性能开销。
  - 没有独立的 Web 前端；`docs/ui/prototype.*` 只是文档。
- **修改**：通过提交 10–12 做了局部修正。
- **建议**：用 `requestAnimationFrame` 合并渲染，再按区块做 keyed diff 或局部更新。

### 5.4 UI / CSS
- **发现**：ITCSS 结构清晰，但约 4,081 行；`index` 注释声称达到 WCAG AAA，未经验证；减少动态效果偏好下仍有骨架屏动画。
- **修改**：提交 11。
- **建议**：用 axe 或对比度工具实际校验；清理未使用的选择器。

### 5.5 布局
- **发现**：`responsive.css` 配合浏览器几何测试，在所有测试宽度下都通过，未发现溢出或重叠。桌面宽度下是居中的窄栏。
- **修改**：无，没有发现低风险且有收益的改动。
- **建议**：宽屏下可考虑双栏（账号 + 任务），属于设计决策。

### 5.6 可视化（配额条、配额面板、账号排序）
- **发现**：倒计时边界错误；aria 语义和文案相反；无数据被误判为耗尽。
- **修改**：提交 6、10。
- **建议**：配额条加入阈值色和图例；为“未知”“过期”状态提供显式视觉区分。

### 5.7 交互（刷新、计时器、表单、焦点）
- **发现**：隐藏状态下仍持续 tick 并自动探测，浪费资源，也会消耗探测额度；整体重渲染影响焦点保持。
- **修改**：提交 12。
- **建议**：将自动探测频率做成可配置项；在 render 前后保存和恢复焦点与滚动位置。

## 6. 未实施的较大建议
1. 引入 ESLint/Biome（无格式化改动的最小规则集），并在 CI 中执行 typecheck、test 和 lint。
2. 对高密度代码逐文件格式化（会产生大 diff，应单独 PR）。
3. Store 的查询分页和索引迁移。
4. Webview 渲染改为批量加局部更新。
5. daemon → UI 合约改为白名单序列化（替代 `rawSnapshot` 透传）。
6. 统一扩展和根项目的 Node 类型版本，测试中的未使用 import 留待 linter 清理。
7. 让 `package:check` 在 CI 中先构建 VSIX 再检查。


## 7. UI / 交互 / 图标（第二轮）

范围：VS Code 扩展的 Webview UI、交互与图标。公开命令、设置、Host 行为均未改变；所有检查通过。

### 7.1 提交明细（第二轮，由旧到新）

| # | 提交 | 内容 |
|---|---|---|
| 14 | 6cf8511 feat(webview/icons) | Webview 图标集改为 VS Code **Codicons**（CC BY 4.0，由 `@vscode/codicons` 0.0.46 的 SVG 生成）。内部名称不变，`CODICON_SOURCE` 记录来源；新增 24 个图标；`icon()` 改为 `fill=currentColor`、`focusable=false`，带 `label` 时为 `role=img`。导航、连接、收工、任务操作、执行器、资源、设置、提示框等按钮都配了语义图标。状态图标：等待审批用 shield，阻塞/取消用 circle-slash，中断用 debug-disconnect，排队用 watch |
| 15 | 5c31545 feat(vscode/icons) | 活动栏图标重绘为 24px 网格、1.5px 描边的 Z 字标，小尺寸也清晰；新增 128×128 `media/icon.png`（市场图标，源文件 `icon-source.svg`）；13 个命令配 codicon；任务树状态用 ThemeIcon 加主题色（running 用 `loading~spin`，成功和失败用 testing 颜色）；README 注明图标许可 |
| 16 | fc7ec0d refactor(webview/css) | **设计 token**：所有色调、边框、阴影都从 `--vscode-*` 经 `color-mix()` 推导，声明在 `:root, body` 上，以便主题回退值重新计算。`themes.css` 从 250 行减到 166 行，浅色只保留基础回退色。修复 HC-light 悬停色不可见。清除徽章、配额条、配额告警、配额面板、排序按钮、交付、提示等处的硬编码 rgba/hex。select 箭头改由主题色绘制，不再需要按主题覆盖 data-URI。输入框焦点改为 VS Code 原生的 1px 环。字号统一到 `--font-xs…--font-display` 刻度（原来有 26 种零散字号，最小 11px）。修复未定义的 `--font-sans`；更正 index.css 中夸大的 WCAG AAA 和行数说明 |
| 17 | 38c1afb style(webview/buttons) | 按钮改为扁平的原生风格，使用 `--button-*` 即 VS Code 按钮色，去掉渐变、光晕和悬停上浮。rest/hover/active/disabled/busy 各状态有明确层级；busy 显示 spinner、`cursor: progress`、`aria-busy`；另加两步确认的样式 |
| 18 | 34c9110 feat(webview/interaction) | **破坏性操作确认**：收工、取消任务、停止执行器点第一次只展开行内确认（提示文字、危险确认按钮、取消按钮）。焦点自动落到确认按钮；Esc、取消或任何其他操作都会撤销确认；确认前不发请求。**操作反馈**：保存、复制诊断、导入等成功消息以前只写进屏幕外区域，现在显示可关闭的成功提示条。**读屏**：持久的 polite/assertive live region 移到重渲染的根节点之外（旧的每次渲染都重建，播报不可靠）；回执阶段变化只播报一次；失败回执用 `role=alert` |
| 19 | 5b76ced fix(webview/a11y) | **对比度**：新增 `--warning/success/danger/info-text`，浅色主题下把状态色向正文色加深（VS Code 浅色的 warning/passed 色在白底上约 3:1）。主按钮回退色由 3.9:1 提到 5.0:1。危险按钮填充态改用编辑器背景色作文字色（原来约 2.4:1）。新增 `scripts/contrast-audit.js`，`test:browser` 断言任务页（暗色/浅色/高对比）以及交付、资源、设置、审批、派发各视图没有低于 WCAG AA 的可见文字 |
| 20 | a622377 style(webview) | 视觉更克制：卡片、任务行、指标、审批卡、资源卡、文件卡悬停不再上浮 1px，避免密集列表抖动；状态徽章和选中行指示去掉彩色光晕；去掉 backdrop-filter（Webview 不透明，模糊只消耗 GPU）；删除重复的 `<summary>` marker 规则 |
| 21 | 6ac8618 feat(webview/keyboard) | 任务列表支持方向键漫游焦点：↑/↓/Home/End 只移动焦点不选中，Enter/Space 打开；读屏有按键说明 |

### 7.2 检查结果（第二轮后全部重跑，日志在 `/workspace/after2/`）

| 检查 | 结果 |
|---|---|
| 根项目 typecheck | 通过 |
| 根项目测试 | 202/202 |
| test:daemon-package | 通过 |
| 扩展 typecheck / build | 通过 |
| 扩展 test:unit | 138 通过，2 跳过，0 失败（新增 3 个：确认/Esc/取消流程、提示条 + live region + 失败回执 role、方向键焦点） |
| 扩展 test:integration | 7/7 |
| 扩展 test:browser | 10 PASS，覆盖 9 种宽度（280–2560px）× 3 种主题，验证几何、无横向溢出、字号 ≥ 11px；新增 WCAG AA 对比度断言，以及取消任务需二次确认且焦点落到确认按钮的断言 |
| package:vsix + package:check | 通过（15 个白名单文件，含 `media/icon.png`） |

截图：`/workspace/ui-shots/`
- `before-*.png`：第一轮结束时的状态（f43b308）
- `after-*.png`：第二轮结束时的状态
- 每个视图有默认宽度和 320px 两张：tasks 分暗色、浅色、高对比三种主题，另有 delivery、resources、settings、approval、compose
- `after-confirm.png`：新增的行内确认

### 7.3 未实施的设计建议
1. 渲染改为 keyed diff 或 rAF 批处理，替代整树 `replaceChildren`，减少焦点和滚动恢复的开销以及读屏干扰。
2. 宽屏（≥1600px）下任务详情改为两栏（概览 | 交付/事件），减少纵向滚动。
3. 在 CI 里加 axe-core 审计（需新增开发依赖，本轮未加），覆盖 ARIA 结构和名称。
4. 间距也做成 token 刻度（`--space-1…8`），目前只统一了颜色和字号；各视图里还有不少 9/11/13px 等零散 padding。
5. 配额面板的半透明表面（`--glass-bg`）可以完全改为不透明的 `--surface-card`，统一卡片层级。
6. 破坏性确认目前是行内两步确认；如需更强提示，可由 Host 改用 `vscode.window.showWarningMessage({modal:true})`，但会改变 Host 行为，所以本轮没做。
7. 欢迎页和空状态可以加插画级的 codicon 组合，并给"下一步"按钮排出更清晰的主次。
