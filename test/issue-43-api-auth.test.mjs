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

test("issue #43 (P0): requestRejection alone without admit fails closed with 503", async () => {
  const mockConnection = {
    requestRejection(req) {
      return undefined; // Not rejected by host fence, but CANNOT prove Owner identity!
    }
  };

  const host = mountPlugin(createBaseContext({ connection: mockConnection }));

  const res = await host.request("/workspace-archives", null, "GET");
  assert.equal(res.status, 503);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "auth-unavailable");
});

test("issue #43 (P0): admit() returning undefined or empty object fails closed with 401", async () => {
  const mockUndefined = { admit: () => undefined };
  const hostUndef = mountPlugin(createBaseContext({ connection: mockUndefined }));
  const resUndef = await hostUndef.request("/annotations", null, "GET");
  assert.equal(resUndef.status, 401);
  assert.equal(resUndef.data.ok, false);
  assert.equal(resUndef.data.code, "unauthorized");

  const mockEmpty = { admit: () => ({}) };
  const hostEmpty = mountPlugin(createBaseContext({ connection: mockEmpty }));
  const resEmpty = await hostEmpty.request("/annotations", null, "GET");
  assert.equal(resEmpty.status, 401);
  assert.equal(resEmpty.data.ok, false);
  assert.equal(resEmpty.data.code, "unauthorized");
});

test("issue #43 (P0): admit() returning peer with missing or non-owner principal fails closed with 403", async () => {
  // Empty peer object
  const mockEmptyPeer = { admit: () => ({ peer: {} }) };
  const hostEmptyPeer = mountPlugin(createBaseContext({ connection: mockEmptyPeer }));
  const resEmptyPeer = await hostEmptyPeer.request("/delete", { sessionId: "s-1" }, "POST");
  assert.equal(resEmptyPeer.status, 403);
  assert.equal(resEmptyPeer.data.code, "forbidden");

  // Peer with empty principal
  const mockEmptyPrincipal = { admit: () => ({ peer: { principal: {} } }) };
  const hostEmptyPrincipal = mountPlugin(createBaseContext({ connection: mockEmptyPrincipal }));
  const resEmptyPrincipal = await hostEmptyPrincipal.request("/delete", { sessionId: "s-1" }, "POST");
  assert.equal(resEmptyPrincipal.status, 403);
  assert.equal(resEmptyPrincipal.data.code, "forbidden");

  // Peer with unknown principal kind
  const mockUnknownPrincipal = { admit: () => ({ peer: { principal: { kind: "external-collaborator" } } }) };
  const hostUnknown = mountPlugin(createBaseContext({ connection: mockUnknownPrincipal }));
  const resUnknown = await hostUnknown.request("/move", { sessionId: "s-1", targetWorkspaceId: "ws-1" }, "POST");
  assert.equal(resUnknown.status, 403);
  assert.equal(resUnknown.data.code, "forbidden");
});

test("issue #43 (P0): unauthenticated or non-owner requests never execute mutations", async () => {
  let deleteInvoked = false;
  let moveInvoked = false;
  let batchInvoked = false;

  const mockConnection = {
    admit: () => ({ peer: { principal: { kind: "guest" } } })
  };

  const host = mountPlugin(createBaseContext({
    connection: mockConnection,
    sessions: {
      get: (id) => {
        deleteInvoked = true;
        return undefined;
      },
      list: () => []
    }
  }));

  const delRes = await host.request("/delete", { sessionId: "s-1" }, "POST");
  assert.equal(delRes.status, 403);
  assert.equal(deleteInvoked, false, "Delete business logic must not be reached");

  const moveRes = await host.request("/move", { sessionId: "s-1", targetWorkspaceId: "ws-1" }, "POST");
  assert.equal(moveRes.status, 403);

  const batchRes = await host.request("/batch", { action: "delete", sessionIds: ["s-1"] }, "POST");
  assert.equal(batchRes.status, 403);

  const updateRes = await host.request("/update/install", { version: "1.0.0" }, "POST");
  assert.equal(updateRes.status, 403);
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

