import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

function baseContext(overrides = {}) {
  return {
    logger: { info() {}, warn() {}, error() {} },
    sessionPersistence: {
      list: async () => [],
      stat: async () => undefined,
      open: async () => ({}),
    },
    workspaceRegistry: { list: () => [], get: () => undefined },
    sessions: { get: () => undefined, list: () => [] },
    agents: { get: () => undefined },
    agentPresets: { list: async () => [] },
    dshHomePath: (n) => "/home/" + n,
    ...overrides,
  };
}

test("GET /update/check: returns update status comparing with npm registry", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes("registry.npmjs.org")) {
        return {
          ok: true,
          json: async () => ({ version: "9.9.0" })
        };
      }
      return origFetch(url);
    };

    const host = mountPlugin(baseContext());
    const res = await host.request("/update/check", null, "GET");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(typeof res.data.result.currentVersion, "string");
    assert.equal(res.data.result.latestVersion, "9.9.0");
    assert.equal(res.data.result.hasUpdate, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("GET /update/check: handles registry fetch errors gracefully", async () => {
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new Error("Registry network timeout");
    };

    const host = mountPlugin(baseContext());
    const res = await host.request("/update/check", null, "GET");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "update-check-failed");
    assert.equal(res.data.result.hasUpdate, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("POST /update/install: calls pluginManager.installBundle when available", async () => {
  let requestedSpec = null;
  const pm = {
    installBundle: async (spec) => {
      requestedSpec = spec;
      return { application: "restart-required" };
    }
  };

  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "1.5.0" }, "POST");

  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(requestedSpec, "dsh-session-manager@1.5.0");
  assert.equal(res.data.result.application, "restart-required");
  assert.equal(res.data.result.spec, "dsh-session-manager@1.5.0");
});

test("POST /update/install: returns 501 when pluginManager is unavailable", async () => {
  const host = mountPlugin(baseContext({ pluginManager: undefined }));
  const res = await host.request("/update/install", { version: "1.5.0" }, "POST");

  assert.equal(res.status, 501);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "plugin-manager-unavailable");
});

test("POST /update/install: returns 500 when installBundle throws", async () => {
  const pm = {
    installBundle: async () => {
      throw new Error("Corrupted bundle tarball");
    }
  };

  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "1.5.0" }, "POST");

  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "install-failed");
  assert.ok(res.data.error.includes("Corrupted bundle tarball"));
});

test("POST /update/install: rejects invalid version string formats with 400", async () => {
  const pm = {
    installBundle: async () => ({ application: "restart-required" })
  };
  const host = mountPlugin(baseContext({ pluginManager: pm }));

  const invalidVersions = ["1.0.0;rm -rf", "invalid/path", "v1.0.0 & calc", "bad space", "v1.0.0|reboot"];
  for (const badVer of invalidVersions) {
    const res = await host.request("/update/install", { version: badVer }, "POST");
    assert.equal(res.status, 400);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "bad-request");
    assert.equal(res.data.error, "Invalid version format");
  }
});

test("GET /update/check: uses custom registry query parameter when provided", async () => {
  const origFetch = globalThis.fetch;
  let fetchedUrl = null;
  try {
    globalThis.fetch = async (url) => {
      fetchedUrl = url;
      if (url.includes("registry.npmmirror.com")) {
        return {
          ok: true,
          json: async () => ({ version: "2.0.0" })
        };
      }
      return { ok: false };
    };

    const host = mountPlugin(baseContext());
    const res = await host.request("/update/check?registry=" + encodeURIComponent("https://registry.npmmirror.com"), null, "GET");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.ok(fetchedUrl.startsWith("https://registry.npmmirror.com/dsh-session-manager/latest"));
    assert.equal(res.data.result.latestVersion, "2.0.0");
    assert.equal(res.data.result.hasUpdate, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("POST /update/install: forwards registry option and sets NPM_CONFIG_REGISTRY during install", async () => {
  let passedOpts = null;
  let envDuringInstall = null;
  const pm = {
    installBundle: async (spec, opts) => {
      passedOpts = opts;
      envDuringInstall = process.env.NPM_CONFIG_REGISTRY;
      return { application: "applied" };
    }
  };

  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", {
    version: "2.0.0",
    registry: "https://registry.npmmirror.com"
  }, "POST");

  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.result.application, "applied");
  assert.deepEqual(passedOpts, { registry: "https://registry.npmmirror.com" });
  assert.equal(envDuringInstall, "https://registry.npmmirror.com");
  // Outside call, process.env.NPM_CONFIG_REGISTRY should be restored
  assert.notEqual(process.env.NPM_CONFIG_REGISTRY, "https://registry.npmmirror.com");
});

test("GET /update/check: recognizes linked source and reports non-updatable", async () => {
  const host = mountPlugin(baseContext({ pluginSourceOverride: "linked" }));
  const res = await host.request("/update/check", null, "GET");

  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.result.source, "linked");
  assert.equal(res.data.result.hasUpdate, false);
  assert.ok(res.data.result.message.includes("开发模式"));
});

test("GET /update/check: recognizes github source and reports non-updatable", async () => {
  const host = mountPlugin(baseContext({ pluginSourceOverride: "github" }));
  const res = await host.request("/update/check", null, "GET");

  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.result.source, "github");
  assert.equal(res.data.result.hasUpdate, false);
  assert.ok(res.data.result.message.includes("Git/GitHub"));
});

test("POST /update/install: rejects linked and github sources with 400 source-protected", async () => {
  const pm = { installBundle: async () => ({ application: "applied" }) };
  const linkedHost = mountPlugin(baseContext({ pluginManager: pm, pluginSourceOverride: "linked" }));
  const linkedRes = await linkedHost.request("/update/install", { version: "2.0.0" }, "POST");
  assert.equal(linkedRes.status, 400);
  assert.equal(linkedRes.data.code, "source-protected");

  const ghHost = mountPlugin(baseContext({ pluginManager: pm, pluginSourceOverride: "github" }));
  const ghRes = await ghHost.request("/update/install", { version: "2.0.0" }, "POST");
  assert.equal(ghRes.status, 400);
  assert.equal(ghRes.data.code, "source-protected");
});

test("POST /update/install: rejects HMR active environment with 409 hmr-self-update-unsupported", async () => {
  const pm = {
    hot: true,
    installBundle: async () => ({ application: "applied" })
  };
  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

  assert.equal(res.status, 409);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "hmr-self-update-unsupported");
  assert.ok(res.data.error.includes("HMR"));
});

test("POST /update/install: rejects equal or lower version with 400 not-upgrade", async () => {
  const pm = { installBundle: async () => ({ application: "applied" }) };
  const host = mountPlugin(baseContext({ pluginManager: pm }));

  // v0.7.2 is lower than current v0.7.3
  const res = await host.request("/update/install", { version: "0.7.2" }, "POST");
  assert.equal(res.status, 400);
  assert.equal(res.data.code, "not-upgrade");

  // v0.7.3 is equal to current v0.7.3
  const resEqual = await host.request("/update/install", { version: "0.7.3" }, "POST");
  assert.equal(resEqual.status, 400);
  assert.equal(resEqual.data.code, "not-upgrade");
});

test("POST /update/install: treats outcome.application === 'failed' as error, not success", async () => {
  const pm = {
    installBundle: async () => ({
      application: "failed",
      error: new Error("already-installed: package exists")
    })
  };
  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "install-failed");
  assert.ok(res.data.error.includes("already-installed"));
});
