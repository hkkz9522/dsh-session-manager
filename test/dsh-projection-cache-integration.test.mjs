import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mountPlugin } from './helpers/plugin-harness.mjs';

// Optional integration with exact upstream packages installed outside this repo.
// DSH_MODULE_ROOT=<node_modules> DSH_TEST_VERSION=<exact version> node --test <this file>
const moduleRoot = process.env.DSH_MODULE_ROOT ?? process.env.DSH_RC1_MODULE_ROOT;
const version = process.env.DSH_TEST_VERSION ?? '0.2.2-rc.1';
test(`${version} real cache/storage: deletion wins over an already pending write, disposal, and restart`, {
  skip: !moduleRoot
}, async t => {
  const load = async name => {
    const root = join(moduleRoot, '@deepseek-ai', name);
    const manifest = JSON.parse(await fs.readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.version, version);
    return import(pathToFileURL(join(root, 'lib/index.js')).href);
  };
  const { JsonStorageBackend } = await load('dsh-storage-json');
  const { DomainFacility } = await load('dsh-storage-domain');
  const { SessionProjectionCache, projectionCacheDomainSpec } = await load('dsh-session-projection-cache');
  const home = await fs.mkdtemp(join(tmpdir(), 'dsh-real-cache-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = join(home, 'storages');
  await fs.mkdir(root);
  const record = { identity: { createdAt: 1 }, rows: { title: { ver: 1, seq: 0, val: 'old title' } } };
  const legacyPath = join(root, 'session_projcache.json');
  await fs.writeFile(legacyPath, JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, tables: { sessions: { s1: record, keep: record } } }));
  let backend = new JsonStorageBackend(root);
  const domainCtx = { storage: { backend: { get: () => backend } }, emit() {}, logger: { warn() {}, error(message) { throw new Error(message); } } };
  let facility = new DomainFacility(domainCtx, { backend: 'json' });
  const domain = await facility.open(projectionCacheDomainSpec);
  const header = { id: 's1', version: 4, createdAt: 1, cwd: '/work', isSeeded: false, origin: 'user' };
  const session = { id: 's1', header, inheritedEventCount: 0 };
  let live = session;
  let release;
  const pausedFlush = new Promise(resolve => { release = resolve; });
  const cache = Object.assign(Object.create(SessionProjectionCache.prototype), {
    table: domain.table('sessions'), dirty: new Map(),
    ctx: { sessionProjections: { checkpoint: () => record.rows }, sessions: { get: () => live, flush: () => pausedFlush }, logger: { warn() {} } }
  });
  const pendingWrite = cache.write(session); // already suspended before plugin installs its guard
  const path = join(home, 'sessions', 'project', 's1', 'session.v4.jsonl');
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(header) + '\n');
  const services = { dshHomePath: (...parts) => join(home, ...parts), sessionProjectionCache: cache, sessionPersistence: { list: async () => live ? [header] : [], locate: () => ({ path }) } };
  let disposal;
  const plugin = mountPlugin({
    get: key => services[key], agents: { get: () => undefined },
    workspaceRegistry: { list: () => [], requireState: () => ({ workspaces: [], archivedSessionIds: [] }), setState: async () => {}, enqueueOperation: async fn => fn() },
    sessions: { get: () => live, flush: async () => {}, store: { get: () => ({ detach() { live = undefined; disposal = cache.flushSoft(session, 'detach'); } }) } },
    waterfall: async (name, payload, fallback) => fallback(), emit() {}, logger: { info() {}, warn() {} }
  });
  try {
    const result = await plugin.request('/delete', { sessionId: 's1' });
    assert.equal(result.status, 200);
    assert.equal(cache.table.get('s1'), undefined);
    release();
    await pendingWrite;
    await disposal;
    assert.equal(cache.table.get('s1'), undefined);
    assert.ok(cache.table.get('keep'));
    await assert.rejects(fs.access(join(root, 'session_projcache/sessions/s1.json')), { code: 'ENOENT' });
    assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(legacyPath, 'utf8')).tables.sessions, 's1'), false);
    await facility.closeAll();
    await backend.close();
    backend = new JsonStorageBackend(root);
    facility = new DomainFacility(domainCtx, { backend: 'json' });
    const reopened = await facility.open(projectionCacheDomainSpec);
    assert.equal(reopened.table('sessions').get('s1'), undefined);
    assert.ok(reopened.table('sessions').get('keep'));
  } finally {
    release();
    await pendingWrite;
    await facility.closeAll();
    await backend.close();
  }
});
