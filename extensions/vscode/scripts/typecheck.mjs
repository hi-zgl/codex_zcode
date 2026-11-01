import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
for(const config of ['tsconfig.host.json','tsconfig.webview.json']){
  const result=spawnSync(process.execPath,[`${root}/node_modules/typescript/bin/tsc`,'--project',config],{cwd:root,stdio:'inherit'});
  if(result.status!==0)process.exit(result.status??1);
}
