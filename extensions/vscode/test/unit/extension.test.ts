import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {dirname,join,resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import type {UiSnapshot} from '../../src/host/types.js';
import type {RequestType,WebviewRequest} from '../../src/host/protocol.js';

const root=resolve(__dirname,'../..');
const requireModule=createRequire(join(root,'package.json'));
const bundle=build({absWorkingDir:root,entryPoints:['src/extension.ts'],bundle:true,write:false,platform:'node',format:'cjs',target:'node20',external:['vscode'],alias:{zod:join(root,'node_modules/zod')}});
interface ExtensionApi {snapshot():UiSnapshot;execute(request:WebviewRequest):Promise<unknown>}
interface StartupRuntime {
  nodePath:string;cliPath:string;
  discoverNode?():Promise<void>;
  resolvePool?(path:string):Promise<void>;
}
async function harness(options:{poolHome?:string;debugPoolHome?:string;development?:boolean;mock?:boolean;selectedPool?:string;socketState?:'unavailable'|'pending';startupRuntime?:StartupRuntime}={}){
  let poolHome=options.poolHome;
  let configurationChanged:(event:{affectsConfiguration(key:string):boolean})=>Promise<void>=async()=>{};
  const commands=new Map<string,(arg?:unknown)=>unknown>();
  const nativeCommands:string[]=[];const errors:string[]=[];const sockets:string[]=[];const canonicalized:string[]=[];
  const spawns:{command:string;args:string[]}[]=[];
  let panels=0;let id=0;
  const disposable=()=>({dispose(){}});const event=()=>disposable();
  const uri=(fsPath:string)=>({fsPath,toString:()=>fsPath});
  const vscode={
    ExtensionMode:{Production:1},StatusBarAlignment:{Left:1},ViewColumn:{One:1},ConfigurationTarget:{Global:1},
    EventEmitter:class{event=event;fire(){}dispose(){}},TreeItem:class{},
    Uri:{joinPath:(base:{fsPath:string},...parts:string[])=>uri(join(base.fsPath,...parts))},
    env:{remoteName:'ssh-remote'},
    workspace:{isTrusted:true,workspaceFolders:[],
      getConfiguration:()=>({inspect:(key:string)=>({globalValue:key==='poolHome'?poolHome:key==='daemonCliPath'?options.startupRuntime?.cliPath:undefined,workspaceValue:'/workspace/must-not-be-used'}),get:()=>30,update:async(key:string,value:string)=>{if(key==='poolHome'){poolHome=value;await configurationChanged({affectsConfiguration:k=>k==='zcodePool.poolHome'});}}}),
      registerTextDocumentContentProvider:disposable,onDidGrantWorkspaceTrust:event,onDidChangeWorkspaceFolders:event,onDidCloseTextDocument:event,
      onDidChangeConfiguration:(listener:typeof configurationChanged)=>{configurationChanged=listener;return disposable();},
    },
    commands:{registerCommand:(name:string,handler:(arg?:unknown)=>unknown)=>{commands.set(name,handler);return disposable();},executeCommand:async(name:string,...args:unknown[])=>{const handler=commands.get(name);if(handler)return handler(args[0]);nativeCommands.push(name);}},
    window:{
      createStatusBarItem:()=>({...disposable(),show(){}}),createTreeView:()=>({...disposable(),visible:false,onDidChangeVisibility:event}),
      onDidChangeActiveTextEditor:event,showInputBox:async()=>options.selectedPool,showErrorMessage:async(message:string)=>{errors.push(message);},
      createWebviewPanel:()=>{panels++;return {...disposable(),visible:true,reveal(){},onDidChangeViewState:event,onDidDispose:event,webview:{cspSource:'test',asWebviewUri:(value:unknown)=>value,onDidReceiveMessage:event,postMessage:async()=>true}};},
    },
  };
  const env:Record<string,string>={ZCODE_POOL_EXTENSION_MODE:options.mock?'mock':'real',ZCODE_POOL_UI_FIXTURE:join(root,'test/fixtures/pool-demo.json')};
  if(options.debugPoolHome!==undefined)env.ZCODE_POOL_DEBUG_POOL_HOME=options.debugPoolHome;
  if(options.startupRuntime)env.PATH=dirname(options.startupRuntime.nodePath);
  const module={exports:{} as {activate(context:unknown):Promise<ExtensionApi>;deactivate():void}};
  runInNewContext((await bundle).outputFiles[0]!.text,{module,exports:module.exports,
    require:(name:string)=>{
      if(name==='vscode')return vscode;
      if(name==='node:fs/promises'){
        const fs=requireModule(name);const runtime=options.startupRuntime;
        const manifest=runtime?join(dirname(dirname(runtime.cliPath)),'package.json'):undefined;
        return {...fs,
          realpath:async(path:string)=>{canonicalized.push(path);if(runtime){if(path===runtime.nodePath)await runtime.discoverNode?.();else if(path!==runtime.cliPath)await runtime.resolvePool?.(path);}return path;},
          stat:async(path:string)=>runtime&&[runtime.nodePath,runtime.cliPath,manifest].includes(path)?{isFile:()=>true,size:128}:fs.stat(path),
          access:async(path:string,mode?:number)=>runtime&&[runtime.nodePath,runtime.cliPath].includes(path)?undefined:fs.access(path,mode),
          readFile:async(path:string,encoding:BufferEncoding)=>runtime&&path===manifest?JSON.stringify({name:'zcode-pool',bin:{'zcode-pool':'./bin/zcode-pool.mjs'}}):fs.readFile(path,encoding),
        };
      }
      if(name==='node:child_process')return {...requireModule(name),spawn:(command:string,args:string[])=>{spawns.push({command,args});throw new Error('Process startup is blocked by the extension unit harness');}};
      if(name==='node:net')return {createConnection:(path:string)=>{
        sockets.push(path);if(!options.socketState)throw new Error('Test socket blocked');
        const socket=new EventEmitter();let destroyed=false;
        Object.assign(socket,{write:()=>true,destroy:()=>{if(!destroyed){destroyed=true;queueMicrotask(()=>socket.emit('close'));}}});
        if(options.socketState==='unavailable')queueMicrotask(()=>{if(!destroyed)socket.emit('error',new Error('ECONNREFUSED'));});
        return socket;
      }};
      return requireModule(name);
    },process:{env,platform:'linux'},Buffer,AbortController,TextEncoder,TextDecoder,structuredClone,setTimeout,clearTimeout,console,
  });
  const subscriptions:{dispose():void}[]=[];
  const api=await module.exports.activate({extensionMode:options.development||options.mock?2:1,extensionUri:uri(root),subscriptions,workspaceState:{get:(_key:string,fallback:unknown)=>fallback,update:async()=>{}}});
  return {api,commands,nativeCommands,errors,sockets,canonicalized,spawns,get panels(){return panels;},
    execute:(type:RequestType,payload:unknown={})=>api.execute({v:1,id:String(++id),generation:api.snapshot().connection.generation,type,payload} as WebviewRequest),
    changePool:async(value:string)=>{poolHome=value;await configurationChanged({affectsConfiguration:key=>key==='zcodePool.poolHome'});},
    dispose:()=>{module.exports.deactivate();for(const subscription of subscriptions)subscription.dispose();},
  };
}

for(const bad of ['relative/pool','"/isolated/quoted-pool"','/isolated/nul\0pool'])test(`invalid configured pool keeps activation and Settings usable: ${JSON.stringify(bad)}`,async()=>{
  const h=await harness({poolHome:bad});
  try{
    assert.equal(h.api.snapshot().connection.state,'error');assert.equal(h.api.snapshot().connection.poolHome,bad);
    assert.equal(h.api.snapshot().connection.error?.code,'INVALID_POOL_HOME');assert.match(h.api.snapshot().connection.error!.message,/User\/Remote Settings/);
    await h.commands.get('zcodePool.openWorkbench')!();assert.equal(h.panels,1);
    await h.commands.get('zcodePool.openSettings')!();assert.ok(h.nativeCommands.includes('workbench.action.openSettings'));
    await h.execute('ready');await assert.rejects(h.execute('connect'),{code:'INVALID_POOL_HOME'});
    await h.commands.get('zcodePool.connect')!();assert.match(h.errors.at(-1)!,/absolute pool path/);
    await h.execute('disconnect');assert.equal(h.api.snapshot().connection.error?.code,'INVALID_POOL_HOME');
    assert.deepEqual(h.canonicalized,[]);assert.deepEqual(h.sockets,[]);
    await h.changePool('/isolated/corrected-pool');
    assert.equal(h.api.snapshot().connection.state,'disconnected');assert.equal(h.api.snapshot().connection.error,null);
    assert.equal(h.api.snapshot().connection.poolHome,'/isolated/corrected-pool');assert.deepEqual(h.sockets,[]);
    await assert.rejects(h.execute('connect'),/Test socket blocked/);
    assert.deepEqual(h.sockets,['/isolated/corrected-pool/scheduler/daemon.sock']);
    await h.changePool(bad);await assert.rejects(h.execute('connect'),{code:'INVALID_POOL_HOME'});
    assert.equal(h.sockets.length,1,'An invalid replacement never opens another socket');
  }finally{h.dispose();}
});

for(const bad of ['','relative/pool','"/isolated/debug-pool"','/isolated/debug\0pool'])test(`invalid F5 pool can be corrected through host settings: ${JSON.stringify(bad)}`,async()=>{
  const h=await harness({poolHome:'/isolated/settings-pool',development:true,debugPoolHome:bad});
  try{
    assert.equal(h.api.snapshot().connection.poolHome,bad);assert.equal(h.api.snapshot().connection.error?.code,'INVALID_POOL_HOME');
    assert.match(h.api.snapshot().connection.error!.message,/ZCODE_POOL_DEBUG_POOL_HOME.*选择连接目录/);
    await h.commands.get('zcodePool.openWorkbench')!();await h.commands.get('zcodePool.openSettings')!();
    await assert.rejects(h.execute('connect'),{code:'INVALID_POOL_HOME'});
    await h.changePool('/isolated/other-settings-pool');assert.equal(h.api.snapshot().connection.state,'disconnected');assert.equal(h.api.snapshot().connection.poolHome,'/isolated/other-settings-pool');
    assert.deepEqual(h.canonicalized,['/isolated/other-settings-pool']);assert.deepEqual(h.sockets,[]);
  }finally{h.dispose();}
});

test('valid F5 input takes priority; Production ignores debug input and workspace overrides',async()=>{
  for(const development of [false,true]){
    const h=await harness({poolHome:'/isolated/settings-pool',development,debugPoolHome:development?'/isolated/debug-pool':'relative/ignored'});
    try{assert.equal(h.api.snapshot().connection.state,'disconnected');assert.equal(h.api.snapshot().connection.poolHome,development?'/isolated/debug-pool':'/isolated/settings-pool');assert.deepEqual(h.sockets,[]);}finally{h.dispose();}
  }
});

test('Mock remains independent of invalid real pool settings and debug input',async()=>{
  const h=await harness({poolHome:'invalid/real-pool',debugPoolHome:'invalid/debug-pool',mock:true});
  try{assert.equal(h.api.snapshot().connection.poolHome,'/mock/zcode-pool');await h.execute('connect');assert.equal(h.api.snapshot().connection.state,'connected');assert.deepEqual(h.canonicalized,[]);assert.deepEqual(h.sockets,[]);}finally{h.dispose();}
});


test('native connection selection replaces F5 directory without connecting',async()=>{
  const h=await harness({development:true,debugPoolHome:'/old/debug-pool',selectedPool:'/chosen/remote-pool'});
  try{await h.execute('connection.configure');assert.equal(h.api.snapshot().connection.poolHome,'/chosen/remote-pool');assert.equal(h.api.snapshot().connection.state,'disconnected');assert.deepEqual(h.sockets,[]);}finally{h.dispose();}
});
test('cancelling connection selection preserves the current directory',async()=>{
  const h=await harness({poolHome:'/existing/pool'});
  try{await h.execute('connection.configure');assert.equal(h.api.snapshot().connection.poolHome,'/existing/pool');assert.deepEqual(h.sockets,[]);}finally{h.dispose();}
});

function deferred(){
  let release:()=>void=()=>{};
  const promise=new Promise<void>(resolvePromise=>{release=resolvePromise;});
  return {promise,release};
}
const startupPaths={nodePath:'/isolated/runtime/bin/node',cliPath:'/isolated/installed/node_modules/zcode-pool/bin/zcode-pool.mjs'};

test('switching pools during PATH discovery prevents startup before the replacement resolves',async()=>{
  const discovering=deferred();const nodeReady=deferred();const poolReady=deferred();
  const nextPool='/isolated/replacement-pool';
  const h=await harness({poolHome:'/isolated/original-pool',socketState:'unavailable',startupRuntime:{...startupPaths,
    discoverNode:async()=>{discovering.release();await nodeReady.promise;},
    resolvePool:async path=>{if(path===nextPool)await poolReady.promise;},
  }});
  let rebuilding:Promise<void>|undefined;
  try{
    const starting=h.execute('daemon.start');
    const rejected=assert.rejects(starting,{code:'ABORTED'});
    await discovering.promise;
    assert.equal(h.api.snapshot().connection.error?.code,'DAEMON_UNAVAILABLE');
    rebuilding=h.changePool(nextPool);
    assert.equal(h.api.snapshot().connection.poolHome,'/isolated/original-pool','The new pool is still resolving while startup is cancelled');
    nodeReady.release();
    await rejected;
    assert.deepEqual(h.spawns,[],'No Node check or daemon command may start after the pool changes');
    poolReady.release();await rebuilding;
    assert.equal(h.api.snapshot().connection.poolHome,nextPool);
    assert.equal(h.api.snapshot().connection.state,'disconnected');
  }finally{nodeReady.release();poolReady.release();await rebuilding;h.dispose();}
});

test('deactivation during PATH discovery cannot start an installed daemon afterward',async()=>{
  const discovering=deferred();const nodeReady=deferred();
  const h=await harness({poolHome:'/isolated/pool',socketState:'unavailable',startupRuntime:{...startupPaths,
    discoverNode:async()=>{discovering.release();await nodeReady.promise;},
  }});
  try{
    const starting=h.execute('daemon.start');
    const rejected=assert.rejects(starting,{code:'ABORTED'});
    await discovering.promise;
    assert.equal(h.api.snapshot().connection.error?.code,'DAEMON_UNAVAILABLE');
    h.dispose();nodeReady.release();
    await rejected;
    assert.deepEqual(h.spawns,[],'Deactivation cancels startup before any executable runs');
  }finally{nodeReady.release();h.dispose();}
});

test('startup during a pending connection is rejected instead of reporting success',async()=>{
  const h=await harness({poolHome:'/isolated/pool',socketState:'pending',startupRuntime:startupPaths});
  try{
    const connecting=h.execute('connect');
    const cancelled=assert.rejects(connecting,{code:'ABORTED'});
    await new Promise<void>(resolveTurn=>setImmediate(resolveTurn));
    assert.equal(h.api.snapshot().connection.state,'connecting');
    await assert.rejects(h.execute('daemon.start'),{code:'ACTION_UNAVAILABLE'});
    assert.deepEqual(h.sockets,['/isolated/pool/scheduler/daemon.sock'],'Startup does not make another connection attempt');
    assert.deepEqual(h.spawns,[]);
    assert.equal(h.canonicalized.includes(startupPaths.nodePath),false,'Startup does not discover or check Node while Connect is pending');
    await h.execute('disconnect');await cancelled;
  }finally{h.dispose();}
});

test('pool replacements keep generation strictly increasing after prior connection attempts',async()=>{
  const h=await harness({poolHome:'/isolated/first-pool'});
  try{
    const initial=h.api.snapshot().connection.generation;
    await assert.rejects(h.execute('connect'),/Test socket blocked/);
    let previous=h.api.snapshot().connection.generation;
    assert.ok(previous>initial);
    for(const pool of ['/isolated/second-pool','/isolated/third-pool']){
      await h.changePool(pool);
      const current=h.api.snapshot().connection.generation;
      assert.ok(current>previous,'A rebuilt service must not reset the generation consumed by an open webview');
      assert.equal(h.api.snapshot().connection.poolHome,pool);
      await assert.rejects(h.api.execute({v:1,id:`stale-${previous}`,generation:previous,type:'connect',payload:{}}),{code:'STALE_CONNECTION'});
      await assert.rejects(h.execute('connect'),/Test socket blocked/);
      previous=h.api.snapshot().connection.generation;
      assert.ok(previous>current);
    }
  }finally{h.dispose();}
});
