/**
 * Test coverage for Issue #44:
 * Session topbar buttons visually aligned with native DSH session header buttons.
 *
 * Verifies:
 * - 28px button height and metrics matching DSH native title bar buttons.
 * - Flat transparent background and border: 0 on idle.
 * - var(--dsw-alias-interactive-bg-hover) on hover.
 * - SVG vector icons (14x14) replacing emojis (★/☆, ◷, 🏷, ↔, 🗑, ⋯, 📥/📤).
 * - Danger button styling (transparent at rest, error-primary hover fill).
 * - Active state (ghost active fill).
 * - Container queries (28x28 icon-only at 1000px, collapse at 520px and 420px).
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

test("Issue #44: static CSS declares 28px height, border:0, transparent idle background, and 6px radius", () => {
  // .sm-headerBtn base styling
  assert.match(SRC, /\.sm-headerBtn\{[^}]*min-height:28px/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*height:28px/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*background:transparent/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*border:0/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*border-radius:6px/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*padding:0 6px/);
  assert.match(SRC, /\.sm-headerBtn\{[^}]*font-size:12px/);

  // Hover and active states
  assert.match(SRC, /\.sm-headerBtn:hover:not\(:disabled\)\{background:var\(--dsw-alias-interactive-bg-hover\)/);
  assert.match(SRC, /\.sm-headerBtn\.sm-headerBtnActive\{background:var\(--dsw-alias-button-ghost-active-fill/);

  // Danger delete button styling
  assert.match(SRC, /\.sm-headerBtnDanger\{background:transparent/);
  assert.match(SRC, /\.sm-headerBtnDanger\{[^}]*color:var\(--dsw-alias-state-error-primary/);
  assert.match(SRC, /\.sm-headerBtnDanger\{[^}]*border:0/);
  assert.match(SRC, /\.sm-headerBtnDanger:hover:not\(:disabled\)\{background:var\(--dsw-alias-state-error-primary,#d92d20\);color:var\(--dsw-alias-label-primary-foreground,#fff\)/);

  // Icon sizing in buttons
  assert.match(SRC, /\.sm-headerBtn svg\{width:14px;height:14px/);
  assert.match(SRC, /\.sm-headerBtnIcon\{[^}]*width:14px;height:14px/);

  // Square icon-only buttons (mark icons and compact menu trigger)
  assert.match(SRC, /\.sm-headerBtn\.sm-markIcon\{width:28px;min-width:28px;height:28px;padding:0/);
  assert.match(SRC, /\.sm-headerCompactMenuBtn\{width:28px;min-width:28px;height:28px;padding:0/);
});

test("Issue #44: container query transitions to 28x28 square buttons on medium screens", () => {
  assert.match(SRC, /@container\s*\(max-width:1000px\)\s*\{[\s\S]*?\.sm-headerBtn\s*\{width:28px;min-width:28px;height:28px;padding:0/);
});

test("Issue #44: rendered header buttons contain SVG vector icons rather than raw unicode emojis", async (t) => {
  const sessions = [{ id: "s1", displayTitle: "Test Session", updatedAt: 100 }];
  const app = mountClient({ sessions, current: "s1", workspaces: [{ id: "w1", name: "Dev Workspace" }] });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader("s1");

  const header = app.headerTree;
  assert.ok(header, "header must be mounted");

  // Favorite button
  const favBtn = nodes(header, n => n.props?.["aria-label"]?.includes("收藏会话"))[0];
  assert.ok(favBtn, "favorite button must exist");
  const favSvg = nodes(favBtn, n => n.type === "svg")[0];
  assert.ok(favSvg, "favorite button must render an SVG icon");
  assert.equal(favSvg.props.width, 14);
  assert.equal(favSvg.props.height, 14);

  // Review later button
  const revBtn = nodes(header, n => n.props?.["aria-label"]?.includes("标记待回看"))[0];
  assert.ok(revBtn, "review later button must exist");
  const revSvg = nodes(revBtn, n => n.type === "svg")[0];
  assert.ok(revSvg, "review later button must render an SVG icon");
  assert.equal(revSvg.props.width, 14);
  assert.equal(revSvg.props.height, 14);

  // Edit / tag button
  const editBtn = nodes(header, n => n.props?.["aria-label"]?.includes("编辑标签、备注和优先级"))[0];
  assert.ok(editBtn, "edit button must exist");
  const editSvg = nodes(editBtn, n => n.type === "svg")[0];
  assert.ok(editSvg, "edit button must render an SVG icon");
  assert.equal(editSvg.props.width, 14);
  assert.equal(editSvg.props.height, 14);

  // Move button
  const moveBtn = nodes(header, n => n.props?.["aria-label"] === "移动至工作区")[0];
  assert.ok(moveBtn, "move button must exist");
  const moveSvg = nodes(moveBtn, n => n.type === "svg")[0];
  assert.ok(moveSvg, "move button must render an SVG icon");
  assert.equal(moveSvg.props.width, 14);
  assert.equal(moveSvg.props.height, 14);

  // Delete button
  const deleteBtn = nodes(header, n => n.props?.["aria-label"] === "删除会话")[0];
  assert.ok(deleteBtn, "delete button must exist");
  const deleteSvg = nodes(deleteBtn, n => n.type === "svg")[0];
  assert.ok(deleteSvg, "delete button must render an SVG icon");
  assert.equal(deleteSvg.props.width, 14);
  assert.equal(deleteSvg.props.height, 14);

  // Compact more button
  const moreBtn = nodes(header, n => n.props?.className?.includes("sm-headerCompactMenuBtn"))[0];
  assert.ok(moreBtn, "compact more button must exist");
  const moreSvg = nodes(moreBtn, n => n.type === "svg")[0];
  assert.ok(moreSvg, "compact more button must render an SVG icon");
  assert.equal(moreSvg.props.width, 14);
  assert.equal(moreSvg.props.height, 14);
});

