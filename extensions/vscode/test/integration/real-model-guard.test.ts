import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const script=join(__dirname,'../../scripts/test-real-model.mjs');
for(const scenario of [
 {name:'disabled by default',enabled:'',args:[],status:0,phase:'skipped'},
 {name:'enabled but all targets missing',enabled:'1',args:[],status:2,phase:'not_started'},
 {name:'enabled but only a pool supplied',enabled:'1',args:['--pool-home','/not-a-selected-live-pool'],status:2,phase:'not_started'},
])test(`real-model runner opens zero sockets when ${scenario.name}`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'zp-model-guard-'));
 try{
  const guard=join(directory,'guard.mjs');
  await writeFile(guard,`import net from 'node:net';import {syncBuiltinESMExports} from 'node:module';
   const deny=()=>{process.stderr.write('UNEXPECTED_SOCKET_ATTEMPT');process.exit(91);};
   net.createConnection=deny;net.connect=deny;net.Socket.prototype.connect=deny;syncBuiltinESMExports();`);
  const result=spawnSync(process.execPath,['--import',guard,script,...scenario.args],{
   cwd:directory,env:{...process.env,ZCODE_POOL_RUN_REAL_MODEL:scenario.enabled,ZCODE_POOL_HOME:'/not-a-default-live-pool'},encoding:'utf8',timeout:15000,
  });
  assert.equal(result.error,undefined);assert.equal(result.status,scenario.status,result.stderr||result.stdout);
  assert.doesNotMatch(result.stderr,/UNEXPECTED_SOCKET_ATTEMPT/);
  const lines=result.stdout.trim().split('\n');assert.equal(lines.length,1);
  const event=JSON.parse(lines[0]!);assert.equal(event.phase,scenario.phase);
  if(scenario.enabled==='1')assert.equal(event.code,'MISSING_ARGUMENTS');
 }finally{await rm(directory,{recursive:true,force:true});}
});
