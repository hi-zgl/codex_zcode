// Opt-in live validation. Never run by npm test. Requires existing ready workers a and b.
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git } from '../src/daemon/workspace.js';
import { poolRoot, rpcCall } from '../src/shared/rpc.js';
const root=poolRoot();
await mkdir(join(root,'validation'),{recursive:true});
const repo=await mkdtemp(join(root,'validation','repo-'));
await git(repo,['init','-b','main']);
await git(repo,['config','user.email','fixture@example.invalid']);
await git(repo,['config','user.name','Fixture']);
await writeFile(join(repo,'sum.cjs'),'exports.sum = (a,b) => a-b;\n');
await writeFile(join(repo,'sum.test.cjs'),"const {test}=require('node:test'); const assert=require('node:assert/strict'); const {sum}=require('./sum.cjs'); test('sum',()=>assert.equal(sum(2,3),5));\n");
await git(repo,['add','.']);await git(repo,['commit','-m','validation fixture']);
const tasks=[];
const before=[];
for(const worker of ['a','b']) {
 before.push(await rpcCall('probe_worker',{worker_id:worker}));
 const ws=await rpcCall<any>('create_workspace',{repository:repo,base_ref:'main'});
 const dispatch=await rpcCall<any>('dispatch_task',{workspace_id:ws.workspaceId,worker_id:worker,request_id:`live-${worker}-${Date.now()}`,session:'new',mode:'yolo',prompt:'In this isolated validation fixture only, fix sum.cjs so sum(a,b) adds the two numbers. Run node --test sum.test.cjs. Do not modify any files outside this workspace. Keep the response brief.',verify_commands:[{command:process.execPath,args:['--test','sum.test.cjs'],timeout_ms:30000}]});
 tasks.push({worker,ws,taskId:dispatch.task.taskId});
}
console.log(JSON.stringify({phase:'dispatched',tasks:tasks.map(t=>({worker:t.worker,taskId:t.taskId}))}));
const deadline=Date.now()+300000;
let revision=0;
let lastStatus='';
while(Date.now()<deadline) {
 const status=await rpcCall<any>('wait',{task_ids:tasks.map(t=>t.taskId),after_revision:revision,timeout_sec:10});
 revision=status.revision;
 const key=status.tasks.map((t:any)=>t.status).join(',');
 if(key!==lastStatus) {lastStatus=key;console.log(JSON.stringify({phase:'status',tasks:status.tasks.map((t:any)=>({id:t.taskId,status:t.status,revision:t.revision}))}));}
 if(status.tasks.every((t:any)=>['succeeded','failed','cancelled','blocked','interrupted','waiting_approval'].includes(t.status)))break;
 // A completed task returns immediately; bounded delay avoids spinning while its peer is active.
 await new Promise(r=>setTimeout(r,500));
}
const results=[];
for(const t of tasks) results.push({worker:t.worker,workspace:t.ws.worktreePath,...await rpcCall<any>('get_result',{task_id:t.taskId}),actualFile:await readFile(join(t.ws.worktreePath,'sum.cjs'),'utf8')});
const after=[];for(const worker of ['a','b'])after.push(await rpcCall('probe_worker',{worker_id:worker}));
const report={recordedAt:new Date().toISOString(),before,results,after};
await writeFile(join(root,'validation','coordinator-report.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify({phase:'finished',results:results.map(r=>({worker:r.worker,status:r.task.status,file:r.actualFile,verification:r.result?.verification})),report:join(root,'validation','coordinator-report.json')}));
if(results.some(r=>r.task.status!=='succeeded'))process.exitCode=1;
