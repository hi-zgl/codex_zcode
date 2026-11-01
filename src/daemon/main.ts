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
 return coordinator.call(method,params);
});
const store=new DurableTaskStore(join(root,'scheduler','state.db'));
store.recoverInterruptedTasks();
coordinator=new Coordinator(root,store);
console.error('zcode-pool daemon ready');
let stopping=false;
async function shutdown(){
 if(stopping)return;stopping=true;
 await rpc.close(); await coordinator!.close(); store.close();
 process.exit(0);
}
process.on('SIGTERM',()=>{void shutdown();});
process.on('SIGINT',()=>{void shutdown();});
