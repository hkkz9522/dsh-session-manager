import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

const EVENT = "session-manager/session-deleted";

async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-delete-notify-"));
  t.after(async () => {
    const rel = relative(await fs.realpath(tmpdir()), await fs.realpath(home));
    assert.ok(rel.startsWith("dsh-delete-notify-") && !rel.includes(sep));
    await fs.rm(home, { recursive: true, force: true });
  });
  let state = { archivedSessionIds: [], workspaces: [{ id: "ws", sessionIds: [] }] };
  const entity = {
    id: "ws", path: join(home, "workspace"),
    get record() { return state.workspaces[0]; },
    get sessionIds() { return this.record.sessionIds; },
    async detachSession(id) { this.record.sessionIds = this.sessionIds.filter(item => item !== id); },
  };
  const registry = {
    list: () => [entity], requireState: () => state,
    setState: async next => { state = next; }, enqueueOperation: async fn => fn(),
  };
  const headers = [], files = new Map(), notifications = [], warnings = [], disposed = [];
  const table = {
    host: { unit: { descriptor: { layout: "per-record" } } },
    get: () => undefined, put: async () => {}, delete: async () => {},
  };
  const services = {
    workspaceRegistry: registry, dshHomePath: (...parts) => join(home, ...parts),
    sessionPersistence: { list: async () => headers, locate: header => ({ path: files.get(header.id) }) },
    sessionProjectionCache: { requireTable: () => table },
  };
  const f = { home, files, entity, table, notifications, warnings, disposed, notify: async () => {} };
  const ctx = {
    get: name => services[name], workspaceRegistry: registry,
    sessions: { get: () => undefined, flush: async () => {} },
    agents: { get: () => undefined },
    waterfall: async (name, payload, fallback) => fallback(),
    emit(name, payload) { disposed.push([name, payload]); },
    async parallel(name, payload) {
      if (name !== EVENT) return;
      assert.deepEqual(Object.keys(payload), ["sessionId"]);
      await assert.rejects(fs.access(files.get(payload.sessionId)), { code: "ENOENT" });
      assert.ok(!entity.sessionIds.includes(payload.sessionId));
      notifications.push(payload.sessionId);
      await f.notify(payload);
    },
    logger: { info() {}, warn: message => warnings.push(message) },
  };
  f.ctx = ctx;
  f.stage = async (id, extra = {}) => {
    const header = { id, version: 4, createdAt: headers.length + 1, cwd: entity.path, origin: "user", ...extra };
    const file = join(home, "sessions", "project", id, "session.v4.jsonl");
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(header) + "\n");
    headers.push(header); files.set(id, file);
    if (header.origin !== "subagent") entity.record.sessionIds.push(id);
  };
  f.plugin = mountPlugin(ctx);
  await f.stage("s1");
  await f.stage("keep");
  return f;
}

test("permanent deletion notifies after file/account removal and awaits consumers", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const references = new Set(["s1", "keep"]);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const notified = new Promise(resolve => { reached = resolve; });
  f.notify = async ({ sessionId }) => { reached("notified"); await gate; references.delete(sessionId); };
  const request = f.plugin.request("/delete", { sessionId: "s1" });
  let response;
  try {
    const first = await Promise.race([notified, request.then(() => "returned-before-notification")]);
    assert.equal(first, "notified");
    assert.ok(references.has("s1"), "consumer save is still pending");
  } finally {
    release(); response = await request;
  }
  assert.equal(response.status, 200);
  assert.equal(response.data.result.warning, undefined);
  assert.deepEqual(f.notifications, ["s1"]);
  assert.deepEqual([...references], ["keep"]);
  await fs.access(f.files.get("keep"));
});

test("consumer failures are cleanup warnings, not rollback of a completed delete", async t => {
  const f = await fixture(t);
  f.notify = async () => { throw new AggregateError([new Error("consumer save failed")]); };
  const response = await f.plugin.request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.ok, true);
  assert.match(response.data.result.warning, /关联插件同步失败.*consumer save failed/);
  assert.ok(f.warnings.some(message => message.includes("consumer save failed")));
  await assert.rejects(fs.access(f.files.get("s1")), { code: "ENOENT" });
});

test("failed cancellation sends no permanent-delete notification", async t => {
  const f = await fixture(t);
  f.ctx.agents.get = () => ({ cancel() { throw new Error("cancel failed"); } });
  const response = await f.plugin.request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 500);
  assert.deepEqual(f.notifications, []);
  await fs.access(f.files.get("s1"));
});

test("failed workspace detachment sends no permanent-delete notification", async t => {
  const f = await fixture(t);
  f.entity.detachSession = async () => { throw new Error("detach failed"); };
  const response = await f.plugin.request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 500);
  assert.deepEqual(f.notifications, []);
  await fs.access(f.files.get("s1"));
});

test("batch deletion notifies once for each deleted identity", async t => {
  const f = await fixture(t);
  await f.stage("s2");
  const response = await f.plugin.request("/batch", { action: "delete", sessionIds: ["s1", "s2"] });
  assert.equal(response.status, 200);
  assert.deepEqual([...f.notifications].sort(), ["s1", "s2"]);
  await fs.access(f.files.get("keep"));
});

test("cascade deletion notifies descendants before their parent", async t => {
  const f = await fixture(t);
  await f.stage("child", { origin: "subagent", parentSession: "s1" });
  const response = await f.plugin.request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 200);
  assert.deepEqual(f.notifications, ["child", "s1"]);
  await fs.access(f.files.get("keep"));
});

test("cache cleanup failure does not suppress the completed-delete notification", async t => {
  const f = await fixture(t);
  f.table.delete = async () => { throw new Error("cache cleanup failed"); };
  const response = await f.plugin.request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 200);
  assert.match(response.data.result.warning, /cache cleanup failed/);
  assert.deepEqual(f.notifications, ["s1"]);
});

test("archive actions do not send permanent-delete notifications", async t => {
  const f = await fixture(t);
  f.ctx.workspaceRegistry.archiveSession = async () => {};
  const response = await f.plugin.request("/batch", { action: "archive", sessionIds: ["s1"] });
  assert.equal(response.status, 200);
  assert.deepEqual(f.notifications, []);
  await fs.access(f.files.get("s1"));
});

test("delete preview does not send permanent-delete notifications", async t => {
  const f = await fixture(t);
  const response = await f.plugin.request("/delete-preview?sessionId=s1", undefined, "GET");
  assert.equal(response.status, 200);
  assert.deepEqual(f.notifications, []);
  await fs.access(f.files.get("s1"));
});

test("a host with no registered consumers still deletes without warnings", async t => {
  const f = await fixture(t);
  f.ctx.parallel = async () => {};
  // mountPlugin captures context properties, so remount after changing the dispatcher.
  const plugin = mountPlugin(f.ctx);
  const response = await plugin.request("/delete", { sessionId: "s1" });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.warning, undefined);
  await assert.rejects(fs.access(f.files.get("s1")), { code: "ENOENT" });
});
