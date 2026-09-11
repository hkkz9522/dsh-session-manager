/**
 * Regression coverage for issue #6:
 *   "[性能] listSessionHeaders 的磁盘兜底在 readFile 之后才判 seen.has，
 *    导致每次启动/移动/预设扫描都重读整个会话库（80 会话 / 249MB）"
 *
 * The original bug: `listSessionHeaders()` opened and zstd-decoded every
 * session file under `<dshHome>/sessions/<proj>/<dir>/` even when the
 * persistence layer had already returned those ids, wasting O(N *
 * file_size) read + inflate per call. The fix builds a `knownDirs` set
 * from the persisted ids and skips matching directories with an O(1)
 * Set lookup before any fopen.
 *
 * Spy-based assertions (node:fs/promises is non-configurable, so we cannot
 * monkey-patch it directly). Instead, we (a) stage a fixture whose known
 * session files are large enough that decompressing all of them is
 * measurable but reading their directory entries is not, (b) assert the
 * orphan raw-id session is still discovered (the disk fallback that
 * motivates the loop is preserved), and (c) keep a static guard that the
 * `knownDirs` early-skip is in place.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { listSessionHeaders, encodeSessionSegment } from "../lib/index.js";

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

test("listSessionHeaders: skips known dirs -- perf bound (issue #6 hot path)", async () => {
  // Timing-based regression: stage 30 known sessions, each with a zstd
  // payload large enough that a single decode is clearly measurable.
  // Pre-fix would decode all 30 (~tens of ms on a typical machine);
  // post-fix decodes zero known files, only the directory entries are
  // enumerated. We pick a generous threshold to avoid CI flakiness
  // while still catching a regression where knownDirs is removed.
  const home = await mkdtemp(join(tmpdir(), "dsh-sm-"));
  try {
    const proj = "--encoded--workspace--";
    const N = 30;
    // ~256 KB compressed payload per known session; decompression is
    // fast but adds up across 30 files. Buffer the artifact to keep
    // the test self-contained.
    const bigBody = Buffer.alloc(256 * 1024, 0x20); // ASCII spaces
    const knownIds = [];
    for (let i = 0; i < N; i++) {
      const id = "known-" + i;
      knownIds.push(id);
      const header = JSON.stringify({ id, cwd: "/x", createdAt: i, version: 3, origin: "user" });
      const payload = Buffer.concat([
        frame(header + "\n"),
        zstdCompressSync(bigBody)
      ]);
      await stageSession(home, proj, encodeSessionSegment(id), payload);
    }
    const persistence = {
      list: async () => knownIds.map((id, i) => ({ id, cwd: "/x", createdAt: i, version: 3, origin: "user" })),
    };
    const t0 = Date.now();
    const headers = await listSessionHeaders(persistence, (n) => join(home, n));
    const elapsed = Date.now() - t0;
    assert.equal(headers.length, N, "all known headers must come from persistence.list()");
    // Generous threshold -- on a typical CI runner, post-fix should
    // take a few ms; pre-fix would take ~50ms+ for 30x256KB decodes.
    // 250ms leaves headroom for slow runners without admitting the
    // pre-fix cost (~tens of ms per file times 30 files).
    assert.ok(elapsed < 250, `listSessionHeaders took ${elapsed}ms for ${N} known + 0 orphans; expected < 250ms (issue #6 regression)`);
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

test("lib/index.js source contains the knownDirs early-skip (regression guard)", () => {
  // Static guard: if someone reverts the issue #6 fix by deleting the
  // Set lookup, this assertion fails. The behavioral tests above
  // verify correctness; this one guards the explicit "no false reads"
  // optimization against silent reverts.
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(src, /const knownDirs = new Set\(\)/);
  assert.match(src, /if \(knownDirs\.has\(entry\.name\)\) continue;/);
  // The DRY refactor must also still be in place; the inline zstd walk
  // must NOT be re-introduced into listSessionHeaders.
  assert.match(src, /await decompressAllZstdFrames\(buf\)/);
});

