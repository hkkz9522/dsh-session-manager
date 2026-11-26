/**
 * Regression coverage for issue #28 — the session manager panel was occluded by
 * the main conversation area and became unclickable, worst of all under a
 * translucent-background theme.
 *
 * Root cause (confirmed in `lib/client.js`, independent of the issue text and
 * of PR #29): the panel was returned straight out of the
 * `sidebar.footer.action` slot, so it rendered *inside the sidebar subtree*
 * instead of through `renderInOverlay()` like every other dialog. Its surface
 * is `position:fixed`, and any ancestor carrying `transform`, `filter`,
 * `backdrop-filter`, `will-change` or `contain` becomes the containing block
 * for fixed descendants — which translucent themes do apply. The panel was
 * therefore positioned relative to, and clipped by, that subtree, and its
 * `z-index` only competed inside that subtree's stacking context, so the
 * conversation area painted over it (overlapping text, clicks landing on the
 * conversation). The overlay root is also `pointer-events:none`, so the portal
 * alone is not enough: the node needs a `.sm-overlayLayer` wrapper, whose
 * `.sm-overlayLayer>*{pointer-events:auto}` rule is what re-enables input.
 *
 * These tests pin the delivered structure (portal target, wrapper chain, layer
 * order) and the behaviour that must not regress (interaction through the
 * portaled tree, Esc, no new click-outside dismissal, dialogs still above).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SESSIONS = [
  { id: "s1", displayTitle: "Alpha", updatedAt: 3 },
  { id: "s2", displayTitle: "Beta", updatedAt: 2 },
];
const ARCHIVED = [{ id: "s3", displayTitle: "Gamma", updatedAt: 1 }];
const OVERLAY_ROOT_ID = "dsh-session-manager-overlay-root";
const hasClass = (node, name) => String(node?.props?.className ?? "").split(/\s+/).includes(name);
/** The plugin's stylesheet as it actually reached the document head. */
const css = app => app.styleTags.map(tag => tag.textContent ?? "").join("\n");

function mount(options = {}) {
  return mountClient({ sessions: SESSIONS, current: "s1", language: "zh", ...options });
}

/** The panel modal node: the fragment's first child returned by the panel. */
function panelModal(app) {
  const fragment = app.tree[0];
  return fragment.props.children[0];
}

test("issue #28: the panel modal is portaled into the plugin overlay root", () => {
  const app = mount();
  const modal = panelModal(app);

  const portals = app.portals.filter(entry => entry.node === modal);
  assert.equal(portals.length, 1, "the panel modal must be delivered through exactly one portal");
  assert.equal(
    portals[0].container?.id,
    OVERLAY_ROOT_ID,
    "the panel must be portaled into #" + OVERLAY_ROOT_ID + " so it escapes the sidebar subtree"
  );
});

test("issue #28: the portaled panel keeps its layer wrapper, dialog semantics and pointer-events hook", () => {
  const app = mount();
  const modal = panelModal(app);

  // .sm-overlayLayer > .sm-nativeDialogLayer > section.sm-panelDialog, the same
  // shape the other dialogs use. The wrapper class is load-bearing: the overlay
  // root is pointer-events:none and `.sm-overlayLayer>*` is the only rule that
  // turns its direct child (and therefore the panel) back into a hit target.
  assert.ok(hasClass(modal, "sm-overlayLayer"), "the portaled node must carry sm-overlayLayer");
  const layer = modal.props.children[0];
  assert.ok(hasClass(layer, "sm-nativeDialogLayer"), "the dialog layer wrapper must be preserved");
  assert.equal(layer.props.role, "presentation");
  const surface = layer.props.children[0];
  assert.ok(hasClass(surface, "sm-panelDialog"), "the panel surface must keep sm-panelDialog");
  assert.equal(surface.props.role, "dialog");
  assert.equal(surface.props["aria-modal"], "true");
  assert.equal(surface.props["aria-labelledby"], "sm-panel-dialog-title");

  const stylesheet = css(app);
  assert.match(
    stylesheet,
    /#dsh-session-manager-overlay-root\{[^}]*pointer-events:none!important/,
    "the overlay root must stay pointer-events:none; the wrapper hook below depends on it"
  );
  assert.match(
    stylesheet,
    /\.sm-overlayLayer>\*\{pointer-events:auto\}/,
    "the pointer-events re-enable hook must exist"
  );
  // ... and no rule may switch the panel surface itself back off.
  for (const rule of stylesheet.matchAll(/[^{}]*\.sm-panelDialog[^{}]*\{[^}]*\}/g)) {
    assert.ok(
      !/pointer-events\s*:\s*none/.test(rule[0]),
      "the panel surface must not declare pointer-events:none: " + rule[0].slice(0, 80)
    );
  }
});

test("issue #28: the panel stays below the overlay root and below every dialog layer", () => {
  const app = mount();
  const stylesheet = css(app);

  const number = (pattern, what) => {
    const match = pattern.exec(stylesheet);
    assert.ok(match, what + " must be declared in the stylesheet");
    return Number(match[1]);
  };
  const panelZ = number(/\.sm-panelDialog\{[^}]*z-index:(\d+)/, "the panel z-index");
  const rootZ = number(/#dsh-session-manager-overlay-root\{[^}]*z-index:(\d+)!important/, "the overlay root z-index");

  assert.ok(panelZ < rootZ, `panel z-index ${panelZ} must stay below the overlay root ${rootZ}`);
  // DSH's floating tier (menus, popovers, tooltips) is 1100; the plugin's whole
  // document layer must stay underneath it, above DSH's 1000 backdrop tier.
  assert.ok(rootZ < 1100, "the overlay root must stay below DSH's 1100 floating tier");
  assert.ok(rootZ > 1000, "the overlay root must stay above DSH's 1000 backdrop tier");

  // Within the root, dialogs (confirm 10001, bulk 10002, annotation 100002, ...)
  // order above the panel, so an open dialog is never trapped behind it.
  const layerZs = [...stylesheet.matchAll(/\.sm-[a-zA-Z]*[Dd]ialog(?:Layer)?\.sm-nativeDialogLayer[^{}]*\{[^}]*z-index:(\d+)/g)]
    .map(match => Number(match[1]));
  assert.ok(layerZs.length > 0, "expected at least one dialog layer z-index");
  for (const z of layerZs) {
    assert.ok(z > panelZ, `dialog layer z-index ${z} must exceed the panel's ${panelZ}`);
  }
});

test("issue #28: interaction keeps working through the portaled panel", async () => {
  const app = mount();
  assert.deepEqual(app.rowIds(), ["s1", "s2"]);

  // Search, filter and sort are read back through the same tree the portal
  // delivers, so portaling must not detach them from their handlers.
  await app.change("搜索标题、ID、标签或备注", "Alpha");
  assert.deepEqual(app.rowIds(), ["s1"]);
  await app.change("搜索标题、ID、标签或备注", "");
  assert.deepEqual(app.rowIds(), ["s1", "s2"]);

  await app.change("排序", "updated-asc");
  assert.equal(app.control("排序").props.value, "updated-asc");

  // Filter toggles are text buttons (no aria-label), so assert through the tree.
  await app.click("未归档");
  const activeFilter = nodes(app.tree, node => node.type === "button" && text(node) === "未归档")[0];
  assert.ok(String(activeFilter.props.className).includes("sm-on"), "the active filter must light up");
});

test("issue #28: the panel gains no backdrop and no click-outside dismissal", () => {
  const app = mount();
  const modal = panelModal(app);

  // The panel is a non-modal floating window: it had no mask before the fix and
  // must not grow one, or clicking the page behind it would start closing it.
  assert.equal(
    nodes(modal, node => hasClass(node, "sm-overlayBackdrop")).length,
    0,
    "the panel must not render a backdrop"
  );
  assert.equal(
    nodes(modal, node => hasClass(node, "sm-nativeDialogBackdrop")).length,
    0,
    "the panel must not render the native dialog backdrop either"
  );
  // Only the one wrapper this fix adds: no extra stacking layers.
  assert.equal(
    nodes(app.tree, node => hasClass(node, "sm-overlayLayer")).length,
    1,
    "the panel must add exactly one overlay layer"
  );
});

test("issue #28: Esc still closes the portaled panel", async () => {
  const app = mount();
  assert.equal(app.isOpen(), true);

  app.keydown({ key: "Escape", isComposing: true, preventDefault() { throw new Error("IME Escape must be ignored"); }, stopPropagation() {} });
  assert.equal(app.isOpen(), true, "an IME-composing Escape must not close the panel");

  app.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(app.isOpen(), false, "a plain Escape must still close the panel");
});

test("issue #69: the macOS overlay root leaves window dragging to the host and keeps dialogs interactive", () => {
  const app = mount();
  const stylesheet = css(app);
  assert.ok(stylesheet.includes('html[data-platform="darwin"] #dsh-session-manager-overlay-root{-webkit-app-region:initial!important}'));
  assert.ok(stylesheet.includes('#dsh-session-manager-overlay-root :is(.sm-nativeDialog,.sm-headerMenu){-webkit-app-region:no-drag}'));
  app.dispose();
});

test("issue #72: reset remains an inside click after the reset button is removed", async t => {
  const app = mount({ sessionAnnotations: { s1: { tags: ["work"] } } });
  t.after(() => app.dispose());
  await app.flush();
  await new Promise(resolve => setTimeout(resolve, 60));
  await app.click("批量处理");
  await app.change("按标签筛选", "tag:work");
  assert.deepEqual(app.rowIds(), ["s1"]);
  const reset = nodes(app.tree, node => hasClass(node, "sm-resetFilters") && text(node) === "重置筛选")[0];
  await app.click("重置筛选");
  assert.deepEqual(app.rowIds(), ["s1", "s2"]);
  const panel = nodes(panelModal(app), node => hasClass(node, "sm-panelDialog"))[0].props.ref.current;
  assert.ok(panel && !panel.contains(reset));

  app.window.dispatchEvent({ type: "click", target: reset, composedPath: () => [reset, panel, app.window] });
  assert.equal(app.isOpen(), true);
  assert.ok(nodes(app.tree, node => text(node) === "退出批量处理" && node.type === "button").length);

  const outside = { closest: () => null };
  app.window.dispatchEvent({ type: "click", target: outside, composedPath: () => [outside, app.window] });
  assert.equal(app.isOpen(), false);
});

test("issue #28: dialog flows stay intact and every dialog surface still portals", async () => {
  const app = mount();
  const panelPortals = app.portals.length;
  assert.equal(panelPortals, 1, "only the panel is mounted at first");

  // Row delete buttons are text buttons inside a row, matching how the delete
  // flow is driven in the other panel tests. The dialog element itself is not
  // rendered by the harness (OverlayLayer is invoked by React, not by the
  // harness stub), so assert on the element's props the way
  // client-delete-navigation.test.mjs does.
  const row = nodes(app.tree, node => node.props?.["data-session-id"] === "s1")[0];
  const deleteButton = nodes(row, node => node.type === "button" && text(node) === "删除会话")[0];
  assert.ok(deleteButton, "the row must expose its delete button");
  deleteButton.props.onClick();
  await app.flush();
  const dialog = nodes(app.tree, node => node.type?.name === "ConfirmDialog" && node.props?.title === "删除会话")[0];
  assert.ok(dialog, "clicking the row delete button must still open the confirmation dialog");

  // Source guard: the panel and all four dialog components must keep routing
  // their surface through renderInOverlay(), i.e. nothing may go back to
  // rendering a document-level surface inside its slot subtree.
  const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.equal(
    (source.match(/return renderInOverlay\(/g) || []).length,
    4,
    "the four dialog components must each portal their surface"
  );
  assert.match(
    source,
    /const panelModal = renderInOverlay\(h\("div", \{\s*\n\s*className: "sm-overlayLayer"/,
    "the panel modal must be portaled through renderInOverlay with the sm-overlayLayer wrapper"
  );
});

test("issue #28: archived-only filters keep working with the portaled panel", async () => {
  const app = mount({ archivedIds: ["s3"], sessions: [...SESSIONS, ...ARCHIVED] });
  await app.click("已归档");
  assert.deepEqual(app.rowIds(), ["s3"], "the archived filter must list the archived session");
  await app.click("未归档");
  assert.deepEqual(app.rowIds(), ["s1", "s2"], "the active filter must hide it again");
});
