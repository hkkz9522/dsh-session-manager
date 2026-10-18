import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

test("Settings Card: registered in settings.plugin.item slot with correct metadata", () => {
  const harness = mountClient();
  const reg = harness.registered;

  // Registered under id and key
  const slotById = reg.get("session-manager-settings");
  const slotByKey = reg.get("dsh-session-manager");
  assert.ok(slotById, "Slot must be registered by id 'session-manager-settings'");
  assert.ok(slotByKey, "Slot must be registered by key 'dsh-session-manager'");
  assert.equal(slotById, slotByKey, "Both lookups should return the same registration");

  assert.equal(slotById.options.name, "settings.plugin.item");
  assert.equal(slotById.options.key, "dsh-session-manager");
  assert.equal(slotById.options.id, "session-manager-settings");
  assert.equal(slotById.options.order, 50);

  harness.dispose();
});

test("Settings Card: renders title, version badge, sections and GitHub repository link", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = null;
  updateStore.state.status = "idle";

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const cardText = text(host.tree);

  assert.ok(cardText.includes(harness.t("settings.title")), "Card title must appear");
  assert.ok(cardText.includes("v1.0.0"), "Current version badge must appear");
  assert.ok(cardText.includes(harness.t("settings.versionSection")), "Version section title must appear");
  assert.ok(cardText.includes(harness.t("settings.prefSection")), "Preference section title must appear");
  assert.ok(cardText.includes(harness.t("settings.projectSection")), "Project section title must appear");

  // GitHub link check
  const links = nodes(host.tree, n => n.type === "a");
  const ghLink = links.find(a => a.props?.href === "https://github.com/hkkz9522/dsh-session-manager" && a.props?.className === "sm-settingsLink");
  assert.ok(ghLink, "GitHub repository link must be present");
  assert.equal(ghLink.props.target, "_blank");
  assert.equal(ghLink.props.rel, "noopener noreferrer");

  const starLink = links.find(a => a.props?.href === "https://github.com/hkkz9522/dsh-session-manager" && a.props?.className?.includes("sm-settingsBadgeLink"));
  assert.ok(starLink, "Star badge link must be present");
  assert.ok(text(starLink).includes(harness.t("settings.star")), "Star link must contain star label");
  assert.equal(starLink.props.title, undefined, "Star link must not use native title attribute");
  assert.equal(starLink.props["aria-label"], harness.t("settings.star.tip"), "Star link must have aria-label matching tip");

  const issueLink = links.find(a => a.props?.href === "https://github.com/hkkz9522/dsh-session-manager/issues");
  assert.ok(issueLink, "Issues badge link must be present");
  assert.ok(text(issueLink).includes(harness.t("settings.feedback")), "Issue link must contain feedback label");
  assert.equal(issueLink.props.title, undefined, "Issue link must not use native title attribute");
  assert.equal(issueLink.props["aria-label"], harness.t("settings.feedback.tip"), "Issue link must have aria-label matching tip");

  const badgeActions = nodes(host.tree, n => n.props?.className === "sm-settingsBadgeActions");
  assert.equal(badgeActions.length, 1, "sm-settingsBadgeActions must wrap star and feedback badges to right-align them");

  host.dispose();
  harness.dispose();
});

test("Settings Card: star and feedback badges use renderTip to match panel header tooltip format", () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(
    src,
    /renderTip\(t\("settings\.star\.tip"\),\s*h\("a",\s*\{[\s\S]*?className:\s*"sm-settingsBadgeLink"[\s\S]*?"aria-label":\s*t\("settings\.star\.tip"\)/
  );
  assert.match(
    src,
    /renderTip\(t\("settings\.feedback\.tip"\),\s*h\("a",\s*\{[\s\S]*?className:\s*"sm-settingsBadgeLink"[\s\S]*?"aria-label":\s*t\("settings\.feedback\.tip"\)/
  );
  assert.ok(
    !/className:\s*"sm-settingsBadgeLink"[^}]*title:/.test(src),
    "sm-settingsBadgeLink must not have a native title attribute"
  );
});

test("Settings Card: auto-check toggle updates updateStore and localStorage", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });

  const inputs = nodes(host.tree, n => n.type === "input" && n.props?.type === "checkbox");
  const autoCheckInput = inputs.find(i => i.props?.["aria-label"] === harness.t("update.autoCheck"));
  assert.ok(autoCheckInput, "Auto-check checkbox must be present");

  // Initially true
  assert.equal(autoCheckInput.props.checked, true);

  // Toggle off
  autoCheckInput.props.onChange({ target: { checked: false } });
  assert.equal(updateStore.getAutoCheck(), false);
  assert.equal(harness.localStorage.getItem("dsh-session-manager-auto-check"), "false");

  // Toggle on
  autoCheckInput.props.onChange({ target: { checked: true } });
  assert.equal(updateStore.getAutoCheck(), true);
  assert.equal(harness.localStorage.getItem("dsh-session-manager-auto-check"), "true");

  host.dispose();
  harness.dispose();
});

test("Settings Card: renders check button and triggers manual update check", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = null;
  updateStore.state.status = "idle";

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const buttons = nodes(host.tree, n => n.type === "button");
  const checkBtn = buttons.find(b => text(b).includes(harness.t("update.btn.check")));
  assert.ok(checkBtn, "Check for updates button must be present");

  // Click check button
  checkBtn.props.onClick();
  assert.equal(updateStore.getSnapshot().status, "checking");

  host.dispose();
  harness.dispose();
});

test("Settings Card: displays update available state and update action button", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "available";

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const cardText = text(host.tree);
  assert.ok(cardText.includes("v1.2.0"), "Latest version should be displayed");

  const buttons = nodes(host.tree, n => n.type === "button");
  const updateBtn = buttons.find(b => text(b).includes(harness.t("update.btn.update", { version: "1.2.0" })));
  assert.ok(updateBtn, "Update button should appear in available state");

  host.dispose();
  harness.dispose();
});

test("Settings Card: check update stays inline without opening modal dialog", async () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = null;
  updateStore.state.status = "idle";
  updateStore.state.dialogOpen = false;

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const buttons = nodes(host.tree, n => n.type === "button");
  const checkBtn = buttons.find(b => text(b).includes(harness.t("update.btn.check")));
  assert.ok(checkBtn, "Check for updates button must be present");

  // Click check button
  await checkBtn.props.onClick();
  assert.equal(updateStore.getSnapshot().dialogOpen, false, "Settings Card check must not open modal dialog");

  host.dispose();
  harness.dispose();
});

test("Settings Card & UpdateDialog: follow DSH theme tokens instead of a private dark palette", () => {
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // The plugin must only read DSH's theme. Redefining --dsw-alias-* locally is
  // what used to block theme (and third-party theme) overlays from reaching
  // the plugin, so pin its absence.
  const themedBodies = [...src.matchAll(/\[data-sm-theme=(?:light|dark)\][^{]*\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(themedBodies.length > 0, "the light/dark mirror must still exist");
  for (const body of themedBodies) {
    assert.ok(
      !/--dsw-/.test(body),
      "the plugin must not redefine DSH tokens, found: " + body.slice(0, 80)
    );
  }

  // No dependency on tokens that do not exist in DSH (they silently degraded
  // to their hard-coded fallbacks and blocked theming).
  for (const dead of [
    "--dsw-alias-surface-l1",
    "--dsw-alias-fill-l1",
    "--dsw-alias-fill-l2",
    "--dsw-alias-fill-l3",
    "--dsw-alias-accent-primary",
    "--dsw-alias-state-warning-primary"
  ]) {
    assert.ok(!src.includes(dead), "must not use the non-existent token " + dead);
  }

  // The card and the update dialog read real DSH tokens.
  assert.match(src, /\.sm-settingsCard\{background:var\(--sm-dialog-surface\);border:1px solid var\(--dsw-alias-border-l2,#ddd\)/);
  assert.match(src, /\.sm-settingsSelect\{[^}]*background:var\(--dsw-alias-bg-layer-2/);
  assert.match(src, /\.sm-settingsTag\{[^}]*background:var\(--dsw-alias-markdown-tag/);
  assert.match(src, /\.sm-settingsBadgeLink\{[^}]*background:var\(--dsw-alias-markdown-tag/);
  assert.match(src, /\.sm-settingsBadgeActions\{display:flex;align-items:center;gap:8px;margin-left:auto;flex:0 0 280px;width:280px;min-width:280px;max-width:280px;box-sizing:border-box;justify-content:flex-end\}/);
  assert.match(src, /\.sm-settingsRow>span:first-child\{white-space:nowrap;flex-shrink:0\}/);
  assert.match(src, /\.sm-updateVersionGrid\{[^}]*background:var\(--dsw-alias-bg-layer-2/);
  assert.match(src, /\.sm-updateVersionLabel\{color:var\(--dsw-alias-label-secondary/);
  assert.match(src, /\.sm-updateVersionValue\{color:var\(--dsw-alias-label-primary/);
  assert.match(src, /\.sm-updateDialogLayer \.sm-nativeDialog\{[^}]*background:var\(--sm-dialog-fill\)/);
});

test("Settings Card: registry selector renders options and persists choice", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });

  const selects = nodes(host.tree, n => n.type === "select");
  const registrySelect = selects.find(s => s.props?.["aria-label"] === harness.t("settings.registry"));
  assert.ok(registrySelect, "Registry select dropdown must be present");
  assert.equal(registrySelect.props.className, "sm-settingsSelect", "Registry select must use sm-settingsSelect without full-width sm-viewSelect");

  // Default value is npm official
  assert.equal(registrySelect.props.value, "registry.npmjs.org");

  // Verify all 3 options are always present in formal environment
  const options = nodes(registrySelect, n => n.type === "option");
  assert.equal(options.length, 3, "Registry selector must always render all 3 options unconditionally");
  assert.equal(options[0].props.value, "registry.npmjs.org");
  assert.equal(options[1].props.value, "registry.npmmirror.com");
  assert.equal(options[2].props.value, "127.0.0.1:4873");

  // Select China mirror
  registrySelect.props.onChange({ target: { value: "registry.npmmirror.com" } });
  assert.equal(updateStore.getRegistry(), "registry.npmmirror.com");
  assert.equal(harness.localStorage.getItem("dsh-session-manager-registry"), "registry.npmmirror.com");

  // Select local Verdaccio registry
  registrySelect.props.onChange({ target: { value: "127.0.0.1:4873" } });
  assert.equal(updateStore.getRegistry(), "127.0.0.1:4873");
  assert.equal(harness.localStorage.getItem("dsh-session-manager-registry"), "127.0.0.1:4873");

  // Switch back to official npm
  registrySelect.props.onChange({ target: { value: "registry.npmjs.org" } });
  assert.equal(updateStore.getRegistry(), "registry.npmjs.org");
  assert.equal(harness.localStorage.getItem("dsh-session-manager-registry"), "registry.npmjs.org");

  host.dispose();
  harness.dispose();
});

test("Settings Card: registered in plugins.bundle.config slot for DSH desktop compatibility", () => {
  const harness = mountClient();
  const reg = harness.registered;

  const bundleConfig = reg.get("dsh-session-manager-bundle-config");
  assert.ok(bundleConfig, "Slot must be registered under 'dsh-session-manager-bundle-config'");
  assert.equal(bundleConfig.options.name, "plugins.bundle.config");
  assert.equal(bundleConfig.options.key, "dsh-session-manager");

  // Summary view returns null
  const summaryEl = bundleConfig.component({ view: "summary" });
  assert.equal(summaryEl, null, "Summary view should render null to avoid duplicate headers");

  // Detail view returns element
  const detailEl = bundleConfig.component({ view: "detail" });
  assert.ok(detailEl, "Detail view should render Settings Card");

  harness.dispose();
});

test("Settings Card: registry select, opacity slider, and project badges align at uniform 280px width", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // Registry select, opacity slider, and badge actions share identical 280px width for vertical alignment
  assert.match(src, /\.sm-settingsSelect\{[^}]*width:280px;min-width:280px;max-width:280px;flex:0 0 280px/);
  assert.match(src, /\.sm-settingsSlider\{[^}]*flex:0 0 280px;width:280px;min-width:280px;max-width:280px/);
  assert.match(src, /\.sm-settingsBadgeActions\{[^}]*flex:0 0 280px;width:280px;min-width:280px;max-width:280px;box-sizing:border-box;justify-content:flex-end/);

  // Badge actions children share width equally without cramping
  assert.match(src, /\.sm-settingsBadgeActions>\*\{display:inline-flex;flex:1 1 0;min-width:0\}/);
  assert.match(src, /\.sm-settingsBadgeLink\{[^}]*min-height:28px;height:28px/);

  // Reset button in slider harmonizes with 28px control height
  assert.match(src, /\.sm-settingsResetBtn\{min-height:28px;height:28px;/);

  // Rows have comfortable vertical breathing room (min-height: 36px, gap: 16px, margin-top: 8px)
  assert.match(src, /\.sm-settingsRow\{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:36px;margin-top:8px\}/);

  // Opacity hint is positioned below label in column flex to prevent text collision
  assert.match(src, /\.sm-settingsRowLeft\{display:flex;flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;min-width:0;flex:1 1 auto\}/);
  assert.match(src, /\.sm-settingsHintInline\{margin-left:0;font-weight:normal\}/);
});
