import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, lstat, readlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
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
  const changedFiles = (await git(ws.worktreePath, ['diff','--name-only','-z',ws.baseCommit,'--'])).split('\0').filter(Boolean);
  const untracked = (await git(ws.worktreePath, ['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean);
  const dir = join(root, 'scheduler', 'artifacts', taskId);
  await mkdir(dir, {recursive: true, mode: 0o700});
  const files: {path:string; sha256:string; artifact:string}[] = [];
  for (const path of untracked) {
    const filePath = join(ws.worktreePath, path);
    const stat = await lstat(filePath);
    const data = stat.isSymbolicLink() ? Buffer.from(await readlink(filePath)) : await readFile(filePath);
    const sha256 = createHash('sha256').update(data).digest('hex');
    await writeFile(join(dir, sha256), data, {flag:'wx', mode:0o600}).catch(error => {if (error.code !== 'EEXIST') throw error;});
    files.push({path,sha256,artifact:sha256});
  }
  const digest = createHash('sha256').update(diff).digest('hex');
  await writeFile(join(dir, `${digest}.patch`), diff, {flag:'wx',mode:0o600}).catch(error => {if(error.code !== 'EEXIST') throw error;});
  return {baseCommit:ws.baseCommit, head, status, changedFiles:[...new Set([...changedFiles,...untracked])], patchFile:join(dir, `${digest}.patch`), untracked:files};
}
