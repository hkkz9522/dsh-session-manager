/**
 * Regression coverage for Issue #33:
 *   "删除会话时清理 subagent"
 *
 * Requirements verified:
 *   1. Recursively cascades deletion to descendant subagents (origin === "subagent", parentSession === id).
 *   2. Strictly preserves normal fork sessions (origin !== "subagent") and their own subagents.
 *   3. Supports multi-level descendant subagents.
 *   4. Safely stops active subagents or rejects deletion if running subagents cannot be safely stopped.
 *   5. Deduplicates cascaded deletions in batch delete (/batch) avoiding double-deletion errors.
 *   6. /delete-preview endpoint reports accurate descendant subagent count and hierarchy.
 *   7. Rejects unsafe / non-existent session ids appropriately.
 */
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
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-subagent-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(home));
    assert.ok(rel.startsWith("dsh-subagent-test-") && !rel.includes(sep));
    await fs.rm(home, { recursive: true, force: true });
  });

  await fs.mkdir(join(home, "sessions"), { recursive: true });
  let state = {
    archivedSessionIds: [],
    workspaces: [{ id: "ws1", sessionIds: [] }]
  };
  let writes = 0;

  const entity = {
    id: "ws1",
    title: "ws1",
    path: join(home, "ws1"),
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
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
  };

  const liveSessions = new Map();
  const liveAgents = new Map();
  const emitted = [];
  const warnings = [];

  function artifactPath(header, filename = "session.v3.jsonl.zstd") {
    return join(home, "sessions", encodeProjectSegment(header.cwd), encodeFsSessionSegment(header.id), filename);
  }

  const persistence = {
    list: async () => [],
    locate: header => ({ path: artifactPath(header) })
  };

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    dshHomePath: segment => join(home, segment),
    agentPresets: { list: async () => [{ id: "p1" }] },
    sessionProjectionCache: { coldSnapshot: async () => {} },
  };

  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: id => liveSessions.get(id), flush: async () => {} },
    agents: { get: id => liveAgents.get(id) },
    waterfall: async (name, payload, fallback) => typeof fallback === "function" ? fallback() : [],
    parallel: async () => [],
    workspaces: {
      archiveSession: async (sessionId) => {
        state = { ...state, archivedSessionIds: Array.from(new Set([...state.archivedSessionIds, sessionId])) };
      }
    },
    get: name => services[name],
    emit: (...args) => emitted.push(args),
    logger: { info() {}, warn: message => warnings.push(message) },
  };

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
    registry.headers.set(id, header);
    await entity.attachSession(id);
    return { header, path, bytes: payload, content };
  }

  return {
    home,
    stage,
    artifactPath,
    registry,
    persistence,
    services,
    ctx,
    liveSessions,
    liveAgents,
    warnings,
    emitted,
    get state() { return state; },
    mount: () => mountPlugin(ctx)
  };
}

test("issue #33: deleting parent session cascades to multi-level subagents and preserves normal forks", async t => {
  const f = await fixture(t);

  // 1. Root parent session
  await f.stage({ id: "parent-1", header: { origin: "user" } });

  // 2. Direct subagent of parent
  await f.stage({ id: "sub-1", header: { origin: "subagent", parentSession: "parent-1" } });

  // 3. Nested subagent of sub-1 (level 2)
  await f.stage({ id: "sub-2", header: { origin: "subagent", parentSession: "sub-1" } });

  // 4. Normal fork of parent (MUST NOT BE DELETED!)
  await f.stage({ id: "fork-1", header: { origin: "fork", parentSession: "parent-1" } });

  // 5. Subagent of the fork (MUST NOT BE DELETED because fork-1 is not deleted!)
  await f.stage({ id: "sub-fork", header: { origin: "subagent", parentSession: "fork-1" } });

  const plugin = f.mount();

  // Check preview endpoint first
  const previewRes = await plugin.request("/delete-preview?sessionId=parent-1", undefined, "GET");
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.data.ok, true);
  assert.equal(previewRes.data.result.subagentCount, 2);
  const subIds = previewRes.data.result.subagents.map(s => s.id).sort();
  assert.deepEqual(subIds, ["sub-1", "sub-2"]);

  // Delete parent-1
  const delRes = await plugin.request("/delete", { sessionId: "parent-1" });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.ok, true);
  assert.equal(delRes.data.result.sessionId, "parent-1");
  assert.equal(delRes.data.result.subagentCount, 2);
  assert.deepEqual(delRes.data.result.deletedSubagents.sort(), ["sub-1", "sub-2"]);

  // Verify disk: parent-1, sub-1, sub-2 deleted
  for (const id of ["parent-1", "sub-1", "sub-2"]) {
    let exists = true;
    try {
      await fs.stat(f.artifactPath({ id, cwd: join(f.home, "ws1") }));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, `Session artifact '${id}' should have been removed`);
  }

  // Verify disk: fork-1 and sub-fork MUST STILL EXIST
  for (const id of ["fork-1", "sub-fork"]) {
    const stat = await fs.stat(f.artifactPath({ id, cwd: join(f.home, "ws1") }));
    assert.ok(stat.size > 0, `Fork session '${id}' must be preserved`);
  }
});

test("issue #33: active subagent is safely stopped and disposed before deletion", async t => {
  const f = await fixture(t);

  await f.stage({ id: "parent-active", header: { origin: "user" } });
  await f.stage({ id: "sub-running", header: { origin: "subagent", parentSession: "parent-active" } });

  let cancelledWith = null;
  let disposed = false;

  const mockAgent = {
    status: "running",
    cancel(reason) {
      cancelledWith = reason;
      this.status = "disposed";
    },
    scope: {
      dispose() { disposed = true; }
    }
  };

  f.liveAgents.set("sub-running", mockAgent);

  const plugin = f.mount();
  const delRes = await plugin.request("/delete", { sessionId: "parent-active" });

  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.ok, true);
  assert.equal(delRes.data.result.subagentCount, 1);
  assert.deepEqual(cancelledWith, { kind: "disposed" });
  assert.equal(disposed, true);
});

test("issue #33: deletion is rejected when active subagent cannot be safely stopped", async t => {
  const f = await fixture(t);

  await f.stage({ id: "parent-busy", header: { origin: "user" } });
  await f.stage({ id: "sub-unstoppable", header: { origin: "subagent", parentSession: "parent-busy" } });

  const unstoppableAgent = {
    status: "running",
    cancel() {
      // Stubbornly remains running
    }
  };

  f.liveAgents.set("sub-unstoppable", unstoppableAgent);

  const plugin = f.mount();
  const delRes = await plugin.request("/delete", { sessionId: "parent-busy" });

  assert.equal(delRes.status, 500);
  assert.equal(delRes.data.ok, false);
  assert.match(delRes.data.error, /无法安全停止/);

  // Both sessions must still exist on disk (no partial deletion)
  const parentStat = await fs.stat(f.artifactPath({ id: "parent-busy", cwd: join(f.home, "ws1") }));
  assert.ok(parentStat.size > 0);
  const subStat = await fs.stat(f.artifactPath({ id: "sub-unstoppable", cwd: join(f.home, "ws1") }));
  assert.ok(subStat.size > 0);
});

test("issue #33: batch delete deduplicates cascaded subagents without double deletion errors", async t => {
  const f = await fixture(t);

  await f.stage({ id: "p1", header: { origin: "user" } });
  await f.stage({ id: "s1", header: { origin: "subagent", parentSession: "p1" } });
  await f.stage({ id: "p2", header: { origin: "user" } });

  const plugin = f.mount();

  // Preview across multiple IDs (p1, p2 has cascaded descendant s1)
  const previewRes = await plugin.request("/delete-preview?sessionIds=p1,p2", undefined, "GET");
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.data.ok, true);
  assert.equal(previewRes.data.result.subagentCount, 1);
  assert.equal(previewRes.data.result.subagents[0].id, "s1");

  // Batch delete with both parent and subagent in the list
  const res = await plugin.request("/batch", {
    action: "delete",
    sessionIds: ["p1", "s1", "p2"]
  });

  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.result.summary.total, 3);
  assert.equal(res.data.result.summary.success, 3);
  assert.equal(res.data.result.summary.failed, 0);

  const itemP1 = res.data.result.items.find(i => i.sessionId === "p1");
  assert.equal(itemP1.status, "success");
  assert.equal(itemP1.subagentCount, 1);
  assert.deepEqual(itemP1.deletedSubagents, ["s1"]);

  const itemS1 = res.data.result.items.find(i => i.sessionId === "s1");
  assert.equal(itemS1.status, "success");
  assert.equal(itemS1.cascaded, true);

  const itemP2 = res.data.result.items.find(i => i.sessionId === "p2");
  assert.equal(itemP2.status, "success");
  assert.equal(itemP2.subagentCount, 0);
});

test("issue #33: cold session with agents.get() throwing error does not break preview or cascaded delete", async t => {
  const f = await fixture(t);

  // Simulate DSH behavior where agents.get() throws ApiRemoteSessionNotFound on cold sessions
  f.ctx.agents.get = (id) => {
    const err = new Error(`ApiRemoteSessionNotFound: session '${id}' is not loaded in memory`);
    err.code = "ApiRemoteSessionNotFound";
    throw err;
  };

  await f.stage({ id: "parent-cold", header: { origin: "user" } });
  await f.stage({ id: "sub-cold", header: { origin: "subagent", parentSession: "parent-cold" } });

  const plugin = f.mount();

  const previewRes = await plugin.request("/delete-preview?sessionId=parent-cold", undefined, "GET");
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.data.ok, true);
  assert.equal(previewRes.data.result.subagentCount, 1);
  assert.equal(previewRes.data.result.subagents[0].id, "sub-cold");

  const delRes = await plugin.request("/delete", { sessionId: "parent-cold" });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.ok, true);
  assert.equal(delRes.data.result.subagentCount, 1);
  assert.deepEqual(delRes.data.result.deletedSubagents, ["sub-cold"]);

  // Both should be deleted on disk
  for (const id of ["parent-cold", "sub-cold"]) {
    let exists = true;
    try {
      await fs.stat(f.artifactPath({ id, cwd: join(f.home, "ws1") }));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, `Session artifact '${id}' should have been removed`);
  }
});

test("issue #33: refuses cascade deletion when session scan is incomplete or errored", async t => {
  const f = await fixture(t);

  await f.stage({ id: "parent-incomplete", header: { origin: "user" } });
  await f.stage({ id: "sub-incomplete", header: { origin: "subagent", parentSession: "parent-incomplete" } });

  // Simulate persistence.list returning invalid data or throwing, causing scanSessionHeaders to report errors
  f.persistence.list = async () => {
    throw new Error("Disk listing EIO: read failed");
  };

  const plugin = f.mount();

  // Preview must reject with 500 when scan is incomplete
  const previewRes = await plugin.request("/delete-preview?sessionId=parent-incomplete", undefined, "GET");
  assert.equal(previewRes.status, 500);
  assert.equal(previewRes.data.ok, false);
  assert.match(previewRes.data.error, /扫描子智能体会话失败/);

  // Delete must also reject with 500 and NOT delete anything
  const delRes = await plugin.request("/delete", { sessionId: "parent-incomplete" });
  assert.equal(delRes.status, 500);
  assert.equal(delRes.data.ok, false);
  assert.match(delRes.data.error, /扫描子智能体会话失败/);

  // Files must still exist on disk (no destruction on partial scan)
  const stat = await fs.stat(f.artifactPath({ id: "parent-incomplete", cwd: join(f.home, "ws1") }));
  assert.ok(stat.size > 0, "parent session file must be preserved");
});

test("issue #33: pre-delete validation: directory validation failure aborts before removing any files", async t => {
  const f = await fixture(t);

  await f.stage({ id: "parent-safe", header: { origin: "user" } });
  await f.stage({ id: "sub-invalid", header: { origin: "subagent", parentSession: "parent-safe" } });

  // Simulate subagent having an invalid directory (outside sessions root)
  const originalLocate = f.persistence.locate;
  f.persistence.locate = (header) => {
    if (header.id === "sub-invalid") {
      return { path: join(tmpdir(), "outside-root", "session.v3.jsonl.zstd") };
    }
    return originalLocate(header);
  };

  const plugin = f.mount();

  const delRes = await plugin.request("/delete", { sessionId: "parent-safe" });
  assert.equal(delRes.status, 500);
  assert.equal(delRes.data.ok, false);

  // Parent session must NOT have been removed because validation happens before deleting any files
  const parentStat = await fs.stat(f.artifactPath({ id: "parent-safe", cwd: join(f.home, "ws1") }));
  assert.ok(parentStat.size > 0, "Parent session must still exist on disk");
});

test("issue #33: descendant-first deletion order and midway partial failure reporting", async t => {
  const f = await fixture(t);

  // Root -> child -> leaf
  await f.stage({ id: "p-order", header: { origin: "user" } });
  await f.stage({ id: "sub-child", header: { origin: "subagent", parentSession: "p-order" } });
  await f.stage({ id: "sub-leaf", header: { origin: "subagent", parentSession: "sub-child" } });

  const entity = f.registry.list()[0];
  const origDetach = entity.detachSession;
  entity.detachSession = async (id) => {
    if (id === "sub-child") {
      throw new Error("Disk error: failed to detach sub-child from workspace");
    }
    return origDetach.call(entity, id);
  };

  const plugin = f.mount();

  // Test in /batch to verify accurate reporting of partial failure
  const batchRes = await plugin.request("/batch", {
    action: "delete",
    sessionIds: ["p-order"]
  });

  assert.equal(batchRes.status, 200);
  assert.equal(batchRes.data.ok, true);
  assert.equal(batchRes.data.result.summary.failed, 1);
  assert.equal(batchRes.data.result.summary.success, 0);

  const item = batchRes.data.result.items[0];
  assert.equal(item.sessionId, "p-order");
  assert.equal(item.status, "failed");
  assert.match(item.error, /删除子智能体 'sub-child' 失败/);
  // Leaf was deleted first
  assert.deepEqual(item.deletedSubagents, ["sub-leaf"]);
  assert.deepEqual(item.remainingSessions, ["p-order", "sub-child"]);

  // Verify disk state:
  // 1. sub-leaf was deleted before sub-child failed
  let leafExists = true;
  try { await fs.stat(f.artifactPath({ id: "sub-leaf", cwd: join(f.home, "ws1") })); }
  catch { leafExists = false; }
  assert.equal(leafExists, false, "sub-leaf was deleted first");

  // 2. sub-child failed to delete (detach threw before artifact rm) and still exists
  const childStat = await fs.stat(f.artifactPath({ id: "sub-child", cwd: join(f.home, "ws1") }));
  assert.ok(childStat.size > 0, "sub-child still exists");

  // 3. parent was not deleted because child failed before parent
  const parentStat = await fs.stat(f.artifactPath({ id: "p-order", cwd: join(f.home, "ws1") }));
  assert.ok(parentStat.size > 0, "parent was preserved after subagent deletion failure");
});

test("issue #33: subagent archive record cleanup failure aggregates warning without failing deletion", async t => {
  const f = await fixture(t);

  await f.stage({ id: "p-warn", header: { origin: "user" } });
  await f.stage({ id: "sub-warn", header: { origin: "subagent", parentSession: "p-warn" } });

  const plugin = f.mount();

  // Corrupt workspace-archives.v1.json in home/dsh-session-manager to cause removeSession to fail
  const archiveDir = join(f.home, "dsh-session-manager");
  await fs.mkdir(archiveDir, { recursive: true });
  const archivesPath = join(archiveDir, "workspace-archives.v1.json");
  await fs.writeFile(archivesPath, "{ corrupt json }");

  const delRes = await plugin.request("/delete", { sessionId: "p-warn" });
  assert.equal(delRes.status, 200);
  assert.equal(delRes.data.ok, true);
  assert.ok(Array.isArray(delRes.data.result.warnings) && delRes.data.result.warnings.length > 0, "Warnings should be aggregated");
  assert.ok(delRes.data.result.warnings.some(w => w.includes("归档记录清理失败")), "Should report archive cleanup failure warning");

  // Files should still be successfully deleted
  for (const id of ["p-warn", "sub-warn"]) {
    let exists = true;
    try {
      await fs.stat(f.artifactPath({ id, cwd: join(f.home, "ws1") }));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, `Session artifact '${id}' should have been removed`);
  }
});

test("issue #33: /delete accurately reports partial failure when all subagents deleted but parent deletion fails", async t => {
  const f = await fixture(t);

  await f.stage({ id: "p-fail", header: { origin: "user" } });
  await f.stage({ id: "sub-p1", header: { origin: "subagent", parentSession: "p-fail" } });
  await f.stage({ id: "sub-p2", header: { origin: "subagent", parentSession: "p-fail" } });

  const entity = f.registry.list()[0];
  const origDetach = entity.detachSession;
  entity.detachSession = async (id) => {
    if (id === "p-fail") {
      throw new Error("Disk error: parent detachment failed");
    }
    return origDetach.call(entity, id);
  };

  const plugin = f.mount();

  const res = await plugin.request("/delete", { sessionId: "p-fail" });
  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.partialFailure, true);
  assert.match(res.data.error, /删除主会话 'p-fail' 失败/);
  assert.deepEqual(res.data.deletedSubagents.sort(), ["sub-p1", "sub-p2"]);
  assert.deepEqual(res.data.remainingSessions, ["p-fail"]);

  // Verify disk: both subagents were deleted
  for (const subId of ["sub-p1", "sub-p2"]) {
    let exists = true;
    try { await fs.stat(f.artifactPath({ id: subId, cwd: join(f.home, "ws1") })); }
    catch { exists = false; }
    assert.equal(exists, false, `Subagent '${subId}' must have been deleted`);
  }

  // Verify disk: parent still exists
  const parentStat = await fs.stat(f.artifactPath({ id: "p-fail", cwd: join(f.home, "ws1") }));
  assert.ok(parentStat.size > 0, "Parent session must still exist on disk");
});

test("issue #33: /batch accurately reports partial failure and cascades when parent deletion fails", async t => {
  const f = await fixture(t);

  await f.stage({ id: "p-batch-fail", header: { origin: "user" } });
  await f.stage({ id: "sub-bf1", header: { origin: "subagent", parentSession: "p-batch-fail" } });

  const entity = f.registry.list()[0];
  const origDetach = entity.detachSession;
  entity.detachSession = async (id) => {
    if (id === "p-batch-fail") {
      throw new Error("Disk error: parent detachment failed");
    }
    return origDetach.call(entity, id);
  };

  const plugin = f.mount();

  // Request batch delete with both parent and the subagent
  const batchRes = await plugin.request("/batch", {
    action: "delete",
    sessionIds: ["p-batch-fail", "sub-bf1"]
  });

  assert.equal(batchRes.status, 200);
  assert.equal(batchRes.data.ok, true);
  assert.equal(batchRes.data.result.summary.failed, 1);
  assert.equal(batchRes.data.result.summary.success, 1);

  const [parentItem, subItem] = batchRes.data.result.items;
  assert.equal(parentItem.sessionId, "p-batch-fail");
  assert.equal(parentItem.status, "failed");
  assert.equal(parentItem.partialFailure, true);
  assert.deepEqual(parentItem.deletedSubagents, ["sub-bf1"]);
  assert.deepEqual(parentItem.remainingSessions, ["p-batch-fail"]);

  // sub-bf1 was already deleted during parent processing, so it is reported as cascaded success
  assert.equal(subItem.sessionId, "sub-bf1");
  assert.equal(subItem.status, "success");
  assert.equal(subItem.cascaded, true);

  // Verify disk
  let subExists = true;
  try { await fs.stat(f.artifactPath({ id: "sub-bf1", cwd: join(f.home, "ws1") })); }
  catch { subExists = false; }
  assert.equal(subExists, false, "Subagent must be removed from disk");

  const pStat = await fs.stat(f.artifactPath({ id: "p-batch-fail", cwd: join(f.home, "ws1") }));
  assert.ok(pStat.size > 0, "Parent must remain on disk");
});

test("issue #33: /delete accurately reports partial failure when subagent fails midway", async t => {
  const f = await fixture(t);

  await f.stage({ id: "p-midway", header: { origin: "user" } });
  await f.stage({ id: "sub-m1", header: { origin: "subagent", parentSession: "p-midway" } });
  await f.stage({ id: "sub-m2", header: { origin: "subagent", parentSession: "sub-m1" } });

  const entity = f.registry.list()[0];
  const origDetach = entity.detachSession;
  entity.detachSession = async (id) => {
    if (id === "sub-m1") {
      throw new Error("Disk error: failed to detach sub-m1");
    }
    return origDetach.call(entity, id);
  };

  const plugin = f.mount();

  const res = await plugin.request("/delete", { sessionId: "p-midway" });
  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.partialFailure, true);
  assert.match(res.data.error, /删除子智能体 'sub-m1' 失败/);
  // sub-m2 was deleted first (descendant-first)
  assert.deepEqual(res.data.deletedSubagents, ["sub-m2"]);
  assert.deepEqual(res.data.remainingSessions, ["p-midway", "sub-m1"]);
});
