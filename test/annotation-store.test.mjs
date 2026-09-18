import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createAnnotationStore, normalizeAnnotationPatch } from "../lib/annotation-store.js";

async function fixture(t) {
  const home = await fs.mkdtemp(join(tmpdir(), "dsh-annotations-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(home));
    assert.ok(rel.startsWith("dsh-annotations-") && !rel.includes(sep));
    await fs.rm(home, { recursive: true, force: true });
  });
  const directory = join(home, "marks");
  return { directory, store: createAnnotationStore(directory) };
}

test("annotations persist across store instances without creating a session artifact", async t => {
  const { store, directory } = await fixture(t);
  assert.deepEqual(await store.list(), {});
  const saved = await store.update("s1", { favorite: true, reviewLater: true, tags: [" 修复 ", "Fix", "fix", ""], note: "第一行\n第二行", priority: 1 }, 0);
  assert.deepEqual(saved.tags, ["修复", "Fix"]);
  assert.equal(saved.revision, 1);
  assert.equal(saved.priority, 1);
  assert.deepEqual((await createAnnotationStore(directory).list()).s1, saved);
  assert.deepEqual(await fs.readdir(directory), ["annotations.v1.json"]);
});

test("partial updates merge fields; stale editors cannot overwrite another window", async t => {
  const { store } = await fixture(t);
  await store.update("s1", { note: "original" });
  const toggled = await store.update("s1", { favorite: true });
  assert.equal(toggled.note, "original");
  await assert.rejects(store.update("s1", { note: "stale" }, 1), { code: "annotation-conflict" });
  assert.equal((await store.list()).s1.note, "original");
  const latest = await store.update("s1", { note: "fresh" }, 2);
  assert.equal(latest.note, "fresh");
  assert.equal(latest.favorite, true);
});

test("independent instances serialize writes without losing sessions or disjoint fields", async t => {
  const { store, directory } = await fixture(t);
  const other = createAnnotationStore(directory);
  await Promise.all([
    store.update("s1", { favorite: true }), other.update("s1", { note: "parallel" }),
    store.update("s2", { tags: ["two"] }), other.update("s3", { priority: 5 }),
  ]);
  const data = await store.list();
  assert.equal(data.s1.favorite, true); assert.equal(data.s1.note, "parallel");
  assert.deepEqual(Object.keys(data).sort(), ["s1", "s2", "s3"]);
});

test("clearing annotations preserves revision history; deletion removes just the requested entry", async t => {
  const { store } = await fixture(t);
  await store.update("s1", { favorite: true });
  const cleared = await store.update("s1", { favorite: false });
  assert.equal(cleared.revision, 2);
  await assert.rejects(store.update("s1", { note: "stale empty editor" }, 0), { code: "annotation-conflict" });
  await store.update("s2", { note: "keep" });
  assert.equal(await store.remove("s1"), true);
  assert.equal(await store.remove("s1"), false);
  assert.equal((await store.list()).s2.note, "keep");
});

test("priority 1–5 or unset, tag/note limits and unknown fields are enforced", () => {
  for (const value of [1, 2, 3, 4, 5, null]) assert.equal(normalizeAnnotationPatch({ priority: value }).priority, value);
  for (const patch of [{ priority: 0 }, { priority: 6 }, { priority: 1.5 }, { priority: "1" }, { favorite: "yes" }, { note: "x".repeat(2001) }, { tags: ["x".repeat(33)] }, { tags: ["a,b"] }, { tags: Array.from({ length: 21 }, (_, i) => "tag" + i) }, { tags: "tag" }, { extra: true }, {}, null]) {
    assert.throws(() => normalizeAnnotationPatch(patch), { code: "bad-request" });
  }
});

test("corrupt or future-version metadata is never silently replaced", async t => {
  const { store, directory } = await fixture(t);
  await fs.mkdir(directory);
  for (const original of ['{"note":"PRIVATE-NOTE"', '{"version":2,"sessions":{}}', '{"version":1,"sessions":{"s1":{"revision":1}}}']) {
    await fs.writeFile(store.path, original);
    await assert.rejects(store.list(), error => error.code === "annotations-corrupt" && !error.message.includes("PRIVATE-NOTE"));
    await assert.rejects(store.update("s1", { favorite: true }), { code: "annotations-corrupt" });
    assert.equal(await fs.readFile(store.path, "utf8"), original);
  }
});

test("failed atomic publication leaves old annotations intact and cleans the temp/lock", async t => {
  const { store, directory } = await fixture(t);
  await store.update("s1", { note: "keep" });
  const before = await fs.readFile(store.path);
  const faulty = createAnnotationStore(directory, { io: { ...fs, rename: async () => { throw new Error("injected EPERM"); } } });
  await assert.rejects(faulty.update("s1", { note: "replacement" }), /EPERM/);
  assert.deepEqual(await fs.readFile(store.path), before);
  assert.deepEqual(await fs.readdir(directory), ["annotations.v1.json"]);
});

test("a held/crash-left lock is reported and never forcibly removed", async t => {
  const { directory } = await fixture(t); await fs.mkdir(directory);
  const lock = join(directory, "annotations.v1.lock");
  await fs.writeFile(lock, "other process");
  const store = createAnnotationStore(directory, { lockWaitMs: 30 });
  await assert.rejects(store.update("s1", { favorite: true }), { code: "annotations-busy" });
  assert.equal(await fs.readFile(lock, "utf8"), "other process");
});

test("prototype-like session IDs are stored as data, not object properties on the prototype", async t => {
  const { store } = await fixture(t);
  await store.update("__proto__", { note: "valid id" });
  await store.update("constructor", { favorite: true });
  const data = await store.list();
  assert.ok(Object.hasOwn(data, "__proto__"));
  assert.equal(data.__proto__.note, "valid id");
  assert.equal(data.constructor.favorite, true);
  assert.equal({}.note, undefined);
});
