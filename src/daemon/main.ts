import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { poolRoot } from '../shared/rpc.js';
import { serveRpc } from './server.js';
import { Coordinator } from './coordinator.js';
import { DurableTaskStore } from '../core/index.js';

const root=poolRoot();
await mkdir(join(root,'scheduler'),{recursive:true,mode:0o700});
let coordinator:Coordinator|undefined;
const rpc=await serveRpc(root,async(method,params)=>{
 if(method==='daemon_stop') {setTimeout(()=>{void shutdown();},100);return {stopping:true,workersStopped:false};}
 if(!coordinator) throw new Error('Daemon is initializing');
 const result=await coordinator.call(method,params);
 if(method==='shutdown_pool'||method==='pool_control'&&params.action==='shutdown')setTimeout(()=>{void shutdown();},100);
 return result;
});
const store=new DurableTaskStore(join(root,'scheduler','state.db'));
store.recoverInterruptedTasks();
coordinator=new Coordinator(root,store);
void coordinator.recoverTasks().then(results=>{
 const attached=results.filter(result=>result.attached).length;
 const inspection=results.filter(result=>result.requiresInspection).length;
 if(results.length) console.error(`zcode-pool recovery: ${attached} attached, ${inspection} require inspection; uncertain commands are never resent`);
}).catch(()=>console.error('zcode-pool recovery could not finish; occupancy retained, inspect task status'));
console.error('zcode-pool daemon ready');
let stopping=false;
async function shutdown(){
 if(stopping)return;stopping=true;
 // Keep the daemon ownership lock until all attached tasks and local verification
 // jobs have drained; a successor must not race their database/worktree writes.
 await coordinator!.close(); await rpc.close(); store.close();
 process.exit(0);
}
process.on('SIGTERM',()=>{void shutdown();});
process.on('SIGINT',()=>{void shutdown();});
