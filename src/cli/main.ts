import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rpcCall, poolRoot } from '../shared/rpc.js';
import { connectionPoolRoot } from '../shared/connection.js';
import { methods, validateMethod } from '../shared/methods.js';
import { defaultUserServiceOptions, installUserService, renderUserService, userUnitDirectory } from '../service/systemd.js';
import { RotatingLog } from '../shared/rotating-log.js';
import { storageStatus } from '../maintenance/storage.js';

const serviceHelp = `User service commands:
  service-generate [OPTIONS]         print a systemd --user unit to stdout
  service-install [OPTIONS]          write the unit; does not reload, enable, or start it

Options:
  --name NAME.service               default: zcode-pool.service
  --pool-home PATH                  default: ZCODE_POOL_HOME or ~/.zcode_pool
  --node PATH                       default: this Node executable
  --loader PATH                     default: this project's resolved tsx loader
  --entry PATH                      default: this project's src/daemon/main.ts
  --working-directory PATH          default: this project root
  --unit-dir PATH                   install destination (default: XDG_CONFIG_HOME/systemd/user)
  --replace                         atomically replace an existing regular unit file (install only)

Paths are resolved to absolute paths when generated. See docs/service.md.`;

async function serviceCommand(command: string, args: string[]): Promise<void> {
  if (args.includes('--help')) { console.log(serviceHelp); return; }
  const options = defaultUserServiceOptions();
  const pathOptions = { '--pool-home': 'poolHome', '--node': 'nodePath', '--loader': 'loaderPath', '--entry': 'entryPath', '--working-directory': 'workingDirectory' } as const;
  let directory: string | undefined;
  let replace = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (seen.has(flag)) throw new Error(`Repeated service option: ${flag}`);
    seen.add(flag);
    if (flag === '--replace' && command === 'service-install') { replace = true; continue; }
    if (!Object.hasOwn(pathOptions, flag) && flag !== '--name' && !(flag === '--unit-dir' && command === 'service-install')) {
      throw new Error(`Unknown service option: ${flag}; use ${command} --help`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--name') options.name = value;
    else if (flag === '--unit-dir') directory = resolve(value);
    else options[pathOptions[flag as keyof typeof pathOptions]] = resolve(value);
  }
  if (command === 'service-generate') { process.stdout.write(renderUserService(options)); return; }
  const path = await installUserService(options, directory ?? userUnitDirectory(), { replace });
  console.log(`Installed ${path}\nNext: review the unit and follow docs/service.md to activate it.`);
}

async function main() {
  const [command,...args] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    console.log('zcode-pool: local isolated ZCode orchestration prototype\n\nCommands:\n  daemon-start\n  daemon (foreground)\n  mcp (stdio)\n  storage-status (read-only logical bytes and retention policy)\n  service-generate [OPTIONS]\n  service-install [OPTIONS]\n  import-accounts FILE...\n  METHOD \'{"parameter":"value"}\'\n\nMethods:\n'+Object.entries(methods).map(([n,d])=>`  ${n}: ${d.description}`).join('\n'));
    return;
  }
  if (command === 'mcp') {await import('../mcp/main.js');return;}
  // The extension and Codex use one host-side profile; a running daemon keeps
  // the concrete pool selected when it started, even if that profile changes.
  process.env.ZCODE_POOL_HOME = await connectionPoolRoot();
  if (command === 'storage-status') {
    if (args.length) throw new Error('storage-status takes no arguments');
    console.log(JSON.stringify(storageStatus(poolRoot()), null, 2));
    return;
  }
  if (command === 'daemon') {await import('../daemon/main.js');return;}
  if (command === 'service-generate' || command === 'service-install') { await serviceCommand(command,args); return; }
  if (command === 'daemon-start') {
    try {await rpcCall('overview',{}, {timeoutMs:1000});console.log('Daemon already ready');return;} catch {}
    const root=poolRoot(); await mkdir(join(root,'scheduler'),{recursive:true,mode:0o700});
    const logPath=join(root,'scheduler','daemon.log');
    // Validate/create the managed regular file before passing its append FD on.
    // Rotation in the child preserves this inode instead of renaming active output.
    new RotatingLog(logPath).close();
    const log=await open(logPath,constants.O_WRONLY|constants.O_APPEND|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const runtime=defaultUserServiceOptions();
    const child=spawn(runtime.nodePath,[...(runtime.loaderPath?['--import',pathToFileURL(runtime.loaderPath).href]:[]),runtime.entryPath],{cwd:runtime.workingDirectory,detached:true,stdio:['ignore',log.fd,log.fd],env:{...process.env,ZCODE_POOL_MANAGED_DAEMON_LOG:'1'}});
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
