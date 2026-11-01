# 可视化交互设计

本目录是设计交付，尚未实现或安装 VS Code 扩展，也未连接真实 daemon。

- [交互原型](prototype.html)：用浏览器打开，可切换工作台与窄侧栏、查看任务、审批、账号与示例差异；所有数据和操作均为本地演示。
- [形态选择与交互方案](interaction-design.md)：推荐 VS Code 扩展与现有 daemon 分离，列出交互流程和实施阶段。
- [技术集成与接口契约](integration-contract.md)：远程环境、消息边界、现有接口映射与需要补齐的能力。

原型使用本地 HTML/CSS/JavaScript，无需 npm 安装、账号导入或启动 ZCode。它不修改任务、账号、工作区、Codex 配置或系统服务。浏览器预览不等同于已经在 VS Code Webview 中验收。

## 风格参考

参考 [pjpv/zcode-switch](https://github.com/pjpv/zcode-switch)，克隆版本 `f34225686dfef05d84c256a56f868719248f15ff`，本地位于 `references/zcode-switch/`。参考源码采用 MIT 许可，完整许可保留在独立克隆中；本原型自行编写，仅借鉴深石墨底色、琥珀强调、紧凑信息层级等视觉特征，没有复制其源码、截图或标志。

整个 `references/` 继续从主项目 Git 中排除。新克隆本项目后，如需查看参考源码，可独立执行：

```bash
git clone https://github.com/pjpv/zcode-switch.git references/zcode-switch
```

## 检查范围

已检查 JavaScript 语法及本地 DOM 模拟交互：任务筛选、续跑上限、批准/拒绝、未知占用、只读对账与显式附着分离、账号信息、审阅标记、侧栏切换和重置。当前环境没有可用浏览器，未进行浏览器像素级验收或 VS Code 扩展宿主实测；深浅色、高对比度、真实 Webview 和远程连接验证属于实施阶段。临时检查依赖仅保存在 Git 忽略的 runtime/，未加入项目依赖。
