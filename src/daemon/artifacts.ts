import {constants} from 'node:fs';
import {chmod,lstat,mkdir,open,readFile,readlink,realpath,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {z} from 'zod';
import type {ArtifactMetadata,PersistedTaskResult} from '../core/types.js';
import {uiArtifactFileSchema,type UiArtifactFile,type UiArtifactManifest,type UiFileSide} from '../shared/ui-contract.js';
import {canonicalJson,digest,UiRpcError} from './ui-support.js';

const exec=promisify(execFile);
const FILE_LIMIT=64*1024*1024,TASK_LIMIT=256*1024*1024;
const sideSchema=uiArtifactFileSchema.shape.base.extend({blob:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict();
const storedFileSchema=uiArtifactFileSchema.extend({base:sideSchema,final:sideSchema}).strict();
const manifestSchema=z.object({schemaVersion:z.literal(1),taskId:z.string(),baseCommit:z.string(),scope:z.literal('workspace_base_cumulative'),sourceScope:z.literal('git_tracked_plus_nonignored_untracked'),
 captureStartedAtMs:z.number().int(),captureCompletedAtMs:z.number().int(),consistency:z.literal('lease_held_non_atomic'),
 patch:z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),sizeBytes:z.number().int().nonnegative(),blob:z.string().regex(/^[a-f0-9]{64}\.patch$/)}).strict(),files:z.array(storedFileSchema)}).strict();
export type StoredManifest=z.infer<typeof manifestSchema>;
type StoredSide=z.infer<typeof sideSchema>;
async function gitBytes(cwd:string,args:string[],maxBuffer=TASK_LIMIT):Promise<Buffer>{return (await exec('git',['-C',cwd,...args],{encoding:'buffer',maxBuffer,timeout:30_000})).stdout;}
function safeTask(taskId:string){if(!taskId||taskId.includes('\0')||taskId.includes('/')||taskId.includes('\\')||taskId==='.'||taskId==='..')throw new UiRpcError('PATH_REJECTED');}
function validRelative(path:string){return path.length>0&&!isAbsolute(path)&&!path.includes('\0')&&!path.split(/[\\/]/).some(p=>p==='..'||p==='.'||p==='');}
function kind(mode:string|null):UiFileSide['kind'] {return mode?.startsWith('100')?'regular':mode==='120000'?'symlink':mode==='160000'?'gitlink':'unknown';}
function side(state:StoredSide['state'],mode:string|null,reason:string|null=null):StoredSide{return {state,reason,kind:kind(mode),mode,sha256:null,sizeBytes:null,encoding:'unknown',blob:null};}
function encoding(data:Buffer):UiFileSide['encoding'] {if(data.includes(0))return 'binary';try{new TextDecoder('utf-8',{fatal:true}).decode(data);return 'utf8';}catch{return 'binary';}}
function same(a:Awaited<ReturnType<typeof lstat>>,b:Awaited<ReturnType<typeof lstat>>){return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;}
async function privateDir(path:string){await mkdir(path,{recursive:true,mode:0o700});const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink())throw new UiRpcError('PATH_REJECTED');await chmod(path,0o700);}
async function createArtifactDir(root:string,taskId:string){await privateDir(root);let path=await realpath(root);for(const component of ['scheduler','artifacts',taskId]){path=join(path,component);await privateDir(path);}return path;}
async function blobWrite(dir:string,name:string,data:Buffer){
 const path=join(dir,name);
 try{await writeFile(path,data,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const current=await secureRead(dir,name);if(!current.equals(data))throw new UiRpcError('INTEGRITY_MISMATCH');}
 return path;
}
/** Reject every symlink component and final special file; never resolve a task-supplied path to disk. */
async function checkedDir(root:string,taskId:string):Promise<string>{
 safeTask(taskId);let parent=await realpath(root);
 for(const component of ['scheduler','artifacts',taskId]){parent=join(parent,component);const stat=await lstat(parent);if(!stat.isDirectory()||stat.isSymbolicLink())throw new UiRpcError('PATH_REJECTED');}
 const actual=await realpath(parent);if(actual!==parent)throw new UiRpcError('PATH_REJECTED');return actual;
}
async function secureRead(dir:string,name:string):Promise<Buffer>{
 if(!/^[a-f0-9]{64}(?:\.patch|\.manifest\.json)?$/.test(name))throw new UiRpcError('PATH_REJECTED');
 const path=join(dir,name);const before=await lstat(path);
 if(!before.isFile()||before.isSymbolicLink())throw new UiRpcError('PATH_REJECTED');
 if(before.size>TASK_LIMIT)throw new UiRpcError('OUTPUT_BUDGET_EXCEEDED');
 const actual=await realpath(path);if(dirname(actual)!==dir)throw new UiRpcError('PATH_REJECTED');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const opened=await file.stat();if(!opened.isFile()||!same(before,opened))throw new UiRpcError('INTEGRITY_MISMATCH');const data=await file.readFile();const after=await file.stat();if(!same(opened,after))throw new UiRpcError('INTEGRITY_MISMATCH');return data;}finally{await file.close();}
}

export async function captureFileManifest(root:string,taskId:string,ws:{worktreePath:string;baseCommit:string},patch:Buffer){
 safeTask(taskId);const started=Date.now();const worktree=await realpath(ws.worktreePath);
 const dir=await createArtifactDir(root,taskId);
 // All paths come from Git NUL-delimited bytes; invalid UTF-8 names retain an escaped metadata entry.
 const raw=await gitBytes(worktree,['diff','--raw','--no-abbrev','--no-renames','-z',ws.baseCommit,'--']);
 const entries:Array<{path:Buffer;baseMode:string;finalMode:string;baseOid:string;change:UiArtifactFile['change']}>=[];
 const parts=raw.subarray().toString('latin1').split('\0');
 for(let i=0;i<parts.length&&parts[i];i+=2){const header=/^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/.exec(parts[i]!);if(!header)throw new UiRpcError('UNSUPPORTED_SCHEMA');entries.push({path:Buffer.from(parts[i+1]??'','latin1'),baseMode:header[1]!,finalMode:header[2]!,baseOid:header[3]!,change:header[5]==='A'?'added':header[5]==='D'?'deleted':header[5]==='T'?'type_changed':'modified'});}
 const untracked=(await gitBytes(worktree,['ls-files','--others','--exclude-standard','-z'])).toString('latin1').split('\0').filter(Boolean);
 entries.push(...untracked.map(path=>({path:Buffer.from(path,'latin1'),baseMode:'000000',finalMode:'100644',baseOid:'',change:'untracked' as const})));
 let total=patch.length;const artifacts=new Map<string,ArtifactMetadata>();
 const save=async(data:Buffer,mode:string):Promise<StoredSide>=>{
  if(data.length>FILE_LIMIT)return side('unavailable',mode,'file_too_large');
  if(total+data.length>TASK_LIMIT)return side('unavailable',mode,'task_capture_limit');
  const sha256=digest(data);total+=data.length;const path=await blobWrite(dir,sha256,data);
  artifacts.set(path,{kind:'snapshot_blob',path,sha256,sizeBytes:data.length,mediaType:'application/octet-stream'});
  return {...side('available',mode),sha256,sizeBytes:data.length,encoding:encoding(data),blob:sha256};
 };
 const files:StoredManifest['files']=[];
 for(const entry of entries){
  let path:string|null=null;try{path=new TextDecoder('utf-8',{fatal:true}).decode(entry.path);}catch{}
  const displayPath=path??Array.from(entry.path,b=>b>=32&&b<=126&&b!==92?String.fromCharCode(b):'\\x'+b.toString(16).padStart(2,'0')).join('');
  const fileId='file-'+digest(entry.path).slice(0,40);let base=side('absent',null),final=side('absent',null);
  const allowed=path!==null&&validRelative(path);
  if(entry.baseMode!=='000000'){
   base=side('unavailable',entry.baseMode,allowed?'capture_failed':path===null?'unsupported_path_encoding':'path_rejected');
   if(allowed&&kind(entry.baseMode)!=='gitlink')try{const size=Number((await gitBytes(worktree,['cat-file','-s',entry.baseOid],1000)).toString('utf8').trim());
    base=size>FILE_LIMIT?{...side('unavailable',entry.baseMode,'file_too_large'),sizeBytes:size}:size+total>TASK_LIMIT?{...side('unavailable',entry.baseMode,'task_capture_limit'),sizeBytes:size}:await save(await gitBytes(worktree,['cat-file','blob',entry.baseOid],FILE_LIMIT+1),entry.baseMode);
   }catch{base=side('unavailable',entry.baseMode,'base_object_unavailable');}
   else if(kind(entry.baseMode)==='gitlink')base={...base,reason:'gitlink_metadata_only',sha256:null};
  }
  if(entry.finalMode!=='000000'){
   final=side('unavailable',entry.finalMode,allowed?'capture_failed':path===null?'unsupported_path_encoding':'path_rejected');
   if(allowed)try{
    const filePath=join(worktree,path!);const parent=await realpath(dirname(filePath));
    const rel=relative(worktree,parent);if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new UiRpcError('PATH_REJECTED');
    const before=await lstat(filePath);const mode=before.isSymbolicLink()?'120000':before.isFile()?(before.mode&0o111?'100755':'100644'):entry.finalMode;
    if(kind(entry.finalMode)==='gitlink')final=side('unavailable','160000','gitlink_metadata_only');
    else if(before.size>FILE_LIMIT)final={...side('unavailable',mode,'file_too_large'),sizeBytes:before.size};
    else if(total+before.size>TASK_LIMIT)final={...side('unavailable',mode,'task_capture_limit'),sizeBytes:before.size};
    else if(before.isSymbolicLink()){
      const data=await readlink(filePath,{encoding:'buffer'});const after=await lstat(filePath);final=same(before,after)?await save(data,mode):side('unavailable',mode,'unstable_capture');
    }else if(before.isFile()){
      const handle=await open(filePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{const opened=await handle.stat();if(!opened.isFile()||!same(before,opened))final=side('unavailable',mode,'unstable_capture');else{const data=await handle.readFile();const after=await handle.stat();const pathAfter=await lstat(filePath);final=same(opened,after)&&same(after,pathAfter)?await save(data,mode):side('unavailable',mode,'unstable_capture');}}finally{await handle.close();}
    }else final=side('unavailable',mode,'unsupported_file_type');
   }catch(e){final=side('unavailable',entry.finalMode,e instanceof UiRpcError?'path_rejected':'capture_failed');}
  }
  const native=allowed&&[base,final].every(s=>s.state==='absent'||s.state==='available'&&s.kind!=='gitlink'&&s.encoding==='utf8'&&(s.sizeBytes??Infinity)<=2*1024*1024);
  if(entry.change==='untracked'&&final.blob){const artifact=artifacts.get(join(dir,final.blob));if(artifact)artifact.kind='untracked';}
  files.push({fileId,relativePath:allowed?path:null,displayPath,basePath:base.state==='absent'?null:path,finalPath:final.state==='absent'?null:path,change:entry.change,base,final,nativeDiff:{available:native,reason:native?null:'side_unavailable_binary_or_large'}});
 }
 files.sort((a,b)=>Buffer.compare(Buffer.from(a.relativePath??a.displayPath),Buffer.from(b.relativePath??b.displayPath))||a.fileId.localeCompare(b.fileId));
 const patchHash=digest(patch);const patchPath=await blobWrite(dir,patchHash+'.patch',patch);
 const document:StoredManifest={schemaVersion:1,taskId,baseCommit:ws.baseCommit,scope:'workspace_base_cumulative',sourceScope:'git_tracked_plus_nonignored_untracked',captureStartedAtMs:started,captureCompletedAtMs:Date.now(),consistency:'lease_held_non_atomic',patch:{sha256:patchHash,sizeBytes:patch.length,blob:patchHash+'.patch'},files};
 const content=Buffer.from(canonicalJson(document));const manifestHash=digest(content);const manifestPath=await blobWrite(dir,manifestHash+'.manifest.json',content);
 const manifestArtifact:ArtifactMetadata={kind:'file_manifest',path:manifestPath,sha256:manifestHash,sizeBytes:content.length,mediaType:'application/json'};
 return {manifestArtifact,snapshotArtifacts:[...artifacts.values()],manifest:document,patchFile:patchPath};
}

export async function loadManifest(root:string,taskId:string,result:PersistedTaskResult|null):Promise<{document:StoredManifest;sha256:string}|null>{
 const artifact=result?.artifacts.find(a=>a.kind==='file_manifest');if(!artifact)return null;
 try{
  if(!/^[a-f0-9]{64}$/.test(artifact.sha256))throw new UiRpcError('INTEGRITY_MISMATCH');
  const dir=await checkedDir(root,taskId);const name=artifact.sha256+'.manifest.json';
  if(resolve(artifact.path)!==join(dir,name))throw new UiRpcError('PATH_REJECTED');
  const data=await secureRead(dir,name);if(data.length!==artifact.sizeBytes||digest(data)!==artifact.sha256)throw new UiRpcError('INTEGRITY_MISMATCH');
  const parsed=manifestSchema.safeParse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)));
  if(!parsed.success||parsed.data.taskId!==taskId||canonicalJson(parsed.data)!==data.toString('utf8'))throw new UiRpcError('INTEGRITY_MISMATCH');
  if(new Set(parsed.data.files.map(f=>f.fileId)).size!==parsed.data.files.length)throw new UiRpcError('INTEGRITY_MISMATCH');
  if(parsed.data.files.some(f=>[f.relativePath,f.basePath,f.finalPath].some(p=>p!==null&&!validRelative(p))))throw new UiRpcError('PATH_REJECTED');
  const patch=result!.artifacts.find(a=>a.kind==='patch');if(patch&&(patch.sha256!==parsed.data.patch.sha256||patch.sizeBytes!==parsed.data.patch.sizeBytes||resolve(patch.path)!==join(dir,parsed.data.patch.blob)))throw new UiRpcError('INTEGRITY_MISMATCH');
  return {document:parsed.data,sha256:artifact.sha256};
 }catch(e){if(e instanceof UiRpcError)throw e;throw new UiRpcError('ARTIFACT_UNAVAILABLE');}
}
export function manifestView(taskId:string,baseCommit:string,result:PersistedTaskResult|null,loaded:{document:StoredManifest;sha256:string}|null):UiArtifactManifest{
 const patch=result?.artifacts.find(a=>a.kind==='patch');const m=loaded?.document;const available=m?.files.filter(f=>[f.base,f.final].every(s=>s.state!=='unavailable')).length??0;
 return {taskId,state:m?'available':patch?'legacy_patch_only':'not_captured',schemaVersion:1,manifestSha256:loaded?.sha256??null,scope:'workspace_base_cumulative',baseCommit:m?.baseCommit??baseCommit,sourceScope:'git_tracked_plus_nonignored_untracked',
 captureStartedAtMs:m?.captureStartedAtMs??null,captureCompletedAtMs:m?.captureCompletedAtMs??null,consistency:m?'lease_held_non_atomic':'legacy_unknown',fileCount:m?.files.length??null,availableFileCount:available,unavailableFileCount:m?m.files.length-available:0,fileListComplete:!!m,
 patch:{available:!!patch,sha256:patch?.sha256??null,sizeBytes:patch?.sizeBytes??null},unavailableReason:m?null:patch?'legacy_file_bytes_not_captured':'snapshot_not_captured'};
}
export function publicArtifactFile(file:StoredManifest['files'][number]):UiArtifactFile {return uiArtifactFileSchema.parse(file);}
export async function readSavedFile(root:string,taskId:string,file:StoredManifest['files'][number],which:'base'|'final'):Promise<Buffer>{
 const selected=file[which];if(selected.state!=='available'||!selected.blob||selected.blob!==selected.sha256)throw new UiRpcError('ARTIFACT_UNAVAILABLE');
 try{const data=await secureRead(await checkedDir(root,taskId),selected.blob);if(data.length!==selected.sizeBytes||digest(data)!==selected.sha256)throw new UiRpcError('INTEGRITY_MISMATCH');return data;}catch(e){if(e instanceof UiRpcError)throw e;throw new UiRpcError('ARTIFACT_UNAVAILABLE');}
}
