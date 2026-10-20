/**
 * Regression coverage for issue #41:
 *   "[Bug] 与 DSH 0.2.x 的三处兼容缺口：新会话/分叉会话不归属工作区、
 *    「移动至工作区」静默无效"
 *
 * The mock workspace registry below mirrors the DSH 0.2.1-rc.2 structures
 * verified against the official source (packages/workspace/workspace):
 *   - durable records live in a `workspaces` table keyed by workspace id and
 *     are flat `{ path, title, sessionIds, createdAt, updatedAt }` objects
 *     (no `workspaces` array on the global domain state);
 *   - entities expose `record` plus a runtime-filtered `sessionIds` getter
 *     backed by a canonical-cwd index (`sessionPaths`), and attach/detach
 *     only through the official entity API, which re-validates the stored
 *     header cwd against the canonical workspace path;
 *   - `enqueueOperation` serializes registry writes.
 *
 * Covered behaviors: runtime attach of new/forked sessions, boot repair of
 * historical unaccounted sessions, same-path move membership repair (with
 * artifact bytes/size/mtime invariants), idempotence, true cross-workspace
 * moves, cwd mismatch safety, incomplete-scan safety, restart stability,
 * archived-session preservation, and custom DSH home resolution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { encodeFsSessionSegment, encodeProjectSegment } from "../lib/session-files.js";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

const frame = text => zstdCompressSync(Buffer.from(text));
const waitFor = async (predicate, timeoutMs = 3000) => {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor: condition not met in time");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

async function createHarness(t, options = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-issue41-"));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  await fs.mkdir(join(home, "ws-src"));
  await fs.mkdir(join(home, "ws-tgt"));
  await fs.mkdir(join(home, "other-dir"));
  await fs.mkdir(join(home, "sessions"));
  // DSH stores workspace paths canonicalized (fs.realpath at create time).
  const source = await fs.realpath(join(home, "ws-src"));
  const target = await fs.realpath(join(home, "ws-tgt"));
  const other = await fs.realpath(join(home, "other-dir"));

  const table = new Map();               // workspaceId -> durable record
  const sessionPaths = new Map();        // canonical cwd index (runtime)
  const missingSessionPaths = new Set();
  const invalidSessionPaths = new Map();
  const headerIndex = new Map();
  const state = { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] };
  const live = new Map();
  const warnings = [];
  const infoLogs = [];
  let queue = Promise.resolve();

  const persistence = {
    rows: [],
    async list() { return persistence.rows.map(row => ({ header: { ...row.header }, revision: row.revision })); },
    locate: header => ({ kind: "jsonl", path: artifactPath(header) }),
  };

  const readSessionHeader = async (id) => {
    const liveSession = live.get(id);
    if (liveSession !== undefined) { headerIndex.set(id, liveSession.header); return liveSession.header; }
    const cached = headerIndex.get(id);
    if (cached !== undefined) return cached;
    for (const row of await persistence.list()) {
      if (row.header?.id === id) {
        headerIndex.set(id, row.header);
        indexHeader(row.header);
        return row.header;
      }
    }
    throw new Error(`cannot validate session '${id}': session persistence holds no such session`);
  };
  const indexHeader = (header) => {
    headerIndex.set(header.id, header);
    if (header.cwd === undefined) { invalidSessionPaths.set(header.id, "header has no cwd"); return; }
    fs.realpath(header.cwd).then((path) => {
      sessionPaths.set(header.id, path);
      invalidSessionPaths.delete(header.id);
    }, () => { invalidSessionPaths.set(header.id, `cwd '${header.cwd}' does not resolve`); });
  };

  const specs = [
    { id: "ws-src", path: source, title: "src" },
    { id: "ws-tgt", path: target, title: "tgt" },
  ];
  const entities = specs.map(spec => {
    const record = { path: spec.path, title: spec.title, sessionIds: [], createdAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z" };
    table.set(spec.id, record);
    state.workspaceIds.push(spec.id);
    return {
      id: spec.id,
      get record() { return table.get(spec.id); },
      get path() { return record.path; },
      get title() { return record.title; },
      get createdAt() { return record.createdAt; },
      get updatedAt() { return record.updatedAt; },
      // Official semantics: the getter filters the durable account through the
      // canonical-cwd index, so a stale index hides a member from the UI while
      // the record still accounts for it.
      get sessionIds() {
        return record.sessionIds.filter(id => sessionPaths.get(id) === record.path || missingSessionPaths.has(id));
      },
      async attachSession(sessionId) {
        if (!record.sessionIds.includes(sessionId)) {
          const header = await readSessionHeader(sessionId);
          if (header.cwd === undefined) throw new Error("cannot attach: stored header carries no cwd");
          let cwd;
          try { cwd = await fs.realpath(header.cwd); }
          catch { throw new Error(`cannot attach: cwd '${header.cwd}' does not resolve`); }
          if (!(await fs.stat(cwd)).isDirectory()) throw new Error("cannot attach: cwd is not a directory");
          if (cwd !== record.path) throw new Error(`cannot attach: cwd resolves to '${cwd}', not '${record.path}'`);
          sessionPaths.set(sessionId, cwd);
          missingSessionPaths.delete(sessionId);
          invalidSessionPaths.delete(sessionId);
        }
        if (!record.sessionIds.includes(sessionId)) record.sessionIds.unshift(sessionId);
        record.updatedAt = new Date().toISOString();
      },
      async detachSession(sessionId) {
        record.sessionIds = record.sessionIds.filter(id => id !== sessionId);
        record.updatedAt = new Date().toISOString();
      },
    };
  });

  const registry = {
    list: () => entities,
    get: id => entities.find(entity => entity.id === id),
    requireState: () => state,
    setState: async next => { Object.assign(state, next); },
    enqueueOperation: operation => {
      const result = queue.then(operation);
      queue = result.then(() => {}, () => {});
      return result;
    },
    headers: headerIndex,
    sessionPaths,
    missingSessionPaths,
    invalidSessionPaths,
    async resolveByPath(path) {
      const canonical = await fs.realpath(path);
      return entities.find(entity => entity.path === canonical);
    },
    async sessionKnown(id) {
      if (live.has(id)) return true;
      if (headerIndex.has(id)) return true;
      return (await persistence.list()).some(row => row.header?.id === id);
    },
    async archiveSession(id) { if (!state.archivedSessionIds.includes(id)) state.archivedSessionIds.push(id); },
    async unarchiveSession(id) { state.archivedSessionIds = state.archivedSessionIds.filter(x => x !== id); },
  };

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    sessionProjectionCache: { cachedSnapshot: () => undefined, coldSnapshot: async () => {} },
  };
  if (options.dshHomePathService !== false) services.dshHomePath = segment => join(home, segment);

  const listeners = {};
  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: id => live.get(id), list: () => [...live.values()], flush: async () => {} },
    agents: { get: () => undefined },
    get: name => services[name],
    emit: () => {},
    on: (name, fn) => { (listeners[name] = listeners[name] ?? []).push(fn); },
    logger: {
      info: message => infoLogs.push(message),
      warn: message => warnings.push(message),
      error: message => warnings.push(message),
    },
  };

  function artifactPath(header, filename = "session.v3.jsonl.zstd") {
    return join(home, "sessions", encodeProjectSegment(header.cwd), encodeFsSessionSegment(header.id), filename);
  }
  async function stage({ id, cwd, origin = "user", parentSession, isSeeded, filename = "session.v3.jsonl.zstd", register = true } = {}) {
    const header = { id, cwd, version: 3, origin, createdAt: Date.now(), agentPreset: "standard",
      ...(parentSession === undefined ? {} : { parentSession }),
      ...(isSeeded === true ? { isSeeded: true } : {}) };
    const path = artifactPath(header, filename);
    const lines = [
      JSON.stringify({ type: "session/header", seq: 0, time: Date.now(), data: {} }) + "\n",
      JSON.stringify({ type: "user/message", seq: 1, time: Date.now(), data: { content: "hi", surfaceOp: { kind: "append", seq: 1 } } }) + "\n",
    ];
    const bytes = Buffer.concat([frame(JSON.stringify(header) + "\n"), ...lines.map(frame)]);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, bytes);
    if (register) persistence.rows.push({ header, revision: "rev-" + id });
    return { header, path, bytes };
  }

  return {
    home, source, target, other, stage, artifactPath, registry, persistence, ctx, live, state,
    warnings, infoLogs, listeners,
    recordOf: id => table.get(id),
    memberIds: id => [...table.get(id).sessionIds],
    fire: (name, ...args) => { for (const fn of listeners[name] ?? []) fn(...args); },
    mount: () => mountPlugin(ctx),
  };
}

test("new session in a registered workspace is attached at runtime (session/created)", async t => {
  const h = await createHarness(t);
  h.mount();
  const sessionId = "session-new-1";
  // A brand-new session is live (header known) before its artifact lands.
  h.live.set(sessionId, { id: sessionId, header: { id: sessionId, cwd: h.source, origin: "user", version: 3 }, events: [] });
  h.fire("session/created", h.live.get(sessionId));
  await waitFor(() => h.memberIds("ws-src").includes(sessionId));
  assert.deepEqual(h.memberIds("ws-src"), [sessionId]);
  assert.deepEqual(h.memberIds("ws-tgt"), []);
});

test("forked session (seeded, with parent) is attached at runtime", async t => {
  const h = await createHarness(t);
  h.mount();
  const parentId = "session-parent";
  const childId = "session-fork-1";
  h.live.set(parentId, { id: parentId, header: { id: parentId, cwd: h.source, origin: "user", version: 3 }, events: [] });
  h.fire("session/created", h.live.get(parentId));
  await waitFor(() => h.memberIds("ws-src").includes(parentId));
  h.live.set(childId, { id: childId, header: { id: childId, cwd: h.source, origin: "user", version: 3, parentSession: parentId, isSeeded: true }, events: [] });
  h.fire("session/created", h.live.get(childId));
  await waitFor(() => h.memberIds("ws-src").includes(childId));
  assert.deepEqual(h.memberIds("ws-src"), [childId, parentId]);
});

test("subagent sessions never join a workspace account", async t => {
  const h = await createHarness(t);
  h.mount();
  const subId = "session-sub-1";
  h.live.set(subId, { id: subId, header: { id: subId, cwd: h.source, origin: "subagent", parentSession: "session-parent", version: 3 }, events: [] });
  h.fire("session/created", h.live.get(subId));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.memberIds("ws-src"), []);
  assert.deepEqual(h.memberIds("ws-tgt"), []);
});

test("runtime attach skips a session whose cwd matches no workspace", async t => {
  const h = await createHarness(t);
  h.mount();
  const sessionId = "session-nowhere";
  h.live.set(sessionId, { id: sessionId, header: { id: sessionId, cwd: h.other, origin: "user", version: 3 }, events: [] });
  h.fire("session/created", h.live.get(sessionId));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.memberIds("ws-src"), []);
  assert.deepEqual(h.memberIds("ws-tgt"), []);
});

test("runtime attach never double-registers a session already accounted for", async t => {
  const h = await createHarness(t);
  const sessionId = "session-dup";
  const staged = await h.stage({ id: sessionId, cwd: h.source });
  h.registry.get("ws-src").record.sessionIds.push(sessionId);
  h.mount();
  h.live.set(sessionId, { id: sessionId, header: staged.header, events: [] });
  h.fire("session/created", h.live.get(sessionId));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(h.memberIds("ws-src"), [sessionId]);
  assert.deepEqual(h.memberIds("ws-tgt"), []);
});

test("boot repair attaches historical sessions whose cwd matches a registered workspace", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-hist-1", cwd: h.source });
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-src"), ["session-hist-1"]);
  assert.deepEqual(h.memberIds("ws-tgt"), []);
  assert.ok(h.infoLogs.some(message => message.includes("attached 1 unaccounted sessions")), "repair must be logged");
  assert.equal(staged.header.cwd, h.source);
});

test("boot repair attaches indexed sessions even when the disk sweep also runs", async t => {
  const h = await createHarness(t);
  // A partial persistence index plus a disk-only session the index cannot
  // surface: the indexed session is repaired, the unvalidatable one is left
  // untouched with a warning (the official entity API validates through
  // session persistence, so an unindexed session can never be registered).
  const indexed = await h.stage({ id: "session-indexed", cwd: h.target });
  await h.stage({ id: "session-unindexed", cwd: h.target, register: false });
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-tgt"), ["session-indexed"]);
  assert.ok(indexed.bytes.length > 0);
  assert.ok(
    h.warnings.some(message => message.includes("session-unindexed") && message.includes("boot attach")),
    "the unvalidatable disk-only session must be reported, not silently dropped"
  );
});

test("boot repair is idempotent across restarts", async t => {
  const h = await createHarness(t);
  await h.stage({ id: "session-restart-1", cwd: h.source });
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-src"), ["session-restart-1"]);
  await h.mount().boot();
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-src"), ["session-restart-1"]);
});

test("boot repair never registers a session in two workspaces", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-two-ws", cwd: h.source });
  // Inconsistent legacy state: the session is accounted by ws-tgt while its
  // cwd names ws-src. The repair must not add a second account.
  h.registry.get("ws-tgt").record.sessionIds.push(staged.header.id);
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-tgt"), ["session-two-ws"]);
  assert.deepEqual(h.memberIds("ws-src"), []);
});

test("same-path move repairs the missing membership without touching the artifact", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-samepath", cwd: h.target });
  const before = await fs.stat(staged.path);
  const beforeBytes = await fs.readFile(staged.path);
  const response = await h.mount().request("/move", { sessionId: "session-samepath", targetWorkspaceId: "ws-tgt" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.moved, false);
  assert.equal(response.data.result.attached, true);
  assert.deepEqual(h.memberIds("ws-tgt"), ["session-samepath"]);
  assert.deepEqual(h.memberIds("ws-src"), []);
  const after = await fs.stat(staged.path);
  const afterBytes = await fs.readFile(staged.path);
  assert.equal(after.size, before.size, "artifact size must not change");
  assert.equal(after.mtimeMs, before.mtimeMs, "artifact mtime must not change");
  assert.deepEqual(afterBytes, beforeBytes, "artifact bytes must not change");
});

test("same-path move is idempotent when the membership already exists", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-samepath-idem", cwd: h.target });
  h.registry.get("ws-tgt").record.sessionIds.push(staged.header.id);
  const plugin = h.mount();
  const first = await plugin.request("/move", { sessionId: "session-samepath-idem", targetWorkspaceId: "ws-tgt" });
  assert.equal(first.data.result.attached, false);
  const second = await plugin.request("/move", { sessionId: "session-samepath-idem", targetWorkspaceId: "ws-tgt" });
  assert.equal(second.data.result.attached, false);
  assert.deepEqual(h.memberIds("ws-tgt"), ["session-samepath-idem"]);
});

test("same-path move re-accounts a session wrongly registered in another workspace", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-misaccounted", cwd: h.target });
  h.registry.get("ws-src").record.sessionIds.push(staged.header.id);
  const response = await h.mount().request("/move", { sessionId: "session-misaccounted", targetWorkspaceId: "ws-tgt" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.attached, true);
  assert.deepEqual(response.data.result.detachedFrom, ["ws-src"]);
  assert.deepEqual(h.memberIds("ws-tgt"), ["session-misaccounted"]);
  assert.deepEqual(h.memberIds("ws-src"), []);
});

test("same-path move reports failure when the membership write fails", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-attach-fail", cwd: h.target });
  h.registry.get("ws-tgt").attachSession = async () => { throw new Error("durable write failed"); };
  const response = await h.mount().request("/move", { sessionId: "session-attach-fail", targetWorkspaceId: "ws-tgt" });
  assert.equal(response.status, 500);
  assert.match(response.data.error, /durable write failed/);
  assert.deepEqual(h.memberIds("ws-tgt"), []);
});

test("same-path move leaves a live session untouched", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-live-samepath", cwd: h.target });
  const session = { id: staged.header.id, header: { ...staged.header }, events: [], flush: async () => {} };
  h.live.set(session.id, session);
  const response = await h.mount().request("/move", { sessionId: session.id, targetWorkspaceId: "ws-tgt" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.attached, true);
  assert.equal(session.events.length, 0, "no events may be appended to the live session");
  assert.equal(session.header.cwd, h.target, "live header cwd must not change");
  assert.equal(h.live.has(session.id), true, "the live session must stay live");
});

test("true cross-workspace move still re-homes the artifact and swaps accounting", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-crossmove", cwd: h.source });
  h.registry.get("ws-src").record.sessionIds.push(staged.header.id);
  const response = await h.mount().request("/move", { sessionId: "session-crossmove", targetWorkspaceId: "ws-tgt" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.moved, true);
  assert.deepEqual(response.data.result.fromWorkspaceIds, ["ws-src"]);
  assert.deepEqual(h.memberIds("ws-src"), []);
  assert.deepEqual(h.memberIds("ws-tgt"), ["session-crossmove"]);
  const movedPath = h.artifactPath({ id: "session-crossmove", cwd: h.target });
  await assert.rejects(fs.stat(staged.path), { code: "ENOENT" });
  const moved = await fs.stat(movedPath);
  assert.ok(moved.size > 0);
});

test("move to a workspace whose path differs from cwd rewrites the header cwd", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-rehome", cwd: h.other });
  const response = await h.mount().request("/move", { sessionId: "session-rehome", targetWorkspaceId: "ws-tgt" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.moved, true);
  const movedPath = h.artifactPath({ id: "session-rehome", cwd: h.target });
  const bytes = await fs.readFile(movedPath);
  const header = JSON.parse(zstdDecompressFirstLine(bytes));
  assert.equal(header.cwd, h.target);
});

test("boot repair never attaches a session whose cwd matches no workspace", async t => {
  const h = await createHarness(t);
  await h.stage({ id: "session-elsewhere", cwd: h.other });
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-src"), []);
  assert.deepEqual(h.memberIds("ws-tgt"), []);
});

test("incomplete persistence listing leaves existing membership untouched", async t => {
  const h = await createHarness(t);
  await h.stage({ id: "session-kept", cwd: h.source });
  h.registry.get("ws-src").record.sessionIds.push("session-kept");
  h.persistence.list = async () => { throw new Error("temporary failure"); };
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-src"), ["session-kept"]);
  assert.ok(h.warnings.some(message => message.includes("reconciliation skipped")));
});

test("incomplete disk sweep never prunes existing membership", async t => {
  const h = await createHarness(t);
  // A registered session with no readable artifact on disk, plus an
  // unreadable directory that makes the disk sweep report errors.
  h.registry.get("ws-src").record.sessionIds.push("session-ghost");
  const brokenDir = join(h.home, "sessions", "--broken--", "session-broken");
  await fs.mkdir(brokenDir, { recursive: true });
  await fs.writeFile(join(brokenDir, "session.v3.jsonl.zstd"), Buffer.from("not zstd at all"));
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-src"), ["session-ghost"], "an incomplete scan must not prune members");
});

test("archived sessions keep their workspace account across boots", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({ id: "session-archived", cwd: h.source });
  h.registry.get("ws-src").record.sessionIds.push(staged.header.id);
  h.state.archivedSessionIds.push(staged.header.id);
  await h.mount().boot();
  assert.deepEqual(h.memberIds("ws-src"), ["session-archived"]);
  assert.deepEqual(h.state.archivedSessionIds, ["session-archived"]);
});

test("custom DSH home is resolved when the dshHomePath service is unavailable", async t => {
  const previous = process.env.DSH_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  const h = await createHarness(t, { dshHomePathService: false });
  process.env.DSH_HOME = h.home;
  // The move path resolves the sessions root through adapter.homePath; with a
  // broken home resolver the directory assertion would refuse the move.
  const staged = await h.stage({ id: "session-customhome", cwd: h.other });
  const response = await h.mount().request("/move", { sessionId: "session-customhome", targetWorkspaceId: "ws-tgt" });
  assert.equal(response.status, 200, response.data.error);
  assert.equal(response.data.result.moved, true);
  const movedPath = h.artifactPath({ id: "session-customhome", cwd: h.target });
  assert.ok((await fs.stat(movedPath)).size > 0);
  assert.ok(staged.bytes.length > 0);
});

function zstdDecompressFirstLine(bytes) {
  // Local helper: decode only the first zstd frame (the header line).
  return zstdDecompressSync(bytes).toString("utf8").split("\n")[0];
}
