// Reproduction of issue #8: "迁移会话到新工作区后发送新消息报 ENOENT，重启 DSH 后恢复"
// plus a verification of the moveSession fix (issue #8 follow-up, plan B).
//
// This file is a self-contained Node ESM script that:
//   1. Stages a synthetic session file at the source workspace path.
//   2. Builds a minimal DSH ctx whose persistence layer behaves like
//      JsonlSessionPersistence / JsonlSessionHandle / JsonlBackendTracker:
//        - tracker.writers keeps the single active write handle per id
//        - the handle's header.cwd is captured at construction; subsequent
//          appendLines() opens logPath(root, header.cwd, id, compression)
//   3. Calls the EXACT moveSession function extracted from lib/index.js.
//   4. (OLD path) Demonstrates the bug: writing via the OLD writer ENOENTs
//      because its captured header.cwd still points at the deleted source path.
//   5. (FIX path) The plugin retargets the existing in-process writer in place;
//      subsequent writes succeed WITHOUT emitting "session/disposed" (the
//      Session remains live and that event would tear down unrelated state).
//
// Run with:  node test/issue-8-repro/reproduce.mjs

import { mkdir, mkdtemp, open, readFile, stat, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { moveSession } from "./_move.mjs";

const encodeSessionSegment = (id) => {
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
};
const logPath = (root, cwd, id) =>
  join(root, "sessions", encodeSessionSegment(cwd), encodeSessionSegment(id), "session.v3.jsonl.zstd");

const home = await mkdtemp(join(tmpdir(), "dsh-move-issue-8-"));
const sourceWorkspace = join(home, "fake-source");
const targetWorkspace = join(home, "fake-target");
await mkdir(sourceWorkspace, { recursive: true });
await mkdir(targetWorkspace, { recursive: true });

const sessionId = "session-issue8-" + Date.now();
const initialHeader = { id: sessionId, cwd: sourceWorkspace, createdAt: Date.now(), version: 3, origin: "user", agentPreset: "standard" };
const headerLine = JSON.stringify(initialHeader);
const rest = [
  JSON.stringify({ type: "session/header", seq: 0, time: Date.now(), data: {} }),
  JSON.stringify({ type: "user/message", seq: 1, time: Date.now(), data: { content: "before move", surfaceOp: { kind: "append", seq: 1 } } }),
].join("\n") + "\n";
const artifactBytes = Buffer.concat([
  zstdCompressSync(Buffer.from(headerLine + "\n", "utf8")),
  zstdCompressSync(Buffer.from(rest, "utf8")),
]);
const sourceArtifactPath = logPath(home, sourceWorkspace, sessionId);
const targetArtifactPath = logPath(home, targetWorkspace, sessionId);
await mkdir(dirname(sourceArtifactPath), { recursive: true });
{
  const h = await open(sourceArtifactPath, "wx", 0o600);
  await h.writeFile(artifactBytes);
  await h.sync();
  await h.close();
}

// --- Minimal JSONL-backend simulation ------------------------------------
//
// tracker.writers holds the single active write handle per sessionId (mirrors
// JsonlBackendTracker.writers). persistence.open() scans the filesystem for
// the latest artifact (mirrors JsonlSessionPersistence.open / findLog) and
// builds a fresh handle bound to the stored header. The fix closes the old
// writer directly rather than emitting session/disposed.

const tracker = { writers: new Map() };
const eventListeners = { "session/disposed": [], "session/event": [], "session/flush": [] };

const liveSession = {
  id: sessionId,
  events: [],
  header: { ...initialHeader },
  append(t, d) { const e = { type: t, seq: this.events.length, time: Date.now(), data: d }; this.events.push(e); return e; },
  flush() { return Promise.resolve(); },
};

function makeWriteHandle(header) {
  return {
    id: sessionId, access: "write",
    header: { ...header },
    state: { materialized: true, cursor: 2, inheritedEventCount: 0 },
    async appendBatch(events) {
      const path = logPath(home, this.header.cwd, this.id);
      process.stdout.write(`  [handle @${this.header.cwd.split(/[\\\\/]/).pop()}] open path: ${path}\n`);
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
  // Scan sessions/ for the latest artifact matching id.
  const root = join(home, "sessions");
  const projects = await readdir(root).catch(() => []);
  for (const project of projects) {
    const dir = join(root, project);
    for (const candidate of [encodeSessionSegment(id), id]) {
      const file = join(dir, candidate, "session.v3.jsonl.zstd");
      try {
        const buf = await readFile(file);
        // First zstd frame = header line.
        const frame = zstdDecompressSync(buf);
        const firstLine = frame.toString("utf8").split("\n")[0];
        return { file, meta: JSON.parse(firstLine) };
      } catch {}
    }
  }
  return undefined;
}

async function persistenceOpen(id, access) {
  if (access !== "write") throw new Error(`mock persistence only supports 'write' in this test`);
  if (tracker.writers.has(id)) {
    const err = new Error(`session "${id}" is already owned by an active write handle`);
    err.name = "SessionAlreadyOwnedError";
    err.code = "session-already-owned";
    throw err;
  }
  const found = await findStoredHeader(id);
  if (!found) {
    const err = new Error(`session "${id}" not found`);
    err.name = "SessionPersistenceNotFoundError";
    throw err;
  }
  const handle = makeWriteHandle(found.meta);
  tracker.writers.set(id, handle);
  return handle;
}

const sessionPersistence = {
  coordinator: undefined,
  async list() { return [{ header: { ...initialHeader }, revision: "mock-rev" }]; },
  locate(meta) { return { kind: "jsonl", path: logPath(home, meta.cwd, meta.id) }; },
  open: persistenceOpen,
  // Expose the tracker so the plugin's post-move header mutation has
  // something to mutate. In real DSH, the JSONL backend's tracker is a
  // private field, but TypeScript's "private" modifier is compile-time
  // only -- at runtime it's a regular property and persistence.tracker
  // is reachable.
  tracker,
};

// Initial writer (captured at "resume" time, before move).
const initialWriter = makeWriteHandle(initialHeader);
tracker.writers.set(sessionId, initialWriter);

const workspaceRegistry = {
  headers: new Map([[sessionId, { ...initialHeader }]]),
  sessionPaths: new Map([[sessionId, sourceWorkspace]]),
  invalidSessionPaths: new Map(),
  workspaces: [
    { id: "ws-source", title: "Source", path: sourceWorkspace, record: { sessionIds: [sessionId] }, sessionIds: [sessionId], async attachSession(i) { this.record.sessionIds.push(i); this.sessionIds = [...this.record.sessionIds]; }, async detachSession(i) { this.record.sessionIds = this.record.sessionIds.filter(x => x !== i); this.sessionIds = [...this.record.sessionIds]; } },
    { id: "ws-target", title: "Target", path: targetWorkspace, record: { sessionIds: [] }, sessionIds: [], async attachSession(i) { this.record.sessionIds.push(i); this.sessionIds = [...this.record.sessionIds]; }, async detachSession(i) { this.record.sessionIds = this.record.sessionIds.filter(x => x !== i); this.sessionIds = [...this.record.sessionIds]; } },
  ],
  requireState() { return { archivedSessionIds: [] }; },
  async enqueueOperation(op) { await op(); },
  async setState() {},
  list() { return this.workspaces; },
};

// Cordis-style ctx with .get(name) and .emit(name, ...args)
const ctxListeners = { "session/disposed": [], "session/event": [], "session/flush": [] };
const ctx = {
  workspaceRegistry,
  sessions: { get: (id) => id === sessionId ? liveSession : undefined, flush: (s) => s.flush() },
  agents: { get: () => undefined },
  get(name) {
    if (name === "sessionPersistence") return sessionPersistence;
    if (name === "dshHomePath") return (seg) => join(home, seg);
    if (name === "sessionProjectionCache") return undefined;
    return undefined;
  },
  logger: { info() {}, warn: (...a) => process.stdout.write(`[warn] ${a.join(" ")}\n`), error() {} },
  emit(name, ...args) {
    const ls = ctxListeners[name] || [];
    for (const l of ls) l(...args);
  },
  on(name, fn) {
    (ctxListeners[name] = ctxListeners[name] || []).push(fn);
  },
  effect() {},
};

// JSONL backend simulation: install() runs once at backend setup and hooks
// session/event, session/flush, session/disposed. Mirrors storage.ts:534-565.
ctx.on("session/event", (session, event) => {
  const w = tracker.writers.get(session.id);
  if (!w) return; // event silently dropped (matches real backend when no writer)
  // In real backend, w.enqueueLive buffers and batches. We directly call appendBatch
  // after constructing an event-array shape. This is the path the API gateway takes.
  w.appendBatch([event]).catch(() => {});
});
ctx.on("session/disposed", (session) => {
  const w = tracker.writers.get(session.id);
  if (!w) return;
  tracker.writers.delete(session.id);
  // In real backend, writer.close() runs asynchronously; here we just drop the slot
  // which is what the listener depends on for tracker release.
});

async function snapshot(label) {
  const w = tracker.writers.get(sessionId);
  return `[${label}]
  liveSession.header.cwd       = ${liveSession.header.cwd}
  writer.header.cwd            = ${w ? w.header.cwd : "(no writer)"}
  registry.sessionPaths[id]    = ${workspaceRegistry.sessionPaths.get(sessionId)}
  registry.headers[id].cwd     = ${workspaceRegistry.headers.get(sessionId).cwd}
  source artifact exists       = ${await stat(sourceArtifactPath).then(() => true).catch(() => false)}
  target artifact exists       = ${await stat(targetArtifactPath).then(() => true).catch(() => false)}`;
}

console.log(await snapshot("BEFORE MOVE"));

const moveResult = await moveSession(ctx, sessionId, "ws-target");
console.log("\n[MOVE RESULT]");
console.log(JSON.stringify(moveResult, null, 2));

console.log("\n" + (await snapshot("AFTER MOVE")));

// Simulate the OLD api-gateway path that triggered issue #8: the api-gateway
// emits session/event. The backend routes to tracker.writers.get(id). Before
// the fix, that returned the ORIGINAL writer (header.cwd = OLD), which ENOENTs.
// After the fix, the plugin retargets the existing writer, so
// tracker.writers keeps the same writer with header.cwd = NEW.
console.log("\n[SIMULATING API-GATEWAY session/event AFTER MOVE]");
let writeError;
try {
  // emit("session/event", liveSession, event) — the backend listener routes it.
  await new Promise((resolve, reject) => {
    const ls = ctxListeners["session/event"];
    const wrapped = (s, e) => {
      // Run the listener synchronously so we surface its rejection here.
      const fn = ls[0];
      try {
        const result = fn(s, e);
        if (result && typeof result.catch === "function") result.catch(reject);
        else resolve();
      } catch (err) { reject(err); }
    };
    // Call our own listener synchronously to await its async work.
    wrapped(liveSession, { type: "user/message", seq: 2, time: Date.now(), data: { content: "after move", surfaceOp: { kind: "append", seq: 2 } } });
  });
} catch (e) { writeError = e; }

if (writeError && writeError.code === "ENOENT") {
  console.log(`FAILED: ${writeError.code} ${writeError.message}`);
  process.exit(2);
} else if (writeError) {
  console.log(`UNEXPECTED ERROR: ${writeError.message}`);
  process.exit(3);
} else {
  console.log("SUCCESS: write through tracker-routed session/event landed at the new path.");
}

// Cleanup
await rm(home, { recursive: true, force: true });
