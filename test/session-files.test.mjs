import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { assertSessionId, assertSessionDirectory, readSessionFile, readSessionHeader, replaceSessionFile, writeTempFile } from "../lib/session-files.js";

async function sandbox(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "dsh-files-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.ok(rel.startsWith("dsh-files-test-") && !rel.includes(sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
const frame = text => zstdCompressSync(Buffer.from(text));
const header = { id: "s1", cwd: "/workspace", version: 3, agentPreset: "old" };
const headerLine = JSON.stringify(header) + "\n";

for (const id of ["..", ".", "../outside", "..\\outside", "D:\\outside", "/absolute", "x\0y", "x:y", "x.", " "]) {
  test("reject unsafe session identifier " + JSON.stringify(id), () => {
    assert.throws(() => assertSessionId(id), { code: "bad-request" });
  });
}

test("directory guard rejects root, project, sibling, and junction escapes", async t => {
  const home = await sandbox(t);
  const root = join(home, "sessions");
  const directory = join(root, "project", "s1");
  await fs.mkdir(directory, { recursive: true });
  assert.equal(await assertSessionDirectory(root, directory, "s1"), directory);
  for (const target of [root, dirname(directory), join(home, "outside"), join(root, "project", "other")]) {
    await assert.rejects(assertSessionDirectory(root, target, "s1"));
  }
  const outside = join(home, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, join(root, "project", "s2"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assertSessionDirectory(root, join(root, "project", "s2"), "s2"), /符号链接/);
  await fs.symlink(outside, join(root, "linked-project"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(assertSessionDirectory(root, join(root, "linked-project", "s3"), "s3", { allowMissing: true }), /符号链接/);
});

test("header-only discovery does not inflate a corrupt body; strict reads reject it", async t => {
  const home = await sandbox(t);
  const path = join(home, "session.v3.jsonl.zstd");
  const broken = frame('{"type":"user/message"}\n');
  broken[4] |= 8;
  await fs.writeFile(path, Buffer.concat([frame(headerLine), broken, frame('{"type":"later"}\n')]));
  assert.deepEqual(await readSessionHeader(path), header);
  await assert.rejects(readSessionFile(path), /reserved/);
});

test("strict reader keeps every complete frame and refuses a torn tail", async t => {
  const home = await sandbox(t);
  const path = join(home, "session.v3.jsonl.zstd");
  const content = headerLine + '{"type":"first"}\n' + '{"type":"second"}\n';
  const bytes = Buffer.concat([frame(headerLine), frame('{"type":"first"}\n'), frame('{"type":"second"}\n')]);
  await fs.writeFile(path, bytes);
  assert.equal((await readSessionFile(path)).content, content);
  await fs.appendFile(path, Buffer.from([0x28, 0xb5, 0x2f]));
  await assert.rejects(readSessionFile(path), /截断/);
});

test("plain header reader ignores history, but strict reader rejects a torn final line", async t => {
  const home = await sandbox(t);
  const path = join(home, "session.jsonl");
  await fs.writeFile(path, headerLine + '{"unfinished":');
  assert.deepEqual(await readSessionHeader(path), header);
  await assert.rejects(readSessionFile(path), /尾行/);
});


test("V4 header is read identically to V3 (reader is version-agnostic)", async t => {
  const home = await sandbox(t);
  const path = join(home, "session.v4.jsonl.zstd");
  const v4Header = { id: "s-v4", cwd: "D:\\1Workspace\\AI\\Codex", version: 4, agentPreset: "standard", delegationDepth: 0 };
  const headerLine = JSON.stringify(v4Header) + "\n";
  const userMsg = JSON.stringify({ type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "hi" }] } }) + "\n";
  const bytes = Buffer.concat([frame(headerLine), frame(userMsg)]);
  await fs.writeFile(path, bytes);
  const got = await readSessionHeader(path);
  assert.equal(got.id, "s-v4");
  assert.equal(got.version, 4);
  assert.equal(got.agentPreset, "standard");
  assert.equal(got.delegationDepth, 0);
  assert.equal(got.cwd, "D:\\1Workspace\\AI\\Codex");
});

test("V3-only artifact remains readable when V4 entry precedes it in ARTIFACT_NAMES", async t => {
  const home = await sandbox(t);
  const proj = join(home, "proj");
  const dir = join(proj, "s1");
  await fs.mkdir(dir, { recursive: true });
  const v3Header = { id: "s1", cwd: "/workspace", version: 3 };
  const headerLine = JSON.stringify(v3Header) + "\n";
  await fs.writeFile(join(dir, "session.v3.jsonl.zstd"), Buffer.concat([frame(headerLine)]));
  const got = await readSessionHeader(join(dir, "session.v3.jsonl.zstd"));
  assert.equal(got.version, 3);
});

function fakeFs({ renameFailures = [], writeFailure = false, syncFailure = false, backupCleanupFailure = false } = {}) {
  const path = "/virtual/session.jsonl";
  const files = new Map([[path, Buffer.from("original")]]);
  const removed = [];
  let renameCount = 0;
  const io = {
    async open(p) {
      assert.ok(!files.has(p));
      files.set(p, Buffer.alloc(0));
      return {
        async writeFile(data) { if (writeFailure) throw new Error("write failed"); files.set(p, Buffer.from(data)); },
        async sync() { if (syncFailure) throw new Error("sync failed"); },
        async close() {},
      };
    },
    async rename(a, b) {
      if (renameFailures.includes(++renameCount)) throw new Error("rename failed " + renameCount);
      assert.ok(files.has(a));
      files.set(b, files.get(a)); files.delete(a);
    },
    async rm(p) {
      removed.push(p);
      if (backupCleanupFailure && p.endsWith(".bak")) throw new Error("cleanup failed");
      files.delete(p);
    },
  };
  return { path, files, removed, io };
}

test("publish: failed first rename never removes the original", async () => {
  const f = fakeFs({ renameFailures: [1] });
  await assert.rejects(replaceSessionFile(f.path, Buffer.from("new"), f.io), /未删除原文件/);
  assert.equal(f.files.get(f.path).toString(), "original");
  assert.equal(f.files.size, 1);
  assert.ok(!f.removed.includes(f.path));
});

test("publish: failed second rename restores original", async () => {
  const f = fakeFs({ renameFailures: [2] });
  await assert.rejects(replaceSessionFile(f.path, Buffer.from("new"), f.io), /已恢复/);
  assert.equal(f.files.get(f.path).toString(), "original");
  assert.equal(f.files.size, 1);
});

test("publish: failed rollback retains original backup and replacement and reports both paths", async () => {
  const f = fakeFs({ renameFailures: [2, 3] });
  let failure;
  try { await replaceSessionFile(f.path, Buffer.from("new"), f.io); } catch (error) { failure = error; }
  assert.ok(failure instanceof AggregateError);
  assert.equal(f.files.size, 2);
  for (const path of f.files.keys()) assert.ok(failure.message.includes(path));
  assert.deepEqual([...f.files.values()].map(b => b.toString()).sort(), ["new", "original"]);
});

for (const reason of ["writeFailure", "syncFailure"]) {
  test("temp file is cleaned after " + reason, async () => {
    const f = fakeFs({ [reason]: true });
    await assert.rejects(writeTempFile(f.path, Buffer.from("new"), f.io));
    assert.equal(f.files.size, 1);
    assert.equal(f.files.get(f.path).toString(), "original");
  });
}

test("publish succeeds; a failed backup cleanup is reported, not mistaken for failed publication", async () => {
  const f = fakeFs({ backupCleanupFailure: true });
  const result = await replaceSessionFile(f.path, Buffer.from("new"), f.io);
  assert.equal(f.files.get(f.path).toString(), "new");
  assert.equal(f.files.get(result.backupPath).toString(), "original");
});
