import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { privateDirectory, writePrivateJson, type AccountCredentials } from '../accounts/index.js';
import { injectAccount, initializeMachineIdentity, type InjectedIdentity } from './injection.js';
export { injectAccount, initializeMachineIdentity, verifyInjectedIdentity, type InjectedIdentity } from './injection.js';

export interface WorkerEndpoint { baseUrl: string; serverRoot: string; tokenFile: string }
export interface WorkerHandle {
  workerId: string;
  workerRoot: string;
  serverRoot: string;
  accountAlias: string;
  provider: 'zai' | 'bigmodel';
  pid: number;
  startedAt: number;
  processStartTicks: string;
  endpoint: WorkerEndpoint;
  version: string;
  identity: InjectedIdentity;
  machineIdentityConfigured: boolean;
}
export interface WorkerStatus {
  workerId: string;
  accountAlias: string;
  state: 'ready' | 'stopped' | 'unreachable' | 'identity-mismatch' | 'unsupported';
  pid: number;
  processOwned: boolean;
  runningTaskCount?: number;
  version?: string;
  endpoint?: WorkerEndpoint;
}
interface Ownership {
  schemaVersion: 1;
  workerId: string;
  accountAlias: string;
  provider: 'zai' | 'bigmodel';
  serverRoot: string;
  pid: number;
  processStartTicks: string;
  ownershipMarker: string;
  startedAt: number;
  cliPath: string;
}
interface ProcIdentity { pid: number; parentPid: number; processGroup: number; startTicks: string; uid: number; command: string[]; env: Record<string, string> }
interface ServerStatus { state: string; pid: number | null; port: number | null; host: string | null; version: string; updatedAt: number; runningTaskCount: number; serviceRegistered: boolean }
export interface SupervisorOptions { poolRoot: string; runtimeRoot?: string; readyTimeoutMs?: number; supportedVersions?: readonly string[]; machineIdentityFile?: string }
const pendingStarts = new Set<string>();

export async function readProcessIdentity(pid: number): Promise<ProcIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
  try {
    const [stat, status, cmd, env] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8'), readFile(`/proc/${pid}/environ`, 'utf8'),
    ]);
    // comm can contain spaces and parentheses. Fields after the final ')' begin at stat field 3.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    return {
      pid, parentPid: Number(fields[1]), processGroup: Number(fields[2]), startTicks: fields[19]!,
      uid: Number(status.match(/^Uid:\s+(\d+)/m)?.[1]), command: cmd.split('\0').filter(Boolean),
      env: Object.fromEntries(env.split('\0').filter(Boolean).map(item => { const i = item.indexOf('='); return [item.slice(0, i), item.slice(i + 1)]; })),
    };
  } catch { return undefined; }
}

function validId(workerId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(workerId)) throw new Error('Invalid worker ID');
}
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Only a process spawned with our persisted nonce, exact root, command and birth time is owned. */
export function processMatchesOwnership(processInfo: ProcIdentity | undefined, ownership: Ownership): boolean {
  if (!processInfo || processInfo.pid !== ownership.pid || processInfo.startTicks !== ownership.processStartTicks || processInfo.uid !== process.getuid?.()) return false;
  const rootOption = processInfo.command.indexOf('--server-root');
  return processInfo.processGroup === ownership.pid && processInfo.command.includes(ownership.cliPath) &&
    processInfo.command.includes('serve') && rootOption >= 0 && processInfo.command[rootOption + 1] === ownership.serverRoot &&
    processInfo.env.ZCODE_SERVER_ROOT === ownership.serverRoot && processInfo.env.ZCODE_POOL_OWNERSHIP === ownership.ownershipMarker;
}

function redactLog(line: string, account: AccountCredentials, secret: string): string {
  let clean = line;
  for (const value of [account.accessToken, account.zcodeJwtToken, account.refreshToken, secret]) if (value) clean = clean.split(value).join('[REDACTED]');
  return clean.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]');
}

async function control(serverRoot: string, command: 'status', timeoutMs = 2000): Promise<ServerStatus> {
  return new Promise((resolveResult, reject) => {
    const socket = connect(join(serverRoot, 'run/control.sock'));
    const id = randomUUID();
    let buffer = '';
    const finish = (error?: Error, value?: ServerStatus) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolveResult(value!); };
    const timer = setTimeout(() => finish(new Error('Worker control request timed out')), timeoutMs);
    socket.setEncoding('utf8');
    socket.once('error', () => finish(new Error('Worker control request failed')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ id, command })}\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 256 * 1024) return finish(new Error('Worker control response too large'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.id !== id || response.ok !== true) throw new Error();
        finish(undefined, response.result as ServerStatus);
      } catch { finish(new Error('Worker control response was invalid')); }
    });
    socket.once('end', () => { if (!buffer.includes('\n')) finish(new Error('Worker control connection closed')); });
  });
}

export class WorkerSupervisor {
  readonly poolRoot: string;
  readonly runtimeRoot: string;
  readonly readyTimeoutMs: number;
  readonly supportedVersions: readonly string[];
  readonly machineIdentityFile?: string;
  #children = new Map<string, ChildProcess>();
  constructor(options: SupervisorOptions) {
    this.poolRoot = resolve(options.poolRoot);
    this.runtimeRoot = resolve(options.runtimeRoot ?? join(homedir(), '.zcode/server'));
    this.readyTimeoutMs = options.readyTimeoutMs ?? 45_000;
    this.supportedVersions = options.supportedVersions ?? ['3.16.3'];
    this.machineIdentityFile = options.machineIdentityFile;
    const defaultDataRoot = join(homedir(), '.zcode');
    if ([resolve(homedir()), resolve('/'), this.runtimeRoot, defaultDataRoot].includes(this.poolRoot) || isInside(defaultDataRoot, this.poolRoot) || isInside(this.runtimeRoot, this.poolRoot)) throw new Error('Pool root must be an independent private directory');
  }
  workerRoot(workerId: string): string { validId(workerId); return join(this.poolRoot, 'workers', workerId); }
  async #prepare(workerId: string): Promise<string> {
    const workerRoot = this.workerRoot(workerId);
    if (Buffer.byteLength(join(workerRoot, 'data/.zcode/server/run/control.sock')) > 107) throw new Error('Worker control socket path exceeds the Linux limit; choose a shorter pool root or worker ID');
    await privateDirectory(this.poolRoot);
    for (const dir of [join(this.poolRoot, 'workers'), workerRoot, join(workerRoot, 'data'), join(workerRoot, 'data/.zcode'), join(workerRoot, 'data/.zcode/server'), join(workerRoot, 'logs'), join(workerRoot, 'artifacts')]) await privateDirectory(dir);
    const canonicalPool = await realpath(this.poolRoot);
    const canonicalWorker = await realpath(workerRoot);
    if (!isInside(canonicalPool, canonicalWorker)) throw new Error('Worker directory escapes pool root');
    return workerRoot;
  }
  async #ownership(workerId: string): Promise<Ownership | undefined> {
    const workerRoot = this.workerRoot(workerId);
    try {
      const path = join(workerRoot, 'process.json');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error();
      const value = JSON.parse(await readFile(path, 'utf8')) as Ownership;
      if (value.schemaVersion !== 1 || value.workerId !== workerId || value.serverRoot !== join(workerRoot, 'data/.zcode/server') || !value.ownershipMarker || !/^\d+$/.test(value.processStartTicks) || !Number.isSafeInteger(value.pid) || value.pid <= 1) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Worker ownership record is invalid');
    }
  }
  async #runtime(): Promise<{ node: string; cli: string; version: string }> {
    let current: { version: string; releaseDir: string };
    try { current = JSON.parse(await readFile(join(this.runtimeRoot, 'current.json'), 'utf8')); }
    catch { throw new Error('Installed official Server release metadata is unavailable'); }
    if (!this.supportedVersions.includes(current.version)) throw new Error('Installed official Server version is not supported');
    const releaseRoot = await realpath(join(this.runtimeRoot, 'releases'));
    const release = await realpath(current.releaseDir);
    if (!isInside(releaseRoot, release)) throw new Error('Official Server release escapes installation directory');
    const node = join(release, 'runtime/node'), cli = join(release, 'runtime/server-cli.js');
    for (const file of [node, cli, join(release, 'runtime/server-core.js'), join(release, 'runtime/zcode.cjs')]) if (!(await lstat(file)).isFile()) throw new Error('Official runtime resources are missing');
    return { node, cli, version: current.version };
  }
  async #endpoint(ownership: Ownership, status: ServerStatus): Promise<WorkerEndpoint> {
    if (status.state !== 'ready' || status.serviceRegistered || status.updatedAt < ownership.startedAt || !status.pid || !status.port || !['127.0.0.1', 'localhost', '::1'].includes(status.host ?? '') || !Number.isSafeInteger(status.port) || status.port > 65535) throw new Error('Worker status is not ready or belongs to another lifecycle');
    const core = await readProcessIdentity(status.pid);
    if (!core || core.processGroup !== ownership.pid || core.env.ZCODE_SERVER_ROOT !== ownership.serverRoot || core.env.ZCODE_POOL_OWNERSHIP !== ownership.ownershipMarker) throw new Error('Worker core process identity mismatch');
    const tokenFile = join(ownership.serverRoot, 'run/ingress-token');
    const tokenStat = await lstat(tokenFile);
    if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || tokenStat.uid !== process.getuid?.() || tokenStat.mode & 0o077) throw new Error('Unsafe worker ingress token file');
    const token = (await readFile(tokenFile, 'utf8')).trim();
    if (!token) throw new Error('Worker ingress token is empty');
    const host = status.host === '::1' ? '[::1]' : status.host;
    const baseUrl = `http://${host}:${status.port}`;
    let info: Record<string, unknown>;
    try {
      const response = await fetch(`${baseUrl}/api/server-info`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
      if (!response.ok) throw new Error();
      info = await response.json() as Record<string, unknown>;
    } catch { throw new Error('Worker authenticated readiness request failed'); }
    if (!this.supportedVersions.includes(String(info.version)) || info.version !== status.version || info.protocolVersion !== 1 || info.authRequired !== true || typeof info.serverId !== 'string') throw new Error('Worker runtime identity or version mismatch');
    return { baseUrl, serverRoot: ownership.serverRoot, tokenFile };
  }
  async start(input: { workerId: string; account: AccountCredentials; workspacePath?: string }): Promise<WorkerHandle> {
    const keys = [`worker:${this.poolRoot}:${input.workerId}`, `account:${this.poolRoot}:${input.account.alias}`];
    if (keys.some(key => pendingStarts.has(key))) throw new Error('Worker or account startup is already in progress');
    for (const key of keys) pendingStarts.add(key);
    try { return await this.#start(input); }
    finally { for (const key of keys) pendingStarts.delete(key); }
  }
  async #start(input: { workerId: string; account: AccountCredentials; workspacePath?: string }): Promise<WorkerHandle> {
    if (process.platform !== 'linux') throw new Error('Process ownership verification currently requires Linux /proc');
    const workerRoot = await this.#prepare(input.workerId);
    const previous = await this.#ownership(input.workerId);
    if (previous && previous.accountAlias !== input.account.alias) throw new Error('Worker belongs to another account; use a new worker ID to preserve session ownership');
    if (previous && await readProcessIdentity(previous.pid)) throw new Error('Worker already has a live process; reconcile it before starting');
    for (const other of await this.list()) {
      if (other.workerId !== input.workerId && other.accountAlias === input.account.alias && other.state !== 'stopped') throw new Error('Account is already bound to another active worker');
    }
    // Refuse an existing foreign control server even if no local ownership record exists.
    try { await control(join(workerRoot, 'data/.zcode/server'), 'status', 300); throw new Error('foreign-live-worker'); }
    catch (error) { if ((error as Error).message === 'foreign-live-worker') throw new Error('Worker root already contains a live server'); }
    const runtime = await this.#runtime();
    const secretPath = join(workerRoot, 'credential-secret');
    let secret: string;
    try { await writeFile(secretPath, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Unable to initialize worker credential secret'); }
    const secretStat = await lstat(secretPath);
    if (!secretStat.isFile() || secretStat.isSymbolicLink() || secretStat.uid !== process.getuid?.()) throw new Error('Unsafe worker credential secret');
    await chmod(secretPath, 0o600);
    secret = await readFile(secretPath, 'utf8');
    const identity = await injectAccount(workerRoot, input.account, secret);
    const machineIdentityConfigured = await initializeMachineIdentity(workerRoot, this.machineIdentityFile);
    const serverRoot = join(workerRoot, 'data/.zcode/server');
    const ownershipMarker = randomUUID();
    const startedAt = Date.now();
    const logPath = join(workerRoot, 'logs/server.log');
    const log = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
    await chmod(logPath, 0o600).catch(() => undefined);
    const env: NodeJS.ProcessEnv = { ...process.env, ZCODE_DATA_BASE_DIR: join(workerRoot, 'data'), ZCODE_SERVER_ROOT: serverRoot, ZCODE_CREDENTIAL_SECRET: secret, ZCODE_POOL_OWNERSHIP: ownershipMarker, ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: '1' };
    delete env.DISPLAY;
    delete env.WAYLAND_DISPLAY;
    delete env.ZCODE_AGENT_SERVER_COMMAND;
    delete env.ZCODE_AGENT_SERVER_ARGS_JSON;
    const child = spawn(runtime.node, [runtime.cli, 'serve', '--server-root', serverRoot, '--json'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: workerRoot });
    let spawnError = false;
    child.once('error', () => { spawnError = true; });
    await new Promise<void>((resolveSpawn, reject) => { child.once('spawn', resolveSpawn); child.once('error', () => reject(new Error('Unable to launch official Server'))); }).catch(error => { log.end(); throw error; });
    for (const stream of [child.stdout!, child.stderr!]) {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        pending += chunk;
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) { log.write(`${redactLog(pending.slice(0, newline), input.account, secret)}\n`); pending = pending.slice(newline + 1); }
        if (pending.length > 64 * 1024) { log.write('[Oversized log line redacted]\n'); pending = ''; }
      });
      stream.on('end', () => { if (pending) log.write(redactLog(pending, input.account, secret)); });
    }
    child.once('close', () => { this.#children.delete(input.workerId); log.end(); });
    child.unref();
    (child.stdout as unknown as { unref?: () => void })?.unref?.();
    (child.stderr as unknown as { unref?: () => void })?.unref?.();
    const proc = await readProcessIdentity(child.pid!);
    if (!proc) { log.end(); throw new Error('Official Server exited before ownership could be recorded'); }
    const ownership: Ownership = { schemaVersion: 1, workerId: input.workerId, accountAlias: input.account.alias, provider: input.account.provider, serverRoot, pid: child.pid!, processStartTicks: proc.startTicks, ownershipMarker, startedAt, cliPath: runtime.cli };
    if (!processMatchesOwnership(proc, ownership)) { child.kill('SIGTERM'); throw new Error('Spawned Server ownership verification failed'); }
    await writePrivateJson(join(workerRoot, 'process.json'), ownership);
    this.#children.set(input.workerId, child);
    const deadline = Date.now() + this.readyTimeoutMs;
    let lastError = 'not ready';
    while (Date.now() < deadline) {
      if (spawnError || !processMatchesOwnership(await readProcessIdentity(ownership.pid), ownership)) throw new Error('Official Server exited before becoming ready');
      try {
        const status = await control(serverRoot, 'status', 800);
        const endpoint = await this.#endpoint(ownership, status);
        return { workerId: input.workerId, workerRoot, serverRoot, accountAlias: ownership.accountAlias, provider: ownership.provider, pid: ownership.pid, startedAt, processStartTicks: ownership.processStartTicks, endpoint, version: runtime.version, identity, machineIdentityConfigured };
      } catch (error) { lastError = (error as Error).message; }
      await delay(200);
    }
    await this.stop(input.workerId, { force: true }).catch(() => undefined);
    throw new Error(`Official Server did not become ready: ${lastError}`);
  }
  async status(workerId: string): Promise<WorkerStatus> {
    const ownership = await this.#ownership(workerId);
    if (!ownership) throw new Error('Worker has no ownership record');
    const proc = await readProcessIdentity(ownership.pid);
    const base = { workerId, accountAlias: ownership.accountAlias, pid: ownership.pid, processOwned: processMatchesOwnership(proc, ownership) };
    if (!proc) return { ...base, state: 'stopped' };
    if (!base.processOwned) return { ...base, state: 'identity-mismatch' };
    try {
      const status = await control(ownership.serverRoot, 'status');
      if (!this.supportedVersions.includes(status.version)) return { ...base, state: 'unsupported', version: status.version, runningTaskCount: status.runningTaskCount };
      const endpoint = await this.#endpoint(ownership, status);
      return { ...base, state: 'ready', version: status.version, runningTaskCount: status.runningTaskCount, endpoint };
    } catch { return { ...base, state: 'unreachable' }; }
  }
  async list(): Promise<WorkerStatus[]> {
    let ids: string[];
    try { ids = await readdir(join(this.poolRoot, 'workers')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const statuses: WorkerStatus[] = [];
    for (const id of ids.sort()) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) continue;
      if (await this.#ownership(id)) statuses.push(await this.status(id));
    }
    return statuses;
  }
  /** Reconciles persisted PID plus birth time and does an authenticated live request before reuse. */
  async reconcile(workerId: string): Promise<WorkerStatus> { return this.status(workerId); }
  async stop(workerId: string, options: { force?: boolean; timeoutMs?: number } = {}): Promise<{ workerId: string; stopped: boolean }> {
    const ownership = await this.#ownership(workerId);
    if (!ownership) throw new Error('Worker has no ownership record');
    const proc = await readProcessIdentity(ownership.pid);
    if (!proc) return { workerId, stopped: true };
    if (!processMatchesOwnership(proc, ownership)) throw new Error('Refusing to signal a process that does not match worker ownership');
    let status: ServerStatus | undefined;
    try { status = await control(ownership.serverRoot, 'status'); }
    catch { if (!options.force) throw new Error('Cannot verify active tasks; force is required to stop this owned worker'); }
    if (status && status.runningTaskCount > 0 && !options.force) throw new Error('Worker has active tasks; force is required');
    // Recheck immediately before signalling. Negative PID addresses only this verified child group.
    if (!processMatchesOwnership(await readProcessIdentity(ownership.pid), ownership)) throw new Error('Worker process changed before stop');
    try { process.kill(-ownership.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Unable to signal owned worker'); }
    const deadline = Date.now() + (options.timeoutMs ?? 8000);
    while (Date.now() < deadline) {
      if (!processMatchesOwnership(await readProcessIdentity(ownership.pid), ownership)) return { workerId, stopped: true };
      await delay(100);
    }
    if (!options.force) throw new Error('Owned worker did not stop before timeout');
    if (processMatchesOwnership(await readProcessIdentity(ownership.pid), ownership)) {
      try { process.kill(-ownership.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error('Unable to kill owned worker'); }
    }
    await delay(100);
    return { workerId, stopped: !(await readProcessIdentity(ownership.pid)) };
  }
}
