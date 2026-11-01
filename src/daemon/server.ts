import { createConnection, createServer, type Server } from 'node:net';
import { constants, type BigIntStats } from 'node:fs';
import { mkdir, open, readFile, unlink, chmod, lstat, realpath, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { consumeLines, isRequest, MAX_FRAME_BYTES } from '../shared/rpc.js';
import { UI_LIMITS } from '../shared/ui-contract.js';
import { UiRpcError } from './ui-support.js';

export type RpcHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;
interface FileIdentity { dev: string; ino: string; ctimeNs: string }
interface LockRecord {
  pid: number;
  start: string;
  version?: 1;
  token?: string;
  socket?: FileIdentity;
}
interface LockSnapshot { identity: FileIdentity; raw: string; owner: LockRecord }

function identity(stat: BigIntStats): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs) };
}
function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.ctimeNs === b.ctimeNs;
}
function isIdentity(value: unknown): value is FileIdentity {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return ['dev', 'ino', 'ctimeNs'].every(key => typeof v[key] === 'string' && /^\d+$/.test(v[key] as string));
}
async function statIfPresent(path: string): Promise<BigIntStats | undefined> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
}

// An absent /proc entry is only a candidate for death: kill(pid, 0) must also return ESRCH.
// Other errors (including permission errors) fail closed instead of treating an unknown PID as dead.
async function processStart(pid: number): Promise<string | null> {
  let stat: string;
  try { stat = await readFile(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw new Error('Cannot verify daemon process identity; manual inspection required', { cause: error });
  }
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!start || !/^\d+$/.test(start)) throw new Error('Cannot verify daemon process start time');
  return start;
}
async function assertOwnerDead(owner: LockRecord): Promise<void> {
  const start = await processStart(owner.pid);
  if (start !== null) {
    if (start === owner.start) throw new Error('Daemon already running');
    throw new Error('Daemon lock PID has been reused; manual inspection required');
  }
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw new Error('Cannot prove daemon owner has exited; manual inspection required', { cause: error });
  }
  throw new Error('Daemon owner changed while checking its identity; retry later');
}

async function readLock(path: string): Promise<LockSnapshot | undefined> {
  const before = await statIfPresent(path);
  if (!before) return;
  if (!before.isFile() || before.size > 16_384n) throw new Error('Invalid daemon lock; manual inspection required');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || !sameFile(identity(before), identity(stat))) throw new Error('Daemon lock changed; retry later');
    const raw = await file.readFile('utf8');
    let owner: LockRecord;
    try { owner = JSON.parse(raw) as LockRecord; }
    catch { throw new Error('Daemon lock is unreadable or being initialized; manual inspection required'); }
    if (!owner || typeof owner !== 'object' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 2_147_483_647
      || typeof owner.start !== 'string' || !/^\d+$/.test(owner.start)
      || (owner.version !== undefined && owner.version !== 1)
      || (owner.version === 1 && (typeof owner.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.token)
        || Object.keys(owner).some(key => !['version', 'pid', 'start', 'token', 'socket'].includes(key))))
      || (owner.socket !== undefined && (owner.version !== 1 || !isIdentity(owner.socket)))
      || (owner.version === undefined && Object.keys(owner).some(key => key !== 'pid' && key !== 'start'))) {
      throw new Error('Invalid daemon lock; manual inspection required');
    }
    return { identity: identity(stat), raw, owner };
  } finally { await file.close(); }
}
async function lockUnchanged(path: string, expected: LockSnapshot): Promise<boolean> {
  const current = await readLock(path);
  return !!current && sameFile(current.identity, expected.identity) && current.raw === expected.raw;
}
async function removeOwnedLock(path: string, expected: LockSnapshot): Promise<void> {
  // Every cooperating starter holds the same kernel mutex. Still check the token, contents,
  // and inode so shutdown cannot erase a replacement lock written by an outside process.
  if (await lockUnchanged(path, expected).catch(() => false)) await unlink(path);
}
async function assertSocketInactive(path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(new Error('Daemon socket activity is uncertain; manual inspection required')), 1_000);
    function finish(error?: Error) { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(); }
    socket.once('connect', () => finish(new Error('Daemon socket is active; refusing stale-lock recovery')));
    socket.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') finish();
      else finish(new Error('Cannot prove daemon socket is inactive; manual inspection required', { cause: error }));
    });
  });
}
async function recoverLock(lockPath: string, socketPath: string, stale: LockSnapshot): Promise<void> {
  await assertOwnerDead(stale.owner);
  const socket = await statIfPresent(socketPath);
  if (socket) {
    if (!socket.isSocket() || !stale.owner.socket || !sameFile(identity(socket), stale.owner.socket)) {
      throw new Error('Stale daemon lock cannot prove socket ownership; manual inspection required');
    }
    await assertSocketInactive(socketPath);
    await assertOwnerDead(stale.owner);
    const currentSocket = await statIfPresent(socketPath);
    if (!currentSocket || !sameFile(identity(currentSocket), identity(socket)) || !await lockUnchanged(lockPath, stale)) {
      throw new Error('Daemon lock or socket changed during recovery; retry later');
    }
    await unlink(socketPath);
  }
  await assertOwnerDead(stale.owner);
  if (!await lockUnchanged(lockPath, stale)) throw new Error('Daemon lock changed during recovery; retry later');
  await unlink(lockPath);
}
async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
}
async function closeServer(server: Server): Promise<void> {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
}
async function writeLockRecord(file: FileHandle, raw: string): Promise<void> {
  const bytes = Buffer.from(raw);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new Error('Unable to complete daemon lock record');
    offset += bytesWritten;
  }
  await file.truncate(bytes.length);
  await file.sync();
}

export async function serveRpc(root: string, handler: RpcHandler): Promise<{server: Server; close(): Promise<void>}> {
  if (process.platform !== 'linux') throw new Error('Daemon ownership verification requires Linux /proc and abstract Unix sockets');
  const dir = join(root, 'scheduler');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const canonicalDir = await realpath(dir);
  const lockPath = join(canonicalDir, 'daemon.lock');
  const path = join(canonicalDir, 'daemon.sock');
  if (Buffer.byteLength(path) > 107) throw new Error('Daemon socket path exceeds Linux Unix socket limit; use a shorter pool path');
  // Kernel-owned lifetime mutex: all starts and recovery attempts for the same real path
  // serialize, and SIGKILL releases it automatically. It has no stale file to recover.
  const mutex = createServer(socket => socket.destroy());
  const mutexPath = '\0zcode-pool-' + createHash('sha256').update(canonicalDir).digest('hex');
  try { await listen(mutex, mutexPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('Daemon already running or starting for this pool');
    throw error;
  }
  let ownedLock: LockSnapshot | undefined;
  let ownedSocket: FileIdentity | undefined;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    consumeLines(socket, line => {
      void (async () => {
        let id: string | number | null = null;
        let uiRequest = false;
        let protocolCode: number|undefined;
        try {
          let request:unknown;
          try{request=JSON.parse(line);}catch{protocolCode=-32700;throw new Error('Parse error');}
          if (!isRequest(request)) {protocolCode=-32600;throw new Error('Invalid JSON-RPC request');}
          id = request.id;
          uiRequest=request.method.startsWith('ui_');
          if(uiRequest&&Buffer.byteLength(line)+1>UI_LIMITS.requestBytes)throw new UiRpcError('INVALID_ARGUMENT');
          const result = await handler(request.method, request.params ?? {});
          const response = JSON.stringify({jsonrpc:'2.0', id, result}) + '\n';
          if(uiRequest&&Buffer.byteLength(response)>UI_LIMITS.responseBytes)throw new UiRpcError('OUTPUT_BUDGET_EXCEEDED',{outcome:['ui_respond_approval','ui_probe_quota'].includes(request.method)?'may_have_applied':'read_only'});
          if (Buffer.byteLength(response) > MAX_FRAME_BYTES) throw new Error('Result too large; request a smaller page');
          if (!socket.destroyed) socket.write(response);
        } catch (error) {
          const failure=error instanceof UiRpcError?{code:error.code,message:error.message,...(error.data?{data:error.data}:{})}:protocolCode?{code:protocolCode,message:error instanceof Error?error.message:'Invalid request'}:uiRequest?{code:-32010,message:'The daemon could not complete this UI request.',data:{kind:'INTERNAL_ERROR',retryable:false,outcome:'may_have_applied'}}:{code:-32000,message:error instanceof Error ? error.message : 'Request failed'};
          if (!socket.destroyed) socket.write(JSON.stringify({jsonrpc:'2.0', id, error:failure}) + '\n');
        }
      })();
    });
  });
  async function closeOwnedServer(): Promise<void> {
    if (server.listening) {
      const current = await statIfPresent(path);
      if (current && (!ownedSocket || !sameFile(identity(current), ownedSocket))) {
        // libuv unlinks its bound pathname on close. Avoid that close if an outside
        // process replaced the pathname; the kernel releases our unreferenced handle at exit.
        server.unref();
        throw new Error('Daemon socket was replaced externally; preserved socket and lock for manual inspection');
      }
      await closeServer(server);
    }
  }
  try {
    const stale = await readLock(lockPath);
    if (stale) await recoverLock(lockPath, path, stale);
    const start = await processStart(process.pid);
    if (start === null) throw new Error('Cannot establish daemon process identity');
    const owner: LockRecord = { version: 1, pid: process.pid, start, token: randomUUID() };
    const lock = await open(lockPath, 'wx', 0o600);
    try {
      const raw = JSON.stringify(owner);
      await writeLockRecord(lock, raw);
      ownedLock = { identity: identity(await lock.stat({ bigint: true })), raw, owner };
      // A socket without a provable stale owner is ambiguous and is never removed.
      await listen(server, path);
      ownedSocket = identity(await lstat(path, { bigint: true }));
      await chmod(path, 0o600);
      ownedSocket = identity(await lstat(path, { bigint: true }));
      owner.socket = ownedSocket;
      const readyRaw = JSON.stringify(owner);
      await writeLockRecord(lock, readyRaw);
      ownedLock = { identity: identity(await lock.stat({ bigint: true })), raw: readyRaw, owner };
    } finally { await lock.close(); }
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    let safeToRemoveLock = true;
    try { await closeOwnedServer(); } catch { safeToRemoveLock = false; }
    try { if (safeToRemoveLock && ownedLock) await removeOwnedLock(lockPath, ownedLock); }
    finally { await closeServer(mutex); }
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {server, close() {
    return closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      try {
        await closeOwnedServer();
        if (ownedLock) await removeOwnedLock(lockPath, ownedLock);
      } finally { await closeServer(mutex); }
    })();
  }};
}
