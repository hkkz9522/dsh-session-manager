/**
 * Standalone tests for the DSH compatibility adapter. Run with
 * `node --test test/dsh-adapter.test.mjs`.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createDshAdapter,
  normalizeSessionHeader,
  normalizeSessionHeaders,
  classifyInstallSource,
  detectPluginSource,
  resolveProfileDir,
  isHmrActive,
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

test("homePath: falls back to the official DSH home resolution when the service is absent", () => {
  const previous = process.env.DSH_HOME;
  const restore = () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  };
  try {
    const adapter = createDshAdapter({ get: () => undefined });
    assert.equal(typeof adapter.homePath, "function");

    // Unset: ~/.dsh (official resolveDshHome default).
    delete process.env.DSH_HOME;
    assert.equal(adapter.homePath("sessions"), join(homedir(), ".dsh", "sessions"));

    // Blank override is treated as unset.
    process.env.DSH_HOME = "   ";
    assert.equal(adapter.homePath("sessions"), join(homedir(), ".dsh", "sessions"));

    // Explicit override wins and is resolved absolute.
    process.env.DSH_HOME = "D:\\dsh-custom-home";
    assert.equal(adapter.homePath("sessions"), resolve("D:\\dsh-custom-home", "sessions"));

    // Tilde expansion matches @deepseek-ai/dsh-home-paths expandHomePath.
    process.env.DSH_HOME = "~/dsh-tilde";
    assert.equal(adapter.homePath("sessions"), join(homedir(), "dsh-tilde", "sessions"));
  } finally {
    restore();
  }
});

test("homePath: prefers the provided dshHomePath service when present", () => {
  const adapter = createDshAdapter({ get: (name) => name === "dshHomePath" ? (segment => "/served/" + segment) : undefined });
  assert.equal(adapter.homePath("sessions"), "/served/sessions");
});

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

test("production listing normalizes snapshot rows through the compat layer", async () => {
  const { listSessionHeaders } = await import("../lib/index.js");
  const header = { id: "s1", cwd: "/workspace" };
  assert.deepEqual(await listSessionHeaders({ list: async () => [{ header, revision: "r1" }] }), [header]);
});

test("getSessionEvents: returns [] when no events surface exists", () => {
  const a = createDshAdapter(makeCtx());
  assert.deepEqual(a.getSessionEvents(undefined), []);
  assert.deepEqual(a.getSessionEvents({}), []);
  assert.deepEqual(a.getSessionEvents({ events: [1, 2] }), [1, 2]);
});

test("pluginVersion: reads dsh-session-manager package.json", () => {
  const a = createDshAdapter(makeCtx());
  assert.equal(a.pluginVersion(), "0.7.6");
});

test("dshVersion: returns a string", () => {
  const a = createDshAdapter(makeCtx());
  assert.equal(typeof a.dshVersion(), "string");
});

test("Cordis context safety: detectPluginSource and resolveProfileDir do not throw without inject", () => {
  const allowed = ["sessions", "agents", "workspaceRegistry", "sessionPersistence", "agentPresets", "webServer"];
  const target = {
    sessions: { get: () => undefined, list: () => [] },
    agents: { get: () => undefined },
    workspaceRegistry: { list: () => [] },
    sessionPersistence: { list: async () => [], open: async () => ({}), stat: async () => undefined },
    agentPresets: { list: async () => [] },
    webServer: { register() {} },
  };

  const cordisProxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol" || prop === "inspect" || prop === "toString") return undefined;
      if (prop === "get") {
        return (name) => (allowed.includes(name) ? t[name] : undefined);
      }
      if (!allowed.includes(prop)) {
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      }
      return t[prop];
    }
  });

  const adapter = createDshAdapter(cordisProxy);
  assert.doesNotThrow(() => {
    const src = detectPluginSource(adapter, cordisProxy);
    assert.equal(src, "unknown");
  });
  assert.doesNotThrow(() => {
    const dir = resolveProfileDir(adapter, cordisProxy);
    assert.equal(dir, undefined);
  });
  assert.doesNotThrow(() => {
    const hmr = isHmrActive(adapter, cordisProxy);
    assert.equal(hmr, false);
  });
});

test("detectPluginSource: inspects bundle list accurately", () => {
  const adapter = createDshAdapter(makeCtx());
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", availability: "installation" }]),
    "installation"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "link:../dev-plugin" }]),
    "linked"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "file:C:/path/to/pkg" }]),
    "linked"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "github:hkkz9522/dsh-session-manager" }]),
    "github"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "registry:npm" }]),
    "npm"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "^0.7.3" }]),
    "npm"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "custom-proto:something" }]),
    "unknown"
  );
});

test("detectPluginSource: falls back to unknown if unconfirmed (never defaults to npm)", () => {
  const adapter = createDshAdapter(makeCtx());
  assert.equal(detectPluginSource(adapter, {}), "unknown");
  assert.equal(detectPluginSource(adapter, {}, []), "unknown");
});

test("classifyInstallSource: correctly classifies npm specifications", () => {
  // Bare versions & ranges
  assert.equal(classifyInstallSource("0.7.3"), "npm");
  assert.equal(classifyInstallSource("^0.7.3"), "npm");
  assert.equal(classifyInstallSource("~0.7.3"), "npm");
  assert.equal(classifyInstallSource(">=0.7.0"), "npm");
  assert.equal(classifyInstallSource("0.7.4-test.1"), "npm");
  assert.equal(classifyInstallSource("latest"), "npm");
  assert.equal(classifyInstallSource("beta"), "npm");
  assert.equal(classifyInstallSource("registry:npm"), "npm");

  // DSH official dependencySpec() format: name@spec
  assert.equal(classifyInstallSource("dsh-session-manager@0.7.3"), "npm");
  assert.equal(classifyInstallSource("dsh-session-manager@^0.7.3"), "npm");
  assert.equal(classifyInstallSource("dsh-session-manager@latest"), "npm");
  assert.equal(classifyInstallSource("dsh-session-manager@0.7.4-test.1"), "npm");
  assert.equal(classifyInstallSource("dsh-session-manager@npm:dsh-session-manager@^0.7.3"), "npm");

  // Local links
  assert.equal(classifyInstallSource("dsh-session-manager@link:../local-dir"), "linked");
  assert.equal(classifyInstallSource("link:../dev-plugin"), "linked");
  assert.equal(classifyInstallSource("file:C:/path/to/pkg"), "linked");
  assert.equal(classifyInstallSource("./relative/path"), "linked");

  // Git / GitHub
  assert.equal(classifyInstallSource("dsh-session-manager@github:hkkz9522/dsh-session-manager"), "github");
  assert.equal(classifyInstallSource("github:hkkz9522/dsh-session-manager"), "github");
  assert.equal(classifyInstallSource("git+https://github.com/hkkz9522/dsh-session-manager.git"), "github");

  // Non-npm URLs and unknown protocols
  assert.equal(classifyInstallSource("https://example.com/tarball.tgz"), "unknown");
  assert.equal(classifyInstallSource("custom-proto:something"), "unknown");
  assert.equal(classifyInstallSource(""), "unknown");
  assert.equal(classifyInstallSource(null), "unknown");
});

test("detectPluginSource: handles official DSH listBundles() sources correctly (P0-1)", () => {
  const adapter = createDshAdapter(makeCtx());
  // DSH dependencySpec output
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "dsh-session-manager@0.7.3" }]),
    "npm"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "dsh-session-manager@^0.7.3" }]),
    "npm"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "dsh-session-manager@latest" }]),
    "npm"
  );
  assert.equal(
    detectPluginSource(adapter, {}, [{ name: "dsh-session-manager", source: "dsh-session-manager@0.7.4-test.1" }]),
    "npm"
  );
});
