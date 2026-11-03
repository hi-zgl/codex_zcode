import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { storageStatus } from '../../src/maintenance/storage.js';

test('storage status counts logical bytes by retention class without reading through symlinks or changing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-storage-'));
  const pool = join(root, 'pool');
  const files = {
    'scheduler/daemon.log': 'log', 'scheduler/daemon.log.1': 'backup',
    'scheduler/state.db': 'synthetic database', 'scheduler/state.db-wal': 'synthetic wal',
    'scheduler/artifacts/task/blob': 'fixed delivery', 'workers/a/data/.zcode/cli/db/db.sqlite': 'session',
    'workers/a/logs/server.log': 'worker log', 'workers/a/artifacts/legacy': 'retained legacy',
    'accounts/vault.json': 'synthetic encrypted vault', 'workspaces/a/file': 'worktree',
  };
  try {
    for (const [path, value] of Object.entries(files)) { await mkdir(dirname(join(pool, path)), { recursive: true }); await writeFile(join(pool, path), value); }
    const outside = join(root, 'outside');
    await mkdir(outside); await writeFile(join(outside, 'large'), 'x'.repeat(1024));
    await symlink(outside, join(pool, 'scheduler/artifacts/linked'));
    const status = storageStatus(pool);
    assert.equal(status.measurement, 'logical_regular_file_bytes');
    assert.equal(status.logicalBytes, Object.values(files).reduce((sum, value) => sum + Buffer.byteLength(value), 0));
    assert.equal(status.files, Object.keys(files).length);
    assert.equal(status.categories.managed_logs.logicalBytes, Buffer.byteLength('logbackupworker log'));
    assert.equal(status.categories.deliveries.logicalBytes, Buffer.byteLength('fixed delivery'));
    assert.equal(status.categories.worker_data.logicalBytes, Buffer.byteLength('session'));
    assert.equal(status.categories.accounts.logicalBytes, Buffer.byteLength('synthetic encrypted vault'));
    assert.equal(status.skippedSymlinks, 1);
    assert.equal(status.complete, false);
    assert.match(status.categories.deliveries.retention, /indefinitely/);
    for (const [path, value] of Object.entries(files)) assert.equal(await readFile(join(pool, path), 'utf8'), value);
    const absent = join(root, 'absent');
    assert.equal(storageStatus(absent).exists, false);
    assert.deepEqual((await readdir(root)).sort(), ['outside', 'pool']);
    assert.equal(storageStatus(join(pool, 'scheduler/artifacts/linked')).logicalBytes, 0, 'even a selected root symlink is not followed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI storage-status works without a daemon and creates no pool data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-storage-cli-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, ZCODE_POOL_HOME: join(root, 'absent') };
    delete env.ZCODE_POOL_CONNECTION_FILE;
    const { stdout } = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url)), 'storage-status'], { env });
    const status = JSON.parse(stdout);
    assert.equal(status.exists, false);
    assert.equal(status.logicalBytes, 0);
    assert.equal(status.managedLogPolicy.backups, 3);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
