import { test } from "node:test";
import { strict as assert } from "node:assert";
import { compareSemver } from "../lib/compat/dsh-adapter.js";
import { mountClient } from "./helpers/client-harness.mjs";

test("compareSemver: handles standard semver triplets and prefixes", () => {
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareSemver("v1.2.3", "1.2.3"), 0);
  assert.equal(compareSemver("1.2.3", "v1.2.3"), 0);

  assert.ok(compareSemver("1.0.1", "1.0.0") > 0);
  assert.ok(compareSemver("1.0.0", "1.0.1") < 0);

  assert.ok(compareSemver("1.1.0", "1.0.9") > 0);
  assert.ok(compareSemver("1.0.9", "1.1.0") < 0);

  assert.ok(compareSemver("2.0.0", "1.99.99") > 0);
  assert.ok(compareSemver("1.99.99", "2.0.0") < 0);
});

test("compareSemver: handles pre-release suffixes correctly", () => {
  // A normal release is newer than a pre-release for the same major.minor.patch
  assert.ok(compareSemver("1.0.0", "1.0.0-beta.1") > 0);
  assert.ok(compareSemver("1.0.0-beta.1", "1.0.0") < 0);

  // Comparing pre-releases (numeric identifiers compare numerically)
  assert.ok(compareSemver("1.0.0-beta.2", "1.0.0-beta.1") > 0);
  assert.ok(compareSemver("1.0.0-beta.10", "1.0.0-beta.2") > 0);
  assert.ok(compareSemver("1.0.0-beta.1", "1.0.0-beta.2") < 0);
  assert.ok(compareSemver("1.0.0-beta.2", "1.0.0-beta.10") < 0);
  assert.equal(compareSemver("1.0.0-beta.1", "1.0.0-beta.1"), 0);

  // Newer minor pre-release is still newer than older minor final
  assert.ok(compareSemver("1.1.0-alpha.1", "1.0.0") > 0);

  // Multiple hyphens in pre-release tag
  assert.ok(compareSemver("1.0.0-alpha-1", "1.0.0-alpha-2") < 0);
  assert.ok(compareSemver("1.0.0-alpha-2", "1.0.0-alpha-1") > 0);

  // Build metadata is ignored in comparison
  assert.equal(compareSemver("1.0.0+20261001", "1.0.0+20261002"), 0);
  assert.equal(compareSemver("1.0.0-beta.1+build.1", "1.0.0-beta.1+build.2"), 0);

  // Numeric identifier has lower precedence than string identifier
  assert.ok(compareSemver("1.0.0-1", "1.0.0-alpha") < 0);

  // More identifier fields have higher precedence
  assert.ok(compareSemver("1.0.0-beta.1.1", "1.0.0-beta.1") > 0);
});

test("compareSemver: handles non-standard or missing version inputs safely", () => {
  assert.equal(compareSemver("", ""), 0);
  assert.equal(compareSemver(null, undefined), 0);
  assert.ok(compareSemver("1.0", "0.9") > 0);
});

test("updateStore: initial state and auto-check toggle with localStorage", () => {
  const harness = mountClient();
  const updateStore = harness.exports.updateStore;
  assert.ok(updateStore, "updateStore must be exported by client");

  const snapshot = updateStore.getSnapshot();
  assert.equal(typeof snapshot.currentVersion, "string");
  assert.equal(snapshot.dialogOpen, false);

  // Auto check default is true
  assert.equal(updateStore.getAutoCheck(), true);

  // Toggle to false
  updateStore.setAutoCheck(false);
  assert.equal(updateStore.getAutoCheck(), false);
  assert.equal(harness.localStorage.getItem("dsh-session-manager-auto-check"), "false");

  // Toggle back to true
  updateStore.setAutoCheck(true);
  assert.equal(updateStore.getAutoCheck(), true);
  assert.equal(harness.localStorage.getItem("dsh-session-manager-auto-check"), "true");

  harness.dispose();
});

test("updateStore: openDialog and closeDialog transitions", () => {
  const harness = mountClient();
  const updateStore = harness.exports.updateStore;

  let notified = 0;
  const unsub = updateStore.subscribe(() => {
    notified++;
  });

  updateStore.openDialog();
  assert.equal(updateStore.getSnapshot().dialogOpen, true);
  assert.ok(notified > 0);

  updateStore.closeDialog();
  assert.equal(updateStore.getSnapshot().dialogOpen, false);

  unsub();
  harness.dispose();
});

test("updateStore.checkForUpdate: detects update available via mock API", async () => {
  let calledCheck = false;
  const harness = mountClient({
    fetchUpdateCheck: async () => {
      calledCheck = true;
      return {
        ok: true,
        result: {
          currentVersion: "1.0.0",
          latestVersion: "1.2.0",
          hasUpdate: true
        }
      };
    }
  });

  const updateStore = harness.exports.updateStore;
  // Reset store to known state
  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.status = "idle";
  updateStore.state.latestVersion = null;

  const result = await updateStore.checkForUpdate({ manual: false, silent: false, openOnFound: true });
  assert.ok(calledCheck, "fetchUpdateCheck should have been invoked");
  assert.equal(result.status, "available");
  assert.equal(result.latestVersion, "1.2.0");
  assert.equal(result.dialogOpen, true);

  harness.dispose();
});

test("updateStore.checkForUpdate: handles no update available (idle)", async () => {
  const harness = mountClient({
    fetchUpdateCheck: async () => ({
      ok: true,
      result: {
        currentVersion: "1.0.0",
        latestVersion: "1.0.0",
        hasUpdate: false
      }
    })
  });

  const updateStore = harness.exports.updateStore;
  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.status = "idle";
  updateStore.state.latestVersion = null;
  updateStore.state.dialogOpen = false;

  // Silent check when up-to-date should not open dialog
  const result = await updateStore.checkForUpdate({ manual: false, silent: true, openOnFound: false });
  assert.equal(result.status, "idle");
  assert.equal(result.latestVersion, "1.0.0");
  assert.equal(result.dialogOpen, false);

  // Manual check when up-to-date opens dialog to show "up to date"
  await updateStore.checkForUpdate({ manual: true, silent: false });
  assert.equal(updateStore.getSnapshot().dialogOpen, true);

  harness.dispose();
});

test("updateStore.checkForUpdate: handles API error gracefully", async () => {
  const harness = mountClient({
    fetchUpdateCheck: async () => ({
      ok: false,
      error: "Registry unreachable"
    }),
    fetchNpmLatest: async () => {
      throw new Error("DNS resolution failed");
    }
  });

  const updateStore = harness.exports.updateStore;
  updateStore.state.status = "idle";

  const result = await updateStore.checkForUpdate({ manual: true, silent: false });
  assert.equal(result.status, "error");
  assert.ok(result.error);
  assert.equal(result.dialogOpen, true);

  harness.dispose();
});

test("updateStore.startUpdate: installs bundle and transitions to done", async () => {
  let installedSpec = null;
  const harness = mountClient({
    fetchUpdateInstall: async (body) => {
      installedSpec = body.version;
      return {
        ok: true,
        result: {
          application: "restart-required",
          spec: "dsh-session-manager@" + body.version
        }
      };
    }
  });

  const updateStore = harness.exports.updateStore;
  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "available";

  const outcome = await updateStore.startUpdate();
  assert.equal(installedSpec, "1.2.0");
  assert.equal(outcome.application, "restart-required");
  assert.equal(updateStore.getSnapshot().status, "done");
  assert.equal(updateStore.getSnapshot().application, "restart-required");

  harness.dispose();
});

test("updateStore: respects window.__DSH_SM_TEST_UPDATE__ dev override", async () => {
  const harness = mountClient();
  const updateStore = harness.exports.updateStore;

  // Set test override in sandbox
  const sandbox = {
    currentVersion: "1.0.0",
    latestVersion: "9.9.9",
    application: "applied"
  };

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.status = "idle";

  // Simulate test override
  const prevOverride = globalThis.window?.__DSH_SM_TEST_UPDATE__;
  try {
    globalThis.__DSH_SM_TEST_UPDATE__ = sandbox;
    if (globalThis.window) globalThis.window.__DSH_SM_TEST_UPDATE__ = sandbox;

    // Verify compareSemver client export matches
    assert.equal(harness.exports.compareSemver("9.9.9", "1.0.0"), 1);

    // Verify checkForUpdate uses test override
    const result = await updateStore.checkForUpdate({ manual: false, openOnFound: false, openDialog: false });
    assert.equal(result.latestVersion, "9.9.9");
    assert.equal(result.status, "available");
    assert.equal(result.dialogOpen, false);
  } finally {
    delete globalThis.__DSH_SM_TEST_UPDATE__;
    if (globalThis.window) globalThis.window.__DSH_SM_TEST_UPDATE__ = prevOverride;
    harness.dispose();
  }
});

test("updateStore: window.__DSH_SM_TEST_UPDATE__ error simulation", async () => {
  const harness = mountClient();
  const updateStore = harness.exports.updateStore;

  const prevOverride = globalThis.window?.__DSH_SM_TEST_UPDATE__;
  try {
    globalThis.__DSH_SM_TEST_UPDATE__ = { error: "Simulated offline network error" };
    if (globalThis.window) globalThis.window.__DSH_SM_TEST_UPDATE__ = globalThis.__DSH_SM_TEST_UPDATE__;

    const result = await updateStore.checkForUpdate({ manual: false, openOnFound: false, openDialog: false });
    assert.equal(result.status, "error");
    assert.ok(result.error.includes("Simulated offline network error"));
    assert.equal(result.dialogOpen, false);
  } finally {
    delete globalThis.__DSH_SM_TEST_UPDATE__;
    if (globalThis.window) globalThis.window.__DSH_SM_TEST_UPDATE__ = prevOverride;
    harness.dispose();
  }
});

test("updateStore.startUpdate: handles installation errors gracefully without unhandled rejection", async () => {
  const harness = mountClient({
    fetchUpdateInstall: async () => ({
      ok: false,
      error: "PluginManager lock held by another process"
    })
  });

  const updateStore = harness.exports.updateStore;
  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "available";
  updateStore.state.dialogOpen = false;

  // Must not throw an unhandled rejection
  const result = await updateStore.startUpdate({ openDialog: false });
  assert.equal(result.ok, false);
  assert.equal(updateStore.getSnapshot().status, "error");
  assert.ok(updateStore.getSnapshot().error.includes("PluginManager lock held"));
  assert.equal(updateStore.getSnapshot().dialogOpen, false);

  harness.dispose();
});

test("updateStore: registry selection, persistence and url resolution", () => {
  const harness = mountClient();
  const updateStore = harness.exports.updateStore;

  // Defaults
  assert.equal(updateStore.getRegistry(), "registry.npmjs.org");
  assert.equal(updateStore.getRegistryUrl(), "https://registry.npmjs.org");

  // Set China mirror
  updateStore.setRegistry("registry.npmmirror.com");
  assert.equal(updateStore.getRegistry(), "registry.npmmirror.com");
  assert.equal(updateStore.getRegistryUrl(), "https://registry.npmmirror.com");
  assert.equal(harness.localStorage.getItem("dsh-session-manager-registry"), "registry.npmmirror.com");

  // Set unknown/invalid key -> falls back to default
  updateStore.setRegistry("malicious.registry.com");
  assert.equal(updateStore.getRegistry(), "registry.npmjs.org");
  assert.equal(updateStore.getRegistryUrl(), "https://registry.npmjs.org");

  harness.dispose();
});

test("updateStore.checkForUpdate: sends chosen registry in query parameter", async () => {
  let queriedUrl = null;
  const harness = mountClient({
    fetchUpdateCheck: async (options, url) => {
      queriedUrl = url;
      return {
        ok: true,
        result: {
          currentVersion: "1.0.0",
          latestVersion: "1.1.0",
          hasUpdate: true
        }
      };
    }
  });

  const updateStore = harness.exports.updateStore;
  updateStore.setRegistry("registry.npmmirror.com");
  updateStore.state.status = "idle";

  await updateStore.checkForUpdate({ manual: false, silent: true, openOnFound: false });
  assert.ok(queriedUrl, "API check must be requested");
  assert.ok(queriedUrl.includes("registry=" + encodeURIComponent("https://registry.npmmirror.com")),
    "Query URL must contain encoded registry: " + queriedUrl);

  harness.dispose();
});

test("updateStore.startUpdate: sends chosen registry in install payload", async () => {
  let installPayload = null;
  const harness = mountClient({
    fetchUpdateInstall: async (body) => {
      installPayload = body;
      return {
        ok: true,
        result: { application: "restart-required", spec: "dsh-session-manager@1.2.0" }
      };
    }
  });

  const updateStore = harness.exports.updateStore;
  updateStore.setRegistry("registry.npmmirror.com");
  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "available";

  await updateStore.startUpdate({ openDialog: false });
  assert.ok(installPayload, "Install request payload must be sent");
  assert.equal(installPayload.version, "1.2.0");
  assert.equal(installPayload.registry, "https://registry.npmmirror.com");

  harness.dispose();
});

