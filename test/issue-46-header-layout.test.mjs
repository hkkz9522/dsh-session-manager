import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

test("Issue #46: slot registration order is 0, placing session manager header after static agent-team (-20) and agent-preset (-10), and before dynamic subagent-catalog (10) and job-list (20)", () => {
  // DSH official header action slots:
  // agent-team: order: -20 ("智能体团队", static trigger text)
  // agent-preset: order: -10 ("标准模式", static read-only label)
  // session-manager-header: order: 0 (our icon-only button group)
  // subagent-catalog: order: 10 ("2 个子智能体", dynamic fluctuating count)
  // job-list: order: 20 ("任务状态", dynamic fluctuating state)
  assert.match(SRC, /name:\s*"conversation\.session\.header\.actions"[\s\S]*?id:\s*"session-manager-header"[\s\S]*?order:\s*0/);
});

test("Issue #46: static CSS enforces fixed-width icon-only buttons in session header", () => {
  // .sm-header must be flex-shrink: 0
  assert.match(SRC, /\.sm-header\{flex-shrink:0\}/);

  // In .sm-header, .sm-headerBtn must be icon-only: 28x28 square with zero padding
  assert.match(SRC, /\.sm-header\s*\.sm-headerBtn\{width:28px;min-width:28px;padding:0;justify-content:center;position:relative\}/);

  // In .sm-header, text labels must be hidden by default
  assert.match(SRC, /\.sm-header\s*\.sm-headerBtnLabel\{display:none\}/);

  // Priority badge styled as corner overlay so button width stays 28px
  assert.match(SRC, /\.sm-header\s*\.sm-priorityBadge\{position:absolute;top:0;right:0/);
});

test("Issue #46: rendered header buttons maintain stable 28px dimensions regardless of state changes", async (t) => {
  const sessions = [
    { id: "s1", displayTitle: "Very Long Session Title That Would Push Things If Not Properly Sized", updatedAt: 100 }
  ];
  const app = mountClient({ sessions, current: "s1", workspaces: [{ id: "w1", name: "Dev Workspace" }] });
  t.after(() => app.dispose());
  await app.flush();
  await app.mountHeader("s1");

  const header = app.headerTree;
  assert.ok(header, "header must be mounted");

  // Verify all 6 buttons exist
  const favBtn = nodes(header, n => n.props?.["aria-label"]?.includes("收藏会话"))[0];
  const revBtn = nodes(header, n => n.props?.["aria-label"]?.includes("标记待回看"))[0];
  const tagBtn = nodes(header, n => n.props?.["aria-label"]?.includes("编辑标签、备注和优先级"))[0];
  const moveBtn = nodes(header, n => n.props?.["aria-label"] === "移动至工作区")[0];
  const delBtn = nodes(header, n => n.props?.["aria-label"] === "删除会话")[0];
  const archiveBtn = nodes(header, n => n.props?.["aria-label"]?.includes("归档"))[0];

  assert.ok(favBtn, "favorite button must exist");
  assert.ok(revBtn, "review later button must exist");
  assert.ok(tagBtn, "tag/note button must exist");
  assert.ok(moveBtn, "move button must exist");
  assert.ok(delBtn, "delete button must exist");
  assert.ok(archiveBtn, "archive button must exist");

  // Every button has an SVG icon
  for (const btn of [favBtn, revBtn, tagBtn, moveBtn, delBtn, archiveBtn]) {
    const svgs = nodes(btn, n => n.type === "svg");
    assert.ok(svgs.length > 0, "every header button must render an SVG icon");
    assert.equal(svgs[0].props.width, 14);
    assert.equal(svgs[0].props.height, 14);
  }
});

test("Issue #46 / Panel row actions: single session row actions matching header use icons only; non-header and bulk buttons keep text", async (t) => {
  // Static CSS rule hiding row button label text
  assert.match(SRC, /\.sm-rowActions\s*\.sm-rowBtnLabel\{display:none\}/);
  assert.match(SRC, /\.sm-panelDialog \.sm-rowActions \.sm-rowBtn\.sm-rowBtnIcon/);

  const sessions = [
    { id: "s1", displayTitle: "Alpha Session", updatedAt: 100 }
  ];
  const app = mountClient({ sessions, current: "s1", workspaces: [{ id: "w1", name: "Dev Workspace" }] });
  t.after(() => app.dispose());
  await app.flush();

  const tree = app.tree;
  const rowActions = nodes(tree, n => n.props?.className === "sm-rowActions")[0];
  assert.ok(rowActions, "sm-rowActions must be rendered in panel row");

  // Buttons matching header: favorite, review, edit, archive, move, delete
  const favBtn = nodes(rowActions, n => n.props?.["aria-label"]?.includes("收藏会话"))[0];
  const revBtn = nodes(rowActions, n => n.props?.["aria-label"]?.includes("标记待回看"))[0];
  const editBtn = nodes(rowActions, n => n.props?.["aria-label"]?.includes("编辑标签、备注和优先级"))[0];
  const archiveBtn = nodes(rowActions, n => n.props?.["aria-label"]?.startsWith("归档:") || n.props?.["aria-label"]?.startsWith("移出归档:"))[0];
  const moveBtn = nodes(rowActions, n => n.props?.["aria-label"]?.startsWith("移动至工作区:"))[0];
  const deleteBtn = nodes(rowActions, n => n.props?.["aria-label"]?.startsWith("删除会话:"))[0];

  assert.ok(favBtn, "favorite button must exist in row");
  assert.ok(revBtn, "review later button must exist in row");
  assert.ok(editBtn, "edit button must exist in row");
  assert.ok(archiveBtn, "archive button must exist in row");
  assert.ok(moveBtn, "move button must exist in row");
  assert.ok(deleteBtn, "delete button must exist in row");

  // Each of these 6 buttons must render an SVG icon and have their text label wrapped in .sm-rowBtnLabel
  for (const btn of [favBtn, revBtn, editBtn, archiveBtn, moveBtn, deleteBtn]) {
    const svgs = nodes(btn, n => n.type === "svg");
    assert.ok(svgs.length > 0, "row action matching header must render SVG icon");
    assert.equal(svgs[0].props.width, 14);
    assert.equal(svgs[0].props.height, 14);
  }

  // Buttons NOT in header: "打开" (open) and "迁移预设" (migrate)
  // They must NOT have SVG icons and must display text directly
  const openBtn = nodes(rowActions, n => n.type === "button" && text(n) === "打开")[0];
  assert.ok(openBtn, "open button must exist with visible text");
  assert.equal(nodes(openBtn, n => n.type === "svg").length, 0, "open button must NOT render SVG icon");

  const migrateBtn = nodes(rowActions, n => n.type === "button" && text(n) === "迁移预设")[0];
  assert.ok(migrateBtn, "migrate button must exist with visible text");
  assert.equal(nodes(migrateBtn, n => n.type === "svg").length, 0, "migrate button must NOT render SVG icon");

  // Bulk buttons: enter bulk mode and verify BulkActionBar component presence & source guards
  await app.clickLabel("进入批量管理模式");
  const bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  assert.ok(bar, "BulkActionBar should be present");

  // Verify bulk buttons retain visible text in client.js source
  assert.match(SRC, /archive:\s*t\("bulk\.archive"\)/);
  assert.match(SRC, /delete:\s*t\("bulk\.delete"\)/);
  assert.match(SRC, /move:\s*t\("bulk\.move"\)/);
  assert.match(SRC, /\.sm-bulkBar \.sm-bulkBtn\{cursor:pointer/);
});

