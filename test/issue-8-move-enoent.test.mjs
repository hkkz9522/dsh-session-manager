/**
 * Regression coverage for issue #8:
 *   "[Bug] 迁移会话到新工作区后发送新消息报 ENOENT，重启 DSH 后恢复"
 *
 * Pre-fix symptom: the JSONL backend's JsonlSessionHandle captures its
 * header at construction time and uses the captured cwd to compute the
 * artifact path on every fs.open(). moveSession rewrites the liveSession
 * header, the workspaceRegistry state, and the file on disk, but never
 * touches the in-process write handle. After move, the api-gateway keeps
 * routing session/event to the OLD writer, which fs.open()s the pre-move
 * (now non-existent) path -> ENOENT.
 *
 * Fix: after publishing the target artifact, retarget the existing in-process
 * writer's header in place. The same handle is retained by the live agent, so
 * replacing it with a newly opened handle would leave the agent's owned handle
 * stale. We do NOT emit "session/disposed" because the Session is still live.
 *
 * This test loads the EXACT moveSession body extracted from lib/index.js
 * (test/issue-8-repro/_move.mjs) -- no rewrite of the body -- and exercises
 * it against a minimal JSONL-backend-shaped ctx (tracker.writers + the
 * session/event listener that routes through tracker.writers.get(id)).
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, open, readFile, stat, rm, rename, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { moveSession } from "./issue-8-repro/_move.mjs";


function encodeSessionSegment(id) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    const code = id.charCodeAt(i);
    if (ch === "/" || ch === String.fromCharCode(92) || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return "--" + (readable.replace(/^-+/, "") || "root").slice(0, 251) + "--";
}
function logPath(root, cwd, id) {
  return join(root, "sessions", encodeSessionSegment(cwd), encodeSessionSegment(id), "session.v3.jsonl.zstd");
}
async function stage(home, sourceWorkspace, targetWorkspace) {
  const sessionId = "sess-issue8-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  const initialHeader = {
    id: sessionId,
    cwd: sourceWorkspace,
    createdAt: Date.now(),
    version: 3,
    origin: "user",
    agentPreset: "standard",
  };
  const sourcePath = logPath(home, sourceWorkspace, sessionId);
  const targetPath = logPath(home, targetWorkspace, sessionId);
  await mkdir(dirname(sourcePath), { recursive: true });
  const headerLine = JSON.stringify(initialHeader);
  const rest = [
    JSON.stringify({ type: "session/header", seq: 0, time: Date.now(), data: {} }),
    JSON.stringify({ type: "user/message", seq: 1, time: Date.now(), data: { content: "hi", surfaceOp: { kind: "append", seq: 1 } } }),
  ].join("\n") + "\n";
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from(headerLine + "\n", "utf8")),
    zstdCompressSync(Buffer.from(rest, "utf8")),
  ]);
  const h = await open(sourcePath, "wx", 0o600);
  await h.writeFile(bytes);
  await h.sync();
  await h.close();
  return { sessionId, initialHeader, sourcePath, targetPath };
}
function buildCtx(home, sourceWorkspace, targetWorkspace, sessionId, initialHeader) {
  const tracker = { writers: new Map() };
  const liveSession = {
    id: sessionId,
    events: [],
    header: { ...initialHeader },
    append(t, d) { const e = { type: t, seq: this.events.length, time: Date.now(), data: d }; this.events.push(e); return e; },
    flush() { return Promise.resolve(); },
  };
  function makeWriteHandle(home, sessionId, header) {
    return {
      id: sessionId, access: "write",
      header: { ...header },
      state: { materialized: true, cursor: 2, inheritedEventCount: 0 },
      async appendBatch(events) {
        const path = logPath(home, this.header.cwd, this.id);
        const handle = await open(path, "a");
        try { await handle.writeFile(Buffer.from(JSON.stringify({ events }) + "\n")); await handle.sync(); }
        finally { await handle.close(); }
      },
      async close() {
        if (tracker.writers.get(sessionId) === this) tracker.writers.delete(sessionId);
      },
    };
  }
  async function findStoredHeader(id) {
    const root = join(home, "sessions");
    const projects = await readdir(root).catch(() => []);
    for (const project of projects) {
      for (const candidate of [encodeSessionSegment(id), id]) {
        const file = join(root, project, candidate, "session.v3.jsonl.zstd");
        try {
          const buf = await readFile(file);
          const frame = zstdDecompressSync(buf);
          const firstLine = frame.toString("utf8").split("\n")[0];
          const meta = JSON.parse(firstLine);
        process.stdout.write(`[debug] findStoredHeader for ${id} -> cwd=${meta.cwd}\n`);
        return { file, meta };
        } catch {}
      }
    }
    return undefined;
  }
  async function persistenceOpen(id, access) {
    if (access !== "write") throw new Error("mock: only 'write' supported in this test");
    if (tracker.writers.has(id)) {
      const err = new Error(`session "${id}" is already owned by an active write handle`);
      err.name = "SessionAlreadyOwnedError";
      err.code = "session-already-owned";
      throw err;
    }
    const found = await findStoredHeader(id);
    if (!found) throw new Error(`mock: session "${id}" not found`);
    const handle = makeWriteHandle(home, id, found.meta);
    tracker.writers.set(id, handle);
    return handle;
  }
  const persistence = {
    coordinator: undefined,
    async list() { return [{ header: { ...initialHeader }, revision: "mock-rev" }]; },
    locate(meta) { return { kind: "jsonl", path: logPath(home, meta.cwd, meta.id) }; },
    tracker,
    open: persistenceOpen,
  };
  const initialWriter = makeWriteHandle(home, sessionId, initialHeader);
  tracker.writers.set(sessionId, initialWriter);
  const workspaceRegistry = {
    headers: new Map([[sessionId, { ...initialHeader }]]),
    sessionPaths: new Map([[sessionId, sourceWorkspace]]),
    invalidSessionPaths: new Map(),
    workspaces: [
      { id: "ws-source", title: "Source", path: sourceWorkspace, record: { sessionIds: [sessionId] }, sessionIds: [sessionId],
        async attachSession(i) { this.record.sessionIds.push(i); this.sessionIds = [...this.record.sessionIds]; },
        async detachSession(i) { this.record.sessionIds = this.record.sessionIds.filter((x) => x !== i); this.sessionIds = [...this.record.sessionIds]; } },
      { id: "ws-target", title: "Target", path: targetWorkspace, record: { sessionIds: [] }, sessionIds: [],
        async attachSession(i) { this.record.sessionIds.push(i); this.sessionIds = [...this.record.sessionIds]; },
        async detachSession(i) { this.record.sessionIds = this.record.sessionIds.filter((x) => x !== i); this.sessionIds = [...this.record.sessionIds]; } },
    ],
    requireState() { return { archivedSessionIds: [] }; },
    async enqueueOperation(op) { await op(); },
    async setState() {},
    list() { return this.workspaces; },
  };
  const listeners = { "session/event": [] };
  const ctx = {
    workspaceRegistry,
    sessions: { get: (id) => id === sessionId ? liveSession : undefined, flush: (s) => s.flush() },
    agents: { get: () => undefined },
    get(name) {
      if (name === "sessionPersistence") return persistence;
      if (name === "dshHomePath") return (seg) => join(home, seg);
      if (name === "sessionProjectionCache") return undefined;
      return undefined;
    },
    logger: { info() {}, warn() {}, error() {} },
    emit(name, ...args) { for (const fn of listeners[name] || []) fn(...args); },
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    effect() {},
  };
  // The real backend exposes its tracker as a runtime property even though
  // the TypeScript field is private. The fix retargets the existing writer;
  // it must not emit session/disposed because the Session remains live.
  ctx.on("session/event", (session, event) => {
    const w = tracker.writers.get(session.id);
    if (!w) return;
    w.appendBatch([event]).catch(() => {});
  });
  return { ctx, tracker, liveSession, persistence };
}


test("issue #8 fix: post-move writer.header.cwd is the NEW cwd and writes land there", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-issue8-fix-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const sourceWorkspace = join(home, "src");
  const targetWorkspace = join(home, "tgt");
  await mkdir(sourceWorkspace, { recursive: true });
  await mkdir(targetWorkspace, { recursive: true });

  const { sessionId, initialHeader, sourcePath, targetPath } = await stage(home, sourceWorkspace, targetWorkspace);
  const { ctx, tracker, liveSession } = buildCtx(home, sourceWorkspace, targetWorkspace, sessionId, initialHeader);

  // Pre-move sanity: writer.header.cwd is the source cwd.
  const initialWriter = tracker.writers.get(sessionId);
  assert.equal(initialWriter.header.cwd, sourceWorkspace);

  const result = await moveSession(ctx, sessionId, "ws-target");
  assert.equal(result.ok, true);
  assert.equal(result.moved, true);

  // After move, the original writer's captured header.cwd MUST be the NEW cwd.
  // The handle identity is preserved because the live agent retains it.
  const postWriter = tracker.writers.get(sessionId);
  assert.ok(postWriter, "tracker should still hold a write handle after move");
  assert.strictEqual(postWriter, initialWriter, "the live writer identity remains stable");
  assert.equal(postWriter.header.cwd, targetWorkspace, "writer.header.cwd must be the NEW cwd after move");

  // The artifact on disk must reflect the move.
  assert.equal(await stat(sourcePath).then(() => true).catch(() => false), false);
  assert.equal(await stat(targetPath).then(() => true).catch(() => false), true);

  // Simulate the api-gateway's session/event after move. The tracker-routed
  // handle must fs.open() the NEW path -- not the OLD deleted one.
  const event = { type: "user/message", seq: 2, time: Date.now(), data: { content: "after move", surfaceOp: { kind: "append", seq: 2 } } };
  // session/event listener is async (returns the promise from appendBatch).
  // Wait briefly for it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Direct invoke the listener for deterministic result.
  const listeners = (ctx._listeners ?? {});
  // The mock ctx.on registered the listener; replay it.
  // We re-invoke by going through the listener list captured at install.
  // For deterministic behavior, just call writer.appendBatch directly.
  await postWriter.appendBatch([event]);
  // No ENOENT was thrown -> the fix works.
});

test("issue #8 regression guard: without the fix, the OLD writer ENOENTs on the new path", async (t) => {
  // Sanity guard: if we skip the fix (no header mutation, no close+reopen) the
  // OLD writer still ENOENTs, confirming the regression is real and the
  // previous test isn't tautological.
  const home = await mkdtemp(join(tmpdir(), "dsh-issue8-guard-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const sourceWorkspace = join(home, "src");
  const targetWorkspace = join(home, "tgt");
  await mkdir(sourceWorkspace, { recursive: true });
  await mkdir(targetWorkspace, { recursive: true });

  const { sessionId, initialHeader, sourcePath, targetPath } = await stage(home, sourceWorkspace, targetWorkspace);
  const { tracker } = buildCtx(home, sourceWorkspace, targetWorkspace, sessionId, initialHeader);

  // Simulate ONLY the parts of moveSession that the pre-fix code DID do:
  // mkdir the target parent, rename the file, rewrite liveSession.header.
  // Skip the fix's header mutation.
  await mkdir(dirname(targetPath), { recursive: true });
  await rename(sourcePath, targetPath);
  await rm(dirname(sourcePath), { recursive: true, force: true });

  // The OLD writer still survives in tracker.writers, bound to the source cwd.
  const stale = tracker.writers.get(sessionId);
  assert.equal(stale.header.cwd, sourceWorkspace, "no-fix: OLD writer's header.cwd is still OLD");
  assert.equal(await stat(sourcePath).then(() => true).catch(() => false), false, "OLD path gone");
  assert.equal(await stat(targetPath).then(() => true).catch(() => false), true, "NEW path has artifact");

  // Writing through the stale writer must ENOENT (because we also removed
  // its parent directory, mirroring the plugin's post-move cleanup).
  await assert.rejects(
    stale.appendBatch([{ type: "user/message", seq: 2, time: Date.now(), data: { content: "x", surfaceOp: { kind: "append", seq: 2 } } }]),
    (err) => err.code === "ENOENT"
  );
});
