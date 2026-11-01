import { constants } from 'node:fs';
import { access, lstat, mkdir, open, link, rename, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { poolRoot } from '../shared/rpc.js';

export interface UserServiceOptions {
  name: string;
  nodePath: string;
  loaderPath: string;
  entryPath: string;
  workingDirectory: string;
  poolHome: string;
}

export function defaultUserServiceOptions(): UserServiceOptions {
  return {
    name: 'zcode-pool.service',
    nodePath: process.execPath,
    loaderPath: fileURLToPath(import.meta.resolve('tsx')),
    entryPath: fileURLToPath(new URL('../daemon/main.ts', import.meta.url)),
    workingDirectory: resolve(fileURLToPath(new URL('../../', import.meta.url))),
    poolHome: poolRoot(),
  };
}

function validateName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.service$/.test(name) || Buffer.byteLength(name) > 255) {
    throw new Error('Service name must be a plain .service filename without paths or specifiers');
  }
}
function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute path without control characters`);
  return resolve(value);
}
function normalized(options: UserServiceOptions): UserServiceOptions {
  validateName(options.name);
  const checked = { ...options };
  for (const key of ['nodePath', 'loaderPath', 'entryPath', 'workingDirectory', 'poolHome'] as const) {
    checked[key] = absolutePath(options[key], key);
  }
  // systemd rejects these characters in the executable pathname even when C-escaped.
  if (/["'\\]/.test(checked.nodePath)) throw new Error('systemd nodePath cannot contain quotes or backslashes; choose another Node executable path');
  for (const key of ['loaderPath', 'entryPath'] as const) {
    if (checked[key].includes('\\')) throw new Error(`Node ${key} cannot contain backslashes in an ES module path`);
  }
  if (Buffer.byteLength(join(checked.poolHome, 'scheduler', 'daemon.sock')) > 107) {
    throw new Error('Daemon socket path exceeds Linux Unix socket limit; use a shorter pool path');
  }
  return checked;
}

// ExecStart and Environment use systemd quoting, not shell quoting. The ExecStart ':'
// prefix below disables environment expansion, preserving every literal dollar sign.
function quote(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `"${escaped}"`;
}

export function renderUserService(input: UserServiceOptions): string {
  const options = normalized(input);
  // --import takes a module URL. Encoding the filesystem path preserves #, ?, %, and
  // whitespace in loader names instead of interpreting them as URL fragments or queries.
  const command = [options.nodePath, '--import', pathToFileURL(options.loaderPath).href, options.entryPath];
  return [
    '[Unit]',
    'Description=ZCode Pool local orchestration daemon',
    'StartLimitIntervalSec=60',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=exec',
    // WorkingDirectory does not unquote or C-unescape its value. A final /. preserves
    // literal trailing spaces/backslashes through the unit parser's whitespace trimming.
    `WorkingDirectory=${options.workingDirectory.replaceAll('%', '%%')}/.`,
    `Environment=${quote(`ZCODE_POOL_HOME=${options.poolHome}`)}`,
    `ExecStart=:${command.map(value => quote(value)).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=3',
    'TimeoutStopSec=30',
    // Workers are detached processes which must survive daemon restarts. The current
    // supervisor verifies them using persisted process identity before reconnecting.
    'KillMode=process',
    'UMask=0077',
    'StandardInput=null',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function userUnitDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const config = env.XDG_CONFIG_HOME === undefined ? join(homedir(), '.config') : absolutePath(env.XDG_CONFIG_HOME, 'XDG_CONFIG_HOME');
  return join(config, 'systemd', 'user');
}

async function validateRuntime(options: UserServiceOptions): Promise<void> {
  for (const key of ['nodePath', 'loaderPath', 'entryPath'] as const) {
    if (!(await stat(options[key])).isFile()) throw new Error(`${key} must name an existing file`);
    await access(options[key], key === 'nodePath' ? constants.X_OK : constants.R_OK);
  }
  if (!(await stat(options.workingDirectory)).isDirectory()) throw new Error('workingDirectory must name an existing directory');
}

/** Writes only a unit file. It never reloads, enables, starts, or changes a service manager. */
export async function installUserService(input: UserServiceOptions, directory = userUnitDirectory(), settings: { replace?: boolean } = {}): Promise<string> {
  if (process.platform !== 'linux') throw new Error('User services require Linux systemd');
  const options = normalized(input);
  const destination = absolutePath(directory, 'unit directory');
  await validateRuntime(options);
  const unit = renderUserService(options);
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const path = join(destination, options.name);
  const temporary = join(destination, `.zcode-pool-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(unit);
    await file.sync();
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  } finally { await file.close(); }
  try {
    if (settings.replace) {
      let existing;
      try { existing = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existing && !existing.isFile()) throw new Error('Refusing to replace a service symlink or non-regular file');
      await rename(temporary, path);
    } else {
      // link is atomic and refuses an existing destination; a plain rename would overwrite it.
      await link(temporary, path);
    }
  } finally { await unlink(temporary).catch(() => {}); }
  return path;
}
