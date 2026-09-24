/**
 * Direct unit coverage for the client-side `runBatch` wrapper shipped
 * with dsh-session-manager 0.5.2.
 *
 * runBatch is the SessionManagerPanel's only network layer to the
 * /session-manager/api/batch endpoint. We extract it from the
 * runInNewContext sandbox used by mountClient so we can call it with a
 * stubbed fetch and exercise the happy / sad / abort paths without
 * needing to drive selectedIds from outside the panel.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function loadRunBatch({ fetchImpl, AbortControllerImpl = AbortController }) {
  // Find the `async function runBatch(args, onProgress)` declaration. The
  // snippet is re-hosted in a sandbox; we then bind the function onto
  // the sandbox global (the second arg to runInNewContext), which is
  // the context's `this` inside the snippet.
  const match = SRC.match(/async function runBatch\(args, onProgress\) \{[\s\S]*?[\r\n]+    \}[\r\n]+/);
  assert.ok(match, "runBatch must be exported as a top-level async function");
  const sandbox = { fetch: fetchImpl, AbortController: AbortControllerImpl, API: "/session-manager/api", console: { warn() {}, error() {}, log() {} } };
  runInNewContext(match[0] + "\nthis.runBatch = runBatch;", sandbox);
  if (typeof sandbox.runBatch !== "function") throw new Error("runBatch did not load");
  return sandbox.runBatch;
}

test("client runBatch: POSTs {action, sessionIds, payload} to /session-manager/api/batch", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return { json: async () => ({ ok: true, result: { summary: { total: 0, success: 0, failed: 0, skipped: 0 }, items: [] } }) };
  };
  const runBatch = loadRunBatch({ fetchImpl });
  const result = await runBatch({ action: "favorite", sessionIds: ["a", "b"], payload: { value: true } });
  assert.equal(captured.url, "/session-manager/api/batch", "must hit the /batch endpoint");
  assert.equal(captured.options.method, "POST");
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body, { action: "favorite", sessionIds: ["a", "b"], payload: { value: true } });
  assert.equal(captured.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(JSON.stringify(result.summary)), { total: 0, success: 0, failed: 0, skipped: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), []);
  assert.equal(result.aborted, false);
});

test("client runBatch: forwards server error code into the thrown exception", async () => {
  const fetchImpl = async () => ({ json: async () => ({ ok: false, code: "batch-too-large", error: "单次批量最多 200 条" }) });
  const runBatch = loadRunBatch({ fetchImpl });
  await assert.rejects(
    () => runBatch({ action: "archive", sessionIds: ["a"] }),
    (err) => {
      assert.equal(err.code, "batch-too-large", "error.code must mirror data.code");
      assert.match(err.message, /单次批量最多 200 条/);
      return true;
    }
  );
});

test("client runBatch: defaults to bad-request when the response is malformed", async () => {
  const fetchImpl = async () => ({ json: async () => ({}) });
  const runBatch = loadRunBatch({ fetchImpl });
  await assert.rejects(
    () => runBatch({ action: "favorite", sessionIds: [] }),
    (err) => {
      assert.equal(err.code, "bad-request");
      assert.match(err.message, /batch failed/);
      return true;
    }
  );
});

test("client runBatch: AbortError from fetch resolves to aborted:true without re-throwing", async () => {
  // runBatch creates an internal AbortController that is never exposed
  // (cancellation is wired in SessionManagerPanel via the progress
  // dialog button rather than an external signal). The only abort path
  // that actually produces aborted:true is the catch on `error.name ===
  // "AbortError"` -- exercise it by making fetch fail synchronously
  // with an AbortError.
  const fetchImpl = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  const runBatch = loadRunBatch({ fetchImpl });
  const result = await runBatch({ action: "favorite", sessionIds: ["a"], payload: {} });
  assert.equal(result.aborted, true, "AbortError must surface as aborted:true without re-throwing");
  assert.deepEqual(JSON.parse(JSON.stringify(result.summary)), { total: 0, success: 0, failed: 0, skipped: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), []);
});

test("client runBatch: onProgress fires once with the final items count and lastItem", async () => {
  const events = [];
  const items = [
    { sessionId: "s1", status: "success" },
    { sessionId: "s2", status: "success" },
    { sessionId: "s3", status: "failed", reason: "x" },
  ];
  const fetchImpl = async () => ({ json: async () => ({ ok: true, result: { summary: { total: 3, success: 2, failed: 1, skipped: 0 }, items } }) });
  const runBatch = loadRunBatch({ fetchImpl });
  const result = await runBatch({ action: "favorite", sessionIds: ["s1", "s2", "s3"], payload: {} }, (ev) => events.push(ev));
  assert.equal(events.length, 1, "progress fires exactly once when the batch completes");
  assert.equal(events[0].done, 3);
  assert.equal(events[0].total, 3);
  assert.deepEqual(events[0].lastItem, items[2]);
  assert.equal(result.aborted, false);
});

test("client runBatch: empty sessionIds array still POSTs (validation lives on the server)", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return { json: async () => ({ ok: false, code: "bad-request", error: "sessionIds must be a non-empty array" }) };
  };
  const runBatch = loadRunBatch({ fetchImpl });
  await assert.rejects(() => runBatch({ action: "favorite", sessionIds: [], payload: {} }));
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body.sessionIds, [], "empty array is forwarded as-is");
});

test("client runBatch: undefined payload and sessionIds normalise to {} / []", async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return { json: async () => ({ ok: true, result: { items: [] } }) };
  };
  const runBatch = loadRunBatch({ fetchImpl });
  await runBatch({ action: "favorite" });
  const body = JSON.parse(captured.options.body);
  assert.deepEqual(body.sessionIds, [], "missing sessionIds normalises to []");
  assert.deepEqual(body.payload, {}, "missing payload normalises to {}");
});

test("client runBatch: summary fallback uses items.length when the server omits summary", async () => {
  const fetchImpl = async () => ({
    json: async () => ({ ok: true, result: { items: [{ sessionId: "s1", status: "success" }, { sessionId: "s2", status: "skipped" }] } }),
  });
  const runBatch = loadRunBatch({ fetchImpl });
  const result = await runBatch({ action: "favorite", sessionIds: ["s1", "s2"], payload: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(result.summary)), { total: 2, success: 0, failed: 0, skipped: 0 });
});
