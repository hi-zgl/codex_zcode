import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { HostError } from './client.js';

export interface DaemonLaunchOptions {
  poolHome: string;
  nodePath: string;
  cliPath: string;
  trusted(): boolean;
  isCurrent(): boolean;
  signal?: AbortSignal;
}

/** Discovery only: never execute a PATH candidate or search a relative directory. */
export async function findNodeExecutable(pathEnv: string | undefined): Promise<string | undefined> {
  for (const directory of pathEnv?.split(delimiter) ?? []) {
    if (!isAbsolute(directory) || directory.includes('\0')) continue;
    try {
      const candidate = await realpath(join(directory, 'node'));
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch { /* Try the next absolute PATH directory. */ }
  }
  return undefined;
}

function requireCurrent(options: DaemonLaunchOptions, mayHaveStarted = false): void {
  if (options.signal?.aborted) throw new HostError('ABORTED', mayHaveStarted
    ? 'Stopped waiting for daemon startup. A daemon may already have started; Connect before trying again.'
    : 'Daemon startup was cancelled before launching the daemon.', mayHaveStarted);
  if (!options.isCurrent()) throw new HostError('STALE_CONNECTION', 'The selected pool or startup settings changed. Connect to the selected pool before starting again.', mayHaveStarted);
  if (!options.trusted()) throw new HostError('WORKSPACE_UNTRUSTED', 'Trust this workspace before starting the installed daemon.', mayHaveStarted);
}

function requirePath(value: string, setting: string): void {
  if (!value || !isAbsolute(value) || value.includes('\0')) {
    throw new HostError('INVALID_DAEMON_CONFIG', `Set ${setting} to an absolute path on the extension host without quotes or NUL characters.`);
  }
}

async function executable(path: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (!(await stat(canonical)).isFile()) throw new Error();
    await access(canonical, constants.X_OK);
    return canonical;
  } catch {
    throw new HostError('INVALID_DAEMON_NODE', 'Set zcodePool.daemonNodePath to an accessible Node.js 24 or later executable on the extension host.');
  }
}

async function installedCli(path: string): Promise<{ entry: string; directory: string }> {
  try {
    const entry = await realpath(path);
    if (!(await stat(entry)).isFile()) throw new Error();
    await access(entry, constants.R_OK);
    // The distribution's public bin resolves to <package>/bin/zcode-pool.mjs.
    // Checking its manifest rejects a checkout's undeclared development entry.
    const directory = dirname(dirname(entry));
    const manifestPath = join(directory, 'package.json');
    const info = await stat(manifestPath);
    if (!info.isFile() || info.size > 65_536) throw new Error();
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!manifest || typeof manifest !== 'object') throw new Error();
    const pkg = manifest as { name?: unknown; bin?: unknown };
    const bin = typeof pkg.bin === 'string' ? pkg.bin
      : pkg.bin && typeof pkg.bin === 'object' ? (pkg.bin as Record<string, unknown>)['zcode-pool'] : undefined;
    if (pkg.name !== 'zcode-pool' || typeof bin !== 'string' || !bin || isAbsolute(bin) || bin.includes('\0')) throw new Error();
    const declared = resolve(directory, bin);
    if (!declared.startsWith(`${directory}/`) || await realpath(declared) !== entry) throw new Error();
    return { entry, directory };
  } catch {
    throw new HostError('INVALID_DAEMON_CLI', 'Set zcodePool.daemonCliPath to the bin entry of a separately installed zcode-pool package. Install the daemon outside the development checkout first.');
  }
}

function runNode(options: DaemonLaunchOptions, nodePath: string, args: string[], cwd: string, version: boolean): Promise<string> {
  requireCurrent(options);
  return new Promise((resolveRun, reject) => {
    let done = false;
    let output = '';
    const failure = () => new HostError(version ? 'INVALID_DAEMON_NODE' : 'DAEMON_START_FAILED', version
      ? 'The selected executable did not report Node.js 24 or later. Check zcodePool.daemonNodePath.'
      : 'Daemon startup did not complete. Inspect scheduler/daemon.log in the selected pool, then Connect before trying again.', !version);
    let child: ChildProcess;
    try {
      child = spawn(nodePath, args, {
        cwd, shell: false,
        env: { ...process.env, ZCODE_POOL_HOME: options.poolHome },
        stdio: ['ignore', version ? 'pipe' : 'ignore', 'ignore'],
      });
    } catch { reject(failure()); return; }
    const timer = setTimeout(() => finish(failure()), version ? 5_000 : 65_000);
    const abort = () => finish(new HostError('ABORTED', version
      ? 'Stopped checking the Node.js executable. No daemon start was requested.'
      : 'Stopped waiting for daemon startup. A daemon may already have started; Connect before trying again.', !version));
    function finish(error?: HostError): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      // Only terminate this CLI invocation. daemon-start owns its detached daemon.
      if (error && child.exitCode === null && child.signalCode === null) child.kill();
      error ? reject(error) : resolveRun(output);
    }
    child.once('error', () => finish(failure()));
    child.once('close', code => finish(code === 0 ? undefined : failure()));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 1_024) { finish(failure()); return; }
      output += chunk.toString('utf8');
    });
  });
}

/** Explicit user action only. Reuses the installed CLI's existing lifecycle. */
export async function startInstalledDaemon(options: DaemonLaunchOptions): Promise<void> {
  if (process.platform !== 'linux') throw new HostError('UNSUPPORTED_PLATFORM', 'Starting a daemon requires a Linux extension host.');
  requireCurrent(options);
  requirePath(options.poolHome, 'zcodePool.poolHome');
  requirePath(options.nodePath, 'zcodePool.daemonNodePath');
  requirePath(options.cliPath, 'zcodePool.daemonCliPath');
  const nodePath = await executable(options.nodePath);
  const cli = await installedCli(options.cliPath);
  requireCurrent(options);
  const version = (await runNode(options, nodePath, ['--version'], cli.directory, true)).trim();
  const parsed = /^v(\d+)\.\d+\.\d+(?:-[\w.-]+)?$/.exec(version);
  if (!parsed || Number(parsed[1]) < 24) throw new HostError('INVALID_DAEMON_NODE', 'The selected executable must be Node.js 24 or later. Check zcodePool.daemonNodePath.');
  requireCurrent(options);
  await runNode(options, nodePath, [cli.entry, 'daemon-start'], cli.directory, false);
  requireCurrent(options, true);
}
