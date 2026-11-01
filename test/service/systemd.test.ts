import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultUserServiceOptions, installUserService, renderUserService, userUnitDirectory, type UserServiceOptions } from '../../src/service/systemd.js';
import { rpcCall } from '../../src/shared/rpc.js';

const run = promisify(execFile);
const cli = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
const loader = import.meta.resolve('tsx');

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zpu-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, options: { ...defaultUserServiceOptions(), poolHome: join(root, 'pool') } };
}

test('unit uses absolute runtime paths, foreground daemon, bounded restart, and worker-preserving stop semantics', () => {
  const options = defaultUserServiceOptions();
  for (const key of ['nodePath', 'loaderPath', 'entryPath', 'workingDirectory', 'poolHome'] as const) assert.ok(isAbsolute(options[key]));
  const unit = renderUserService(options);
  assert.ok(unit.includes(`ExecStart=:"${process.execPath}" "--import" "${pathToFileURL(options.loaderPath).href}" "${options.entryPath}"\n`));
  assert.ok(unit.includes(`WorkingDirectory=${options.workingDirectory}/.\n`));
  assert.ok(unit.includes(`Environment="ZCODE_POOL_HOME=${options.poolHome}"\n`));
  assert.match(unit, /^Type=exec$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^StartLimitBurst=5$/m);
  assert.match(unit, /^KillMode=process$/m);
  assert.match(unit, /^UMask=0077$/m);
  assert.doesNotMatch(unit, /daemon-start|\/bin\/(?:ba)?sh|PIDFile=|User=/);
});

test('unit generation rejects relative paths, control characters, unsafe names, unsupported executable characters, and overlong sockets', () => {
  const options = defaultUserServiceOptions();
  for (const key of ['nodePath', 'loaderPath', 'entryPath', 'workingDirectory', 'poolHome'] as const) {
    assert.throws(() => renderUserService({ ...options, [key]: 'relative/path' }), /absolute path/);
    assert.throws(() => renderUserService({ ...options, [key]: '/absolute\nInjected=1' }), /control characters/);
  }
  for (const name of ['../other.service', 'x@.service', 'x%Q.service', 'x\n.service', '.service', 'x.timer']) {
    assert.throws(() => renderUserService({ ...options, name }), /Service name/);
  }
  assert.throws(() => renderUserService({ ...options, name: 'x'.repeat(248) + '.service' }), /Service name/);
  for (const nodePath of ['/node"quote', "/node'apostrophe", '/node\\slash']) {
    assert.throws(() => renderUserService({ ...options, nodePath }), /quotes or backslashes/);
  }
  assert.throws(() => renderUserService({ ...options, loaderPath: '/loader\\slash.mjs' }), /ES module path/);
  assert.throws(() => renderUserService({ ...options, entryPath: '/entry\\slash.ts' }), /ES module path/);
  assert.throws(() => renderUserService({ ...options, poolHome: '/pool/' + 'x'.repeat(100) }), /socket path exceeds/);
  assert.equal(userUnitDirectory({ XDG_CONFIG_HOME: '/tmp/custom-config' }), '/tmp/custom-config/systemd/user');
  assert.throws(() => userUnitDirectory({ XDG_CONFIG_HOME: 'relative' }), /absolute path/);
});

test('compiled runtime units execute the daemon directly without a TypeScript loader', () => {
  const options = { ...defaultUserServiceOptions(), loaderPath: '', entryPath: '/installed/runtime/daemon.mjs' };
  const unit = renderUserService(options);
  assert.ok(unit.includes(`ExecStart=:"${process.execPath}" "/installed/runtime/daemon.mjs"\n`));
  assert.doesNotMatch(unit, /--import/);
});

test('systemd-analyze verifies defaults and actually parses spaces, percent, dollars, quotes, backslashes, Unicode and trailing spaces', async t => {
  if (spawnSync('systemd-analyze', ['--version']).error) { t.skip('systemd-analyze is not installed'); return; }
  const { root, options } = await fixture(t);
  const unitPath = join(root, options.name);
  await writeFile(unitPath, renderUserService(options));
  const env = { ...process.env, SYSTEMD_UNIT_PATH: `${root}:/usr/lib/systemd/user:/lib/systemd/user` };
  await run('systemd-analyze', ['verify', '--user', '--generators=no', unitPath], { env });

  const workingDirectory = join(root, 'work %Q $VALUE "quote" \\slash 你好 ');
  const poolHome = join(root, 'p %Q $VALUE " \\ ');
  await mkdir(workingDirectory);
  const nodePath = join(root, 'node $VALUE %Q space');
  await symlink(options.nodePath, nodePath);
  const moduleDirectory = join(root, 'modules %Q $VALUE " 你好');
  await mkdir(moduleDirectory);
  const loaderPath = join(moduleDirectory, 'loader %Q $VALUE " # ?.mjs');
  const entryPath = join(moduleDirectory, 'entry %Q $VALUE " # ?.ts');
  await symlink(options.loaderPath, loaderPath);
  await symlink(options.entryPath, entryPath);
  const special = { ...options, nodePath, loaderPath, entryPath, workingDirectory, poolHome };
  const unit = renderUserService(special);
  assert.ok(unit.includes('WorkingDirectory=' + workingDirectory.replaceAll('%', '%%') + '/.\n'));
  assert.ok(unit.includes('file:///'));
  assert.ok(unit.includes('%%20'));
  assert.ok(unit.includes('%%23'));
  assert.ok(unit.includes('%%3F'));
  assert.ok(unit.includes('$VALUE'));
  assert.doesNotMatch(unit, /\$\$VALUE/);
  await writeFile(unitPath, unit);
  const checked = await run('systemd-analyze', ['verify', '--user', '--generators=no', unitPath], { env: { ...env, SYSTEMD_LOG_LEVEL: 'debug' } });
  const parsed = checked.stdout + checked.stderr;
  assert.ok(parsed.includes('WorkingDirectory: ' + workingDirectory + '\n'), 'systemd must preserve the exact working directory');
  assert.ok(parsed.includes('ZCODE_POOL_HOME=' + poolHome), 'systemd must preserve the literal pool path');
  assert.ok(parsed.includes(pathToFileURL(loaderPath).href.replaceAll('$', '\\$')), 'systemd must unescape percent exactly once in the loader URL');
  // The URL passed to Node must resolve the loader even with URL-reserved path characters.
  const loaded = await run(nodePath, ['--import', pathToFileURL(loaderPath).href, '--input-type=module', '--eval', 'console.log("loader-ready")'], { cwd: workingDirectory });
  assert.equal(loaded.stdout.trim(), 'loader-ready');
});

test('install writes a private unit atomically, refuses overwrite, and replaces only a regular file when requested', async t => {
  const { root, options } = await fixture(t);
  const destination = join(root, 'user-units');
  const installed = await installUserService(options, destination);
  assert.equal(installed, join(destination, options.name));
  assert.equal(await readFile(installed, 'utf8'), renderUserService(options));
  assert.equal((await stat(installed)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(destination), [options.name]);
  const replacement = { ...options, poolHome: join(root, 'other-pool') };
  await assert.rejects(installUserService(replacement, destination), { code: 'EEXIST' });
  assert.equal(await readFile(installed, 'utf8'), renderUserService(options));
  await installUserService(replacement, destination, { replace: true });
  assert.equal(await readFile(installed, 'utf8'), renderUserService(replacement));
  assert.deepEqual(await readdir(destination), [options.name]);

  const external = join(root, 'external');
  await writeFile(external, 'external service');
  const aliasOptions = { ...options, name: 'alias.service' };
  await symlink(external, join(destination, aliasOptions.name));
  await assert.rejects(installUserService(aliasOptions, destination, { replace: true }), /symlink or non-regular/);
  assert.equal(await readFile(external, 'utf8'), 'external service');
  assert.deepEqual((await readdir(destination)).sort(), ['alias.service', options.name].sort());
  const longName = { ...options, name: 'x'.repeat(247) + '.service' };
  assert.equal(await installUserService(longName, destination), join(destination, longName.name));
  assert.equal(await readFile(join(destination, longName.name), 'utf8'), renderUserService(longName));
});

test('racing installs never overwrite one another and invalid runtime paths create no destination', async t => {
  const { root, options } = await fixture(t);
  const destination = join(root, 'racing-units');
  const second = { ...options, poolHome: join(root, 'second') };
  const results = await Promise.allSettled([installUserService(options, destination), installUserService(second, destination)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'EEXIST').length, 1);
  const winner: UserServiceOptions = results[0]!.status === 'fulfilled' ? options : second;
  assert.equal(await readFile(join(destination, options.name), 'utf8'), renderUserService(winner));
  assert.deepEqual(await readdir(destination), [options.name]);
  const invalidDestination = join(root, 'invalid-units');
  await assert.rejects(installUserService({ ...options, loaderPath: join(root, 'missing-loader') }, invalidDestination), { code: 'ENOENT' });
  await assert.rejects(stat(invalidDestination), { code: 'ENOENT' });
});

test('CLI generates and installs from an unrelated directory using a temporary XDG configuration', async t => {
  const { root } = await fixture(t);
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), ZCODE_POOL_HOME: join(root, 'pool') };
  const generated = await run(process.execPath, ['--import', loader, cli, 'service-generate'], { cwd: root, env });
  assert.match(generated.stdout, /^\[Unit\]/);
  assert.ok(generated.stdout.includes(fileURLToPath(new URL('../../src/daemon/main.ts', import.meta.url))));
  await assert.rejects(stat(join(root, 'pool')), { code: 'ENOENT' });
  const installed = await run(process.execPath, ['--import', loader, cli, 'service-install', '--name', 'test-pool.service'], { cwd: root, env });
  const unitPath = join(root, 'config', 'systemd', 'user', 'test-pool.service');
  assert.ok(installed.stdout.includes(`Installed ${unitPath}`));
  assert.equal(await readFile(unitPath, 'utf8'), generated.stdout);
  assert.deepEqual(await readdir(join(root, 'config', 'systemd', 'user')), ['test-pool.service']);
  const explicit = await run(process.execPath, ['--import', loader, cli, 'service-install', '--unit-dir', 'elsewhere', '--pool-home', 'relative-pool'], { cwd: root, env });
  assert.ok(explicit.stdout.includes(join(root, 'elsewhere', 'zcode-pool.service')));
  const explicitUnit = await readFile(join(root, 'elsewhere', 'zcode-pool.service'), 'utf8');
  assert.ok(explicitUnit.includes(`ZCODE_POOL_HOME=${join(root, 'relative-pool')}`));
});

test('CLI rejects ambiguous and unknown service flags before writing a unit', async t => {
  const { root } = await fixture(t);
  const env = { ...process.env, XDG_CONFIG_HOME: join(root, 'config'), ZCODE_POOL_HOME: join(root, 'pool') };
  for (const args of [['--name'], ['--replace'], ['--unknown', 'value'], ['constructor', 'value'], ['--name', 'a.service', '--name', 'b.service'], ['--name', '../outside.service']]) {
    await assert.rejects(run(process.execPath, ['--import', loader, cli, 'service-generate', ...args], { cwd: root, env }));
  }
  await assert.rejects(stat(join(root, 'config')), { code: 'ENOENT' });
});

test('daemon-start uses absolute loader and entry paths from an unrelated working directory', { timeout: 15_000 }, async t => {
  const { root } = await fixture(t);
  const pool = join(root, 'pool');
  const lock = join(pool, 'scheduler', 'daemon.lock');
  const env = { ...process.env, ZCODE_POOL_HOME: pool };
  try {
    const started = await run(process.execPath, ['--import', loader, cli, 'daemon-start'], { cwd: root, env });
    assert.equal(started.stdout.trim(), 'Daemon ready');
    const again = await run(process.execPath, ['--import', loader, cli, 'daemon-start'], { cwd: root, env });
    assert.equal(again.stdout.trim(), 'Daemon already ready');
    assert.deepEqual((await rpcCall<{ tasks: unknown[] }>('overview', {}, { root: pool })).tasks, []);
  } finally {
    await rpcCall('daemon_stop', {}, { root: pool, timeoutMs: 1_000 }).catch(() => {});
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await stat(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await assert.rejects(stat(lock), { code: 'ENOENT' });
  }
});
