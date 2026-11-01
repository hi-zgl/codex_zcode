/** Explicit opt-in official-runtime smoke test. Never included in the unit-test glob. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { discoverEndpoint } from '../src/runtime/probe.js';
import type { RuntimeEvent, SessionRef, TurnRef } from '../src/runtime/types.js';
import { ZCodeServerAdapter, redact } from '../src/runtime/zcode-server/index.js';

if (process.env.ZCODE_POOL_LIVE !== '1') throw new Error('Set ZCODE_POOL_LIVE=1 to explicitly enable this real quota-consuming isolated smoke test');
function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1]!;
}
const serverRoot = resolve(argument('--server-root'));
const workspacePath = resolve(argument('--workspace'));
const artifacts = resolve(argument('--artifacts'));
const resumeIndex = process.argv.indexOf('--session-id');
const resumeSessionId = resumeIndex < 0 ? undefined : argument('--session-id');
const resumeTurnIndex = process.argv.indexOf('--resume-turn');
const resumeTurnId = resumeTurnIndex < 0 ? undefined : argument('--resume-turn');
if (resumeTurnId && !resumeSessionId) throw new Error('--resume-turn requires its explicit --session-id');
await mkdir(workspacePath, { recursive: true, mode: 0o700 });
if ((await readdir(workspacePath)).length && !resumeSessionId) throw new Error('Live smoke requires a new, empty, explicitly selected isolated workspace');
await mkdir(artifacts, { recursive: true, mode: 0o700 });
const initialCode = 'export function add(a, b) { return a - b; }\n';
const initialTest = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from './arithmetic.mjs';\ntest('adds two numbers', () => assert.equal(add(2, 3), 5));\n";
if (resumeSessionId && !resumeTurnId) {
  assert.equal(await readFile(join(workspacePath, 'arithmetic.mjs'), 'utf8'), initialCode, 'Only untouched fixture drafts can be resumed by this smoke command');
  assert.equal(await readFile(join(workspacePath, 'arithmetic.test.mjs'), 'utf8'), initialTest);
} else if (!resumeSessionId) {
  await writeFile(join(workspacePath, 'arithmetic.mjs'), initialCode);
  await writeFile(join(workspacePath, 'arithmetic.test.mjs'), initialTest);
}

const protocol: unknown[] = [];
const events: RuntimeEvent[] = [];
const connection = await new ZCodeServerAdapter({ rpcTimeoutMs: 60_000, onProtocolMessage: (message) => protocol.push(message) }).connect(await discoverEndpoint(serverRoot));
const modelSelection = { providerId: 'account:zai-start-plan', modelId: 'GLM-5.3-Flash' };
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), workspacePath, providerId: modelSelection.providerId, modelId: modelSelection.modelId };
let session: SessionRef | undefined;
let currentTurn: TurnRef | undefined;
let fatalError: unknown;

function approveIsolatedOperation(event: RuntimeEvent): boolean {
  if (event.data.kind !== 'permission') return false;
  const payload = event.data.payload as Record<string, any> | undefined;
  const details = JSON.stringify(payload?.detail ?? {});
  // All requests are printed for review. Permission only follows the user-authorized tiny fixture task.
  // Reject explicit absolute paths outside the supplied fixture workspace; cwd itself is not a sandbox.
  const paths = [...details.matchAll(/"(?:file_path|path|filePath|cwd)"\s*:\s*"([^"]+)"/g)].map((match) => match[1]!);
  if (paths.some((path) => isAbsolute(path) && path !== workspacePath && !path.startsWith(`${workspacePath}/`))) return false;
  if (['Bash', 'Shell'].includes(String(payload?.toolName))) {
    const command = payload?.detail?.command ?? payload?.detail?.input?.command;
    return typeof command === 'string' && (/^(?:node --test(?: arithmetic\.test\.mjs)?|pwd|ls(?: -la)?)\s*$/.test(command) || command.trim() === `node --test ${join(workspacePath, 'arithmetic.test.mjs')}`);
  }
  return ['Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'Shell', 'Glob', 'Grep', 'LS'].includes(String(payload?.toolName));
}
async function finish(turn: TurnRef): Promise<void> {
  const deadline = setTimeout(() => void connection.close(), 5 * 60_000);
  try {
    for await (const event of connection.events(turn, events.at(-1)?.cursor)) {
      events.push(event);
      if (['turn_started', 'approval_requested', 'turn_completed', 'turn_failed', 'turn_cancelled', 'error'].includes(event.type)) process.stdout.write(`${JSON.stringify({ type: event.type, turnId: event.turnId, data: event.type === 'approval_requested' || event.type === 'error' ? event.data : { runtimeTurnId: event.data.runtimeTurnId, state: event.data.state } })}\n`);
      if (event.type === 'approval_requested') {
        if (!approveIsolatedOperation(event)) throw new Error('Live smoke encountered an approval outside its narrow fixture policy');
        await connection.respondApproval(turn, String(event.data.approvalId), 'accept');
      }
      if (event.turnId === turn.turnId && ['turn_completed', 'turn_failed', 'turn_cancelled'].includes(event.type)) {
        if (event.type !== 'turn_completed') throw new Error(`Official task terminated as ${event.type}`);
        return;
      }
    }
    throw new Error('Official connection ended before terminal evidence');
  } finally { clearTimeout(deadline); }
}

try {
  const status = await connection.providerStatus(true);
  evidence.providerStatus = (status.providers as Array<Record<string, any>> | undefined)?.filter((provider) => provider.providerId === modelSelection.providerId).map((provider) => ({ providerId: provider.providerId, executable: provider.executable, accountState: provider.accountState }));
  evidence.quotaBefore = await connection.quota(modelSelection.providerId);
  session = await connection.openSession({ workspacePath, ...(resumeSessionId ? { sessionId: resumeSessionId } : {}), modelSelection, mode: 'build' });
  evidence.sessionId = session.sessionId;
  process.stdout.write(`${JSON.stringify({ type: 'session_opened', sessionId: session.sessionId, modelSelection: (await connection.syncHistory(session)).modelSelection })}\n`);
  currentTurn = resumeTurnId ? { ...session, turnId: resumeTurnId, commandId: resumeTurnId } : await connection.sendTurn(session, { prompt: 'This is a tiny isolated validation fixture. Fix arithmetic.mjs so the existing arithmetic.test.mjs passes. Run node --test arithmetic.test.mjs. Change only these fixture files if necessary. Do not commit anything.', modelSelection });
  evidence.firstTurn = currentTurn;
  await finish(currentTurn);
  evidence.firstSnapshot = await connection.syncHistory(session);
  evidence.firstVerification = await promisify(execFile)(process.execPath, ['--test', 'arithmetic.test.mjs'], { cwd: workspacePath, timeout: 30_000 });
  currentTurn = await connection.sendTurn(session, { prompt: 'Continue the same fixture task in this same session. Extend the function you just fixed to accept a third numeric argument, defaulting to 0. Add a test for the new case and run the test file again. Preserve its existing two-argument behavior. Do not commit.', modelSelection });
  evidence.secondTurn = currentTurn;
  await finish(currentTurn);
  evidence.secondSnapshot = await connection.syncHistory(session);
  evidence.secondVerification = await promisify(execFile)(process.execPath, ['--test', 'arithmetic.test.mjs'], { cwd: workspacePath, timeout: 30_000 });
  const code = await readFile(join(workspacePath, 'arithmetic.mjs'), 'utf8');
  const exports = await import(`${pathToFileURL(join(workspacePath, 'arithmetic.mjs')).href}?v=${Date.now()}`);
  assert.equal(exports.add(2, 3), 5);
  assert.equal(exports.add(2, 3, 4), 9);
  evidence.finalCode = code;
  evidence.quotaAfter = await connection.quota(modelSelection.providerId);
  evidence.completedAt = new Date().toISOString();
  evidence.status = 'passed';
} catch (error) {
  fatalError = error;
  evidence.status = 'failed'; evidence.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
  if (session) evidence.finalSnapshot = await connection.syncHistory(session).catch(() => undefined);
} finally {
  await connection.close();
  await writeFile(join(artifacts, 'live-smoke-evidence.json'), JSON.stringify(redact(evidence), null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(artifacts, 'live-smoke-events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 });
  await writeFile(join(artifacts, 'live-smoke-protocol.json'), JSON.stringify(redact(protocol), null, 2) + '\n', { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ status: evidence.status, sessionId: session?.sessionId, artifacts, error: evidence.error })}\n`);
if (fatalError) process.exitCode = 1;
