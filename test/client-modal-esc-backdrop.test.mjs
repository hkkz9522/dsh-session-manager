/**
 * Regression coverage for issue #7:
 *   "[UI] 会话管理面板无法通过 Esc 或点击遮罩关闭
 *    （backdrop 为 display:none，焦点未进入 keydown 监听层）"
 *
 * The original bugs:
 *   1. `<section>` elements have no `tabindex`, so their `ref.focus()`
 *      callbacks were silent no-ops; the layer div with `tabIndex:-1`
 *      was never focused. Esc keydown never reached the layer.
 *   2. `.sm-nativeDialogBackdrop` had no visible styling for the panel,
 *      so clicking the dimmed page area behind the panel did nothing.
 *
 * The fix moves Esc handling to a `window`-level `keydown` listener
 * (via `useEffect`) on every modal -- panel + the three inner dialogs.
 * Per user feedback the dim backdrop has been removed so opening a
 * modal never darkens the page (sidebar or content). Closing paths are
 * Esc and the explicit close buttons only.
 *
 * No client-side DOM test infrastructure exists, so the tests are
 * static guards against silent reverts (same approach used for
 * issue #6): grep the source for the markers of each fix.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// Locate each dialog's window listener so the count assertion is precise
// (one per modal, not "at least one" which would let a regression sneak in).
function countMatches(pat) {
  let n = 0;
  let pos = 0;
  while ((pos = SRC.indexOf(pat, pos)) >= 0) { n++; pos += pat.length; }
  return n;
}

const WINDOW_ADD = 'window.addEventListener("keydown", handler);';
const WINDOW_RM = 'window.removeEventListener("keydown", handler);';

test("lib/client.js: every modal listens for Esc at the window level (issue #7 fix)", () => {
  // Four windows: panel + ConfirmDialog + MoveDialog + MigratePresetDialog.
  assert.equal(countMatches(WINDOW_ADD), 4, "expected 4 window.addEventListener(\"keydown\") call sites (panel + 3 inner dialogs)");
  assert.equal(countMatches(WINDOW_RM), 4, "expected 4 matching window.removeEventListener cleanup call sites");
});



test("lib/client.js: no dialog relies on the <section> ref's silent .focus() (issue #7 cleanup)", () => {
  // Three dialogs used to attach a ref that called el.focus() on a
  // non-focusable <section>. All three have been removed.
  assert.equal(
    countMatches('ref: (el) => { if (el && typeof el.focus === "function") el.focus(); }'),
    0,
    "the silent el.focus() ref must not be reintroduced on any <section>"
  );
});

test("lib/client.js: panel layer no longer handles Esc at the layer level", () => {
  // The panel used to define a top-level onPanelKeyDown callback and
  // bind it via `onKeyDown: onPanelKey` on the layer div. With the
  // window-level listener that handler is dead code -- keep it gone
  // so we do not double-close.
  assert.equal(
    countMatches("const onPanelKey = (e) =>"),
    0,
    "onPanelKey callback must be removed -- Esc handling lives on window"
  );
  assert.equal(
    countMatches("onKeyDown: onPanelKey,"),
    0,
    "panel layer must not bind onKeyDown"
  );
});

test("lib/client.js: ConfirmDialog layer no longer handles Enter (avoid Cancel-button race)", () => {
  // The previous layer onKeyDown also handled Enter, which raced with
  // the focused Cancel button's native Enter handler (both fired,
  // onCancel + onConfirm). Enter now lives only on the focused button.
  assert.equal(
    countMatches('e.key === "Enter" && !busy) { e.preventDefault(); onConfirm(); }'),
    0,
    "ConfirmDialog layer Enter handler must be removed"
  );
});

test("lib/client.js: MoveDialog layer keeps Enter but no longer handles Esc", () => {
  // MoveDialog's Enter-to-confirm shortcut is preserved (it gates on
  // selectedWorkspaceId), but the Esc branch on the layer is gone.
  assert.match(
    SRC,
    /e\.key === "Enter" && !busy && selectedWorkspaceId && list\.length > 0\)/,
    "MoveDialog layer Enter handler must remain"
  );
  assert.equal(
    countMatches('e.key === "Escape" && !busy) {\n          e.preventDefault();\n          onCancel();'),
    0,
    "MoveDialog layer Esc branch must be removed"
  );
});

test("lib/client.js: MigratePresetDialog layer no longer has onKeyDown", () => {
  // The whole onKeyDown is removed -- Esc moved to window-level, and
  // MigratePresetDialog never had Enter handling on the layer.
  assert.equal(
    countMatches('onKeyDown: (event) => { if (event.key === "Escape" && !busy)'),
    0,
    "MigratePresetDialog layer onKeyDown must be removed"
  );
});

test("lib/client.js: window Esc handlers respect e.defaultPrevented (DSH / plugin coexistence)", () => {
  // The window listeners must defer to whoever already consumed Esc,
  // otherwise they would race with DSH's own Esc handling on menus /
  // sidebar collapse / etc.
  const deferChecks = SRC.match(/e\.defaultPrevented\) return;/g) || [];
  assert.ok(
    deferChecks.length >= 4,
    `expected >= 4 "e.defaultPrevented) return;" guards (one per window listener); got ${deferChecks.length}`
  );
});

test("lib/client.js: window Esc handlers call stopPropagation to prevent further downstream reactions)", () => {
  // stopPropagation stops the synthetic event from reaching DSH / other
  // listeners on document / body once our handler has acted.
  const stopChecks = SRC.match(/e\.stopPropagation\(\);/g) || [];
  assert.ok(
    stopChecks.length >= 4,
    `expected >= 4 "e.stopPropagation();" calls (one per window listener); got ${stopChecks.length}`
  );
});

test("lib/client.js: no backdrop closes on mousedown (click-outside-to-close removed by design)", () => {
  // Per the post-0.4.9 user feedback: the panel and inner dialogs should
  // close ONLY via Esc / explicit close buttons, never by clicking the
  // backdrop. The panel backdrop is purely decorative now. The inner
  // dialogs have no visible backdrop at all (CSS hides it), and their
  // dead onMouseDown handlers have been removed for clarity.
  const backdropOnMouseDown = SRC.match(/className: "sm-nativeDialogBackdrop"[\s\S]{0,200}onMouseDown:/g) || [];
  assert.equal(backdropOnMouseDown.length, 0, "no backdrop may carry an onMouseDown that closes the modal");
});

test("lib/client.js: every Esc handler blurs the active element to avoid lingering focus ring", () => {
  // The :focus-visible heuristic activates after keyboard input, so the
  // button that originally opened the modal (sidebar toggle / row button
  // / Cancel button) would keep its focus ring after Esc closes the
  // modal. The handlers blur document.activeElement after the close
  // call to clean that up. Mouse-driven closes are unaffected because
  // :focus-visible does not activate for mouse-acquired focus.
  const blurCalls = SRC.match(/ae\.blur\(\);/g) || [];
  assert.equal(blurCalls.length, 4, "expected 4 ae.blur() calls (one per modal Esc handler)");
});
