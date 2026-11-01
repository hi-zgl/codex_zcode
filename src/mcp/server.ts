import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { methods } from '../shared/methods.js';
import { rpcCall } from '../shared/rpc.js';
import { MCP_PRESENTED_METHODS, classifyMcpError, presentMcpError, presentMcpResult, type PresentedText } from '../shared/presentation.js';

type DaemonCall = (method: string, args: Record<string, unknown>) => Promise<unknown>;
function response(presented: PresentedText) {
  return { ...(presented.isError ? { isError: true } : {}), content: [{ type: 'text' as const, text: presented.text }] };
}
export function createMcpServer(call: DaemonCall = rpcCall): McpServer {
  const server = new McpServer({ name: 'zcode-pool', version: '0.1.0' },{instructions:'Use ZCode workers for implementation; act as coordinator when the user requests delegation. Explicitly use daemon_start when starting work; status reads never start the daemon. Use shutdown_pool only when the user asks to finish work; it refuses active or uncertain tasks and never cancels them. Do not automatically restart a pool after shutdown. Inspect overview and pool policy, select explicit accounts/workers/workspaces, dispatch scoped tasks with verification commands, and observe the original task IDs. Start/stop workers and adjust concurrency only within the user\'s instructions. Keep worker conversations local: read compact status/results, fetch logs or diffs only when needed. Busy continuation is bounded by the daemon; do not duplicate tasks or resend uncertain commands. The VS Code panel is optional monitoring and human intervention, not a required dispatch step. Approval decisions and execution mode must respect the user\'s authorization; do not silently select unrestricted mode.'});
  const registered = new Map<string, (typeof methods)[keyof typeof methods]>();
  for (const [name, definition] of Object.entries(methods)) {
    // Adding a daemon method never implicitly exposes its native return object.
    if (!MCP_PRESENTED_METHODS.has(name)) continue;
    registered.set(`zcode_${name}`, definition);
    server.registerTool(`zcode_${name}`, {
      description: definition.description,
      inputSchema: definition.schema.shape,
    }, async () => response(presentMcpError('REQUEST_FAILED', name)));
  }
  // MCP SDK validation normally builds errors outside the registered callback.
  // Own tools/call so unknown names and hostile schema errors get the same bound
  // and privacy policy as successful daemon replies. tools/list keeps real schemas.
  server.server.setRequestHandler(CallToolRequestSchema, async request => {
    const definition = registered.get(request.params.name);
    const method = definition ? request.params.name.slice('zcode_'.length) : '';
    if (!definition) return response(presentMcpError('UNSUPPORTED_METHOD', method));
    const parsed = definition.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) return response(presentMcpError('INVALID_ARGUMENT', method));
    const args = parsed.data as Record<string, unknown>;
    try {
      return response(presentMcpResult(method, await call(method, args), args));
    } catch (error) {
      return response(presentMcpError(classifyMcpError(error), method, args));
    }
  });
  return server;
}
