import * as vscode from 'vscode';
import type { UiSnapshot } from './types.js';
export class ResourceTree implements vscode.TreeDataProvider<vscode.TreeItem>,vscode.Disposable{
  private readonly changed=new vscode.EventEmitter<vscode.TreeItem|undefined>();readonly onDidChangeTreeData=this.changed.event;
  constructor(private readonly snapshot:()=>UiSnapshot){}
  refresh():void{this.changed.fire(undefined);}
  getTreeItem(item:vscode.TreeItem):vscode.TreeItem{return item;}
  getChildren(parent?:vscode.TreeItem):vscode.TreeItem[]{
    const {resources}=this.snapshot();
    if(!parent)return ['Workers','Accounts','Workspaces'].map(label=>{const item=new vscode.TreeItem(label,vscode.TreeItemCollapsibleState.Expanded);item.id=label;return item;});
    if(parent.id==='Workers')return resources.workers.map(worker=>{const item=new vscode.TreeItem(worker.workerId);item.id=`worker:${worker.workerId}`;item.contextValue=worker.state==='ready'?'worker.ready':'worker.other';item.description=`${worker.state} · native ${worker.runningTaskCount??'unknown'} · leases ${worker.leaseTaskIds.length}`;item.tooltip=`Account ${worker.accountAlias}\n${worker.leaseTaskIds.length?`Held by ${worker.leaseTaskIds.join(', ')}`:'Ready does not prove that the worker is idle.'}`;item.iconPath=new vscode.ThemeIcon('server-process');(item as vscode.TreeItem&{workerId:string}).workerId=worker.workerId;return item;});
    if(parent.id==='Accounts')return resources.accounts.map(account=>{const item=new vscode.TreeItem(account.alias);item.id=`account:${account.alias}`;item.description=`${account.provider} · ${account.health}`;item.contextValue='account';item.iconPath=new vscode.ThemeIcon('account');return item;});
    if(parent.id==='Workspaces')return resources.workspaces.map(workspace=>{const item=new vscode.TreeItem(workspace.workspaceId);item.id=`workspace:${workspace.workspaceId}`;item.description=`${workspace.branch}${workspace.activeTaskId?' · occupied':''}`;item.contextValue='workspace';item.tooltip=`Source: ${workspace.repositoryPath}\nWorktree: ${workspace.worktreePath}\nBase: ${workspace.baseCommit}\nHeld by: ${workspace.activeTaskId??'none reported'}`;item.iconPath=new vscode.ThemeIcon('repo');return item;});
    return [];
  }
  dispose():void{this.changed.dispose();}
}
