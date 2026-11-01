import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';
import { createManagedDaemonCall } from './managed-connection.js';

const server = createMcpServer(createManagedDaemonCall());
await server.connect(new StdioServerTransport());
