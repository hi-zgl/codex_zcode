import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { methods } from '../shared/methods.js';
import { rpcCall } from '../shared/rpc.js';

const server = new McpServer({name:'zcode-pool',version:'0.1.0'});
for (const [name,definition] of Object.entries(methods)) {
  if (name === 'import_accounts' || name === 'daemon_stop') continue; // Credentials are imported explicitly by local CLI.
  server.registerTool(`zcode_${name}`, {
    description:definition.description,
    inputSchema:definition.schema.shape,
  }, async (args: Record<string, unknown>) => {
    try {
      const result = await rpcCall(name,args);
      return {content:[{type:'text' as const,text:JSON.stringify(result)}]};
    } catch (error) {
      return {isError:true,content:[{type:'text' as const,text:error instanceof Error ? error.message : 'Daemon request failed'}]};
    }
  });
}
await server.connect(new StdioServerTransport());
