import { isAbsolute } from 'node:path';
import { HostError } from './client.js';

export function codexMcpConfig(input:{nodePath:string;cliPath:string;profilePath:string}):string{
  for(const value of Object.values(input))if(!isAbsolute(value)||value.includes('\0'))throw new HostError('INVALID_ARGUMENT','MCP paths must be absolute on the execution host.');
  const quote=JSON.stringify;
  return `[mcp_servers.zcode_pool]\ncommand = ${quote(input.nodePath)}\nargs = [${quote(input.cliPath)}, "mcp"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 120\n\n[mcp_servers.zcode_pool.env]\nZCODE_POOL_CONNECTION_FILE = ${quote(input.profilePath)}\n`;
}
export function codexSetupDocument(input:{config:string;host:string;poolHome:string;version:string}):string{
  return `# 连接 Codex 与 ZCode\n\n运行环境：${input.host}\n\n连接目录：${input.poolHome}\n\n插件随附后台版本：${input.version}\n\n将下方配置添加到同一执行侧的 Codex config.toml（通常是 ~/.codex/config.toml）。如果已经存在 mcp_servers.zcode_pool，请替换该服务器配置，不要重复追加。也可在 Codex 的 MCP 设置中添加 STDIO 服务。此文档仅生成配置，没有修改你的 Codex 设置，也不能证明 Codex 已连接。\n\n\`\`\`toml\n${input.config}\`\`\`\n\n保存后重新启动或连接 Codex 的 MCP 服务。配置引用同一连接资料文件，之后在面板切换连接目录时，新的 MCP 工具调用也会读取该目录；已经在旧目录运行的任务继续保留，请勿把切目录当作任务迁移。\n\n后台在首次工具调用时按需启动，关闭 VS Code 后仍可使用；不会自动启动账号实例或模型任务。官方 ZCode runtime 和 Node.js 24+ 仍是执行侧依赖。\n\n可以对 Codex 说：\n\n> 连接 zcode_pool，查看账号、额度和并发上限。你只负责流程管理与任务安排，让 ZCode 完成指定项目的开发。只向我报告关键进度、需要决策的阻塞和验证结果。\n\n连接后先检查 zcode_overview 和 zcode_get_pool_policy；用 zcode_set_pool_policy 控制并发，0 暂停新派发，null 不设全池上限。\n\n配置格式依据：[OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。\n`;
}
