import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountClient, nodes, text } from './helpers/client-harness.mjs';

const sessions = [{ id: 's1', displayTitle: 'Title', workspaceId: 'w1' }];
const workspaces = [{ id: 'w1', title: 'One', path: '/one' }, { id: 'w2', title: 'Two', path: '/two' }];

test('header session hook is called consistently as displayTitle arrives', async t => {
  const app = mountClient({ sessions, workspaces, current: 's1' });
  t.after(() => app.dispose());
  await app.flush();
  const slot = app.registered.get('session-manager-header');
  let calls = 0;
  const host = app.mountComponent(slot.component, {
    ...slot.options.inject(), t: app.t, sessionId: 's1', displayTitle: 's1',
    useSessions: selector => { calls++; return selector({ ids: ['s1'], byId: { s1: sessions[0] }, current: 's1' }); },
    useWorkspaces: selector => selector({ archivedSessionIds: [] })
  });
  t.after(() => host.dispose());
  const first = calls;
  assert.equal(first, 1);
  calls = 0;
  host.props = { ...host.props, displayTitle: 'Title' };
  host.render();
  assert.equal(calls, first);
});

test('move dialog keeps its hook count when opening and closing', async t => {
  const app = mountClient({ sessions, workspaces, current: 's1' });
  t.after(() => app.dispose());
  await app.flush();
  const row = nodes(app.tree, n => n.props?.['data-session-id'] === 's1')[0];
  const button = nodes(row, n => n.props?.['aria-label'] === '移动至工作区…: Title')[0]
    ?? nodes(row, n => n.props?.['aria-label']?.includes('移动'))[0];
  assert.ok(button);
  button.props.onClick();
  await app.flush();
  const dialog = nodes(app.tree, n => n.type?.name === 'MoveDialog')[0];
  assert.ok(dialog);
  const host = app.mountComponent(dialog.type, { ...dialog.props, open: false });
  t.after(() => host.dispose());
  const closedCount = host.cursor;
  host.props = { ...host.props, open: true };
  host.render();
  assert.equal(host.cursor, closedCount);
  host.props = { ...host.props, open: false };
  host.render();
  assert.equal(host.cursor, closedCount);
});

test('archived session title unarchives before opening, with the same behavior as Open', async t => {
  const app = mountClient({ sessions, archivedIds: ['s1'], workspaces });
  t.after(() => app.dispose());
  await app.flush();
  const order = [];
  app.ctx.uiWorkspace.unarchiveSession = async id => { order.push('unarchive:' + id); };
  app.ctx.uiWorkspace.openSession = id => { order.push('open:' + id); };
  const title = nodes(app.tree, n => n.props?.className === 'sm-rowTitleButton')[0];
  assert.equal(text(title), 'Title');
  title.props.onClick();
  await app.flush();
  assert.deepEqual(order, ['unarchive:s1', 'open:s1']);
});

test('batch result shows cache cleanup warnings even when session deletion succeeded', async t => {
  const app = mountClient({ sessions, workspaces });
  t.after(() => app.dispose());
  await app.flush();
  await app.click('批量处理');
  await app.click('全选筛选');
  const bar = nodes(app.tree, n => n.type?.name === 'BulkActionBar')[0];
  assert.ok(bar);
  bar.props.onAction('favorite');
  await app.flush();
  const result = nodes(app.tree, n => n.type?.name === 'BatchResultDialog')[0];
  assert.ok(result);
  const host = app.mountComponent(result.type, { ...result.props, items: [{ sessionId: 's1', status: 'success', warnings: ['cache cleanup failed'] }] });
  t.after(() => host.dispose());
  assert.match(text(host.tree), /cache cleanup failed/);
  assert.ok(nodes(host.tree, n => n.props?.role === 'status').length);
});
