import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Runs the real Webview bundle against the real Host action/router code, with only
// the native VS Code adapter and daemon transport replaced by isolated test doubles.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.test-browser');
await mkdir(output, { recursive: true });
// Use the same source/target as the production Webview build, in an isolated output
// directory so browser verification never races the extension watch/build process.
await build({ entryPoints: [join(root, 'src/webview/main.ts')], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: join(output, 'webview.js'), logLevel: 'silent' });
const hostBundle = join(output, 'host.mjs');
await build({ stdin: { contents: `export {ActionService} from './src/host/actions.ts'; export {MessageRouter} from './src/host/router.ts'; export {MockTransport,loadMockFixture} from './src/host/mock.ts';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: hostBundle, logLevel: 'silent' });
const { ActionService, MessageRouter, MockTransport, loadMockFixture } = await import(pathToFileURL(hostBundle).href);
const fixture = await loadMockFixture(join(root, 'test/fixtures/pool-demo.json'));
// Review lifetime is wall-clock bounded in production. Test data starts fresh per run.
for (const review of Object.values(fixture.reviews)) review.expiresAtMs = Date.now() + 300_000;
const files = {
  '/main.js': ['text/javascript', await readFile(join(output, 'webview.js'))],
  '/styles.css': ['text/css', await readFile(join(root, 'media/styles.css'))],
  '/theme.css': ['text/css', `
  :root {--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-focusBorder:#f3ad4e;--vscode-button-background:#bf7e26;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#aa7020;--vscode-button-secondaryBackground:#3a3a3a;--vscode-button-secondaryForeground:#fff;--vscode-errorForeground:#f48771;--vscode-testing-iconPassed:#89d185;--vscode-descriptionForeground:#aaa;--vscode-panel-border:#3b3b3b;--vscode-input-border:#4d4d4d;--vscode-input-background:#252526;--vscode-input-foreground:#eee;--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#ddd;--vscode-foreground:#ddd;--vscode-sideBar-background:#252526;--vscode-textCodeBlock-background:#171717;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#3c3e40;--vscode-textLink-foreground:#dfac6a;}
  :root.vscode-light {--vscode-editor-background:#fff;--vscode-editor-foreground:#222;--vscode-foreground:#222;--vscode-sideBar-background:#f3f3f3;--vscode-descriptionForeground:#555;--vscode-panel-border:#d6d6d6;--vscode-input-background:#fff;--vscode-input-foreground:#222;--vscode-input-border:#aaa;--vscode-textCodeBlock-background:#f1f1f1;--vscode-list-hoverBackground:#eee;--vscode-list-activeSelectionBackground:#dceaf5;--vscode-button-secondaryBackground:#ddd;--vscode-button-secondaryForeground:#222;--vscode-textLink-foreground:#805000;}
  :root.vscode-high-contrast {--vscode-editor-background:#000;--vscode-editor-foreground:#fff;--vscode-foreground:#fff;--vscode-sideBar-background:#000;--vscode-descriptionForeground:#fff;--vscode-panel-border:#fff;--vscode-contrastBorder:#fff;--vscode-focusBorder:#f38518;--vscode-input-background:#000;--vscode-input-foreground:#fff;--vscode-input-border:#fff;--vscode-textCodeBlock-background:#000;}
  `],
};
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-test-browser'; style-src 'self'; img-src 'self' data:; connect-src 'none';"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"></head><body class="vscode-dark"><div id="app"></div><script nonce="test-browser" src="/main.js"></script></body></html>`;
const server = createServer((request, response) => {
  const file = request.url === '/' ? ['text/html', html] : files[request.url];
  if (!file) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { 'Content-Type': file[0] }); response.end(file[1]);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const browser = await chromium.launch({ executablePath: process.env.ZCODE_POOL_CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] }).catch(async error => {
  await new Promise(resolve => server.close(resolve)); throw error;
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' }).catch(async error => {
  await browser.close(); await new Promise(resolve => server.close(resolve)); throw error;
});
const errors = []; const messages = []; const nativeCalls = []; const storage = new Map();
let transport; let trusted = true; let service; let router;
let delivery = Promise.resolve();
function send(message) {
  const copy = structuredClone(message);
  delivery = delivery.then(() => page.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), copy));
  delivery.catch(error => errors.push(error.message));
}
service = new ActionService({ mode: 'mock', poolHome: '/mock/pool', host: 'Browser test / isolated mock', authority: 'browser-test',
  createTransport: async () => (transport = new MockTransport(fixture)),
  native: {
    trusted: () => trusted,
    getState: (key, fallback) => storage.get(key) ?? fallback,
    setState: async (key, value) => { storage.set(key, structuredClone(value)); },
    pickAccountFiles: async () => { nativeCalls.push('pickAccountFiles'); return undefined; },
    pickRepository: async () => { nativeCalls.push('pickRepository'); return undefined; },
    openDiff: async (taskId, manifestHash, file, read) => { nativeCalls.push({ action: 'diff', taskId, manifestHash, fileId: file.fileId, base: await read('base'), final: await read('final') }); },
    openSettings: async () => { nativeCalls.push('openSettings'); }, saveInterval: async () => {},
    copyDiagnostics: async () => { nativeCalls.push('copyDiagnostics'); }, guidance: async () => {},
  }, onSnapshot: snapshot => send({ v: 1, type: 'state', generation: snapshot.connection.generation, data: snapshot }),
});
router = new MessageRouter(service, send);
page.on('pageerror', error => errors.push(error.message));
await page.exposeFunction('__hostBridge', async message => { messages.push(structuredClone(message)); await router.receive(message); });
await page.addInitScript(() => {
  let state; let acquired = false;
  window.acquireVsCodeApi = () => {
    if (acquired) throw new Error('VS Code API acquired twice'); acquired = true;
    return { postMessage: message => { void window.__hostBridge(message); }, getState: () => state,
      setState: value => { state = structuredClone(value); window.__persistedUi = state; } };
  };
});
const action = (name, extra = '') => page.locator(`[data-action="${name}"]${extra}`).first();
const waitState = async predicate => {
  for (let count = 0; count < 100; count++) { if (predicate(service.snapshot())) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Host state condition timed out');
};
async function checkLayout(name) {
  for (const width of [280, 320, 360, 760, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
      clipped: [...document.querySelectorAll('button,input,select,textarea')].flatMap(element => {
        const r = element.getBoundingClientRect();
        return r.width > 0 && (r.left < -2 || r.right > innerWidth + 2) ? [element.getAttribute('aria-label') || element.textContent || element.tagName] : [];
      }),
    }));
    assert.ok(geometry.scroll <= geometry.width + 2, `${name}/${width} horizontal overflow: ${JSON.stringify(geometry)}`);
    assert.deepEqual(geometry.clipped, [], `${name}/${width} controls outside viewport`);
    if (width === 320) await page.screenshot({ path: join(output, `${name}-320.png`), fullPage: true });
  }
}
const report = [];
try {
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await action('connect').waitFor();
  assert.equal(transport, undefined, 'opening the view must not create a transport');
  await action('connect').click();
  await waitState(state => state.connection.state === 'connected');
  await action('task.select').waitFor();
  assert.ok(transport.calls.every(call => ['ui_capabilities', 'overview', 'ui_list_tasks', 'ui_get_task_detail'].includes(call.method)), 'initial connection is read-only');
  report.push('Explicit connection and real Host/router bridge; no transport before click');

  // Test responsive geometry and themes using the actual bundled styles and browser layout.
  for (const theme of ['vscode-dark', 'vscode-light', 'vscode-high-contrast']) {
    await page.evaluate(value => { document.body.className = value; document.documentElement.className = value; }, theme);
    await checkLayout(theme);
    await page.screenshot({ path: join(output, `${theme}-tasks.png`), fullPage: true });
  }
  report.push('Task list geometry: 280/320/360/760/1280 px, dark/light/high contrast');
  await page.evaluate(() => { document.body.className = 'vscode-dark'; document.documentElement.className = 'vscode-dark'; });
  await page.setViewportSize({ width: 1280, height: 900 });

  await action('task.select', '[data-task-id="task-complete"]').click();
  await waitState(state => state.selectedTaskId === 'task-complete' && state.detail);
  await action('tab', '[data-tab="delivery"]').click();
  await action('artifacts.list').click();
  await waitState(state => state.delivery.files.length > 0);
  await action('diff.open').click();
  await waitState(() => nativeCalls.some(call => call.action === 'diff'));
  const opened = nativeCalls.find(call => call.action === 'diff');
  assert.ok(typeof opened.base === 'string' && typeof opened.final === 'string');
  assert.notEqual(opened.base, opened.final);
  await page.screenshot({ path: join(output, 'delivery.png'), fullPage: true });
  await checkLayout('delivery');
  report.push('Immutable file manifest and original Host native-diff content reads');

  await action('page', '[data-page="resources"]').click();
  await action('accounts.import').click();
  assert.ok(nativeCalls.includes('pickAccountFiles'));
  assert.ok(!transport.calls.some(call => call.method === 'import_accounts'), 'cancelled picker must not import');
  await page.screenshot({ path: join(output, 'resources.png'), fullPage: true });
  await checkLayout('resources');
  report.push('Resource screen and cancelled native import picker have no daemon mutation');

  trusted = false; service.trustChanged(); await delivery;
  await page.getByText('受限模式', { exact: true }).first().waitFor();
  assert.equal(await action('accounts.import').isDisabled(), true);
  trusted = true; service.trustChanged(); await delivery;
  report.push('Workspace trust change disables mutation UI');

  await action('page', '[data-page="tasks"]').click();
  await action('task.select', '[data-task-id="task-approval"]').click();
  await action('tab', '[data-tab="approvals"]').click();
  await action('approvals.list').click();
  await action('approval.open').click();
  await action('approval.respond', '[data-decision="accept"]').waitFor();
  await page.waitForFunction(() => !!document.querySelector('[data-action="approval.respond"][data-decision="accept"]') && !document.querySelector('[data-action="approval.respond"][data-decision="accept"]').disabled);
  await page.screenshot({ path: join(output, 'approval.png'), fullPage: true });
  await checkLayout('approval');
  await action('approval.respond', '[data-decision="accept"]').click();
  await waitState(() => transport.calls.filter(call => call.method === 'ui_respond_approval').length === 1);
  assert.equal(transport.calls.filter(call => call.method === 'ui_respond_approval').length, 1);
  report.push('One-click complete approval read, hash validation and single fingerprint-bound answer');

  await action('compose.open').click();
  await checkLayout('compose');
  await page.screenshot({ path: join(output, 'compose.png'), fullPage: true });
  // Keyboard navigation must land on a named, visible control rather than losing focus.
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => ({ tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent || '' }));
  assert.ok(focused.tag && !['BODY', 'HTML'].includes(focused.tag));
  report.push('Delivery, resources, approval and composer geometry at all five widths; keyboard focus retained');

  const availableWorkspace = service.snapshot().resources.workspaces.find(workspace => !workspace.activeTaskId);
  const availableWorker = service.snapshot().resources.workers.find(worker => worker.state === 'ready' && !worker.leaseTaskIds.length);
  assert.ok(availableWorkspace && availableWorker);
  await page.locator('[data-field="draft.workspaceId"]').selectOption(availableWorkspace.workspaceId);
  await page.locator('[data-field="draft.workerId"]').selectOption(availableWorker.workerId);
  const promptCanary = 'BROWSER_DRAFT_CANARY: implement a mock change without real execution';
  await page.locator('[data-field="draft.prompt"]').fill(promptCanary);
  await action('dispatch').click();
  await waitState(state => state.actions.some(receipt => receipt.key.startsWith('dispatch:') && receipt.phase === 'succeeded') && state.selectedTaskId?.startsWith('task-mock-'));
  const dispatched = transport.calls.filter(call => call.method === 'dispatch_task');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].params.prompt, promptCanary);
  assert.equal(dispatched[0].params.busy_retry_limit, 3);
  assert.ok(!JSON.stringify([...storage.values()]).includes(promptCanary), 'Host recovery storage excludes prompt');
  await action('cancel').click();
  await waitState(state => !!state.detail?.cancelRequestedAtMs);
  assert.equal(service.snapshot().detail.leaseHeld, true, 'cancellation request does not prove release');
  assert.ok(transport.calls.filter(call => call.method === 'cancel_task').length === 1);
  report.push('Composer dispatches once with stable identity/default immediate continuation limit; cancellation retains unproved occupancy');

  const stoppingCallsBeforeDisconnect = transport.calls.filter(call => ['daemon_stop', 'stop_worker', 'cancel_task'].includes(call.method)).length;
  await action('disconnect').click();
  await waitState(state => state.connection.state === 'disconnected');
  assert.equal(transport.calls.filter(call => ['daemon_stop', 'stop_worker', 'cancel_task'].includes(call.method)).length, stoppingCallsBeforeDisconnect, 'disconnect must not stop work');
  const persisted = await page.evaluate(() => JSON.stringify(window.__persistedUi ?? {}));
  assert.ok(!/approvalContents|verifyCommands|contentSha256|"prompt"/.test(persisted), 'UI persistence must not contain content');
  assert.deepEqual(errors, []);
  report.push('Disconnect leaves tasks alone; UI persistence contains navigation only; zero browser exceptions');
  await writeFile(join(output, 'report.json'), JSON.stringify({ browser: browser.version(), checks: report, messages: messages.map(message => message.type) }, null, 2));
  console.log(report.map(check => `PASS: ${check}`).join('\n'));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Browser errors:', errors);
  console.error('Bridge messages:', messages.map(message => message.type));
  console.error('Mock methods:', transport?.calls.map(call => call.method));
  console.error('Host receipts:', service.snapshot().actions.map(({ key, phase, error }) => ({ key, phase, code: error?.code })));
  throw error;
} finally {
  router.dispose(); service.dispose();
  await delivery.catch(() => {}); await browser.close();
  await new Promise(resolve => server.close(resolve));
}
