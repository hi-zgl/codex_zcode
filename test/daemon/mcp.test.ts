import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rpcCall } from '../../src/shared/rpc.js';

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
  assert.ok(tools.tools.some(t=>t.name==='zcode_dispatch_task'));
  assert.ok(!tools.tools.some(t=>t.name==='zcode_import_accounts'));
  const result=await client.callTool({name:'zcode_overview',arguments:{}});
  assert.equal(result.isError,undefined);
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
