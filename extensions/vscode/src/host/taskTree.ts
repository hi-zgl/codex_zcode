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
    const state=this.snapshot();if(!state.tasks.length){const connected=['connected','legacy-readonly'].includes(state.connection.state);const item=new vscode.TreeItem(connected?'暂无任务 · 打开工作台':'打开工作台并连接');item.contextValue='empty';item.iconPath=new vscode.ThemeIcon('dashboard');item.command={command:'zcodePool.openWorkbench',title:'打开工作台'};return [item];}
    return state.tasks.map(task=>this.item(task));
  }
  private item(task:UiTask):vscode.TreeItem{
    const labels:Record<string,string>={queued:'排队中',dispatching:'派发中',running:'执行中',waiting_approval:'等待审批',verifying:'核验中',succeeded:'已完成',failed:'失败',cancelled:'已取消',blocked:'受阻',interrupted:'待核对'};
    const item=new vscode.TreeItem(task.taskId);item.id=task.taskId;item.description=`${labels[task.status]??task.status}${task.leaseHeld?' · 占用中':''}`;
    (item as vscode.TreeItem&{taskId:string}).taskId=task.taskId;
    item.contextValue=active.has(task.status)?'task.active':task.leaseHeld||task.status==='interrupted'?'task.uncertain':'task.finished';
    const glyph=taskStatusIcon(task.status);item.iconPath=new vscode.ThemeIcon(glyph.id,glyph.color?new vscode.ThemeColor(glyph.color):undefined);
    item.command={command:'zcodePool.openTask',title:'Open task',arguments:[{taskId:task.taskId}]};
    item.tooltip=`Task ${task.taskId}\n${task.status}\nWorker: ${task.workerId??'unassigned'}\nWorkspace: ${task.workspaceId}\nRevision: ${task.revision}\n${task.leaseHeld?'Occupancy retained.':''}`;
    item.accessibilityInformation={label:`Task ${task.taskId}, ${task.status}${task.leaseHeld?', occupancy retained':''}`};return item;
  }
  dispose():void{this.changed.dispose();}
}

/** Codicon + theme color per task status; mirrors the Webview status badges. */
export function taskStatusIcon(status:string):{id:string;color?:string}{
  switch(status){
    case 'queued':return {id:'watch'};
    case 'dispatching':case 'running':case 'verifying':return {id:'loading~spin',color:'charts.blue'};
    case 'waiting_approval':return {id:'shield',color:'editorWarning.foreground'};
    case 'succeeded':return {id:'pass',color:'testing.iconPassed'};
    case 'failed':return {id:'error',color:'testing.iconFailed'};
    case 'blocked':return {id:'circle-slash',color:'editorWarning.foreground'};
    case 'interrupted':return {id:'debug-disconnect',color:'editorWarning.foreground'};
    case 'cancelled':return {id:'circle-slash'};
    default:return {id:'circle-outline'};
  }
}
