import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  assertSessionId,
  assertSessionDirectory,
  candidateSessionDirs,
  encodeFsSessionSegment,
  decodeFsSessionSegment,
  encodeProjectSegment,
  readSessionHeader,
  readSessionFile
} from "../lib/session-files.js";
import { scanSessionHeaders, listSessionHeaders } from "../lib/index.js";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

const frame = (text) => zstdCompressSync(Buffer.from(text));

async function sandbox(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "dsh-issue39-test-"));
  t.after(async () => {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.ok(rel.startsWith("dsh-issue39-test-") && !rel.includes(sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

test("encodeFsSessionSegment: encodes according to DSH encodeSegment contract", () => {
  // 1. Regular session UUID
  assert.equal(encodeFsSessionSegment("session-1234-abcd"), "session-1234-abcd");

  // 2. IM session ID with multiple colons
  assert.equal(
    encodeFsSessionSegment("im:feishu:123"),
    "im~003Afeishu~003A123"
  );
  assert.equal(
    encodeFsSessionSegment("im:feishu_56be8237a8d9:dm:1790921018596:oc_ba735356160a6b2a86b0df2a48a0c7b3"),
    "im~003Afeishu_56be8237a8d9~003Adm~003A1790921018596~003Aoc_ba735356160a6b2a86b0df2a48a0c7b3"
  );

  // 3. ID containing tilde '~'
  assert.equal(encodeFsSessionSegment("sess~123"), "sess~007E123");

  // 4. Non-ASCII characters (e.g. Chinese characters)
  assert.equal(encodeFsSessionSegment("会话-001"), "~4F1A~8BDD-001");
  assert.equal(encodeFsSessionSegment("im:测试:123"), "im~003A~6D4B~8BD5~003A123");

  // 5. Special segments
  assert.equal(encodeFsSessionSegment("."), "~002E");
  assert.equal(encodeFsSessionSegment(".."), "~002E~002E");

  // 6. Empty segment throws
  assert.throws(() => encodeFsSessionSegment(""), /cannot encode an empty path segment/);
});

test("decodeFsSessionSegment: decodes encoded segments back to raw string", () => {
  assert.equal(decodeFsSessionSegment("session-1234-abcd"), "session-1234-abcd");
  assert.equal(decodeFsSessionSegment("im~003Afeishu~003A123"), "im:feishu:123");
  assert.equal(decodeFsSessionSegment("sess~007E123"), "sess~123");
  assert.equal(decodeFsSessionSegment("~4F1A~8BDD-001"), "会话-001");
  assert.equal(decodeFsSessionSegment("im~003A~6D4B~8BD5~003A123"), "im:测试:123");
  assert.equal(decodeFsSessionSegment("~002E"), ".");
  assert.equal(decodeFsSessionSegment("~002E~002E"), "..");
});

test("assertSessionId: accepts legal IDs and strictly rejects unsafe IDs", () => {
  // Legal IDs
  const legal = [
    "session-123",
    "im:feishu:123",
    "im:feishu_56be8237a8d9:dm:1790921018596:oc_ba73",
    "sess~123",
    "会话-001",
    "user_session.v1",
    "session-name-with-dash_and.dot"
  ];
  for (const id of legal) {
    assert.equal(assertSessionId(id), id);
  }

  // Illegal IDs
  const illegal = [
    "",
    "   ",
    null,
    undefined,
    123,
    ".",
    "..",
    "../outside",
    "..\\outside",
    "/absolute",
    "\\windows\\path",
    "D:\\outside",
    "x\0y",
    "x\x1fy",
    "x<y",
    "x>y",
    'x"y',
    "x|y",
    "x?y",
    "x*y",
    "x.",
    "x "
  ];
  for (const id of illegal) {
    assert.throws(() => assertSessionId(id), { code: "bad-request" });
  }
});

test("candidateSessionDirs: yields correct set for regular and IM IDs", () => {
  // Regular UUID
  assert.deepEqual(candidateSessionDirs("s1"), ["s1", "--s1--"]);

  // IM ID with colons
  assert.deepEqual(candidateSessionDirs("im:feishu:123"), [
    "im~003Afeishu~003A123",
    "im:feishu:123",
    "--im-feishu-123--"
  ]);
});

test("assertSessionDirectory: verifies IM session directories and guards against escapes", async (t) => {
  const home = await sandbox(t);
  const root = join(home, "sessions");
  const imId = "im:feishu:123";
  const imEncodedDir = encodeFsSessionSegment(imId);
  const directory = join(root, "project", imEncodedDir);

  await fs.mkdir(directory, { recursive: true });
  assert.equal(await assertSessionDirectory(root, directory, imId), directory);

  // Mismatched directory name rejected
  await assert.rejects(
    assertSessionDirectory(root, join(root, "project", "other-dir"), imId),
    /会话目录超出允许范围/
  );

  // Traversal rejected
  await assert.rejects(
    assertSessionDirectory(root, join(root, "..", "escape"), imId),
    /会话目录超出允许范围/
  );

  // Symlink/junction rejected
  const outside = join(home, "outside");
  await fs.mkdir(outside);
  const symDir = join(root, "project", "im~003Asymlink");
  await fs.symlink(outside, symDir, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    assertSessionDirectory(root, symDir, "im:symlink"),
    /符号链接/
  );
});

test("scanSessionHeaders: seamlessly scans regular sessions, IM sessions, and disk orphans", async (t) => {
  const home = await sandbox(t);
  const sessionsRoot = join(home, "sessions");
  const projDir = encodeProjectSegment("/workspace");

  // 1. Regular session
  const s1Id = "session-reg-001";
  const s1Dir = join(sessionsRoot, projDir, encodeFsSessionSegment(s1Id));
  await fs.mkdir(s1Dir, { recursive: true });
  const s1Header = { id: s1Id, cwd: "/workspace", version: 4, origin: "user", createdAt: 1000 };
  await fs.writeFile(join(s1Dir, "session.v4.jsonl.zstd"), frame(JSON.stringify(s1Header) + "\n"));

  // 2. IM session with multiple colons
  const imId = "im:feishu:dm:17909:oc_ba73";
  const imDir = join(sessionsRoot, projDir, encodeFsSessionSegment(imId));
  await fs.mkdir(imDir, { recursive: true });
  const imHeader = { id: imId, cwd: "/workspace", version: 4, origin: "user", createdAt: 2000 };
  await fs.writeFile(join(imDir, "session.v4.jsonl.zstd"), frame(JSON.stringify(imHeader) + "\n"));

  // 3. IM session with tilde
  const tildeId = "im:wechat:user~001";
  const tildeDir = join(sessionsRoot, projDir, encodeFsSessionSegment(tildeId));
  await fs.mkdir(tildeDir, { recursive: true });
  const tildeHeader = { id: tildeId, cwd: "/workspace", version: 4, origin: "user", createdAt: 3000 };
  await fs.writeFile(join(tildeDir, "session.v4.jsonl.zstd"), frame(JSON.stringify(tildeHeader) + "\n"));

  // Mock persistence returning s1 and imId, but tildeId is a disk-only orphan
  const persistence = {
    list: async () => [s1Header, imHeader]
  };

  const scan = await scanSessionHeaders(persistence, (sub) => join(home, sub));
  assert.equal(scan.complete, true, "Scan must be complete with 0 errors");
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.headers.length, 3, "All 3 headers must be discovered");

  const ids = scan.headers.map((h) => h.id);
  assert.ok(ids.includes(s1Id));
  assert.ok(ids.includes(imId));
  assert.ok(ids.includes(tildeId));
});

test("scanSessionHeaders: rejects mismatched header id and session directory", async (t) => {
  const home = await sandbox(t);
  const sessionsRoot = join(home, "sessions");
  const projDir = encodeProjectSegment("/workspace");

  // Create folder for session A, but place an artifact with header id B inside
  const folderId = "session-folder-A";
  const headerId = "session-header-B";
  const dir = join(sessionsRoot, projDir, encodeFsSessionSegment(folderId));
  await fs.mkdir(dir, { recursive: true });
  const badHeader = { id: headerId, cwd: "/workspace", version: 4, origin: "user" };
  await fs.writeFile(join(dir, "session.v4.jsonl.zstd"), frame(JSON.stringify(badHeader) + "\n"));

  const persistence = { list: async () => [] };
  const scan = await scanSessionHeaders(persistence, (sub) => join(home, sub));
  assert.equal(scan.complete, false, "Scan must report incomplete on mismatch");
  assert.ok(scan.errors.some((err) => err.message.includes("会话目录与 header id 不一致") || err.message.includes("无法完整读取会话目录")));
});

test("scanSessionHeaders: skips known dirs before reading from disk (performance invariant)", async (t) => {
  const home = await sandbox(t);
  const sessionsRoot = join(home, "sessions");
  const projDir = encodeProjectSegment("/workspace");

  const imId = "im:feishu:123";
  const dir = join(sessionsRoot, projDir, encodeFsSessionSegment(imId));
  await fs.mkdir(dir, { recursive: true });
  // Put invalid content that would throw if read
  await fs.writeFile(join(dir, "session.v4.jsonl.zstd"), Buffer.from("NOT ZSTD"));

  // Because persistence lists imId, scanSessionHeaders should add encodeFsSessionSegment(imId) to knownDirs
  // and skip reading the file completely!
  const imHeader = { id: imId, cwd: "/workspace", version: 4, origin: "user", createdAt: 1000 };
  const persistence = { list: async () => [imHeader] };

  const scan = await scanSessionHeaders(persistence, (sub) => join(home, sub));
  assert.equal(scan.complete, true, "Known directory must be skipped without reading invalid file");
  assert.equal(scan.errors.length, 0);
  assert.equal(scan.headers.length, 1);
  assert.equal(scan.headers[0].id, imId);
});

test("subagent discovery and deletion: handles IM sessions and cascade delete", async (t) => {
  const home = await sandbox(t);
  const source = join(home, "ws1");
  await fs.mkdir(source);
  await fs.mkdir(join(home, "sessions"));

  const parentId = "im:feishu:root:001";
  const subId = "im:feishu:subagent:002";

  let state = {
    archivedSessionIds: [],
    workspaces: [{ id: "ws1", sessionIds: [parentId] }]
  };
  let writes = 0;

  const entity = {
    id: "ws1",
    title: "ws1",
    path: source,
    get record() { return state.workspaces.find((w) => w.id === "ws1"); },
    get sessionIds() { return this.record.sessionIds; },
    async attachSession(id) { if (!this.sessionIds.includes(id)) this.record.sessionIds.push(id); },
    async detachSession(id) { this.record.sessionIds = this.sessionIds.filter((x) => x !== id); }
  };

  function artifactPath(header, filename = "session.v4.jsonl.zstd") {
    return join(home, "sessions", encodeProjectSegment(header.cwd), encodeFsSessionSegment(header.id), filename);
  }

  const parentHeader = { id: parentId, cwd: source, version: 4, origin: "user" };
  const subHeader = { id: subId, cwd: source, version: 4, origin: "subagent", parentSession: parentId };

  // Stage files on disk
  const pPath = artifactPath(parentHeader);
  await fs.mkdir(dirname(pPath), { recursive: true });
  await fs.writeFile(pPath, frame(JSON.stringify(parentHeader) + "\n"));

  const sPath = artifactPath(subHeader);
  await fs.mkdir(dirname(sPath), { recursive: true });
  await fs.writeFile(sPath, frame(JSON.stringify(subHeader) + "\n"));

  const registry = {
    list: () => [entity],
    requireState: () => state,
    setState: async (next) => { state = next; writes++; },
    enqueueOperation: async (op) => op(),
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map()
  };

  const persistence = {
    list: async () => [parentHeader, subHeader],
    locate: (header) => ({ path: artifactPath(header) })
  };

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    dshHomePath: (segment) => join(home, segment)
  };

  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: () => undefined, flush: async () => {} },
    agents: { get: () => undefined },
    get: (name) => services[name],
    emit: () => {},
    logger: { info() {}, warn() {} }
  };

  const mounted = mountPlugin(ctx);

  // 1. Test delete-preview finds the subagent
  const previewRes = await mounted.request(`/delete-preview?sessionId=${encodeURIComponent(parentId)}`, undefined, "GET");
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.data.ok, true);
  assert.equal(previewRes.data.result.subagentCount, 1);
  assert.equal(previewRes.data.result.subagents[0].id, subId);

  // 2. Test deletion deletes both parent and subagent files
  const deleteRes = await mounted.request("/delete", { sessionId: parentId });
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.data.ok, true);

  // Verify physical files were deleted
  const parentExists = await fs.stat(pPath).then(() => true).catch(() => false);
  const subExists = await fs.stat(sPath).then(() => true).catch(() => false);
  assert.equal(parentExists, false, "Parent file must be deleted");
  assert.equal(subExists, false, "Subagent file must be deleted");
});

test("scanSessionHeaders: resolves directory collision between known session and independent legacy-pattern session", async (t) => {
  const home = await sandbox(t);
  const sessionsRoot = join(home, "sessions");
  const projDir = encodeProjectSegment("/workspace");

  // Session 1: id = "s1". Persistence lists it. Canonical directory is "s1".
  // Legacy candidate directory for "s1" would be "--s1--".
  const s1Id = "s1";
  const s1Header = { id: s1Id, cwd: "/workspace", version: 4, origin: "user", createdAt: 1000 };
  const s1Dir = join(sessionsRoot, projDir, encodeFsSessionSegment(s1Id));
  await fs.mkdir(s1Dir, { recursive: true });
  await fs.writeFile(join(s1Dir, "session.v4.jsonl.zstd"), frame(JSON.stringify(s1Header) + "\n"));

  // Session 2: actual id = "--s1--". NOT in persistence.list() (an independent / orphan session).
  // Its canonical directory on disk is "--s1--".
  const s2Id = "--s1--";
  const s2Header = { id: s2Id, cwd: "/workspace", version: 4, origin: "user", createdAt: 2000 };
  const s2Dir = join(sessionsRoot, projDir, encodeFsSessionSegment(s2Id));
  await fs.mkdir(s2Dir, { recursive: true });
  await fs.writeFile(join(s2Dir, "session.v4.jsonl.zstd"), frame(JSON.stringify(s2Header) + "\n"));

  // Persistence only lists s1
  const persistence = { list: async () => [s1Header] };

  const scan = await scanSessionHeaders(persistence, (sub) => join(home, sub));
  assert.equal(scan.complete, true, "Scan must succeed with complete: true");
  assert.equal(scan.errors.length, 0, "Scan must have 0 errors");
  assert.equal(scan.headers.length, 2, "Both s1 and --s1-- must be discovered");

  const ids = scan.headers.map((h) => h.id);
  assert.ok(ids.includes(s1Id), "s1 must be in scanned headers");
  assert.ok(ids.includes(s2Id), "--s1-- must be discovered and not skipped by collision");
});

test("subagent cascade delete: independent collision session is protected and preserved", async (t) => {
  const home = await sandbox(t);
  const sessionsRoot = join(home, "sessions");
  const projDir = encodeProjectSegment("/workspace");

  // Parent session P
  const parentId = "parent-root";
  const parentHeader = { id: parentId, cwd: "/workspace", version: 4, origin: "user" };
  const pDir = join(sessionsRoot, projDir, encodeFsSessionSegment(parentId));
  await fs.mkdir(pDir, { recursive: true });
  await fs.writeFile(join(pDir, "session.v4.jsonl.zstd"), frame(JSON.stringify(parentHeader) + "\n"));

  // Subagent session S whose id is "sub-session"
  const subId = "sub-session";
  const subHeader = { id: subId, cwd: "/workspace", version: 4, origin: "subagent", parentSession: parentId };
  const sDir = join(sessionsRoot, projDir, encodeFsSessionSegment(subId));
  await fs.mkdir(sDir, { recursive: true });
  await fs.writeFile(join(sDir, "session.v4.jsonl.zstd"), frame(JSON.stringify(subHeader) + "\n"));

  // Independent session whose id is "--sub-session--" (legacy pattern collision candidate of S)
  const indepId = "--sub-session--";
  const indepHeader = { id: indepId, cwd: "/workspace", version: 4, origin: "user" };
  const indepDir = join(sessionsRoot, projDir, encodeFsSessionSegment(indepId));
  await fs.mkdir(indepDir, { recursive: true });
  await fs.writeFile(join(indepDir, "session.v4.jsonl.zstd"), frame(JSON.stringify(indepHeader) + "\n"));

  let state = {
    version: 1,
    activeWorkspace: "/workspace",
    archivedSessionIds: [],
    workspaces: [{ id: "w1", sessionIds: [parentId, subId, indepId] }]
  };
  const entity = {
    id: "w1",
    title: "w1",
    path: "/workspace",
    get record() { return state.workspaces.find((w) => w.id === "w1"); },
    get sessionIds() { return this.record.sessionIds; },
    async attachSession(id) { if (!this.sessionIds.includes(id)) this.record.sessionIds.push(id); },
    async detachSession(id) { this.record.sessionIds = this.sessionIds.filter((x) => x !== id); }
  };

  const registry = {
    list: () => [entity],
    requireState: () => state,
    setState: async (next) => { state = next; },
    enqueueOperation: async (op) => op(),
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map()
  };

  const persistence = {
    list: async () => [parentHeader, subHeader, indepHeader],
    locate: (header) => ({ path: join(sessionsRoot, projDir, encodeFsSessionSegment(header.id), "session.v4.jsonl.zstd") })
  };

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    dshHomePath: (segment) => join(home, segment)
  };

  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: () => undefined, flush: async () => {} },
    agents: { get: () => undefined },
    get: (name) => services[name],
    emit: () => {},
    logger: { info() {}, warn() {} }
  };

  const mounted = mountPlugin(ctx);

  // Delete parent session P
  const deleteRes = await mounted.request("/delete", { sessionId: parentId });
  assert.equal(deleteRes.status, 200);
  assert.equal(deleteRes.data.ok, true);

  // Verify parent and subagent files were deleted
  const parentExists = await fs.stat(pDir).then(() => true).catch(() => false);
  const subExists = await fs.stat(sDir).then(() => true).catch(() => false);
  assert.equal(parentExists, false, "Parent session directory must be deleted");
  assert.equal(subExists, false, "Subagent session directory must be deleted");

  // Verify independent session was NOT deleted
  const indepExists = await fs.stat(indepDir).then(() => true).catch(() => false);
  assert.equal(indepExists, true, "Independent collided session must NOT be deleted");
});

test("destructive operation safety: scan errors abort deletion without removing files", async (t) => {
  const home = await sandbox(t);
  const sessionsRoot = join(home, "sessions");
  const projDir = encodeProjectSegment("/workspace");

  // Parent session
  const parentId = "parent-safe";
  const parentHeader = { id: parentId, cwd: "/workspace", version: 4, origin: "user" };
  const pDir = join(sessionsRoot, projDir, encodeFsSessionSegment(parentId));
  await fs.mkdir(pDir, { recursive: true });
  await fs.writeFile(join(pDir, "session.v4.jsonl.zstd"), frame(JSON.stringify(parentHeader) + "\n"));

  // Corrupt directory that will cause scan failure
  const corruptDir = join(sessionsRoot, projDir, "corrupt-orphan");
  await fs.mkdir(corruptDir, { recursive: true });
  await fs.writeFile(join(corruptDir, "session.v4.jsonl.zstd"), Buffer.from("CORRUPT DATA"));

  const persistence = {
    list: async () => [parentHeader],
    locate: (header) => ({ path: join(pDir, "session.v4.jsonl.zstd") })
  };

  const registry = {
    list: () => [],
    requireState: () => ({ version: 1, workspaces: [] }),
    setState: async () => {},
    enqueueOperation: async (op) => op(),
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map()
  };

  const services = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    dshHomePath: (segment) => join(home, segment)
  };

  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: () => undefined, flush: async () => {} },
    agents: { get: () => undefined },
    get: (name) => services[name],
    emit: () => {},
    logger: { info() {}, warn() {} }
  };

  const mounted = mountPlugin(ctx);

  // Deletion must fail safely because scan complete is false
  const deleteRes = await mounted.request("/delete", { sessionId: parentId });
  assert.notEqual(deleteRes.status, 200, "Deletion must be rejected when scan is incomplete");
  assert.equal(deleteRes.data.ok, false);

  // Verify parent file is still intact
  const parentExists = await fs.stat(pDir).then(() => true).catch(() => false);
  assert.equal(parentExists, true, "Parent session file must be preserved on scan failure");
});
