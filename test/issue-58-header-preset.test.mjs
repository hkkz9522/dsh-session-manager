import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountClient, nodes, text } from './helpers/client-harness.mjs';
const sessions = [{ id: 's1', displayTitle: 'Alpha', agentPreset: 'PresetA' }, { id: 's2', displayTitle: 'Beta', agentPreset: 'PresetA' }];

test('issue #58: header opens the prepared preset dialog and switches the current session', async t => {
  const app = mountClient({ sessions, current: 's1' });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader('s1');
  const button = app.headerControl('切换预设');
  assert.equal(nodes(button, n => n.type === 'svg').length, 1);
  await app.clickHeader('切换预设');
  const dialog = nodes(app.headerTree, n => n.type?.name === 'MigratePresetDialog')[0];
  assert.equal(dialog.props.sessionId, 's1');
  const host = app.mountComponent(dialog.type, dialog.props);
  t.after(() => host.dispose());
  assert.ok(!text(host.tree).includes('处理中'));
  const select = nodes(host.tree, n => n.type === 'select')[0];
  assert.equal(select.props.value, 'PresetA');
  select.props.onChange({ target: { value: 'PresetB' } });
  host.render();
  assert.equal(nodes(host.tree, n => n.props?.className?.includes('sm-nativeDialogConfirm'))[0].props.disabled, false);
  await dialog.props.onRun('PresetB');
  await app.flush();
  const request = app.requests.find(r => r.url === '/session-manager/api/preset-migrate');
  assert.deepEqual(JSON.parse(request.options.body), { sessionId: 's1', toPreset: 'PresetB' });
  assert.equal(nodes(app.headerTree, n => n.type?.name === 'MigratePresetDialog').length, 0);
  assert.ok(app.refreshCalls.includes('sessions'));
});

test('issue #58: running sessions cannot prepare or submit a preset switch', async t => {
  const app = mountClient({ sessions: [{ ...sessions[0], running: true }], current: 's1' });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader('s1');
  const button = app.headerControl('切换预设');
  assert.equal(button.props.disabled, true);
  button.props.onClick();
  await app.flush();
  assert.equal(app.requests.filter(r => r.url.includes('preset-scan')).length, 0);
  assert.equal(app.control('迁移预设: Alpha').props.disabled, true);
});

test('issue #58: narrow-screen More menu exposes the same prepared dialog', async t => {
  const app = mountClient({ sessions, current: 's1', innerWidth: 400 });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader('s1');
  const more = nodes(app.headerTree, n => n.props?.className?.includes('sm-headerCompactMenuBtn'))[0];
  more.props.onClick();
  await app.flush();
  const item = nodes(app.headerTree, n => n.props?.role === 'menuitem' && text(n) === '切换预设')[0];
  assert.ok(item);
  item.props.onClick();
  await app.flush();
  assert.ok(nodes(app.headerTree, n => n.type?.name === 'MigratePresetDialog').length);
});

test('issue #58: changing header session cancels an old preparation response', async t => {
  let finish;
  const app = mountClient({ sessions, current: 's1', fetchPresetScan: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => app.dispose());
  await app.flush();
  const slot = app.registered.get('session-manager-header');
  const host = app.mountComponent(slot.component, {
    ...slot.options.inject(), t: app.t, sessionId: 's1', displayTitle: 'Alpha',
    useSessions: select => select({ byId: Object.fromEntries(sessions.map(s => [s.id, s])), ids: ['s1', 's2'], current: 's1' }),
    useWorkspaces: select => select({ archivedSessionIds: [] })
  });
  t.after(() => host.dispose());
  nodes(host.tree, n => n.props?.['aria-label'] === '切换预设')[0].props.onClick();
  host.render();
  host.props = { ...host.props, sessionId: 's2', displayTitle: 'Beta' };
  host.render();
  finish({ ok: true, result: { availablePresets: ['PresetB'] } });
  await app.flush();
  host.render();
  assert.equal(nodes(host.tree, n => n.type?.name === 'MigratePresetDialog').length, 0);
});

test('issue #58: header preparation failure is visible and can be retried', async t => {
  let fail = true;
  const app = mountClient({ sessions, current: 's1', fetchPresetScan: async () => fail
    ? { ok: false, error: 'preset list unavailable' }
    : { ok: true, result: { availablePresets: ['PresetB'] } } });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader('s1');
  await app.clickHeader('切换预设');
  assert.equal(nodes(app.headerTree, n => n.type?.name === 'MigratePresetDialog').length, 0);
  assert.ok(app.alerts.some(message => message.includes('preset list unavailable')));
  assert.equal(app.headerControl('切换预设').props['aria-busy'], false);
  fail = false;
  await app.clickHeader('切换预设');
  assert.ok(nodes(app.headerTree, n => n.type?.name === 'MigratePresetDialog').length);
});

test('issue #58: English header uses a localized accessible preset action', async t => {
  const app = mountClient({ sessions, current: 's1', language: 'en' });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader('s1');
  assert.ok(app.headerControl('Switch preset'));
  await app.clickHeader('Switch preset');
  assert.ok(nodes(app.headerTree, n => n.type?.name === 'MigratePresetDialog').length);
});
