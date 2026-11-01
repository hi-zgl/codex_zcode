import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const testVersion = process.env.ZCODE_POOL_VSCODE_VERSION || '1.95.3';
delete process.env.ELECTRON_RUN_AS_NODE;
// Keep this installed test in its isolated profile, including under Remote SSH.
for (const key of ['VSCODE_IPC_HOOK_CLI', 'VSCODE_IPC_HOOK', 'VSCODE_CWD']) delete process.env[key];
const executable = await downloadAndUnzipVSCode(testVersion);
const codeCli = join(executable, '..', 'bin', 'code');
const temp = await mkdtemp(join(tmpdir(), 'zp-install-'));
const user = join(temp, 'user');
const extensions = join(temp, 'extensions');
const storage = join(user, 'User/globalStorage/zcode-pool.zcode-pool');
const launcher = join(storage, 'runtime/bin/zcode-pool.mjs');
const mcpLauncher = join(storage, 'runtime/bin/zcode-pool-mcp.mjs');
const pools = [join(temp, 'pool-a'), join(temp, 'pool-b')];
const env = { ...process.env };
delete env.ZCODE_POOL_CONNECTION_FILE;
delete env.ZCODE_POOL_RUNTIME_CLI_PATH;
const cli = (pool, ...args) => exec(process.execPath, [launcher, ...args], { cwd: temp, env: { ...env, ZCODE_POOL_HOME: pool }, timeout: 10_000 });
async function poolPresent(pool) {
  for (const name of ['daemon.sock', 'daemon.lock']) try { await access(join(pool, 'scheduler', name)); return true; } catch {}
  return false;
}
async function cleanupPools() {
  let stopped = true;
  for (const pool of pools) {
    for (let attempt = 0; attempt < 40 && await poolPresent(pool); attempt++) {
      try { await cli(pool, 'daemon-stop'); } catch {}
      await delay(100);
    }
    if (await poolPresent(pool)) stopped = false;
  }
  return stopped;
}
try {
  const vsix = join(temp, 'zcode-pool.vsix');
  await cp(join(root, `zcode-pool-${version}.vsix`), vsix);
  await mkdir(join(user, 'User'), { recursive: true });
  await writeFile(join(user, 'User/settings.json'), JSON.stringify({
    'zcodePool.poolHome': pools[0], 'zcodePool.daemonNodePath': process.execPath,
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'workbench.startupEditor': 'none',
  }));
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
  assert.equal(api.snapshot().connection.poolHome,${JSON.stringify(pools[0])});
  assert.equal(api.snapshot().connection.state,'disconnected');
  await vscode.commands.executeCommand('zcodePool.openWorkbench');
  assert.equal(api.snapshot().connection.state,'disconnected');
  assert.equal(vscode.workspace.getConfiguration('zcodePool').get('daemonCliPath'),'','no separate daemon installation is configured');
  await api.execute({v:1,id:'start-installed',generation:api.snapshot().connection.generation,type:'daemon.start',payload:{}});
  const state=api.snapshot(); assert.equal(state.connection.state,'connected');
  assert.equal(state.connection.capabilities.taskDetail.version,1); assert.ok(state.connection.storeId);
  assert.deepEqual(state.tasks,[]); assert.deepEqual(state.resources.accounts,[]); assert.deepEqual(state.resources.workers,[]);
  const instance=state.connection.instanceId;
  await vscode.commands.executeCommand('zcodePool.startDaemon');
  assert.equal(api.snapshot().connection.instanceId,instance,'Starting an existing service only reconnects');
  await vscode.commands.executeCommand('zcodePool.disconnect');
  const settings=vscode.workspace.getConfiguration('zcodePool');
  await settings.update('poolHome',${JSON.stringify(pools[1])},vscode.ConfigurationTarget.Global);
  for(let n=0;n<100&&api.snapshot().connection.poolHome!==${JSON.stringify(pools[1])};n++)await new Promise(r=>setTimeout(r,20));
  assert.equal(api.snapshot().connection.poolHome,${JSON.stringify(pools[1])});
  assert.equal(api.snapshot().connection.state,'disconnected');
  await vscode.commands.executeCommand('zcodePool.startDaemon');
  assert.equal(api.snapshot().connection.state,'connected');
  assert.notEqual(api.snapshot().connection.instanceId,instance,'A selected pool owns an independent backend');
  assert.deepEqual(api.snapshot().resources.workers,[]); assert.deepEqual(api.snapshot().tasks,[]);
  await vscode.commands.executeCommand('zcodePool.disconnect');
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  console.log('PASS: VSIX-only installation prepares the bundled runtime and explicitly starts independent backends');
};
`);
  const workspace = join(temp, 'workspace'); await mkdir(workspace);
  await writeFile(join(workspace, 'README.md'), 'Empty unified installation fixture.\n');
  await runTests({
    vscodeExecutablePath: executable, extensionDevelopmentPath: verifier, extensionTestsPath: join(verifier, 'tests.cjs'),
    extensionTestsEnv: { ZCODE_POOL_EXTENSION_MODE: 'mock', ZCODE_POOL_UI_FIXTURE: '/nonexistent/must-be-ignored.json', ZCODE_POOL_DEBUG_POOL_HOME: '/nonexistent/also-ignored' },
    launchArgs: [workspace, '--user-data-dir', user, '--extensions-dir', extensions, '--disable-workspace-trust', '--no-sandbox', '--skip-welcome', '--skip-release-notes'],
  });
  await access(launcher); await access(mcpLauncher);
  assert.ok(!launcher.startsWith(extensions), 'Stable runtime is independent of the extension version directory');
  for (const pool of pools) {
    const overview = JSON.parse((await cli(pool, 'overview')).stdout);
    assert.deepEqual(overview.workers, []); assert.deepEqual(overview.tasks, []);
  }
  // Simulate removal of the obsolete VSIX version after an extension update.
  await rm(extensions, { recursive: true, force: true });
  const service = await cli(pools[0], 'service-generate');
  assert.ok(service.stdout.includes(join(storage, 'runtime/versions')));
  assert.ok(!service.stdout.includes(extensions));
  assert.doesNotMatch(service.stdout, /--import/);
  const transport = new StdioClientTransport({ command: process.execPath, args: [mcpLauncher], env: { ...env, ZCODE_POOL_CONNECTION_FILE: join(storage, 'connection.json') }, stderr: 'pipe' });
  const client = new Client({ name: 'unified-vsix-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'zcode_overview'));
    const overview = await client.callTool({ name: 'zcode_overview', arguments: {} });
    assert.ok(!overview.isError, 'Stable bundled MCP uses the selected connection after VS Code exits');
    const finish=await client.callTool({name:'zcode_shutdown_pool',arguments:{}});
    assert.ok(!finish.isError,'explicit finish-work accepted for an idle pool');
    for(let n=0;n<100&&await poolPresent(pools[1]);n++)await delay(50);
    assert.equal(await poolPresent(pools[1]),false,'shutdown removes socket and lock');
    const stopped=await client.callTool({name:'zcode_overview',arguments:{}});
    assert.equal(stopped.isError,true,'read after shutdown does not restart the pool');
    assert.equal(await poolPresent(pools[1]),false);
    const restarted=await client.callTool({name:'zcode_daemon_start',arguments:{}});
    assert.ok(!restarted.isError,'only explicit start restarts the selected pool');
    assert.ok(!(await client.callTool({name:'zcode_overview',arguments:{}})).isError);

  } finally { await client.close(); }
  assert.ok(await cleanupPools(), 'Only the isolated test daemons stop during cleanup');
  console.log(`PASS: unified VSIX, independent daemon lifetime, stable CLI/MCP after extension removal, no npm runtime installation (VS Code ${testVersion})`);
} finally {
  if (await cleanupPools()) await rm(temp, { recursive: true, force: true });
  else console.error(`Preserved isolated test state because its daemon is still live: ${temp}`);
}
