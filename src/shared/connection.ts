import { lstat, readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface ConnectionProfile {schemaVersion:1;poolHome:string}
function validPath(value:unknown):value is string{return typeof value==='string'&&isAbsolute(value)&&!value.includes('\0');}
async function loadConnectionProfile(path:string,allowInvalidContent:boolean):Promise<ConnectionProfile|null>{
  if(!validPath(path))throw new Error('Connection profile requires an absolute path');
  let info;try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!info.isFile())throw new Error('Invalid connection profile file');
  if(info.size>16384){if(allowInvalidContent)return null;throw new Error('Invalid connection profile file');}
  const content=await readFile(path,'utf8');
  let value:unknown;
  try{value=JSON.parse(content);}catch(error){if(allowInvalidContent&&error instanceof SyntaxError)return null;throw error;}
  if(!value||typeof value!=='object'||(value as ConnectionProfile).schemaVersion!==1||!validPath((value as ConnectionProfile).poolHome)){
    if(allowInvalidContent)return null;throw new Error('Invalid connection profile');
  }
  return {schemaVersion:1,poolHome:resolve((value as ConnectionProfile).poolHome)};
}
export async function readConnectionProfile(path:string):Promise<ConnectionProfile|null>{
  return loadConnectionProfile(path,false);
}
export async function writeConnectionProfile(path:string,poolHome:string,isCurrent:()=>boolean=()=>true):Promise<void>{
  if(!validPath(path)||!validPath(poolHome))throw new Error('Connection paths must be absolute');
  const value:ConnectionProfile={schemaVersion:1,poolHome:resolve(poolHome)};
  // Explicit saves may repair invalid ordinary files; reads remain strict and
  // filesystem failures, symlinks and other non-regular paths are never ignored.
  const previous=await loadConnectionProfile(path,true);
  const checkCurrent=()=>{if(!isCurrent())throw new Error('Connection profile write is stale');};
  if(previous?.poolHome===value.poolHome){checkCurrent();return;}
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${randomUUID()}.tmp`;
  try{await writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});checkCurrent();await rename(temporary,path);}finally{await rm(temporary,{force:true});}
}
/** A configured profile is authoritative; missing/corrupt profiles never fall back. */
export async function connectionPoolRoot(env:NodeJS.ProcessEnv=process.env):Promise<string>{
  if(env.ZCODE_POOL_CONNECTION_FILE!==undefined){const profile=await readConnectionProfile(env.ZCODE_POOL_CONNECTION_FILE);if(!profile)throw new Error('Configured connection profile is missing');return profile.poolHome;}
  return resolve(env.ZCODE_POOL_HOME??join(homedir(),'.zcode_pool'));
}
