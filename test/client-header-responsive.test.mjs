/**
 * Regression coverage for Phase 2:
 * Header responsive design, container query integration, opaque button styling,
 * danger button hover styling, and compact overflow menu.
 * (§5, §6, §15.1, §19 of dsh-session-manager-20261001修改意见.md)
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// =========================================================================
// 1. Static CSS and Architecture Guards (§5, §6)
// =========================================================================

test("header-responsive: DSH container query rules defined for 1000px, 520px, and 420px", () => {
  // Container query for medium width: 32x32 square icon-only, hide labels/badge
  assert.match(SRC, /@container\s*\(max-width:1000px\)\s*\{[\s\S]*?\.sm-headerBtn\s*\{[^}]*width:28px[^}]*height:28px/);
  assert.match(SRC, /@container\s*\(max-width:1000px\)\s*\{[\s\S]*?\.sm-headerBtnLabel[^}]*display:none/);
  assert.match(SRC, /@container\s*\(max-width:1000px\)\s*\{[\s\S]*?\.sm-priorityBadge[^}]*display:none/);

  // Container query for narrow width: fold secondary actions into compact menu
  assert.match(SRC, /@container\s*\(max-width:520px\)\s*\{[\s\S]*?\.sm-headerSecondaryActions[^}]*display:none!important/);
  assert.match(SRC, /@container\s*\(max-width:520px\)\s*\{[\s\S]*?\.sm-headerCompactMenu\s*\{[^}]*display:inline-flex/);

  // Container query for ultra-narrow width: fold all actions into compact menu
  assert.match(SRC, /@container\s*\(max-width:420px\)\s*\{[\s\S]*?\.sm-header>:not\(\.sm-headerCompactMenu\)\{display:none!important\}/);
  assert.match(SRC, /@container\s*\(max-width:420px\)\s*\{[\s\S]*?\.sm-headerCompactMenu\{display:inline-flex!important\}/);
  assert.match(SRC, /@container\s*\(max-width:420px\)\s*\{[\s\S]*?\.sm-headerMenu\{right:auto!important;left:0!important\}/);
  assert.match(SRC, /@container\s*\(max-width:420px\)\s*\{[\s\S]*?\.sm-headerMenuUltraOnly\{display:flex!important\}/);
});

test("header-responsive: .sm-header uses flex-wrap: nowrap and does not wrap", () => {
  assert.match(SRC, /\.sm-header\{display:inline-flex;align-items:center;gap:6px;flex-wrap:nowrap\}/);
  assert.ok(!SRC.match(/\.sm-header\{flex-wrap:wrap\}/), "sm-header must not have flex-wrap:wrap");
});

test("header-responsive: .sm-headerBtn is filled with an opaque DSH button token", () => {
  // Issue #23: the old --dsw-alias-surface-l1 token does not exist in DSH, so
  // the declared colour silently degraded to the hard-coded #fff fallback.
  // Follow-up: a *surface* token is the wrong fill for a button -- a theme may
  // give it alpha or a hue chosen for large areas, which left the button's
  // text (e.g. the danger red) unreadable on its own plate. Use DSH's opaque
  // button-fill token instead.
  assert.match(SRC, /\.sm-headerBtn\{[^}]*background:transparent/);
  assert.match(SRC, /\.sm-headerBtnDanger\{background:transparent/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*border:0/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*flex-shrink:0/);
  assert.ok(!SRC.includes("--dsw-alias-surface-l1"), "the non-existent --dsw-alias-surface-l1 token must not be used");
});

test("header-responsive: .sm-headerBtnDanger uses solid red on hover", () => {
  assert.match(SRC, /\.sm-headerBtnDanger\{[^}]*color:var\(--dsw-alias-state-error-primary/);
  assert.match(SRC, /\.sm-headerBtnDanger:hover:not\(:disabled\)\{background:var\(--dsw-alias-state-error-primary,#d92d20\);color:var\(--dsw-alias-label-primary-foreground,#fff\);border-color:var\(--dsw-alias-state-error-primary,#d92d20\)\}/);
  // The generic .sm-headerBtn:hover rule no longer needs to be beaten with
  // !important: the danger selector carries more class selectors, which wins
  // the specificity tie. Pin both the absence of !important and the fact that
  // the generic rule it must outrank is still there.
  assert.ok(!/\.sm-headerBtnDanger:hover:not\(:disabled\)\{[^}]*!important/.test(SRC),
    "the danger hover must not need !important any more");
  assert.match(SRC, /\.sm-headerBtn:hover\{background:var\(--dsw-alias-interactive-bg-hover\)/);
  const classes = selector => (selector.match(/\.[a-z0-9_-]+|:(?!:)[a-z-]+(?:\([^)]*\))?/gi) || []).length;
  assert.ok(
    classes(".sm-headerBtnDanger:hover:not(:disabled)") > classes(".sm-headerBtn:hover"),
    "the danger hover selector must outrank .sm-headerBtn:hover"
  );
});

test("header-responsive: compact dropdown menu classes follow DSH tokens", () => {
  assert.match(SRC, /\.sm-headerMenu\{[^}]*position:absolute/);
  assert.match(SRC, /\.sm-headerMenuItem\{[^}]*display:flex/);
  assert.match(SRC, /\.sm-headerMenuUltraOnly\{display:none!important\}/);
  assert.match(SRC, /\.sm-headerMenuItemDanger\{[^}]*color:var\(--dsw-alias-state-error-primary/);
  // The danger menu item keeps its red tint from a real DSH token instead of a
  // private light/dark palette, so it follows the active theme.
  assert.match(SRC, /\.sm-headerMenuItemDanger:hover\{background:var\(--dsw-alias-interactive-bg-hover-danger\)\}/);
});

// =========================================================================
// 2. Functional DOM Structure & Interactions
// =========================================================================

const sessions = [
  { id: "s1", displayTitle: "First Session", updatedAt: 300 },
  { id: "s2", displayTitle: "Second Session", updatedAt: 200 }
];

async function setupHeader(t, options = {}) {
  const app = mountClient({ sessions, current: "s1", workspaces: [{ id: "w1", name: "Dev Workspace" }], ...options });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader("s1");
  return app;
}

test("header-responsive: renders primary, secondary, and compact menu elements", async (t) => {
  const app = await setupHeader(t);
  const header = app.headerTree;

  // Primary buttons (☆, ◷) rendered
  const starBtn = nodes(header, n => n.props?.["aria-label"]?.includes("收藏会话"))[0];
  assert.ok(starBtn, "favorite button must exist in header");

  const reviewBtn = nodes(header, n => n.props?.["aria-label"]?.includes("标记待回看"))[0];
  assert.ok(reviewBtn, "review later button must exist in header");

  // Edit annotations button rendered with secondaryAction class and icon
  const editBtn = nodes(header, n => n.props?.["aria-label"]?.includes("编辑标签、备注和优先级"))[0];
  assert.ok(editBtn, "edit annotations button must exist");
  assert.ok(editBtn.props.className.includes("sm-headerSecondaryAction"), "edit button must have sm-headerSecondaryAction");
  const editIcon = nodes(editBtn, n => n.props?.className === "sm-headerBtnIcon")[0];
  assert.ok(nodes(editIcon, n => n.type === "svg").length > 0, "edit icon must render an svg");
  const editLabel = nodes(editBtn, n => n.props?.className === "sm-headerBtnLabel")[0];
  assert.equal(text(editLabel), "标签/备注");

  // Secondary actions container contains move and delete buttons
  const secondaryContainer = nodes(header, n => n.props?.className === "sm-headerSecondaryActions")[0];
  assert.ok(secondaryContainer, "sm-headerSecondaryActions container must exist");

  const moveBtn = nodes(secondaryContainer, n => n.props?.["aria-label"] === "移动至工作区")[0];
  assert.ok(moveBtn, "move button must be inside sm-headerSecondaryActions");
  const moveIcon = nodes(moveBtn, n => n.props?.className === "sm-headerBtnIcon")[0];
  assert.ok(nodes(moveIcon, n => n.type === "svg").length > 0, "move icon must render an svg");
  const moveLabel = nodes(moveBtn, n => n.props?.className === "sm-headerBtnLabel")[0];
  assert.equal(text(moveLabel), "移动至工作区");

  const deleteBtn = nodes(secondaryContainer, n => n.props?.["aria-label"] === "删除会话")[0];
  assert.ok(deleteBtn, "delete button must be inside sm-headerSecondaryActions");
  assert.ok(deleteBtn.props.className.includes("sm-headerBtnDanger"), "delete button must be styled with sm-headerBtnDanger");
  const deleteIcon = nodes(deleteBtn, n => n.props?.className === "sm-headerBtnIcon")[0];
  assert.ok(nodes(deleteIcon, n => n.type === "svg").length > 0, "delete icon must render an svg");
  const deleteLabel = nodes(deleteBtn, n => n.props?.className === "sm-headerBtnLabel")[0];
  assert.equal(text(deleteLabel), "删除会话");

  // Compact menu button exists
  const compactMenu = nodes(header, n => n.props?.className === "sm-headerCompactMenu")[0];
  assert.ok(compactMenu, "sm-headerCompactMenu must exist");
  const moreBtn = nodes(compactMenu, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  assert.ok(moreBtn, "more button (⋯) must exist");
  assert.equal(moreBtn.props["aria-expanded"], false);
});

test("header-responsive: compact menu opens and displays secondary action items", async (t) => {
  const app = await setupHeader(t);
  const compactMenu = nodes(app.headerTree, n => n.props?.className === "sm-headerCompactMenu")[0];
  const moreBtn = nodes(compactMenu, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];

  // Initially dropdown menu is closed
  assert.equal(nodes(app.headerTree, n => n.props?.className === "sm-headerMenu").length, 0);

  // Click ⋯ button to open
  moreBtn.props.onClick({ stopPropagation() {} });
  await app.flush();

  const menu = nodes(app.headerTree, n => n.props?.className === "sm-headerMenu")[0];
  assert.ok(menu, "dropdown menu must be open");

  const menuItems = nodes(menu, n => n.props?.className?.includes("sm-headerMenuItem"));
  assert.equal(menuItems.length, 6, "must have archive, favorite, review, edit, move, delete in menu");

  const menuTexts = menuItems.map(item => text(item));
  assert.deepEqual(menuTexts, ["归档", "收藏会话", "标记待回看", "标签/备注", "移动至工作区", "删除会话"]);

  // Clicking ⋯ button again toggles it closed
  const updatedMoreBtn = nodes(app.headerTree, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  assert.equal(updatedMoreBtn.props["aria-expanded"], true);
  updatedMoreBtn.props.onClick({ stopPropagation() {} });
  await app.flush();

  assert.equal(nodes(app.headerTree, n => n.props?.className === "sm-headerMenu").length, 0);
});

test("header-responsive: clicking dropdown items triggers their respective dialogs", async (t) => {
  const app = await setupHeader(t);

  // Open ⋯ menu
  const moreBtn = nodes(app.headerTree, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  moreBtn.props.onClick({ stopPropagation() {} });
  await app.flush();

  // Click "移动至工作区" item
  const menu = nodes(app.headerTree, n => n.props?.className === "sm-headerMenu")[0];
  const moveItem = nodes(menu, n => n.props?.className?.includes("sm-headerMenuItem") && text(n).includes("移动至工作区"))[0];
  assert.ok(moveItem, "move item must exist in menu");
  assert.equal(typeof moveItem.props.onClick, "function");
  moveItem.props.onClick({ currentTarget: {} });
  await app.flush();

  // Menu is now closed
  assert.equal(nodes(app.headerTree, n => n.props?.className === "sm-headerMenu").length, 0);

  // Move dialog is opened
  const moveDialog = nodes(app.headerTree, n => n.props?.title === "移动会话到工作区")[0];
  assert.ok(moveDialog, "MoveDialog must be opened from menu");

  // Close move dialog
  moveDialog.props.onClose();
  await app.flush();

  // Open ⋯ menu again and click "删除会话"
  const moreBtn2 = nodes(app.headerTree, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  moreBtn2.props.onClick({ stopPropagation() {} });
  await app.flush();

  const menu2 = nodes(app.headerTree, n => n.props?.className === "sm-headerMenu")[0];
  const deleteItem = nodes(menu2, n => n.props?.className?.includes("sm-headerMenuItem") && text(n).includes("删除会话"))[0];
  assert.ok(deleteItem, "delete item must exist in menu");
  assert.equal(typeof deleteItem.props.onClick, "function");
  deleteItem.props.onClick({ currentTarget: {} });
  await app.flush();

  // Delete confirm dialog is opened
  const confirmDialog = nodes(app.headerTree, n => n.props?.title === "删除会话")[0];
  assert.ok(confirmDialog, "ConfirmDialog must be opened from menu");
});

test("header-responsive: clicking favorite and review in compact menu toggles annotations", async (t) => {
  const app = await setupHeader(t);

  // Open ⋯ menu
  const moreBtn = nodes(app.headerTree, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  moreBtn.props.onClick({ stopPropagation() {} });
  await app.flush();

  const menu = nodes(app.headerTree, n => n.props?.className === "sm-headerMenu")[0];
  const favItem = nodes(menu, n => n.props?.className?.includes("sm-headerMenuItem") && text(n).includes("收藏会话"))[0];
  assert.ok(favItem, "favorite item must exist in menu");

  // Click favorite
  favItem.props.onClick();
  await app.flush();

  // Menu is closed after clicking
  assert.equal(nodes(app.headerTree, n => n.props?.className === "sm-headerMenu").length, 0);

  // Re-open menu to verify favorite state updated
  const moreBtn2 = nodes(app.headerTree, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  moreBtn2.props.onClick({ stopPropagation() {} });
  await app.flush();

  const menu2 = nodes(app.headerTree, n => n.props?.className === "sm-headerMenu")[0];
  const unfavItem = nodes(menu2, n => n.props?.className?.includes("sm-headerMenuItem") && text(n).includes("取消收藏"))[0];
  assert.ok(unfavItem, "menu item should now reflect favorite active (取消收藏)");

  // Click review later
  const reviewItem = nodes(menu2, n => n.props?.className?.includes("sm-headerMenuItem") && text(n).includes("标记待回看"))[0];
  assert.ok(reviewItem, "review item must exist in menu");
  reviewItem.props.onClick();
  await app.flush();

  assert.equal(nodes(app.headerTree, n => n.props?.className === "sm-headerMenu").length, 0);

  // Re-open menu to verify review later state updated
  const moreBtn3 = nodes(app.headerTree, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  moreBtn3.props.onClick({ stopPropagation() {} });
  await app.flush();

  const menu3 = nodes(app.headerTree, n => n.props?.className === "sm-headerMenu")[0];
  const unreviewItem = nodes(menu3, n => n.props?.className?.includes("sm-headerMenuItem") && text(n).includes("取消待回看"))[0];
  assert.ok(unreviewItem, "menu item should now reflect review later active (取消待回看)");
});

test("header-responsive: secondary dialogs respect sidebar boundary and do not overlap sidebar", async (t) => {
  const customQuerySelector = (sel) => {
    if (sel === "[data-dsh-sidebar]" || sel === "aside" || sel === ".dsw-sidebar") {
      return {
        getBoundingClientRect: () => ({ right: 280, left: 0, width: 280, top: 0, bottom: 900 })
      };
    }
    return null;
  };

  const app = await setupHeader(t, { querySelector: customQuerySelector, innerWidth: 400 });

  // Open ⋯ menu
  const moreBtn = nodes(app.headerTree, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  moreBtn.props.onClick({ stopPropagation() {} });
  await app.flush();

  // Click "删除会话"
  const menu = nodes(app.headerTree, n => n.props?.className === "sm-headerMenu")[0];
  const deleteItem = nodes(menu, n => n.props?.className?.includes("sm-headerMenuItem") && text(n).includes("删除会话"))[0];
  deleteItem.props.onClick({ currentTarget: { nodeType: 1, getBoundingClientRect: () => ({ top: 40, bottom: 72, left: 290, right: 322, width: 32, height: 32 }) } });
  await app.flush();

  const confirmDialog = nodes(app.headerTree, n => n.props?.title === "删除会话")[0];
  assert.ok(confirmDialog, "ConfirmDialog must be opened");

  // Mount dialog layer
  const host = app.mountComponent(confirmDialog.type, confirmDialog.props);
  assert.ok(host.tree, "dialog layer rendered");
  const leftPx = parseInt(host.tree.props.style.left, 10);
  assert.ok(leftPx >= 288, `dialog left (${leftPx}px) must be >= sidebarRight + 8 (288px) to prevent overlap`);
  host.dispose();
});
