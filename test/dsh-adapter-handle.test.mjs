import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createDshAdapter } from "../lib/compat/dsh-adapter.js";

function makeCtx(services = {}) {
  return { get: (name) => services[name] };
}

test("openSessionRead: returns handle from persistence.open", async () => {
  const fakeHandle = { id: "s1", async read() { return []; }, async close() {} };
  const ctx = makeCtx({ sessionPersistence: { open: async () => fakeHandle } });
  const a = createDshAdapter(ctx);
  const handle = await a.openSessionRead("s1");
  assert.equal(handle.id, "s1");
});

test("openSessionRead: throws when persistence.open missing", async () => {
  const ctx = makeCtx({});
  const a = createDshAdapter(ctx);
  await assert.rejects(a.openSessionRead("s1"), /is unavailable/);
});

test("resolveSessionPath: prefers resolveLog over locate", async () => {
  let locateCalled = false;
  const ctx = makeCtx({
    sessionPersistence: {
      resolveLog: async (id) => "/home/.dsh/sessions/" + id + "/session.jsonl.zstd",
      locate: () => { locateCalled = true; return { path: "ignored" }; },
    },
  });
  const a = createDshAdapter(ctx);
  const path = await a.resolveSessionPath("s1");
  assert.equal(path, "/home/.dsh/sessions/s1/session.jsonl.zstd");
  assert.equal(locateCalled, false);
});

test("resolveSessionPath: falls back to locate when resolveLog absent", async () => {
  const ctx = makeCtx({
    sessionPersistence: {
      locate: (header) => ({ path: "/home/.dsh/sessions/" + header.id + "/session.jsonl.zstd" }),
    },
  });
  const a = createDshAdapter(ctx);
  const path = await a.resolveSessionPath("s2");
  assert.equal(path, "/home/.dsh/sessions/s2/session.jsonl.zstd");
});

test("resolveSessionPath: returns undefined when no path API", async () => {
  const ctx = makeCtx({});
  const a = createDshAdapter(ctx);
  assert.equal(await a.resolveSessionPath("s3"), undefined);
});

test("statSession: returns snapshot when persistence.stat present", async () => {
  const snap = { header: { id: "s1" }, revision: "abc", sizeBytes: 42 };
  const ctx = makeCtx({ sessionPersistence: { stat: async () => snap } });
  const a = createDshAdapter(ctx);
  const out = await a.statSession("s1");
  assert.equal(out.sizeBytes, 42);
});

test("listSessionSnapshots: returns [] when persistence.list absent", async () => {
  const ctx = makeCtx({});
  const a = createDshAdapter(ctx);
  assert.deepEqual(await a.listSessionSnapshots(), []);
});

test("workspaceEntityFor: returns workspace from registry.get", () => {
  const ws = { id: "w1", path: "/x" };
  const ctx = makeCtx({ workspaceRegistry: { get: (id) => (id === "w1" ? ws : undefined) } });
  const a = createDshAdapter(ctx);
  assert.equal(a.workspaceEntityFor("w1"), ws);
  assert.equal(a.workspaceEntityFor("missing"), undefined);
});

test("readSessionEvents: returns events then closes handle", async () => {
  let closed = false;
  const events = [{ type: "agent-preset/selected", data: { agentPreset: "ptc" } }];
  const fakeHandle = {
    async read() { return events; },
    async close() { closed = true; },
  };
  const ctx = makeCtx({ sessionPersistence: { open: async () => fakeHandle } });
  const a = createDshAdapter(ctx);
  const out = await a.readSessionEvents("s1", 10);
  assert.equal(out.length, 1);
  assert.equal(closed, true);
});
