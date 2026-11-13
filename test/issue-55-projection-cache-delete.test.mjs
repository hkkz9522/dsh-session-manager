import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { assertProjectionCachePath, removeLegacyProjectionCache } from '../lib/compat/projection-cache-delete.js';
import { mountPlugin } from './helpers/plugin-harness.mjs';

async function fixture(t, { linkedHome = false } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), 'dsh-projcache-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const servedHome = linkedHome ? home + '-linked' : home;
  if (linkedHome) {
    await fs.symlink(home, servedHome, process.platform === 'win32' ? 'junction' : 'dir');
    t.after(() => fs.unlink(servedHome));
  }
  const headers = ['s1', 's2', 'keep'].map((id, i) => ({ id, createdAt: i + 1, cwd: '/workspace', version: 4, origin: 'user' }));
  const files = new Map();
  for (const header of headers) {
    const path = join(home, 'sessions', 'project', header.id, 'session.v4.jsonl');
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(header) + '\n');
    files.set(header.id, path);
  }
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions');
  await fs.mkdir(cacheDir, { recursive: true });
  const records = new Map();
  let chain = Promise.resolve();
  const enqueue = fn => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };
  const table = {
    host: { unit: { descriptor: { layout: 'per-record' } } },
    get: id => records.get(id),
    put(id, record) { return enqueue(async () => { await fs.writeFile(join(cacheDir, id + '.json'), JSON.stringify(record)); records.set(id, record); }); },
    delete(id) { return enqueue(async () => { await fs.rm(join(cacheDir, id + '.json'), { force: true }); return records.delete(id); }); },
  };
  for (const h of headers) await table.put(h.id, { identity: { createdAt: h.createdAt }, rows: { title: h.id } });
  const legacy = join(home, 'storages', 'session_projcache.json');
  await fs.writeFile(legacy, JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, tables: { sessions: Object.fromEntries(records), unrelated: { keep: 1 } } }));
  const live = new Map();
  const delayed = [];
  const warnings = [];
  const cache = { requireTable: () => table };
  const registry = { list: () => [], requireState: () => ({ workspaces: [], archivedSessionIds: [] }), setState: async () => {}, enqueueOperation: async fn => fn() };
  const services = { sessionProjectionCache: cache, dshHomePath: (...parts) => join(servedHome, ...parts), sessionPersistence: { list: async () => headers, locate: h => ({ path: join(servedHome, relative(home, files.get(h.id))) }) } };
  const ctx = {
    get: name => services[name], workspaceRegistry: registry,
    sessions: { get: id => live.get(id), flush: async () => {}, store: { get: id => live.has(id) ? { detach() { const session = live.get(id); live.delete(id); ctx.emit('session/disposed', session); } } : undefined } },
    agents: { get: () => undefined }, waterfall: async (name, payload, fallback) => fallback(),
    emit(name, session) { if (name === 'session/disposed' && session.header) delayed.push(() => table.put(session.id, { identity: { createdAt: session.header.createdAt }, rows: { title: 'late' } })); },
    logger: { info() {}, warn: message => warnings.push(message) },
  };
  return { home, servedHome, headers, files, records, table, legacy, live, delayed, warnings, cache, ctx, plugin: mountPlugin(ctx) };
}

for (const batch of [false, true]) {
  test(`issue #56: linked home supports ${batch ? 'batch' : 'single'} deletion without cleanup warnings`, async t => {
    const f = await fixture(t, { linkedHome: true });
    f.live.set('s1', { id: 's1', header: f.headers[0] });
    const result = batch
      ? await f.plugin.request('/batch', { action: 'delete', sessionIds: ['s1', 's2'] })
      : await f.plugin.request('/delete', { sessionId: 's1' });
    assert.equal(result.status, 200);
    const items = batch ? result.data.result.items : [result.data.result];
    for (const item of items) assert.equal(item.warnings?.length ?? 0, 0, JSON.stringify(item));
    for (const id of batch ? ['s1', 's2'] : ['s1']) {
      assert.equal(f.records.has(id), false);
      await assert.rejects(fs.access(f.files.get(id)), { code: 'ENOENT' });
      await assert.rejects(fs.access(join(f.home, 'storages/session_projcache/sessions', id + '.json')), { code: 'ENOENT' });
      assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(f.legacy, 'utf8')).tables.sessions, id), false);
    }
    for (const write of f.delayed) await write();
    assert.equal(f.records.has('s1'), false);
    assert.equal(f.records.has('keep'), true);
  });
}

test('deletion cleans current and legacy cache; delayed disposal cannot recreate it; new lifecycle can write', async t => {
  const f = await fixture(t);
  f.live.set('s1', { id: 's1', header: f.headers[0] });
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.equal(f.records.has('s1'), false);
  for (const write of f.delayed) await write();
  assert.equal(f.records.has('s1'), false, 'late disposal must not resurrect cache');
  await assert.rejects(fs.access(join(f.home, 'storages/session_projcache/sessions/s1.json')), { code: 'ENOENT' });
  const legacy = JSON.parse(await fs.readFile(f.legacy, 'utf8'));
  assert.equal(Object.hasOwn(legacy.tables.sessions, 's1'), false);
  assert.equal(legacy.tables.sessions.keep.rows.title, 'keep');
  assert.equal(legacy.tables.unrelated.keep, 1);
  await f.table.put('s1', { identity: { createdAt: 100 }, rows: { title: 'new' } });
  assert.equal(f.records.get('s1').rows.title, 'new');
  await f.table.put('s1', { identity: { createdAt: 1, cwd: '/new-lifecycle' }, rows: { title: 'different identity' } });
  assert.equal(f.records.get('s1').rows.title, 'different identity');
  for (const write of f.delayed) await write();
  assert.equal(f.records.get('s1').rows.title, 'different identity', 'old write must not overwrite the recreated session');
});

test('batch deletion cleans both requested caches and preserves unrelated records', async t => {
  const f = await fixture(t);
  const response = await f.plugin.request('/batch', { action: 'delete', sessionIds: ['s1', 's2'] });
  assert.equal(response.status, 200);
  assert.equal(f.records.has('s1'), false);
  assert.equal(f.records.has('s2'), false);
  assert.equal(f.records.has('keep'), true);
  const legacy = JSON.parse(await fs.readFile(f.legacy, 'utf8'));
  assert.deepEqual(Object.keys(legacy.tables.sessions), ['keep']);
});

test('concurrent deletes serialize legacy updates without losing unrelated entries', async t => {
  const f = await fixture(t);
  const results = await Promise.all(['s1', 's2'].map(sessionId => f.plugin.request('/delete', { sessionId })));
  assert.ok(results.every(r => r.status === 200));
  const legacy = JSON.parse(await fs.readFile(f.legacy, 'utf8'));
  assert.deepEqual(Object.keys(legacy.tables.sessions), ['keep']);
});

test('cache failure is returned as a cleanup warning after successful artifact deletion', async t => {
  const f = await fixture(t);
  f.table.delete = async () => { throw new Error('injected cache failure'); };
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(response.data), /injected cache failure/);
  await assert.rejects(fs.access(f.files.get('s1')), { code: 'ENOENT' });
  assert.equal(f.records.has('keep'), true);
});

test('malformed legacy cache is preserved and reported rather than overwritten', async t => {
  const f = await fixture(t);
  const invalid = '{ broken';
  await fs.writeFile(f.legacy, invalid);
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(response.data), /旧版投影缓存清理失败/);
  assert.equal(await fs.readFile(f.legacy, 'utf8'), invalid);
  assert.equal(f.records.has('s1'), false);
});

test('legacy cache symlink cannot expand deletion outside the storage root', async t => {
  const f = await fixture(t);
  const outside = join(f.home, 'outside.json');
  const content = await fs.readFile(f.legacy);
  await fs.writeFile(outside, content);
  await fs.rm(f.legacy);
  try { await fs.symlink(outside, f.legacy); }
  catch (error) { if (error.code === 'EPERM') { t.skip('file symlink privilege unavailable'); return; } throw error; }
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(response.data), /旧版投影缓存清理失败/);
  assert.deepEqual(await fs.readFile(outside), content);
});

test('a linked current cache directory is rejected before calling the host delete method', async t => {
  const f = await fixture(t);
  const root = join(f.home, 'storages', 'session_projcache');
  const outside = join(f.home, 'outside-cache');
  await fs.rename(root, outside);
  await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  let deleted = false;
  f.table.delete = async () => { deleted = true; };
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(response.data), /投影缓存清理失败/);
  assert.equal(deleted, false);
  await fs.access(join(outside, 'sessions', 's1.json'));
});

test('a rejected main deletion releases its cache write guard', async t => {
  const f = await fixture(t);
  f.ctx.agents.get = () => ({ cancel() { throw new Error('injected cancellation failure'); } });
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 500);
  await fs.access(f.files.get('s1'));
  await f.table.put('s1', { identity: { createdAt: 1 }, rows: { title: 'still alive' } });
  assert.equal(f.records.get('s1').rows.title, 'still alive');
});

test('cascaded subagent deletion also cleans each descendant cache', async t => {
  const f = await fixture(t);
  const child = { id: 'child', createdAt: 10, cwd: '/workspace', version: 4, origin: 'subagent', parentSession: 's1' };
  f.headers.push(child);
  const path = join(f.home, 'sessions/project/child/session.v4.jsonl');
  f.files.set('child', path);
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(child) + '\n');
  await f.table.put('child', { identity: { createdAt: 10 }, rows: { title: 'child title' } });
  const legacy = JSON.parse(await fs.readFile(f.legacy, 'utf8'));
  legacy.tables.sessions.child = f.records.get('child');
  await fs.writeFile(f.legacy, JSON.stringify(legacy));
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.equal(f.records.has('s1'), false);
  assert.equal(f.records.has('child'), false);
  assert.equal(f.records.has('keep'), true);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(f.legacy, 'utf8')).tables.sessions, 'child'), false);
});

test('an unrecognized storage layout leaves the legacy file unchanged and reports it', async t => {
  const f = await fixture(t);
  delete f.table.host;
  const before = await fs.readFile(f.legacy);
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 200);
  assert.match(JSON.stringify(response.data), /无法确认旧版缓存已停止写入/);
  assert.deepEqual(await fs.readFile(f.legacy), before);
});

for (const parts of [['storages'], ['storages', 'session_projcache'], ['storages', 'session_projcache', 'sessions']]) {
  test(`issue #56: linked home still rejects internal ${parts.join('/')} junction`, async t => {
    const f = await fixture(t, { linkedHome: true });
    const internal = join(f.home, ...parts);
    const target = join(f.home, 'outside-cache');
    await fs.rename(internal, target);
    await fs.symlink(target, internal, process.platform === 'win32' ? 'junction' : 'dir');
    const targetRecord = join(target, ...['storages', 'session_projcache', 'sessions'].slice(parts.length), 's1.json');
    const before = await fs.readFile(targetRecord);
    await assert.rejects(assertProjectionCachePath(f.servedHome, 's1'), /投影缓存路径不是安全/);
    if (parts.length === 1) {
      const legacy = join(target, 'session_projcache.json');
      const legacyBefore = await fs.readFile(legacy);
      await assert.rejects(removeLegacyProjectionCache(f.servedHome, 's1'), /投影缓存路径不是安全/);
      assert.deepEqual(await fs.readFile(legacy), legacyBefore);
    }
    let called = false;
    f.table.delete = async () => { called = true; };
    const response = await f.plugin.request('/delete', { sessionId: 's1' });
    assert.equal(response.status, 200);
    assert.match(JSON.stringify(response.data), /投影缓存清理失败/);
    assert.equal(called, false);
    assert.deepEqual(await fs.readFile(targetRecord), before);
  });
}

test('issue #56: absent home and absent storage remain harmless no-ops', async t => {
  const f = await fixture(t, { linkedHome: true });
  const absent = join(f.home, 'absent-home');
  await assertProjectionCachePath(absent, 's1');
  await removeLegacyProjectionCache(absent, 's1');
  await assert.rejects(fs.access(absent), { code: 'ENOENT' });
  await fs.rename(join(f.home, 'storages'), join(f.home, 'saved-storages'));
  await assertProjectionCachePath(f.servedHome, 's1');
  await removeLegacyProjectionCache(f.servedHome, 's1');
  await assert.rejects(fs.access(join(f.home, 'storages')), { code: 'ENOENT' });
});

test('rc.3 imported cold sessions without origin or preset can be previewed and deleted', async t => {
  const f = await fixture(t);
  const header = f.headers[0];
  delete header.origin;
  header.isSeeded = false;
  const events = [
    { seq: 0, time: header.createdAt, type: 'turn/start', data: {} },
    { seq: 1, time: header.createdAt, type: 'user/message', data: { content: 'imported question' } },
    { seq: 2, time: header.createdAt, type: 'assistant/message', data: { source: 'deepseek-chat-export', content: 'imported answer' } },
    { seq: 3, time: header.createdAt, type: 'turn/end', data: { kind: 'completed' } }
  ];
  await fs.writeFile(f.files.get('s1'), [header, ...events].map(value => JSON.stringify(value)).join('\n') + '\n');
  const preview = await f.plugin.request('/delete-preview?sessionId=s1', undefined, 'GET');
  assert.equal(preview.status, 200);
  assert.equal(preview.data.result.subagentCount, 0);
  const result = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(result.status, 200);
  assert.equal(result.data.result.wasLive, false);
  assert.equal(result.data.result.warnings, undefined);
  assert.equal(f.records.has('s1'), false);
  assert.equal(f.records.has('keep'), true);
});

test('deletion refuses failed writer retirement without removing its artifact', async t => {
  const f = await fixture(t);
  const writer = { id: 's1', access: 'write', close: async () => { throw new Error('writer drain failed'); } };
  f.ctx.get('sessionPersistence').tracker = { writers: new Map([['s1', writer]]) };
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 500);
  assert.match(JSON.stringify(response.data), /writer drain failed/);
  await fs.access(f.files.get('s1'));
  assert.equal(f.records.has('s1'), true);
});

test('deletion refuses failed session flush without detaching or removing files', async t => {
  const f = await fixture(t);
  f.live.set('s1', { id: 's1', header: f.headers[0] });
  f.ctx.sessions.flush = async () => { throw new Error('flush failed'); };
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 500);
  assert.equal(f.live.has('s1'), true);
  await fs.access(f.files.get('s1'));
});

test('deletion awaits an already closing write handle and leaves read handles alone', async t => {
  const f = await fixture(t);
  let release;
  let entered;
  const closing = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let readClosed = false;
  const writer = { id: 's1', access: 'write', close() { entered(); return closing; } };
  f.ctx.get('sessionPersistence').tracker = { writers: new Map(), openHandles: new Set([writer, { id: 's1', access: 'read', close() { readClosed = true; } }]) };
  const pending = f.plugin.request('/delete', { sessionId: 's1' });
  let timer;
  try {
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('writer was not awaited')), 2000); })]);
    await fs.access(f.files.get('s1'));
  } finally { clearTimeout(timer); release(); }
  assert.equal((await pending).status, 200);
  assert.equal(readClosed, false);
  await assert.rejects(fs.access(f.files.get('s1')), { code: 'ENOENT' });
});

test('writer close failure during Agent teardown is retained for deletion admission', async t => {
  const f = await fixture(t);
  const persistence = f.ctx.get('sessionPersistence');
  const writer = { id: 's1', access: 'write', close: () => Promise.reject(new Error('early retirement failed')) };
  persistence.tracker = { writers: new Map([['s1', writer]]) };
  f.ctx.agents.get = () => ({ status: 'running', cancel() {}, scope: { async dispose() { persistence.tracker.writers.delete('s1'); } } });
  // The fake Agent is reported stopped after the first observation.
  let checks = 0;
  const agent = f.ctx.agents.get();
  f.ctx.agents.get = () => ++checks === 1 ? agent : undefined;
  const response = await f.plugin.request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 500);
  assert.match(JSON.stringify(response.data), /early retirement failed/);
  await fs.access(f.files.get('s1'));
});

test('failed disposal notification prevents physical deletion', async t => {
  const f = await fixture(t);
  f.ctx.emit = () => { throw new Error('disposal notification failed'); };
  const response = await mountPlugin(f.ctx).request('/delete', { sessionId: 's1' });
  assert.equal(response.status, 500);
  assert.match(JSON.stringify(response.data), /disposal notification failed/);
  await fs.access(f.files.get('s1'));
});
