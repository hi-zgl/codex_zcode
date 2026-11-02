import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runtimeFiles } from './build-runtime.mjs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const listed = spawnSync(process.execPath, ['node_modules/@vscode/vsce/vsce', 'ls', '--no-dependencies'], { cwd: root, encoding: 'utf8' });
if (listed.status !== 0) throw new Error(listed.stderr || listed.stdout);
const files = listed.stdout.trim().split('\n').filter(Boolean);
const runtime = runtimeFiles.map(path => `dist/runtime/${path}`).concat('dist/runtime/manifest.json');
const expected = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'dist/host/extension.cjs', 'dist/webview/main.js', 'dist/webview/styles.css', 'media/zcode-pool.svg', 'media/icon.png', ...runtime];
// vsce normalizes LICENSE to LICENSE.txt inside the archive.
const canonical = path => path.toLowerCase().replace(/^license\.txt$/, 'license');
const allowed = new Set(expected.map(canonical));
for (const file of files) if (!allowed.has(canonical(file))) throw new Error(`Unexpected packaged file: ${file}`);
for (const file of expected) if (!files.some(entry => canonical(entry) === canonical(file))) throw new Error(`Missing packaged file: ${file}`);
const archive = `${pkg.name}-${pkg.version}.vsix`;
const zip = spawnSync('unzip', ['-Z1', archive], { cwd: root, encoding: 'utf8' });
if (zip.status !== 0) throw new Error(`Cannot inspect ${archive}; build the VSIX first`);
const entries = zip.stdout.trim().split('\n');
for (const file of entries) if (!['[Content_Types].xml', 'extension.vsixmanifest'].includes(file) && !allowed.has(canonical(file.replace(/^extension\//, '')))) throw new Error(`Unexpected VSIX entry: ${file}`);
for (const file of expected) if (!entries.some(entry => entry.startsWith('extension/') && canonical(entry.slice('extension/'.length)) === canonical(file))) throw new Error(`Missing VSIX entry: ${file}`);
function archiveFile(path) {
  const result = spawnSync('unzip', ['-p', archive, `extension/${path}`], { cwd: root, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Cannot read bundled VSIX file: ${path}`);
  return result.stdout;
}
const manifest = JSON.parse(archiveFile('dist/runtime/manifest.json'));
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.deepEqual(Object.keys(manifest.files).sort(), [...runtimeFiles].sort());
for (const file of runtimeFiles) assert.equal(createHash('sha256').update(archiveFile(`dist/runtime/${file}`)).digest('hex'), manifest.files[file], `VSIX runtime checksum: ${file}`);
const runtimePkg = JSON.parse(archiveFile('dist/runtime/package.json'));
assert.equal(runtimePkg.version, pkg.version);
assert.equal(runtimePkg.bin['zcode-pool'], './bin/zcode-pool.mjs');
assert.equal(runtimePkg.dependencies, undefined, 'runtime dependencies are bundled');
console.log(`Unified VSIX verified: ${files.length} allowlisted files, daemon/CLI/MCP checksums match, no checkout source, maps, credentials or fixtures.`);
