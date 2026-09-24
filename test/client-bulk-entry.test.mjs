
/**
 * Static source guards for the v0.5.2 bulk-management entry-point fix.
 *
 * Issue #13 ships a non-trivial bulk surface (BulkActionBar, three
 * Batch* dialogs, two input dialogs, a runBatch wrapper, panel
 * integration) but the first release of the feature had no UI way to
 * enter selection mode: both the row checkboxes and the BulkActionBar
 * were gated behind \`selectedIds.size > 0\`. This file pins down the
 * fix so the regression cannot silently come back.
 *
 * The test is intentionally static (text-level) because the existing
 * \`mountClient\` harness in \`test/helpers/client-harness.mjs\` does
 * not expose \`selectedIds\` or \`selectModeEnabled\` to the outside,
 * so UI-driven coverage is not practical. Static guards complement
 * the runBatch unit tests and the bulk-actions / selection
 * static-guard suites by asserting the structural pieces that make
 * the entry point reachable from the rendered tree.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const CHANGELOG = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

function countMatches(pat) {
  let n = 0;
  let pos = 0;
  while ((pos = SRC.indexOf(pat, pos)) >= 0) { n++; pos += pat.length; }
  return n;
}

test("entry: selectModeEnabled state is declared inside SessionManagerPanel", () => {
  const matches = SRC.match(/const \[selectModeEnabled, setSelectModeEnabled\] = useState\(false\)/g) || [];
  assert.ok(matches.length >= 1, "expected selectModeEnabled useState declaration");
});

test("entry: selectModeEnabled is reset alongside other bulk state when the panel closes", () => {
  const blockRe = /if \(!open\) \{[\s\S]*?setSelectModeEnabled\(false\);[\s\S]*?\}/;
  assert.match(SRC, blockRe, "selectModeEnabled should be reset to false in the open-close useEffect");
});

test("entry: row checkboxes are gated by (selectedIds.size === 0 && !selectModeEnabled)", () => {
  const gateRe = /selectedIds\.size === 0 && !selectModeEnabled/;
  assert.match(SRC, gateRe, "row checkbox gate must include selectModeEnabled");
  const rowCheckboxRe = /sm-bulkRowCheckbox[\s\S]{0,200}h\("input",\s*\{[\s\S]{0,200}type:\s*"checkbox"/;
  assert.match(SRC, rowCheckboxRe, "row checkbox must render an h('input', type: 'checkbox')");
});

test("entry: BulkActionBar renders whenever selectModeEnabled is on or there are selections", () => {
  const gateRe = /selectedIds\.size > 0 \|\| selectModeEnabled/;
  assert.match(SRC, gateRe, "BulkActionBar gate must include selectModeEnabled");
});

test("entry: panel toolbar renders a bulk-mode toggle button in its own group", () => {
  // The bulk-mode entry point lives in the toolbar row, sitting in
  // its own sm-markFiltersGroup between the filter buttons and the
  // bulk-toggle group (全选当前筛选 / 清空选择). It uses the
  // standard sm-filterBtn pill style so it blends with the row.
  assert.match(SRC, /className: "sm-filterBtn"\s*\+\s*\(selectModeEnabled \? " sm-on" : ""\),[\s\S]{0,300}?onClick: toggleSelectMode/);
  assert.match(SRC, /"aria-pressed": selectModeEnabled/);
  // The header no longer carries the toggle (only the close button).
  // Note: sm-panelHeaderSelect may still appear as a stale CSS class
  // definition, but it must not be wired up in the JSX anymore.
  assert.ok(!SRC.includes('className: "sm-panelHeaderSelect"'),
    "sm-panelHeaderSelect must not be used in the panel JSX anymore");
});

test("entry: toggleSelectMode clears selection on exit", () => {
  const re = /const toggleSelectMode = \(\) => \{[\s\S]*?clearSelection\(\);[\s\S]*?\};/;
  assert.match(SRC, re, "toggleSelectMode must call clearSelection when leaving select mode");
});

test("entry: locale keys for select-mode are present in both zh and en", () => {
  for (const key of ["panel.selectMode", "panel.selectMode.exit", "panel.selectMode.aria", "panel.selectMode.active.aria"]) {
    assert.match(SRC, new RegExp('"' + key.replace(/\./g, "\\.") + '":'), "locale key " + key + " missing");
  }
  for (const key of ["panel.selectMode", "panel.selectMode.exit", "panel.selectMode.aria", "panel.selectMode.active.aria"]) {
    const n = countMatches('"' + key + '"');
    assert.ok(n >= 2, "locale key " + key + " must appear in both dictionaries (got " + n + ")");
  }
});

test("entry: bulk-mode toggle reuses the sm-filterBtn .sm-on modifier (no longer its own class)", () => {
  // The toggle now reuses the standard sm-filterBtn pill style.
  // Its active state is signalled by the same .sm-on modifier
  // that drives 全部 / 未归档 / 已归档.
  assert.match(SRC, /\.sm-filterBtn\.sm-on\{[^}]*label-primary/);
});

test("entry: CHANGELOG 0.5.2 mentions the missing entry-point fix", () => {
  assert.match(CHANGELOG, /## 0\.5\.2 .* 2026-09-23/);
  assert.match(CHANGELOG, /\*\*fix\(bulk management\)\*\*: add a missing entry-point/);
});


test("entry: bulk dialogs are reachable (no early return above the bulk-dialog declarations)", () => {
  // Issue discovered together with the missing entry point: the panel
  // had a duplicated \`return h(React.Fragment, null, panelModal, ...)\`
  // above the bulkPreviewDialog / bulkProgressDialog / bulkResultDialog
  // declarations. The early return made every bulk dialog unreachable,
  // so even though /batch fired, the user never saw the progress or
  // result UI. This guard scopes to the SessionManagerPanel return
  // (which always mentions panelModal) and pins that exactly one such
  // return exists, and it sits after every bulk-dialog declaration.
  const panelFragmentReturns = SRC.match(/return h\(React\.Fragment, null, panelModal/g) || [];
  assert.ok(panelFragmentReturns.length === 1, "exactly one panel Fragment return expected, got " + panelFragmentReturns.length);
  const finalReturnIdx = SRC.lastIndexOf("return h(React.Fragment, null, panelModal");
  const bulkResultIdx = SRC.indexOf("const bulkResultDialog");
  const bulkPresetIdx = SRC.indexOf("const bulkPresetDialog");
  assert.ok(bulkResultIdx > 0, "bulkResultDialog must be declared");
  assert.ok(bulkPresetIdx > 0, "bulkPresetDialog must be declared");
  assert.ok(finalReturnIdx > bulkResultIdx, "Fragment return must come after bulkResultDialog");
  assert.ok(finalReturnIdx > bulkPresetIdx, "Fragment return must come after bulkPresetDialog");
});

test("entry: BulkActionBar exposes a migrate-preset button wired to onOpenPresetDialog", () => {
  // The locale key bulk.presetMigrate existed before the entry-point
  // fix but the BulkActionBar had no button for it. Pin both pieces:
  // the button render and the props plumbing through the parent.
  assert.match(SRC, /const onOpenPresetDialog = props\.onOpenPresetDialog/);
  assert.match(SRC, /onClick: onOpenPresetDialog \}, t\("bulk\.presetMigrate"\)/);
  assert.match(SRC, /onOpenPresetDialog: onBulkPreset/);
  assert.match(SRC, /const bulkPresetDialog = bulkPresetDraft \? h\(BulkChoiceDialog,/);
  assert.match(SRC, /onBulkAction\("preset-migrate", \{ toPreset: value \}, true\)/);
});


test("css: sm-bulkDialog.sm-nativeDialogLayer is positioned like the per-row confirm dialog", () => {
  // The bulk dialog must not render in normal document flow at the
  // bottom of the panel. It should reuse the same fixed-position
  // inset as .sm-confirmDialog.sm-nativeDialogLayer so it pops up
  // to the right of the panel like every other per-row dialog.
  assert.match(SRC, /\.sm-bulkDialog\.sm-nativeDialogLayer\{[^}]*position:fixed/);
  assert.match(SRC, /\.sm-bulkDialog\.sm-nativeDialogLayer\{[^}]*inset:calc\(50vh - 90px\) auto auto calc\(50vw \+ 308px\)/);
  // The inner .sm-nativeDialog gets the proper background / border /
  // animation so it does not look unstyled.
  assert.match(SRC, /\.sm-bulkDialog\.sm-nativeDialogLayer \.sm-nativeDialog\{[^}]*background:var\(--dsw-alias-surface-l1/);
  assert.match(SRC, /\.sm-bulkDialog\.sm-nativeDialogLayer \.sm-nativeDialog\{[^}]*animation:sm-confirmPop/);
});

test("css: dark theme overrides cover .sm-bulkDialog (no more white-on-white)", () => {
  // Issue: bulk dialogs were excluded from every dark-theme selector
  // list, so dark mode rendered them with the default white background
  // while the rest of the UI went dark -- text became white-on-white.
  // Every selector list that covers panel / confirm / migrate must
  // also cover bulk.
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-bulkDialog\.sm-nativeDialogLayer \.sm-nativeDialog\{/);
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-bulkDialog \.sm-nativeDialogHeader/);
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-bulkDialog \.sm-nativeDialogBody/);
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-bulkDialog \.sm-nativeDialogFooter/);
  // Inner containers that previously had no background need explicit
  // dark fill so they don't show through as white panels.
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-bulkDialog \.sm-bulkSessionList/);
  assert.match(SRC, /\[data-sm-theme=dark\] \.sm-bulkDialog \.sm-bulkResultList/);
});

test("entry: clearSelection() only clears IDs, NOT selectModeEnabled (bulk mode stays on)", () => {
  // Regression guard: earlier clearSelection() also flipped
  // selectModeEnabled to false, which made the "清空选择" toolbar
  // button silently exit bulk mode. Pin that clearSelection no
  // longer touches selectModeEnabled; bulk mode is now exited
  // exclusively by toggleSelectMode().
  const okLine = "const clearSelection = () => { setSelectedIds(new Set()); setLastClickedRank(null); };";
  assert.ok(SRC.includes(okLine), "clearSelection must clear IDs only (no setSelectModeEnabled call): " + okLine);
  // Anti-pattern: the old single-line version that also reset selectModeEnabled
  assert.ok(!SRC.includes("const clearSelection = () => { setSelectedIds(new Set()); setLastClickedRank(null); setSelectModeEnabled(false); }"),
    "old clearSelection that also flipped selectModeEnabled must be gone");
});
