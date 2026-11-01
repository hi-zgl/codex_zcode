#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('ZCode Pool requires Node.js 24 or later.');
  process.exitCode = 1;
} else {
  // Resolve everything from this installed package, never from the user's cwd.
  const child = spawn(process.execPath, [
    '--import', import.meta.resolve('tsx'),
    fileURLToPath(new URL('../src/cli/main.ts', import.meta.url)),
    ...process.argv.slice(2),
  ], { stdio: 'inherit', env: process.env });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forward = new Map(signals.map(signal => [signal, () => child.kill(signal)]));
  for (const [signal, handler] of forward) process.on(signal, handler);
  child.once('error', () => { console.error('Could not start the ZCode Pool CLI.'); process.exitCode = 1; });
  child.once('close', (code, signal) => {
    for (const [name, handler] of forward) process.off(name, handler);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
