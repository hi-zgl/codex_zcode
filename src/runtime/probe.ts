import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WorkerEndpoint } from './types.js';
import { ZCodeServerAdapter } from './zcode-server/index.js';

/** Explicit server roots only: discovery never silently targets the user's default instance. */
export async function discoverEndpoint(serverRoot: string): Promise<WorkerEndpoint> {
  const root = resolve(serverRoot);
  const status = JSON.parse(await readFile(join(root, 'run', 'status.json'), 'utf8'));
  if (!['ready', 'running'].includes(status.state) || typeof status.host !== 'string' || !Number.isInteger(status.port) || status.port < 1 || status.port > 65535) throw new Error('Explicit worker status is not ready with a valid address');
  const host = status.host === '::1' ? '[::1]' : status.host;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) throw new Error('Worker status has a non-loopback address');
  return { baseUrl: `http://${host}:${status.port}`, serverRoot: root, tokenFile: join(root, 'run', 'ingress-token') };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const at = args.indexOf('--server-root');
  const serverRoot = at < 0 ? undefined : args[at + 1];
  if (!serverRoot) throw new Error('Usage: tsx src/runtime/probe.ts --server-root <isolated-worker-server-root> [--handshake]');
  const endpoint = await discoverEndpoint(serverRoot);
  const adapter = new ZCodeServerAdapter();
  const info = await adapter.probe(endpoint);
  if (args.includes('--handshake')) {
    const connection = await adapter.connect(endpoint);
    Object.assign(info, connection.info);
    await connection.close();
  }
  process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
