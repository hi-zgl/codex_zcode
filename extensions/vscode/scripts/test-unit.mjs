import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const files=(await readdir(new URL('../test/unit',import.meta.url))).filter(f=>f.endsWith('.test.ts')).map(f=>`test/unit/${f}`);
const r=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','--tsconfig','tsconfig.host.json','--test',...files],{cwd:new URL('..',import.meta.url),stdio:'inherit'});process.exit(r.status??1);
