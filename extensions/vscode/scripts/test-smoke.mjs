import {runTests,downloadAndUnzipVSCode}from'@vscode/test-electron';
import {spawn}from'node:child_process';
import {build}from'esbuild';
import {mkdtemp,mkdir,writeFile,rm}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join}from'node:path';
import {fileURLToPath}from'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
await build({absWorkingDir:root,entryPoints:['test/smoke/index.ts'],bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode'],outfile:'dist/test/smoke.cjs'});
const version=process.env.ZCODE_POOL_VSCODE_VERSION??'stable';
const selectedExecutable=process.env.ZCODE_POOL_VSCODE_EXECUTABLE_PATH??process.env.ZCODE_POOL_VSCODE_EXECUTABLE;
const restricted=process.env.ZCODE_POOL_SMOKE_RESTRICTED==='1';
// The remote CLI environment can request Node mode for Electron; the downloaded
// desktop binary must run its actual extension-host application instead.
delete process.env.ELECTRON_RUN_AS_NODE;
const temp=await mkdtemp(join(tmpdir(),'zcode-extension-host-smoke-'));const user=join(temp,'user');await mkdir(join(user,'User'),{recursive:true});
await writeFile(join(user,'User','settings.json'),JSON.stringify({'workbench.startupEditor':'none','security.workspace.trust.startupPrompt':'never','security.workspace.trust.untrustedFiles':'open','telemetry.telemetryLevel':'off','update.mode':'none'}));
const workspace=join(temp,'fixture-workspace');await mkdir(workspace);await writeFile(join(workspace,'README.md'),'Isolated ZCode Pool Host smoke workspace.\n');
try{
  const env={ZCODE_POOL_EXTENSION_MODE:'mock',ZCODE_POOL_UI_FIXTURE:join(root,'test/fixtures/pool-demo.json'),ZCODE_POOL_SMOKE_RESTRICTED:restricted?'1':'0'};
  const args=[workspace,'--user-data-dir',user,'--extensions-dir',join(temp,'extensions'),'--disable-extensions','--skip-welcome','--skip-release-notes','--no-sandbox'];
  if(restricted){
    // test-electron's runTests unconditionally appends --disable-workspace-trust.
    // Launch its official downloaded binary directly for a real Restricted Mode run.
    const executable=selectedExecutable??await downloadAndUnzipVSCode({version});
    await new Promise((resolveRun,reject)=>{const child=spawn(executable,[...args,`--extensionDevelopmentPath=${root}`,`--extensionTestsPath=${join(root,'dist/test/smoke.cjs')}`],{env:{...process.env,...env},stdio:'inherit'});child.once('error',reject);child.once('exit',code=>code===0?resolveRun():reject(new Error(`Restricted Host smoke exited ${code}`)));});
  }else await runTests({version,...(selectedExecutable?{vscodeExecutablePath:selectedExecutable}:{}),extensionDevelopmentPath:root,extensionTestsPath:join(root,'dist/test/smoke.cjs'),extensionTestsEnv:env,launchArgs:args});
}finally{await rm(temp,{recursive:true,force:true});}
