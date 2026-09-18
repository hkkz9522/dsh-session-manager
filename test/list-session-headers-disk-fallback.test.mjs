/** Regression coverage for header enumeration, orphan discovery and the
 * issue #6 known-directory early skip. Assertions are behavioral rather than
 * timing thresholds or source-code regexes.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { listSessionHeaders, scanSessionHeaders, encodeSessionSegment } from "../lib/index.js";

function frame(text) {
  return zstdCompressSync(Buffer.from(text, "utf8"));
}

function makeArtifact(id, cwd) {
  const header = JSON.stringify({ id, cwd, createdAt: 1, version: 3, origin: "user" });
  return Buffer.concat([frame(header + "\n"), frame('{"type":"end"}\n')]);
}

async function stageSession(root, projName, dirName, payload) {
  // Match lib/index.js#listSessionHeaders which reads dshHome("sessions")
  // -- the real layout is <dshHome>/sessions/<projectDir>/<sessionDir>/.
  const dir = join(root, "sessions", projName, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "session.v3.jsonl.zstd"), payload);
}

test("encodeSessionSegment: deterministic, separators collapse", () => {
  // Smoke check on the hoisted helper. The exact shape mirrors DSH's
  // projectKey; only the wrapping "--...--" markers and the "/" -> "-"
  // collapse are asserted (loose enough to survive refactors of the
  // internal hex-encoding of unsafe code units).
  const enc = encodeSessionSegment("/home/u/proj");
  assert.match(enc, /^--/);
  assert.match(enc, /--$/);
  assert.ok(!enc.includes("/"), "separators must be folded away");
});

test("listSessionHeaders: returns headers from persistence.list() verbatim", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-sm-"));
  try {
    const persistence = {
      list: async () => [
        { id: "s1", cwd: "/x", createdAt: 1, version: 3, origin: "user" },
        { id: "s2", cwd: "/y", createdAt: 2, version: 3, origin: "user" },
      ],
    };
    const headers = await listSessionHeaders(persistence, (n) => join(home, n));
    assert.deepEqual(
      headers.map((h) => ({ id: h.id, cwd: h.cwd })),
      [{ id: "s1", cwd: "/x" }, { id: "s2", cwd: "/y" }]
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listSessionHeaders: disk fallback discovers orphan raw-id session (issue #6 fallback preserved)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-sm-"));
  try {
    const proj = "--encoded--workspace--";
    // The orphan lives in a raw-id directory that persistence.list()
    // does not know about -- the exact scenario the disk loop exists
    // to rescue. After the early-skip fix, this is the *only* directory
    // the loop opens; every other known session is skipped.
    await stageSession(home, proj, "orphan-raw", makeArtifact("orphan-raw", "/z"));
    const persistence = { list: async () => [] };
    const headers = await listSessionHeaders(persistence, (n) => join(home, n));
    const ids = headers.map((h) => h.id);
    assert.ok(ids.includes("orphan-raw"), "orphan must be discovered from disk");
    assert.equal(ids.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listSessionHeaders: known id + orphan, all returned (regression guard)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-sm-"));
  try {
    const proj = "--encoded--workspace--";
    await stageSession(home, proj, encodeSessionSegment("known-A"), makeArtifact("known-A", "/x"));
    await stageSession(home, proj, encodeSessionSegment("known-B"), makeArtifact("known-B", "/y"));
    await stageSession(home, proj, "orphan-C", makeArtifact("orphan-C", "/z"));
    const persistence = {
      list: async () => [
        { id: "known-A", cwd: "/x", createdAt: 1, version: 3, origin: "user" },
        { id: "known-B", cwd: "/y", createdAt: 2, version: 3, origin: "user" },
      ],
    };
    const headers = await listSessionHeaders(persistence, (n) => join(home, n));
    assert.deepEqual(headers.map((h) => h.id).sort(), ["known-A", "known-B", "orphan-C"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listSessionHeaders: known directories are never opened (issue #6 hot path)", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-sm-"));
  try {
    const ids = ["known-A", "known-B"];
    for (const id of ids) {
      // Reading either file would report corruption and mark the scan incomplete.
      await stageSession(home, "project", encodeSessionSegment(id), Buffer.from("not zstd"));
    }
    const persistence = { list: async () => ids.map(id => ({ id, cwd: "/x" })) };
    const result = await scanSessionHeaders(persistence, segment => join(home, segment));
    assert.deepEqual(result.headers.map(h => h.id), ids);
    assert.equal(result.complete, true);
    assert.deepEqual(result.errors, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("listSessionHeaders: returns [] when persistence.list() throws and disk has nothing", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-sm-"));
  try {
    const persistence = { list: async () => { throw new Error("boom"); } };
    const headers = await listSessionHeaders(persistence, (n) => join(home, n));
    assert.deepEqual(headers, []);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

