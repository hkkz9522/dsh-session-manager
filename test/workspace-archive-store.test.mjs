import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import {
  createWorkspaceArchiveStore,
  assertWorkspaceId,
  normalizeWorkspaceArchiveRecord
} from "../lib/workspace-archive-store.js";

async function makeTempDir() {
  const dir = join(tmpdir(), "dsh-sm-ws-archive-" + randomBytes(8).toString("hex"));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

test("assertWorkspaceId rejects empty, null, traversals, and null bytes", () => {
  assert.throws(() => assertWorkspaceId(""), /无效的工作区标识/);
  assert.throws(() => assertWorkspaceId(null), /无效的工作区标识/);
  assert.throws(() => assertWorkspaceId(".."), /无效的工作区标识/);
  assert.throws(() => assertWorkspaceId("ws/../escape"), /无效的工作区标识/);
  assert.throws(() => assertWorkspaceId("ws\0bad"), /无效的工作区标识/);
  assert.doesNotThrow(() => assertWorkspaceId("workspace-123"));
  assert.doesNotThrow(() => assertWorkspaceId("C:\\Projects\\MyProject"));
});

test("normalizeWorkspaceArchiveRecord validates and fills defaults", () => {
  const rec = normalizeWorkspaceArchiveRecord({
    workspaceId: "ws-1",
    sessionIds: ["session-a"],
    archived: true
  });
  assert.equal(rec.workspaceId, "ws-1");
  assert.equal(rec.archived, true);
  assert.deepEqual(rec.sessionIds, ["session-a"]);
  assert.deepEqual(rec.pending, []);
  assert.ok(typeof rec.archivedAt === "number");
});

test("in-memory mode works without directory", async () => {
  const store = createWorkspaceArchiveStore(null, { memory: true });
  assert.deepEqual(await store.getAll(), {});

  await store.setArchive("ws-1", { sessionIds: ["s-1", "s-2"] });
  const item = await store.get("ws-1");
  assert.equal(item.workspaceId, "ws-1");
  assert.equal(item.archived, true);
  assert.deepEqual(item.sessionIds, ["s-1", "s-2"]);

  await store.removeSession("s-1");
  const afterRemove = await store.get("ws-1");
  assert.deepEqual(afterRemove.sessionIds, ["s-2"]);

  await store.setUnarchive("ws-1");
  assert.equal(await store.get("ws-1"), null);
});

test("file store: saves, re-reads, handles unarchive and session removal", async () => {
  const dir = await makeTempDir();
  try {
    const store = createWorkspaceArchiveStore(dir);
    assert.deepEqual(await store.getAll(), {});

    const saved = await store.setArchive("ws-alpha", {
      sessionIds: ["sess-1", "sess-2"],
      archivedAt: 1000
    });
    assert.equal(saved.workspaceId, "ws-alpha");
    assert.equal(saved.archived, true);
    assert.deepEqual(saved.sessionIds, ["sess-1", "sess-2"]);

    // Fresh store instance on the same directory (simulating restart)
    const store2 = createWorkspaceArchiveStore(dir);
    const readBack = await store2.get("ws-alpha");
    assert.deepEqual(readBack, saved);

    // Remove a session (e.g. deleted session)
    await store2.removeSession("sess-1");
    const afterDel = await store2.get("ws-alpha");
    assert.deepEqual(afterDel.sessionIds, ["sess-2"]);

    // Unarchive with pending
    await store2.setUnarchive("ws-alpha", { pending: ["sess-2"] });
    const partial = await store2.get("ws-alpha");
    assert.equal(partial.archived, false);
    assert.deepEqual(partial.pending, ["sess-2"]);

    // Complete unarchive
    await store2.setUnarchive("ws-alpha");
    assert.equal(await store2.get("ws-alpha"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("file store: detects corrupt JSON gracefully", async () => {
  const dir = await makeTempDir();
  try {
    await fs.writeFile(join(dir, "workspace-archives.v1.json"), "NOT-JSON{{{");
    const store = createWorkspaceArchiveStore(dir);
    await assert.rejects(() => store.read(), /工作区归档文件损坏或版本不兼容/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("file store: setUnarchive with retainSessionIds retains record with archived: false and sessionIds", async () => {
  const dir = await makeTempDir();
  try {
    const store = createWorkspaceArchiveStore(dir);
    await store.setArchive("ws-retain", {
      sessionIds: ["s-1", "s-2"],
      archivedAt: 1234
    });
    const unarchived = await store.setUnarchive("ws-retain", { retainSessionIds: true });
    assert.equal(unarchived.workspaceId, "ws-retain");
    assert.equal(unarchived.archived, false);
    assert.deepEqual(unarchived.sessionIds, ["s-1", "s-2"]);

    // Survives reload from disk
    const store2 = createWorkspaceArchiveStore(dir);
    const reloaded = await store2.get("ws-retain");
    assert.equal(reloaded.archived, false);
    assert.deepEqual(reloaded.sessionIds, ["s-1", "s-2"]);

    // Complete removal without retainSessionIds
    await store2.setUnarchive("ws-retain");
    assert.equal(await store2.get("ws-retain"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

test("workspace IDs that also name Object properties survive restart and removal", async t => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createWorkspaceArchiveStore(dir);
  assert.equal(await store.get("constructor"), null);
  await store.setArchive("__proto__", { sessionIds: ["one"] });
  const fresh = createWorkspaceArchiveStore(dir);
  assert.deepEqual((await fresh.get("__proto__")).sessionIds, ["one"]);
  await fresh.setUnarchive("__proto__");
  assert.equal(await fresh.get("__proto__"), null);
});

test("failed publication preserves the durable archive and removes its uncommitted temp", async t => {
  const dir = await makeTempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = createWorkspaceArchiveStore(dir);
  await store.setArchive("ws", { sessionIds: ["one"] });
  const broken = createWorkspaceArchiveStore(dir, { io: { ...fs, async rename() { throw Error("busy target"); } } });
  await assert.rejects(broken.setUnarchive("ws"), /busy target/);
  assert.deepEqual((await store.get("ws")).sessionIds, ["one"]);
  assert.deepEqual(await fs.readdir(dir), ["workspace-archives.v1.json"]);
});
