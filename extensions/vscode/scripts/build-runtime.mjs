import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const extension = fileURLToPath(new URL('../', import.meta.url));
const project = fileURLToPath(new URL('../../../', import.meta.url));
export const runtimeFiles = ['package.json', 'bin/zcode-pool.mjs', 'cli.mjs', 'daemon.mjs', 'mcp.mjs'];

/** Everything required by the daemon, CLI and MCP is compiled into the VSIX. */
export async function buildBundledRuntime() {
  const pkg = JSON.parse(await readFile(join(project, 'package.json'), 'utf8'));
  const extensionPkg = JSON.parse(await readFile(join(extension, 'package.json'), 'utf8'));
  if (pkg.version !== extensionPkg.version) throw new Error('Daemon and extension versions must match');
  const output = join(extension, 'dist/runtime');
  await rm(output, { recursive: true, force: true });
  await mkdir(join(output, 'bin'), { recursive: true });
  const result = await build({
    absWorkingDir: project,
    entryPoints: { cli: 'src/cli/main.ts', daemon: 'src/daemon/main.ts', mcp: 'src/mcp/main.ts' },
    outdir: output, outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', target: 'node24',
    define: { ZCODE_POOL_BUNDLED: 'true' }, minifySyntax: true,
    // Some bundled CommonJS dependencies require Node builtins at runtime.
    banner: { js: "import { createRequire as __zcodeCreateRequire } from 'node:module';const require=__zcodeCreateRequire(import.meta.url);" },
    metafile: true,
  });
  for (const outputInfo of Object.values(result.metafile.outputs)) {
    for (const dependency of outputInfo.imports) {
      if (dependency.external && !isBuiltin(dependency.path) && !['bufferutil', 'utf-8-validate'].includes(dependency.path)) {
        throw new Error(`Unbundled runtime dependency: ${dependency.path}`);
      }
    }
  }
  await writeFile(join(output, 'package.json'), JSON.stringify({
    name: pkg.name, version: pkg.version, private: true, type: 'module',
    description: 'Bundled ZCode Pool daemon, CLI and MCP runtime',
    engines: { node: '>=24.0.0' }, os: ['linux'],
    bin: { 'zcode-pool': './bin/zcode-pool.mjs' },
  }, null, 2) + '\n');
  await writeFile(join(output, 'bin/zcode-pool.mjs'), `#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('ZCode Pool requires Node.js 24 or later.');
  process.exitCode = 1;
} else {
  process.env.ZCODE_POOL_RUNTIME_CLI_PATH = fileURLToPath(import.meta.url);
  await import(new URL('../cli.mjs', import.meta.url));
}
`);
  await chmod(join(output, 'bin/zcode-pool.mjs'), 0o755);
  const files = {};
  for (const path of runtimeFiles) files[path] = createHash('sha256').update(await readFile(join(output, path))).digest('hex');
  await writeFile(join(output, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, name: pkg.name, version: pkg.version, files,
  }, null, 2) + '\n');
  return { output, files: [...runtimeFiles, 'manifest.json'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildBundledRuntime();
  console.log(`Bundled runtime: ${result.files.length} files in ${result.output}`);
}
