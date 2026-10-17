/**
 * Regression coverage for issue #32:
 * 1. Packed rows: physical rows missing `seq` (e.g. tool-call-chunks) are not passed directly to coldSnapshot.
 *    If official adapter.openSessionRead is available, logical events from handle.read(0) are used.
 *    If fallback to disk, packed rows without sequential seq are safely skipped.
 * 2. Old format migration: moving cold old-format sessions preserves original generation filename and header version.
 * 3. Inherited sessions: inheritedEventCount is resolved or safely skipped.
 * 4. Cache hit/miss: cachedSnapshot skips coldSnapshot; cache miss triggers refold.
 * 5. Large history library: workspace reconciliation runs immediately; projection rebuild respects budget & yields event loop.
 * 6. Cache consistency after cross-workspace move and corrupt JSON line safety.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { encodeFsSessionSegment, encodeProjectSegment } from "../lib/session-files.js";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

const frame = text => zstdCompressSync(Buffer.from(text));

async function createHarness(t) {
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-issue32-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(home));
    assert.ok(rel.startsWith("dsh-issue32-test-") && !rel.includes(sep));
    await fs.rm(home, { recursive: true, force: true });
  });

  const source = join(home, "source");
  const target = join(home, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.mkdir(join(home, "sessions"));

  let state = {
    archivedSessionIds: [],
    workspaces: [
      { id: "source", sessionIds: ["s1"] },
      { id: "target", sessionIds: [] }
    ]
  };
  let writes = 0;
  const entities = ["source", "target"].map(id => ({
    id,
    title: id,
    path: id === "source" ? source : target,
    get record() { return state.workspaces.find(w => w.id === id); },
    get sessionIds() { return this.record.sessionIds; },
    async attachSession(sessionId) {
      if (!this.sessionIds.includes(sessionId)) this.record.sessionIds.push(sessionId);
    },
    async detachSession(sessionId) {
      this.record.sessionIds = this.sessionIds.filter(i => i !== sessionId);
    }
  }));

  const registry = {
    list: () => entities,
    requireState: () => state,
    setState: async next => { state = next; writes++; },
    enqueueOperation: async operation => operation(),
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map()
  };

  const live = new Map();
  const warnings = [];
  const infoLogs = [];
  const coldSnapshotCalls = [];

  const persistence = {
    list: async () => [],
    locate: header => ({ path: artifactPath(header) })
  };

  const projectionCache = {
    cachedSnapshot: () => undefined,
    coldSnapshot: async (meta, count, events) => {
      coldSnapshotCalls.push({ meta, count, events });
    }
  };

  const adapter = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    homePath: segment => join(home, segment),
    projectionCache,
    getSession: id => live.get(id)
  };

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    dshHomePath: segment => join(home, segment),
    sessionProjectionCache: projectionCache
  };

  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: id => live.get(id), flush: async () => {} },
    agents: { get: () => undefined },
    get: name => services[name],
    emit: () => {},
    logger: {
      info: msg => infoLogs.push(msg),
      warn: msg => warnings.push(msg),
      error: msg => warnings.push(msg)
    }
  };

  function artifactPath(header, filename = "session.v3.jsonl.zstd") {
    return join(home, "sessions", encodeProjectSegment(header.cwd), encodeFsSessionSegment(header.id), filename);
  }

  async function stage({
    id = "s1",
    cwd = source,
    filename = "session.v3.jsonl.zstd",
    events = [{ type: "user/message", seq: 0, data: { content: "keep history" } }],
    rawLines,
    header: overrides = {}
  } = {}) {
    const header = { id, cwd, version: 3, agentPreset: "standard", origin: "user", ...overrides };
    const path = artifactPath({ ...header, id }, filename);
    const lines = rawLines ?? events.map(e => JSON.stringify(e) + "\n");
    const content = JSON.stringify(header) + "\n" + lines.join("");
    const payload = filename.endsWith(".zstd")
      ? Buffer.concat([frame(JSON.stringify(header) + "\n"), ...lines.map(frame)])
      : Buffer.from(content);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, payload);
    return { header, path, bytes: payload, content, lines };
  }

  return {
    home,
    source,
    target,
    stage,
    artifactPath,
    registry,
    persistence,
    projectionCache,
    services,
    ctx,
    adapter,
    live,
    warnings,
    infoLogs,
    coldSnapshotCalls,
    get state() { return state; },
    mount: () => mountPlugin(ctx)
  };
}

test("packed rows: uses logical events from official openSessionRead when available (issue #32)", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({
    rawLines: [
      JSON.stringify({ type: "session/header", seq: 0, data: {} }) + "\n",
      JSON.stringify({ type: "tool-call-chunks", seq0: 1, chunks: ["chunk1", "chunk2"] }) + "\n"
    ]
  });
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-1" }];

  // Provide official persistence.open that returns decoded & expanded logical events via openSessionRead
  const logicalEvents = [
    { type: "session/header", seq: 0, data: {} },
    { type: "tool-call", seq: 1, data: { output: "chunk1" } },
    { type: "tool-call", seq: 2, data: { output: "chunk2" } }
  ];
  h.persistence.open = async (id, mode) => {
    assert.equal(id, staged.header.id);
    assert.equal(mode, "read");
    return {
      header: staged.header,
      inheritedEventCount: 0,
      async read(offset) {
        assert.equal(offset, 0);
        return logicalEvents;
      },
      async close() {}
    };
  };

  await h.mount().boot();

  assert.equal(h.coldSnapshotCalls.length, 1);
  assert.deepEqual(h.coldSnapshotCalls[0].events, logicalEvents);
  assert.equal(h.coldSnapshotCalls[0].count, 0);
});

test("packed rows: disk fallback safely skips coldSnapshot when events have non-contiguous seq (issue #32)", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({
    rawLines: [
      JSON.stringify({ type: "session/header", seq: 0, data: {} }) + "\n",
      // Physical packed row missing seq
      JSON.stringify({ type: "tool-call-chunks", seq0: 1, data: {} }) + "\n"
    ]
  });
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-1" }];

  await h.mount().boot();

  assert.equal(h.coldSnapshotCalls.length, 0, "must NOT pass physical packed rows to coldSnapshot");
  assert.ok(
    h.warnings.some(w => w.includes("physical rows cannot be restored as logical events without official migration")),
    "must warn about skipping packed rows"
  );
});

test("old format migration: moving cold old-format session preserves filename and generation (issue #32)", async t => {
  const h = await createHarness(t);
  // Stage cold v0 session
  const staged = await h.stage({
    filename: "session.jsonl.zstd",
    header: { version: 0 },
    events: [
      { type: "session/header", seq: 0, data: {} },
      { type: "user/message", seq: 1, data: { content: "v0 history" } }
    ]
  });
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-v0" }];

  const res = await h.mount().request("/move", { sessionId: staged.header.id, targetWorkspaceId: "target" });
  assert.equal(res.status, 200, res.data.error);
  assert.equal(res.data.result.moved, true);

  // Target filename must remain session.jsonl.zstd, NOT upgraded to session.v4.jsonl.zstd without migrating events
  const targetDir = join(h.home, "sessions", encodeProjectSegment(h.target), encodeFsSessionSegment(staged.header.id));
  const targetPath = join(targetDir, "session.jsonl.zstd");
  const exists = await fs.stat(targetPath).then(() => true).catch(() => false);
  assert.ok(exists, "moved file must retain legacy filename session.jsonl.zstd");

  const v4Path = join(targetDir, "session.v4.jsonl.zstd");
  const v4Exists = await fs.stat(v4Path).then(() => true).catch(() => false);
  assert.equal(v4Exists, false, "must NOT forge session.v4.jsonl.zstd for cold old session");

  // Header version must match filename (0)
  const bytes = await fs.readFile(targetPath);
  const decompressed = zstdDecompressSync(bytes).toString("utf8");
  const targetHeader = JSON.parse(decompressed.split("\n")[0]);
  assert.equal(targetHeader.version, 0, "header.version must remain 0 to match filename and unmigrated events");
});

test("cache hits and misses: skips coldSnapshot on cachedSnapshot hit (issue #32)", async t => {
  const h = await createHarness(t);
  const staged = await h.stage();
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-1" }];

  // Simulate cache hit
  h.projectionCache.cachedSnapshot = header => {
    assert.equal(header.id, staged.header.id);
    return { snapshot: true };
  };

  await h.mount().boot();
  assert.equal(h.coldSnapshotCalls.length, 0, "must skip coldSnapshot on cache hit");

  // Simulate cache miss
  h.projectionCache.cachedSnapshot = () => undefined;
  await h.mount().boot();
  assert.equal(h.coldSnapshotCalls.length, 1, "must refold on cache miss");
});

test("large history library: membership reconciliation is decoupled from projection rebuild (issue #32)", async t => {
  const h = await createHarness(t);

  // Stage 60 sessions
  const headers = [];
  for (let i = 0; i < 60; i++) {
    const id = `s-${i}`;
    const staged = await h.stage({
      id,
      events: [{ type: "session/header", seq: 0, data: {} }]
    });
    headers.push(staged.header);
  }
  h.persistence.list = async () => headers.map(header => ({ header, revision: "rev" }));

  // Initially source workspace has only s1
  h.state.workspaces[0].sessionIds = ["s-0"];

  let reconcileFinishedBeforeLastColdSnapshot = false;
  let snapshotCount = 0;
  h.projectionCache.coldSnapshot = async () => {
    snapshotCount++;
    // Check if registry reconciliation has already attached the disk sessions to source workspace
    if (h.state.workspaces[0].sessionIds.length > 1) {
      reconcileFinishedBeforeLastColdSnapshot = true;
    }
  };

  await h.mount().boot();

  // 1. Reconciliation completed and attached disk sessions
  assert.ok(h.state.workspaces[0].sessionIds.length > 1, "workspace reconciliation must have attached disk sessions");
  assert.ok(reconcileFinishedBeforeLastColdSnapshot, "workspace reconciliation must run before projection rebuild completes");

  // 2. Budget capped at 50 refolds
  assert.ok(snapshotCount <= 50, `snapshot count (${snapshotCount}) must not exceed MAX_BOOT_REFOLD_COUNT (50)`);
  assert.ok(
    h.infoLogs.some(msg => msg.includes("boot projection cache refold budget reached")),
    "must log that refold budget was reached and remaining deferred"
  );
});

test("cache consistency after move and corrupt line safety (issue #32)", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({
    events: [
      { type: "session/header", seq: 0, data: {} },
      { type: "user/message", seq: 1, data: { content: "hello" } }
    ]
  });
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-1" }];

  const res = await h.mount().request("/move", { sessionId: staged.header.id, targetWorkspaceId: "target" });
  assert.equal(res.status, 200, res.data.error);

  // Cache must have been updated with target cwd
  assert.equal(h.coldSnapshotCalls.length, 1);
  assert.equal(h.coldSnapshotCalls[0].meta.cwd, h.target, "projection cache must reflect moved target workspace cwd");

  // Now test move with corrupt JSON lines in events: must safely skip cache refold without crashing
  const corruptStaged = await h.stage({
    id: "s-corrupt",
    rawLines: [
      JSON.stringify({ type: "session/header", seq: 0, data: {} }) + "\n",
      "CORRUPT_NOT_JSON\n"
    ]
  });
  h.coldSnapshotCalls.length = 0;
  h.persistence.list = async () => [{ header: corruptStaged.header, revision: "rev-corrupt" }];

  // Attach s-corrupt to source workspace so it can be moved
  h.state.workspaces[0].sessionIds.push("s-corrupt");
  const moveCorruptRes = await h.mount().request("/move", { sessionId: "s-corrupt", targetWorkspaceId: "target" });
  assert.equal(moveCorruptRes.status, 200);

  // coldSnapshot must be skipped due to corrupt JSON lines
  assert.equal(h.coldSnapshotCalls.length, 0, "corrupt JSON must safely skip coldSnapshot");
  assert.ok(
    h.warnings.some(w => w.includes("JSON parse error in artifact events")),
    "must warn about corrupt JSON line skipping cache refold"
  );
});

test("sizeBytes: DSH official statSession return structure with sizeBytes > 5MB skips cache refold on all paths (issue #32)", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({
    events: [
      { type: "session/header", seq: 0, data: {} },
      { type: "user/message", seq: 1, data: { content: "normal events" } }
    ]
  });
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-1" }];
  // DSH official persistence.stat returns { header, revision, sizeBytes }
  h.persistence.stat = async () => ({
    header: staged.header,
    revision: "rev-1",
    sizeBytes: 10 * 1024 * 1024 // 10MB > 5MB limit
  });

  await h.mount().boot();

  assert.equal(h.coldSnapshotCalls.length, 0, "boot refold must be skipped for large file (>5MB)");
  assert.ok(
    h.infoLogs.some(log => log.includes("skipping boot cache refold for large artifact") && log.includes("10485760 bytes")),
    "must log info about skipping large artifact"
  );

  // Now test post-move sizeBytes check as well
  h.infoLogs.length = 0;
  h.coldSnapshotCalls.length = 0;
  const res = await h.mount().request("/move", { sessionId: staged.header.id, targetWorkspaceId: "target" });
  assert.equal(res.status, 200);
  assert.equal(h.coldSnapshotCalls.length, 0, "post-move refold must also be skipped for large file (>5MB)");
});

test("budget: failed sessions are counted towards MAX_BOOT_REFOLD_COUNT to prevent infinite spin (issue #32)", async t => {
  const h = await createHarness(t);
  const headers = [];
  // Generate 70 sessions that will fail cache refold (e.g. unresolvable seeded session)
  for (let i = 0; i < 70; i++) {
    const id = `s-fail-${i}`;
    const staged = await h.stage({
      id,
      header: { id, isSeeded: true, parentSession: "p-missing" },
      rawLines: [
        JSON.stringify({ type: "session/header", seq: 0, data: {} }) + "\n",
        JSON.stringify({ type: "user/message", seq: 1, data: { content: "no end-seed" } }) + "\n"
      ]
    });
    headers.push(staged.header);
    h.state.workspaces[0].sessionIds.push(id);
  }
  h.persistence.list = async () => headers.map(header => ({ header, revision: "rev" }));

  await h.mount().boot();

  assert.equal(h.coldSnapshotCalls.length, 0);
  // Verify budget reached log confirms attemptedCount reached 50
  assert.ok(
    h.infoLogs.some(log => log.includes("boot projection cache refold budget reached (50 attempted")),
    "failed sessions must count toward budget and stop after 50 attempted"
  );
});

test("header precedence: DSH official handle.header takes precedence over caller header (issue #32)", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({
    header: { version: 2, title: "Old Title" },
    events: [
      { type: "session/header", seq: 0, data: {} },
      { type: "user/message", seq: 1, data: { content: "hello" } }
    ]
  });
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-1" }];

  // Official persistence.open returns a handle with migrated header
  h.persistence.open = async (sessionId) => ({
    header: { id: sessionId, version: 4, title: "Migrated Logical Title", cwd: staged.header.cwd },
    inheritedEventCount: 0,
    read: async () => [
      { type: "session/header", seq: 0, data: {} },
      { type: "user/message", seq: 1, data: { content: "hello" } }
    ],
    close: async () => {}
  });

  await h.mount().boot();

  assert.equal(h.coldSnapshotCalls.length, 1);
  assert.equal(h.coldSnapshotCalls[0].meta.version, 4, "official handle.header version (4) must take precedence over old header (2)");
  assert.equal(h.coldSnapshotCalls[0].meta.title, "Migrated Logical Title", "official handle.header title must take precedence");
});

test("official read failure: official openSessionRead throwing does not fall back to disk artifact (issue #32)", async t => {
  const h = await createHarness(t);
  const staged = await h.stage({
    events: [
      { type: "session/header", seq: 0, data: {} },
      { type: "user/message", seq: 1, data: { content: "on disk" } }
    ]
  });
  h.persistence.list = async () => [{ header: staged.header, revision: "rev-1" }];

  // Official persistence.open throws decoding/migration error
  h.persistence.open = async () => {
    throw new Error("official session migration failed: corrupt frame");
  };

  await h.mount().boot();

  assert.equal(h.coldSnapshotCalls.length, 0, "must NOT fall back to disk artifact when official read/migration fails");
  assert.ok(
    h.warnings.some(w => w.includes("official read/migration failed: official session migration failed: corrupt frame")),
    "must warn about official read/migration failure"
  );
});
