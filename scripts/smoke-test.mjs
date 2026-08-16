#!/usr/bin/env node
/**
 * dsh-session-manager — host API smoke test.
 *
 * Standalone, dependency-free (Node 18+ has global fetch). Points at a
 * RUNNING dsh web instance and exercises both plugin endpoints with a
 * nonexistent session id — nothing real is touched:
 *
 *   POST /session-manager/api/delete    { sessionId: "smoke-test-nonexistent" }
 *   POST /session-manager/api/unarchive { sessionId: "smoke-test-nonexistent" }
 *
 * Both must answer `{ ok: true }`. Exits 0 on success, 1 on failure.
 *
 * Usage:  node scripts/smoke-test.mjs [baseUrl]
 *         (baseUrl defaults to http://127.0.0.1:3080)
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3080";
const API = BASE + "/session-manager/api";
const FAKE = "smoke-test-nonexistent";

async function call(path) {
  const response = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: FAKE })
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  const data = await response.json();
  if (data.ok !== true) throw new Error(`${path} -> ${JSON.stringify(data)}`);
  return data;
}

let failures = 0;
for (const path of ["/unarchive", "/delete"]) {
  try {
    const data = await call(path);
    console.log(`OK   ${path} -> ${JSON.stringify(data.result ?? data)}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${path} -> ${error.message}`);
  }
}
if (failures > 0) {
  console.error(`${failures} check(s) failed (is the plugin loaded? web running at ${BASE}?)`);
  process.exit(1);
}
console.log("smoke test passed");
