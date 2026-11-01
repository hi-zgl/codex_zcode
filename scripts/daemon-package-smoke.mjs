import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const archive = join(source, 'dist', 'releases', `${pkg.name}-${pkg.version}.tgz`);
const temporary = await mkdtemp(join(tmpdir(), 'zpd-'));
const prefix = join(temporary, 'install');
const pool = join(temporary, 'pool');
const env = { ...process.env, ZCODE_POOL_HOME: pool };
let daemon;
let exited;
let stderr = '';
function rpc(method) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(pool, 'scheduler', 'daemon.sock'));
    let buffer = ''; let done = false;
    const timer = setTimeout(() => finish(new Error('Package smoke RPC timed out')), 1000);
    function finish(error, value) {
      if (done) return;
      done = true; clearTimeout(timer); socket.destroy();
      error ? reject(error) : resolve(value);
    }
    socket.once('error', error => finish(error));
    socket.once('close', () => { if (!done) finish(new Error('RPC closed without response')); });
    socket.once('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 'smoke', method, params: {} }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) { finish(new Error('Oversize response')); return; }
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, index));
        assert.equal(response.id, 'smoke');
        response.error ? finish(new Error(response.error.message)) : finish(undefined, response.result);
      } catch (error) { finish(error); }
    });
  });
}
try {
  await mkdir(prefix);
  await run('npm', ['install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', archive], {
    cwd: temporary, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
  });
  const installed = join(prefix, 'node_modules', pkg.name);
  const launcher = join(installed, 'bin', 'zcode-pool.mjs');
  const cli = async (...args) => run(process.execPath, [launcher, ...args], { cwd: temporary, env, timeout: 15_000 });
  const help = await cli('--help');
  assert.match(help.stdout, /daemon-start/);
  const unit = await cli('service-generate');
  assert.ok(unit.stdout.includes(installed), 'unit must use installed runtime');
  assert.ok(!unit.stdout.includes(source), 'unit must not refer to checkout');
  assert.match(unit.stdout, /KillMode=process/);
  daemon = spawn(process.execPath, [launcher, 'daemon'], { cwd: temporary, env, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  exited = new Promise((resolve, reject) => { daemon.once('error', reject); daemon.once('exit', (code, signal) => resolve({ code, signal })); });
  let overview;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`Installed daemon exited: ${stderr}`);
    try { overview = await rpc('overview'); break; } catch { await delay(100); }
  }
  assert.ok(overview, `Installed daemon never became ready: ${stderr}`);
  assert.deepEqual(overview.tasks, []);
  assert.deepEqual(overview.workers, []);
  assert.deepEqual(overview.accounts, []);
  assert.deepEqual(await rpc('daemon_stop'), { stopping: true, workersStopped: false });
  const result = await Promise.race([exited, delay(10_000).then(() => { throw new Error('Installed daemon did not exit'); })]);
  assert.equal(result.code, 0);
  console.log('PASS: independent package install, CLI, service paths, empty daemon RPC, clean shutdown; no Worker/model activity');
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM');
    await Promise.race([exited.catch(() => {}), delay(5000)]);
  }
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) await rm(temporary, { recursive: true, force: true });
  else console.error(`Preserved test directory because the owned test daemon has not exited: ${temporary}`);
}
