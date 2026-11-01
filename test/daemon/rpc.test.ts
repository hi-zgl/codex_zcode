import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile, lstat, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { serveRpc } from '../../src/daemon/server.js';
import { rpcCall, socketPath } from '../../src/shared/rpc.js';

const loader = import.meta.resolve('tsx');
const serverModule = new URL('../../src/daemon/server.ts', import.meta.url).href;
const deadPid = 2_147_483_647;

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zpool-rpc-'));
  await mkdir(join(root, 'scheduler'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, lock: join(root, 'scheduler', 'daemon.lock'), socket: socketPath(root) };
}
async function kill(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}
function rpcChild(root: string, barrier = false) {
  const source = `
    import { once } from 'node:events';
    import { serveRpc } from ${JSON.stringify(serverModule)};
    if (${barrier}) { console.log('waiting'); await once(process.stdin, 'data'); }
    process.stdin.destroy();
    try {
      const service = await serveRpc(process.argv[1], async () => ({ pid: process.pid }));
      process.on('SIGTERM', () => { void service.close().then(() => process.exit(0)); });
      console.log(JSON.stringify({ ready: process.pid }));
    } catch (error) { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; }
  `;
  const child = spawn(process.execPath, ['--import', loader, '--input-type=module', '--eval', source, root], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  return { child, async line(): Promise<string> {
    const line = await lines.next();
    assert.equal(line.done, false, `RPC child exited unexpectedly: ${stderr}`);
    return line.value!;
  } };
}
async function foreignSocket(path: string): Promise<Server> {
  const server = createServer(socket => { socket.on('error', () => {}); socket.end('foreign'); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  return server;
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function socketIdentity(path: string) {
  const stat = await lstat(path, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), ctimeNs: String(stat.ctimeNs) };
}
async function currentStart(): Promise<string> {
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}

test('daemon serves multiple stateless clients and prevents second owner', async () => {
  const root = await mkdtemp(join(tmpdir(),'zpool-rpc-'));
  const service = await serveRpc(root, async (method,params) => {
    if(method === 'fail') throw new Error('Expected failure');
    return {method,params};
  });
  try {
    assert.deepEqual(await rpcCall('ping',{value:'你好'}, {root}), {method:'ping', params:{value:'你好'}});
    await assert.rejects(rpcCall('fail',{}, {root}), /Expected failure/);
    await assert.rejects(serveRpc(root,async()=>null), /already running/);
    assert.deepEqual(await rpcCall('again',{}, {root}), {method:'again',params:{}});
  } finally {await service.close();}
  try {
    await assert.rejects(lstat(join(root, 'scheduler', 'daemon.lock')), { code: 'ENOENT' });
    await assert.rejects(lstat(socketPath(root)), { code: 'ENOENT' });
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('SIGKILL releases the recovery mutex and a crashed RPC owner is reclaimed', { timeout: 10_000 }, async t => {
  const { root, lock, socket } = await fixture(t);
  const child = rpcChild(root);
  try {
    assert.ok(JSON.parse(await child.line()).ready);
    const previous = JSON.parse(await readFile(lock, 'utf8'));
    assert.deepEqual(previous.socket, await socketIdentity(socket));
    await kill(child.child);
    assert.deepEqual(previous.socket, await socketIdentity(socket), 'socket identity survives SIGKILL');
    const service = await serveRpc(root, async () => ({ recovered: true }));
    try {
      assert.deepEqual(await rpcCall('ping', {}, { root }), { recovered: true });
      assert.notEqual(JSON.parse(await readFile(lock, 'utf8')).token, previous.token);
    } finally { await service.close(); }
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
    await assert.rejects(lstat(socket), { code: 'ENOENT' });
  } finally { await kill(child.child); }
});

test('two processes racing to reclaim a crashed owner through path aliases elect one daemon', { timeout: 10_000 }, async t => {
  const { root, lock } = await fixture(t);
  const alias = root + '-alias';
  await symlink(root, alias);
  t.after(() => unlink(alias));
  const previous = rpcChild(root);
  let competitors: ReturnType<typeof rpcChild>[] = [];
  try {
    assert.ok(JSON.parse(await previous.line()).ready);
    await kill(previous.child);
    competitors = [rpcChild(root, true), rpcChild(alias, true)];
    assert.deepEqual(await Promise.all(competitors.map(child => child.line())), ['waiting', 'waiting']);
    for (const child of competitors) child.child.stdin!.write('go');
    const results = (await Promise.all(competitors.map(child => child.line()))).map(line => JSON.parse(line));
    const winners = results.filter(result => result.ready);
    const losers = results.filter(result => result.error);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.match(losers[0]!.error, /already running/);
    assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, winners[0]!.ready);
    assert.deepEqual(await rpcCall('ping', {}, { root }), { pid: winners[0]!.ready });
  } finally {
    await kill(previous.child);
    await Promise.all(competitors.map(child => kill(child.child)));
  }
});

test('legacy stale lock without a socket is recovered, live and reused PID records are retained', async t => {
  const { root, lock } = await fixture(t);
  await writeFile(lock, JSON.stringify({ pid: deadPid, start: '1' }));
  const service = await serveRpc(root, async () => null);
  await service.close();
  for (const [start, message] of [[await currentStart(), /already running/], ['0', /PID has been reused/]] as const) {
    const raw = JSON.stringify({ pid: process.pid, start });
    await writeFile(lock, raw);
    await assert.rejects(serveRpc(root, async () => null), message);
    assert.equal(await readFile(lock, 'utf8'), raw);
  }
});

test('malformed or non-regular daemon locks are preserved for manual inspection', async t => {
  const { root, lock } = await fixture(t);
  const records = ['', '{', 'null', '{}', '{"pid":1,"start":null}', JSON.stringify({ version: 2, pid: deadPid, start: '1' }),
    JSON.stringify({ version: 1, pid: deadPid, start: '1', token: '-'.repeat(36) }),
    JSON.stringify({ version: 1, pid: deadPid, start: '1', token: randomUUID(), socket: { ino: '1' } })];
  for (const raw of records) {
    await writeFile(lock, raw);
    await assert.rejects(serveRpc(root, async () => null), /daemon lock/i);
    assert.equal(await readFile(lock, 'utf8'), raw);
  }
  const target = join(root, 'external-lock');
  await writeFile(target, JSON.stringify({ pid: deadPid, start: '1' }));
  await unlink(lock);
  await symlink(target, lock);
  await assert.rejects(serveRpc(root, async () => null), /Invalid daemon lock/);
  assert.equal((await lstat(lock)).isSymbolicLink(), true);
  assert.equal(await readFile(target, 'utf8'), JSON.stringify({ pid: deadPid, start: '1' }));
});

test('an unowned socket or regular file is never removed, and failed bind cleans only its own lock', async t => {
  const { root, lock, socket } = await fixture(t);
  const foreign = await foreignSocket(socket);
  try {
    const previous = await socketIdentity(socket);
    await assert.rejects(serveRpc(root, async () => null), { code: 'EADDRINUSE' });
    assert.deepEqual(await socketIdentity(socket), previous);
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
    const raw = JSON.stringify({ pid: deadPid, start: '1' });
    await writeFile(lock, raw);
    await assert.rejects(serveRpc(root, async () => null), /cannot prove socket ownership/);
    assert.equal(await readFile(lock, 'utf8'), raw);
    assert.deepEqual(await socketIdentity(socket), previous);
  } finally { await closeServer(foreign); }
  await unlink(lock);
  await writeFile(socket, 'external data');
  await assert.rejects(serveRpc(root, async () => null), { code: 'EADDRINUSE' });
  assert.equal(await readFile(socket, 'utf8'), 'external data');
  await assert.rejects(lstat(lock), { code: 'ENOENT' });
});

test('a live socket is retained even when a dead-owner lock claims the matching inode', async t => {
  const { root, lock, socket } = await fixture(t);
  const foreign = await foreignSocket(socket);
  try {
    const expected = await socketIdentity(socket);
    const raw = JSON.stringify({ version: 1, pid: deadPid, start: '1', token: randomUUID(), socket: expected });
    await writeFile(lock, raw);
    await assert.rejects(serveRpc(root, async () => null), /socket is active/);
    assert.equal(await readFile(lock, 'utf8'), raw);
    assert.deepEqual(await socketIdentity(socket), expected);
  } finally { await closeServer(foreign); }
});

test('a replacement socket is preserved even after the previous daemon crashed', { timeout: 10_000 }, async t => {
  const { root, lock, socket } = await fixture(t);
  const child = rpcChild(root);
  let foreign: Server | undefined;
  try {
    assert.ok(JSON.parse(await child.line()).ready);
    await kill(child.child);
    const raw = await readFile(lock, 'utf8');
    await unlink(socket);
    foreign = await foreignSocket(socket);
    const expected = await socketIdentity(socket);
    await assert.rejects(serveRpc(root, async () => null), /cannot prove socket ownership/);
    assert.equal(await readFile(lock, 'utf8'), raw);
    assert.deepEqual(await socketIdentity(socket), expected);
  } finally { await kill(child.child); if (foreign) await closeServer(foreign); }
});

test('shutdown preserves a replacement lock instead of unlinking it', async t => {
  const { root, lock } = await fixture(t);
  const service = await serveRpc(root, async () => null);
  const replacement = JSON.stringify({ pid: process.pid, start: await currentStart() });
  await unlink(lock);
  await writeFile(lock, replacement);
  await service.close();
  assert.equal(await readFile(lock, 'utf8'), replacement);
});

test('shutdown avoids libuv unlink when an outside process replaced the socket', async t => {
  const { root, lock, socket } = await fixture(t);
  const service = await serveRpc(root, async () => null);
  await unlink(socket);
  const foreign = await foreignSocket(socket);
  try {
    const expected = await socketIdentity(socket);
    await assert.rejects(service.close(), /replaced externally/);
    assert.deepEqual(await socketIdentity(socket), expected);
    assert.ok(await readFile(lock, 'utf8'));
  } finally {
    await closeServer(foreign);
    // The safety branch intentionally keeps the old native handle until process exit;
    // now that the foreign server has removed its path, closing that handle is safe.
    await closeServer(service.server);
  }
});

test('the foreground daemon restarts after SIGKILL using its persisted lock and socket', { timeout: 20_000 }, async t => {
  const { root, lock } = await fixture(t);
  const entry = fileURLToPath(new URL('../../src/daemon/main.ts', import.meta.url));
  function start() {
    return spawn(process.execPath, ['--import', loader, entry], { env: { ...process.env, ZCODE_POOL_HOME: root }, stdio: 'ignore' });
  }
  async function ready(child: ChildProcess) {
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, 'foreground daemon should remain running');
      try { return await rpcCall<{ tasks: unknown[] }>('overview', {}, { root, timeoutMs: 100 }); }
      catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
    assert.fail('foreground daemon did not become ready');
  }
  const first = start();
  let second: ChildProcess | undefined;
  try {
    assert.deepEqual((await ready(first)).tasks, []);
    const previous = await readFile(lock, 'utf8');
    await kill(first);
    second = start();
    assert.deepEqual((await ready(second)).tasks, []);
    assert.notEqual(await readFile(lock, 'utf8'), previous);
    await kill(second, 'SIGTERM');
    assert.equal(second.exitCode, 0);
    await assert.rejects(lstat(lock), { code: 'ENOENT' });
  } finally { await kill(first); if (second) await kill(second); }
});
