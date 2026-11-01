import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFileManifest, loadManifest, readSavedFile } from '../../src/daemon/artifacts.js';
import { git } from '../../src/daemon/workspace.js';
import type { PersistedTaskResult } from '../../src/core/types.js';
import { UiRpcError } from '../../src/daemon/ui-support.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'zp-art-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, 'repo'); const pool = join(root, 'pool');
  await mkdir(repository);
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Fixture']);
  await git(repository, ['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(repository, 'tracked.txt'), 'base\n');
  await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'base']);
  const baseCommit = (await git(repository, ['rev-parse', 'HEAD'])).trim();
  await writeFile(join(repository, 'tracked.txt'), 'captured final\n');
  const ws = { worktreePath: repository, baseCommit };
  const capture = async (id = 'task-adversarial') => {
    const captured = await captureFileManifest(pool, id, ws, Buffer.from('fixture patch'));
    const result: PersistedTaskResult = { taskId: id, createdAt: Date.now(), summary: '', changedFiles: [], verification: [], blockers: [], artifacts: [captured.manifestArtifact, ...captured.snapshotArtifacts] };
    return { ...captured, result, id };
  };
  return { root, pool, repository, capture };
}
function kind(expected: string) {
  return (error: unknown) => error instanceof UiRpcError && error.data?.kind === expected;
}

test('UI artifact bytes preserve non-UTF8 symlink targets and record unsupported Git path encodings', async t => {
  const f = await fixture(t);
  const target = Buffer.from([0x2e, 0x2f, 0xff, 0x66]);
  await symlink(target, join(f.repository, 'raw-link'));
  const invalidPath = Buffer.concat([Buffer.from(f.repository + '/'), Buffer.from([0x66, 0xff])]);
  await writeFile(invalidPath, 'not silently renamed');
  const c = await f.capture();
  const link = c.manifest.files.find(file => file.relativePath === 'raw-link')!;
  assert.equal(link.final.kind, 'symlink');
  assert.equal(link.final.encoding, 'binary');
  assert.deepEqual(await readSavedFile(f.pool, c.id, link, 'final'), target);
  const invalid = c.manifest.files.find(file => file.relativePath === null)!;
  assert.equal(invalid.final.state, 'unavailable');
  assert.equal(invalid.final.reason, 'unsupported_path_encoding');
  assert.equal(invalid.nativeDiff.available, false);
  assert.match(invalid.displayPath, /\\xff/);
});

test('UI artifacts reject leaf symlinks and corrupted saved bytes instead of reading the live worktree', async t => {
  const f = await fixture(t); const c = await f.capture();
  const loaded = await loadManifest(f.pool, c.id, c.result);
  assert.ok(loaded);
  const file = loaded.document.files.find(item => item.relativePath === 'tracked.txt')!;
  await writeFile(join(f.repository, 'tracked.txt'), 'later mutable content\n');
  assert.equal((await readSavedFile(f.pool, c.id, file, 'base')).toString(), 'base\n');
  assert.equal((await readSavedFile(f.pool, c.id, file, 'final')).toString(), 'captured final\n');
  const blob = join(f.pool, 'scheduler', 'artifacts', c.id, file.final.blob!);
  const outside = join(f.root, 'outside'); await writeFile(outside, 'outside-secret-canary');
  await unlink(blob); await symlink(outside, blob);
  await assert.rejects(readSavedFile(f.pool, c.id, file, 'final'), kind('PATH_REJECTED'));
  await unlink(blob); await writeFile(blob, 'corrupted');
  await assert.rejects(readSavedFile(f.pool, c.id, file, 'final'), kind('INTEGRITY_MISMATCH'));
  assert.equal(await readFile(outside, 'utf8'), 'outside-secret-canary');
});

test('UI artifact readers reject replaced ancestor directories and cross-task manifest references', async t => {
  const f = await fixture(t); const c = await f.capture();
  const second = await f.capture('task-other');
  await assert.rejects(loadManifest(f.pool, second.id, { ...second.result, artifacts: c.result.artifacts }), kind('PATH_REJECTED'));
  const taskDir = join(f.pool, 'scheduler', 'artifacts', c.id);
  const moved = join(f.root, 'moved'); await rename(taskDir, moved); await symlink(moved, taskDir);
  await assert.rejects(loadManifest(f.pool, c.id, c.result), kind('PATH_REJECTED'));
  await unlink(taskDir); await rename(moved, taskDir);
  const artifacts = join(f.pool, 'scheduler', 'artifacts');
  const movedArtifacts = join(f.root, 'all-artifacts'); await rename(artifacts, movedArtifacts); await symlink(movedArtifacts, artifacts);
  await assert.rejects(loadManifest(f.pool, c.id, c.result), kind('PATH_REJECTED'));
  await unlink(artifacts); await rename(movedArtifacts, artifacts);
  const scheduler = join(f.pool, 'scheduler'); const movedScheduler = join(f.root, 'scheduler');
  await rename(scheduler, movedScheduler); await symlink(movedScheduler, scheduler);
  await assert.rejects(loadManifest(f.pool, c.id, c.result), kind('PATH_REJECTED'));
});
