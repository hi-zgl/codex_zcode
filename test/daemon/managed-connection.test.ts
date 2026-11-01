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

test('ENOENT and ECONNREFUSED allow one start and one retry of the exact original request',async t=>{
  for(const code of ['ENOENT','ECONNREFUSED'])await t.test(code,async t=>{
    const {profile,poolA,cli,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
    const params={workspace_id:'workspace',worker_id:'worker',request_id:'unchanged-request',prompt:'Fixture only'};
    const requests:Request[]=[],starts:{root:string;cli:string}[]=[];
    const managed=createManagedDaemonCall({env,call:injectedCall(request=>{
      requests.push(request);if(requests.length===1)throw unavailable(code);return {accepted:true};
    }),start:async(root,entry)=>{starts.push({root,cli:entry});}});
    assert.deepEqual(await managed('dispatch_task',params),{accepted:true});
    assert.deepEqual(starts,[{root:poolA,cli}]);assert.equal(requests.length,2);
    for(const request of requests){assert.equal(request.root,poolA);assert.equal(request.method,'dispatch_task');assert.equal(request.params,params);}
  });
});

test('timeouts, lost acknowledgements and every other transport or RPC error are never retried',async t=>{
  const {profile,poolA,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const failures=[
    new Error('Daemon RPC timed out; task execution state is unchanged'),
    new Error('Daemon connection closed before response'),
    new Error('Malformed daemon response'),
    unavailable('ETIMEDOUT'),unavailable('ECONNRESET'),unavailable('EPIPE'),unavailable('EACCES'),unavailable('ENOTDIR'),
    new RpcCallError('Daemon applied the request before the reply was lost',-32000),
  ];
  for(const failure of failures){
    let calls=0,starts=0;
    const managed=createManagedDaemonCall({env,call:injectedCall(()=>{calls++;throw failure;}),start:async()=>{starts++;}});
    await assert.rejects(managed('dispatch_task',{request_id:'possibly-applied'}),error=>error===failure);
    assert.equal(calls,1,failure.message);assert.equal(starts,0,failure.message);
  }
});

test('a missing or invalid runtime CLI disables automatic startup even after a definite connect failure',async t=>{
  const {profile,poolA,cli,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  for(const entry of [undefined,'','relative/cli.mjs',cli+'\0other']){
    const failure=unavailable();let calls=0,starts=0;
    const managed=createManagedDaemonCall({env:{...env,ZCODE_POOL_RUNTIME_CLI_PATH:entry},call:injectedCall(()=>{calls++;throw failure;}),start:async()=>{starts++;}});
    await assert.rejects(managed('overview',{}),error=>error===failure);
    assert.equal(calls,1);assert.equal(starts,0);
  }
});

test('a failed retry is propagated without a second startup or third dispatch',async t=>{
  const {profile,poolA,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const secondFailure=unavailable('ECONNREFUSED');let calls=0,starts=0;
  const managed=createManagedDaemonCall({env,call:injectedCall(()=>{calls++;throw calls===1?unavailable():secondFailure;}),start:async()=>{starts++;}});
  await assert.rejects(managed('dispatch_task',{request_id:'one-retry-only'}),error=>error===secondFailure);
  assert.equal(calls,2);assert.equal(starts,1);
});

test('startup failure never dispatches a retry and a later explicit call may start again',async t=>{
  const {profile,poolA,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const startupFailure=new Error('Fixture startup failed');let calls=0,starts=0;
  const managed=createManagedDaemonCall({env,call:injectedCall(()=>{calls++;if(calls<=2)throw unavailable();return {accepted:true};}),start:async()=>{starts++;if(starts===1)throw startupFailure;}});
  await assert.rejects(managed('dispatch_task',{request_id:'not-sent'}),error=>error===startupFailure);
  assert.equal(calls,1);assert.equal(starts,1);
  assert.deepEqual(await managed('dispatch_task',{request_id:'not-sent'}),{accepted:true});
  assert.equal(calls,3);assert.equal(starts,2);
});

test('concurrent requests to one pool share one in-progress daemon startup', {timeout:5000}, async t=>{
  const {profile,poolA,cli,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const count=12,attempts=new Map<string,number>(),requests:Request[]=[];
  const allAttempted=signal(),startEntered=signal(),releaseStartup=signal();t.after(releaseStartup.release);
  let starts=0;
  const managed=createManagedDaemonCall({env,call:injectedCall(request=>{
    requests.push(request);const id=request.params.request_id as string;
    const attempt=(attempts.get(id)??0)+1;attempts.set(id,attempt);
    if(attempt===1){if(attempts.size===count)allAttempted.release();throw unavailable();}
    return {requestId:id};
  }),start:async(root,entry)=>{starts++;assert.equal(root,poolA);assert.equal(entry,cli);startEntered.release();await releaseStartup.promise;}});
  const operations=Array.from({length:count},(_,index)=>managed('dispatch_task',{request_id:`request-${index}`}));
  await Promise.all([allAttempted.promise,startEntered.promise]);
  assert.equal(starts,1);assert.equal(requests.length,count);
  releaseStartup.release();
  assert.deepEqual(await Promise.all(operations),Array.from({length:count},(_,index)=>({requestId:`request-${index}`})));
  assert.equal(starts,1);assert.equal(requests.length,count*2);
  assert.equal(requests.every(request=>request.root===poolA),true);
  assert.equal([...attempts.values()].every(attempt=>attempt===2),true);
});

test('switching profiles during startup starts the new pool separately and keeps each retry bound to its original pool', {timeout:5000}, async t=>{
  const {profile,poolA,poolB,env}=await fixture(t);await writeConnectionProfile(profile,poolA);
  const enteredA=signal(),enteredB=signal(),releaseA=signal(),releaseB=signal();
  t.after(()=>{releaseA.release();releaseB.release();});
  const requests:Request[]=[],starts:string[]=[],attempts=new Map<string|undefined,number>();
  const managed=createManagedDaemonCall({env,call:injectedCall(request=>{
    requests.push(request);const attempt=(attempts.get(request.root)??0)+1;attempts.set(request.root,attempt);
    if(attempt===1)throw unavailable();return {root:request.root};
  }),start:async(root)=>{
    starts.push(root);
    if(root===poolA){enteredA.release();await releaseA.promise;}
    else {assert.equal(root,poolB);enteredB.release();await releaseB.promise;}
  }});
  const first=managed('dispatch_task',{request_id:'pool-a-request'});await enteredA.promise;
  await writeConnectionProfile(profile,poolB);
  const second=managed('overview',{});await enteredB.promise;
  assert.deepEqual(starts,[poolA,poolB]);releaseA.release();releaseB.release();
  assert.deepEqual(await first,{root:poolA});assert.deepEqual(await second,{root:poolB});
  assert.deepEqual(requests.filter(request=>request.method==='dispatch_task').map(request=>request.root),[poolA,poolA]);
  assert.deepEqual(requests.filter(request=>request.method==='overview').map(request=>request.root),[poolB,poolB]);
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
