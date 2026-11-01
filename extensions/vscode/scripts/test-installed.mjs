import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const project = fileURLToPath(new URL('../../../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const testVersion = process.env.ZCODE_POOL_VSCODE_VERSION || '1.95.3';
delete process.env.ELECTRON_RUN_AS_NODE;
// The desktop bin/code shim otherwise redirects to the user's existing remote
// CLI and silently ignores our isolated profile/extension directories.
delete process.env.VSCODE_IPC_HOOK_CLI;
delete process.env.VSCODE_IPC_HOOK;
delete process.env.VSCODE_CWD;
const executable = await downloadAndUnzipVSCode(testVersion);
const codeCli = join(executable, '..', 'bin', 'code');
const temp = await mkdtemp(join(tmpdir(), 'zp-install-'));
let daemon; let exit;
try {
  const vsix = join(temp, 'zcode-pool.vsix'); const tgz = join(temp, 'zcode-pool.tgz');
  await cp(join(root, `zcode-pool-${version}.vsix`), vsix);
  await cp(join(project, 'dist/releases', `zcode-pool-${version}.tgz`), tgz);
  const prefix = join(temp, 'runtime'); const pool = join(temp, 'pool');
  const env = { ...process.env, ZCODE_POOL_HOME: pool };
  await exec('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', tgz], { cwd: temp, env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const launcher = join(prefix, 'node_modules/zcode-pool/bin/zcode-pool.mjs');
  let stderr = '';
  daemon = spawn(process.execPath, [launcher, 'daemon'], { cwd: temp, env, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  exit = new Promise((resolve, reject) => { daemon.once('error', reject); daemon.once('exit', (code, signal) => resolve({ code, signal })); });
  const cli = (...args) => exec(process.execPath, [launcher, ...args], { cwd: temp, env, timeout: 10_000 });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (daemon.exitCode !== null) throw new Error(`Installed daemon exited: ${stderr}`);
    try { await cli('overview'); ready = true; break; } catch { await delay(100); }
  }
  assert.ok(ready, 'Standalone installed daemon must be reachable');
  const user = join(temp, 'user'); const extensions = join(temp, 'extensions');
  await mkdir(join(user, 'User'), { recursive: true });
  await writeFile(join(user, 'User/settings.json'), JSON.stringify({ 'zcodePool.poolHome': pool, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none' }));
  await exec(codeCli, ['--user-data-dir', user, '--extensions-dir', extensions, '--install-extension', vsix, '--force', '--no-sandbox'], { cwd: temp, env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
  const verifier = join(temp, 'verifier'); await mkdir(verifier);
  await writeFile(join(verifier, 'package.json'), JSON.stringify({ name: 'installed-verifier', publisher: 'local-test', version: '0.0.1', engines: { vscode: '^1.95.0' }, main: './index.js' }));
  await writeFile(join(verifier, 'index.js'), 'exports.activate = () => {};\n');
  await writeFile(join(verifier, 'tests.cjs'), `
const vscode=require('vscode'); const assert=require('node:assert/strict');
exports.run=async()=>{
  const extension=vscode.extensions.getExtension('zcode-pool.zcode-pool'); assert.ok(extension,'VSIX installed');
  assert.ok(extension.extensionPath.startsWith(${JSON.stringify(extensions)}),'target comes from isolated installed extensions directory');
  const api=await extension.activate();
  assert.equal(api.snapshot().connection.mode,'real','production ignores injected mock debug environment');
  assert.equal(api.snapshot().connection.poolHome,${JSON.stringify(pool)});
  assert.equal(api.snapshot().connection.state,'disconnected');
  await vscode.commands.executeCommand('zcodePool.openWorkbench');
  assert.equal(api.snapshot().connection.state,'disconnected');
  await vscode.commands.executeCommand('zcodePool.connect');
  const state=api.snapshot(); assert.equal(state.connection.state,'connected');
  assert.equal(state.connection.capabilities.taskDetail.version,1); assert.ok(state.connection.storeId);
  assert.deepEqual(state.tasks,[]); assert.deepEqual(state.resources.accounts,[]);
  await vscode.commands.executeCommand('zcodePool.disconnect');
  assert.equal(api.snapshot().connection.state,'disconnected');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('PASS: installed production VSIX, explicit real connection to independently installed daemon, no checkout runtime dependency');
};
`);
  const workspace = join(temp, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), 'Empty standalone installation fixture.\n');
  await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: verifier, extensionTestsPath: join(verifier, 'tests.cjs'),
    extensionTestsEnv: { ZCODE_POOL_EXTENSION_MODE: 'mock', ZCODE_POOL_UI_FIXTURE: '/nonexistent/must-be-ignored.json', ZCODE_POOL_DEBUG_POOL_HOME: '/nonexistent/also-ignored' },
    launchArgs: [workspace, '--user-data-dir', user, '--extensions-dir', extensions, '--disable-workspace-trust', '--no-sandbox', '--skip-welcome', '--skip-release-notes'],
  });
  const overview = JSON.parse((await cli('overview')).stdout);
  assert.deepEqual(overview.workers, []); assert.deepEqual(overview.tasks, []);
  await cli('daemon-stop');
  const controller = new AbortController();
  try { const outcome = await Promise.race([exit, delay(10_000, undefined, { signal: controller.signal }).then(() => { throw new Error('Installed daemon did not stop'); })]); assert.equal(outcome.code, 0); }
  finally { controller.abort(); }
  console.log(`PASS: standalone VSIX + daemon installation verified on VS Code ${testVersion}`);
} finally {
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM'); const controller = new AbortController();
    try { await Promise.race([exit.catch(() => {}), delay(5000, undefined, { signal: controller.signal })]); } finally { controller.abort(); }
  }
  if (!daemon || daemon.exitCode !== null || daemon.signalCode !== null) await rm(temp, { recursive: true, force: true });
  else console.error(`Preserved test state because owned daemon is still live: ${temp}`);
}
