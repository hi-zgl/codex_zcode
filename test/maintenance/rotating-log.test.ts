import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, writeSync } from 'node:fs';
import { link, mkdtemp, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingLog, workerLogWriter } from '../../src/shared/rotating-log.js';

test('managed writes bound oversized chunks and retain only the newest three bounded backups', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-log-'));
  const path = join(root, 'server.log');
  const log = new RotatingLog(path, { maxBytes: 16, backups: 3 });
  try {
    const content = '0123456789abcdef'.repeat(7) + 'newest';
    log.write(content);
    log.close();
    assert.deepEqual((await readdir(root)).sort(), ['server.log', 'server.log.1', 'server.log.2', 'server.log.3']);
    const ordered = ['server.log.3', 'server.log.2', 'server.log.1', 'server.log'];
    let saved = '';
    for (const name of ordered) {
      const file = join(root, name), info = await stat(file);
      assert.ok(info.size <= 16);
      assert.equal(info.mode & 0o777, 0o600);
      saved += await readFile(file, 'utf8');
    }
    assert.equal(saved, content.slice(-(16 * 3 + 6)));
  } finally { log.close(); await rm(root, { recursive: true, force: true }); }
});

test('copy/truncate preserves an inherited append FD and bounds oversized existing diagnostic history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-fd-log-'));
  const path = join(root, 'daemon.log');
  await writeFile(path, 'old bytes to discard;newestdiagnostic', { mode: 0o600 });
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
  const inode = fstatSync(fd).ino;
  const log = new RotatingLog(path, { maxBytes: 16, backups: 3 });
  try {
    assert.equal(log.matchesDescriptor(fd), true);
    assert.equal(log.rotateIfNeeded(), true);
    assert.equal((await stat(path)).ino, inode);
    assert.equal(await readFile(`${path}.1`, 'utf8'), 'newestdiagnostic');
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write("after rotation")'], { stdio: ['ignore', fd, fd] });
    assert.equal(child.status, 0);
    assert.equal(await readFile(path, 'utf8'), 'after rotation');
    for (let index = 0; index < 5; index++) { writeSync(fd, '0123456789abcdef'); assert.equal(log.rotateIfNeeded(), true); }
    assert.equal((await stat(path)).ino, inode);
    assert.equal(fstatSync(fd).ino, inode);
    assert.deepEqual((await readdir(root)).sort(), ['daemon.log', 'daemon.log.1', 'daemon.log.2', 'daemon.log.3']);
    for (const name of await readdir(root)) assert.ok((await stat(join(root, name))).size <= 16);
  } finally { closeSync(fd); log.close(); await rm(root, { recursive: true, force: true }); }
});

test('unsafe destinations are preserved and a Worker log failure is reported once without escaping writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zp-log-error-'));
  try {
    const outside = join(root, 'preserved');
    await writeFile(outside, 'keep');
    await symlink(outside, join(root, 'link.log'));
    assert.throws(() => new RotatingLog(join(root, 'link.log')), /Unsafe/);
    await link(outside, join(root, 'hard.log'));
    assert.throws(() => new RotatingLog(join(root, 'hard.log')), /Unsafe/);
    const path = join(root, 'server.log');
    const log = new RotatingLog(path, { maxBytes: 4 });
    log.write('full');
    await symlink(outside, `${path}.1`);
    assert.throws(() => log.write('more'), /Unsafe/);
    assert.equal(await readFile(path, 'utf8'), 'full');
    log.close();
    let failures = 0;
    const worker = workerLogWriter(join(root, 'worker.log'), () => { failures++; throw new Error('diagnostic callback also failed'); });
    await unlink(join(root, 'worker.log'));
    await symlink(outside, join(root, 'worker.log'));
    assert.doesNotThrow(() => { worker.write('first'); worker.write('second'); worker.close(); });
    assert.equal(failures, 1);
    assert.equal(await readFile(outside, 'utf8'), 'keep');
  } finally { await rm(root, { recursive: true, force: true }); }
});
