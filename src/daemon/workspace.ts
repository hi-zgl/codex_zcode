import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile, chmod, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureFileManifest, loadManifest, readSavedFile } from './artifacts.js';
import type { PersistedTaskResult } from '../core/types.js';
const exec = promisify(execFile);
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], {maxBuffer: 16 * 1024 * 1024, timeout: 30_000})).stdout;
}
export async function createWorkspace(root: string, repository: string, baseRef: string) {
  const repo = (await git(resolve(repository), ['rev-parse', '--show-toplevel'])).trim();
  if (!baseRef || baseRef.startsWith('-')) throw new Error('Invalid base reference');
  let baseCommit = (await git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
  if(baseRef==='HEAD'&&(await git(repo,['status','--porcelain'])).trim())baseCommit=await saveWorkingTree(repo,baseCommit);
  const workspaceId = randomUUID();
  const branch = `zcode-pool/${workspaceId}`;
  const worktreePath = join(root, 'workspaces', workspaceId);
  await mkdir(join(root, 'workspaces'), {recursive: true, mode:0o700});
  await git(repo, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
  await git(repo,['update-ref',`refs/zcode-pool/workspaces/${workspaceId}/base`,baseCommit]);
  return {workspaceId, repositoryPath:repo, worktreePath, branch, baseCommit};
}
export async function cleanupWorkspace(root:string,ws:{workspaceId:string;repositoryPath:string;worktreePath:string;branch:string;baseCommit:string}):Promise<boolean>{
 const owned=resolve(root,'workspaces')+'/';if(!resolve(ws.worktreePath).startsWith(owned)||!ws.branch.startsWith('zcode-pool/'))return false;
 await git(ws.repositoryPath,['update-ref',`refs/zcode-pool/workspaces/${ws.workspaceId}/base`,ws.baseCommit]);
 await git(ws.repositoryPath,['worktree','remove','--force',ws.worktreePath]);
 await git(ws.repositoryPath,['branch','-D',ws.branch]);return true;
}
/** A private index captures dirty files without changing the user's index, files or branch. */
export async function saveWorkingTree(repo:string,parent?:string):Promise<string>{
 const dir=await mkdtemp(join(tmpdir(),'zcode-index-'));
 try{
  const env={...process.env,GIT_INDEX_FILE:join(dir,'index'),GIT_AUTHOR_NAME:'ZCode Pool',GIT_AUTHOR_EMAIL:'zcode@localhost',GIT_COMMITTER_NAME:'ZCode Pool',GIT_COMMITTER_EMAIL:'zcode@localhost'};
  const run=async(args:string[])=>(await exec('git',['-C',repo,...args],{env,maxBuffer:16*1024*1024,timeout:30_000})).stdout.trim();
  const head=parent??await run(['rev-parse','HEAD']);await run(['read-tree',head]);await run(['add','-A','--']);
  const tree=await run(['write-tree']);return run(['commit-tree',tree,'-p',head,'-m','ZCode working tree snapshot']);
 }finally{await rm(dir,{recursive:true,force:true});}
}
/** Materialize exact saved bytes for independent acceptance, never a mutable implementation directory. */
export async function materializeDelivery(root:string,repository:string,taskId:string,result:PersistedTaskResult){
 const loaded=await loadManifest(root,taskId,result);if(!loaded)throw new Error('Delivery has no immutable file manifest');
 const ws=await createWorkspace(root,repository,loaded.document.baseCommit);
 for(const file of loaded.document.files){
  if(!file.relativePath)throw new Error('Delivery contains an unsupported file path');
  const path=await deliveryDestination(ws.worktreePath,file.relativePath),side=file.final;
  await rm(path,{recursive:true,force:true});
  if(side.state==='absent')continue;
  if(side.state!=='available'||!['regular','symlink'].includes(side.kind))throw new Error('Delivery cannot be fully materialized');
  const bytes=await readSavedFile(root,taskId,file,'final');await mkdir(resolve(path,'..'),{recursive:true});
  if(side.kind==='symlink')await symlink(bytes.toString('utf8'),path);else{await writeFile(path,bytes);await chmod(path,side.mode==='100755'?0o755:0o644);}
 }
 return ws;
}
export async function deliveryDestination(root:string,relativePath:string):Promise<string>{
 const parts=relativePath.split('/');if(parts.some(p=>!p||p==='.'||p==='..')||relativePath.includes('\\'))throw new Error('Invalid delivery path');
 let parent=root;for(const part of parts.slice(0,-1)){parent=join(parent,part);let stat;try{stat=await lstat(parent);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(parent);stat=await lstat(parent);}if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Delivery path traverses a symlink or non-directory');}
 return join(root,relativePath);
}
export async function treeCommit(repository:string,tree:string,parent:string):Promise<string>{
 return (await exec('git',['-C',repository,'commit-tree',tree,'-p',parent,'-m','ZCode saved delivery'],{env:{...process.env,GIT_AUTHOR_NAME:'ZCode Pool',GIT_AUTHOR_EMAIL:'zcode@localhost',GIT_COMMITTER_NAME:'ZCode Pool',GIT_COMMITTER_EMAIL:'zcode@localhost'}})).stdout.trim();
}
/** Build an immutable Git version directly from saved bytes without touching any working tree. */
export async function deliveryCommit(root:string,repository:string,taskId:string,result:PersistedTaskResult):Promise<string>{
 const loaded=await loadManifest(root,taskId,result);if(!loaded)throw new Error('Saved delivery manifest is unavailable');
 const dir=await mkdtemp(join(tmpdir(),'zcode-delivery-'));
 try{
  const env={...process.env,GIT_INDEX_FILE:join(dir,'index')};
  const run=async(args:string[])=>(await exec('git',['-C',repository,...args],{env,maxBuffer:16*1024*1024,timeout:30_000})).stdout.trim();
  await run(['read-tree',loaded.document.baseCommit]);
  for(const file of loaded.document.files){
   if(!file.relativePath)throw new Error('Unsupported saved file path');
   if(file.final.state==='absent'){await run(['update-index','--force-remove','--',file.relativePath]);continue;}
   if(file.final.state!=='available'||!['regular','symlink'].includes(file.final.kind))throw new Error('Saved delivery is incomplete');
   const blobFile=join(dir,'blob');await writeFile(blobFile,await readSavedFile(root,taskId,file,'final'));const blob=await run(['hash-object','-w',blobFile]);
   await run(['update-index','--add','--cacheinfo',file.final.mode!,blob,file.relativePath]);
  }
  return treeCommit(repository,await run(['write-tree']),loaded.document.baseCommit);
 }finally{await rm(dir,{recursive:true,force:true});}
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
