import { createServer, type Server } from 'node:net';
import { mkdir, open, readFile, unlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { consumeLines, isRequest, socketPath, MAX_FRAME_BYTES } from '../shared/rpc.js';

export type RpcHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
// Linux process start time disambiguates recycled PIDs without inspecting arguments or secrets.
async function processStart(pid: number): Promise<string | null> {
  try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; }
  catch { return null; }
}
export async function serveRpc(root: string, handler: RpcHandler): Promise<{server: Server; close(): Promise<void>}> {
  const dir = join(root, 'scheduler');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const lockPath = join(dir, 'daemon.lock');
  let lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { lock = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Do not delete malformed/in-progress lock records or a living owner's lock.
      let owner: {pid: number; start: string};
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')); }
      catch { throw new Error('Daemon lock is unreadable or being initialized; retry later'); }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !owner.start) throw new Error('Invalid daemon lock; manual inspection required');
      if (await processStart(owner.pid) === owner.start) throw new Error('Daemon already running');
      // Conservative stale-lock policy: avoids a stale-cleanup race between simultaneous starters.
      throw new Error('Stale daemon lock detected. Verify no daemon owns this pool, then remove scheduler/daemon.lock and daemon.sock');
    }
  }
  if (!lock) throw new Error('Could not acquire daemon lock');
  await lock.writeFile(JSON.stringify({pid: process.pid, start: await processStart(process.pid)}));
  await lock.close();
  const path = socketPath(root);
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    consumeLines(socket, line => {
      void (async () => {
        let id: string | number | null = null;
        try {
          const request: unknown = JSON.parse(line);
          if (!isRequest(request)) throw new Error('Invalid JSON-RPC request');
          id = request.id;
          const result = await handler(request.method, request.params ?? {});
          const response = JSON.stringify({jsonrpc:'2.0', id, result}) + '\n';
          if (Buffer.byteLength(response) > MAX_FRAME_BYTES) throw new Error('Result too large; request a smaller page');
          if (!socket.destroyed) socket.write(response);
        } catch (error) {
          if (!socket.destroyed) socket.write(JSON.stringify({jsonrpc:'2.0', id, error:{code:-32000,message:error instanceof Error ? error.message : 'Request failed'}}) + '\n');
        }
      })();
    });
  });
  try {
    // A pre-existing socket with no lock is ambiguous: never unlink it automatically.
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolve(); }); });
    await chmod(path, 0o600);
  } catch (error) { await unlink(lockPath).catch(() => {}); throw error; }
  let closed = false;
  return {server, async close() {
    if (closed) return; closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(lockPath).catch(() => {});
  }};
}
