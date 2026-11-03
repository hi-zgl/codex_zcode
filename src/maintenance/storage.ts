import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { DAEMON_LOG_CHECK_MS, MANAGED_LOG_BACKUPS, MANAGED_LOG_MAX_BYTES } from '../shared/rotating-log.js';

const retention = {
  managed_logs: 'Managed server.log and daemon.log: 5 MiB per file and 3 backups. Worker pipe writes are bounded; daemon inherited-FD copy/truncate checks every 5 seconds, can temporarily exceed the limit and can lose concurrent diagnostic writes. Official runtime internal logs are not rotated here.',
  deliveries: 'Saved deliveries and file snapshots are retained indefinitely; task and acceptance history can reference them. No automatic deletion.',
  worker_data: 'Worker sessions, official runtime state and injected credentials are retained indefinitely, including stopped or unknown Workers. No automatic deletion.',
  scheduler_state: 'SQLite, WAL, task history and scheduler metadata are retained indefinitely. No automatic deletion; a running database requires a consistent backup.',
  accounts: 'Encrypted account vault and keys are retained indefinitely. No automatic deletion; back up the vault with its key.',
  workspaces: 'Existing terminal-workspace cleanup applies only after its saved results and lifecycle are proven safe. This command does not clean workspaces.',
  other: 'Unclassified files and legacy paths are retained. This command neither reads file contents nor deletes data.',
} as const;
type Category = keyof typeof retention;
function category(path: string): Category {
  if (/^(?:scheduler\/daemon\.log|workers\/[^/]+\/logs\/server\.log)(?:\.[1-3])?$/.test(path)) return 'managed_logs';
  if (path.startsWith('scheduler/artifacts/')) return 'deliveries';
  if (/^workers\/[^/]+\/data\//.test(path)) return 'worker_data';
  if (path.startsWith('scheduler/')) return 'scheduler_state';
  if (path.startsWith('accounts/')) return 'accounts';
  if (path.startsWith('workspaces/')) return 'workspaces';
  return 'other';
}

/** Metadata-only, non-atomic logical byte count. Directory FDs prevent symlink traversal. */
export function storageStatus(poolRoot: string) {
  if (process.platform !== 'linux') throw new Error('Storage status requires Linux directory FD traversal');
  const root = resolve(poolRoot);
  const categories = Object.fromEntries(Object.entries(retention).map(([name, policy]) => [name, { logicalBytes: 0, files: 0, retention: policy }])) as Record<Category, { logicalBytes: number; files: number; retention: string }>;
  let exists = true, skippedSymlinks = 0, skippedSpecialFiles = 0, unreadableEntries = 0, changedEntries = 0, depthLimitedDirectories = 0;
  function visit(path: string, relativePath: string, depth: number): void {
    let stat: Stats;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!relativePath) exists = false;
        else changedEntries++;
      } else unreadableEntries++;
      return;
    }
    if (stat.isSymbolicLink()) { skippedSymlinks++; return; }
    if (stat.isFile()) { const entry = categories[category(relativePath)]; entry.logicalBytes += stat.size; entry.files++; return; }
    if (!stat.isDirectory()) { skippedSpecialFiles++; return; }
    if (depth >= 64) { depthLimitedDirectories++; return; }
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) { changedEntries++; return; }
      // Resolve child paths through the held directory, not a mutable pathname.
      const directory = `/proc/self/fd/${fd}`;
      for (const name of readdirSync(directory)) visit(join(directory, name), relativePath ? `${relativePath}/${name}` : name, depth + 1);
    } catch { unreadableEntries++; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  visit(root, '', 0);
  const entries = Object.values(categories);
  return {
    root, exists, measuredAtMs: Date.now(), measurement: 'logical_regular_file_bytes', consistency: 'non_atomic',
    complete: !skippedSymlinks && !unreadableEntries && !changedEntries && !depthLimitedDirectories,
    logicalBytes: entries.reduce((sum, entry) => sum + entry.logicalBytes, 0), files: entries.reduce((sum, entry) => sum + entry.files, 0),
    skippedSymlinks, skippedSpecialFiles, unreadableEntries, changedEntries, depthLimitedDirectories,
    notes: ['Hard links are counted per path. Logical bytes are not physical disk usage.', 'Symlinks are not followed. This snapshot can change while the pool runs.', 'No files are created, read for content, migrated or deleted.'],
    managedLogPolicy: { maxBytes: MANAGED_LOG_MAX_BYTES, backups: MANAGED_LOG_BACKUPS, daemonCheckMs: DAEMON_LOG_CHECK_MS },
    categories,
  };
}
