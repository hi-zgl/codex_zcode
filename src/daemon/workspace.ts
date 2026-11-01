import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureFileManifest } from './artifacts.js';
const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], {maxBuffer: 16 * 1024 * 1024, timeout: 30_000})).stdout;
}
export async function createWorkspace(root: string, repository: string, baseRef: string) {
  const repo = (await git(resolve(repository), ['rev-parse', '--show-toplevel'])).trim();
  if ((await git(repo, ['status', '--porcelain'])).trim()) throw new Error('Repository has uncommitted changes; commit or stash before creating a workspace');
  if (!baseRef || baseRef.startsWith('-')) throw new Error('Invalid base reference');
  const baseCommit = (await git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
  const workspaceId = randomUUID();
  const branch = `zcode-pool/${workspaceId}`;
  const worktreePath = join(root, 'workspaces', workspaceId);
  await mkdir(join(root, 'workspaces'), {recursive: true, mode:0o700});
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
  return {workspaceId, repositoryPath:repo, worktreePath, branch, baseCommit};
}
export interface WorkspaceRef {worktreePath:string; baseCommit:string}
// Snapshot before the next task gets a lease; files are immutable, keyed by task + digest.
export async function snapshotWorkspace(root: string, taskId: string, ws: WorkspaceRef) {
  const head = (await git(ws.worktreePath, ['rev-parse','HEAD'])).trim();
  const status = await git(ws.worktreePath, ['status','--porcelain=v1','-z']);
  const diff = await git(ws.worktreePath, ['diff','--binary', ws.baseCommit, '--']);
  const captured = await captureFileManifest(root,taskId,ws,Buffer.from(diff));
  const files=captured.manifest.files.filter(f=>f.change==='untracked'&&f.final.state==='available').map(f=>({path:f.relativePath??f.displayPath,sha256:f.final.sha256!,artifact:f.final.blob!}));
  return {baseCommit:ws.baseCommit,head,status,changedFiles:captured.manifest.files.map(f=>f.relativePath??f.displayPath),untracked:files,...captured};
}
