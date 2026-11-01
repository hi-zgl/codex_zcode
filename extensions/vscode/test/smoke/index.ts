import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import {randomUUID}from'node:crypto';
export async function run():Promise<void>{
  const extension=vscode.extensions.getExtension('zcode-pool.zcode-pool');assert.ok(extension);const api=await extension.activate();
  const commands=await vscode.commands.getCommands(true);const manifest=extension.packageJSON;
  for(const command of manifest.contributes.commands)assert.ok(commands.includes(command.command),`Command registered: ${command.command}`);
  assert.equal(api.snapshot().connection.state,'disconnected');assert.equal(api.snapshot().tasks.length,0);assert.equal(api.snapshot().connection.mode,'mock');
  const exec=(type:string,payload:unknown={})=>api.execute({v:1,id:randomUUID(),generation:api.snapshot().connection.generation,type,payload});
  await vscode.commands.executeCommand('zcodePool.openWorkbench');await vscode.commands.executeCommand('workbench.view.extension.zcodePool');
  assert.equal(api.snapshot().connection.state,'disconnected','Opening native views and panel does not connect');
  await exec('connect');assert.equal(api.snapshot().connection.state,'connected');assert.ok(api.snapshot().tasks.length>=3);
  const nativeTaskItem=new vscode.TreeItem('task-complete') as vscode.TreeItem&{taskId:string};nativeTaskItem.taskId='task-complete';
  await vscode.commands.executeCommand('zcodePool.openTask',nativeTaskItem);assert.equal(api.snapshot().selectedTaskId,'task-complete','Native tree context commands accept controlled TreeItem identifiers');
  const restricted=process.env.ZCODE_POOL_SMOKE_RESTRICTED==='1';
  if(restricted){
    assert.equal(vscode.workspace.isTrusted,false,'Restricted smoke must use a genuinely untrusted workspace');
    await assert.rejects(exec('worker.probe',{workerId:'worker-demo'}),/Trust this workspace/);
    await assert.rejects(exec('accounts.import'),/Trust this workspace/);
    await assert.rejects(exec('cancel',{taskId:'task-approval'}),/Trust this workspace/);
  }else{
    assert.equal(vscode.workspace.isTrusted,true);
    await exec('task.select',{taskId:'task-complete'});await exec('artifacts.list',{taskId:'task-complete'});
    const delivery=api.snapshot().delivery;await exec('diff.open',{taskId:'task-complete',manifestSha256:delivery.manifest.manifestSha256,fileId:delivery.files[0].fileId});
    assert.ok(vscode.workspace.textDocuments.some(doc=>doc.uri.scheme.toLowerCase()==='zcodepool-artifact'));
  }
  await assert.rejects(api.execute({v:1,id:'hostile',generation:api.snapshot().connection.generation,type:'worker.stop',payload:{workerId:'worker-demo',method:'daemon_stop'}}));
  // Exercise actual workbench theme and 200% editor/UI zoom settings. Pixel and keyboard
  // acceptance are separate browser/manual checks, not inferred from API smoke.
  for(const theme of ['Default Dark Modern','Default Light Modern','Default High Contrast'])await vscode.workspace.getConfiguration('workbench').update('colorTheme',theme,vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration('window').update('zoomLevel',3.8,vscode.ConfigurationTarget.Global);
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await exec('disconnect');assert.equal(api.snapshot().connection.state,'disconnected');assert.equal(api.snapshot().detail,null);
  console.log(`ZCode Pool Host smoke passed: VS Code ${vscode.version}; trusted=${vscode.workspace.isTrusted}; commands=${manifest.contributes.commands.length}`);
}
