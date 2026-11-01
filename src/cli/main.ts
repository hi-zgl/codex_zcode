import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { open, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rpcCall, poolRoot } from '../shared/rpc.js';
import { methods, validateMethod } from '../shared/methods.js';

async function main() {
  const [command,...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log('zcode-pool: local isolated ZCode orchestration prototype\n\nCommands:\n  daemon-start\n  daemon (foreground)\n  mcp (stdio)\n  import-accounts FILE...\n  METHOD \'{"parameter":"value"}\'\n\nMethods:\n'+Object.entries(methods).map(([n,d])=>`  ${n}: ${d.description}`).join('\n'));
    return;
  }
  if (command === 'daemon') {await import('../daemon/main.js');return;}
  if (command === 'mcp') {await import('../mcp/main.js');return;}
  if (command === 'daemon-start') {
    try {await rpcCall('overview',{}, {timeoutMs:1000});console.log('Daemon already ready');return;} catch {}
    const root=poolRoot(); await mkdir(join(root,'scheduler'),{recursive:true,mode:0o700});
    const log=await open(join(root,'scheduler','daemon.log'),'a',0o600);
    const entry=fileURLToPath(new URL('../daemon/main.ts',import.meta.url));
    const child=spawn(process.execPath,['--import','tsx',entry],{detached:true,stdio:['ignore',log.fd,log.fd],env:process.env});
    child.on('error',()=>{}); child.unref(); await log.close();
    for(let i=0;i<100;i++) {
      await new Promise(r=>setTimeout(r,100));
      try {await rpcCall('overview',{}, {timeoutMs:500});console.log('Daemon ready');return;} catch {}
    }
    throw new Error('Daemon did not become ready. Inspect scheduler/daemon.log; no Worker was automatically stopped');
  }
  const method=command.replaceAll('-','_');
  const params=method==='import_accounts' ? {files:args} : args[0] ? JSON.parse(args[0]) : {};
  const checked=validateMethod(method,params);
  console.log(JSON.stringify(await rpcCall(checked.name,checked.params),null,2));
}
main().catch(error=>{console.error(error instanceof Error ? error.message : 'Command failed');process.exitCode=1;});
