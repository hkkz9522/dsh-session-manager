/**
 * Coverage for the /session-manager/api/batch endpoint.
 *
 * The batch route dispatches one HTTP request across N session ids, reusing
 * the same per-id helpers the single-action endpoints use, with per-item
 * success / fail / skipped accounting. These tests exercise the dispatch
 * table directly via the shared mountPlugin harness so we hit the real
 * route handler without duplicating the implementation.
 */
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
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-batch-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(home));
    assert.ok(rel.startsWith("dsh-batch-test-") && !rel.includes(sep));
    await fs.rm(home, { recursive: true, force: true });
  });
  await fs.mkdir(join(home, "sessions"));
  let state = { archivedSessionIds: [], workspaces: [{ id: "ws1", sessionIds: ["s1", "s2", "s3"] }] };
  let writes = 0;
  const entity = {
    id: "ws1", title: "ws1", path: join(home, "ws1"),
    get record() { return state.workspaces.find(w => w.id === "ws1"); },
    get sessionIds() { return this.record.sessionIds; },
    async attachSession(id) { if (!this.sessionIds.includes(id)) this.record.sessionIds.push(id); },
    async detachSession(id) { this.record.sessionIds = this.sessionIds.filter(x => x !== id); },
  };
  const registry = {
    list: () => [entity],
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
    agentPresets: { list: async () => [{ id: "p1" }, { id: "p2" }] },
    sessionProjectionCache: { coldSnapshot: async () => {} },
  };
  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: id => live.get(id), flush: async () => {} },
    agents: { get: () => undefined },
    workspaces: { archiveSession: async (sessionId) => { state = { ...state, archivedSessionIds: Array.from(new Set([...state.archivedSessionIds, sessionId])) }; } },
    get: name => services[name], emit: (...args) => emitted.push(args),
    logger: { info() {}, warn: message => warnings.push(message) },
  };
  function artifactPath(header, filename = "session.v3.jsonl.zstd") {
    return join(home, "sessions", encodeSessionSegment(header.cwd), encodeSessionSegment(header.id), filename);
  }
  async function stage({ id, cwd = join(home, "ws1"), filename = "session.v3.jsonl.zstd", events = [], header: overrides = {} } = {}) {
    const header = { id, cwd, version: 3, agentPreset: "p1", origin: "user", blank: false, ...overrides };
    const path = artifactPath(header, filename);
    const lines = events.map(event => JSON.stringify(event) + "\n");
    const content = JSON.stringify(header) + "\n" + lines.join("");
    const payload = filename.endsWith(".zstd")
      ? Buffer.concat([frame(JSON.stringify(header) + "\n"), ...lines.map(frame)])
      : Buffer.from(content);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, payload);
    return { header, path, bytes: payload, content };
  }
  return { home, stage, artifactPath, registry, persistence, services, ctx, live, warnings, emitted,
    get state() { return state; }, get writes() { return writes; }, mount: () => mountPlugin(ctx) };
}

test("/batch: archive dispatches each id and reports per-item success", async t => {
  const f = await fixture(t);
  for (const id of ["s1", "s2", "s3"]) await f.stage({ id });
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "archive", sessionIds: ["s1", "s2", "s3"] });
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.result.summary.total, 3);
  assert.equal(response.data.result.summary.success, 3);
  assert.equal(response.data.result.summary.failed, 0);
  assert.equal(response.data.result.summary.skipped, 0);
  for (const item of response.data.result.items) {
    assert.equal(item.status, "success");
    assert.equal(typeof item.sessionId, "string");
  }
  assert.deepEqual(f.state.archivedSessionIds.sort(), ["s1", "s2", "s3"]);
});

test("/batch: unarchive restores previously archived ids", async t => {
  const f = await fixture(t);
  for (const id of ["s1", "s2"]) await f.stage({ id });
  f.state.archivedSessionIds = ["s1", "s2"];
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "unarchive", sessionIds: ["s1", "s2"] });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.summary.success, 2);
  assert.deepEqual(f.state.archivedSessionIds, []);
});

test("/batch: move reports per-item failure when targetWorkspaceId is missing or unknown", async t => {
  const f = await fixture(t);
  for (const id of ["s1", "s2"]) await f.stage({ id });
  const plugin = f.mount();
  // Per-item validation lives in runBatchAction, so the route always returns
  // 200 with per-item status, even when every item fails for the same reason.
  for (const payload of [{}, { targetWorkspaceId: "no-such-ws" }]) {
    const response = await plugin.request("/batch", { action: "move", sessionIds: ["s1", "s2"], payload });
    assert.equal(response.status, 200);
    assert.equal(response.data.result.summary.failed, 2);
    assert.equal(response.data.result.summary.success, 0);
    for (const item of response.data.result.items) {
      assert.equal(item.status, "failed");
      // empty payload -> bad-request (per-item validation); unknown ws -> workspace-not-found
      assert.ok(item.code === "bad-request" || item.code === "workspace-not-found", "got " + item.code);
      assert.match(item.error, /targetWorkspaceId|工作区|workspace/);
    }
  }
});

test("/batch: empty sessionIds returns 400 bad-request", async t => {
  const f = await fixture(t);
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "archive", sessionIds: [] });
  assert.equal(response.status, 400);
  assert.equal(response.data.code, "bad-request");
});

test("/batch: more than 200 ids returns 400 batch-too-large", async t => {
  const f = await fixture(t);
  const plugin = f.mount();
  const tooMany = Array.from({ length: 201 }, (_, i) => "s" + i);
  const response = await plugin.request("/batch", { action: "archive", sessionIds: tooMany });
  assert.equal(response.status, 400);
  assert.equal(response.data.code, "batch-too-large");
});

test("/batch: unknown action returns 400 bad-request", async t => {
  const f = await fixture(t);
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "explode", sessionIds: ["s1"] });
  assert.equal(response.status, 400);
  assert.equal(response.data.code, "bad-request");
});

test("/batch: deletes one session per id (idempotent: missing id counts as success)", async t => {
  const f = await fixture(t);
  await f.stage({ id: "s1" });
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "delete", sessionIds: ["s1", "missing"] });
  assert.equal(response.status, 200);
  // deleteSession resolves gracefully when the id is unknown; we surface it as
  // success per the per-id wrapper contract (it is idempotent).
  assert.equal(response.data.result.summary.success, 2);
});


test("/batch: favorite dispatches to the annotation store via runBatchAction(annotations)", async t => {
  // Regression: runBatchAction used to be called without the
  // \`annotations\` parameter; for any annotation-affecting action
  // (favorite / review / set-priority / add-tags / remove-tags) the
  // server then threw \`annotations is not a function\` because
  // \`runBatchAction\` destructures the function from its parameter
  // object. Single-session favorites worked because that route calls
  // \`annotations()\` directly via closure.
  const f = await fixture(t);
  for (const id of ["s1", "s2"]) await f.stage({ id });
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "favorite", sessionIds: ["s1", "s2"] });
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.result.summary.success, 2);
  assert.equal(response.data.result.summary.failed, 0);
  for (const item of response.data.result.items) {
    assert.equal(item.status, "success", item.sessionId + " -> " + JSON.stringify(item));
  }
});

test("/batch: set-priority validates payload per item and reports bad-request", async t => {
  const f = await fixture(t);
  for (const id of ["s1", "s2"]) await f.stage({ id });
  const plugin = f.mount();
  // priority 99 is out of range; each item must fail with bad-request
  // rather than crash the dispatch loop.
  const response = await plugin.request("/batch", {
    action: "set-priority",
    sessionIds: ["s1", "s2"],
    payload: { priority: 99 },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.summary.failed, 2);
  for (const item of response.data.result.items) {
    assert.equal(item.status, "failed");
    assert.equal(item.code, "bad-request");
  }
});


test("/batch: add-tags dispatches to the annotation store with the same payload shape as single-session", async t => {
  // Regression companion for the favorite case: add-tags is the most
  // common user action and used to throw "annotations is not a function"
  // because runBatchAction(annotations) wasn't wired up. Single-session
  // \`/annotations\` worked because that route calls annotations()
  // directly via closure.
  const f = await fixture(t);
  for (const id of ["s1", "s2"]) await f.stage({ id });
  const plugin = f.mount();
  const response = await plugin.request("/batch", {
    action: "add-tags",
    sessionIds: ["s1", "s2"],
    payload: { tags: ["排障", "方案"] },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.ok, true);
  assert.equal(response.data.result.summary.success, 2);
  assert.equal(response.data.result.summary.failed, 0);
  for (const item of response.data.result.items) {
    assert.equal(item.status, "success");
  }
});

test("/batch: remove-tags accepts an empty tags array and reports success", async t => {
  // Bulk "Clear tags" sends { tags: [] } to mean "remove every tag".
  // runBatchAction must not reject this -- it must round-trip through
  // the annotation store's normal clear-tags path.
  const f = await fixture(t);
  for (const id of ["s1"]) await f.stage({ id });
  const plugin = f.mount();
  const response = await plugin.request("/batch", {
    action: "remove-tags",
    sessionIds: ["s1"],
    payload: { tags: [] },
  });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.summary.success, 1);
});


test("/batch: archive persists the id in workspaceRegistry.archivedSessionIds", async t => {
  // Regression: bulk archive used to call ctx.workspaces.archiveSession
  // directly from the server-side dispatch, which Cordis rejects with
  // "cannot get property 'workspaces' without inject". The host now
  // mirrors the unarchiveSession helper and updates the registry state
  // atomically -- the same path the per-row button would land on.
  const f = await fixture(t);
  for (const id of ["s1", "s2"]) await f.stage({ id });
  const plugin = f.mount();
  const response = await plugin.request("/batch", { action: "archive", sessionIds: ["s1", "s2"] });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.summary.success, 2);
  assert.deepEqual(f.state.archivedSessionIds.sort(), ["s1", "s2"]);
});

test("/batch: unfavorite / unreview flip the annotation boolean off", async t => {
  // Regression: the original BATCH_ACTIONS set only listed "favorite"
  // and "review", so unfavorite / unreview were rejected with
  // "action 不支持". Both are now first-class annotation actions that
  // map to { favorite: false } / { reviewLater: false }.
  const f = await fixture(t);
  for (const id of ["s1"]) await f.stage({ id });
  const plugin = f.mount();
  for (const action of ["unfavorite", "unreview"]) {
    const response = await plugin.request("/batch", {
      action,
      sessionIds: ["s1"],
      payload: {},
    });
    assert.equal(response.status, 200, action + " got " + response.status);
    assert.equal(response.data.result.summary.success, 1, action + " summary: " + JSON.stringify(response.data.result.summary));
  }
});


test("/batch: plugin emits a build marker on apply() so DSH operators can confirm the new code is loaded", async t => {
  // Regression guard: every time we ship a server-side bulk fix, the
  // user's DSH instance may still have an older plugin bundle loaded.
  // This build marker logs once per apply() and is the canonical way
  // to tell which code path is actually live.
  const f = await fixture(t);
  const messages = [];
  f.ctx.logger = { info: m => messages.push(m), warn: m => messages.push(m) };
  f.mount();
  assert.ok(
    messages.some(m => /dsh-session-manager v0\.5\.2\+release-17/.test(m)),
    "expected build marker in logger output, got: " + JSON.stringify(messages)
  );
});
