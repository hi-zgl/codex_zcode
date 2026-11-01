import {spawnSync} from 'node:child_process';
import {mkdir,copyFile,watch} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {buildBundledRuntime} from './build-runtime.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const watching=process.argv.includes('--watch');
function command(file,args){const r=spawnSync(process.execPath,[file,...args],{cwd:root,stdio:'inherit'});if(r.status!==0)throw new Error('Build check failed');}
async function compile(){
  console.log('[zcodePool-watch] build started');
  command('scripts/typecheck.mjs',[]);
  command('node_modules/tsx/dist/cli.mjs',['--tsconfig','tsconfig.host.json','scripts/validate-fixtures.ts']);
  await mkdir(`${root}/dist/host`,{recursive:true});await mkdir(`${root}/dist/webview`,{recursive:true});
  const [host,webview]=await Promise.all([
    build({absWorkingDir:root,entryPoints:['src/extension.ts'],bundle:true,platform:'node',format:'cjs',target:'node20',outfile:'dist/host/extension.cjs',external:['vscode'],alias:{zod:`${root}/node_modules/zod`},sourcemap:true,metafile:true}),
    build({absWorkingDir:root,entryPoints:['src/webview/main.ts'],bundle:true,platform:'browser',format:'iife',target:'chrome120',outfile:'dist/webview/main.js',sourcemap:true,metafile:true}),
  ]);
  for(const input of Object.keys(host.metafile.inputs))if(/(?:src\/(?:daemon|core|accounts|supervisor|runtime)|node:sqlite)/.test(input.replaceAll('\\','/')))throw new Error(`Forbidden host dependency: ${input}`);
  for(const input of Object.keys(webview.metafile.inputs))if(/(?:node_modules|src\/host)/.test(input.replaceAll('\\','/')))throw new Error(`Forbidden browser dependency: ${input}`);
  await copyFile(`${root}/media/styles.css`,`${root}/dist/webview/styles.css`);
  await buildBundledRuntime();
  console.log('[zcodePool-watch] build finished');
}
if(!watching){await compile();}else{
  let building=false;let rerun=false;let debounce;
  async function run(){if(building){rerun=true;return;}building=true;try{await compile();}catch(error){console.error(String(error));}finally{building=false;if(rerun){rerun=false;void run();}}}
  await run();
  const abort=new AbortController();
  for(const directory of ['src','media','../../src','test/fixtures'])void(async()=>{for await(const event of watch(`${root}/${directory}`,{recursive:true,signal:abort.signal})){if(event.filename){clearTimeout(debounce);debounce=setTimeout(()=>void run(),150);}}})();
  process.once('SIGINT',()=>{abort.abort();process.exit(0);});
}
