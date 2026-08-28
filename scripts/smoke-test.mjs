#!/usr/bin/env node
/**
 * dsh-session-manager — host API smoke test.
 *
 * Standalone, dependency-free (Node 18+ has global fetch). Points at a
 * RUNNING dsh web instance and exercises plugin endpoints with a
 * nonexistent session id — nothing real is touched:
 *
 *   POST /session-manager/api/delete    { sessionId: "smoke-test-nonexistent" }
 *   POST /session-manager/api/unarchive { sessionId: "smoke-test-nonexistent" }
 *   POST /session-manager/api/move      { sessionId: "smoke-test-nonexistent", targetWorkspaceId: "test" }
 *   GET  /session-manager/api/workspaces
 *
 * delete / unarchive answer `{ ok: true }` for unknown ids (idempotent);
 * move answers `{ ok: false }` with a readable message (pre-flight refuses
 * sessions with no stored artifact). Exits 0 on success, 1 on failure.
 *
 * Usage:  node scripts/smoke-test.mjs [baseUrl]
 *         (baseUrl defaults to http://127.0.0.1:3080)
 */
const BASE = process.argv[2] ?? "http://127.0.0.1:3080";
const API = BASE + "/session-manager/api";
const FAKE = "smoke-test-nonexistent";

async function callPost(path, body) {
  const response = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  const data = await response.json();
  if (data.ok !== true) throw new Error(`${path} -> ${JSON.stringify(data)}`);
  return data;
}

async function callGet(path) {
  const response = await fetch(API + path);
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  const data = await response.json();
  if (data.ok !== true) throw new Error(`${path} -> ${JSON.stringify(data)}`);
  return data;
}

/** POST that reports the parsed body without throwing on business failures. */
async function callPostRaw(path, body) {
  const response = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  return { status: response.status, data };
}

let failures = 0;

// Test POST endpoints. /move with a nonexistent session must FAIL with
// ok:false + a readable message (0.2.1 semantics: the pre-flight refuses to
// "move" sessions that have no stored artifact — a silent ok there was the
// 0.2.0 bug). /delete and /unarchive stay idempotent ok:true for unknown ids.
const expectFail = await callPostRaw("/move", { sessionId: FAKE, targetWorkspaceId: "nonexistent-workspace" });
if (!expectFail.data.ok) {
  console.log(`OK   POST /move (fake ids) -> refused: ${expectFail.data.error ?? expectFail.data.code}`);
} else {
  failures++;
  console.error(`FAIL POST /move -> unexpectedly ok for a nonexistent session: ${JSON.stringify(expectFail.data)}`);
}

for (const [path, body] of [
  ["/unarchive", { sessionId: FAKE }],
  ["/delete", { sessionId: FAKE }]
]) {
  try {
    const data = await callPost(path, body);
    console.log(`OK   POST ${path} -> ${JSON.stringify(data.result ?? data)}`);
  } catch (error) {
    failures++;
    console.error(`FAIL POST ${path} -> ${error.message}`);
  }
}

// Test GET endpoints
try {
  const data = await callGet("/workspaces");
  console.log(`OK   GET  /workspaces -> ${JSON.stringify(data.result ?? data)}`);
} catch (error) {
  failures++;
  console.error(`FAIL GET  /workspaces -> ${error.message}`);
}

if (failures > 0) {
  console.error(`${failures} check(s) failed (is the plugin loaded? web running at ${BASE}?)`);
  process.exit(1);
}
console.log("smoke test passed");
