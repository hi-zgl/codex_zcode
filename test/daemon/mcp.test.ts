import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { consumeLines, rpcCall, socketPath } from '../../src/shared/rpc.js';
import { MCP_MAX_TEXT_BYTES } from '../../src/shared/presentation.js';

test('real MCP stdio forwards to daemon; MCP exit does not terminate daemon', {timeout:20000}, async () => {
 const root=await mkdtemp(join(tmpdir(),'zpool-mcp-'));
 const env={...process.env,ZCODE_POOL_HOME:root};
 const daemon=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../../src/daemon/main.ts',import.meta.url))],{env,stdio:'ignore'});
 let client:Client|undefined;
 try {
  let ready=false;
  for(let i=0;i<100;i++) {
   try {await rpcCall('overview',{}, {root,timeoutMs:100});ready=true;break;} catch{}
   await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(ready,true,'daemon should become ready');
  client=new Client({name:'pool-test',version:'1'},{capabilities:{}});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',fileURLToPath(new URL('../../src/mcp/main.ts',import.meta.url))],env:env as Record<string,string>,stderr:'pipe'});
  await client.connect(transport);
  const tools=await client.listTools();
  assert.deepEqual(tools.tools.map(t=>t.name).sort(),['zcode_advance_work','zcode_inspect','zcode_pool_control','zcode_submit_work','zcode_wait_work']);
  const result=await client.callTool({name:'zcode_pool_control',arguments:{action:'read'}});
  assert.equal(result.isError,undefined);
  assert.deepEqual(readText(result).tasks,[]);
  assert.equal(readText(result).poolPolicy.retryIntervalMs,5000);assert.equal(readText(result).poolPolicy.recoveryWaitMs,120000);assert.equal(readText(result).poolPolicy.silenceCheckMs,900000);
  const policy=await client.callTool({name:'zcode_pool_control',arguments:{action:'configure',policy:{max_concurrent_tasks:0},user_requested_pool_change:true}});
  assert.equal(readText(policy).poolPolicy.maxConcurrentTasks,0);
  assert.deepEqual(await rpcCall('get_pool_policy',{}, {root}),readText(policy).poolPolicy,'MCP and local clients share one persisted policy');
  assert.deepEqual(readText(await client.callTool({name:'zcode_pool_control',arguments:{action:'start'}})).poolPolicy,readText(policy).poolPolicy);
  await client.close();client=undefined;
  const overview=await rpcCall<{tasks:unknown[]}>('overview',{}, {root});
  assert.deepEqual(overview.tasks,[]);
 } finally {
  await client?.close();
  const stopped=new Promise<void>(r=>daemon.once('exit',()=>r()));
  daemon.kill('SIGTERM'); await stopped;
  await rm(root,{recursive:true,force:true});
 }
});

function readText(result: unknown): any {
  const content=(result as {content:unknown}).content as {type:string;text:string}[];
  assert.equal(content.length,1);
  assert.equal(content[0]?.type,'text');
  assert.ok(Buffer.byteLength(content[0]!.text,'utf8')<=MCP_MAX_TEXT_BYTES);
  return JSON.parse(content[0]!.text);
}

async function fakeMcp(t:TestContext, handler:(method:string,args:Record<string,unknown>)=>unknown) {
 const root=await mkdtemp(join(tmpdir(),'zpool-mcp-fake-'));
 await mkdir(join(root,'scheduler'));
 const requests:{method:string;params:Record<string,unknown>}[]=[];
 const sockets=new Set<Socket>();
 const daemon=createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  socket.on('error',()=>{});
  consumeLines(socket,line=>{
   const request=JSON.parse(line);
   requests.push(request);
   let response:unknown;
   try {response={jsonrpc:'2.0',id:request.id,result:handler(request.method,request.params)};}
   catch(error) {response={jsonrpc:'2.0',id:request.id,error:{code:-32000,message:error instanceof Error?error.message:'Failed'}};}
   socket.write(JSON.stringify(response)+'\n');
  });
 });
 await new Promise<void>((resolve,reject)=>{daemon.once('error',reject);daemon.listen(socketPath(root),resolve);});
 const client=new Client({name:'safe-view-test',version:'1'},{capabilities:{}});
 const env={...process.env,ZCODE_POOL_HOME:root};
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',fileURLToPath(new URL('../../src/mcp/main.ts',import.meta.url))],env:env as Record<string,string>,stderr:'pipe'});
 t.after(async()=>{
  await client.close();
  for(const socket of sockets)socket.destroy();
  await new Promise<void>(resolve=>daemon.close(()=>resolve()));
  await rm(root,{recursive:true,force:true});
 });
 await client.connect(transport);
 return {client,requests};
}

test('real MCP stdio bounds hostile replies and native errors without exposing private context', {timeout:20000}, async t=>{
 const privateText='PRIVATE-PROMPT-CREDENTIAL-'.repeat(2000);
 const {client,requests}=await fakeMcp(t,(method)=>{
  if(method==='inspect')throw new Error(`Bearer actual-secret raw_snapshot=${privateText}`);
  if(method==='submit_work')throw new Error('Workspace is held by task private-task');
  return {tasks:[{taskId:'task-1',status:'running',revision:10,leaseHeld:true,prompt:privateText,detail:{summary:privateText,arguments:privateText}}],raw:privateText,history:privateText};
 });
 const overview=await client.callTool({name:'zcode_pool_control',arguments:{action:'read'}});
 assert.equal(readText(overview).tasks[0].taskId,'task-1');
 assert.doesNotMatch(JSON.stringify(overview),/PRIVATE-PROMPT-CREDENTIAL|"prompt"|"history"|"raw"/);
 const failed=await client.callTool({name:'zcode_inspect',arguments:{kind:'result',task_id:'task-1'}});
 assert.equal(failed.isError,true);
 assert.equal(readText(failed).error,'REQUEST_FAILED');
 assert.equal(readText(failed).task_id,'task-1');
 assert.doesNotMatch(JSON.stringify(failed),/actual-secret|PRIVATE-PROMPT-CREDENTIAL|raw_snapshot/);
 const busy=await client.callTool({name:'zcode_submit_work',arguments:{request_id:'request-1',commander_id:'commander',repository:'/project',goal:'Do the task',criteria:['observable'],stages:[{stageId:'build',title:'Build'}]}});
 assert.equal(busy.isError,true);
 assert.equal(readText(busy).error,'WORKSPACE_BUSY');
 assert.match(readText(busy).message,/Inspect/);
 assert.equal(requests.length,3);
});

test('real MCP stdio validates listed schemas and rejects unknown or huge invalid input before RPC', {timeout:20000}, async t=>{
 const {client,requests}=await fakeMcp(t,()=>({}));
 const listed=await client.listTools();
 const dispatch=listed.tools.find(tool=>tool.name==='zcode_submit_work')!;
 assert.equal((dispatch.inputSchema.properties?.goal as any).maxLength,12_000);
 assert.ok(!listed.tools.some(tool=>tool.name==='zcode_daemon_stop'||tool.name==='zcode_import_accounts'));
 const pool=listed.tools.find(tool=>tool.name==='zcode_pool_control')!;
 assert.ok(pool.inputSchema.properties?.policy);
 assert.equal((pool.inputSchema.properties?.only_if_idle as any).type,'boolean');
 assert.equal((pool.inputSchema.properties?.only_if_idle as any).default,undefined);
 assert.ok(!pool.inputSchema.required?.includes('only_if_idle'));
 for(const max_concurrent_tasks of [-1,65,0.5,'2']){
  const invalidPolicy=await client.callTool({name:'zcode_pool_control',arguments:{action:'configure',policy:{max_concurrent_tasks}}});
  assert.equal(invalidPolicy.isError,true);assert.equal(readText(invalidPolicy).error,'INVALID_ARGUMENT');
 }
 const invalid=await client.callTool({name:'zcode_wait_work',arguments:{work_id:123,commander_id:'commander',after_revision:{['PRIVATE-KEY-'.repeat(1000)]:-1}}});
 assert.equal(invalid.isError,true);
 assert.equal(readText(invalid).error,'INVALID_ARGUMENT');
 assert.doesNotMatch(JSON.stringify(invalid),/PRIVATE-KEY/);
 const unknown=await client.callTool({name:`zcode_unknown_${'PRIVATE-NAME-'.repeat(1000)}`,arguments:{prompt:'PRIVATE-PROMPT'}});
 assert.equal(unknown.isError,true);
 assert.equal(readText(unknown).error,'UNSUPPORTED_METHOD');
 assert.doesNotMatch(JSON.stringify(unknown),/PRIVATE-NAME|PRIVATE-PROMPT/);
 assert.equal(requests.length,0);
});

test('MCP instructions arrange explicit starts and automatic guarded finish without changing manual defaults',{timeout:20000},async t=>{
 const {client,requests}=await fakeMcp(t,(_method,args)=>{
  if(args.action==='shutdown'){
   if(args.only_if_idle)throw new Error('Pool has unfinished work; automatic shutdown requires an idle pool PRIVATE-CONTEXT');
   return {stopping:true,workersStopped:true,stoppedWorkers:0};
  }
  return {tasks:[]};
 });
 const instructions=client.getInstructions()!;
 assert.match(instructions,/Explicitly call pool_control with action start/);
 assert.match(instructions,/passed final acceptance and is completed, automatically attempt pool_control with action shutdown and only_if_idle true/);
 assert.match(instructions,/without asking for extra confirmation/);
 assert.match(instructions,/another commander's Work remains/);
 assert.match(instructions,/never fall back to only_if_idle false for automatic shutdown/);
 assert.match(instructions,/user explicitly stops work, save its current state and attempt shutdown with only_if_idle false/);
 assert.match(instructions,/Closing VS Code or losing the commander connection does not mean work is complete/);
 const busy=await client.callTool({name:'zcode_pool_control',arguments:{action:'shutdown',only_if_idle:true}});
 assert.equal(busy.isError,true);assert.equal(readText(busy).error,'POOL_NOT_IDLE');
 assert.equal(readText(busy).stopping,undefined);
 assert.match(readText(busy).message,/No Workers were stopped/);
 assert.doesNotMatch(JSON.stringify(busy),/PRIVATE-CONTEXT/);
 const stopped=await client.callTool({name:'zcode_pool_control',arguments:{action:'shutdown'}});
 assert.equal(stopped.isError,undefined);assert.equal(readText(stopped).stopping,true);
 for(const action of ['read','start','configure']){
  const result=await client.callTool({name:'zcode_pool_control',arguments:{action}});
  assert.equal(result.isError,undefined);
 }
 assert.equal(requests[0]!.params.only_if_idle,true);
 assert.ok(requests.slice(1).every(request=>!Object.hasOwn(request.params,'only_if_idle')),'omitting the guard preserves older daemon request shapes');
 const invalid=await client.callTool({name:'zcode_pool_control',arguments:{action:'shutdown',only_if_idle:'true'}});
 assert.equal(readText(invalid).error,'INVALID_ARGUMENT');assert.equal(requests.length,5);
});
