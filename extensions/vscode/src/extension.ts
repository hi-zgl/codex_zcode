import * as vscode from 'vscode';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ActionService, type NativeAdapter } from './host/actions.js';
import { SocketTransport, HostError, safeError } from './host/client.js';
import { loadMockFixture, MockTransport } from './host/mock.js';
import { TaskTree } from './host/taskTree.js';
import { ResourceTree } from './host/resourceTree.js';
import { Workbench } from './host/workbench.js';
import { ArtifactDiffProvider } from './host/diffProvider.js';
import { parseRequest, type RequestType, type WebviewRequest } from './host/protocol.js';
import { findNodeExecutable, startInstalledDaemon, validateNode24 } from './host/daemon-launcher.js';
import { ensureBundledRuntime } from './host/runtime-installer.js';
import { codexMcpConfig, codexSetupDocument } from './host/codex-setup.js';
import { readConnectionProfile, writeConnectionProfile } from '../../../src/shared/connection.js';

let activeDispose:(()=>void)|undefined;
export async function activate(context:vscode.ExtensionContext):Promise<unknown>{
  const development=context.extensionMode!==vscode.ExtensionMode.Production;
  const mode=development&&process.env.ZCODE_POOL_EXTENSION_MODE==='mock'?'mock':'real';
  const authority=vscode.env.remoteName??'local';const host=`${hostname()}${vscode.env.remoteName?` (${vscode.env.remoteName})`:''}`;
  let service:ActionService;let workbench:Workbench;
  let useDebugPool=true;let startPromise:Promise<void>|undefined;let launchAbort:AbortController|undefined;let serviceRevision=0;
  const storagePath=context.globalStorageUri?.fsPath;
  const profilePath=storagePath?join(storagePath,'connection.json'):undefined;
  let preferSettings=false;let profileRequired=false;let extensionDisposed=false;let profileWatcher:FSWatcher|undefined;let profileTimer:ReturnType<typeof setTimeout>|undefined;let decisionTimer:ReturnType<typeof setTimeout>|undefined;
  function observeProfile(){
    if(!profilePath||!storagePath||profileWatcher)return;
    try{profileWatcher=watch(storagePath,(_event,file)=>{if(file?.toString()!=='connection.json')return;clearTimeout(profileTimer);profileTimer=setTimeout(()=>{void reloadProfile();},100);});profileWatcher.unref();}catch{/* Created on first explicit setup/connection. */}
  }
  async function reloadProfile(){
    if(extensionDisposed)return;
    try{const profile=profilePath?await readConnectionProfile(profilePath):null;if(profile&&profile.poolHome===service.snapshot().connection.poolHome)return;}catch{/* Rebuild into a visible configuration error. */}
    if(extensionDisposed)return;useDebugPool=false;await rebuildService();
  }
  async function saveProfile(poolHome:string,isCurrent:()=>boolean=()=>!extensionDisposed){if(profilePath){await writeConnectionProfile(profilePath,poolHome,isCurrent);profileRequired=true;observeProfile();}}
  async function bundledRuntime(){if(!storagePath)throw new HostError('STORAGE_UNAVAILABLE','Extension storage is unavailable.');return ensureBundledRuntime({extensionPath:context.extensionUri.fsPath,globalStoragePath:storagePath});}
  const diff=new ArtifactDiffProvider(()=>`${authority}|${service.snapshot().connection.poolHome}|${service.snapshot().connection.storeId}`);
  const taskTree=new TaskTree(()=>service.snapshot());const resourceTree=new ResourceTree(()=>service.snapshot());
  const status=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left,20);status.command='zcodePool.openWorkbench';status.name='ZCode Pool';status.show();
  const tasks=vscode.window.createTreeView('zcodePool.tasks',{treeDataProvider:taskTree,showCollapseAll:false});
  const resources=vscode.window.createTreeView('zcodePool.resources',{treeDataProvider:resourceTree,showCollapseAll:true});
  const visible=()=>service?.setVisible(tasks.visible||resources.visible||workbench?.visible);
  const native:NativeAdapter={
    trusted:()=>vscode.workspace.isTrusted,
    getState:<T>(key:string,fallback:T)=>context.workspaceState.get(key,fallback),
    setState:async(key,value)=>{await context.workspaceState.update(key,value);},
    pickAccountFiles:async(targetHost)=>{
      const choice=await vscode.window.showOpenDialog({defaultUri:vscode.Uri.file(join(homedir(),'.local','share','zcode-pool','imports')),title:`Import OAuth JSON on ${targetHost}. Same aliases may replace stored credentials.`,openLabel:'Import selected OAuth JSON',canSelectFiles:true,canSelectFolders:false,canSelectMany:true,filters:{'OAuth JSON':['json']}});
      if(!choice)return undefined;
      const files:string[]=[];for(const uri of choice){if(!['file','vscode-remote'].includes(uri.scheme))throw new HostError('PATH_REJECTED','Select files on the current extension host.');const path=await realpath(uri.fsPath);if(!(await lstat(path)).isFile())throw new HostError('PATH_REJECTED','Select regular OAuth JSON files.');files.push(path);}return files;
    },
    pickRepository:async(targetHost)=>{
      const choice=await vscode.window.showOpenDialog({title:`Choose the clean source repository on ${targetHost}. A separate worktree will be created.`,openLabel:'Choose source repository',canSelectFiles:false,canSelectFolders:true,canSelectMany:false});
      if(!choice?.[0])return undefined;const uri=choice[0];if(!['file','vscode-remote'].includes(uri.scheme))throw new HostError('PATH_REJECTED','Choose a repository on the current extension host.');const path=await realpath(uri.fsPath);if(!(await lstat(path)).isDirectory())throw new HostError('PATH_REJECTED','Choose a repository directory.');return path;
    },
    openDiff:(taskId,hash,file,read)=>diff.open(taskId,hash,file,read),
    openCurrentFile:async(worktreePath,relativePath)=>{
      const root=await realpath(worktreePath);const candidate=resolve(root,relativePath);const rel=relative(root,candidate);
      if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel)||(await lstat(candidate)).isSymbolicLink())throw new HostError('PATH_REJECTED','The current file path escapes the registered worktree or is a symbolic link.');
      const canonical=await realpath(candidate);const actual=relative(root,canonical);if(!actual||actual==='..'||actual.startsWith(`..${sep}`)||isAbsolute(actual)||!(await lstat(canonical)).isFile())throw new HostError('PATH_REJECTED','The current file is outside the registered worktree or is not a regular file.');
      await vscode.window.showTextDocument(vscode.Uri.file(canonical),{preview:true});
    },
    openSettings:async()=>{await vscode.commands.executeCommand('workbench.action.openSettings','@ext:zcode-pool.zcode-pool');},
    configureConnection:async()=>{
      const path=await vscode.window.showInputBox({title:'选择后台连接目录',prompt:`输入 ${host} 上的绝对目录。切换目录不会停止原有任务。`,value:service.snapshot().connection.poolHome,ignoreFocusOut:true,validateInput:value=>isAbsolute(value)&&!value.includes('\0')?null:'请输入绝对目录，不加引号或 ~。'});
      if(path===undefined)return;
      if(!isAbsolute(path)||path.includes('\0'))throw new HostError('INVALID_POOL_HOME','请输入执行侧的绝对目录。');
      useDebugPool=false;
      preferSettings=true;
      const previous=service;
      await vscode.workspace.getConfiguration('zcodePool').update('poolHome',path,vscode.ConfigurationTarget.Global);
      if(service===previous)await rebuildService();
    },
    startDaemon:()=>{if(!startPromise)startPromise=startBackend().finally(()=>{startPromise=undefined;});return startPromise;},
    codexSetup:async()=>{
      const target=service;const revision=serviceRevision;const poolHome=target.snapshot().connection.poolHome;
      if(mode!=='real'||process.platform!=='linux'||!vscode.workspace.isTrusted||!profilePath)throw new HostError('ACTION_UNAVAILABLE','请在已信任的 Linux 执行侧配置 Codex。');
      const configuredNode=vscode.workspace.getConfiguration('zcodePool').inspect<string>('daemonNodePath')?.globalValue??'';
      const current=()=>service===target&&serviceRevision===revision&&vscode.workspace.isTrusted&&!extensionDisposed&&(vscode.workspace.getConfiguration('zcodePool').inspect<string>('daemonNodePath')?.globalValue??'')===configuredNode;
      const nodePath=configuredNode||await findNodeExecutable(process.env.PATH);
      if(!nodePath)throw new HostError('INVALID_DAEMON_NODE','未找到 Node.js 24+，请配置后台 Node 路径。');
      await validateNode24(nodePath,current);
      const runtime=await bundledRuntime();
      if(!current())throw new HostError('STALE_CONNECTION','连接设置已改变，请重新生成配置。');
      await saveProfile(poolHome,current);
      const config=codexMcpConfig({nodePath,cliPath:runtime.cliPath,profilePath});
      const document=await vscode.workspace.openTextDocument({content:codexSetupDocument({config,host,poolHome,version:runtime.version}),language:'markdown'});
      await vscode.window.showTextDocument(document,{preview:false});
      return {cancelled:false};
    },
    saveInterval:async(value)=>{await vscode.workspace.getConfiguration('zcodePool').update('overviewIntervalSeconds',value,vscode.ConfigurationTarget.Global);},
    copyDiagnostics:async(value)=>{
      const doc=await vscode.workspace.openTextDocument({content:value,language:'json'});await vscode.window.showTextDocument(doc,{preview:true});
      const action=await vscode.window.showInformationMessage('Review this limited diagnostic preview. It contains host/pool identities and control IDs, with no prompt or native logs.','Copy diagnostic preview');
      if(action)await vscode.env.clipboard.writeText(value);
    },
    guidance:async(topic)=>{const messages:Record<string,string>={connection:'后台已随插件交付。选择连接目录后，生成 Codex MCP 配置即可由 Codex 调度；也可在面板启动后台并连接。执行侧需要 Node.js 24+ 和官方 ZCode runtime。',approval:'Only complete supported permission snapshots can be answered. Missing or legacy sources remain read-only. Inspect the executing native session locally when needed.',workspace:'Create a separate worktree from a clean source repository. Source and execution directories are distinct. No merge or cleanup operation is provided.',recovery:'Reconcile inspects the original execution and may update records/release proved occupancy. Resume attaches observation and may finish verification or qualified channel recovery. Inspect uncertain local processes first.'};await vscode.window.showInformationMessage(messages[topic]??messages.connection!);},
  };
  async function startBackend():Promise<void>{
    const target=service;const revision=serviceRevision;const controller=new AbortController();launchAbort=controller;
    const selected=()=>service===target&&serviceRevision===revision&&!controller.signal.aborted;
    try{
      if(mode!=='real'||process.platform!=='linux'||!vscode.workspace.isTrusted)throw new HostError('ACTION_UNAVAILABLE','启动后台需要已信任的 Linux 执行侧。');
      if(target.snapshot().connection.state==='connecting')throw new HostError('ACTION_UNAVAILABLE','正在连接，请等待本次连接结果后再启动后台。');
      try{await target.connect();if(!selected())throw new HostError('STALE_CONNECTION','连接目录已改变。');return;}catch(error){if(!(error instanceof HostError)||error.code!=='DAEMON_UNAVAILABLE')throw error;}
      if(!selected())throw new HostError('STALE_CONNECTION','连接目录已改变，请连接当前选定目录。');
      const poolHome=target.snapshot().connection.poolHome;const generation=target.generation();
      const setting=(key:string)=>vscode.workspace.getConfiguration('zcodePool').inspect<string>(key)?.globalValue??'';
      const configuredNode=setting('daemonNodePath'),configuredCli=setting('daemonCliPath');
      const current=()=>selected()&&target.generation()===generation&&setting('daemonNodePath')===configuredNode&&setting('daemonCliPath')===configuredCli;
      const nodePath=configuredNode||await findNodeExecutable(process.env.PATH);
      if(!nodePath)throw new HostError('DAEMON_NOT_INSTALLED','未找到 Node.js。请在远程设置中配置 zcodePool.daemonNodePath，指向 Node.js 24+。');
      const cliPath=configuredCli||(await bundledRuntime()).cliPath;
      if(!current())throw new HostError('ABORTED','连接设置已改变，启动已取消。');
      await saveProfile(poolHome,current);
      await startInstalledDaemon({poolHome,nodePath,cliPath,trusted:()=>vscode.workspace.isTrusted,isCurrent:current,signal:controller.signal});
      if(!current())throw new HostError('STALE_CONNECTION','连接设置已改变，请连接当前选定目录。');
      await target.connect();
    }finally{if(launchAbort===controller)launchAbort=undefined;}
  }
  let lastGeneration=-1;let taskTreeKey='';let resourceTreeKey='';let contextKey='';
  const notifiedDecisions=new Set<string>();
  const update=()=>{
    const state=service.snapshot();
    if(mode==='real'&&state.connection.state==='connected'&&!state.connection.stale){
      const visibleDecisions=state.workOverview?.works.flatMap(work=>work.todos.map(todo=>({workId:work.workId,goal:work.goal,todo})))??[];
      const pending=[...new Map([...(state.decisionTodos??[]),...visibleDecisions].map(item=>[item.todo.todoId,item])).values()].filter(({todo})=>['resource_shortage','all_accounts_low','integration_conflict','decision'].includes(todo.kind));
      const current=new Set(pending.map(({todo})=>`${state.connection.storeId}:${todo.todoId}`));
      for(const key of notifiedDecisions)if(!current.has(key))notifiedDecisions.delete(key);
      for(const {workId,goal,todo} of pending){const storeId=state.connection.storeId;const key=`${storeId}:${todo.todoId}`;if(notifiedDecisions.has(key))continue;notifiedDecisions.add(key);
        void vscode.window.showWarningMessage(`ZCode 需要决定：${todo.summary}（${goal}）`,'查看待办').then(async action=>{if(action==='查看待办'&&service.snapshot().connection.storeId===storeId){try{await service.focusWork(workId);workbench.show();}catch(error){await vscode.window.showErrorMessage(safeError(error).message);}}});
      }
    }
    const nextTasks=JSON.stringify([state.connection.state,state.tasks]);
    const nextResources=JSON.stringify([state.resources.workers,state.resources.accounts,state.resources.workspaces]);
    if(nextTasks!==taskTreeKey){taskTreeKey=nextTasks;taskTree.refresh();}
    if(nextResources!==resourceTreeKey){resourceTreeKey=nextResources;resourceTree.refresh();}
    workbench?.push(state);
    if(lastGeneration!==state.connection.generation){diff.clear();lastGeneration=state.connection.generation;}
    const connected=['connected','legacy-readonly'].includes(state.connection.state);
    const canMutate=connected&&state.connection.trusted&&!state.connection.stale&&state.connection.state!=='legacy-readonly';
    const nextContext=`${connected}|${canMutate}`;
    if(nextContext!==contextKey){contextKey=nextContext;void vscode.commands.executeCommand('setContext','zcodePool.connected',connected);void vscode.commands.executeCommand('setContext','zcodePool.canMutate',canMutate);}
    const attention=state.tasks.filter(t=>t.status==='waiting_approval'||t.status==='interrupted'||t.leaseHeld&&['failed','cancelled'].includes(t.status)||t.deliveryReview==='pending').length+(state.workOverview?.works.reduce((count,work)=>count+work.todos.length,0)??0);
    const connectionLabels:Record<string,string>={connected:'已连接','legacy-readonly':'兼容只读',disconnected:'未连接',connecting:'连接中',error:'连接异常'};
    status.text=`$(server-process) ZCode ${connectionLabels[state.connection.state]??state.connection.state}${attention?` · ${attention} 项待处理`:''}${state.connection.stale?' · 待刷新':''}${mode==='mock'?' · 演示':''}`;
    status.tooltip=`${host}\n${state.connection.poolHome}\nLoaded scope: ${state.scope}. Opening does not execute work.`;
  };
  async function createService(initialGeneration=0):Promise<ActionService>{
    const creatingRevision=serviceRevision;
    // Machine-scope settings deliberately ignore workspace/folder overrides.
    const inspected=vscode.workspace.getConfiguration('zcodePool').inspect<string>('poolHome');
    const debugPoolHome=development&&mode==='real'&&useDebugPool?process.env.ZCODE_POOL_DEBUG_POOL_HOME:undefined;
    let configured=debugPoolHome??inspected?.globalValue??'';let profileError:HostError|undefined;
    if(mode==='real'&&profilePath&&debugPoolHome===undefined&&!preferSettings){try{const profile=await readConnectionProfile(profilePath);if(profile){configured=profile.poolHome;profileRequired=true;}else if(profileRequired)throw new Error('missing');}catch{profileError=new HostError('INVALID_CONNECTION_PROFILE','连接资料缺失或损坏，请检查共享 connection.json。');}}
    let configurationError=profileError??(mode==='real'&&(configured!==''||debugPoolHome!==undefined)&&(!isAbsolute(configured)||configured.includes('\0'))?new HostError('INVALID_POOL_HOME',debugPoolHome!==undefined?'ZCODE_POOL_DEBUG_POOL_HOME must be an absolute path. Use 选择连接目录 or change host User/Remote Settings to correct it without restarting F5.':'Set zcodePool.poolHome to an absolute pool path without quotes or NUL characters in host User/Remote Settings, then Connect.'):undefined);
    // Keep invalid input visible; never resolve it or substitute another pool.
    const requested=configurationError?configured:resolve(configured||join(homedir(),'.zcode_pool'));
    const poolHome=mode==='mock'?'/mock/zcode-pool':configurationError?requested:await realpath(requested).catch(()=>requested);
    if(preferSettings&&mode==='real'&&!configurationError){try{await saveProfile(poolHome,()=>creatingRevision===serviceRevision&&!extensionDisposed);preferSettings=false;}catch{configurationError=new HostError('INVALID_CONNECTION_PROFILE','无法保存共享连接资料，请检查 connection.json 路径和写入权限。');}}
    return new ActionService({mode,poolHome,host,authority,native,configurationError,initialGeneration,onSnapshot:update,projectContext:()=>({workspaceFolderPaths:(vscode.workspace.workspaceFolders??[]).filter(folder=>['file','vscode-remote'].includes(folder.uri.scheme)).map(folder=>folder.uri.fsPath),activeFilePath:vscode.window.activeTextEditor&&['file','vscode-remote'].includes(vscode.window.activeTextEditor.document.uri.scheme)?vscode.window.activeTextEditor.document.uri.fsPath:null}),supported:mode==='mock'||process.platform==='linux',environmentReason:process.platform==='linux'?undefined:'Real daemon connections require a Linux workspace extension host.',overviewIntervalSeconds:vscode.workspace.getConfiguration('zcodePool').get('overviewIntervalSeconds',30),createTransport:async()=>{
      if(configurationError)throw configurationError;
      if(mode==='mock'){
        const fixture=process.env.ZCODE_POOL_UI_FIXTURE??vscode.Uri.joinPath(context.extensionUri,'test','fixtures','pool-demo.json').fsPath;
        return new MockTransport(await loadMockFixture(fixture));
      }
      if(process.platform!=='linux')throw new HostError('UNSUPPORTED_PLATFORM','Real daemon connections require a Linux workspace extension host.');
      return new SocketTransport(poolHome);
    }});
  }
  async function rebuildService():Promise<void>{
    if(extensionDisposed)return;
    const revision=++serviceRevision;launchAbort?.abort();service.dispose();diff.clear();
    const replacement=await createService(service.generation()+1);
    if(revision!==serviceRevision){replacement.dispose();return;}
    service=replacement;visible();update();
  }
  service=await createService();
  workbench=new Workbench(context.extensionUri,()=>service,visible,()=>diff.clear());
  const watchDecisions=()=>{if(mode!=='real'||extensionDisposed)return;decisionTimer=setTimeout(()=>{if(!tasks.visible&&!resources.visible&&!workbench.visible)void service.refreshDecisions();watchDecisions();},30000);decisionTimer.unref?.();};watchDecisions();
  const execute=async(type:RequestType,payload:unknown={})=>service.execute(parseRequest({v:1,id:randomUUID(),generation:service.generation(),type,payload}));
  const register=(name:string,handler:(arg?:unknown)=>unknown)=>context.subscriptions.push(vscode.commands.registerCommand(`zcodePool.${name}`,async(arg?:unknown)=>{try{return await handler(arg);}catch(error){const safe=safeError(error);await vscode.window.showErrorMessage(safe.message);return undefined;}}));
  const taskId=async(arg:unknown)=>{
    if(arg!==undefined){if(arg&&typeof arg==='object'&&!(arg instanceof vscode.TreeItem)&&Object.keys(arg).some(key=>key!=='taskId'))throw new HostError('INVALID_ARGUMENT','Task commands accept only a task identifier.');const value=arg&&typeof arg==='object'&&'taskId' in arg?arg.taskId:typeof arg==='string'?arg:undefined;if(typeof value!=='string'||!value||value.length>150||value.includes('\0')||arg instanceof vscode.TreeItem&&!service.snapshot().tasks.some(task=>task.taskId===value))throw new HostError('INVALID_ARGUMENT','Pass a valid task identifier from the current pool.');await service.selectTask(value);return value;}
    const choice=await vscode.window.showQuickPick(service.snapshot().tasks.map(task=>({label:task.taskId,description:`${task.status}${task.leaseHeld?' · occupancy retained':''}`})),{title:'Select an explicitly identified task'});return choice?.label;
  };
  const workerId=async(arg:unknown)=>{
    if(arg!==undefined){if(arg&&typeof arg==='object'&&!(arg instanceof vscode.TreeItem)&&Object.keys(arg).some(key=>key!=='workerId'))throw new HostError('INVALID_ARGUMENT','Worker commands accept only a worker identifier.');const value=arg&&typeof arg==='object'&&'workerId' in arg?arg.workerId:typeof arg==='string'?arg:undefined;if(typeof value!=='string'||!service.snapshot().resources.workers.some(w=>w.workerId===value))throw new HostError('INVALID_ARGUMENT','Select a worker from the current pool.');return value;}
    const choice=await vscode.window.showQuickPick(service.snapshot().resources.workers.map(w=>({label:w.workerId,description:`${w.state} · ${w.accountAlias} · native ${w.runningTaskCount??'unknown'} · leases ${w.leaseTaskIds.length}`})),{title:'Select a worker on the current host'});return choice?.label;
  };
  register('openWorkbench',()=>{workbench.show();const attention=service.snapshot().tasks.find(t=>t.status==='waiting_approval'||t.status==='interrupted');if(attention)return service.selectTask(attention.taskId);});
  register('connect',()=>execute('connect'));
  register('configureConnection',()=>execute('connection.configure'));
  register('setupCodex',()=>execute('connection.codexSetup'));
  register('startDaemon',()=>execute('daemon.start'));
  register('shutdownPool',()=>execute('pool.shutdown'));
  register('disconnect',()=>{diff.clear();return execute('disconnect');});
  register('refresh',()=>execute('refresh'));
  register('openTask',async arg=>{const id=await taskId(arg);if(id){workbench.show();return execute('task.select',{taskId:id});}});
  register('newTask',()=>{workbench.show();service.state.notice='Open New Task to review the execution worktree, worker, model, session and verification policy before dispatch.';update();});
  register('createWorkspace',async()=>{const baseRef=await vscode.window.showInputBox({title:'Create an isolated workspace from a clean source repository',prompt:'Base Git ref (source folder picker follows)',value:'HEAD',ignoreFocusOut:true});if(baseRef)return execute('workspace.create',{baseRef});});
  register('importAccounts',()=>execute('accounts.import'));
  register('startWorker',async()=>{const account=await vscode.window.showQuickPick(service.snapshot().resources.accounts.filter(a=>!['blocked','invalid','cooling'].includes(a.health)).map(a=>({label:a.alias,description:`${a.provider} · ${a.health}`})),{title:'Account for a new isolated worker'});if(!account)return;const id=await vscode.window.showInputBox({title:'New Worker ID',validateInput:value=>/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)?null:'Use 1–64 letters, digits, underscores or hyphens.'});if(id)return execute('worker.start',{workerId:id,accountAlias:account.label});});
  register('stopWorker',async arg=>{const id=await workerId(arg);if(id)return execute('worker.stop',{workerId:id});});
  register('probeWorker',async arg=>{const id=await workerId(arg);if(id)return execute('worker.probe',{workerId:id});});
  for(const [command,type]of [['cancelTask','cancel'],['reconcileTask','reconcile'],['resumeTask','resume']]as const)register(command,async arg=>{const id=await taskId(arg);if(id)return execute(type,{taskId:id});});
  register('respondApproval',async arg=>{const id=await taskId(arg);if(id){workbench.show();return execute('approvals.list',{taskId:id});}});
  register('openDiff',async arg=>{const id=await taskId(arg);if(!id)return;workbench.show();await execute('task.select',{taskId:id});await execute('artifacts.list',{taskId:id});const choice=await vscode.window.showQuickPick(service.snapshot().delivery.files.map(file=>({label:file.displayPath,description:file.nativeDiff.available?file.change:file.nativeDiff.reason??'Unavailable',file})),{title:'Immutable base → delivery Diff (cumulative from workspace base)'});if(choice&&service.snapshot().delivery.manifest?.manifestSha256)return execute('diff.open',{taskId:id,manifestSha256:service.snapshot().delivery.manifest!.manifestSha256,fileId:choice.file.fileId});});
  register('openSettings',()=>execute('settings.open'));
  context.subscriptions.push(tasks,resources,taskTree,resourceTree,status,diff,workbench,
    tasks.onDidChangeVisibility(visible),resources.onDidChangeVisibility(visible),vscode.workspace.onDidGrantWorkspaceTrust(()=>service.trustChanged()),
    vscode.window.onDidChangeActiveTextEditor(()=>update()),vscode.workspace.onDidChangeWorkspaceFolders(()=>update()),
    vscode.workspace.onDidCloseTextDocument(doc=>diff.release(doc.uri)),
    vscode.workspace.onDidChangeConfiguration(async event=>{
      if(event.affectsConfiguration('zcodePool.poolHome')){useDebugPool=false;preferSettings=true;await rebuildService();}
      if(event.affectsConfiguration('zcodePool.daemonNodePath')||event.affectsConfiguration('zcodePool.daemonCliPath'))launchAbort?.abort();
      if(event.affectsConfiguration('zcodePool.overviewIntervalSeconds'))service.setOverviewInterval(vscode.workspace.getConfiguration('zcodePool').get('overviewIntervalSeconds',30));
    }),{dispose:()=>{launchAbort?.abort();service.dispose();}});
  activeDispose=()=>{extensionDisposed=true;serviceRevision++;profileWatcher?.close();clearTimeout(profileTimer);clearTimeout(decisionTimer);launchAbort?.abort();service.dispose();workbench.dispose();diff.dispose();};observeProfile();update();visible();
  return {snapshot:()=>service.snapshot(),execute:async(request:WebviewRequest)=>service.execute(parseRequest(request)),show:()=>workbench.show()};
}
export function deactivate():void{activeDispose?.();activeDispose=undefined;}
