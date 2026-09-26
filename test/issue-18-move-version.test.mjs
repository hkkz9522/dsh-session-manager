/**
 * Regression coverage for issue #18:
 *   "[Bug] dsh-session-manager 的 move 功能写坏了文件"
 *
 * Pre-fix symptom: moveSession only mutated header.cwd before re-encoding the
 * artifact, leaving header.version at the OLD value (0, 2 or 3). The host
 * always asks `persistence.locate(newHeader)` for the target path, and that
 * helper returns the latest `SESSION_FORMAT_VERSION` filename regardless of
 * `meta.version`. So a v0 source moved to a v4 path produced
 * `session.v4.jsonl.zstd` whose header still claimed `version: 0`. On the
 * next DSH startup, `JsonlSessionPersistence.listArtifacts` threw
 * `session generation filename identifies v4, but its header identifies v0`
 * (a plain `Error`, not caught by `listArtifacts`), `persistence.list()`
 * crashed, the workspace registry never finished booting, and 6 host
 * plugins went pending.
 *
 * Fix: derive the generation from the target filename chosen by
 * `persistence.locate()` and stamp it onto `newHeader.version` before
 * encoding, so the on-disk header always agrees with the filename.
 *
 * The test exercises the real production HTTP handler (not a copy of
 * `moveSession`), stages a v0 session at the legacy `session.jsonl.zstd`
 * path that `ARTIFACT_NAMES` knows how to read, mocks `persistence.locate`
 * to behave like the DSH 0.1.7 backend (always returns the latest
 * generation), and asserts that the moved artifact at the v4 path carries
 * a `version: 4` header.
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { moveSession } from "./issue-8-repro/_move.mjs";

function encodeSegment(id) {
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

const SESSION_FORMAT_VERSION = 4;
const LATEST_ARTIFACT = `session.v${SESSION_FORMAT_VERSION}.jsonl.zstd`;
const LEGACY_ARTIFACT = "session.jsonl.zstd";

async function stageV0Session(home, sourceWorkspace) {
  const sessionId = "sess-issue18-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
  // Use the legacy v0 filename (`session.jsonl.zstd`) so the plugin's
  // ARTIFACT_NAMES iteration in `readSessionArtifact` discovers the file on
  // disk; the on-disk header explicitly claims v0 to reproduce the bug.
  const initialHeader = {
    type: "session",
    id: sessionId,
    cwd: sourceWorkspace,
    createdAt: Date.now(),
    version: 0,
    isSeeded: true,
    delegationDepth: 0,
    origin: "user",
    agentPreset: "standard",
  };
  const projectDir = encodeSegment(sourceWorkspace);
  const sessionDir = join(home, "sessions", projectDir, encodeSegment(sessionId));
  await mkdir(sessionDir, { recursive: true });
  const sourcePath = join(sessionDir, LEGACY_ARTIFACT);
  const headerLine = JSON.stringify(initialHeader);
  const rest = [
    JSON.stringify({ type: "session/header", seq: 0, time: Date.now(), data: {} }),
    JSON.stringify({ type: "user/message", seq: 1, time: Date.now(), data: { content: "hi", surfaceOp: { kind: "append", seq: 1 } } }),
  ].join("\n") + "\n";
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from(headerLine + "\n", "utf8")),
    zstdCompressSync(Buffer.from(rest, "utf8")),
  ]);
  await writeFile(sourcePath, bytes);
  return { sessionId, initialHeader, sourcePath };
}

function makeWriteHandle(home, sessionId, header) {
  return {
    id: sessionId, access: "write",
    header: { ...header },
    state: { materialized: true, cursor: 2, inheritedEventCount: 0 },
    async appendBatch() { /* not exercised by this test */ },
    async close() { /* not exercised by this test */ },
  };
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
  // Mirror DSH 0.1.7+ behaviour: persistence.locate() always returns the
  // SESSION_FORMAT_VERSION path, regardless of meta.version.
  function locatePath(meta) {
    return { kind: "jsonl", path: join(home, "sessions", encodeSegment(meta.cwd), encodeSegment(meta.id), LATEST_ARTIFACT) };
  }
  const persistence = {
    coordinator: undefined,
    async list() { return [{ header: { ...initialHeader }, revision: "mock-rev" }]; },
    locate: locatePath,
    tracker,
  };
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
    emit() {},
    on() {},
    effect() {},
  };
  const writer = makeWriteHandle(home, sessionId, initialHeader);
  tracker.writers.set(sessionId, writer);
  return { ctx, tracker, liveSession, locatePath, writer };
}

async function readHeaderVersion(path) {
  const bytes = await readFile(path);
  const decoded = zstdDecompressSync(bytes).toString("utf8");
  const firstLine = decoded.split("\n")[0];
  return JSON.parse(firstLine).version;
}

test("issue #18 regression: moveSession stamps the new filename's generation onto header.version", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "dsh-issue18-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const sourceWorkspace = join(home, "src");
  const targetWorkspace = join(home, "tgt");
  await mkdir(sourceWorkspace, { recursive: true });
  await mkdir(targetWorkspace, { recursive: true });

  const { sessionId, initialHeader, sourcePath } = await stageV0Session(home, sourceWorkspace);
  const { ctx } = buildCtx(home, sourceWorkspace, targetWorkspace, sessionId, initialHeader);

  // Pre-move sanity: source exists, has the v0 header we staged.
  assert.equal(await stat(sourcePath).then(() => true).catch(() => false), true);
  assert.equal(await readHeaderVersion(sourcePath), 0);

  const result = await moveSession(ctx, sessionId, "ws-target");
  assert.equal(result.ok, true);
  assert.equal(result.moved, true);

  // Source must be gone.
  assert.equal(await stat(sourcePath).then(() => true).catch(() => false), false);

  // Target file lives at the v4 path persistence.locate() picked.
  const targetPath = join(home, "sessions", encodeSegment(targetWorkspace), encodeSegment(sessionId), LATEST_ARTIFACT);
  assert.equal(await stat(targetPath).then(() => true).catch(() => false), true);

  // The header version must match the filename generation. Without the fix
  // this would still be 0 and DSH's JsonlSessionPersistence.listArtifacts
  // would reject the file on the next startup.
  const movedVersion = await readHeaderVersion(targetPath);
  assert.equal(movedVersion, SESSION_FORMAT_VERSION, `expected moved header.version=${SESSION_FORMAT_VERSION}, got ${movedVersion}`);
});

test("issue #18 regression guard: without the version stamp, the moved artifact would keep its old header.version", async (t) => {
  // Sanity guard mirroring the issue-8 pattern: simulate the pre-fix code
  // path (header spread + cwd override, no version stamp) against the same
  // staging harness, and assert it produces a v4 file with a v0 header --
  // i.e. exactly the broken shape that crashes DSH's startup scan.
  const home = await mkdtemp(join(tmpdir(), "dsh-issue18-guard-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const sourceWorkspace = join(home, "src");
  const targetWorkspace = join(home, "tgt");
  await mkdir(sourceWorkspace, { recursive: true });
  await mkdir(targetWorkspace, { recursive: true });

  const { sessionId, initialHeader, sourcePath } = await stageV0Session(home, sourceWorkspace);

  // Re-encode the file at the v4 path exactly like the pre-fix code did:
  // only mutate cwd, never stamp version.
  const brokenHeader = { ...initialHeader, cwd: targetWorkspace };
  const targetPath = join(home, "sessions", encodeSegment(targetWorkspace), encodeSegment(sessionId), LATEST_ARTIFACT);
  await mkdir(dirname(targetPath), { recursive: true });
  const bytes = Buffer.concat([
    zstdCompressSync(Buffer.from(JSON.stringify(brokenHeader) + "\n", "utf8")),
    zstdCompressSync(Buffer.from("noop\n", "utf8")),
  ]);
  await writeFile(targetPath, bytes);

  // The broken shape: v4 filename, v0 header.
  assert.equal(await stat(targetPath).then(() => true).catch(() => false), true);
  const brokenVersion = await readHeaderVersion(targetPath);
  assert.equal(brokenVersion, 0, "guard: pre-fix shape leaves header.version at the OLD value");

  // For symmetry, also confirm the source file is still v0 on disk so the
  // test isn't accidentally relying on a staging mistake.
  assert.equal(await stat(sourcePath).then(() => true).catch(() => false), true);
  assert.equal(await readHeaderVersion(sourcePath), 0);
});
