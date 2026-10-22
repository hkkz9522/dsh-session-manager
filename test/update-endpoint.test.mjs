import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mountPlugin } from "./helpers/plugin-harness.mjs";

// The running plugin version is the baseline the update flow compares against;
// derive it from package.json so a release bump does not stale these fixtures.
const PLUGIN_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function baseContext(overrides = {}) {
  const hasPm = "pluginManager" in overrides;
  let pm;
  if (hasPm) {
    if (overrides.pluginManager) {
      pm = {
        listBundles: async () => [{ name: "dsh-session-manager", source: "^0.7.3" }],
        ...overrides.pluginManager,
      };
    } else {
      pm = undefined;
    }
  } else {
    pm = {
      listBundles: async () => [{ name: "dsh-session-manager", source: "^0.7.3" }],
    };
  }

  const { pluginManager: _ignored, ...rest } = overrides;
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
    ...rest,
    pluginManager: pm,
  };
}

function createMockProfileDir(version = PLUGIN_VERSION) {
  const dir = join(tmpdir(), "sm-mock-profile-" + Date.now() + "-" + Math.random().toString(36).slice(2));
  const pkgDir = join(dir, "node_modules", "dsh-session-manager");
  mkdirSync(join(pkgDir, "lib"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "dsh-session-manager", version }, null, 2), "utf8");
  writeFileSync(join(pkgDir, "lib", "index.js"), "// mock server entry", "utf8");
  writeFileSync(join(pkgDir, "lib", "client.js"), "// mock client entry", "utf8");
  return {
    dir,
    pkgDir,
    cleanup() {
      try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    },
    setVersion(v) {
      writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "dsh-session-manager", version: v }, null, 2), "utf8");
    }
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
  const mockProfile = createMockProfileDir();
  try {
    let requestedSpec = null;
    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async (spec) => {
        requestedSpec = spec;
        mockProfile.setVersion("1.5.0");
        return { application: "restart-required", version: "1.5.0" };
      }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "1.5.0" }, "POST");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(requestedSpec, "dsh-session-manager@1.5.0");
    assert.equal(res.data.result.application, "restart-required");
    assert.equal(res.data.result.spec, "dsh-session-manager@1.5.0");
  } finally {
    mockProfile.cleanup();
  }
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
  const mockProfile = createMockProfileDir();
  try {
    let passedOpts = null;
    let envDuringInstall = null;
    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async (spec, opts) => {
        passedOpts = opts;
        envDuringInstall = process.env.NPM_CONFIG_REGISTRY;
        mockProfile.setVersion("2.0.0");
        return { application: "applied", version: "2.0.0" };
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
  } finally {
    mockProfile.cleanup();
  }
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

test("POST /update/install: in HMR mode, calls removeBundle then installBundle", async () => {
  const mockProfile = createMockProfileDir();
  try {
    const calls = [];
    const pm = {
      hot: true,
      profile: { dir: mockProfile.dir },
      removeBundle: async (name) => {
        calls.push(["remove", name]);
        return { ok: true };
      },
      installBundle: async (spec) => {
        calls.push(["install", spec]);
        mockProfile.setVersion("2.0.0");
        return { application: "applied", version: "2.0.0" };
      }
    };
    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.result.application, "applied");
    assert.deepEqual(calls, [
      ["remove", "dsh-session-manager"],
      ["install", "dsh-session-manager@2.0.0"]
    ]);
  } finally {
    mockProfile.cleanup();
  }
});

test("POST /update/install: in HMR mode, rolls back to old version when installBundle fails", async () => {
  const mockProfile = createMockProfileDir();
  try {
    const calls = [];
    const pm = {
      hot: true,
      profile: { dir: mockProfile.dir },
      removeBundle: async (name) => {
        calls.push(["remove", name]);
        return { ok: true };
      },
      installBundle: async (spec) => {
        calls.push(["install", spec]);
        if (spec.includes("2.0.0")) {
          throw new Error("Tarball checksum mismatch");
        }
        mockProfile.setVersion(PLUGIN_VERSION);
        return { application: "applied", version: PLUGIN_VERSION };
      }
    };
    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 500);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "install-failed");
    assert.equal(res.data.rolledBack, true);
    assert.ok(res.data.error.includes("Tarball checksum mismatch"));
    assert.ok(res.data.error.includes("已自动恢复旧版本"));
    assert.deepEqual(calls, [
      ["remove", "dsh-session-manager"],
      ["install", "dsh-session-manager@2.0.0"],
      ["install", "dsh-session-manager@" + PLUGIN_VERSION]
    ]);
  } finally {
    mockProfile.cleanup();
  }
});

test("GET /update/status: returns update status and idle when no update running", async () => {
  const host = mountPlugin(baseContext());
  const res = await host.request("/update/status", null, "GET");

  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.result.status, "idle");
  assert.equal(typeof res.data.result.currentVersion, "string");
});

test("POST /update/install: rejects equal or lower version with 400 not-upgrade", async () => {
  const pm = { installBundle: async () => ({ application: "applied" }) };
  const host = mountPlugin(baseContext({ pluginManager: pm }));

  // A lower version than the current one is rejected.
  const res = await host.request("/update/install", { version: "0.7.2" }, "POST");
  assert.equal(res.status, 400);
  assert.equal(res.data.code, "not-upgrade");

  // The current version itself is not an upgrade.
  const resEqual = await host.request("/update/install", { version: PLUGIN_VERSION }, "POST");
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

test("Cordis proxy safety: /update routes do not fail with un-injected property errors", async () => {
  const mockProfile = createMockProfileDir();
  try {
    const allowed = ["sessions", "agents", "workspaceRegistry", "sessionPersistence", "agentPresets", "webServer", "logger", "effect", "pluginManager", "dshHomePath", "profileContext", "connection"];
    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async (spec) => {
        mockProfile.setVersion("2.0.0");
        return { application: "restart-required", spec, version: "2.0.0" };
      }
    };
    const base = baseContext({ pluginManager: pm });
    const cordisCtx = new Proxy(base, {
      get(t, prop) {
        if (typeof prop === "symbol" || prop === "inspect" || prop === "toString") return t[prop];
        if (prop === "get") {
          return (name) => (allowed.includes(name) ? t[name] : undefined);
        }
        if (!allowed.includes(prop)) {
          throw new Error(`cannot get property "${String(prop)}" without inject`);
        }
        return t[prop];
      }
    });

    const host = mountPlugin(cordisCtx);

    const checkRes = await host.request("/update/check", null, "GET");
    assert.equal(checkRes.status, 200);
    assert.equal(checkRes.data.ok, true);

    const statusRes = await host.request("/update/status", null, "GET");
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.ok, true);

    const installRes = await host.request("/update/install", { version: "2.0.0" }, "POST");
    assert.equal(installRes.status, 200);
    assert.equal(installRes.data.ok, true);
    assert.equal(installRes.data.result.version, "2.0.0");
  } finally {
    mockProfile.cleanup();
  }
});

test("POST /update/install: aborts when removeBundle returns application: 'failed' (P0-2)", async () => {
  let installCalled = false;
  let selectCalled = false;
  const pm = {
    hot: true,
    removeBundle: async () => ({
      application: "failed",
      error: { code: "bundle-in-use", message: "Bundle is currently in use" },
      changed: true,
    }),
    selectBundle: async () => {
      selectCalled = true;
    },
    installBundle: async () => {
      installCalled = true;
      return { application: "applied" };
    },
  };

  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "remove-failed");
  assert.ok(res.data.error.includes("Bundle is currently in use") || res.data.error.includes("bundle-in-use"));
  assert.equal(installCalled, false, "installBundle must NOT be called when removeBundle fails");
  assert.equal(selectCalled, true, "selectBundle should be restored when changed was true");
});

test("POST /update/install: aborts when removeBundle throws an exception (P0-2)", async () => {
  let installCalled = false;
  const pm = {
    hot: true,
    removeBundle: async () => {
      throw new Error("ManagementFailure: stop-profile timed out");
    },
    installBundle: async () => {
      installCalled = true;
      return { application: "applied" };
    },
  };

  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "remove-failed");
  assert.ok(res.data.error.includes("ManagementFailure: stop-profile timed out"));
  assert.equal(installCalled, false, "installBundle must NOT be called when removeBundle throws");
});

test("POST /update/install: non-HMR mode installs directly without calling removeBundle (P0-1)", async () => {
  const mockProfile = createMockProfileDir();
  try {
    let removeCalled = false;
    let installedSpec = null;
    const pm = {
      hot: false,
      profile: { dir: mockProfile.dir },
      removeBundle: async () => {
        removeCalled = true;
        throw new Error("stop-profile error in non-HMR");
      },
      installBundle: async (spec) => {
        installedSpec = spec;
        mockProfile.setVersion("2.0.0");
        return { application: "restart-required", version: "2.0.0" };
      },
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(removeCalled, false, "removeBundle must not be called in non-HMR mode");
    assert.equal(installedSpec, "dsh-session-manager@2.0.0");
    assert.equal(res.data.result.application, "restart-required");
  } finally {
    mockProfile.cleanup();
  }
});

test("POST /update/install: failure in HMR triggers rollback; when rollback fails reports recovery-required (P1-1)", async () => {
  const pm = {
    hot: true,
    removeBundle: async () => ({ application: "applied" }),
    installBundle: async (spec) => {
      if (spec.includes("2.0.0")) {
        throw new Error("Corrupt download");
      }
      if (spec.includes(PLUGIN_VERSION)) {
        throw new Error("Registry offline during rollback");
      }
      return { application: "applied" };
    },
  };

  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.code, "recovery-required");
  assert.equal(res.data.rolledBack, false);
  assert.ok(res.data.error.includes("Corrupt download"));
  assert.ok(res.data.error.includes("Registry offline during rollback"));
});

test("POST /update/install: post-install disk verification failure triggers rollback in HMR (P1-2)", async () => {
  const testDir = join(tmpdir(), "sm-update-verify-test-" + Date.now());
  mkdirSync(testDir, { recursive: true });
  const pkgDir = join(testDir, "node_modules", "dsh-session-manager");
  mkdirSync(pkgDir, { recursive: true });

  try {
    let rolledBackSpec = null;
    const pm = {
      hot: true,
      profile: { dir: testDir },
      removeBundle: async () => ({ application: "applied" }),
      installBundle: async (spec) => {
        if (spec.includes("2.0.0")) {
          // Simulate bad installation: package.json has wrong version and missing entry files
          writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "dsh-session-manager", version: "1.9.9" }));
          return { application: "applied" };
        }
        if (spec.includes(PLUGIN_VERSION)) {
          rolledBackSpec = spec;
          // Restore old version correctly
          writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "dsh-session-manager", version: PLUGIN_VERSION }));
          mkdirSync(join(pkgDir, "lib"), { recursive: true });
          writeFileSync(join(pkgDir, "lib", "index.js"), "// ok");
          writeFileSync(join(pkgDir, "lib", "client.js"), "// ok");
          return { application: "applied" };
        }
        return { application: "applied" };
      },
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 500);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.rolledBack, true);
    assert.equal(rolledBackSpec, "dsh-session-manager@" + PLUGIN_VERSION);
    assert.ok(res.data.error.includes("校验失败") || res.data.error.includes("不匹配"));
  } finally {
    try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test("POST /update/install: rejects concurrent updates with 409 Conflict (P1-3)", async () => {
  const mockProfile = createMockProfileDir();
  try {
    let releaseInstall;
    const installPromise = new Promise((resolve) => {
      releaseInstall = resolve;
    });

    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async () => {
        await installPromise;
        mockProfile.setVersion("2.0.0");
        return { application: "restart-required", version: "2.0.0" };
      },
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const firstReq = host.request("/update/install", { version: "2.0.0" }, "POST");

    await new Promise((r) => setTimeout(r, 20));

    const secondRes = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(secondRes.status, 409);
    assert.equal(secondRes.data.ok, false);
    assert.equal(secondRes.data.code, "update-in-progress");
    assert.ok(secondRes.data.error.includes("已有正在执行的更新任务"));

    releaseInstall();
    const firstRes = await firstReq;
    assert.equal(firstRes.status, 200);
  } finally {
    mockProfile.cleanup();
  }
});

test("GET /update/status: returns matching task or superseded for taskId (P1-3)", async () => {
  const testDir = join(tmpdir(), "sm-status-taskid-test-" + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const pkgDir = join(testDir, "node_modules", "dsh-session-manager");
    mkdirSync(join(pkgDir, "lib"), { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "dsh-session-manager", version: "2.0.0" }));
    writeFileSync(join(pkgDir, "lib", "index.js"), "// ok");
    writeFileSync(join(pkgDir, "lib", "client.js"), "// ok");

    const pm = {
      profile: { dir: testDir },
      installBundle: async () => ({ application: "restart-required" }),
    };
    const host = mountPlugin(baseContext({ pluginManager: pm }));

    const customTaskId = "my-test-task-123";
    const installRes = await host.request("/update/install", { version: "2.0.0", taskId: customTaskId }, "POST");
    assert.equal(installRes.status, 200);
    assert.equal(installRes.data.result.taskId, customTaskId);

    const statusMatch = await host.request("/update/status?taskId=" + customTaskId, null, "GET");
    assert.equal(statusMatch.status, 200);
    assert.equal(statusMatch.data.result.taskId, customTaskId);
    assert.equal(statusMatch.data.result.status, "completed");

    const statusOther = await host.request("/update/status?taskId=older-task-999", null, "GET");
    assert.equal(statusOther.status, 200);
    assert.equal(statusOther.data.result.status, "superseded");
    assert.equal(statusOther.data.result.activeTaskId, customTaskId);
  } finally {
    try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test("GET /update/check and POST /update/install: installation and unknown sources are rejected (P1-4)", async () => {
  const pmInst = {
    listBundles: async () => [{ name: "dsh-session-manager", availability: "installation" }],
    installBundle: async () => ({ application: "applied" }),
  };
  const hostInst = mountPlugin(baseContext({ pluginManager: pmInst }));
  const checkInst = await hostInst.request("/update/check", null, "GET");
  assert.equal(checkInst.status, 200);
  assert.equal(checkInst.data.result.source, "installation");
  assert.equal(checkInst.data.result.hasUpdate, false);
  const installInst = await hostInst.request("/update/install", { version: "2.0.0" }, "POST");
  assert.equal(installInst.status, 400);
  assert.equal(installInst.data.code, "source-protected");

  const pmUnknown = {
    listBundles: async () => [{ name: "other-plugin" }],
    installBundle: async () => ({ application: "applied" }),
  };
  const hostUnknown = mountPlugin(baseContext({ pluginManager: pmUnknown }));
  const checkUnknown = await hostUnknown.request("/update/check", null, "GET");
  assert.equal(checkUnknown.status, 200);
  assert.equal(checkUnknown.data.result.source, "unknown");
  assert.equal(checkUnknown.data.result.hasUpdate, false);
  const installUnknown = await hostUnknown.request("/update/install", { version: "2.0.0" }, "POST");
  assert.equal(installUnknown.status, 400);
  assert.equal(installUnknown.data.code, "source-unknown");
});

test("POST /update/install: fails verification when profileDir is missing and never reports success (P1-1)", async () => {
  const pm = {
    // profileDir is intentionally missing
    installBundle: async () => ({ application: "applied", version: "2.0.0" }),
  };
  const host = mountPlugin(baseContext({ pluginManager: pm }));
  const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

  assert.equal(res.status, 500);
  assert.equal(res.data.ok, false);
  assert.ok(res.data.error.includes("无法定位插件运行 profile 目录"));
});

test("POST /update/install: in HMR mode, removes faulty new version before installing oldSpec on verification failure (P0-2)", async () => {
  const mockProfile = createMockProfileDir();
  try {
    const operations = [];
    const pm = {
      hot: true,
      profile: { dir: mockProfile.dir },
      removeBundle: async (name) => {
        operations.push({ op: "remove", name });
        return { ok: true, application: "applied" };
      },
      installBundle: async (spec) => {
        operations.push({ op: "install", spec });
        if (spec.includes("2.0.0")) {
          // Faulty installation: missing client.js entry
          rmSync(join(mockProfile.pkgDir, "lib", "client.js"), { force: true });
          mockProfile.setVersion("2.0.0");
          return { application: "applied", version: "2.0.0" };
        }
        if (spec.includes(PLUGIN_VERSION)) {
          // Restoring old version
          mockProfile.setVersion(PLUGIN_VERSION);
          writeFileSync(join(mockProfile.pkgDir, "lib", "client.js"), "// restored");
          return { application: "applied", version: PLUGIN_VERSION };
        }
        return { application: "applied" };
      }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 500);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.rolledBack, true);
    assert.ok(res.data.error.includes("缺少客户端入口文件"));
    assert.ok(res.data.error.includes("已自动恢复旧版本"));

    // Check strict sequence:
    // 1. remove dsh-session-manager (initial HMR uninstall of old version)
    // 2. install dsh-session-manager@2.0.0
    // 3. remove dsh-session-manager (P0-2: cleanup of faulty new version)
    // 4. install dsh-session-manager@<current> (reinstall of old version)
    assert.deepEqual(operations, [
      { op: "remove", name: "dsh-session-manager" },
      { op: "install", spec: "dsh-session-manager@2.0.0" },
      { op: "remove", name: "dsh-session-manager" },
      { op: "install", spec: "dsh-session-manager@" + PLUGIN_VERSION }
    ]);
  } finally {
    mockProfile.cleanup();
  }
});

test("POST /update/install: in HMR mode, reports recovery-required when cleanup of faulty new version fails (P0-2)", async () => {
  const mockProfile = createMockProfileDir();
  try {
    let removeCount = 0;
    const pm = {
      hot: true,
      profile: { dir: mockProfile.dir },
      removeBundle: async () => {
        removeCount++;
        if (removeCount === 1) {
          // 1st remove succeeds (old version removed)
          return { ok: true, application: "applied" };
        }
        // 2nd remove fails (faulty new version cleanup fails)
        return { ok: false, application: "failed", error: { message: "bundle-locked" } };
      },
      installBundle: async (spec) => {
        // Bad install: missing index.js
        rmSync(join(mockProfile.pkgDir, "lib", "index.js"), { force: true });
        mockProfile.setVersion("2.0.0");
        return { application: "applied", version: "2.0.0" };
      }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 500);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.code, "recovery-required");
    assert.equal(res.data.rolledBack, false);
    assert.ok(res.data.error.includes("清理安装失败的新版本失败"));
    assert.ok(res.data.error.includes("bundle-locked"));
  } finally {
    mockProfile.cleanup();
  }
});

test("POST /update/install: resolves latest concrete version and validates against disk package.json (P1-1)", async () => {
  const mockProfile = createMockProfileDir();
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (url.includes("registry.npmjs.org")) {
        return {
          ok: true,
          json: async () => ({ version: "3.2.1" })
        };
      }
      return { ok: false };
    };

    let installedSpec = null;
    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async (spec) => {
        installedSpec = spec;
        mockProfile.setVersion("3.2.1");
        return { application: "restart-required", version: "3.2.1" };
      }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", {}, "POST");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(installedSpec, "dsh-session-manager@3.2.1");
    assert.equal(res.data.result.version, "3.2.1");
  } finally {
    globalThis.fetch = origFetch;
    mockProfile.cleanup();
  }
});

test("POST /update/install: active task running over 4 minutes does NOT allow a second concurrent task", async () => {
  const mockProfile = createMockProfileDir();
  try {
    let completeFirstInstall;
    const firstInstallPromise = new Promise(resolve => { completeFirstInstall = resolve; });

    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async () => {
        await firstInstallPromise;
        mockProfile.setVersion("2.0.0");
        return { application: "restart-required", version: "2.0.0" };
      }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    // Start task A
    const reqA = host.request("/update/install", { version: "2.0.0" }, "POST");

    // Wait until task A acquires lock and starts installing
    await new Promise(r => setTimeout(r, 50));

    // Simulate task A running for > 4 minutes (e.g. 5 minutes) by artificially moving startedAt back
    const statusPath = join(mockProfile.dir, ".dsh-session-manager-update.json");
    if (existsSync(statusPath)) {
      const data = JSON.parse(readFileSync(statusPath, "utf8"));
      data.startedAt = Date.now() - (5 * 60 * 1000); // 5 minutes ago
      writeFileSync(statusPath, JSON.stringify(data), "utf8");
    }

    // Attempt second update B while A is still actively running in current process
    const resB = await host.request("/update/install", { version: "2.0.0" }, "POST");
    assert.equal(resB.status, 409);
    assert.equal(resB.data.code, "update-in-progress");

    if (completeFirstInstall) completeFirstInstall();
    const resA = await reqA;
    assert.equal(resA.status, 200);
  } finally {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    mockProfile.cleanup();
  }
});

test("POST /update/install: allows starting new task if previous disk task was left by a dead DSH process", async () => {
  const mockProfile = createMockProfileDir();
  try {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    // Write an abandoned update status file pointing to a non-existent PID
    const statusPath = join(mockProfile.dir, ".dsh-session-manager-update.json");
    writeFileSync(statusPath, JSON.stringify({
      taskId: "abandoned-task-9999",
      status: "updating",
      pid: 99999999, // Dead PID
      targetVersion: "2.0.0",
      startedAt: Date.now() - (60 * 1000)
    }), "utf8");

    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async () => {
        mockProfile.setVersion("2.0.0");
        return { application: "restart-required", version: "2.0.0" };
      }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  } finally {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    mockProfile.cleanup();
  }
});

test("POST /update/install: already installed version pending restart returns 200 without reinstalling", async () => {
  const mockProfile = createMockProfileDir("2.0.0"); // Disk already has 2.0.0 installed!
  try {
    let installCalled = false;
    let removeCalled = false;
    const pm = {
      profile: { dir: mockProfile.dir },
      removeBundle: async () => { removeCalled = true; return { ok: true }; },
      installBundle: async () => { installCalled = true; return { application: "applied" }; }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    // Requesting target version 2.0.0 when disk already has 2.0.0 installed (> running 0.7.3)
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
    assert.equal(res.data.result.application, "restart-required");
    assert.equal(res.data.result.alreadyInstalled, true);
    assert.equal(res.data.result.version, "2.0.0");
    assert.equal(removeCalled, false, "Must not invoke removeBundle for already installed version");
    assert.equal(installCalled, false, "Must not invoke installBundle for already installed version");
  } finally {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    mockProfile.cleanup();
  }
});

test("POST /update/install: target version lower than installed version rejected with 400 not-upgrade", async () => {
  const mockProfile = createMockProfileDir("2.0.0");
  try {
    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async () => ({ application: "applied" })
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "0.7.3" }, "POST");

    assert.equal(res.status, 400);
    assert.equal(res.data.code, "not-upgrade");
    assert.ok(res.data.error.includes("低于当前已安装版本"));
  } finally {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    mockProfile.cleanup();
  }
});

test("GET /update/check and POST /update/install: untrusted registry is rejected with 400", async () => {
  const mockProfile = createMockProfileDir();
  try {
    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async () => ({ application: "applied" })
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));

    // Check with untrusted registry
    const checkRes = await host.request("/update/check?registry=http://attacker.example.com", {}, "GET");
    assert.equal(checkRes.status, 400);
    assert.equal(checkRes.data.code, "untrusted-registry");

    // Install with untrusted registry
    const installRes = await host.request("/update/install", {
      version: "2.0.0",
      registry: "http://malicious.registry.org"
    }, "POST");
    assert.equal(installRes.status, 400);
    assert.equal(installRes.data.code, "untrusted-registry");
  } finally {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    mockProfile.cleanup();
  }
});

test("POST /update/install: stalled heartbeat (> 3 min) from external process allows new task", async () => {
  const mockProfile = createMockProfileDir();
  try {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    const statusPath = join(mockProfile.dir, ".dsh-session-manager-update.json");
    writeFileSync(statusPath, JSON.stringify({
      taskId: "stalled-task-1234",
      status: "installing",
      pid: process.pid + 10000,
      targetVersion: "2.0.0",
      startedAt: Date.now() - (10 * 60 * 1000),
      updatedAt: Date.now() - (4 * 60 * 1000) // Heartbeat stopped 4 minutes ago
    }), "utf8");

    const pm = {
      profile: { dir: mockProfile.dir },
      installBundle: async () => {
        mockProfile.setVersion("2.0.0");
        return { application: "restart-required", version: "2.0.0" };
      }
    };

    const host = mountPlugin(baseContext({ pluginManager: pm }));
    const res = await host.request("/update/install", { version: "2.0.0" }, "POST");

    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  } finally {
    delete globalThis[Symbol.for("dsh-session-manager.activeUpdateTask")];
    mockProfile.cleanup();
  }
});
