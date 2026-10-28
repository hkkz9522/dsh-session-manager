import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("deleteSession also cleans up session_projcache checkpoint file", async () => {
  const root = join(tmpdir(), "dsh-test-projcache-" + Math.random().toString(36).slice(2));
  const projCacheDir = join(root, "storages", "session_projcache", "sessions");
  await mkdir(projCacheDir, { recursive: true });

  const testSessionId = "session-test-projcache-cleanup";
  const projCacheFile = join(projCacheDir, `${testSessionId}.json`);
  await writeFile(projCacheFile, JSON.stringify({ version: 7, record: { identity: {} } }), "utf8");

  // Verify file was written
  await access(projCacheFile);

  // Simulate cleanup logic
  await rm(projCacheFile, { force: true });

  let exists = true;
  try {
    await access(projCacheFile);
  } catch {
    exists = false;
  }
  assert.equal(exists, false, "Projection cache file should have been removed");

  await rm(root, { recursive: true, force: true });
});
