import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const MANAGED_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const MANAGED_LOG_BACKUPS = 3;
export const DAEMON_LOG_CHECK_MS = 5_000;

interface LogOptions { maxBytes?: number; backups?: number }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function fileIfPresent(path: string): Stats | undefined {
  try { return lstatSync(path); } catch (error) { if (!missing(error)) throw error; }
}
function safeFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error('Unsafe managed log file');
}
function sameFile(left: Stats, right: Stats): boolean { return left.dev === right.dev && left.ino === right.ino; }
function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!written) throw new Error('Unable to finish managed log write');
    offset += written;
  }
}

/** One managed writer. Copy/truncate preserves the inode used by inherited append FDs. */
export class RotatingLog {
  readonly maxBytes: number;
  readonly backups: number;
  readonly path: string;
  #fd: number | undefined;
  constructor(path: string, options: LogOptions = {}) {
    this.path = path;
    this.maxBytes = options.maxBytes ?? MANAGED_LOG_MAX_BYTES;
    this.backups = options.backups ?? MANAGED_LOG_BACKUPS;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || !Number.isSafeInteger(this.backups) || this.backups < 1 || this.backups > 10) throw new Error('Invalid managed log limits');
    const existing = fileIfPresent(path);
    if (existing) safeFile(existing);
    const fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const opened = fstatSync(fd);
      safeFile(opened);
      if (existing && !sameFile(existing, opened)) throw new Error('Managed log changed while opening');
      fchmodSync(fd, 0o600);
      this.#fd = fd;
    } catch (error) { closeSync(fd); throw error; }
  }
  #current(): Stats {
    if (this.#fd === undefined) throw new Error('Managed log is closed');
    const opened = fstatSync(this.#fd), current = fileIfPresent(this.path);
    safeFile(opened);
    if (!current || !sameFile(current, opened)) throw new Error('Managed log path was replaced');
    return opened;
  }
  /** Verify that a detached child's stdout/stderr still target this exact active file. */
  matchesDescriptor(fd: number): boolean { return sameFile(this.#current(), fstatSync(fd)); }
  #rotate(stat: Stats): boolean {
    // Check every destination before touching any existing backup.
    for (let index = 1; index <= this.backups; index++) {
      const backup = fileIfPresent(`${this.path}.${index}`);
      if (backup) safeFile(backup);
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const copy = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      // Existing oversized logs retain their newest bounded diagnostic bytes.
      const bytes = Buffer.alloc(Math.min(stat.size, this.maxBytes));
      let offset = 0;
      while (offset < bytes.length) {
        const read = readSync(this.#fd!, bytes, offset, bytes.length - offset, stat.size - bytes.length + offset);
        if (!read) throw new Error('Managed log changed while copying');
        offset += read;
      }
      writeAll(copy, bytes);
      fsyncSync(copy);
      // A known concurrent append must not be discarded. A writer can still append
      // between this final check and truncate: external-FD rotation is best effort.
      if (this.#current().size !== stat.size) return false;
      for (let index = this.backups; index >= 1; index--) {
        const source = `${this.path}.${index}`;
        if (!fileIfPresent(source)) continue;
        if (index === this.backups) unlinkSync(source);
        else renameSync(source, `${this.path}.${index + 1}`);
      }
      renameSync(temporary, `${this.path}.1`);
      if (this.#current().size !== stat.size) return false;
      ftruncateSync(this.#fd!, 0);
      return true;
    } finally {
      closeSync(copy);
      try { unlinkSync(temporary); } catch (error) { if (!missing(error)) throw error; }
    }
  }
  /** Pipe-owned writes are split even when a single input chunk exceeds the limit. */
  write(content: string): void {
    if (this.#fd === undefined) return;
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) {
      let stat = this.#current();
      if (stat.size >= this.maxBytes) {
        if (!this.#rotate(stat)) throw new Error('Managed log has concurrent writers');
        stat = this.#current();
      }
      const end = Math.min(bytes.length, offset + this.maxBytes - stat.size);
      writeAll(this.#fd, bytes.subarray(offset, end));
      offset = end;
    }
  }
  /** External appenders can temporarily exceed maxBytes between periodic checks. */
  rotateIfNeeded(): boolean {
    const stat = this.#current();
    return stat.size >= this.maxBytes && this.#rotate(stat);
  }
  close(): void {
    if (this.#fd !== undefined) { const fd = this.#fd; this.#fd = undefined; closeSync(fd); }
  }
}

/** Logging failure consumes diagnostics without interrupting Worker execution. */
export function workerLogWriter(path: string, onError: () => void): { write(content: string): void; close(): void } {
  let log: RotatingLog | undefined;
  let failed = false;
  const fail = () => { try { log?.close(); } catch {} log = undefined; if (!failed) { failed = true; try { onError(); } catch {} } };
  try { log = new RotatingLog(path); } catch { fail(); }
  return {
    write(content) { try { log?.write(content); } catch { fail(); } },
    close() { try { log?.close(); } catch { fail(); } log = undefined; },
  };
}

/** Only daemon-start uses a file FD; foreground/systemd output stays with its caller. */
export function maintainDaemonLog(path: string, inheritedFd: number, onError: () => void): () => void {
  let log: RotatingLog | undefined, timer: NodeJS.Timeout | undefined;
  const report = () => { try { onError(); } catch {} };
  const close = () => { if (timer) clearInterval(timer); timer = undefined; try { log?.close(); } catch {} log = undefined; };
  const check = () => { try { log?.rotateIfNeeded(); } catch { close(); report(); } };
  try {
    log = new RotatingLog(path);
    if (!log.matchesDescriptor(inheritedFd)) throw new Error('Daemon log FD does not match active log');
    timer = setInterval(check, DAEMON_LOG_CHECK_MS);
    timer.unref();
    check();
  } catch { close(); report(); }
  return close;
}
