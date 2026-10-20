import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { encodeFsSessionSegment, encodeProjectSegment, readSessionFile } from "../lib/session-files.js";
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
    waterfall: async (name, payload, fallback) => typeof fallback === "function" ? fallback() : [],
    get: name => services[name], emit: (...args) => emitted.push(args),
    logger: { info() {}, warn: message => warnings.push(message) },
  };
  function artifactPath(header, filename = "session.v3.jsonl.zstd") {
    return join(home, "sessions", encodeProjectSegment(header.cwd), encodeFsSessionSegment(header.id), filename);
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

test("failed reconciliation write does not mutate the original registry object", async t => {
  // DSH 0.2.x durability lives inside the entity API: a failed durable write
  // must reject without swapping the in-memory record. Simulate the official
  // behavior (table.update rejects, snapshot untouched) and assert the
  // registry object stays exactly as it was.
  const f = await fixture(t); const original = structuredClone(f.state);
  const source = f.registry.list().find(ws => ws.id === "source");
  source.detachSession = async () => { throw new Error("write failure"); };
  await f.mount().boot();
  assert.deepEqual(f.state, original);
  assert.ok(f.warnings.some(s => s.includes("post-boot reconcile failed")), "the failure must be reported");
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

test("cold move adapts to 3-arg coldSnapshot signature (issue #25)", async t => {
  const f = await fixture(t); const staged = await f.stage();
  f.persistence.list = async () => [{ header: staged.header, revision: "snapshot" }];
  const calls = [];
  f.services.sessionProjectionCache.coldSnapshot = async (meta, inheritedEventCount, events) => {
    calls.push({ meta, inheritedEventCount, events });
  };
  const response = await f.mount().request("/move", { sessionId: "s1", targetWorkspaceId: "target" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.id, "s1");
  assert.equal(calls[0].meta.cwd, f.target);
  assert.equal(calls[0].inheritedEventCount, 0);
  assert.ok(Array.isArray(calls[0].events));
});

test("cold move resolves inheritedEventCount from SessionHandle when session is seeded (issue #25)", async t => {
  const f = await fixture(t);
  // Realistic DSH SessionHeader does NOT contain inheritedEventCount:
  const staged = await f.stage({ header: { isSeeded: true, parentSession: "p1" } });
  f.persistence.list = async () => [{ header: staged.header, revision: "snapshot" }];
  // SessionHandle exposes inheritedEventCount via persistence.open:
  f.persistence.open = async (sessionId) => ({ inheritedEventCount: 12, close: async () => {} });
  const calls = [];
  f.services.sessionProjectionCache.coldSnapshot = async (meta, inheritedEventCount, events) => {
    calls.push({ meta, inheritedEventCount, events });
  };
  const response = await f.mount().request("/move", { sessionId: "s1", targetWorkspaceId: "target" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].meta.id, "s1");
  assert.equal(calls[0].meta.cwd, f.target);
  assert.equal(calls[0].inheritedEventCount, 12, "must resolve inheritedEventCount from SessionHandle");
  assert.ok(Array.isArray(calls[0].events));
});

test("cold move resolves inheritedEventCount from event log session/end-seed marker (issue #25)", async t => {
  const f = await fixture(t);
  // Realistic DSH fork events: prefix followed by session/end-seed marker event
  const events = [
    { type: "user/message", seq: 0, data: { content: "hello" } },
    { type: "agent/message", seq: 1, data: { content: "world" } },
    { type: "session/end-seed", seq: 2, data: { inherited: true } },
    { type: "user/message", seq: 3, data: { content: "new question" } }
  ];
  const staged = await f.stage({
    header: { isSeeded: true, parentSession: "p1" },
    events
  });
  f.persistence.list = async () => [{ header: staged.header, revision: "snapshot" }];
  const calls = [];
  f.services.sessionProjectionCache.coldSnapshot = async (meta, inheritedEventCount, events) => {
    calls.push({ meta, inheritedEventCount, events });
  };
  const response = await f.mount().request("/move", { sessionId: "s1", targetWorkspaceId: "target" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inheritedEventCount, 2, "must resolve inheritedEventCount from session/end-seed marker index");
});

test("boot effect refolds missing projection cache using inheritedEventCount from session/end-seed marker (issue #25)", async t => {
  const f = await fixture(t);
  const events = [
    { type: "user/message", seq: 0, data: { content: "q" } },
    { type: "session/end-seed", seq: 1, data: { inherited: true } },
    { type: "agent/message", seq: 2, data: { content: "a" } }
  ];
  const staged = await f.stage({
    header: { isSeeded: true, parentSession: "p1" },
    events
  });
  f.persistence.list = async () => [{ header: staged.header }];
  const calls = [];
  f.services.sessionProjectionCache.cachedSnapshot = () => undefined;
  f.services.sessionProjectionCache.coldSnapshot = async (meta, inheritedEventCount, events) => {
    if (inheritedEventCount === undefined || typeof inheritedEventCount !== "number" || inheritedEventCount < 0) {
      throw new TypeError("SessionLogOffset must be a non-negative safe integer");
    }
    calls.push({ meta, inheritedEventCount, events });
  };
  await f.mount().boot();
  assert.equal(calls.length, 1, "missing cache should trigger coldSnapshot reconstruction");
  assert.equal(calls[0].meta.id, "s1");
  assert.equal(calls[0].inheritedEventCount, 1, "must resolve inheritedEventCount for seeded session on boot");
  assert.equal(f.warnings.filter(w => w.includes("post-boot cache refold failed")).length, 0);
});

test("boot effect skips projection cache refold when cachedSnapshot matches (issue #25)", async t => {
  const f = await fixture(t); const staged = await f.stage();
  f.persistence.list = async () => [{ header: staged.header }];
  let coldCalled = false;
  f.services.sessionProjectionCache.cachedSnapshot = (header) => ({ values: { title: "cached" } });
  f.services.sessionProjectionCache.coldSnapshot = async () => { coldCalled = true; };
  await f.mount().boot();
  assert.equal(coldCalled, false, "valid cachedSnapshot must skip disk read and coldSnapshot");
  assert.equal(f.warnings.filter(w => w.includes("post-boot cache refold failed")).length, 0);
});

test("archive session defaults to stopActivity: false and fails if session is active (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  f.state.pinnedSessionIds = ["s1"];
  // Set session as active
  f.live.set("s1", { activeTurn: "turn-1" });
  const stopped = [];
  f.registry.stopSessionActivity = async (id) => { stopped.push(id); };
  const plugin = f.mount();
  // Attempt archiving without stopActivity: true
  const response = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"] });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.summary.failed, 1);
  assert.equal(response.data.result.items[0].status, "failed");
  assert.equal(response.data.result.items[0].code, "workspace/session-active");
  assert.deepEqual(f.state.archivedSessionIds, [], "active session must not be archived when stopActivity is false");
  assert.deepEqual(stopped, [], "agent must NOT be stopped when stopActivity is false");
});

test("archive session with explicit stopActivity: true stops active session after archiving in fallback (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  f.state.pinnedSessionIds = ["s1"];
  f.live.set("s1", { activeTurn: "turn-1" });
  const events = [];
  f.registry.setState = async (next) => {
    events.push("setState");
    f.state.archivedSessionIds = next.archivedSessionIds;
    f.state.pinnedSessionIds = next.pinnedSessionIds;
  };
  f.registry.stopSessionActivity = async (id) => {
    events.push("stopSessionActivity:" + id);
  };
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"], payload: { stopActivity: true } });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.summary.success, 1);
  assert.deepEqual(f.state.archivedSessionIds, ["s1"]);
  assert.deepEqual(events, ["setState", "stopSessionActivity:s1"], "must update state before stopping activity (matching DSH official order)");
});

test("archive and unarchive propagate official API rejection and never bypass via direct write (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  f.registry.archiveSession = async () => {
    const error = new Error("active session cannot be archived");
    error.code = "workspace/session-active";
    throw error;
  };
  f.registry.unarchiveSession = async () => {
    const error = new Error("unarchive rejected by official policy");
    error.code = "workspace/rejected";
    throw error;
  };
  const plugin = f.mount();
  const archiveRes = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"] });
  assert.equal(archiveRes.status, 200);
  assert.equal(archiveRes.data.result.summary.failed, 1);
  assert.match(archiveRes.data.result.items[0].error, /active session cannot be archived/);
  assert.deepEqual(f.state.archivedSessionIds, [], "must not bypass official rejection to write archive state");

  const unarchiveRes = await plugin.request("/unarchive", { sessionId: "s1" });
  assert.equal(unarchiveRes.status, 500);
  assert.match(unarchiveRes.data.error, /unarchive rejected by official policy/);
});

test("cold move resolves inheritedEventCount from LAST session/end-seed marker for nested fork (issue #25)", async t => {
  const f = await fixture(t);
  // Nested fork event stream:
  // - First fork marker at seq 1
  // - Intermediate turns
  // - Second (nested) fork marker at seq 4
  // - Normal non-inherited closer at seq 5
  const events = [
    { type: "user/message", seq: 0, data: { content: "original turn" } },
    { type: "session/end-seed", seq: 1, data: { inherited: true } },
    { type: "user/message", seq: 2, data: { content: "first fork turn" } },
    { type: "agent/message", seq: 3, data: { content: "reply" } },
    { type: "session/end-seed", seq: 4, data: { inherited: true } },
    { type: "session/end-seed", seq: 5, data: {} },
    { type: "user/message", seq: 6, data: { content: "child turn" } }
  ];
  const staged = await f.stage({
    header: { isSeeded: true, parentSession: "nested-parent" },
    events
  });
  f.persistence.list = async () => [{ header: staged.header, revision: "snapshot" }];
  const calls = [];
  f.services.sessionProjectionCache.coldSnapshot = async (meta, inheritedEventCount, events) => {
    calls.push({ meta, inheritedEventCount, events });
  };
  const response = await f.mount().request("/move", { sessionId: "s1", targetWorkspaceId: "target" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inheritedEventCount, 4, "must identify the LAST inherited marker index for nested fork");
});

test("boot and move safely skip cache refold when seeded session inherited boundary cannot be resolved (issue #25)", async t => {
  const f = await fixture(t);
  // Seeded session where events do NOT have any inherited marker and no handle provides count
  const staged = await f.stage({
    header: { isSeeded: true, parentSession: "p1" },
    events: [
      { type: "user/message", seq: 0, data: { content: "missing marker" } }
    ]
  });
  f.persistence.list = async () => [{ header: staged.header, revision: "snapshot" }];
  const coldCalls = [];
  f.services.sessionProjectionCache.cachedSnapshot = () => undefined;
  f.services.sessionProjectionCache.coldSnapshot = async (meta, count, events) => {
    coldCalls.push({ meta, count, events });
  };

  // Boot should skip refold rather than incorrectly passing 0 or undefined
  await f.mount().boot();
  assert.equal(coldCalls.length, 0, "boot must not call coldSnapshot with invalid cut for unresolvable seeded session");
  assert.ok(f.warnings.some(w => w.includes("cannot determine inheritedEventCount")), "must warn about unresolvable seeded session during boot");

  // Move should move session cleanly but skip cache refold rather than passing 0
  const moveRes = await f.mount().request("/move", { sessionId: "s1", targetWorkspaceId: "target" });
  assert.equal(moveRes.status, 200);
  assert.equal(coldCalls.length, 0, "move must skip coldSnapshot when inheritedEventCount cannot be determined");
  assert.ok(f.warnings.some(w => w.includes("skipping post-move cache refresh")), "must warn about skipping post-move cache refresh");
});

test("archive session fails when ctx.waterfall reports ongoing activity (job/subagent/schedule) (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  f.ctx.waterfall = async (name, payload) => {
    if (name === "workspace/session-activity" && payload.sessionId === "s1") {
      return [{ kind: "subagent" }, { kind: "job" }];
    }
    return [];
  };
  const plugin = f.mount();
  const res = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"] });
  assert.equal(res.status, 200);
  assert.equal(res.data.result.summary.failed, 1);
  assert.equal(res.data.result.items[0].status, "failed");
  assert.equal(res.data.result.items[0].code, "workspace/session-active");
  assert.match(res.data.result.items[0].error, /subagent, job/);
  assert.deepEqual(f.state.archivedSessionIds, [], "must not archive when waterfall reports active tasks");
});

test("archive session with stopActivity: true rejects when no valid stop interface is available (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  f.live.set("s1", { activeTurn: "turn-1" });
  // Neither registry.stopSessionActivity nor ctx.parallel available
  f.registry.stopSessionActivity = undefined;
  f.ctx.parallel = undefined;
  const plugin = f.mount();
  const res = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"], payload: { stopActivity: true } });
  assert.equal(res.status, 200);
  assert.equal(res.data.result.summary.failed, 1);
  assert.equal(res.data.result.items[0].code, "stop-activity-unavailable");
  assert.deepEqual(f.state.archivedSessionIds, [], "must safely reject and not write archived state when no stop interface exists");
});

test("archive session with stopActivity: true stops activity via ctx.parallel when stopSessionActivity is absent (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  f.live.set("s1", { activeTurn: "turn-1" });
  f.registry.stopSessionActivity = undefined;
  const parallelCalls = [];
  f.ctx.parallel = async (name, payload) => {
    parallelCalls.push({ name, payload });
  };
  const plugin = f.mount();
  const res = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"], payload: { stopActivity: true } });
  assert.equal(res.status, 200);
  assert.equal(res.data.result.summary.success, 1);
  assert.deepEqual(f.state.archivedSessionIds, ["s1"]);
  assert.deepEqual(parallelCalls, [{ name: "workspace/session-stop", payload: { sessionId: "s1" } }], "must dispatch workspace/session-stop via ctx.parallel");
});

test("archive session fallback rejects when ctx.waterfall is unavailable (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  // ctx.waterfall missing (unable to verify job/subagent/schedule activity)
  f.ctx.waterfall = undefined;
  const plugin = f.mount();
  const res = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"] });
  assert.equal(res.status, 200);
  assert.equal(res.data.result.summary.failed, 1);
  assert.equal(res.data.result.items[0].code, "activity-inspection-unavailable");
  assert.deepEqual(f.state.archivedSessionIds, [], "must safely reject archive when ctx.waterfall is missing");
});

test("archive session fallback rejects when ctx.waterfall query throws an error (issue #26)", async t => {
  const f = await fixture(t);
  f.state.archivedSessionIds = [];
  // ctx.waterfall query throws unexpected exception
  f.ctx.waterfall = async () => {
    throw new Error("provider inspection timed out");
  };
  const plugin = f.mount();
  const res = await plugin.request("/batch", { action: "archive", sessionIds: ["s1"] });
  assert.equal(res.status, 200);
  assert.equal(res.data.result.summary.failed, 1);
  assert.equal(res.data.result.items[0].code, "activity-check-failed");
  assert.match(res.data.result.items[0].error, /provider inspection timed out/);
  assert.deepEqual(f.state.archivedSessionIds, [], "must never swallow query exception and must not archive session");
});
