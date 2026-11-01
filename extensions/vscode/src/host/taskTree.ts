import * as vscode from 'vscode';
import type { UiSnapshot, UiTask } from './types.js';
const active=new Set(['queued','dispatching','running','waiting_approval','verifying']);
export class TaskTree implements vscode.TreeDataProvider<vscode.TreeItem>,vscode.Disposable {
  private readonly changed=new vscode.EventEmitter<vscode.TreeItem|undefined>();
  readonly onDidChangeTreeData=this.changed.event;
  constructor(private readonly snapshot:()=>UiSnapshot){}
  refresh():void{this.changed.fire(undefined);}
  getTreeItem(item:vscode.TreeItem):vscode.TreeItem{return item;}
  getChildren():vscode.TreeItem[]{
    const state=this.snapshot();if(!state.tasks.length){const item=new vscode.TreeItem(state.connection.state==='disconnected'?'Connect to load tasks':'No tasks in the loaded scope');item.contextValue='empty';return [item];}
    return state.tasks.map(task=>this.item(task));
  }
  private item(task:UiTask):vscode.TreeItem{
    const item=new vscode.TreeItem(task.taskId);item.id=task.taskId;item.description=`${task.status}${task.leaseHeld?' · lease held':''}`;
    (item as vscode.TreeItem&{taskId:string}).taskId=task.taskId;
    item.contextValue=active.has(task.status)?'task.active':task.leaseHeld||task.status==='interrupted'?'task.uncertain':'task.finished';
    item.iconPath=new vscode.ThemeIcon(task.status==='waiting_approval'?'shield':task.status==='succeeded'?'pass':task.leaseHeld?'circle-filled':'circle-outline');
    item.command={command:'zcodePool.openTask',title:'Open task',arguments:[{taskId:task.taskId}]};
    item.tooltip=`Task ${task.taskId}\n${task.status}\nWorker: ${task.workerId??'unassigned'}\nWorkspace: ${task.workspaceId}\nRevision: ${task.revision}\n${task.leaseHeld?'Occupancy retained.':''}`;
    item.accessibilityInformation={label:`Task ${task.taskId}, ${task.status}${task.leaseHeld?', occupancy retained':''}`};return item;
  }
  dispose():void{this.changed.dispose();}
}
