# 可视化交互设计

可视化扩展位于 `extensions/vscode`。优先阅读[运行与测试指南](implementation.md)：包含 F5 Mock/真实连接、独立 VSIX 安装、后台安装包及验证命令。实际验证范围见[验收记录](../validation/2026-11-01-vscode.md)。

本目录同时保留实现前的设计规格及早期静态原型。原型使用演示数据，不包含后来新增的全部交互；调试扩展请使用 F5，而不是把 `prototype.html` 当作运行客户端。

## 已确定的方案

采用 VS Code 扩展连接独立 daemon：原生侧栏提供任务与资源树，编辑区 Webview 提供工作台和详情，状态栏点击打开工作台并聚焦待处理项。风格借鉴 zcode-switch，布局按任务调度重新设计。

扩展负责展示与用户动作，daemon 继续拥有任务、账号、Worker 和恢复逻辑。UI 阅读内容不会自动传给 Codex；MCP 继续使用独立的精简输出边界。模型繁忙时保持同一任务的有限即时“继续”，不引入等待队列或自动换账号。

## 阅读顺序

| 文档 | 内容 |
| --- | --- |
| [交互方案](interaction-design.md) | 产品范围、信息架构、视觉语言与关键决策 |
| [页面、流程与状态](flows-and-states.md) | 页面线框、用户动作、正常与异常状态、验收编号 |
| [现有接口与集成差距](integration-contract.md) | 代码事实、现有能力和必须补齐的后台功能 |
| [UI API 契约](api-contract.md) | 拟议接口、分页、错误、完整审批与不可变差异工件 |
| [扩展架构](extension-architecture.md) | 目录、命令、Host/Webview 边界、连接与生命周期 |
| [开发、F5 与验收](development-and-acceptance.md) | Mock/真实连接两套调试模板、实施依赖和测试矩阵 |
| [可点击交互原型](prototype.html) | 代表性任务、审批、账号、差异及窄侧栏演示 |

原型使用本地 HTML/CSS/JavaScript，无需 npm 安装、账号导入或启动 ZCode。浏览器预览不等同于在 VS Code Webview 中验收。可在项目根运行以下命令，然后访问 `http://127.0.0.1:8765/prototype.html`：

```bash
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs/ui
```

## 实施边界

- **M0**：完整设计与契约。
- **M1**：扩展骨架、F5 Mock 演示、旧 daemon 的近期任务只读连接。
- **M2**：可操作首版，包含任务闭环、完整审批、不可变文件差异和独立 VSIX 验收；需要先补齐后台能力。
- **M3**：全历史稳定分页、资源规模化及进一步维护功能。

以上为原实施划分，完成条件见[设计验收方案](development-and-acceptance.md)，实际交付证据见[验收记录](../validation/2026-11-01-vscode.md)。不得以旧服务的截断输出替代完整审批或以实时工作目录伪造历史差异。

## 风格参考

参考 [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch)，克隆版本 `f34225686dfef05d84c256a56f868719248f15ff`，本地位于 `references/zcode-switch/`。参考源码采用 MIT 许可，完整许可保留在独立克隆中；本原型自行编写，仅借鉴深石墨底色、琥珀强调、紧凑信息层级等视觉特征，没有复制其源码、截图或标志。

整个 `references/` 继续从主项目 Git 中排除。新克隆本项目后，如需查看参考源码，可独立执行：

```bash
git clone https://github.com/pjpv/zcode-switch.git references/zcode-switch
```

## 早期静态原型检查范围

已检查 JavaScript 语法及本地 DOM 模拟交互：任务筛选、续跑上限、批准/拒绝、未知占用、只读对账与显式附着分离、账号信息、审阅标记、侧栏切换和重置。早期原型交付时没有可用浏览器，未进行浏览器像素级验收或 VS Code 扩展宿主实测；深浅色、高对比度、真实 Webview 和远程连接验证属于实施阶段。临时检查依赖仅保存在 Git 忽略的 runtime/，未加入项目依赖。
