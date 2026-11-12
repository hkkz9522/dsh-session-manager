import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mountPlugin } from './helpers/plugin-harness.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), 'dsh-projcache-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
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
  const services = { sessionProjectionCache: cache, dshHomePath: (...parts) => join(home, ...parts), sessionPersistence: { list: async () => headers, locate: h => ({ path: files.get(h.id) }) } };
  const ctx = {
    get: name => services[name], workspaceRegistry: registry,
    sessions: { get: id => live.get(id), flush: async () => {}, store: { get: id => live.has(id) ? { detach() { const session = live.get(id); live.delete(id); ctx.emit('session/disposed', session); } } : undefined } },
    agents: { get: () => undefined }, waterfall: async (name, payload, fallback) => fallback(),
    emit(name, session) { if (name === 'session/disposed' && session.header) delayed.push(() => table.put(session.id, { identity: { createdAt: session.header.createdAt }, rows: { title: 'late' } })); },
    logger: { info() {}, warn: message => warnings.push(message) },
  };
  return { home, headers, files, records, table, legacy, live, delayed, warnings, cache, ctx, plugin: mountPlugin(ctx) };
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
