import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createManagedDaemonCall } from '../../src/mcp/managed-connection.js';
import { connectionPoolRoot, readConnectionProfile, writeConnectionProfile } from '../../src/shared/connection.js';
import { RpcCallError, type rpcCall } from '../../src/shared/rpc.js';

type CallOptions = NonNullable<Parameters<typeof rpcCall>[2]>;
interface Request {method:string;params:Record<string,unknown>;root:string|undefined}

function injectedCall(handler:(request:Request)=>unknown|Promise<unknown>):typeof rpcCall {
  return async <T>(method:string,params:Record<string,unknown>={},options:CallOptions={}) =>
    await handler({method,params,root:options.root}) as T;
}

function signal() {
  let release!:()=>void;
  const promise=new Promise<void>(resolve=>{release=resolve;});
  return {promise,release};
}

function unavailable(code='ENOENT') {return Object.assign(new Error(`Fixture connect failure: ${code}`),{code});}

async function fixture(t:TestContext) {
  const directory=await mkdtemp(join(tmpdir(),'zpool-managed-'));
  const profile=join(directory,'connection.json'),poolA=join(directory,'pool-a'),poolB=join(directory,'pool-b');
  const cli=join(directory,'runtime','cli.mjs');
  // Every potential root is temporary. Injected calls never open sockets or spawn a process.
  const env:NodeJS.ProcessEnv={ZCODE_POOL_CONNECTION_FILE:profile,ZCODE_POOL_HOME:join(directory,'unused-fallback'),ZCODE_POOL_RUNTIME_CLI_PATH:cli};
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return {directory,profile,poolA,poolB,cli,env};
}

test('connection profiles normalize absolute roots and every managed call rereads the authoritative selection',async t=>{
  const {profile,poolA,poolB,env}=await fixture(t);
  assert.equal(await readConnectionProfile(profile),null);
  await writeConnectionProfile(profile,`${poolA}/nested/..`);
  assert.deepEqual(await readConnectionProfile(profile),{schemaVersion:1,poolHome:resolve(poolA)});
  const requests:Request[]=[];let starts=0;
  const managed=createManagedDaemonCall({env,call:injectedCall(request=>{requests.push(request);return {root:request.root};}),start:async()=>{starts++;}});
  assert.deepEqual(await managed('overview',{}),{root:poolA});
  await writeConnectionProfile(profile,poolB);
  assert.deepEqual(await managed('get_pool_policy',{}),{root:poolB});
  assert.deepEqual(requests.map(request=>request.root),[poolA,poolB]);
  assert.equal(starts,0);
});

test('explicit profile saves atomically repair damaged ordinary files',async t=>{
  const {directory,poolA,poolB}=await fixture(t);
  const contents=[
    '{',
    '',
    JSON.stringify({schemaVersion:2,poolHome:poolA}),
    JSON.stringify({schemaVersion:1,poolHome:'relative'}),
    JSON.stringify({schemaVersion:1}),
    ' '.repeat(16385),
  ];
  for(const [index,content] of contents.entries()){
    const profile=join(directory,`damaged-${index}.json`);await writeFile(profile,content);
    const before=await lstat(profile);await assert.rejects(readConnectionProfile(profile));
    await writeConnectionProfile(profile,poolB);
    assert.deepEqual(await readConnectionProfile(profile),{schemaVersion:1,poolHome:poolB});
    const after=await lstat(profile);
    assert.notEqual(after.ino,before.ino,'saving stages a new file instead of modifying the old one in place');
    assert.equal(after.mode&0o777,0o600);
  }
  assert.equal((await readdir(directory)).some(name=>name.endsWith('.tmp')),false);
});

test('saving an equivalent valid profile preserves its original bytes and file identity',async t=>{
  const {profile,poolA}=await fixture(t);
  const content=JSON.stringify({schemaVersion:1,poolHome:`${poolA}/nested/..`,comment:'preserve local formatting'},null,2)+'\n';
  await writeFile(profile,content);const before=await lstat(profile);
  await writeConnectionProfile(profile,poolA);
  assert.equal(await readFile(profile,'utf8'),content);
  const after=await lstat(profile);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
});

test('explicit saves still reject symlinks, dangling symlinks and directories without changing their targets',async t=>{
  const {directory,poolA,poolB}=await fixture(t);
  const target=join(directory,'target.json');await writeConnectionProfile(target,poolA);
  const content=await readFile(target,'utf8');
  const link=join(directory,'symlink.json');await symlink(target,link);
  await assert.rejects(writeConnectionProfile(link,poolB),/Invalid connection profile file/);
  assert.equal((await lstat(link)).isSymbolicLink(),true);assert.equal(await readFile(target,'utf8'),content);
  const dangling=join(directory,'dangling.json'),missing=join(directory,'missing-target.json');await symlink(missing,dangling);
  await assert.rejects(writeConnectionProfile(dangling,poolB),/Invalid connection profile file/);
  assert.equal(await readlink(dangling),missing);await assert.rejects(lstat(missing),{code:'ENOENT'});
  const folder=join(directory,'directory.json');await mkdir(folder);await writeFile(join(folder,'keep.txt'),'unchanged');
  await assert.rejects(writeConnectionProfile(folder,poolB),/Invalid connection profile file/);
  assert.equal(await readFile(join(folder,'keep.txt'),'utf8'),'unchanged');
  assert.equal((await readdir(directory)).some(name=>name.endsWith('.tmp')),false);
});

test('the stale-write guard runs after staging and protects the old profile while cleaning the temporary file',async t=>{
  const {directory,profile,poolA,poolB}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const before=await lstat(profile);let checks=0;
  await assert.rejects(writeConnectionProfile(profile,poolB,()=>{
    checks++;const staged=readdirSync(directory).filter(name=>name.endsWith('.tmp'));
    assert.equal(staged.length,1);assert.equal(JSON.parse(readFileSync(join(directory,staged[0]!),'utf8')).poolHome,poolB);
    return false;
  }),/Connection profile write is stale/);
  assert.equal(checks,1);assert.deepEqual(await readConnectionProfile(profile),{schemaVersion:1,poolHome:poolA});
  assert.equal((await lstat(profile)).ino,before.ino);assert.deepEqual(await readdir(directory),['connection.json']);
  await assert.rejects(writeConnectionProfile(profile,poolA,()=>false),/Connection profile write is stale/);
  assert.equal((await lstat(profile)).ino,before.ino);
});

test('a newer pool selection supersedes an asynchronous save from the previous service revision',async t=>{
  const {directory,profile,poolA,poolB}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const latestPool=join(directory,'latest-pool');let revision=1;
  const stale=writeConnectionProfile(profile,poolB,()=>revision===1);
  revision=2;
  await Promise.all([
    assert.rejects(stale,/Connection profile write is stale/),
    writeConnectionProfile(profile,latestPool,()=>revision===2),
  ]);
  assert.deepEqual(await readConnectionProfile(profile),{schemaVersion:1,poolHome:latestPool});
  assert.deepEqual(await readdir(directory),['connection.json']);
});

test('configured missing, corrupt or invalid connection profiles never fall back, call RPC or start a daemon',async t=>{
  const {directory,poolA,cli}=await fixture(t);
  const valid=join(directory,'valid.json');await writeConnectionProfile(valid,poolA);
  const cases:{name:string;prepare?:(path:string)=>Promise<unknown>;path?:string}[]=[
    {name:'missing'},
    {name:'malformed-json',prepare:path=>writeFile(path,'{')},
    {name:'unsupported-schema',prepare:path=>writeFile(path,JSON.stringify({schemaVersion:2,poolHome:poolA}))},
    {name:'relative-pool',prepare:path=>writeFile(path,JSON.stringify({schemaVersion:1,poolHome:'relative-pool'}))},
    {name:'nul-pool',prepare:path=>writeFile(path,JSON.stringify({schemaVersion:1,poolHome:poolA+'\0other'}))},
    {name:'missing-pool',prepare:path=>writeFile(path,JSON.stringify({schemaVersion:1}))},
    {name:'oversized',prepare:path=>writeFile(path,' '.repeat(16385))},
    {name:'directory',prepare:path=>mkdir(path)},
    {name:'symlink',prepare:path=>symlink(valid,path)},
    {name:'relative-profile',path:'relative-connection.json'},
    {name:'empty-profile',path:''},
  ];
  for(const item of cases)await t.test(item.name,async()=>{
    const profile=item.path??join(directory,`${item.name}.json`);await item.prepare?.(profile);
    const env:NodeJS.ProcessEnv={ZCODE_POOL_CONNECTION_FILE:profile,ZCODE_POOL_HOME:join(directory,'fallback-must-not-be-used'),ZCODE_POOL_RUNTIME_CLI_PATH:cli};
    let calls=0,starts=0;
    const managed=createManagedDaemonCall({env,call:injectedCall(()=>{calls++;return {};}),start:async()=>{starts++;}});
    await assert.rejects(managed('dispatch_task',{request_id:'same-request'}));
    assert.equal(calls,0);assert.equal(starts,0);
  });
});

test('a profile removed or corrupted after a successful call cannot reuse the previous pool',async t=>{
  const {profile,poolA,poolB,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const roots:(string|undefined)[]=[];let starts=0;
  const managed=createManagedDaemonCall({env,call:injectedCall(request=>{roots.push(request.root);return request.root;}),start:async()=>{starts++;}});
  assert.equal(await managed('overview',{}),poolA);
  await rm(profile);await assert.rejects(managed('dispatch_task',{request_id:'must-not-reach-old-pool'}));
  await writeFile(profile,'{');await assert.rejects(managed('dispatch_task',{request_id:'must-not-use-fallback'}));
  assert.deepEqual(roots,[poolA]);assert.equal(starts,0);
  await writeConnectionProfile(profile,poolB);
  assert.equal(await managed('overview',{}),poolB);assert.deepEqual(roots,[poolA,poolB]);
});

test('an unconfigured profile uses only the explicitly supplied legacy pool root',async t=>{
  const {poolA}=await fixture(t);
  const env={ZCODE_POOL_HOME:`${poolA}/nested/..`};
  assert.equal(await connectionPoolRoot(env),poolA);
  const managed=createManagedDaemonCall({env,call:injectedCall(request=>request.root),start:async()=>{assert.fail('Unexpected start');}});
  assert.equal(await managed('overview',{}),poolA);
});

test('reads and mutations never start a stopped pool',async t=>{
 const {profile,poolA,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
 for(const method of ['overview','dispatch_task','shutdown_pool'])for(const code of ['ENOENT','ECONNREFUSED','ETIMEDOUT']){
  let calls=0,starts=0;const failure=unavailable(code);
  const managed=createManagedDaemonCall({env,call:injectedCall(()=>{calls++;throw failure;}),start:async()=>{starts++;}});
  await assert.rejects(managed(method,{}),error=>error===failure);assert.equal(calls,1);assert.equal(starts,0);
 }
});

test('explicit start is deduplicated and only retries overview after proven connection failure',async t=>{
 const {profile,poolA,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
 let ready=false,starts=0,calls=0;const entered=signal(),release=signal();t.after(release.release);
 const managed=createManagedDaemonCall({env,call:injectedCall(request=>{assert.equal(request.method,'overview');assert.equal(request.root,poolA);calls++;if(!ready)throw unavailable();return {};}),start:async()=>{starts++;entered.release();await release.promise;ready=true;}});
 const first=managed('daemon_start',{});await entered.promise;const second=managed('daemon_start',{});
 await new Promise(r=>setTimeout(r,20));release.release();
 assert.deepEqual(await Promise.all([first,second]),[{ready:true},{ready:true}]);assert.equal(starts,1);assert.equal(calls,4);
 assert.deepEqual(await managed('daemon_start',{}),{ready:true});assert.equal(starts,1);
});

test('explicit start never retries uncertain RPC errors or invalid runtime configuration',async t=>{
 const {profile,poolA,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
 for(const code of ['ETIMEDOUT','ECONNRESET','EACCES']){
  let starts=0,calls=0;const failure=unavailable(code);
  const managed=createManagedDaemonCall({env,call:injectedCall(()=>{calls++;throw failure;}),start:async()=>{starts++;}});
  await assert.rejects(managed('daemon_start',{}),error=>error===failure);assert.equal(starts,0);assert.equal(calls,1);
 }
 for(const entry of [undefined,'relative','/bad\0path']){
  let starts=0;
  const managed=createManagedDaemonCall({env:{...env,ZCODE_POOL_RUNTIME_CLI_PATH:entry},call:injectedCall(()=>{throw unavailable();}),start:async()=>{starts++;}});
  await assert.rejects(managed('daemon_start',{}));assert.equal(starts,0);
 }
});

test('failed explicit startup leaves a later explicit retry possible, never sends tasks',async t=>{
 const {profile,poolA,env}=await fixture(t);await writeConnectionProfile(profile,poolA);let ready=false,starts=0;
 const managed=createManagedDaemonCall({env,call:injectedCall(request=>{assert.equal(request.method,'overview');if(!ready)throw unavailable();return {};}),start:async()=>{if(++starts===1)throw new Error('start failed');ready=true;}});
 await assert.rejects(managed('daemon_start',{}),/start failed/);assert.deepEqual(await managed('daemon_start',{}),{ready:true});assert.equal(starts,2);
});

test('switching profile during explicit startup keeps each operation bound to its original pool',async t=>{
 const {profile,poolA,poolB,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
 const entered=signal(),release=signal();t.after(release.release);const ready=new Set<string>();const starts:string[]=[];
 const managed=createManagedDaemonCall({env,call:injectedCall(request=>{if(!ready.has(request.root!))throw unavailable();return {};}),start:async root=>{starts.push(root);if(root===poolA){entered.release();await release.promise;}ready.add(root);}});
 const first=managed('daemon_start',{});await entered.promise;await writeConnectionProfile(profile,poolB);
 assert.deepEqual(await managed('daemon_start',{}),{ready:true});release.release();assert.deepEqual(await first,{ready:true});assert.deepEqual(starts,[poolA,poolB]);
});

test('a profile switch cannot change the destination or result of an already-started RPC', {timeout:5000}, async t=>{
  const {profile,poolA,poolB,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const entered=signal(),release=signal();t.after(release.release);
  const requests:Request[]=[];
  const managed=createManagedDaemonCall({env,call:injectedCall(async request=>{
    requests.push(request);
    if(request.method==='dispatch_task'){entered.release();await release.promise;}
    return {root:request.root,method:request.method};
  }),start:async()=>{assert.fail('Connected calls must not start a daemon');}});
  const original=managed('dispatch_task',{request_id:'already-started'});await entered.promise;
  await writeConnectionProfile(profile,poolB);
  assert.deepEqual(await managed('overview',{}),{root:poolB,method:'overview'});
  release.release();assert.deepEqual(await original,{root:poolA,method:'dispatch_task'});
  assert.deepEqual(requests.map(request=>request.root),[poolA,poolB]);
});
