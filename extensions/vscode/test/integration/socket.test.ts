import {test}from'node:test';
import assert from'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join,resolve}from'node:path';
import {createServer,type Server}from'node:net';
import {spawn}from'node:child_process';
import {SocketTransport,TypedClient,HostError}from'../../src/host/client.js';
import {ActionService,type NativeAdapter}from'../../src/host/actions.js';
import {parseRequest,type RequestType}from'../../src/host/protocol.js';
test('real Unix socket framing, identity validation, abort and oversize responses',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-extension-socket-'));await mkdir(join(root,'scheduler'));let requests=0;
  const server=createServer(socket=>{socket.once('data',data=>{requests++;const request=JSON.parse(data.toString());if(request.method==='hang')return;socket.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:request.method==='huge'?'x'.repeat(1048576):{safe:true}})+'\n');});});
  await new Promise<void>(resolveListen=>server.listen(join(root,'scheduler','daemon.sock'),resolveListen));const transport=new SocketTransport(root);
  try{assert.deepEqual(await transport.request('read',{}),{safe:true});await assert.rejects(transport.request('huge',{}),error=>error instanceof HostError&&error.code==='OUTPUT_BUDGET_EXCEEDED');const abort=new AbortController();const pending=transport.request('hang',{},abort.signal,1000);setTimeout(()=>abort.abort(),20);await assert.rejects(pending,error=>error instanceof HostError&&error.code==='ABORTED');assert.equal(requests,3);}finally{transport.dispose();await new Promise<void>(resolveClose=>server.close(()=>resolveClose()));await rm(root,{recursive:true,force:true});}
});
for(const dropped of [false,true])test(`Host ↔ real Coordinator socket action loop, fake native runtime${dropped?' with lost dispatch ACK':''}`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-extension-wire-'));const checkout=resolve(__dirname,'../../../..');
  const child=spawn(process.execPath,['--import',join(checkout,'node_modules/tsx/dist/loader.mjs'),resolve(__dirname,'daemon-harness.mjs'),root],{env:{...process.env,ZCODE_POOL_TEST_DROP_DISPATCH_ACK:dropped?'1':'0'},stdio:['ignore','pipe','pipe']});
  const storage=new Map<string,unknown>();let importPath=join(root,'oauth-fixture.json');await writeFile(importPath,JSON.stringify({provider:'zai',user_id:'wire-fixture',access_token:'WIRE_SECRET_CANARY',zcode_jwt_token:'unverified-test-token'}));
  const diffs:string[]=[];const native:NativeAdapter={trusted:()=>true,getState:<T>(key:string,fallback:T)=>(storage.get(key)??fallback)as T,setState:async(key,value)=>{storage.set(key,value);},pickAccountFiles:async()=>[importPath],pickRepository:async()=>join(root,'repo'),openDiff:async(_task,_hash,_file,read)=>{diffs.push(await read('base'),await read('final'));},openSettings:async()=>{},saveInterval:async()=>{},copyDiagnostics:async()=>{},guidance:async()=>{}};
  const service=new ActionService({mode:'real',poolHome:root,host:'wire-host',authority:'local',createTransport:async()=>new SocketTransport(root),native,onSnapshot:()=>{}});let id=0;const execute=(type:RequestType,payload:unknown={})=>service.execute(parseRequest({v:1,id:`wire-${++id}`,generation:service.generation(),type,payload}));
  try{
    await new Promise<void>((ready,reject)=>{const timer=setTimeout(()=>reject(new Error('Coordinator harness start timed out')),5000);child.stdout.on('data',data=>{if(data.toString().includes('ready')){clearTimeout(timer);ready();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Coordinator harness exited early'));});});
    await execute('connect');assert.equal(service.snapshot().tasks.length,0);
    const imported:any=await execute('accounts.import');assert.equal(imported.fileCount,1);assert.equal(imported.recordCount,1);assert.equal(JSON.stringify(imported).includes('WIRE_SECRET_CANARY'),false);
    const alias=service.state.resources.accounts[0]!.alias;const worker:any=await execute('worker.start',{workerId:'worker-wire',accountAlias:alias});assert.equal(worker.workerId,'worker-wire');assert.equal(JSON.stringify(worker).includes('WIRE_SECRET_CANARY'),false);
    const workspace:any=await execute('workspace.create',{baseRef:'HEAD'});assert.notEqual(workspace.worktreePath,workspace.repositoryPath);
    const draft={...service.state.draft,workspaceId:workspace.workspaceId,workerId:'worker-wire',prompt:'Only a fake runtime receives this integration prompt.'};await execute('draft.change',{draft});
    let taskId:string;
    if(dropped){await assert.rejects(execute('dispatch',{submitToken:draft.submitToken}));const records=storage.get('dispatchRecovery')as any[];assert.equal(records.length,1);const lookup:any=await execute('dispatch.lookup',{requestId:records[0].requestId});taskId=lookup.taskId;await assert.rejects(execute('dispatch',{submitToken:draft.submitToken}));}
    else {const dispatched:any=await execute('dispatch',{submitToken:draft.submitToken});taskId=dispatched.task.taskId;}
    for(let n=0;n<100;n++){const detail:any=await execute('task.select',{taskId});if(['succeeded','failed'].includes(detail.status))break;await new Promise(resolveWait=>setTimeout(resolveWait,20));}
    assert.equal(service.state.detail!.status,'succeeded');assert.equal(service.state.detail!.executionStopped,true);assert.equal(service.state.detail!.leaseHeld,false);
    await execute('artifacts.list',{taskId});assert.equal(service.state.delivery.manifest?.state,'available');assert.ok(service.state.delivery.files.some(file=>file.change==='untracked'));
    const hash=service.state.delivery.manifest!.manifestSha256!;for(const file of service.state.delivery.files)if(file.nativeDiff.available)await execute('diff.open',{taskId,manifestSha256:hash,fileId:file.fileId});assert.ok(diffs.includes('after 😀\n'));assert.ok(diffs.includes('immutable untracked\n'));
    const quota:any=await execute('worker.probe',{workerId:'worker-wire'});assert.equal(JSON.stringify(quota).includes('WIRE_SECRET_CANARY'),false);assert.equal(quota.live.remaining,5);
    const stopped:any=await execute('worker.stop',{workerId:'worker-wire'});assert.deepEqual(stopped,{workerId:'worker-wire',stopped:true});assert.equal(child.exitCode,null);
  }finally{service.dispose();child.kill('SIGTERM');await new Promise<void>(done=>{if(child.exitCode!==null)done();else child.once('exit',()=>done());});await rm(root,{recursive:true,force:true});}
});
test('independent Node 24 daemon only performs explicit read-only handshake; dispose leaves it running',async()=>{
  const root=await mkdtemp(join(tmpdir(),'zcode-extension-daemon-'));const checkout=resolve(__dirname,'../../../..');
  const child=spawn(process.execPath,['--import',join(checkout,'node_modules/tsx/dist/loader.mjs'),join(checkout,'src/daemon/main.ts')],{env:{...process.env,ZCODE_POOL_HOME:root},stdio:['ignore','pipe','pipe']});let diagnostics='';child.stderr.on('data',data=>{diagnostics+=data;});
  const transport=new SocketTransport(root);const client=new TypedClient(transport);
  try{
    let connected=false;for(let i=0;i<100;i++){try{await transport.request('ui_capabilities',{bootstrapVersion:1,client:{name:'vscode',version:'0.1.0'},supportedApiMajors:[1]},undefined,1000);connected=true;break;}catch{await new Promise(resolveWait=>setTimeout(resolveWait,30));}}
    assert.ok(connected,'Temporary daemon must start for integration');
    const capabilities=await client.call('ui_capabilities',{bootstrapVersion:1,client:{name:'vscode',version:'0.1.0'},supportedApiMajors:[1]});assert.equal(capabilities.selectedApiVersion.major,1);
    const overview=await client.legacy('overview',{});assert.deepEqual(overview.tasks,[]);assert.deepEqual(overview.accounts,[]);
    await assert.rejects(client.call('ui_get_task_detail',{apiVersion:1,request_id:'missing-request'}),error=>error instanceof HostError&&error.code==='NOT_FOUND');
    client.dispose();assert.equal(child.exitCode,null);assert.equal(diagnostics.includes('access_token'),false);
  }finally{client.dispose();child.kill('SIGTERM');await new Promise<void>(resolveExit=>{if(child.exitCode!==null)resolveExit();else child.once('exit',()=>resolveExit());});await rm(root,{recursive:true,force:true});}
});
