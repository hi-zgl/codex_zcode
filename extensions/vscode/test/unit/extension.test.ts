import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {build} from 'esbuild';
import type {UiSnapshot} from '../../src/host/types.js';
import type {RequestType,WebviewRequest} from '../../src/host/protocol.js';

const root=resolve(__dirname,'../..');
const requireModule=createRequire(join(root,'package.json'));
const bundle=build({absWorkingDir:root,entryPoints:['src/extension.ts'],bundle:true,write:false,platform:'node',format:'cjs',target:'node20',external:['vscode'],alias:{zod:join(root,'node_modules/zod')}});
interface ExtensionApi {snapshot():UiSnapshot;execute(request:WebviewRequest):Promise<unknown>}
async function harness(options:{poolHome?:string;debugPoolHome?:string;development?:boolean;mock?:boolean}={}){
  let poolHome=options.poolHome;
  let configurationChanged:(event:{affectsConfiguration(key:string):boolean})=>Promise<void>=async()=>{};
  const commands=new Map<string,(arg?:unknown)=>unknown>();
  const nativeCommands:string[]=[];const errors:string[]=[];const sockets:string[]=[];const canonicalized:string[]=[];
  let panels=0;let id=0;
  const disposable=()=>({dispose(){}});const event=()=>disposable();
  const uri=(fsPath:string)=>({fsPath,toString:()=>fsPath});
  const vscode={
    ExtensionMode:{Production:1},StatusBarAlignment:{Left:1},ViewColumn:{One:1},ConfigurationTarget:{Global:1},
    EventEmitter:class{event=event;fire(){}dispose(){}},TreeItem:class{},
    Uri:{joinPath:(base:{fsPath:string},...parts:string[])=>uri(join(base.fsPath,...parts))},
    env:{remoteName:'ssh-remote'},
    workspace:{isTrusted:true,workspaceFolders:[],
      getConfiguration:()=>({inspect:()=>({globalValue:poolHome,workspaceValue:'/workspace/must-not-be-used'}),get:()=>30}),
      registerTextDocumentContentProvider:disposable,onDidGrantWorkspaceTrust:event,onDidChangeWorkspaceFolders:event,onDidCloseTextDocument:event,
      onDidChangeConfiguration:(listener:typeof configurationChanged)=>{configurationChanged=listener;return disposable();},
    },
    commands:{registerCommand:(name:string,handler:(arg?:unknown)=>unknown)=>{commands.set(name,handler);return disposable();},executeCommand:async(name:string,...args:unknown[])=>{const handler=commands.get(name);if(handler)return handler(args[0]);nativeCommands.push(name);}},
    window:{
      createStatusBarItem:()=>({...disposable(),show(){}}),createTreeView:()=>({...disposable(),visible:false,onDidChangeVisibility:event}),
      onDidChangeActiveTextEditor:event,showErrorMessage:async(message:string)=>{errors.push(message);},
      createWebviewPanel:()=>{panels++;return {...disposable(),visible:true,reveal(){},onDidChangeViewState:event,onDidDispose:event,webview:{cspSource:'test',asWebviewUri:(value:unknown)=>value,onDidReceiveMessage:event,postMessage:async()=>true}};},
    },
  };
  const env:Record<string,string>={ZCODE_POOL_EXTENSION_MODE:options.mock?'mock':'real',ZCODE_POOL_UI_FIXTURE:join(root,'test/fixtures/pool-demo.json')};
  if(options.debugPoolHome!==undefined)env.ZCODE_POOL_DEBUG_POOL_HOME=options.debugPoolHome;
  const module={exports:{} as {activate(context:unknown):Promise<ExtensionApi>;deactivate():void}};
  runInNewContext((await bundle).outputFiles[0]!.text,{module,exports:module.exports,
    require:(name:string)=>{
      if(name==='vscode')return vscode;
      if(name==='node:fs/promises')return {...requireModule(name),realpath:async(path:string)=>{canonicalized.push(path);return path;}};
      if(name==='node:net')return {createConnection:(path:string)=>{sockets.push(path);throw new Error('Test socket blocked');}};
      return requireModule(name);
    },process:{env,platform:'linux'},Buffer,AbortController,TextEncoder,TextDecoder,structuredClone,setTimeout,clearTimeout,console,
  });
  const subscriptions:{dispose():void}[]=[];
  const api=await module.exports.activate({extensionMode:options.development||options.mock?2:1,extensionUri:uri(root),subscriptions,workspaceState:{get:(_key:string,fallback:unknown)=>fallback,update:async()=>{}}});
  return {api,commands,nativeCommands,errors,sockets,canonicalized,get panels(){return panels;},
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

for(const bad of ['','relative/pool','"/isolated/debug-pool"','/isolated/debug\0pool'])test(`invalid F5 pool requires a fresh absolute debug input: ${JSON.stringify(bad)}`,async()=>{
  const h=await harness({poolHome:'/isolated/settings-pool',development:true,debugPoolHome:bad});
  try{
    assert.equal(h.api.snapshot().connection.poolHome,bad);assert.equal(h.api.snapshot().connection.error?.code,'INVALID_POOL_HOME');
    assert.match(h.api.snapshot().connection.error!.message,/ZCODE_POOL_DEBUG_POOL_HOME.*restart F5.*absolute pool path without quotes.*Settings does not override/);
    await h.commands.get('zcodePool.openWorkbench')!();await h.commands.get('zcodePool.openSettings')!();
    await assert.rejects(h.execute('connect'),{code:'INVALID_POOL_HOME'});
    await h.changePool('/isolated/other-settings-pool');await assert.rejects(h.execute('connect'),{code:'INVALID_POOL_HOME'});
    assert.deepEqual(h.canonicalized,[]);assert.deepEqual(h.sockets,[]);
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
