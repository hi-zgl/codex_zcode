import { cp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const staging = join(root, 'dist', 'daemon-package');
const output = join(root, 'dist', 'releases');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Packaging requires Node.js >=24');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(output, { recursive: true });
for (const directory of ['src', 'bin']) await cp(join(root, directory), join(staging, directory), { recursive: true, dereference: false });
await cp(join(root, 'docs', 'distribution.md'), join(staging, 'README.md'));
const dependencies = {};
for (const name of [...Object.keys(pkg.dependencies), 'tsx']) {
  const version = lock.packages[`node_modules/${name}`]?.version;
  if (!version) throw new Error(`Missing locked runtime dependency: ${name}`);
  dependencies[name] = version;
}
await writeFile(join(staging, 'package.json'), JSON.stringify({
  name: pkg.name, version: pkg.version, private: true, type: 'module',
  description: 'Local ZCode Pool daemon, CLI and MCP runtime',
  engines: { node: '>=24.0.0' }, os: ['linux'],
  bin: { 'zcode-pool': './bin/zcode-pool.mjs' },
  files: ['bin/', 'src/', 'README.md'], dependencies,
}, null, 2) + '\n');
await chmod(join(staging, 'bin', 'zcode-pool.mjs'), 0o755);
const packed = spawnSync('npm', ['pack', staging, '--pack-destination', output, '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
const result = JSON.parse(packed.stdout)[0];
for (const file of result.files) {
  if (!/^(?:src\/|bin\/|README\.md$|package\.json$)/.test(file.path)) {
    throw new Error(`Unexpected file in distribution: ${file.path}`);
  }
}
console.log(join(output, result.filename));
