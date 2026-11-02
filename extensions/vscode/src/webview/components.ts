import type { RenderContext } from './components/types.js';
import { el } from './components/dom.js';
import { empty, renderActionFeedback } from './components/feedback.js';
import { renderHeader, renderConnection, renderNavigation, renderWelcome } from './components/header.js';
import { notice } from './components/primitives.js';
import { renderSettings } from './components/views/settings.js';
import { renderResources } from './components/views/resources/index.js';
import { renderComposer } from './components/views/composer.js';
import { renderTasks } from './components/views/tasks.js';

export * from './components/types.js';
export * from './components/dom.js';
export * from './components/primitives.js';
export * from './components/button.js';
export * from './components/feedback.js';
export * from './components/header.js';
export * from './components/views/tasks.js';
export * from './components/views/task-detail.js';
export * from './components/views/resources/index.js';
export * from './components/views/composer.js';
export * from './components/views/settings.js';

export function renderApp(ctx: RenderContext): HTMLElement {
  const snapshot = ctx.state.snapshot;
  const root = el('div', 'workbench');
  root.append(renderHeader(ctx));
  if (!snapshot) {
    root.append(empty('正在打开工作台', '正在读取连接状态。', { icon: 'clock' }));
    return root;
  }
  root.append(renderConnection(ctx, snapshot), renderNavigation(ctx));
  if (snapshot.notice) root.append(notice(snapshot.notice, 'warning'));
  const feedback = renderActionFeedback(ctx);
  if (feedback) root.append(feedback);
  const main = el('main', 'main-content');
  main.id = 'main-content';
  if (ctx.state.page === 'settings') main.append(renderSettings(ctx, snapshot));
  else if (snapshot.connection.state === 'disconnected' || (snapshot.connection.state === 'error' && !snapshot.tasks.length)) main.append(renderWelcome(ctx, snapshot));
  else if (ctx.state.page === 'resources') main.append(renderResources(ctx, snapshot));
  else if (ctx.state.page === 'compose') main.append(renderComposer(ctx, snapshot));
  else main.append(renderTasks(ctx, snapshot));
  root.append(main);
  const live = el('div', 'sr-only', ctx.state.message);
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  root.append(live);
  return root;
}
