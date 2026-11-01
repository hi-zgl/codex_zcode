import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { UiArtifactFile } from '../../../../src/shared/ui-contract.js';
export class ArtifactDiffProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly documents=new Map<string,string>();
  private readonly registration:vscode.Disposable;
  constructor(private readonly authority:()=>string){this.registration=vscode.workspace.registerTextDocumentContentProvider('zcodePool-artifact',this);}
  provideTextDocumentContent(uri:vscode.Uri):string {
    const value=this.documents.get(uri.toString());if(value===undefined)throw new Error('This immutable document is no longer available. Reopen it from the task manifest.');return value;
  }
  async open(taskId:string,manifestSha256:string,file:UiArtifactFile,read:(side:'base'|'final')=>Promise<string>):Promise<void>{
    const [base,final]=await Promise.all([read('base'),read('final')]);
    const identity=encodeURIComponent(JSON.stringify({authority:this.authority(),taskId,manifestSha256,fileId:file.fileId}));
    const token=randomUUID();
    const uri=(side:'base'|'final')=>vscode.Uri.from({scheme:'zcodePool-artifact',authority:'snapshot',path:`/${token}/${side}/${encodeURIComponent(file.displayPath)}`,query:identity});
    const left=uri('base'),right=uri('final');this.documents.set(left.toString(),base);this.documents.set(right.toString(),final);
    try{await vscode.commands.executeCommand('vscode.diff',left,right,`${file.displayPath} · base → immutable delivery${file.change==='untracked'?' · untracked (outside patch)':''}`,{preview:true});}
    catch(error){this.documents.delete(left.toString());this.documents.delete(right.toString());throw error;}
  }
  release(uri:vscode.Uri):void{this.documents.delete(uri.toString());}
  clear():void{this.documents.clear();}
  dispose():void{this.registration.dispose();this.clear();}
}
