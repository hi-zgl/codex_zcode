import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, snapshotWorkspace, git } from '../../src/daemon/workspace.js';

test('worktree snapshot covers commits, staged/unstaged changes and untracked files immutably', async () => {
 const root = await mkdtemp(join(tmpdir(),'zpool-git-'));
 try {
  await git(root,['init','-b','main']);
  await git(root,['config','user.email','fixture@example.invalid']);
  await git(root,['config','user.name','Fixture']);
  await writeFile(join(root,'tracked.txt'),'base\n'); await git(root,['add','.']); await git(root,['commit','-m','base']);
  const ws=await createWorkspace(join(root,'pool'),root,'main');
  await writeFile(join(ws.worktreePath,'tracked.txt'),'committed\n'); await git(ws.worktreePath,['commit','-am','worker']);
  await writeFile(join(ws.worktreePath,'staged.txt'),'staged\n');await git(ws.worktreePath,['add','staged.txt']);
  await writeFile(join(ws.worktreePath,'tracked.txt'),'unstaged\n');
  await writeFile(join(ws.worktreePath,'untracked.txt'),'untracked\n');
  const snap=await snapshotWorkspace(join(root,'pool'),'task-fixture',ws);
  const patch=await readFile(snap.patchFile,'utf8');
  assert.match(patch,/unstaged/); assert.match(patch,/staged/); assert.equal(snap.untracked[0].path,'untracked.txt');
  await writeFile(join(ws.worktreePath,'tracked.txt'),'later task\n');
  assert.equal(await readFile(snap.patchFile,'utf8'),patch);
 } finally {await rm(root,{recursive:true,force:true});}
});
