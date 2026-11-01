import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { HostError } from './client.js';

const payloadFiles = ['package.json', 'bin/zcode-pool.mjs', 'cli.mjs', 'daemon.mjs', 'mcp.mjs'] as const;
interface RuntimeManifest {
  schemaVersion: 1;
  name: 'zcode-pool';
  version: string;
  files: Record<string, string>;
}
export interface BundledRuntime {
  version: string;
  /** Immutable installed version, retained across extension upgrades. */
  directory: string;
  /** Stable paths outside the extension installation directory. */
  cliPath: string;
  mcpPath: string;
}
export interface RuntimeInstallOptions { extensionPath: string; globalStoragePath: string }

const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
function invalid(message: string): HostError { return new HostError('BUNDLED_RUNTIME_INVALID', message); }

async function regularFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw invalid('随扩展交付的后台文件无效，请重新安装扩展。');
  const data = await readFile(path);
  if (data.length > maxBytes) throw invalid('随扩展交付的后台文件超出大小限制。');
  return data;
}
function parseManifest(data: Buffer): RuntimeManifest {
  let value: unknown;
  try { value = JSON.parse(data.toString('utf8')); } catch { throw invalid('后台交付清单无效，请重新安装扩展。'); }
  if (!value || typeof value !== 'object') throw invalid('后台交付清单无效。');
  const manifest = value as Partial<RuntimeManifest>;
  if (manifest.schemaVersion !== 1 || manifest.name !== 'zcode-pool' || typeof manifest.version !== 'string' ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version) || !manifest.files ||
      Object.keys(manifest.files).sort().join('\n') !== [...payloadFiles].sort().join('\n') ||
      !Object.values(manifest.files).every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
    throw invalid('后台交付清单不完整或版本无效，请重新安装扩展。');
  }
  return manifest as RuntimeManifest;
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid('后台安装目录必须是执行侧的普通目录。');
}
async function replaceFile(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  try {
    const current = await regularFile(path, 65_536);
    if (current.equals(typeof data === 'string' ? Buffer.from(data) : data)) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.runtime-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
function stableLauncher(entry: 'cli' | 'mcp'): string {
  return `#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('ZCode Pool requires Node.js 24 or later.');
  process.exitCode = 1;
} else {
  const current = JSON.parse(await readFile(new URL('../current.json', import.meta.url), 'utf8'));
  if (current.schemaVersion !== 1 || !/^\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?-[a-f0-9]{16}$/.test(current.release)) throw new Error('Invalid ZCode Pool runtime selection');
  process.env.ZCODE_POOL_RUNTIME_CLI_PATH = fileURLToPath(new URL('./zcode-pool.mjs', import.meta.url));
  await import(new URL('../versions/' + current.release + '/${entry}.mjs', import.meta.url));
}
`;
}

/** Copies only the verified VSIX payload. No npm, network, process or pool activity. */
export async function ensureBundledRuntime(options: RuntimeInstallOptions): Promise<BundledRuntime> {
  if (!isAbsolute(options.extensionPath) || !isAbsolute(options.globalStoragePath) ||
      options.extensionPath.includes('\0') || options.globalStoragePath.includes('\0')) throw invalid('后台安装需要执行侧的绝对目录。');
  try {
    const source = join(options.extensionPath, 'dist/runtime');
    const manifestData = await regularFile(join(source, 'manifest.json'), 65_536);
    const manifest = parseManifest(manifestData);
    const data = new Map<string, Buffer>();
    for (const path of payloadFiles) {
      const content = await regularFile(join(source, path), 16 * 1024 * 1024);
      if (digest(content) !== manifest.files[path]) throw invalid('随扩展交付的后台校验失败，请重新安装扩展。');
      data.set(path, content);
    }
    const pkg = JSON.parse(data.get('package.json')!.toString('utf8')) as { name?: unknown; version?: unknown; bin?: Record<string, unknown> };
    if (pkg.name !== manifest.name || pkg.version !== manifest.version || pkg.bin?.['zcode-pool'] !== './bin/zcode-pool.mjs') throw invalid('后台包与交付清单不匹配。');
    const root = join(options.globalStoragePath, 'runtime');
    const versions = join(root, 'versions');
    const release = `${manifest.version}-${digest(manifestData).slice(0, 16)}`;
    const directory = join(versions, release);
    await privateDirectory(root);
    await privateDirectory(versions);
    let installed = false;
    try {
      const existing = await lstat(directory);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw invalid('已安装后台目录无效。');
      for (const path of payloadFiles) if (digest(await regularFile(join(directory, path), 16 * 1024 * 1024)) !== manifest.files[path]) throw invalid('已安装后台校验失败；请修复扩展的后台安装目录。');
      installed = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!installed) {
      const staging = join(versions, `.install-${randomUUID()}`);
      try {
        await privateDirectory(join(staging, 'bin'));
        for (const [path, content] of data) await writeFile(join(staging, path), content, { mode: path.startsWith('bin/') ? 0o700 : 0o600, flag: 'wx' });
        await writeFile(join(staging, 'manifest.json'), manifestData, { mode: 0o600, flag: 'wx' });
        try { await rename(staging, directory); }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          // Another extension host installed the exact same immutable release.
          for (const path of payloadFiles) if (digest(await regularFile(join(directory, path), 16 * 1024 * 1024)) !== manifest.files[path]) throw invalid('并发安装的后台校验失败。');
        }
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    await privateDirectory(join(root, 'bin'));
    const cliPath = join(root, 'bin/zcode-pool.mjs');
    const mcpPath = join(root, 'bin/zcode-pool-mcp.mjs');
    await replaceFile(join(root, 'package.json'), JSON.stringify({ name: 'zcode-pool', version: manifest.version, private: true, type: 'module', bin: { 'zcode-pool': './bin/zcode-pool.mjs' } }, null, 2) + '\n');
    await replaceFile(cliPath, stableLauncher('cli'), 0o700);
    await replaceFile(mcpPath, stableLauncher('mcp'), 0o700);
    await chmod(cliPath, 0o700);
    await chmod(mcpPath, 0o700);
    // Commit selection last. Existing daemons keep their complete immutable version.
    await replaceFile(join(root, 'current.json'), JSON.stringify({ schemaVersion: 1, release, version: manifest.version }) + '\n');
    return { version: manifest.version, directory, cliPath, mcpPath };
  } catch (error) {
    if (error instanceof HostError) throw error;
    throw invalid('无法准备扩展内置后台，请检查扩展安装和执行侧全局存储目录的权限。');
  }
}
