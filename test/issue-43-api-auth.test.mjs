import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

function createBaseContext(overrides = {}) {
  let deletedId = null;
  let movedId = null;
  let batchRan = false;

  const base = {
    sessions: {
      get: () => undefined,
      list: () => []
    },
    agents: {
      get: () => undefined
    },
    workspaceRegistry: {
      list: () => [{ id: "ws-1", path: "/tmp/ws1", record: { sessionIds: ["s-1"] }, sessionIds: ["s-1"] }],
      requireState: () => ({ archivedSessionIds: [] }),
      setState: async () => {},
      enqueueOperation: async (op) => op(),
      headers: new Map(),
      sessionPaths: new Map(),
      invalidate() {}
    },
    sessionPersistence: {
      list: async () => [],
      open: async () => ({}),
      stat: async () => undefined
    },
    agentPresets: {
      list: async () => []
    },
    logger: {
      warn() {},
      info() {},
      debug() {},
      error() {}
    },
    ...overrides
  };
  return base;
}

test("issue #43 (P0): unauthenticated request rejected with 401 across all endpoints", async () => {
  const mockConnection = {
    admit(req) {
      return { rejection: 401 };
    },
    requestRejection(req) {
      return 401;
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  const endpoints = [
    { path: "/annotations", method: "GET" },
    { path: "/annotations", method: "POST", body: { sessionId: "s-1", patch: { favorite: true } } },
    { path: "/delete", method: "POST", body: { sessionId: "s-1" } },
    { path: "/unarchive", method: "POST", body: { sessionId: "s-1" } },
    { path: "/move", method: "POST", body: { sessionId: "s-1", targetWorkspaceId: "ws-1" } },
    { path: "/preset-migrate", method: "POST", body: { sessionId: "s-1", toPreset: "test" } },
    { path: "/workspace-archive", method: "POST", body: { workspaceId: "ws-1" } },
    { path: "/workspace-unarchive", method: "POST", body: { workspaceId: "ws-1" } },
    { path: "/workspace-archives", method: "GET" },
    { path: "/batch", method: "POST", body: { action: "delete", sessionIds: ["s-1"] } },
    { path: "/delete-preview?sessionId=s-1", method: "GET" },
    { path: "/workspaces", method: "GET" },
    { path: "/preset-scan?sessionId=s-1", method: "GET" },
    { path: "/update/check", method: "GET" },
    { path: "/update/install", method: "POST", body: { version: "1.0.0" } },
    { path: "/update/status", method: "GET" }
  ];

  for (const ep of endpoints) {
    const res = await host.request(ep.path, ep.body, ep.method);
    assert.equal(res.status, 401, `Endpoint ${ep.method} ${ep.path} must return 401 when unauthenticated`);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "unauthorized");
  }
});

test("issue #43 (P0): cross-site or untrusted host request rejected with 403", async () => {
  const mockConnection = {
    admit(req) {
      // DSH returns rejection: 403 when host fence fails (e.g. cross-site origin or DNS rebinding)
      return { rejection: 403 };
    },
    requestRejection(req) {
      return 403;
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  const res = await host.request("/annotations", null, "GET");
  assert.equal(res.status, 403);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "forbidden");
  assert.ok(res.data.error.includes("跨站") || res.data.error.includes("信任"));
});

test("issue #43 (P0): non-owner peer (e.g. guest/liveshare) rejected with 403", async () => {
  const mockConnection = {
    admit(req) {
      return {
        peer: {
          id: "guest-peer-1",
          principal: { kind: "guest" }
        }
      };
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  const res = await host.request("/delete", { sessionId: "s-1" }, "POST");
  assert.equal(res.status, 403);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "forbidden");
  assert.ok(res.data.error.includes("owner"));
});

test("issue #43 (P0): missing or unavailable connection service fails closed with 503", async () => {
  const host = mountPlugin(createBaseContext({ connection: null }));

  const res = await host.request("/annotations", null, "GET");
  assert.equal(res.status, 503);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "auth-unavailable");
});

test("issue #43 (P0): connection service throwing an error fails closed with 403", async () => {
  const mockConnection = {
    admit(req) {
      throw new Error("crypto failure");
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  const res = await host.request("/workspaces", null, "GET");
  assert.equal(res.status, 403);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "auth-error");
});

test("issue #43 (P0): requestRejection fallback works when admit is not defined", async () => {
  const mockConnection = {
    requestRejection(req) {
      return undefined; // Admitted
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  const res = await host.request("/workspace-archives", null, "GET");
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
});

test("issue #43 (P0): rejection occurs before body parsing or business logic", async () => {
  let bodyStreamRead = false;
  const mockConnection = {
    admit(req) {
      return { rejection: 401 };
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  // Send malformed non-JSON data that would cause a 400 JSON parse error if body was read
  const res = await host.request("/delete", null, "POST", "THIS IS NOT VALID JSON {{{{");
  // Should receive 401, NOT 400!
  assert.equal(res.status, 401, "Auth rejection must occur before reading body or parsing JSON");
  assert.equal(res.data.code, "unauthorized");
});

test("issue #43 (P0): authorized owner request successfully reaches business logic", async () => {
  const mockConnection = {
    admit(req) {
      return {
        peer: {
          id: "owner-peer-1",
          principal: { kind: "owner" }
        }
      };
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  const res = await host.request("/workspace-archives", null, "GET");
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.deepEqual(res.data.result, { archives: {} });
});

