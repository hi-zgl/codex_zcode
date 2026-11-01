import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureBundledRuntime } from '../../src/host/runtime-installer.js';

const exec = promisify(execFile);
async function payload(extensionPath: string, version = '0.1.0') {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'zcode-pool', version, type: 'module', bin: { 'zcode-pool': './bin/zcode-pool.mjs' } }),
    'bin/zcode-pool.mjs': "await import(new URL('../cli.mjs',import.meta.url));\n",
    'cli.mjs': `console.log(JSON.stringify({version:${JSON.stringify(version)},args:process.argv.slice(2),entry:process.env.ZCODE_POOL_RUNTIME_CLI_PATH}));\n`,
    'daemon.mjs': `throw new Error('Fixture daemon must never run during installation');\n`,
    'mcp.mjs': `console.log(JSON.stringify({version:${JSON.stringify(version)},mcp:true,entry:process.env.ZCODE_POOL_RUNTIME_CLI_PATH}));\n`,
  };
  const hashes: Record<string, string> = {};
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(join(extensionPath, 'dist/runtime', path)), { recursive: true });
    await writeFile(join(extensionPath, 'dist/runtime', path), data);
    hashes[path] = createHash('sha256').update(data).digest('hex');
  }
  await writeFile(join(extensionPath, 'dist/runtime/manifest.json'), JSON.stringify({ schemaVersion: 1, name: 'zcode-pool', version, files: hashes }));
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zp-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensionPath = join(root, "extension ' 你好 $(no-shell)");
  const globalStoragePath = join(root, "storage ' 你好 $(no-shell)");
  await payload(extensionPath);
  return { root, extensionPath, globalStoragePath };
}

test('verified runtime is installed privately once and stable entries survive removal of the extension', async t => {
  const f = await fixture(t);
  const runtime = await ensureBundledRuntime(f);
  assert.equal(runtime.version, '0.1.0');
  assert.ok(runtime.directory.startsWith(join(f.globalStoragePath, 'runtime/versions')));
  assert.ok(!runtime.cliPath.includes(f.extensionPath));
  const original = await stat(join(runtime.directory, 'cli.mjs'));
  assert.deepEqual(await ensureBundledRuntime(f), runtime);
  assert.equal((await stat(join(runtime.directory, 'cli.mjs'))).mtimeMs, original.mtimeMs);
  assert.equal((await stat(runtime.cliPath)).mode & 0o777, 0o700);
  await rm(f.extensionPath, { recursive: true });
  const run = async (entry: string, ...args: string[]) => JSON.parse((await exec(process.execPath, [entry, ...args], { cwd: f.root })).stdout);
  assert.deepEqual(await run(runtime.cliPath, 'mcp', 'literal $(no-shell)'), { version: '0.1.0', args: ['mcp', 'literal $(no-shell)'], entry: runtime.cliPath });
  assert.deepEqual(await run(runtime.mcpPath), { version: '0.1.0', mcp: true, entry: runtime.cliPath });
  assert.deepEqual((await readdir(join(f.globalStoragePath, 'runtime/versions'))), [runtime.directory.split('/').at(-1)]);
});

test('upgrade preserves the previous daemon version and updates the same stable entry', async t => {
  const f = await fixture(t);
  const first = await ensureBundledRuntime(f);
  const previousDaemon = await readFile(join(first.directory, 'daemon.mjs'), 'utf8');
  await payload(f.extensionPath, '0.2.0');
  const second = await ensureBundledRuntime(f);
  assert.notEqual(first.directory, second.directory);
  assert.equal(second.cliPath, first.cliPath);
  assert.equal(second.mcpPath, first.mcpPath);
  assert.equal(await readFile(join(first.directory, 'daemon.mjs'), 'utf8'), previousDaemon);
  assert.equal(JSON.parse((await exec(process.execPath, [second.cliPath])).stdout).version, '0.2.0');
  assert.equal((await readdir(join(f.globalStoragePath, 'runtime/versions'))).length, 2);
});

test('concurrent installation commits one complete immutable version', async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([ensureBundledRuntime(f), ensureBundledRuntime(f)]);
  assert.deepEqual(first, second);
  assert.deepEqual(await readdir(join(f.globalStoragePath, 'runtime/versions')), [first.directory.split('/').at(-1)]);
  assert.equal(JSON.parse((await exec(process.execPath, [first.cliPath])).stdout).version, '0.1.0');
});

test('incomplete and modified payloads are rejected before any installation or execution', async t => {
  const f = await fixture(t);
  await writeFile(join(f.extensionPath, 'dist/runtime/cli.mjs'), 'throw new Error("tampered");');
  await assert.rejects(ensureBundledRuntime(f), { code: 'BUNDLED_RUNTIME_INVALID' });
  await assert.rejects(lstat(f.globalStoragePath), { code: 'ENOENT' });
  await payload(f.extensionPath);
  const path = join(f.extensionPath, 'dist/runtime/manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.files['../outside.mjs'] = '0'.repeat(64);
  await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(ensureBundledRuntime(f), { code: 'BUNDLED_RUNTIME_INVALID' });
  await assert.rejects(lstat(f.globalStoragePath), { code: 'ENOENT' });
});

test('corrupt installed versions are not selected or silently executed', async t => {
  const f = await fixture(t);
  const runtime = await ensureBundledRuntime(f);
  const currentPath = join(f.globalStoragePath, 'runtime/current.json');
  const current = await readFile(currentPath, 'utf8');
  await writeFile(join(runtime.directory, 'daemon.mjs'), 'tampered');
  await assert.rejects(ensureBundledRuntime(f), { code: 'BUNDLED_RUNTIME_INVALID' });
  assert.equal(await readFile(currentPath, 'utf8'), current);
});
