import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { MessageRouter } from './router.js';
import type { ActionService } from './actions.js';
import type { UiSnapshot } from './types.js';
export class Workbench implements vscode.Disposable{
  private panel?:vscode.WebviewPanel;private router?:MessageRouter;private readonly listeners:vscode.Disposable[]=[];
  constructor(private readonly extensionUri:vscode.Uri,private readonly service:()=>ActionService,private readonly visibility:()=>void,private readonly onClose:()=>void=()=>{}){}
  get visible():boolean{return this.panel?.visible??false;}
  show():void{
    if(this.panel){this.panel.reveal(vscode.ViewColumn.One);return;}
    const staticRoot=vscode.Uri.joinPath(this.extensionUri,'dist','webview');
    const panel=vscode.window.createWebviewPanel('zcodePool.workbench','ZCode Pool',vscode.ViewColumn.One,{enableScripts:true,retainContextWhenHidden:false,localResourceRoots:[staticRoot]});this.panel=panel;
    this.router=new MessageRouter({generation:()=>this.service().generation(),execute:request=>this.service().execute(request)},response=>{void panel.webview.postMessage(response);});
    this.listeners.push(panel.webview.onDidReceiveMessage(message=>this.router?.receive(message)),panel.onDidChangeViewState(()=>this.visibility()),panel.onDidDispose(()=>{this.panel=undefined;this.router?.dispose();this.router=undefined;this.service().closePanel();this.onClose();while(this.listeners.length)this.listeners.pop()?.dispose();this.visibility();}));
    const nonce=randomBytes(24).toString('base64');const script=panel.webview.asWebviewUri(vscode.Uri.joinPath(staticRoot,'main.js'));const style=panel.webview.asWebviewUri(vscode.Uri.joinPath(staticRoot,'styles.css'));
    panel.webview.html=`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource}; font-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none';"><title>ZCode Pool</title><link rel="stylesheet" href="${style}"></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.visibility();
  }
  push(snapshot:UiSnapshot):void{if(this.panel)void this.panel.webview.postMessage({v:1,type:'state',generation:snapshot.connection.generation,data:snapshot});}
  dispose():void{this.router?.dispose();this.panel?.dispose();while(this.listeners.length)this.listeners.pop()?.dispose();}
}
