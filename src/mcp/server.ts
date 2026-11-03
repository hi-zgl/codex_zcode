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
  const server = new McpServer({ name: 'zcode-pool', version: '0.1.0' },{instructions:'You arrange and accept work; ZCode implements without subagents. Explicitly call pool_control with action start when beginning work. Use submit_work for a goal, observable criteria and authorized batches; wait_work for key changes; advance_work to combine acceptance, stage decisions, integration and next work. Success never confirms acceptance. Review fixed delivery IDs and check the actual integrated revision before completion. Ask material user decisions, including partial resources. Use inspect for details and pool_control for explicit resource decisions. Normal retries continue automatically; never duplicate uncertain tasks. Prefer host notifications; otherwise repeat bounded wait_work calls with the returned cursor. Once this round\'s Work has passed final acceptance and is completed, automatically attempt pool_control with action shutdown and only_if_idle true. Do this without asking for extra confirmation. Keep the pool running while execution, recovery, acceptance, pending decisions or another commander\'s Work remains. A busy refusal means retain the pool; never fall back to only_if_idle false for automatic shutdown. If the user explicitly stops work, save its current state and attempt shutdown with only_if_idle false; pending Work without task leases is preserved for the next explicit start. Never release active or uncertain tasks merely to shut down. Closing VS Code or losing the commander connection does not mean work is complete. The VS Code panel is optional.'});
  const registered = new Map<string, (typeof methods)[keyof typeof methods]>();
  for (const [name, definition] of Object.entries(methods)) {
    // Adding a daemon method never implicitly exposes its native return object.
    if (!new Set(['submit_work','wait_work','advance_work','inspect','pool_control']).has(name)) continue;
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
