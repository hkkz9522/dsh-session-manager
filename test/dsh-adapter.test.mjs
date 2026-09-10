/**
 * Standalone tests for the DSH compatibility adapter. Run with
 * `node --test test/dsh-adapter.test.mjs`.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  createDshAdapter,
  normalizeSessionHeader,
  normalizeSessionHeaders,
} from "../lib/compat/dsh-adapter.js";

function makeCtx(overrides = {}) {
  const services = {
    sessionPersistence: {
      list: async () => [],
      stat: async () => undefined,
      open: async () => ({}),
    },
    workspaceRegistry: { list: () => [] },
    sessions: { get: () => undefined, list: () => [] },
    agents: { get: () => undefined },
    agentPresets: { list: async () => [] },
    dshHomePath: (n) => "/home/" + n,
    ...overrides,
  };
  return { get: (name) => services[name] };
}

test("getService: tolerates direct property when ctx.get is absent", () => {
  const ctx = { workspaceRegistry: { id: "ws" }, get: undefined };
  const a = createDshAdapter(ctx);
  assert.equal(a.workspaceRegistry.id, "ws");
});

test("capabilities: reports only the surfaces the ctx exposes", () => {
  const ctx = makeCtx({
    sessionPersistence: { list: async () => [], open: async () => ({}), stat: async () => undefined },
    workspaceRegistry: { list: () => [] },
    sessions: { get: () => undefined, list: () => [] },
  });
  const caps = createDshAdapter(ctx).capabilities();
  assert.equal(caps.sessionList, true);
  assert.equal(caps.sessionHandleOpen, true);
  assert.equal(caps.persistenceLocate, false);
  assert.equal(caps.workspaceList, true);
  assert.equal(caps.workspaceAttach, false);
});

test("capabilities: detects workspace attach/detach when registry has at least one workspace", () => {
  const ws = { list: () => [{ id: "w1", path: "/x", attachSession() {}, detachSession() {} }] };
  const ctx = makeCtx({ workspaceRegistry: ws });
  const caps = createDshAdapter(ctx).capabilities();
  assert.equal(caps.workspaceAttach, true);
  assert.equal(caps.workspaceDetach, true);
});

test("normalizeSessionHeader: accepts both snapshot and raw header shapes", () => {
  assert.equal(normalizeSessionHeader({ header: { id: "s1" } }).id, "s1");
  assert.equal(normalizeSessionHeader({ id: "s2" }).id, "s2");
  assert.equal(normalizeSessionHeader(undefined), undefined);
  assert.equal(normalizeSessionHeader(null), undefined);
  assert.equal(normalizeSessionHeader({}), undefined);
});

test("normalizeSessionHeaders: filters out invalid entries", () => {
  const out = normalizeSessionHeaders([
    { header: { id: "a" } },
    null,
    { id: "b" },
    undefined,
    { id: 42 },
  ]);
  assert.deepEqual(out.map((h) => h.id), ["a", "b"]);
});

test("listSessionHeaders: extracts header from snapshot rows", async () => {
  const ctx = makeCtx({
    sessionPersistence: {
      list: async () => [
        { header: { id: "s1", cwd: "/x", createdAt: 1, delegationDepth: 0 } },
        { id: "s2", cwd: "/y", createdAt: 2, delegationDepth: 0 },
        { header: null },
      ],
    },
  });
  const a = createDshAdapter(ctx);
  const headers = await a.listSessionHeaders();
  assert.deepEqual(headers.map((h) => h.id), ["s1", "s2"]);
});

test("listSessionHeaders: returns [] when persistence is absent", async () => {
  const ctx = makeCtx({ sessionPersistence: undefined });
  const a = createDshAdapter(ctx);
  const headers = await a.listSessionHeaders();
  assert.deepEqual(headers, []);
});

test("normalizeSessionHeader: exposed on adapter and unwraps snapshot shape", () => {
  const a = createDshAdapter(makeCtx());
  const snapshot = { header: { id: "s1", cwd: "/x", delegationDepth: 0 } };
  assert.deepEqual(a.normalizeSessionHeader(snapshot), snapshot.header);
  assert.deepEqual(a.normalizeSessionHeader({ id: "s2", delegationDepth: 0 }), {
    id: "s2",
    delegationDepth: 0,
  });
  assert.equal(a.normalizeSessionHeader(undefined), undefined);
});

test("lib/index.js statically imports the compat helpers it uses", async () => {
  // Regression guard: lib/index.js must statically import the Cordis-adapter
  // shim it uses. (The disk-fallback path inside readSessionArtifact decodes
  // zstd via the inline require_("node:zlib") call below; the compat zstd
  // helper is exposed for the client bundle's test suite, not pulled in here.)
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  assert.match(src, /import\s*\{\s*createDshAdapter\s*\}\s*from\s*["']\.\/compat\/dsh-adapter\.js["']/);
});

test("getSessionEvents: returns [] when no events surface exists", () => {
  const a = createDshAdapter(makeCtx());
  assert.deepEqual(a.getSessionEvents(undefined), []);
  assert.deepEqual(a.getSessionEvents({}), []);
  assert.deepEqual(a.getSessionEvents({ events: [1, 2] }), [1, 2]);
});

test("pluginVersion: reads dsh-session-manager package.json", () => {
  const a = createDshAdapter(makeCtx());
  assert.equal(a.pluginVersion(), "0.4.7");
});

test("dshVersion: returns a string", () => {
  const a = createDshAdapter(makeCtx());
  assert.equal(typeof a.dshVersion(), "string");
});
