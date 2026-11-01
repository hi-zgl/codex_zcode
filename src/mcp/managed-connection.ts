import { spawn } from 'node:child_process';
import { dirname, isAbsolute } from 'node:path';
import { connectionPoolRoot } from '../shared/connection.js';
import { rpcCall } from '../shared/rpc.js';

/** Only retry connect failures that prove no request reached a daemon. */
export function createManagedDaemonCall(options:{env?:NodeJS.ProcessEnv;call?:typeof rpcCall;start?:(root:string,cli:string)=>Promise<void>}={}){
  const env=options.env??process.env;const call=options.call??rpcCall;
  const starts=new Map<string,Promise<void>>();
  return async(method:string,params:Record<string,unknown>):Promise<unknown>=>{
    const root=await connectionPoolRoot(env);
    // Reads and task controls never resurrect a deliberately stopped pool.
    if(method!=='daemon_start')return call(method,params,{root});
    try{await call('overview',{}, {root});return {ready:true};}catch(error){
      if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;
      const cli=env.ZCODE_POOL_RUNTIME_CLI_PATH;
      if(!cli||!isAbsolute(cli)||cli.includes('\0'))throw error;
      let pending=starts.get(root);
      if(!pending){pending=(options.start??startInstalled)(root,cli).finally(()=>starts.delete(root));starts.set(root,pending);}
      await pending;
      await call('overview',{}, {root});return {ready:true};
    }
  };
}
function startInstalled(root:string,cli:string):Promise<void>{
  return new Promise((resolve,reject)=>{
    const env:NodeJS.ProcessEnv={...process.env,ZCODE_POOL_HOME:root};delete env.ZCODE_POOL_CONNECTION_FILE;
    const child=spawn(process.execPath,[cli,'daemon-start'],{cwd:dirname(cli),env,stdio:'ignore',shell:false});
    let done=false;
    const timer=setTimeout(()=>finish(new Error('Daemon startup timeout; inspect status before retrying')),70000);
    function finish(error?:Error){if(done)return;done=true;clearTimeout(timer);if(error&&child.exitCode===null)child.kill();error?reject(error):resolve();}
    child.once('error',()=>finish(new Error('Cannot start bundled daemon')));
    child.once('close',code=>finish(code===0?undefined:new Error('Bundled daemon startup failed')));
  });
}
