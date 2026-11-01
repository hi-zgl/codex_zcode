import * as vscode from 'vscode';
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ActionService, type NativeAdapter } from './host/actions.js';
import { SocketTransport, HostError, safeError } from './host/client.js';
import { loadMockFixture, MockTransport } from './host/mock.js';
import { TaskTree } from './host/taskTree.js';
import { ResourceTree } from './host/resourceTree.js';
import { Workbench } from './host/workbench.js';
import { ArtifactDiffProvider } from './host/diffProvider.js';
import { parseRequest, type RequestType, type WebviewRequest } from './host/protocol.js';

let activeDispose:(()=>void)|undefined;
export async function activate(context:vscode.ExtensionContext):Promise<unknown>{
  const development=context.extensionMode!==vscode.ExtensionMode.Production;
  const mode=development&&process.env.ZCODE_POOL_EXTENSION_MODE==='mock'?'mock':'real';
  const authority=vscode.env.remoteName??'local';const host=`${hostname()}${vscode.env.remoteName?` (${vscode.env.remoteName})`:''}`;
  let service:ActionService;let workbench:Workbench;
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
      const choice=await vscode.window.showOpenDialog({title:`Import OAuth JSON on ${targetHost}. Same aliases may replace stored credentials.`,openLabel:'Import selected OAuth JSON',canSelectFiles:true,canSelectFolders:false,canSelectMany:true,filters:{'OAuth JSON':['json']}});
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
    saveInterval:async(value)=>{await vscode.workspace.getConfiguration('zcodePool').update('overviewIntervalSeconds',value,vscode.ConfigurationTarget.Global);},
    copyDiagnostics:async(value)=>{
      const doc=await vscode.workspace.openTextDocument({content:value,language:'json'});await vscode.window.showTextDocument(doc,{preview:true});
      const action=await vscode.window.showInformationMessage('Review this limited diagnostic preview. It contains host/pool identities and control IDs, with no prompt or native logs.','Copy diagnostic preview');
      if(action)await vscode.env.clipboard.writeText(value);
    },
    guidance:async(topic)=>{const messages:Record<string,string>={connection:'Start a separately installed daemon on the same Linux host, then Connect. The extension never installs or starts the daemon.',approval:'Only complete supported permission snapshots can be answered. Missing or legacy sources remain read-only. Inspect the executing native session locally when needed.',workspace:'Create a separate worktree from a clean source repository. Source and execution directories are distinct. No merge or cleanup operation is provided.',recovery:'Reconcile inspects the original execution and may update records/release proved occupancy. Resume attaches observation and may finish verification or qualified bounded busy continuation. Inspect uncertain local processes first.'};await vscode.window.showInformationMessage(messages[topic]??messages.connection!);},
  };
  let lastGeneration=-1;
  const update=()=>{
    const state=service.snapshot();taskTree.refresh();resourceTree.refresh();workbench?.push(state);
    if(lastGeneration!==state.connection.generation){diff.clear();lastGeneration=state.connection.generation;}
    const connected=['connected','legacy-readonly'].includes(state.connection.state);
    void vscode.commands.executeCommand('setContext','zcodePool.connected',connected);
    void vscode.commands.executeCommand('setContext','zcodePool.canMutate',connected&&state.connection.trusted&&!state.connection.stale&&state.connection.state!=='legacy-readonly');
    const attention=state.tasks.filter(t=>t.status==='waiting_approval'||t.status==='interrupted'||t.leaseHeld&&['failed','cancelled'].includes(t.status)||t.deliveryReview==='pending').length;
    status.text=`$(server-process) ZCode ${state.connection.state}${attention?` · ${attention} loaded need attention`:''}${state.connection.stale?' · stale':''}${mode==='mock'?' · MOCK':''}`;
    status.tooltip=`${host}\n${state.connection.poolHome}\nLoaded scope: ${state.scope}. Opening does not execute work.`;
  };
  async function createService():Promise<ActionService>{
    // Machine-scope settings deliberately ignore workspace/folder overrides.
    const inspected=vscode.workspace.getConfiguration('zcodePool').inspect<string>('poolHome');
    const debugPoolHome=development&&mode==='real'?process.env.ZCODE_POOL_DEBUG_POOL_HOME:undefined;
    const configured=debugPoolHome??inspected?.globalValue??'';
    const configurationError=mode==='real'&&(configured!==''||debugPoolHome!==undefined)&&(!isAbsolute(configured)||configured.includes('\0'))?new HostError('INVALID_POOL_HOME',debugPoolHome!==undefined?'ZCODE_POOL_DEBUG_POOL_HOME must be an absolute path on the extension host without NUL characters. Stop debugging and restart F5; enter an absolute pool path without quotes. Changing Settings does not override this debug input.':'Set zcodePool.poolHome to an absolute pool path without quotes or NUL characters in host User/Remote Settings, then Connect.'):undefined;
    // Keep invalid input visible; never resolve it or substitute another pool.
    const requested=configurationError?configured:resolve(configured||join(homedir(),'.zcode_pool'));
    const poolHome=mode==='mock'?'/mock/zcode-pool':configurationError?requested:await realpath(requested).catch(()=>requested);
    return new ActionService({mode,poolHome,host,authority,native,configurationError,onSnapshot:update,projectContext:()=>({workspaceFolderPaths:(vscode.workspace.workspaceFolders??[]).filter(folder=>['file','vscode-remote'].includes(folder.uri.scheme)).map(folder=>folder.uri.fsPath),activeFilePath:vscode.window.activeTextEditor&&['file','vscode-remote'].includes(vscode.window.activeTextEditor.document.uri.scheme)?vscode.window.activeTextEditor.document.uri.fsPath:null}),supported:mode==='mock'||process.platform==='linux',environmentReason:process.platform==='linux'?undefined:'Real daemon connections require a Linux workspace extension host.',overviewIntervalSeconds:vscode.workspace.getConfiguration('zcodePool').get('overviewIntervalSeconds',30),createTransport:async()=>{
      if(configurationError)throw configurationError;
      if(mode==='mock'){
        const fixture=process.env.ZCODE_POOL_UI_FIXTURE??vscode.Uri.joinPath(context.extensionUri,'test','fixtures','pool-demo.json').fsPath;
        return new MockTransport(await loadMockFixture(fixture));
      }
      if(process.platform!=='linux')throw new HostError('UNSUPPORTED_PLATFORM','Real daemon connections require a Linux workspace extension host.');
      return new SocketTransport(poolHome);
    }});
  }
  service=await createService();
  workbench=new Workbench(context.extensionUri,()=>service,visible,()=>diff.clear());
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
      if(event.affectsConfiguration('zcodePool.poolHome')){service.dispose();diff.clear();service=await createService();visible();update();}
      if(event.affectsConfiguration('zcodePool.overviewIntervalSeconds')){service.state.overviewIntervalSeconds=vscode.workspace.getConfiguration('zcodePool').get('overviewIntervalSeconds',30);update();}
    }),{dispose:()=>service.dispose()});
  activeDispose=()=>{service.dispose();workbench.dispose();diff.dispose();};update();visible();
  return {snapshot:()=>service.snapshot(),execute:async(request:WebviewRequest)=>service.execute(parseRequest(request)),show:()=>workbench.show()};
}
export function deactivate():void{activeDispose?.();activeDispose=undefined;}
