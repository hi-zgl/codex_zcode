import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
const files=(await readdir(new URL('../test/integration',import.meta.url))).filter(f=>f.endsWith('.test.ts')).map(f=>`test/integration/${f}`);
const r=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','--test',...files],{cwd:new URL('..',import.meta.url),stdio:'inherit'});process.exit(r.status??1);
