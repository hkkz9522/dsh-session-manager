import { readFileSync } from "node:fs";
import { test } from "node:test";
import { strict as assert } from "node:assert";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// Every --dsw-alias-*/--dsw-specific-* token DSH declares in its theme token
// block (verified against DSH 0.2.0-rc.2: the :root/body alias layer plus
// body[data-ds-dark-theme]). The plugin may only reference tokens from this
// list: inventing a token name makes var() silently fall back to the hard-coded
// literal, which is exactly what used to block theming (e.g. the plugin read
// --dsw-alias-surface-l1, which DSH has never declared).
const DSH_DECLARED_TOKENS = new Set([
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-document-preview",
  "--dsw-alias-bg-document-selection",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-mask-1",
  "--dsw-alias-bg-mask-2",
  "--dsw-alias-bg-mask-3",
  "--dsw-alias-bg-mask-drop",
  "--dsw-alias-bg-mask-photo",
  "--dsw-alias-bg-module-platform",
  "--dsw-alias-bg-multi-select",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-bg-skeleton",
  "--dsw-alias-border-inverted",
  "--dsw-alias-border-inverted2",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-border-l2-darkmode-thin",
  "--dsw-alias-border-l3",
  "--dsw-alias-border-l4",
  "--dsw-alias-brand-primary",
  "--dsw-alias-brand-primary-invert",
  "--dsw-alias-brand-primary-new-colorprimary-new-color",
  "--dsw-alias-brand-text",
  "--dsw-alias-button-contrast-fill",
  "--dsw-alias-button-elevated-fill",
  "--dsw-alias-button-floating-fill",
  "--dsw-alias-button-floating-hover",
  "--dsw-alias-button-ghost-active-border",
  "--dsw-alias-button-ghost-active-fill",
  "--dsw-alias-button-ghost-active-hover",
  "--dsw-alias-button-info-fill",
  "--dsw-alias-button-info-hover",
  "--dsw-alias-button-primary-dimmed",
  "--dsw-alias-button-primary-fill",
  "--dsw-alias-button-primary-hover",
  "--dsw-alias-button-tool-bar-fill",
  "--dsw-alias-button-tool-bar-fill-invisible",
  "--dsw-alias-button-tool-bar-hover",
  "--dsw-alias-code-diff-added",
  "--dsw-alias-code-diff-deleted",
  "--dsw-alias-file-diff-added-bg",
  "--dsw-alias-file-diff-added-gutter",
  "--dsw-alias-file-diff-added-marker",
  "--dsw-alias-file-diff-deleted-bg",
  "--dsw-alias-file-diff-deleted-gutter",
  "--dsw-alias-file-diff-deleted-marker",
  "--dsw-alias-interactive-bg-active",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-interactive-bg-hover-accent",
  "--dsw-alias-interactive-bg-hover-danger",
  "--dsw-alias-interactive-bg-hover-solid",
  "--dsw-alias-label-caption",
  "--dsw-alias-label-deep-diving",
  "--dsw-alias-label-deep-diving-shimmer",
  "--dsw-alias-label-dimmed",
  "--dsw-alias-label-document-preview",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-primary-bluish",
  "--dsw-alias-label-primary-dimmed",
  "--dsw-alias-label-primary-foreground",
  "--dsw-alias-label-primary-inverted",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-shimmer",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-link",
  "--dsw-alias-markdown-citation",
  "--dsw-alias-markdown-code-block",
  "--dsw-alias-markdown-code-block-banner",
  "--dsw-alias-markdown-code-segment-selected",
  "--dsw-alias-markdown-code-segment-unselected",
  "--dsw-alias-markdown-inline-code",
  "--dsw-alias-markdown-placeholder",
  "--dsw-alias-markdown-tag",
  "--dsw-alias-menu-group-header-fill",
  "--dsw-alias-menu-icon",
  "--dsw-alias-scrollbar-bg-l1",
  "--dsw-alias-scrollbar-bg-l2",
  "--dsw-alias-scrollbar-hover-l1",
  "--dsw-alias-scrollbar-hover-l2",
  "--dsw-alias-state-business-primary",
  "--dsw-alias-state-business-tertiary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-error-secondary",
  "--dsw-alias-state-idle-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-success-secondary",
  "--dsw-alias-state-success-tertiary",
  "--dsw-alias-state-warn-label",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-state-warn-secondary",
  "--dsw-alias-state-warn-tertiary",
  "--dsw-alias-switch-thumb",
  "--dsw-alias-toast-bg",
  "--dsw-alias-toast-label",
  "--dsw-alias-tooltip-bg",
  "--dsw-alias-tooltip-key-bg",
  "--dsw-alias-turn-trigger-bg",
  "--dsw-alias-turn-trigger-bg-hover",
  "--dsw-menu-surface-fill",
  "--dsw-specific-bubble",
  "--dsw-specific-bubble-highlight",
  "--dsw-specific-input-major",
  "--dsw-specific-login-input",
  "--dsw-specific-menu",
  "--dsw-specific-selector",
  "--dsw-specific-sidebar-fill",
  "--dsw-specific-sidebar-nav-item-active",
  "--dsw-specific-sidebar-nav-item-active-accent",
  "--dsw-specific-sidebar-nav-item-hover",
  "--dsw-specific-tip"
]);

function referencedDshTokens(source) {
  const found = new Set();
  const re = /var\(\s*(--dsw-[a-z0-9-]+)/g;
  let m;
  while ((m = re.exec(source))) found.add(m[1]);
  return [...found].sort();
}

test("theme: every --dsw-* token the plugin reads is declared by DSH", () => {
  const unknown = referencedDshTokens(SRC).filter(t => !DSH_DECLARED_TOKENS.has(t));
  assert.deepEqual(unknown, [], "the plugin references tokens DSH does not declare: " + unknown.join(", "));
  assert.ok(referencedDshTokens(SRC).length >= 14, "the plugin should consume DSH tokens directly");
});

test("theme: the plugin never redefines a DSH theme token", () => {
  const redefinitions = [...SRC.matchAll(/--dsw-[a-z0-9-]+\s*:/g)].map(m => m[0]);
  assert.deepEqual(redefinitions, [], "DSH tokens are external input and must only be read: " + redefinitions.join(", "));
});

test("theme: the light/dark branch carries no palette of its own", () => {
  // The plugin mirrors the detected DSH theme for exactly two things, neither of
  // which is a colour palette:
  //   * --sm-dialog-surface-fallback: the token-less fallback of the opacity fill
  //   * color: the plugin-native priority colours (no DSH token exists)
  // It deliberately does NOT set `color-scheme`: native UA chrome (dropdown
  // lists, scrollbars, checkbox internals) is DSH's responsibility -- ui-layout's
  // presenter subscribes to `theme/change` and writes
  // documentElement.style.colorScheme. Forcing it from the plugin's own mirror
  // could pin native chrome to the wrong scheme (dark dropdown lists in light
  // mode) while the tokens had already moved on.
  const allowed = new Set(["--sm-dialog-surface-fallback", "color"]);
  const themedBodies = [...SRC.matchAll(/\[data-sm-theme=(?:light|dark)\][^{]*\{([^}]*)\}/g)].map(m => m[1]);
  assert.ok(themedBodies.length > 0, "the light/dark mirror must still exist for the opacity fallback");
  for (const body of themedBodies) {
    for (const decl of body.split(";")) {
      if (!decl.trim()) continue;
      const prop = decl.slice(0, decl.indexOf(":"));
      assert.ok(
        allowed.has(prop),
        "unexpected property in a light/dark branch: " + decl.trim().slice(0, 60)
      );
      assert.ok(!/--dsw-/.test(decl), "a light/dark branch must not define DSH tokens: " + decl.trim().slice(0, 60));
    }
  }
  // No rule anywhere may declare color-scheme: the plugin must not compete with
  // DSH's presenter for native UA chrome.
  for (const m of SRC.matchAll(/[^{};\n]*\{[^}]*\}/g)) {
    assert.ok(!/color-scheme\s*:/.test(m[0]), "the plugin must not declare color-scheme: " + m[0].slice(0, 80));
  }
  // The mirror is refreshed from DSH's own theme event, not only from DOM
  // attribute guessing.
  assert.match(SRC, /ctx\.on\("theme\/change", \(\) => smApplyTheme\(\)\)/);
});

test("theme: select dropdowns follow the theme instead of the platform default", () => {
  // The <select> popup is native UA chrome: it reads no --dsw-* token, so DSH's
  // palette only reaches it through color-scheme. In dark mode the plugin
  // dropdowns used to open a white list over dark surfaces. The list items get
  // explicit DSH tokens, because the UA paints them with its own default
  // background rather than the control's fill. The surface must be the OPAQUE
  // layer-3: a floating list that inherits a translucent token (a theme may give
  // layer-2 an alpha) composites over the UA's popup backdrop and still reads as
  // white. No `color-scheme` override here: native UA chrome stays DSH's job.
  assert.ok(!/color-scheme\s*:/.test(SRC.replace(/\/\/[^\n]*/g, "").replace(/"[^"]*"/g, "")),
    "the plugin must not declare color-scheme");
  assert.match(SRC, /\.sm-panelDialog option,\.sm-nativeDialog option,\.sm-settingsCard option,\.sm-headerMenu option\{background-color:var\(--dsw-alias-bg-layer-3,#fff\);color:var\(--dsw-alias-label-primary,#111\)\}/);
  assert.match(SRC, /\.sm-panelDialog option:checked,\.sm-nativeDialog option:checked,\.sm-settingsCard option:checked,\.sm-headerMenu option:checked\{background-color:var\(--dsw-alias-bg-layer-3,#fff\);color:var\(--dsw-alias-state-business-primary/);
  assert.match(SRC, /\.sm-panelDialog option:disabled,\.sm-nativeDialog option:disabled,\.sm-settingsCard option:disabled,\.sm-headerMenu option:disabled\{color:var\(--dsw-alias-label-tertiary/);
  // No dropdown-list rule may fall back to a translucent fill token.
  for (const decl of [...SRC.matchAll(/[^{};]*option[^{};]*\{([^}]*)\}/g)].map(m => m[1])) {
    assert.ok(!/bg-layer-2|interactive-bg-hover|markdown-tag|state-.*-tertiary/.test(decl),
      "the dropdown list must not use a translucent fill: " + decl.slice(0, 70));
  }
  // Every <select> in the plugin lives inside one of those four surfaces, so the
  // scoped rule covers all of them without touching DSH's own selects.
  const selectClasses = [...SRC.matchAll(/h\("select", \{[^}]*className: "([^"]+)"/g)].map(m => m[1]);
  const surfaces = selectClasses.map(c => (c.includes("sm-settingsSelect") ? "sm-settingsCard" : "sm-panelDialog"));
  assert.ok(selectClasses.length >= 4, "expected the plugin's selects to be found");
  assert.ok(surfaces.every(s => ["sm-settingsCard", "sm-panelDialog"].includes(s)));
});

test("theme: the plugin does not detect, name or read any third-party theme", () => {
  assert.ok(!/dream-skin|dreamSkin/i.test(SRC), "must not reference a specific theme plugin");
  assert.ok(!/--(?!dsw-|sm-|dsh-)[a-z0-9-]*(theme|skin)[a-z0-9-]*\s*:/i.test(SRC), "must not read private theme variables");
  assert.ok(!/themePlugins?\s*[=:[\]]/i.test(SRC), "must not enumerate theme plugins");
  assert.ok(!/detectTheme|isThemeInstalled|hasTheme/i.test(SRC), "must not detect installed themes");
});

test("theme: each UI semantic reads the matching DSH token", () => {
  // primary surface
  assert.match(SRC, /\.sm-panelDialog\{[^}]*background:var\(--sm-dialog-fill\)/);
  assert.match(SRC, /\.sm-nativeDialog,\.sm-panelDialog,\.sm-migrateDialog,\.sm-settingsCard\{--sm-dialog-surface:var\(--dsw-alias-bg-layer-1/);
  // secondary fill
  assert.match(SRC, /\.sm-settingsSelect\{[^}]*background:var\(--dsw-alias-bg-layer-2/);
  assert.match(SRC, /\.sm-settingsTag\{[^}]*background:var\(--dsw-alias-markdown-tag/);
  assert.match(SRC, /\.sm-panelDialog \.sm-rowCurrent\{background:var\(--dsw-alias-bg-module-platform\)/);
  // hover
  assert.match(SRC, /\.sm-panelDialog \.sm-row:hover\{background:var\(--dsw-alias-interactive-bg-hover\)\}/);
  assert.match(SRC, /\.sm-panelDialog \.sm-rowActions \.sm-rowBtn:hover\{background:var\(--dsw-alias-interactive-bg-hover\)/);
  // text
  assert.match(SRC, /\.sm-panelDialog\{[^}]*color:var\(--dsw-alias-label-primary/);
  assert.match(SRC, /\.sm-rowMeta\{color:var\(--dsw-alias-label-tertiary/);
  assert.match(SRC, /\.sm-bulkResultHeader\{font-size:12px;line-height:18px;font-weight:500;color:var\(--dsw-alias-label-secondary/);
  // border
  assert.match(SRC, /\.sm-panelDialog\{[^}]*border:1px solid var\(--dsw-alias-border-l2/);
  assert.match(SRC, /\.sm-settingsSection\{margin-top:14px;padding-top:12px;border-top:1px solid var\(--dsw-alias-border-l2/);
  // accent / error / warning
  assert.match(SRC, /\.sm-settingsLink\{color:var\(--dsw-alias-state-business-primary/);
  assert.match(SRC, /\.sm-nativeDialogDanger\{background:var\(--dsw-alias-state-error-primary/);
  assert.match(SRC, /\.sm-warn\{[^}]*background:var\(--dsw-alias-state-warn-tertiary/);
  assert.match(SRC, /\.sm-updateStatusBox\.sm-success\{color:var\(--dsw-alias-state-success-primary/);
  // inputs / select / badge / tooltip
  assert.match(SRC, /\.sm-queryInput,\.sm-viewSelect\{[^}]*background:var\(--dsw-alias-bg-layer-2/);
  assert.match(SRC, /\.sm-noteInput\{[^}]*background:var\(--dsw-alias-bg-layer-2/);
  assert.match(SRC, /\.sm-tagChip,\.sm-noteBadge\{[^}]*background:var\(--dsw-alias-markdown-tag/);
  assert.match(SRC, /\.sm-priorityBadge\{[^}]*background:var\(--dsw-alias-markdown-tag/);
  assert.match(SRC, /\.sm-tooltip\{[^}]*border:1px solid var\(--dsw-alias-border-l2/);
  // header menu / button / filter button
  assert.match(SRC, /\.sm-headerMenu\{[^}]*background:var\(--dsw-alias-bg-layer-2/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*background:var\(--dsw-alias-button-floating-fill/);
  assert.match(SRC, /\.sm-headerBtnDanger\{background:var\(--dsw-alias-button-floating-fill/);
  assert.match(SRC, /\.sm-bulkBar \.sm-bulkBtn\{[^}]*background:transparent/);
  assert.match(SRC, /\.sm-panelDialog \.sm-rowActions \.sm-rowBtnDanger:hover\{background:var\(--dsw-alias-interactive-bg-hover-danger\)/);
  // Every dialog's secondary/dismiss button shares one recipe: transparent
  // fill, the same border, radius and metrics, and one shared hover -- the
  // migrate dialog used to be the odd one out with a filled (white) button.
  assert.match(SRC, /\.sm-migrateDialog \.sm-nativeDialogButton\{[^}]*background-color:transparent/);
  assert.match(SRC, /\.sm-panelDialog \.sm-nativeDialogButton\{min-height:28px;padding:3px 14px;font-size:12px;line-height:20px;border:1px solid var\(--dsw-alias-border-l2\);border-radius:8px;background:transparent/);
  assert.match(SRC, /\.sm-confirmDialog \.sm-nativeDialogCancel:hover:not\(:disabled\),\.sm-migrateDialog \.sm-nativeDialogCancel:hover:not\(:disabled\),\.sm-updateDialog \.sm-nativeDialogCancel:hover:not\(:disabled\),\.sm-bulkDialog \.sm-nativeDialogCancel:hover:not\(:disabled\),\.sm-panelDialog \.sm-nativeDialogCancel:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover\)\}/);
  assert.match(SRC, /\.sm-importBtn\{[^}]*min-height:28px;padding:3px 14px;font-size:12px;line-height:20px;text-align:center\}/);
  // Dead button/edit-control rules stay removed.
  for (const dead of [".sm-danger", ".sm-dangerText", ".sm-nativeDialogGhost", ".sm-panelHeaderSelect"]) {
    assert.ok(!SRC.includes(dead + "{") && !SRC.includes(dead + ":"), "dead rule must stay removed: " + dead);
  }
  // The annotation import area uses the same label+field format as the fields
  // above it (no separate surface band; the status box is not double-inset).
  assert.match(SRC, /\.sm-importGroup\{display:flex;flex-direction:column;gap:8px;padding:12px 16px;border-top:1px solid var\(--dsw-alias-border-l2/);
  assert.match(SRC, /\.sm-importLabel\{color:var\(--dsw-alias-label-secondary/);
  assert.match(SRC, /\.sm-importStatus\{margin:0;/);
  assert.match(SRC, /\.sm-filterBtn\.sm-on\{color:var\(--dsw-alias-label-primary\);background:var\(--dsw-alias-bg-module-platform\)/);
  // annotation / marks dialog
  assert.match(SRC, /\.sm-annotationTarget\{font-size:12px;line-height:18px[^}]*color:var\(--dsw-alias-label-secondary/);
  assert.match(SRC, /\.sm-annotationChecks \.sm-prioritySelectInline\{[^}]*color:var\(--dsw-alias-label-primary/);
});

test("theme: the dialog-opacity setting is unchanged (name, default, range, storage)", () => {
  assert.match(SRC, /const SM_DIALOG_OPACITY = \{ min: 50, max: 100, step: 5, default: 100 \}/);
  assert.match(SRC, /const SM_DIALOG_OPACITY_KEY = "dsh-session-manager-dialog-opacity"/);
  assert.match(SRC, /const SM_DIALOG_OPACITY_VAR = "--sm-dialog-opacity"/);
  assert.match(SRC, /--sm-dialog-fill:color-mix\(in srgb,var\(--sm-dialog-surface\) var\(--sm-dialog-opacity,100%\),transparent\)/);
  // The fill is built on DSH's own surface token, so the setting only controls
  // the alpha channel and never a colour of its own.
  assert.match(SRC, /--sm-dialog-surface:var\(--dsw-alias-bg-layer-1,var\(--sm-dialog-surface-fallback,#fff\)\)/);
});
