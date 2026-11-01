import { DurableTaskStore, CoreError } from '../../src/core/index.js';

const [databasePath, action, workspaceId = 'workspace', workerId = 'worker', requestId = 'request'] = process.argv.slice(2);
if (!databasePath || !action) throw new Error('Missing fixture arguments');
const store = new DurableTaskStore(databasePath);

const execute = (): void => {
  try {
    const { task } = store.dispatch({ requestId, workspaceId, workerId, prompt: 'Durability fixture' });
    if (action === 'intent' || action === 'result') {
      store.beginDispatch(task.taskId);
      if (action === 'result') {
        store.acknowledgeDispatch(task.taskId, { sessionId: 'native-session', turnId: 'native-turn' });
        store.transitionTask(task.taskId, 'verifying', {
          executionStopped: { kind: 'runtime_terminal', evidence: 'Recorded terminal runtime event' },
        });
        store.completeTask(task.taskId, {
          summary: 'Immutable delivery',
          artifacts: [{ kind: 'patch', path: '/immutable.patch', sizeBytes: 12, sha256: 'a'.repeat(64) }],
        }, { status: 'succeeded' });
      }
    }
    process.stdout.write(`${JSON.stringify({ taskId: task.taskId })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ error: error instanceof CoreError ? error.code : String(error) })}\n`);
  }
  if (action === 'race') {
    store.close();
    process.exit(0);
  }
};

if (action === 'race') {
  process.stdout.write('ready\n');
  process.stdin.once('data', execute);
} else {
  execute();
  // The parent uses SIGKILL: intentionally do not close or checkpoint SQLite.
  setInterval(() => {}, 1_000);
}
