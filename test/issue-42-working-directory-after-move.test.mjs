/**
 * Regression coverage for issue #42:
 *   "[Bug]: `移动至工作区` 后会话的实际工作目录未更新（workingDirectory 行仍是旧路径）,
 *    cwd 与工作区不一致"
 *
 * Pre-fix symptom: a cross-workspace move rewrote the artifact header's `cwd`
 * and the workspace accounting, but the session's `workingDirectory`
 * projection row kept the pre-move directory. DSH folds that projection from
 * the log: the unit initializes from `header.cwd` only while it has no
 * checkpoint, and both the projection cache and every
 * `working-directory/change` event supersede it. A live session's projection
 * was therefore never re-initialized, and the cache then checkpointed the
 * stale state under the NEW header identity, so a rebuild could not recover
 * the target either.
 *
 * The fix records the change the move implies: live sessions go through the
 * host's `workingDirectory` service (the same path a user `cd` takes), or get
 * the equivalent event appended directly when the host exposes no service or
 * when the agent fiber is inactive; a cold session's log is extended only when
 * it already carries a `working-directory/change` event (otherwise the rewritten
 * `header.cwd` alone initializes the projection).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { decompressAllZstdFrames } from "../lib/compat/zstd-frames.js";
import { encodeFsSessionSegment, encodeProjectSegment } from "../lib/session-files.js";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

const SESSION_ID = "session-issue42";
const ARTIFACT = "session.v4.jsonl.zstd";
const CREATED_AT = 1792482677664;

const frame = (text) => zstdCompressSync(Buffer.from(text, "utf8"));

async function decodeArtifact(path) {
  const bytes = await fs.readFile(path);
  const text = path.endsWith(".zstd")
    ? (await decompressAllZstdFrames(bytes)).content.toString("utf8")
    : bytes.toString("utf8");
  const lines = text.split("\n").filter((line) => line.length > 0);
  return { header: JSON.parse(lines[0]), events: lines.slice(1).map((line) => JSON.parse(line)) };
}

async function createHarness(t, { live = false, withAgent = true, hasService = true, rejectSet = false, fiberInactive = false, events, rawLines } = {}) {
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-issue42-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(home));
    assert.ok(rel.startsWith("dsh-issue42-test-") && !rel.includes(sep));
    await fs.rm(home, { recursive: true, force: true });
  });

  const source = join(home, "source-workspace");
  const target = join(home, "target-workspace");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.mkdir(join(home, "sessions"), { recursive: true });

  const header = {
    type: "session",
    id: SESSION_ID,
    version: 4,
    createdAt: CREATED_AT,
    cwd: source,
    isSeeded: false,
    agentPreset: "standard"
  };
  const stagedEvents = events ?? [
    { type: "permission/preset", seq: 0, time: CREATED_AT + 1, data: { preset: "workspace-write" } },
    { type: "user/message", seq: 1, time: CREATED_AT + 2, data: { content: "hi" } }
  ];
  const body = typeof rawLines === "function"
    ? rawLines(target).join("")
    : (rawLines !== undefined
      ? rawLines.join("")
      : stagedEvents.map((event) => JSON.stringify(event) + "\n").join(""));

  const artifactPath = (cwd) => join(home, "sessions", encodeProjectSegment(cwd), encodeFsSessionSegment(SESSION_ID), ARTIFACT);
  const sourcePath = artifactPath(source);
  const targetPath = artifactPath(target);
  await fs.mkdir(dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, Buffer.concat([frame(JSON.stringify(header) + "\n"), frame(body)]));

  const registryState = {
    workspaces: [
      { id: "ws-source", sessionIds: [SESSION_ID] },
      { id: "ws-target", sessionIds: [] }
    ]
  };
  const entities = ["ws-source", "ws-target"].map((id) => ({
    id,
    title: id,
    path: id === "ws-source" ? source : target,
    get record() { return registryState.workspaces.find((workspace) => workspace.id === id); },
    get sessionIds() { return this.record.sessionIds; },
    async attachSession(sessionId) {
      if (!this.record.sessionIds.includes(sessionId)) this.record.sessionIds.push(sessionId);
    },
    async detachSession(sessionId) {
      this.record.sessionIds = this.record.sessionIds.filter((candidate) => candidate !== sessionId);
    }
  }));

  const registry = {
    list: () => entities,
    requireState: () => ({ archivedSessionIds: [] }),
    setState: async () => {},
    enqueueOperation: async (operation) => operation(),
    headers: new Map([[SESSION_ID, { ...header }]]),
    sessionPaths: new Map([[SESSION_ID, source]]),
    invalidSessionPaths: new Map()
  };

  const writer = {
    id: SESSION_ID,
    access: "write",
    header: { ...header },
    state: { materialized: true, cursor: stagedEvents.length, inheritedEventCount: 0 },
    async appendBatch() {},
    async close() {}
  };
  const tracker = { writers: new Map(live ? [[SESSION_ID, writer]] : []) };

  const liveSession = live ? {
    id: SESSION_ID,
    header: { ...header },
    events: [...stagedEvents],
    append(type, data) {
      const event = { type, seq: this.events.length, time: Date.now(), data };
      this.events.push(event);
      return event;
    },
    async flush() {}
  } : undefined;

  const agent = { session: liveSession, injected: [] };
  const workingDirectoryCalls = [];
  const workingDirectory = {
    async set(receivedAgent, path) {
      workingDirectoryCalls.push({ agent: receivedAgent, path });
      if (rejectSet) throw new Error("working-directory: directory does not exist: " + JSON.stringify(path));
      if (fiberInactive) {
        const err = new Error("cannot call set on inactive fiber");
        err.code = "INACTIVE_EFFECT";
        throw err;
      }
      liveSession.append("working-directory/change", { cwd: path });
      return path;
    }
  };

  const cacheCalls = [];
  const projectionCache = {
    cachedSnapshot: () => undefined,
    async coldSnapshot(meta, count, coldEvents) {
      cacheCalls.push({ kind: "cold", meta, count, events: coldEvents });
    },
    async write(session) {
      cacheCalls.push({ kind: "write", session });
    }
  };

  const persistence = {
    list: async () => [{ header: { ...header }, revision: "rev-1" }],
    locate: (meta) => ({ path: artifactPath(meta.cwd) }),
    tracker
  };

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    dshHomePath: (segment) => join(home, segment),
    sessionProjectionCache: projectionCache,
    workingDirectory: hasService ? workingDirectory : undefined
  };

  const warnings = [];
  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: (id) => (id === SESSION_ID ? liveSession : undefined), list: () => (liveSession ? [liveSession] : []), flush: async () => {} },
    agents: { get: (id) => (live && withAgent && id === SESSION_ID ? agent : undefined) },
    get: (name) => services[name],
    emit: () => {},
    logger: { info: () => {}, warn: (message) => warnings.push(message), error: (message) => warnings.push(message) }
  };

  return {
    home,
    source,
    target,
    header,
    stagedEvents,
    sourcePath,
    targetPath,
    liveSession,
    agent,
    writer,
    registryState,
    workingDirectoryCalls,
    cacheCalls,
    warnings,
    mount: () => mountPlugin(ctx)
  };
}

test("live move re-homes the working directory through the host service (issue #42)", async (t) => {
  const h = await createHarness(t, { live: true });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200, response.data.error);
  const result = response.data.result;

  assert.equal(result.moved, true);
  assert.equal(result.workingDirectory, "synced", "the move must report the working-directory sync");
  assert.equal(result.restartRequired, false);

  assert.equal(h.workingDirectoryCalls.length, 1, "the host cwd-change service must be used exactly once");
  assert.equal(h.workingDirectoryCalls[0].agent, h.agent);
  assert.equal(h.workingDirectoryCalls[0].path, h.target);

  const change = h.liveSession.events.find((event) => event.type === "working-directory/change");
  assert.ok(change, "the live session must record the change event");
  assert.equal(change.data.cwd, h.target);

  const writes = h.cacheCalls.filter((call) => call.kind === "write");
  assert.equal(writes.length, 1, "the post-move path must checkpoint the live projection");
  assert.ok(
    h.cacheCalls.indexOf(writes[0]) > h.cacheCalls.findIndex((call) => call.kind === "cold"),
    "the live checkpoint must land after the post-move refold"
  );
});

test("live move without the host service appends the change event itself (issue #42)", async (t) => {
  const h = await createHarness(t, { live: true, withAgent: false, hasService: false });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200, response.data.error);
  const result = response.data.result;

  assert.equal(result.workingDirectory, "recorded");
  assert.equal(result.restartRequired, false);

  const change = h.liveSession.events.find((event) => event.type === "working-directory/change");
  assert.ok(change, "the plugin must append the equivalent event directly");
  assert.equal(change.data.cwd, h.target);
  assert.equal(change.seq, h.liveSession.events.length - 1, "the appended event must continue the log");
});

test("live move with inactive agent fiber falls back to session.append (issue #42)", async (t) => {
  const h = await createHarness(t, { live: true, withAgent: true, hasService: true, fiberInactive: true });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200, response.data.error);
  const result = response.data.result;

  assert.equal(result.workingDirectory, "recorded");
  assert.equal(result.restartRequired, false);

  const change = h.liveSession.events.find((event) => event.type === "working-directory/change");
  assert.ok(change, "must fall back to appending change event when agent fiber is inactive");
  assert.equal(change.data.cwd, h.target);
});

test("a host that rejects the working-directory change does not fail the move (issue #42)", async (t) => {
  const h = await createHarness(t, { live: true, rejectSet: true });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200, response.data.error);
  const result = response.data.result;

  assert.equal(result.moved, true, "the artifact move already succeeded and must not be rolled back");
  assert.equal(result.workingDirectory, "restart-required");
  assert.equal(result.restartRequired, true);
  assert.ok(h.warnings.some((message) => message.includes("host rejected the working-directory change")));

  const moved = await decodeArtifact(h.targetPath);
  assert.equal(moved.header.cwd, h.target, "the artifact header must still point at the target workspace");
});

test("cold move with a stale change event re-homes the log body (issue #42)", async (t) => {
  const h = await createHarness(t, {
    live: false,
    events: [
      { type: "permission/preset", seq: 0, time: CREATED_AT + 1, data: { preset: "workspace-write" } },
      { type: "working-directory/change", seq: 1, time: CREATED_AT + 2, data: { cwd: join("C:", "Users", "someone", ".sprite", "profiles", "desktop") } }
    ]
  });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200, response.data.error);
  const result = response.data.result;

  assert.equal(result.moved, true);
  assert.equal(result.workingDirectory, "recorded");
  assert.equal(result.restartRequired, false);

  const moved = await decodeArtifact(h.targetPath);
  assert.equal(moved.header.cwd, h.target);
  const changes = moved.events.filter((event) => event.type === "working-directory/change");
  assert.equal(changes.length, 2, "the log must gain one authoritative change event");
  assert.equal(changes.at(-1).data.cwd, h.target);
  assert.equal(changes.at(-1).seq, h.stagedEvents.length, "the appended event must continue the log");
  assert.deepEqual(
    moved.events.map((event) => event.seq),
    moved.events.map((_event, index) => index),
    "the log must stay a contiguous logical event sequence"
  );
});

test("cold move without a prior change event only rewrites the header (issue #42)", async (t) => {
  const h = await createHarness(t, { live: false });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200, response.data.error);
  const result = response.data.result;

  assert.equal(result.workingDirectory, "header-only");
  assert.equal(result.restartRequired, false);

  const moved = await decodeArtifact(h.targetPath);
  assert.equal(moved.header.cwd, h.target);
  assert.equal(moved.events.some((event) => event.type === "working-directory/change"), false);
  assert.deepEqual(moved.events, h.stagedEvents, "the event log must be untouched");
});

test("cold move for packed log without working-directory/change succeeds via header-only (issue #42)", async (t) => {
  const h = await createHarness(t, {
    live: false,
    rawLines: [
      JSON.stringify({ type: "permission/preset", seq: 0, time: CREATED_AT + 1, data: { preset: "workspace-write" } }) + "\n",
      JSON.stringify({ type: "tool-call-chunks", seq0: 1, chunks: ["a", "b"] }) + "\n"
    ]
  });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200, response.data.error);
  const result = response.data.result;

  assert.equal(result.moved, true, "the move itself must succeed");
  assert.equal(result.workingDirectory, "header-only");
  assert.equal(result.restartRequired, false, "no restart needed when no prior working-directory event overrides header");

  const moved = await decodeArtifact(h.targetPath);
  assert.equal(moved.header.cwd, h.target);
  assert.equal(moved.events.length, 2, "the packed log events are left untouched");
});

test("cold move for packed log with conflicting working-directory/change safely refuses move (issue #42)", async (t) => {
  const h = await createHarness(t, {
    live: false,
    rawLines: [
      JSON.stringify({ type: "permission/preset", seq: 0, time: CREATED_AT + 1, data: { preset: "workspace-write" } }) + "\n",
      // Past cd to a custom directory
      JSON.stringify({ type: "working-directory/change", seq: 1, time: CREATED_AT + 2, data: { cwd: "/tmp/custom-old-dir" } }) + "\n",
      // Physical packed row preventing direct safe append
      JSON.stringify({ type: "tool-call-chunks", seq0: 2, chunks: ["chunk-data"] }) + "\n"
    ]
  });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  // Must be refused with 409 conflict and clear code
  assert.equal(response.status, 409);
  assert.equal(response.data.ok, false);
  assert.equal(response.data.code, "working-directory-sync-unsafe");
  assert.ok(response.data.error.includes("压缩行") || response.data.error.includes("无法安全同步"));

  // Original artifact must remain completely untouched at source path
  const source = await decodeArtifact(h.sourcePath);
  assert.equal(source.header.cwd, h.source);
  assert.equal(source.events.length, 3);

  // Target path must NOT exist
  let targetExists = false;
  try {
    await lstat(h.targetPath);
    targetExists = true;
  } catch {}
  assert.equal(targetExists, false, "target file must not be created on refusal");
});

test("cold move for packed log with working-directory/change already matching target succeeds (issue #42)", async (t) => {
  const h = await createHarness(t, {
    live: false,
    rawLines: (target) => [
      JSON.stringify({ type: "permission/preset", seq: 0, time: CREATED_AT + 1, data: { preset: "workspace-write" } }) + "\n",
      JSON.stringify({ type: "working-directory/change", seq: 1, time: CREATED_AT + 2, data: { cwd: target } }) + "\n",
      JSON.stringify({ type: "tool-call-chunks", seq0: 2, chunks: ["chunk-data"] }) + "\n"
    ]
  });

  const response = await h.mount().request("/move", { sessionId: SESSION_ID, targetWorkspaceId: "ws-target" });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.moved, true);
  assert.equal(response.data.result.workingDirectory, "already-target");
  assert.equal(response.data.result.restartRequired, false);

  const moved = await decodeArtifact(h.targetPath);
  assert.equal(moved.header.cwd, h.target);
  assert.equal(moved.events.length, 3);
});

