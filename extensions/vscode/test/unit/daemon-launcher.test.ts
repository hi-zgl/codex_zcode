import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { HostError } from '../../src/host/client.js';
import { findNodeExecutable, startInstalledDaemon, validateNode24, type DaemonLaunchOptions } from '../../src/host/daemon-launcher.js';

const linuxOnly = { skip: process.platform !== 'linux' };
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(t: TestContext, version = 'v24.0.0', extraCli = '') {
  const root = await mkdtemp(join(tmpdir(), 'zcode-launcher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "installed space $(no-shell) ' 好", 'node_modules', 'zcode-pool');
  const cliPath = join(directory, 'bin', 'zcode-pool.mjs');
  const nodePath = join(root, "node space ' $(no-shell)", 'node');
  const versionMarker = join(root, 'version-checked');
  const invocation = join(directory, 'invocation.json');
  await mkdir(dirname(cliPath), { recursive: true });
  await mkdir(dirname(nodePath), { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'zcode-pool', bin: { 'zcode-pool': './bin/zcode-pool.mjs' } }));
  await writeFile(cliPath, `import { writeFile } from 'node:fs/promises';
await writeFile(new URL('../invocation.json', import.meta.url), JSON.stringify({ args: process.argv.slice(2), poolHome: process.env.ZCODE_POOL_HOME, cwd: process.cwd(), connectionFile: process.env.ZCODE_POOL_CONNECTION_FILE }));
${extraCli}
`);
  await writeFile(nodePath, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf checked > ${quote(versionMarker)}
  printf '%s\\n' ${quote(version)}
  exit 0
fi
exec ${quote(process.execPath)} "$@"
`, { mode: 0o700 });
  const options: DaemonLaunchOptions = { poolHome: join(root, "pool space ' ; $(no-shell)"), nodePath, cliPath, trusted: () => true, isCurrent: () => true };
  return { root, directory, cliPath, nodePath, versionMarker, invocation, options };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (existsSync(path)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The temporary CLI fixture did not start');
}

test('explicit startup uses the declared installed bin, selected pool and arguments without a shell', linuxOnly, async t => {
  const f = await fixture(t);
  const bin = join(f.root, '.bin', 'zcode-pool');
  await mkdir(dirname(bin));
  await symlink(f.cliPath, bin);
  await startInstalledDaemon({ ...f.options, cliPath: bin });
  assert.deepEqual(JSON.parse(await readFile(f.invocation, 'utf8')), {
    args: ['daemon-start'], poolHome: f.options.poolHome, cwd: f.directory,
  });
  assert.equal(existsSync(f.options.poolHome), false, 'The launcher itself does not create or populate a pool');
});

test('Codex setup Node validation only checks the version and never starts the CLI or creates a pool', linuxOnly, async t => {
  const f = await fixture(t);
  await validateNode24(f.nodePath);
  assert.equal(existsSync(f.versionMarker), true);
  assert.equal(existsSync(f.invocation), false);
  assert.equal(existsSync(f.options.poolHome), false);
});

test('Codex setup Node validation rejects old versions and selection changes before and after its check', linuxOnly, async t => {
  const old = await fixture(t, 'v22.15.0');
  await assert.rejects(validateNode24(old.nodePath), { code: 'INVALID_DAEMON_NODE' });
  assert.equal(existsSync(old.invocation), false);
  const f = await fixture(t);
  await assert.rejects(validateNode24(f.nodePath, () => false), { code: 'STALE_CONNECTION' });
  assert.equal(existsSync(f.versionMarker), false);
  await assert.rejects(validateNode24(f.nodePath, () => !existsSync(f.versionMarker)), { code: 'STALE_CONNECTION' });
  assert.equal(existsSync(f.versionMarker), true);
  assert.equal(existsSync(f.invocation), false);
});

test('invalid, missing and non-executable paths never request daemon startup', linuxOnly, async t => {
  const f = await fixture(t);
  for (const key of ['poolHome', 'nodePath', 'cliPath'] as const) {
    for (const value of ['', 'relative/path', '"/quoted/path"', '/nul\0path']) {
      await assert.rejects(startInstalledDaemon({ ...f.options, [key]: value }), { code: 'INVALID_DAEMON_CONFIG' });
    }
  }
  await assert.rejects(startInstalledDaemon({ ...f.options, nodePath: f.root }), { code: 'INVALID_DAEMON_NODE' });
  await chmod(f.nodePath, 0o600);
  await assert.rejects(startInstalledDaemon(f.options), { code: 'INVALID_DAEMON_NODE' });
  await chmod(f.nodePath, 0o700);
  await assert.rejects(startInstalledDaemon({ ...f.options, cliPath: join(f.root, 'missing') }), { code: 'INVALID_DAEMON_CLI' });
  assert.equal(existsSync(f.versionMarker), false);
  assert.equal(existsSync(f.invocation), false);
});

test('a profile inherited by VS Code cannot override the explicitly selected launch pool', linuxOnly, async t => {
  const f = await fixture(t);
  const previous = process.env.ZCODE_POOL_CONNECTION_FILE;
  process.env.ZCODE_POOL_CONNECTION_FILE = join(f.root, 'unrelated-pool-profile.json');
  try { await startInstalledDaemon(f.options); }
  finally {
    if (previous === undefined) delete process.env.ZCODE_POOL_CONNECTION_FILE;
    else process.env.ZCODE_POOL_CONNECTION_FILE = previous;
  }
  const invocation = JSON.parse(await readFile(f.invocation, 'utf8'));
  assert.equal(invocation.poolHome, f.options.poolHome);
  assert.equal(invocation.connectionFile, undefined);
});

test('checkout, wrong package, escaped declaration and mismatched bin are rejected before execution', linuxOnly, async t => {
  const f = await fixture(t);
  for (const manifest of [
    { name: 'zcode-pool', private: true },
    { name: 'another-package', bin: { 'zcode-pool': './bin/zcode-pool.mjs' } },
    { name: 'zcode-pool', bin: { 'zcode-pool': '../../bin/zcode-pool.mjs' } },
    { name: 'zcode-pool', bin: { 'zcode-pool': './bin/something-else.mjs' } },
  ]) {
    await writeFile(join(f.directory, 'package.json'), JSON.stringify(manifest));
    await assert.rejects(startInstalledDaemon(f.options), { code: 'INVALID_DAEMON_CLI' });
  }
  await writeFile(join(f.directory, 'package.json'), 'invalid JSON');
  await assert.rejects(startInstalledDaemon(f.options), { code: 'INVALID_DAEMON_CLI' });
  assert.equal(existsSync(f.versionMarker), false);
  assert.equal(existsSync(f.invocation), false);
});

test('older, malformed and oversized version replies never execute the installed CLI', linuxOnly, async t => {
  for (const version of ['v22.1.0', 'v20.0.0', '24.0.0', 'v24.0.0\nextra', 'x'.repeat(2_048)]) {
    const f = await fixture(t, version);
    await assert.rejects(startInstalledDaemon(f.options), { code: 'INVALID_DAEMON_NODE' });
    assert.equal(existsSync(f.invocation), false);
  }
});

test('trust, selection and prior cancellation block startup before any executable runs', linuxOnly, async t => {
  const f = await fixture(t);
  await assert.rejects(startInstalledDaemon({ ...f.options, trusted: () => false }), { code: 'WORKSPACE_UNTRUSTED' });
  await assert.rejects(startInstalledDaemon({ ...f.options, isCurrent: () => false }), { code: 'STALE_CONNECTION' });
  await assert.rejects(startInstalledDaemon({ ...f.options, signal: AbortSignal.abort() }), { code: 'ABORTED', unknownOutcome: false });
  assert.equal(existsSync(f.versionMarker), false);
});

for (const guard of ['trusted', 'isCurrent'] as const) test(`${guard} is checked again after the asynchronous Node check`, linuxOnly, async t => {
  const f = await fixture(t);
  await assert.rejects(startInstalledDaemon({ ...f.options, [guard]: () => !existsSync(f.versionMarker) }), {
    code: guard === 'trusted' ? 'WORKSPACE_UNTRUSTED' : 'STALE_CONNECTION', unknownOutcome: false,
  });
  assert.equal(existsSync(f.versionMarker), true);
  assert.equal(existsSync(f.invocation), false);
});

test('failed CLI output is discarded and startup has an explicitly unknown outcome', linuxOnly, async t => {
  const secret = 'SECRET_NATIVE_LOG_WITH_TOKEN';
  const f = await fixture(t, 'v24.1.0', `console.error(${JSON.stringify(secret)}); process.exitCode = 1;`);
  await assert.rejects(startInstalledDaemon(f.options), (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'DAEMON_START_FAILED');
    assert.equal(error.unknownOutcome, true);
    assert.match(error.message, /scheduler\/daemon.log.*Connect/);
    assert.equal(error.message.includes(secret), false);
    return true;
  });
});

test('cancelling startup stops the CLI wait and does not claim that its daemon stopped', linuxOnly, async t => {
  const f = await fixture(t, 'v24.0.0', 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const started = startInstalledDaemon({ ...f.options, signal: controller.signal });
  const rejected = assert.rejects(started, (error: unknown) => {
    assert.ok(error instanceof HostError);
    assert.equal(error.code, 'ABORTED');
    assert.equal(error.unknownOutcome, true);
    assert.match(error.message, /may already have started.*Connect/);
    return true;
  });
  await waitForFile(f.invocation);
  controller.abort();
  await rejected;
});

test('a pool changed during startup is not reported as a successful current launch', linuxOnly, async t => {
  const f = await fixture(t, 'v24.0.0', 'await new Promise(resolve => setTimeout(resolve, 150));');
  let current = true;
  const started = startInstalledDaemon({ ...f.options, isCurrent: () => current });
  const rejected = assert.rejects(started, { code: 'STALE_CONNECTION', unknownOutcome: true });
  await waitForFile(f.invocation);
  current = false;
  await rejected;
});

test('PATH discovery skips empty, relative, non-file and non-executable candidates without executing them', linuxOnly, async t => {
  const f = await fixture(t);
  const notExecutable = join(f.root, 'not-executable');
  const notFile = join(f.root, 'not-file');
  await mkdir(notExecutable);
  await writeFile(join(notExecutable, 'node'), 'not an executable', { mode: 0o600 });
  await mkdir(join(notFile, 'node'), { recursive: true });
  const linked = join(f.root, 'linked');
  await mkdir(linked);
  await symlink(f.nodePath, join(linked, 'node'));
  const found = await findNodeExecutable(['', '.', 'relative/bin', notExecutable, notFile, linked].join(delimiter));
  assert.equal(found, await realpath(f.nodePath));
  assert.equal(existsSync(f.versionMarker), false);
  assert.equal(await findNodeExecutable(undefined), undefined);
  assert.equal(await findNodeExecutable(['', '.', 'relative/bin', notExecutable, notFile].join(delimiter)), undefined);
});
