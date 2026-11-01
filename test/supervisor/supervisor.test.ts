import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountVault, decryptCredential, loadAccountExports, writePrivateJson } from '../../src/accounts/index.js';
import { injectAccount, initializeMachineIdentity, processMatchesOwnership, readProcessIdentity, verifyInjectedIdentity, WorkerSupervisor } from '../../src/supervisor/index.js';

async function accountAt(root: string) {
  const file = join(root, 'export.json');
  await writeFile(file, JSON.stringify([{ provider: 'zai', user_id: 'u1', auth_mode: 'oauth', access_token: 'test-oauth', zcode_jwt_token: 'test-zcode', refresh_token: 'test-refresh', user_info_raw: { id: 'u1' } }]));
  return (await loadAccountExports([file])).accounts[0]!;
}

test('headless initialization preserves one existing machine ID across isolated workers without changing its source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-machine-'));
  try {
    const source = join(root, 'machine.json');
    const content = JSON.stringify({ deviceMid: 'existing-machine-id', lastDailyActiveDate: '2026-11-01' });
    await writeFile(source, content);
    for (const worker of ['a', 'b']) {
      assert.equal(await initializeMachineIdentity(join(root, worker), source), true);
      assert.deepEqual(JSON.parse(await readFile(join(root, worker, 'data/.zcode/v2/telemetry-state.json'), 'utf8')), { deviceMid: 'existing-machine-id' });
    }
    assert.equal(await readFile(source, 'utf8'), content);
    assert.equal(await initializeMachineIdentity(join(root, 'missing'), join(root, 'absent')), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('injection uses an explicit shared key, isolated v2 paths and only the selected Start Plan provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-inject-'));
  try {
    const account = await accountAt(root);
    const worker = join(root, 'worker');
    const identity = await injectAccount(worker, account, 'test-secret');
    assert.equal(identity.matched, true);
    assert.equal(identity.credentialValidity, 'unknown');
    const path = join(worker, 'data/.zcode/v2/credentials.json');
    const values = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(decryptCredential(values['oauth:active_provider'], 'test-secret'), 'zai');
    assert.equal(decryptCredential(values['oauth:zai:refresh_token'], 'test-secret'), 'test-refresh');
    assert.equal(Object.keys(values).some(key => key.includes('bigmodel')), false);
    assert.equal(JSON.stringify(values).includes('test-oauth'), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const settings = JSON.parse(await readFile(join(worker, 'data/.zcode/v2/setting.json'), 'utf8'));
    assert.deepEqual(settings.providerFamilyConnectionSelections, { zai: { kind: 'start-plan' } });
    values['oauth:zai:access_token'] = values.zcodejwttoken;
    await writeFile(path, JSON.stringify(values));
    await assert.rejects(verifyInjectedIdentity(worker, account, 'test-secret'), /do not match/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker paths reject traversal, symlink escapes and Unix sockets beyond the platform limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-path-'));
  try {
    const supervisor = new WorkerSupervisor({ poolRoot: root });
    assert.throws(() => supervisor.workerRoot('../bad'), /Invalid worker ID/);
    const account = await accountAt(root);
    await mkdir(join(root, 'workers'));
    await symlink(tmpdir(), join(root, 'workers', 'escape'));
    await assert.rejects(supervisor.start({ workerId: 'escape', account }), /symlink/);
    const longRoot = join(root, 'x'.repeat(90));
    await assert.rejects(new WorkerSupervisor({ poolRoot: longRoot }).start({ workerId: 'a', account }), /socket path exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stop refuses a live foreign process and process ownership includes birth time and exact launch marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-owner-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  await new Promise<void>((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', reject); });
  try {
    const processInfo = (await readProcessIdentity(child.pid!))!;
    const serverRoot = join(root, 'workers/a/data/.zcode/server');
    const record = { schemaVersion: 1 as const, workerId: 'a', accountAlias: 'account-123456789abc', provider: 'zai' as const, serverRoot, pid: child.pid!, processStartTicks: processInfo.startTicks, ownershipMarker: 'not-its-marker', startedAt: Date.now(), cliPath: '/not-its-cli' };
    await mkdir(join(root, 'workers/a'), { recursive: true });
    await writePrivateJson(join(root, 'workers/a/process.json'), record);
    const supervisor = new WorkerSupervisor({ poolRoot: root });
    assert.equal(processMatchesOwnership(processInfo, record), false);
    assert.equal((await supervisor.status('a')).state, 'identity-mismatch');
    await assert.rejects(supervisor.stop('a', { force: true }), /Refusing to signal/);
    assert.ok(await readProcessIdentity(child.pid!));
    const synthetic = { ...processInfo, command: [process.execPath, '/test/cli', 'serve', '--server-root', serverRoot], env: { ZCODE_SERVER_ROOT: serverRoot, ZCODE_POOL_OWNERSHIP: 'marker' } };
    const matching = { ...record, cliPath: '/test/cli', ownershipMarker: 'marker' };
    assert.equal(processMatchesOwnership(synthetic, matching), true);
    assert.equal(processMatchesOwnership(synthetic, { ...matching, processStartTicks: `${BigInt(matching.processStartTicks) + 1n}` }), false);
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>(done => { if (child.exitCode !== null) done(); else child.once('exit', () => done()); });
    await rm(root, { recursive: true, force: true });
  }
});
