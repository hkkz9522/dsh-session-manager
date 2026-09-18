import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { encodeSessionSegment, readSessionFile } from "../lib/session-files.js";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

const frame = text => zstdCompressSync(Buffer.from(text));
async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-api-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(home));
    assert.ok(rel.startsWith("dsh-api-test-") && !rel.includes(sep));
    await fs.rm(home, { recursive: true, force: true });
  });
  const source = join(home, "source");
  const target = join(home, "target");
  await fs.mkdir(source); await fs.mkdir(target); await fs.mkdir(join(home, "sessions"));
  let state = { archivedSessionIds: ["s1"], workspaces: [{ id: "source", sessionIds: ["s1"] }, { id: "target", sessionIds: [] }] };
  let writes = 0;
  const entities = ["source", "target"].map(id => ({
    id, title: id, path: id === "source" ? source : target,
    get record() { return state.workspaces.find(w => w.id === id); },
    get sessionIds() { return this.record.sessionIds; },
    async attachSession(sessionId) { if (!this.sessionIds.includes(sessionId)) this.record.sessionIds.push(sessionId); },
    async detachSession(sessionId) { this.record.sessionIds = this.sessionIds.filter(id => id !== sessionId); },
  }));
  const registry = {
    list: () => entities,
    requireState: () => state,
    setState: async next => { state = next; writes++; },
    enqueueOperation: async operation => operation(),
    headers: new Map(), sessionPaths: new Map(), invalidSessionPaths: new Map(),
  };
  const live = new Map();
  const emitted = [];
  const warnings = [];
  const persistence = { list: async () => [], locate: header => ({ path: artifactPath(header) }) };
  const services = {
    workspaceRegistry: registry, sessionPersistence: persistence, dshHomePath: segment => join(home, segment),
    agentPresets: { list: async () => [{ id: "new" }, { id: "newer" }] },
    sessionProjectionCache: { coldSnapshot: async () => {} },
  };
  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: id => live.get(id), flush: async () => {} },
    agents: { get: () => undefined },
    get: name => services[name], emit: (...args) => emitted.push(args),
    logger: { info() {}, warn: message => warnings.push(message) },
  };
  function artifactPath(header, filename = "session.v3.jsonl.zstd") {
    return join(home, "sessions", encodeSessionSegment(header.cwd), encodeSessionSegment(header.id), filename);
  }
  async function stage({ id = "s1", filename = "session.v3.jsonl.zstd", events = [{ type: "user/message", seq: 0, data: { content: "keep history" } }], header: overrides = {}, bytes } = {}) {
    const header = { id, cwd: source, version: 3, agentPreset: "old", origin: "user", ...overrides };
    const path = artifactPath({ ...header, id }, filename);
    const lines = events.map(event => JSON.stringify(event) + "\n");
    const content = JSON.stringify(header) + "\n" + lines.join("");
    const payload = bytes ?? (filename.endsWith(".zstd") ? Buffer.concat([frame(JSON.stringify(header) + "\n"), ...lines.map(frame)]) : Buffer.from(content));
    await fs.mkdir(dirname(path), { recursive: true }); await fs.writeFile(path, payload);
    return { header, path, bytes: payload, content };
  }
  return { home, source, target, stage, artifactPath, registry, persistence, services, ctx, live, warnings, emitted,
    get state() { return state; }, get writes() { return writes; }, mount: () => mountPlugin(ctx) };
}

test("DELETE rejects traversal before cancelling, registry changes or filesystem deletion", async t => {
  const f = await fixture(t); const staged = await f.stage();
  const plugin = f.mount();
  for (const sessionId of ["..", ".", "../outside", "..\\outside"]) {
    const response = await plugin.request("/delete", { sessionId });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(await fs.readFile(staged.path), staged.bytes);
  assert.deepEqual(f.state.workspaces[0].sessionIds, ["s1"]);
  assert.equal(f.emitted.length, 0);
});

test("DELETE validates header id before any side effects", async t => {
  const f = await fixture(t); const staged = await f.stage({ header: { id: "different-id" } });
  const response = await f.mount().request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 500);
  assert.deepEqual(await fs.readFile(staged.path), staged.bytes);
  assert.deepEqual(f.state.workspaces[0].sessionIds, ["s1"]);
  assert.equal(f.emitted.length, 0);
});

test("DELETE rejects a junction/symlink session directory without touching its target", async t => {
  const f = await fixture(t);
  const outside = join(f.home, "outside");
  await fs.mkdir(outside); await fs.writeFile(join(outside, "sentinel"), "keep");
  const dir = dirname(f.artifactPath({ id: "s1", cwd: f.source }));
  await fs.mkdir(dirname(dir), { recursive: true });
  await fs.symlink(outside, dir, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.mount().request("/delete", { sessionId: "s1" })).status, 500);
  assert.equal(await fs.readFile(join(outside, "sentinel"), "utf8"), "keep");
  assert.equal(f.emitted.length, 0);
});

test("DELETE removes only the verified session and remains idempotent", async t => {
  const f = await fixture(t); const one = await f.stage(); const two = await f.stage({ id: "s2" });
  const plugin = f.mount();
  assert.equal((await plugin.request("/delete", { sessionId: "s1" })).status, 200);
  await assert.rejects(fs.stat(dirname(one.path)), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(two.path), two.bytes);
  assert.deepEqual(f.state.workspaces[0].sessionIds, []);
  assert.deepEqual(f.state.archivedSessionIds, []);
  assert.equal((await plugin.request("/delete", { sessionId: "s1" })).data.result.filesRemoved, false);
});

for (const filename of ["session.jsonl", "session.v2.jsonl.zstd", "session.v3.jsonl.zstd"]) {
  test("cold preset migration preserves history: " + filename, async t => {
    const f = await fixture(t);
    const events = [
      { type: "agent-preset/selected", seq: 0, data: { agentPreset: "old" } },
      { type: "user/message", seq: 1, data: { content: "keep history" } },
    ];
    const staged = await f.stage({ filename, events });
    const response = await f.mount().request("/preset-migrate", { sessionId: "s1", toPreset: "new" });
    assert.equal(response.status, 200, response.data.error);
    const stored = await readSessionFile(staged.path);
    assert.deepEqual(stored.meta, staged.header);
    const persistedEvents = stored.content.trim().split("\n").slice(1).map(JSON.parse);
    assert.deepEqual(persistedEvents, [{ ...events[0], data: { agentPreset: "new" } }, events[1]]);
    assert.equal((await fs.readdir(dirname(staged.path))).length, 1);
  });
}

test("a partial readRaw result is never used as the rewrite's durable content", async t => {
  const f = await fixture(t); const staged = await f.stage();
  f.persistence.readRaw = async () => ({ meta: staged.header, content: JSON.stringify(staged.header) + "\n" });
  const response = await f.mount().request("/preset-migrate", { sessionId: "s1", toPreset: "new" });
  assert.equal(response.status, 200, response.data.error);
  const result = await readSessionFile(staged.path);
  assert.equal(result.meta.agentPreset, "new");
  assert.ok(result.content.includes("keep history"));
});

for (const damage of ["corrupt middle frame", "torn tail"]) {
  for (const operation of ["/preset-migrate", "/move"]) {
    test(operation + " refuses " + damage + " without changing disk or registry", async t => {
      const f = await fixture(t); const staged = await f.stage();
      let bytes;
      if (damage === "torn tail") bytes = Buffer.concat([staged.bytes, Buffer.from([0x28, 0xb5])]);
      else {
        const broken = frame('{"type":"damaged"}\n'); broken[4] |= 8;
        bytes = Buffer.concat([frame(JSON.stringify(staged.header) + "\n"), broken, frame('{"type":"valid-later"}\n')]);
      }
      await fs.writeFile(staged.path, bytes);
      const response = await f.mount().request(operation, { sessionId: "s1", toPreset: "new", targetWorkspaceId: "target" });
      assert.equal(response.status, 500);
      assert.deepEqual(await fs.readFile(staged.path), bytes);
      assert.deepEqual(f.state.workspaces[0].sessionIds, ["s1"]);
      assert.equal(f.emitted.length, 0);
    });
  }
}

test("cold move retains history/archive state and changes workspace", async t => {
  const f = await fixture(t); const staged = await f.stage();
  f.persistence.list = async () => [{ header: staged.header, revision: "snapshot" }];
  const response = await f.mount().request("/move", { sessionId: "s1", targetWorkspaceId: "target" });
  assert.equal(response.status, 200, response.data.error);
  const result = await readSessionFile(f.artifactPath({ id: "s1", cwd: f.target }));
  assert.equal(result.meta.cwd, f.target);
  assert.ok(result.content.includes("keep history"));
  assert.deepEqual(f.state.archivedSessionIds, ["s1"]);
  assert.deepEqual(f.state.workspaces.map(ws => ws.sessionIds), [[], ["s1"]]);
  await assert.rejects(fs.stat(staged.path), { code: "ENOENT" });
});

test("boot skips reconciliation when persistence listing fails, even if disk enumeration succeeds", async t => {
  const f = await fixture(t);
  f.persistence.list = async () => { throw new Error("temporary failure"); };
  await f.mount().boot();
  assert.deepEqual(f.state.workspaces[0].sessionIds, ["s1"]);
  assert.equal(f.writes, 0);
  assert.ok(f.warnings.some(s => s.includes("reconciliation skipped")));
});

test("boot skips reconciliation if the session root is unreadable or unavailable", async t => {
  const f = await fixture(t);
  f.services.dshHomePath = segment => join(f.home, "missing-root", segment);
  await f.mount().boot();
  assert.deepEqual(f.state.workspaces[0].sessionIds, ["s1"]);
  assert.equal(f.writes, 0);
});

test("boot keeps valid snapshot headers without cwd and blank live sessions", async t => {
  const f = await fixture(t);
  f.persistence.list = async () => [{ header: { id: "s1", version: 3 } }];
  f.state.workspaces[0].sessionIds.push("blank"); f.live.set("blank", { id: "blank" });
  await f.mount().boot();
  assert.deepEqual(f.state.workspaces[0].sessionIds, ["s1", "blank"]);
  assert.equal(f.writes, 0);
});

test("boot does not overwrite workspace membership added during an async scan", async t => {
  const f = await fixture(t);
  f.persistence.list = async () => { f.state.workspaces[0].sessionIds.push("new-during-scan"); return []; };
  await f.mount().boot();
  assert.deepEqual(f.state.workspaces[0].sessionIds, ["new-during-scan"]);
});

test("failed reconciliation commit does not mutate the original registry object", async t => {
  const f = await fixture(t); const original = structuredClone(f.state);
  f.registry.setState = async () => { throw new Error("write failure"); };
  await f.mount().boot();
  assert.deepEqual(f.state, original);
});

test("boot attaches disk-only sessions using normalized headers", async t => {
  const f = await fixture(t); const staged = await f.stage({ id: "s2" });
  f.persistence.list = async () => [{ header: staged.header }];
  await f.mount().boot();
  assert.deepEqual(f.state.workspaces[0].sessionIds, ["s2"]);
});

test("API rejects non-object JSON and oversized request bodies", async t => {
  const plugin = (await fixture(t)).mount();
  for (const raw of ["null", "[]", "123", "{"]) {
    assert.equal((await plugin.request("/delete", undefined, "POST", raw)).status, 400);
  }
  assert.equal((await plugin.request("/delete", undefined, "POST", " ".repeat(65537))).status, 413);
});

test("DELETE cleans up a blank live session materialized during flush", async t => {
  const f = await fixture(t);
  f.live.set("s1", { id: "s1" });
  let path;
  f.ctx.sessions.flush = async () => { path = (await f.stage()).path; };
  const response = await f.mount().request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.filesRemoved, true);
  await assert.rejects(fs.stat(path), { code: "ENOENT" });
});

test("indexed reads do not call readRaw or decompress history twice", async t => {
  const f = await fixture(t); const staged = await f.stage();
  let rawCalls = 0;
  f.persistence.list = async () => [{ header: staged.header }];
  f.persistence.readRaw = async () => { rawCalls++; throw new Error("must not read twice"); };
  const response = await f.mount().request("/preset-migrate", { sessionId: "s1", toPreset: "new" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(rawCalls, 0);
});

test("move refuses an existing destination artifact without overwriting either copy", async t => {
  const f = await fixture(t); const original = await f.stage();
  const destination = await f.stage({ header: { cwd: f.target } });
  f.persistence.list = async () => [original.header];
  const response = await f.mount().request("/move", { sessionId: "s1", targetWorkspaceId: "target" });
  assert.equal(response.status, 500);
  assert.deepEqual(await fs.readFile(original.path), original.bytes);
  assert.deepEqual(await fs.readFile(destination.path), destination.bytes);
});

test("same-session mutations are serialized; failed operations do not poison the queue", async t => {
  const f = await fixture(t); const staged = await f.stage();
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  f.services.agentPresets.list = async () => {
    calls++;
    if (calls === 1) { entered(); await blocked; throw new Error("first operation failed"); }
    return [{ id: "newer" }];
  };
  const plugin = f.mount();
  const first = plugin.request("/preset-migrate", { sessionId: "s1", toPreset: "new" });
  await started;
  const second = plugin.request("/preset-migrate", { sessionId: "s1", toPreset: "newer" });
  await new Promise(resolve => setImmediate(resolve));
  const concurrentCalls = calls;
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(concurrentCalls, 1);
  assert.equal(a.status, 500);
  assert.equal(b.status, 200, b.data.error);
  assert.equal((await readSessionFile(staged.path)).meta.agentPreset, "newer");
});

test("boot does not reattach a session moved to another workspace during cache refresh", async t => {
  const f = await fixture(t); const staged = await f.stage();
  f.persistence.list = async () => [{ header: staged.header }];
  f.services.sessionProjectionCache.coldSnapshot = async () => {
    f.state.workspaces[0].sessionIds = [];
    f.state.workspaces[1].sessionIds = ["s1"];
  };
  await f.mount().boot();
  assert.deepEqual(f.state.workspaces.map(ws => ws.sessionIds), [[], ["s1"]]);
});

test("workspace API exposes only cached creation times, without reading persistence", async t => {
  const f = await fixture(t);
  f.registry.headers.set("s1", { id: "s1", cwd: f.source, createdAt: 100, secret: "not exported" });
  f.registry.headers.set("s2", { header: { id: "s2", createdAt: "2026-01-01T00:00:00Z" } });
  f.registry.headers.set("invalid", null);
  f.ctx.sessions.list = () => [{ header: { id: "blank", createdAt: 200 } }];
  f.persistence.list = async () => { throw new Error("metadata endpoint must never scan disk"); };
  const response = await f.mount().request("/workspaces", undefined, "GET");
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.result.sessionCreatedAt, { s1: 100, s2: "2026-01-01T00:00:00Z", blank: 200 });
  assert.equal(response.data.result.workspaces.length, 2);
  assert.ok(!JSON.stringify(response.data).includes("not exported"));
});

test("workspace metadata remains usable if an older runtime has no cached headers or session listing", async t => {
  const f = await fixture(t);
  delete f.registry.headers;
  const response = await f.mount().request("/workspaces", undefined, "GET");
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.result.sessionCreatedAt, {});
  assert.equal(response.data.result.workspaces.length, 2);
});

test("annotations API validates priority and unknown sessions, without reading/writing session history", async t => {
  const f = await fixture(t); const staged = await f.stage(); const plugin = f.mount();
  let response = await plugin.request("/annotations", { sessionId: "s1", patch: { favorite: true, reviewLater: true, priority: 1, tags: ["Fix"], note: "review later" }, expectedRevision: 0 });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.annotation.revision, 1);
  response = await plugin.request("/annotations", undefined, "GET");
  assert.equal(response.data.result.annotations.s1.note, "review later");
  assert.deepEqual(await fs.readFile(staged.path), staged.bytes);
  assert.deepEqual(f.state.archivedSessionIds, ["s1"]);
  assert.equal((await plugin.request("/annotations", { sessionId: "s1", patch: { priority: 6 } })).status, 400);
  assert.equal((await plugin.request("/annotations", { sessionId: "unknown", patch: { favorite: true } })).status, 404);
  assert.equal((await plugin.request("/annotations", { sessionId: "..", patch: { favorite: true } })).status, 400);
  assert.equal((await plugin.request("/annotations", { sessionId: "s1", patch: { note: "stale" }, expectedRevision: 0 })).status, 409);
});

test("moving and migrating preserve annotations by ID; successful deletion removes annotations", async t => {
  const f = await fixture(t); await f.stage(); const plugin = f.mount();
  assert.equal((await plugin.request("/annotations", { sessionId: "s1", patch: { note: "keep across workspaces", favorite: true } })).status, 200);
  assert.equal((await plugin.request("/move", { sessionId: "s1", targetWorkspaceId: "target" })).status, 200);
  assert.equal((await plugin.request("/preset-migrate", { sessionId: "s1", toPreset: "new" })).status, 200);
  let response = await plugin.request("/annotations", undefined, "GET");
  assert.equal(response.data.result.annotations.s1.note, "keep across workspaces");
  assert.equal((await plugin.request("/delete", { sessionId: "s1" })).status, 200);
  response = await plugin.request("/annotations", undefined, "GET");
  assert.ok(!Object.hasOwn(response.data.result.annotations, "s1"));
});
