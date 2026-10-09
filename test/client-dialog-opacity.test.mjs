import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const OPACITY_VAR = "--sm-dialog-opacity";
const STORAGE_KEY = "dsh-session-manager-dialog-opacity";

// =========================================================================
// 1. Preference: default, persistence, normalization
// =========================================================================

test("dialog opacity: defaults to 100% and publishes the CSS variable on load", () => {
  const harness = mountClient();
  const { updateStore } = harness.exports;

  assert.equal(updateStore.getDialogOpacity(), 100, "default dialog opacity must be 100");
  assert.equal(updateStore.DIALOG_OPACITY.min, 50);
  assert.equal(updateStore.DIALOG_OPACITY.max, 100);
  assert.equal(updateStore.DIALOG_OPACITY.step, 5);
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), null, "the default must not write storage");

  // The CSS variable is published at bundle load, before any dialog renders.
  assert.equal(harness.rootStyleValues.get(OPACITY_VAR), "100%");

  harness.dispose();
});

test("dialog opacity: a stored value is restored on load", () => {
  const harness = mountClient({ initialStorage: { [STORAGE_KEY]: "65" } });
  const { updateStore } = harness.exports;

  assert.equal(updateStore.getDialogOpacity(), 65, "stored value must be restored");
  assert.equal(harness.rootStyleValues.get(OPACITY_VAR), "65%", "restored value must reach the CSS variable");

  harness.dispose();
});

test("dialog opacity: setDialogOpacity persists to localStorage and updates the CSS variable", () => {
  const harness = mountClient();
  const { updateStore } = harness.exports;

  assert.equal(updateStore.setDialogOpacity(80), 80);
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), "80");
  assert.equal(harness.rootStyleValues.get(OPACITY_VAR), "80%");

  // Survives a "reload" through the storage read path.
  assert.equal(updateStore.getDialogOpacity(), 80);

  harness.dispose();
});

test("dialog opacity: values are clamped to 50..100 and snapped to the 5% step", () => {
  const harness = mountClient();
  const { updateStore } = harness.exports;

  updateStore.setDialogOpacity(10);
  assert.equal(updateStore.getDialogOpacity(), 50, "below the minimum clamps up to 50");

  updateStore.setDialogOpacity(400);
  assert.equal(updateStore.getDialogOpacity(), 100, "above the maximum clamps down to 100");

  updateStore.setDialogOpacity(73);
  assert.equal(updateStore.getDialogOpacity(), 75, "off-step values snap to the nearest 5%");

  updateStore.setDialogOpacity(Number.NaN);
  assert.equal(updateStore.getDialogOpacity(), 100, "a non-numeric value falls back to the default");

  // Persisted garbage is normalized too.
  harness.localStorage.setItem(STORAGE_KEY, "banana");
  assert.equal(updateStore.getDialogOpacity(), 100);
  harness.localStorage.setItem(STORAGE_KEY, "88");
  assert.equal(updateStore.getDialogOpacity(), 90);

  harness.dispose();
});

test("dialog opacity: resetDialogOpacity restores 100%", () => {
  const harness = mountClient();
  const { updateStore } = harness.exports;

  updateStore.setDialogOpacity(55);
  assert.equal(harness.rootStyleValues.get(OPACITY_VAR), "55%");

  updateStore.resetDialogOpacity();
  assert.equal(updateStore.getDialogOpacity(), 100);
  assert.equal(harness.rootStyleValues.get(OPACITY_VAR), "100%");
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), "100");

  harness.dispose();
});

// =========================================================================
// 2. Settings card UI
// =========================================================================

test("dialog opacity: settings card renders a 50..100 slider at 5% steps showing the current value", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard } = harness.exports;

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const slider = nodes(host.tree, node => node.type === "input" && node.props?.type === "range")
    .find(node => node.props?.["aria-label"] === harness.t("settings.dialogOpacity"));

  assert.ok(slider, "the dialog-opacity slider must be present in the settings card");
  assert.equal(slider.props.min, 50);
  assert.equal(slider.props.max, 100);
  assert.equal(slider.props.step, 5);
  assert.equal(slider.props.value, 100, "slider starts at the default 100%");
  assert.equal(slider.props["aria-valuetext"], "100%");

  // The percentage is also rendered as text next to the slider.
  assert.ok(text(host.tree).includes(harness.t("settings.dialogOpacity")), "label must be rendered");
  assert.ok(text(host.tree).includes("100%"), "current percentage must be rendered");
  assert.ok(text(host.tree).includes(harness.t("settings.dialogOpacity.hint")), "hint must be rendered");

  host.dispose();
  harness.dispose();
});

test("dialog opacity: moving the slider updates the store, storage and CSS; reset restores 100%", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const findSlider = () => nodes(host.tree, node => node.type === "input" && node.props?.type === "range")
    .find(node => node.props?.["aria-label"] === harness.t("settings.dialogOpacity"));

  const resetBtn = () => nodes(host.tree, node => node.type === "button" && node.props?.className === "sm-settingsResetBtn")[0];

  assert.equal(resetBtn().props.disabled, true, "reset is disabled while the default is active");

  findSlider().props.onChange({ target: { value: "70" } });
  assert.equal(updateStore.getDialogOpacity(), 70);
  assert.equal(harness.localStorage.getItem(STORAGE_KEY), "70");
  assert.equal(harness.rootStyleValues.get(OPACITY_VAR), "70%", "moving the slider takes effect immediately");

  host.render();
  assert.equal(findSlider().props.value, 70);
  assert.ok(text(host.tree).includes("70%"));
  assert.equal(resetBtn().props.disabled, false, "reset becomes available once the value changed");

  resetBtn().props.onClick();
  assert.equal(updateStore.getDialogOpacity(), 100);
  assert.equal(harness.rootStyleValues.get(OPACITY_VAR), "100%");

  host.dispose();
  harness.dispose();
});

test("dialog opacity: settings card renders English labels through the existing dictionary", () => {
  const harness = mountClient({ language: "en" });
  const { SessionManagerSettingsCard } = harness.exports;

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const cardText = text(host.tree);

  assert.ok(cardText.includes(harness.t("settings.dialogOpacity")), "English label must come from the en dictionary");
  assert.equal(harness.t("settings.dialogOpacity"), "Dialog opacity");
  assert.equal(harness.t("settings.dialogOpacity.reset"), "Reset to default");

  host.dispose();
  harness.dispose();
});

// =========================================================================
// 3. CSS: opacity applies to the dialog fill only
// =========================================================================

test("dialog opacity css: a single custom property drives the fill through color-mix on a DSH token", () => {
  assert.match(SRC, /:root\{--sm-dialog-opacity:100%\}/);
  assert.match(SRC, /--sm-dialog-surface:var\(--dsw-alias-bg-layer-1,var\(--sm-dialog-surface-fallback,#fff\)\)/);
  assert.match(SRC, /--sm-dialog-fill:color-mix\(in srgb,var\(--sm-dialog-surface\) var\(--sm-dialog-opacity,100%\),transparent\)/);

  // The static colour is only a token-less fallback and it follows the
  // mirrored light/dark theme. It is declared on <html> AND on the dialog
  // roots themselves, so the fallback still works even if some ancestor were
  // to stop custom-property inheritance.
  assert.match(SRC, /html\[data-sm-theme=light\]\{--sm-dialog-surface-fallback:#fff\}/);
  assert.match(SRC, /html\[data-sm-theme=dark\]\{--sm-dialog-surface-fallback:#1f1f23\}/);
  assert.match(SRC, /\[data-sm-theme=light\] \.sm-panelDialog[^{]*\{--sm-dialog-surface-fallback:#fff\}/);
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-panelDialog[^{]*\{[^}]*--sm-dialog-surface-fallback:#1f1f23\}/);

  // Never applied as whole-element opacity, which would also fade text,
  // buttons, icons and borders.
  assert.ok(!/opacity:var\(--sm-dialog-opacity/.test(SRC), "must not use whole-element opacity");
  assert.equal(
    (SRC.match(/--sm-dialog-opacity/g) || []).length,
    3,
    "--sm-dialog-opacity should only appear as: JS var name, :root default, and the color-mix fill"
  );
});

test("dialog opacity css: 100% reproduces the DSH token verbatim, alpha included", () => {
  // color-mix(in srgb, C 100%, transparent) === C, its alpha included. So the
  // default setting never forces an originally translucent DSH surface (or a
  // translucency a theme gave it) to become opaque; the plugin only ADDS
  // translucency when the user lowers the slider.
  assert.match(SRC, /--sm-dialog-fill:color-mix\(in srgb,var\(--sm-dialog-surface\) var\(--sm-dialog-opacity,100%\),transparent\)/);
  assert.match(SRC, /:root\{--sm-dialog-opacity:100%\}/);
  // The surface must be the token itself -- not a token wrapped in extra alpha,
  // and not pinned opaque.
  assert.match(SRC, /--sm-dialog-surface:var\(--dsw-alias-bg-layer-1,var\(--sm-dialog-surface-fallback,#fff\)\)/);
  assert.ok(!/--sm-dialog-surface:[^;}]*color-mix/.test(SRC),
    "the surface must not pre-mix its own alpha (that would double-apply the setting)");
  assert.ok(!/--sm-dialog-fill:[^;}]*!important/.test(SRC),
    "the computed fill must not be pinned with !important");
  // The fill must not be re-mixed a second time anywhere.
  assert.ok(!/color-mix\([^)]*var\(--sm-dialog-fill\)/.test(SRC),
    "var(--sm-dialog-fill) must not be fed back into another color-mix");
  // And no dialog root may reduce the whole element's opacity.
  const roots = [
    ".sm-panelDialog{position:fixed",
    ".sm-confirmDialog.sm-nativeDialogLayer .sm-nativeDialog{position:relative",
    ".sm-migrateDialog{position:fixed",
    ".sm-updateDialogLayer .sm-nativeDialog{position:relative",
    ".sm-bulkDialog.sm-nativeDialogLayer .sm-nativeDialog{position:relative"
  ];
  for (const root of roots) {
    const i = SRC.indexOf(root);
    assert.ok(i > 0, "dialog surface rule must exist: " + root);
    const body = SRC.slice(i, SRC.indexOf("}", i));
    assert.ok(!/(^|[;{])opacity\s*:/.test(body),
      "dialog surface must not set whole-element opacity: " + root.slice(0, 40));
  }
});

test("dialog opacity: internal controls read their own DSH tokens, never the dialog fill", () => {
  // "Unified theme source, but NOT unified opacity": inputs, selects, cards,
  // buttons and menus must stay at their own tokens' opacity so they remain
  // readable when the dialog behind them is made translucent.
  const start = SRC.indexOf("const css = [");
  const items = eval("[" + SRC.slice(start + "const css = [".length, SRC.indexOf('].join("");', start)) + "]");
  const css = items.join("");

  const rules = [];
  let depth = 0, buf = "";
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "{") { depth++; if (depth === 1) { rules.push({ sel: buf.trim(), body: "" }); buf = ""; } else rules[rules.length - 1].body += ch; continue; }
    if (ch === "}") { depth--; if (depth > 0) rules[rules.length - 1].body += ch; continue; }
    if (depth === 0) buf += ch; else rules[rules.length - 1].body += ch;
  }

  const controls = /sm-queryInput|sm-viewSelect|sm-noteInput|sm-settingsSelect|sm-tagChip|sm-noteBadge|sm-priorityBadge|sm-headerMenu|sm-headerMenuItem|sm-headerBtn|sm-bulkBtn|sm-importBtn|sm-filterBtn|sm-rowCurrent|sm-rowBtn|sm-settingsCard|sm-settingsTag|sm-settingsBadgeLink|sm-tooltip|sm-migrateChip|sm-nativeDialogButton|sm-progress|sm-bulkProgressBar|sm-settingsRange|sm-settingsResetBtn/;
  const offenders = [];
  for (const r of rules) {
    if (!controls.test(r.sel)) continue;
    // The definition rule declares the variables (for the dialog roots, one of
    // which is the settings card); what matters is that no control CONSUMES
    // them. Consumers reference them through var(), never via a declaration.
    const declares = /(^|;)--sm-dialog-(?:surface|fill|opacity)\s*:/.test(r.body.replace(/^\s*/, ""));
    const consumes = !declares && /var\(--sm-dialog-opacity|var\(--sm-dialog-fill/.test(r.body);
    if (consumes) offenders.push(r.sel.slice(0, 90));
  }
  assert.deepEqual(offenders, [],
    "internal controls must not inherit the dialog opacity: " + offenders.join(" | "));

  // They must still be token-driven (not left with hard-coded surfaces).
  for (const [sel, token] of [
    [".sm-queryInput,.sm-viewSelect", "--dsw-alias-bg-layer-2"],
    [".sm-noteInput", "--dsw-alias-bg-layer-2"],
    [".sm-settingsSelect", "--dsw-alias-bg-layer-2"],
    [".sm-headerMenu", "--dsw-alias-bg-layer-2"],
    [".sm-tagChip,.sm-noteBadge", "--dsw-alias-markdown-tag"],
    [".sm-settingsTag", "--dsw-alias-markdown-tag"],
    [".sm-bulkBar .sm-bulkBtn", "background:transparent"],
    [".sm-importBtn", "background:transparent"],
    [".sm-panelDialog .sm-rowCurrent", "--dsw-alias-bg-module-platform"],
    [".sm-panelDialog .sm-filterBtn.sm-on", "--dsw-alias-bg-module-platform"]
  ]) {
    const rule = rules.find(r => r.sel === sel);
    assert.ok(rule, "expected control rule: " + sel);
    assert.ok(rule.body.includes(token), sel + " must read " + token);
  }

  // The settings card is the one surface that uses the opacity base colour --
  // and it must use the OPAQUE base, not the alpha-mixed fill.
  const card = rules.find(r => r.sel === ".sm-settingsCard");
  assert.ok(card && /background:var\(--sm-dialog-surface\)/.test(card.body),
    "the settings card must use the opaque --sm-dialog-surface, not --sm-dialog-fill");
});

test("dialog opacity css: text, buttons, inputs and borders never follow the opacity setting", () => {
  const opacityDriven = /--sm-dialog-opacity/;
  const rules = [
    /\.sm-confirmDialog \.sm-nativeDialogButton\{([^}]*)\}/,
    /\.sm-confirmDialog \.sm-nativeDialogConfirm\{([^}]*)\}/,
    /\.sm-confirmDialog \.sm-nativeDialogDanger,\.sm-migrateDialog \.sm-nativeDialogDanger,\.sm-bulkDialog \.sm-nativeDialogDanger\{([^}]*)\}/,
    /\.sm-bulkDialog \.sm-nativeDialogButton\{([^}]*)\}/,
    /\.sm-updateDialog \.sm-nativeDialogButton\{([^}]*)\}/,
    /\.sm-queryInput,\.sm-viewSelect\{([^}]*)\}/,
    /\.sm-noteInput\{([^}]*)\}/,
    /\.sm-nativeDialogHeader\{([^}]*)\}/,
    /\.sm-nativeDialogTitle\{([^}]*)\}/,
  ];
  for (const pattern of rules) {
    const match = pattern.exec(SRC);
    assert.ok(match, "expected rule to exist: " + pattern);
    assert.ok(!opacityDriven.test(match[1]), "rule must not be tied to the opacity setting: " + match[0].slice(0, 60));
  }

  // Buttons/inputs keep their own DSH colours.
  assert.match(SRC, /\.sm-confirmDialog \.sm-nativeDialogConfirm\{background:var\(--dsw-alias-state-business-primary,#356ae6\);color:var\(--dsw-alias-label-primary-foreground,#fff\)/);
  assert.match(SRC, /\.sm-migrateDialog \.sm-nativeDialogDanger[\s\S]{0,200}background:var\(--dsw-alias-state-error-primary/);
});

test("dialog opacity css: every plugin dialog surface routes through the shared fill", () => {
  const surfaces = [
    /\.sm-panelDialog\{[^}]*background:var\(--sm-dialog-fill\)/,
    /\.sm-confirmDialog\.sm-nativeDialogLayer \.sm-nativeDialog\{[^}]*background:var\(--sm-dialog-fill\)/,
    /\.sm-migrateDialog\.sm-nativeDialogLayer \.sm-nativeDialog\{[^}]*background-color:var\(--sm-dialog-fill\)/,
    /\.sm-migrateDialog\{[^}]*background-color:var\(--sm-dialog-fill\)/,
    /\.sm-updateDialogLayer \.sm-nativeDialog\{[^}]*background:var\(--sm-dialog-fill\)/,
    /\.sm-bulkDialog\.sm-nativeDialogLayer \.sm-nativeDialog\{[^}]*background:var\(--sm-dialog-fill\)/,
  ];
  for (const pattern of surfaces) {
    assert.match(SRC, pattern, "dialog surface must use the shared fill: " + pattern);
  }

  // .sm-nativeDialog covers the annotation surface, the move dialog and the
  // nested migrate-confirm surface too, so they inherit the same fill.
  assert.match(SRC, /\.sm-nativeDialog,\.sm-panelDialog,\.sm-migrateDialog,\.sm-settingsCard\{--sm-dialog-surface:/);
  assert.match(SRC, /const surfaceClass = "sm-nativeDialog sm-panelDialog sm-annotationSurface"/);
});

test("dialog opacity css: dialog chrome stays transparent so the alpha is applied exactly once", () => {
  // Header/body/footer must not paint their own opaque fill on top of the
  // translucent dialog root, otherwise a 50% setting would still look opaque.
  const chrome = [
    /\.sm-panelDialog \.sm-nativeDialogHeader\{([^}]*)\}/,
    /\.sm-confirmDialog \.sm-nativeDialogHeader\{([^}]*)\}/,
    /\.sm-updateDialog \.sm-nativeDialogHeader\{([^}]*)\}/,
    /\.sm-updateDialog \.sm-nativeDialogFooter\{([^}]*)\}/,
    /\.sm-bulkDialog \.sm-nativeDialogHeader\{([^}]*)\}/,
    /\.sm-bulkDialog \.sm-nativeDialogFooter\{([^}]*)\}/,
  ];
  for (const pattern of chrome) {
    const match = pattern.exec(SRC);
    assert.ok(match, "expected rule to exist: " + pattern);
    assert.ok(!/background(-color)?\s*:/.test(match[1]), "dialog chrome must not set its own background: " + match[0].slice(0, 60));
  }

  // The migrate dialog used to repaint #fff on its header/panel/body/footer.
  assert.match(SRC, /\.sm-migrateDialog \.sm-nativeDialogBody\{padding:0\}/);
  assert.match(SRC, /\.sm-migrateDialog \.sm-migratePanel\{padding:12px 18px;display:flex;flex-direction:column;gap:14px\}/);
  assert.match(SRC, /\.sm-migrateDialog \.sm-nativeDialogFooter\{[^}]*gap:8px\}/);
});

test("dialog opacity css: no hard-coded white/dark background locks or blur/opacity locks remain", () => {
  assert.ok(!/background(-color)?:#fff!important/.test(SRC), "#fff!important backgrounds must be gone");
  assert.ok(!/background(-color)?:#1f1f23!important/.test(SRC), "#1f1f23!important backgrounds must be gone");
  assert.ok(!/backdrop-filter:none/.test(SRC), "forced backdrop-filter:none must be gone");
  assert.ok(!/\.sm-panelDialog\{[^}]*opacity:1[;}]/.test(SRC), "forced opacity:1 on the panel dialog must be gone");
  assert.ok(!/\.sm-migrateDialog\{[^}]*opacity:1/.test(SRC), "forced opacity:1 on the migrate dialog must be gone");

  // No inline !important colours written onto dialog roots any more: that is
  // what used to override third-party themes unconditionally.
  assert.ok(!/smApplyInlineTheme/.test(SRC), "inline dialog theme forcing must be removed");
  assert.ok(!/style\.setProperty\("background"/.test(SRC), "no inline background must be written onto dialogs");
  assert.ok(!/style\.setProperty\("color"/.test(SRC), "no inline colour must be written onto dialogs");
  assert.ok(!/style\.setProperty\("border-color"/.test(SRC), "no inline border colour must be written onto dialogs");
});

test("dialog opacity css: the injected stylesheet really carries the fill rules", () => {
  const harness = mountClient();
  const injected = harness.styleTags
    .filter(tag => tag.dataset?.pluginCss === "dsh-session-manager/session-manager")
    .map(tag => String(tag.textContent || ""))
    .join("\n");

  assert.ok(injected.length > 0, "the plugin stylesheet must be appended to <head>");
  assert.ok(injected.includes("--sm-dialog-fill:color-mix(in srgb,var(--sm-dialog-surface) var(--sm-dialog-opacity,100%),transparent)"));
  assert.ok(injected.includes("--sm-dialog-surface:var(--dsw-alias-bg-layer-1,var(--sm-dialog-surface-fallback,#fff))"));
  assert.ok(injected.includes("html[data-sm-theme=dark]{--sm-dialog-surface-fallback:#1f1f23}"));
  assert.ok(injected.includes("background:var(--sm-dialog-fill)"));
  // Balanced braces: an unclosed rule would make the browser drop later rules.
  assert.equal(
    (injected.match(/\{/g) || []).length,
    (injected.match(/\}/g) || []).length,
    "the injected stylesheet must be brace-balanced"
  );

  harness.dispose();
});

test("dialog opacity css: a plugin reload rewrites the existing stylesheet instead of reusing it", () => {
  // Client-plugin hot reload re-executes the bundle in the same page but keeps
  // the <style> tag created earlier. If the injection path skipped the write
  // whenever a tag already existed, new rules (like the dialog fill) never
  // reached the DOM while the new JS was already live -- the setting appeared
  // to do nothing.
  const injection = /const SM_CSS_SELECTOR[\s\S]*?styleTag\.textContent = css;\r?\n\s*\}/.exec(SRC);
  assert.ok(injection, "the stylesheet writer must assign textContent unconditionally");

  const createBranch = /if \(!styleTag\) \{([\s\S]*?)\n {6}\}/.exec(injection[0]);
  assert.ok(createBranch, "expected an explicit create-only branch");
  assert.ok(
    !/textContent/.test(createBranch[1]),
    "writing the CSS must not live inside the create-only branch"
  );
  assert.ok(
    /styleTag\.textContent = css;/.test(injection[0]),
    "the CSS write must run on every load"
  );
});

test("dialog opacity css: no dependency on a specific third-party theme or its private variables", () => {
  assert.ok(!/dsh-dream-skin/.test(SRC), "must not reference any specific theme plugin");
  assert.ok(!/dream-skin/.test(SRC), "must not reference any specific theme plugin");
  assert.ok(
    !/--dsh-[a-z-]*modal-(fill|opacity|surface)/.test(SRC),
    "must not read third-party private theme variables"
  );
});
