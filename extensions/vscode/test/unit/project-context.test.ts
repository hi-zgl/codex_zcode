import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectChoices,resolvePreferredRepositoryId, type RegisteredProjectWorkspace } from '../../src/host/project-context.js';

const projects: RegisteredProjectWorkspace[] = [
  { workspaceId: 'a-task-2', repositoryPath: '/projects/a', worktreePath: '/pool/worktrees/a-two' },
  { workspaceId: 'a-task-1', repositoryPath: '/projects/a/', worktreePath: '/pool/worktrees/a-one' },
  { workspaceId: 'b-task', repositoryPath: '/projects/b', worktreePath: '/pool/worktrees/b' },
];
test('active source file selects its registered project in a multi-root window', () => {
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/projects/a', '/projects/b'], activeFilePath: '/projects/b/src/main.ts' }, projects), 'b-task');
});
test('active execution worktree maps back to the source project with a deterministic representative', () => {
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/pool/worktrees/a-two', '/projects/b'], activeFilePath: '/pool/worktrees/a-two/src/main.ts' }, projects), 'a-task-1');
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: [], activeFilePath: '/projects/a/src/../README.md' }, [...projects].reverse()), 'a-task-1');
});
test('single root defaults only when exactly one registered repository is represented', () => {
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/projects/a/'] }, projects), 'a-task-1');
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/pool/worktrees/b'] }, projects), 'b-task');
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/projects/a/src'] }, projects), 'a-task-1');
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/projects'] }, projects), null);
});
test('multi-root without an attributable active file, no roots and unregistered roots use the whole pool', () => {
  for (const context of [{ workspaceFolderPaths: ['/projects/a', '/projects/b'] }, { workspaceFolderPaths: ['/projects/a', '/projects/b'], activeFilePath: '/outside/file.ts' }, { workspaceFolderPaths: [] }, { workspaceFolderPaths: ['/unregistered'] }]) assert.equal(resolvePreferredRepositoryId(context, projects), null);
});
test('path prefixes cannot impersonate a registered source or worktree', () => {
  for (const activeFilePath of ['/projects/ab/file.ts', '/pool/worktrees/b-evil/file.ts']) assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: [], activeFilePath }, projects), null);
});
test('nested registered repositories prefer the most specific active-file match', () => {
  const nested = [...projects, { workspaceId: 'nested', repositoryPath: '/projects/a/packages/nested', worktreePath: '/pool/nested' }];
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/projects/a'], activeFilePath: '/projects/a/packages/nested/src/index.ts' }, nested), 'nested');
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/projects/a'] }, nested), null, 'a single container folder with multiple registered repositories stays ambiguous');
});
test('ambiguous registrations and non-host paths do not guess a repository', () => {
  const conflicting = [...projects, { workspaceId: 'conflict', repositoryPath: '/different/repo', worktreePath: '/pool/worktrees/b' }];
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: [], activeFilePath: '/pool/worktrees/b/file.ts' }, conflicting), null);
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['relative/path'], activeFilePath: 'untitled:Document-1' }, projects), null);
  assert.equal(resolvePreferredRepositoryId({ workspaceFolderPaths: ['/projects/a\0'] }, projects), null);
});
test('cold work and Host project choices retain identity after preparation and keep source/worktree subfolders with their source',()=>{
  const context={workspaceFolderPaths:['/projects/cold']};
  const cold=projectChoices(context,[],[{repositoryPath:'/projects/cold'}]);assert.equal(cold.length,1);
  const prepared=projectChoices(context,[{workspaceId:'later-workspace',repositoryPath:'/projects/cold',worktreePath:'/pool/cold'}],[]);
  assert.deepEqual(prepared,cold,'creating a workspace cannot invalidate an active project filter');
  assert.deepEqual(projectChoices(context,[],[]),cold,'the Host folder can identify pending work before preparation');
  assert.deepEqual(projectChoices({workspaceFolderPaths:['/projects/a/src','/pool/worktrees/a-two/src']},projects,[]).map(project=>project.repositoryPath),['/projects/a','/projects/b']);
  assert.deepEqual(projectChoices({workspaceFolderPaths:['relative','/bad\0']},[],[]),[]);
});
