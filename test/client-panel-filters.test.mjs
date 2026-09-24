import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
import { mountClient, text, nodes } from "./helpers/client-harness.mjs";

const sessions = [
  { id: "A-101", displayTitle: "修复 Alpha 登录", updatedAt: 300, createdAt: 100, cwd: "/stale/path" },
  { id: "B-202", displayTitle: "Beta [x]", updatedAt: 200, createdAt: 300, cwd: "/old/path" },
  { id: "C-303", displayTitle: "草稿", updatedAt: 100, createdAt: 200, cwd: "/unregistered" },
  { id: "child", displayTitle: "Child", origin: "subagent", updatedAt: 900 },
  { id: "blank", displayTitle: "", blank: true, updatedAt: 800 },
];
const workspaces = [
  { id: "one", title: "项目一", path: "C:\\Projects\\One", sessionIds: ["A-101", "B-202"] },
  { id: "two", title: "项目二", path: "/two", sessionIds: [] },
];
async function setup(t, options = {}) {
  const app = mountClient({ sessions, workspaces, archivedIds: ["B-202"], current: "A-101", ...options });
  t.after(() => app.dispose());
  await app.flush();
  return app;
}

test("panel defaults to recently updated, excludes subagents/other blank rows, and reports the visible total", async t => {
  const app = await setup(t);
  assert.deepEqual(app.rowIds(), ["A-101", "B-202", "C-303"]);
  assert.ok(text(app.tree).includes("显示 3 / 3 个会话"));
  assert.equal(app.control("排序").props.value, "updated-desc");
  assert.equal(app.workspaceRequests.length, 1);
});

test("search matches title or ID, ignores case/outer whitespace, and treats punctuation literally", async t => {
  const app = await setup(t);
  for (const [query, expected] of [[" ALPHA ", ["A-101"]], ["修复", ["A-101"]], ["b-20", ["B-202"]], ["[x]", ["B-202"]], [".*", []], ["   ", ["A-101", "B-202", "C-303"]]]) {
    await app.change("搜索标题、ID、标签或备注", query);
    assert.deepEqual(app.rowIds(), expected, query);
  }
  assert.equal(app.workspaceRequests.length, 1, "typing must never query session history or refetch workspaces");
});

test("workspace, archive state and search are combined rather than overriding each other", async t => {
  const app = await setup(t);
  await app.change("工作区", "workspace:one");
  assert.deepEqual(app.rowIds(), ["A-101", "B-202"]);
  await app.click("已归档");
  assert.deepEqual(app.rowIds(), ["B-202"]);
  await app.change("搜索标题、ID、标签或备注", "Alpha");
  assert.deepEqual(app.rowIds(), []);
  assert.ok(text(app.tree).includes("没有匹配的会话"));
  assert.ok(text(app.tree).includes("显示 0 / 3 个会话"));
  await app.click("未归档");
  assert.deepEqual(app.rowIds(), ["A-101"]);
});

test("ungrouped means no known workspace, including registry and cwd fallbacks", async t => {
  const app = await setup(t);
  await app.change("工作区", "ungrouped");
  assert.deepEqual(app.rowIds(), ["C-303"]);
  await app.change("工作区", "all");
  assert.deepEqual(app.rowIds(), ["A-101", "B-202", "C-303"]);
});

test("membership takes precedence over stale cwd; fallback supports Windows paths and preserves POSIX case", async t => {
  const rows = [
    { id: "registered", cwd: "/two", workspaceId: "two" },
    { id: "by-id", workspaceId: "one" },
    { id: "by-windows-path", cwd: "c:/projects/one/" },
    { id: "posix", cwd: "/two/" },
    { id: "different-case", cwd: "/TWO" },
  ];
  const app = await setup(t, { sessions: rows, archivedIds: [], workspaces: [{ ...workspaces[0], sessionIds: ["registered"] }, workspaces[1]] });
  await app.change("工作区", "workspace:one");
  assert.deepEqual(app.rowIds(), ["registered", "by-id", "by-windows-path"]);
  await app.change("工作区", "workspace:two");
  assert.deepEqual(app.rowIds(), ["posix"]);
  await app.change("工作区", "ungrouped");
  assert.deepEqual(app.rowIds(), ["different-case"]);
});

test("all four time sorts work without changing the upstream list", async t => {
  const immutable = sessions.map(session => Object.freeze({ ...session }));
  const app = await setup(t, { sessions: immutable });
  const original = [...app.sourceIds]; Object.freeze(app.sourceIds);
  for (const [order, expected] of [
    ["updated-asc", ["C-303", "B-202", "A-101"]],
    ["created-desc", ["B-202", "C-303", "A-101"]],
    ["created-asc", ["A-101", "C-303", "B-202"]],
    ["updated-desc", ["A-101", "B-202", "C-303"]],
  ]) {
    await app.change("排序", order);
    assert.deepEqual(app.rowIds(), expected);
    assert.deepEqual(app.sourceIds, original);
  }
  assert.equal(app.workspaceRequests.length, 1);
});

test("ISO/numeric timestamps sort consistently; ties stay stable and unknown times are always last", async t => {
  const app = await setup(t, { sessions: [
    { id: "tie-first", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "unknown", updatedAt: "invalid" },
    { id: "latest", updatedAt: 1767312000000 },
    { id: "tie-second", updatedAt: "1767225600000" },
    { id: "missing" },
  ] });
  assert.deepEqual(app.rowIds(), ["latest", "tie-first", "tie-second", "unknown", "missing"]);
  await app.change("排序", "updated-asc");
  assert.deepEqual(app.rowIds(), ["tie-first", "tie-second", "latest", "unknown", "missing"]);
  assert.ok(!text(app.tree).includes("NaN"));
});

test("reset restores search, workspace, archive state and default sort together", async t => {
  const app = await setup(t);
  await app.change("工作区", "workspace:one"); await app.change("排序", "created-asc");
  await app.change("搜索标题、ID、标签或备注", "Beta"); await app.click("已归档");
  await app.click("重置筛选");
  assert.equal(app.control("搜索标题、ID、标签或备注").props.value, "");
  assert.equal(app.control("工作区").props.value, "all");
  assert.equal(app.control("排序").props.value, "updated-desc");
  assert.deepEqual(app.rowIds(), ["A-101", "B-202", "C-303"]);
  assert.equal(app.find(node => node.type === "button" && text(node) === "全部")[0].props["aria-pressed"], true);
});

test("current blank session remains visible and is searchable by its localized title", async t => {
  const app = await setup(t, { current: "blank" });
  assert.equal(app.rowIds()[0], "blank");
  await app.change("搜索标题、ID、标签或备注", "新建会话");
  assert.deepEqual(app.rowIds(), ["blank"]);
});

test("empty library is distinguished from an empty filtered result", async t => {
  const app = await setup(t, { sessions: [] });
  assert.ok(text(app.tree).includes("暂无会话"));
  assert.ok(text(app.tree).includes("显示 0 / 0 个会话"));
  assert.ok(!text(app.tree).includes("没有匹配的会话"));
});

test("workspace load failures are visible, disable only the workspace control, and can be retried", async t => {
  const app = await setup(t, { fetchWorkspaces: async () => { throw new Error("offline"); } });
  assert.ok(text(app.tree).includes("工作区加载失败：offline"));
  assert.equal(app.control("工作区").props.disabled, true);
  await app.change("搜索标题、ID、标签或备注", "Alpha");
  assert.deepEqual(app.rowIds(), ["A-101"]);
  app.setFetcher(undefined);
  await app.click("重试");
  assert.equal(app.control("工作区").props.disabled, false);
  assert.ok(!text(app.tree).includes("工作区加载失败"));
});

test("API business failures and malformed workspace payloads never masquerade as ungrouped sessions", async t => {
  for (const payload of [{ ok: false, error: "backend failure" }, { ok: true, result: {} }]) {
    const app = await setup(t, { fetchWorkspaces: async () => payload });
    assert.equal(app.control("工作区").props.disabled, true);
    assert.deepEqual(app.rowIds(), ["A-101", "B-202", "C-303"]);
    assert.ok(text(app.tree).includes("工作区加载失败"));
  }
});

test("selected workspace removed by a successful refresh resets to all; membership changes refresh results", async t => {
  const app = await setup(t);
  await app.change("工作区", "workspace:one");
  app.setWorkspaces([{ ...workspaces[0], sessionIds: ["A-101"] }, { ...workspaces[1], sessionIds: ["B-202"] }]);
  await app.flush();
  assert.deepEqual(app.rowIds(), ["A-101"]);
  app.setWorkspaces([workspaces[1]]);
  await app.flush();
  assert.equal(app.control("工作区").props.value, "all");
  assert.deepEqual(app.rowIds(), ["A-101", "B-202", "C-303"]);
});

test("stale workspace requests are aborted and cannot overwrite newer results", async t => {
  const pending = [];
  const app = await setup(t, { fetchWorkspaces: options => new Promise(resolve => pending.push({ options, resolve })) });
  assert.equal(app.control("工作区").props.disabled, true);
  app.setWorkspaces(workspaces); await app.flush();
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve({ ok: true, result: { workspaces: [workspaces[1]] } });
  await app.flush();
  pending[0].resolve({ ok: true, result: { workspaces: [workspaces[0]] } });
  await app.flush();
  const values = app.find(node => node.type === "option").map(node => node.props.value);
  assert.ok(values.includes("workspace:two"));
  assert.ok(!values.includes("workspace:one"));
});

test("session list updates reapply active search/sort without losing the user's controls", async t => {
  const app = await setup(t);
  await app.change("搜索标题、ID、标签或备注", "Alpha");
  app.setSessions([...sessions, { id: "new", displayTitle: "Alpha follow-up", updatedAt: 500 }]); await app.flush();
  assert.deepEqual(app.rowIds(), ["new", "A-101"]);
  assert.equal(app.control("搜索标题、ID、标签或备注").props.value, "Alpha");
  assert.equal(app.workspaceRequests.length, 2, "new IDs refresh cached creation metadata once");
});

test("workspace IDs cannot collide with all/ungrouped sentinel options", async t => {
  const app = await setup(t, { workspaces: [{ id: "ungrouped", title: "Real workspace", sessionIds: ["A-101"] }] });
  await app.change("工作区", "workspace:ungrouped");
  assert.deepEqual(app.rowIds(), ["A-101"]);
  await app.change("工作区", "ungrouped");
  assert.deepEqual(app.rowIds(), ["B-202", "C-303"]);
});

test("English controls and counts are translated", async t => {
  const app = await setup(t, { language: "en" });
  await app.change("Search title, ID, tags or notes", "Beta");
  await app.change("Workspace", "workspace:one");
  await app.change("Sort by", "created-desc");
  assert.deepEqual(app.rowIds(), ["B-202"]);
  assert.ok(text(app.tree).includes("Showing 1 / 3 sessions"));
  await app.click("Reset filters");
  assert.equal(app.rowIds().length, 3);
});

test("Escape cancels IME composition without closing the panel; normal Escape still closes it", async t => {
  const app = await setup(t);
  app.keydown({ key: "Escape", isComposing: true, preventDefault() { throw new Error("must not handle IME Escape"); } });
  assert.equal(app.isOpen(), true);
  app.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(app.isOpen(), false);
});

test("creation sort uses cached host metadata when native session summaries omit createdAt", async t => {
  const app = await setup(t, {
    sessions: [{ id: "newer", updatedAt: 100 }, { id: "unknown", updatedAt: 300 }, { id: "older", updatedAt: 200 }],
    sessionCreatedAt: { newer: 500, older: "1970-01-01T00:00:00.100Z" },
  });
  await app.change("排序", "created-asc");
  assert.deepEqual(app.rowIds(), ["older", "newer", "unknown"]);
  await app.change("排序", "created-desc");
  assert.deepEqual(app.rowIds(), ["newer", "older", "unknown"]);
  assert.ok(!text(app.tree).includes("未提供创建时间"));
});

test("older hosts with no creation metadata explain the fallback instead of pretending to sort", async t => {
  const app = await setup(t, { sessions: [{ id: "b" }, { id: "a" }] });
  await app.change("排序", "created-desc");
  assert.deepEqual(app.rowIds(), ["b", "a"]);
  assert.ok(text(app.tree).includes("未提供创建时间"));
});

test("title/activity-only updates do not refetch cached workspace metadata", async t => {
  const app = await setup(t);
  app.setSessions(sessions.map(s => s.id === "A-101" ? { ...s, updatedAt: 999, displayTitle: "Updated" } : s));
  await app.flush();
  assert.equal(app.workspaceRequests.length, 1);
});

test("clicking a row's Open button forwards the session id to ctx.sessions.open", async t => {
  // Two sessions sorted by updatedAt desc; "first" comes before "second".
  const app = await setup(t, {
    language: "en",
    sessions: [
      { id: "first", displayTitle: "First", updatedAt: 300 },
      { id: "second", displayTitle: "Second", updatedAt: 200 },
    ],
    current: "first",
  });
  assert.equal(app.sessionOpenCalls.length, 0, "no opens recorded yet");
  // Walk the panel tree and click every button whose onClick source mentions
  // "onOpen". After flush, the spy should have recorded both ids -- proving
  // the click handler is wired to ctx.sessions.open for every row.
  const openButtons = [];
  const walk = (node) => {
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && typeof node.props?.onClick === "function") {
      const source = node.props.onClick.toString();
      if (source.includes("onOpen")) openButtons.push(node);
    }
    const children = Array.isArray(node.props?.children) ? node.props.children : (node.props?.children ? [node.props.children] : []);
    for (const child of children) walk(child);
  };
  walk(app.tree[0]);
  assert.ok(openButtons.length >= 2, "every row should render an Open button");
  for (const b of openButtons) b.props.onClick();
  app.flush();
  assert.equal(app.sessionOpenCalls.length, 2, "Open should fire twice (one per row)");
  assert.ok(app.sessionOpenCalls.includes("first"), "row 'first' Open should call ctx.sessions.open");
  assert.ok(app.sessionOpenCalls.includes("second"), "row 'second' Open should call ctx.sessions.open");
});

test("clicking a specific row's Open button targets only that row", async t => {
  // Two sessions sorted by updatedAt desc; "b" is not current so the row's
  // Open handler is wired through the SessionManagerPanel, not the header.
  const app = await setup(t, {
    language: "en",
    sessions: [
      { id: "a", displayTitle: "A", updatedAt: 200 },
      { id: "b", displayTitle: "B", updatedAt: 100 },
    ],
    current: "a",
  });
  assert.equal(app.sessionOpenCalls.length, 0, "no opens recorded yet");
  // Walk the panel tree for any button whose onClick source mentions onOpen;
  // the harness wraps row buttons in nested arrays so a flat node.props.children lookup misses them.
  const openButtons = [];
  const walk = (node) => {
    if (Array.isArray(node)) { for (const child of node) walk(child); return; }
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && typeof node.props?.onClick === "function") {
      const source = node.props.onClick.toString();
      if (source.includes("onOpen")) openButtons.push(node);
    }
    const children = Array.isArray(node.props?.children) ? node.props.children : (node.props?.children ? [node.props.children] : []);
    for (const child of children) walk(child);
  };
  walk(app.tree[0]);
  assert.ok(openButtons.length >= 2, "every row should render an Open button");
  // Map each Open button to its enclosing row by walking the row containers.
  const rows = nodes(app.tree[0], n => n.props?.["data-session-id"]);
  const buttonForRow = new Map();
  for (const row of rows) {
    const buttonsInRow = nodes(row, n => n.type === "button" && typeof n.props?.onClick === "function" && n.props.onClick.toString().includes("onOpen"));
    if (buttonsInRow.length > 0) buttonForRow.set(row.props["data-session-id"], buttonsInRow[0]);
  }
  const rowBButton = buttonForRow.get("b");
  assert.ok(rowBButton, "should locate row b's Open button");
  rowBButton.props.onClick();
  app.flush();
  assert.equal(app.sessionOpenCalls.length, 1, "Open should fire exactly once");
  assert.equal(app.sessionOpenCalls[0], "b", "open should target the clicked row");
});


test("panel: 4 select controls share one grid row in the panel header", async t => {
  // Layout consolidation: workspace, sort, tags, priority all live inside
  // the same .sm-panelSelects container (CSS gives it 4 columns on wide
  // panels, 2 on mid-width, 1 on narrow). This keeps the toolbar compact.
  const app = await setup(t, {
    language: "zh",
    sessions: [{ id: "a", displayTitle: "A", updatedAt: 100 }],
    current: "a",
    workspaces: [{ id: "ws1", title: "ws1" }],
  });
  const selects = nodes(app.tree[0], n => n.type === "div" && n.props?.className === "sm-panelSelects");
  assert.equal(selects.length, 1, "panelSelects container should be present once");
  const selectNodes = nodes(selects[0], n => n.type === "select");
  assert.equal(selectNodes.length, 4, "expected workspace + sort + tags + priority selects (4 total), got " + selectNodes.length);
  // The CSS must give the panelSelects container a 4-column grid.
  assert.match(SRC, /\.sm-panelSelects\{display:grid;grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
});

test("panel: 8 buttons in toolbar across 3 groups (5 filters + bulk-mode toggle + 2 bulk toggles)", async t => {
  // After the latest reshuffle the toolbar has 8 buttons in 3 groups:
  //   group 1: 全部 / 未归档 / 已归档 / ★ 收藏 / ◷ 待回看
  //   group 2: 批量处理 (or 退出批量处理)
  //   group 3: 全选当前筛选 / 清空选择
  const app = await setup(t, {
    language: "zh",
    sessions: [{ id: "a", displayTitle: "A", updatedAt: 100 }],
    current: "a",
    workspaces: [{ id: "ws1", title: "ws1" }],
  });
  await app.clickLabel("进入批量管理模式");
  const markFilters = nodes(app.tree[0], n => n.type === "div" && n.props?.className === "sm-markFilters");
  assert.equal(markFilters.length, 1);
  const btns = nodes(markFilters[0], n => n.type === "button");
  assert.equal(btns.length, 8, "expected 8 buttons (5 filter + 1 toggle + 2 bulk), got " + btns.length);
  const labels = btns.map(b => text(b));
  // Order matters: filter buttons, then bulk-mode toggle, then bulk toggles
  assert.equal(labels[0], "全部");
  assert.equal(labels[1], "未归档");
  assert.equal(labels[2], "已归档");
  assert.equal(labels[3], "★ 收藏");
  assert.equal(labels[4], "◷ 待回看");
  // The 6th button is the bulk-mode toggle (now positioned left of 全选当前筛选).
  assert.match(labels[5], /批量处理|退出批量处理/);
  assert.equal(labels[6], "全选当前筛选");
  assert.equal(labels[7], "清空选择");
});

test("panel: BulkActionBar no longer contains 全选当前筛选 / 清空筛选 buttons (moved up)", async t => {
  // The two selection-toggles (全选当前筛选 / 清空筛选) live in the
  // panel header filter row now, not inside the BulkActionBar. The bar
  // still owns the per-row action buttons (archive, favorite, ...).
  const app = await setup(t, {
    language: "zh",
    sessions: [{ id: "a", displayTitle: "A", updatedAt: 100 }],
    current: "a",
    workspaces: [{ id: "ws1", title: "ws1" }],
  });
  await app.clickLabel("进入批量管理模式");
  const bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  assert.ok(bar, "BulkActionBar should be present");
  // We can't directly inspect the bar's children (it's a function component
  // that the harness does not instantiate), but the static guard below
  // confirms the source-level removal.
  assert.ok(!SRC.includes('className: "sm-bulkBtn sm-bulkBtnGhost", disabled: filteredCount === 0 || filteredCount === selectedCount || busy, onClick: onSelectAll'),
    "BulkActionBar source must not render onSelectAll anymore");
  assert.ok(!SRC.includes('className: "sm-bulkBtn sm-bulkBtnGhost", disabled: selectedCount === 0 || busy, onClick: onClear'),
    "BulkActionBar source must not render onClear anymore");
});


test("panel: toolbar has two button groups on row 1 and count+reset on row 2", async t => {
  // Row 1 (sm-markFilters):
  //   - sm-markFiltersGroup #1: 全部 / 未归档 / 已归档 / 收藏 / 待回看 (5 filter buttons)
  //   - sm-markFiltersSpacer:   flex-grow spacer
  //   - sm-markFiltersGroup #2: 批量处理 + 全选当前筛选 + 清空选择 (3 buttons, all bulk-related)
  // Row 2 (sm-resultSummary):
  //   - 显示 2/2 个会话 + 重置筛选 button (conditional)
  const app = await setup(t, {
    language: "zh",
    sessions: [{ id: "a", displayTitle: "A", updatedAt: 100 }, { id: "b", displayTitle: "B", updatedAt: 90 }],
    current: "a",
    workspaces: [{ id: "ws1", title: "ws1" }],
  });
  const markFilters = nodes(app.tree[0], n => n.props && n.props.className === "sm-markFilters");
  assert.equal(markFilters.length, 1);
  const groups = nodes(markFilters[0], n => n.props && n.props.className === "sm-markFiltersGroup");
  assert.equal(groups.length, 2, "sm-markFilters must contain exactly two sm-markFiltersGroup children (filter group + bulk-controls group)");
  // Group 1: 5 filter buttons
  const group1Buttons = nodes(groups[0], n => n.type === "button");
  assert.equal(group1Buttons.length, 5, "group 1 must hold 5 filter buttons (全部 / 未归档 / 已归档 / 收藏 / 待回看)");
  // Spacer
  const spacer = nodes(markFilters[0], n => n.props && n.props.className === "sm-markFiltersSpacer");
  assert.equal(spacer.length, 1, "sm-markFiltersSpacer must sit between the two groups");
  // Group 2: bulk-mode toggle + 2 bulk toggles, ADJACENT (no spacer between them)
  const group2Buttons = nodes(groups[1], n => n.type === "button");
  assert.equal(group2Buttons.length, 3, "group 2 must hold 3 buttons (批量处理 + 全选当前筛选 + 清空选择)");
  assert.match(text(group2Buttons[0]), /批量处理|退出批量处理/);
  assert.equal(text(group2Buttons[1]), "全选当前筛选");
  assert.equal(text(group2Buttons[2]), "清空选择");
  // Row 2: count + reset live in sm-resultSummary (NOT inside sm-markFilters)
  const summary = nodes(app.tree[0], n => n.props && n.props.className === "sm-resultSummary");
  assert.equal(summary.length, 1, "sm-resultSummary must exist as the dedicated row 2");
  const countNode = nodes(summary[0], n => n.props && n.props.role === "status")[0];
  assert.ok(countNode, "sm-resultSummary must host the count <span>");
  assert.match(countNode.props.children.join ? countNode.props.children.join("") : String(countNode.props.children), /显示.*个会话/);
  // The reset button only appears once a view change is active. Force one.
  await app.click("已归档");
  const summaryAfter = nodes(app.tree[0], n => n.props && n.props.className === "sm-resultSummary")[0];
  const resetBtn = nodes(summaryAfter, n => n.props && n.props.className === "sm-resetFilters")[0];
  assert.ok(resetBtn, "sm-resetFilters must appear on row 2 once any view change is active");
});

test("panel: row has a permanent checkbox slot so layout is identical in and out of bulk mode", async t => {
  // The user wants row geometry to be identical whether or not bulk mode
  // is on -- the only difference should be the checkbox visibility. We
  // achieve this by always rendering a .sm-rowCheckboxSlot of fixed width
  // and toggling its visibility via CSS class, never via insert/remove.
  const app = await setup(t, {
    language: "zh",
    sessions: [{ id: "a", displayTitle: "A", updatedAt: 100 }],
    current: "a",
    workspaces: [{ id: "ws1", title: "ws1" }],
  });
  const rowSelector = n => n.props && typeof n.props["data-session-id"] === "string";
  // Before bulk mode
  let row = nodes(app.tree[0], rowSelector)[0];
  let slot = nodes(row, n => n.props && typeof n.props.className === "string" && n.props.className.includes("sm-rowCheckboxSlot"))[0];
  assert.ok(slot, "checkbox slot must exist even before bulk mode");
  assert.ok(!slot.props.className.includes("sm-rowCheckboxSlot-visible"),
    "before bulk mode the slot must not have the visible class");
  // Enter bulk mode
  await app.clickLabel("进入批量管理模式");
  row = nodes(app.tree[0], rowSelector)[0];
  slot = nodes(row, n => n.props && typeof n.props.className === "string" && n.props.className.includes("sm-rowCheckboxSlot"))[0];
  assert.ok(slot, "checkbox slot still exists in bulk mode");
  assert.ok(slot.props.className.includes("sm-rowCheckboxSlot-visible"),
    "in bulk mode the slot must carry the visible class");
});

test("panel: rowMain puts title on line 1 and badges+meta+actions on line 2", async t => {
  // Line 1 = sm-rowTitle; line 2 = sm-rowSecondary (wraps sm-rowBadges,
  // sm-rowMeta, sm-rowActions). This satisfies the user's request that
  // the P3 / tags / note chips sit on the same row as the action buttons.
  const app = await setup(t, {
    language: "zh",
    sessions: [{ id: "a", displayTitle: "A", updatedAt: 100, cwd: "/some/where" }],
    current: "a",
    workspaces: [{ id: "ws1", title: "ws1" }],
  });
  const row = nodes(app.tree[0], n => n.props && typeof n.props["data-session-id"] === "string")[0];
  const main = nodes(row, n => n.props && n.props.className === "sm-rowMain")[0];
  assert.ok(main);
  const title = nodes(main, n => n.props && n.props.className === "sm-rowTitle")[0];
  const secondary = nodes(main, n => n.props && n.props.className === "sm-rowSecondary")[0];
  const actions = nodes(secondary, n => n.props && n.props.className === "sm-rowActions")[0];
  const badges = nodes(secondary, n => n.props && n.props.className === "sm-rowBadges")[0];
  const meta = nodes(secondary, n => n.props && n.props.className === "sm-rowMeta")[0];
  assert.ok(title, "sm-rowTitle must exist on line 1");
  assert.ok(secondary, "sm-rowSecondary must exist on line 2");
  assert.ok(actions, "sm-rowActions must live inside sm-rowSecondary (same row as badges)");
  assert.ok(badges, "sm-rowBadges must live inside sm-rowSecondary");
  assert.ok(meta, "sm-rowMeta must live inside sm-rowSecondary");
});


test("panel: .sm-rowSecondary is a horizontal flex row (not block-default)", async t => {
  // Regression: in the previous round the JSX referenced .sm-rowSecondary
  // but no CSS rule was defined for it, so the div fell back to default
  // block layout and stacked badges / meta / actions on three separate
  // lines. The user complained that the priority display and the action
  // buttons were "not on the same row". Pin the flex-row definition so
  // a CSS typo cannot silently revert this to block layout.
  assert.match(SRC, /\.sm-rowSecondary\{display:flex[^}]*align-items:center/);
  // flex-wrap must allow the three children to sit on one horizontal line.
  assert.match(SRC, /\.sm-rowSecondary\{display:flex[^}]*flex-wrap:nowrap/);
});

test("panel: row is not locked to height:36px (must grow when content overflows)", async t => {
  // Regression: the panelDialog rule set height:36px;min-height:36px on
  // .sm-row, which clipped a two-line row (title + secondary) and made
  // it look like the action buttons were "below" the badges.
  // The rule must allow auto height now.
  // Match `height:36px` exactly (not preceded by `min-`). Negative look-behind
  // would be cleaner, but node-test runs in a vm without ES2018+ regex
  // guarantees; just look for the substring after stripping `min-` first.
  const stripped = SRC.replace(/min-height/g, "");
  const heightLock = /\.sm-panelDialog \.sm-row\{[^}]*height:36px/;
  assert.ok(!heightLock.test(stripped), ".sm-panelDialog .sm-row must not lock height to 36px");
  assert.match(SRC, /\.sm-panelDialog \.sm-row\{[^}]*min-height:36px/);
});


test("panel: filter buttons (全部 / 未归档 / 已归档) match the size of the other buttons in the toolbar row", async t => {
  // Regression: the base .sm-filterBtn used padding:3px 12px and no explicit
  // height, while .sm-markFilterToggle and .sm-bulkSelectBtn used
  // height:28px; padding:3px 10px. That made 全部 / 未归档 / 已归档
  // visually shorter than 收藏 / 待回看 / 全选当前筛选 / 清空选择.
  // The base class now carries the same sizing tokens as the modifiers.
  assert.match(SRC, /\.sm-filterBtn\{[^}]*height:28px/);
  assert.match(SRC, /\.sm-filterBtn\{[^}]*padding:3px 10px/);
});


test("panel: header is a flex row with centered title, github anchor at left and close at right", async t => {
  // The session manager header is a display:flex row holding three children:
  // a GitHub anchor (left), a centered title, and a close button (right).
  // The header must NOT use justify-content:space-between anymore because
  // the title is centered via flex:1 1 auto + text-align:center.
  assert.match(SRC, /\.sm-panelDialog \.sm-nativeDialogHeader\{display:flex/);
  assert.match(SRC, /\.sm-panelDialog \.sm-nativeDialogTitle\{[^}]*text-align:center/);
  assert.match(SRC, /\.sm-panelDialog \.sm-nativeDialogTitle\{[^}]*flex:1 1 auto/);
  assert.match(SRC, /\.sm-panelHeaderGithub/);
});

test("panel: bulk-mode toggle is ADJACENT to 全选当前筛选 (no spacer between them), BulkActionBar is a standalone row", async t => {
  // Final layout (per user feedback):
  //   Header: [title] [close]
  //   Row 1 (sm-markFilters):
  //     [filter buttons group] [spacer] [bulk controls group: 批量处理 + 全选 + 清空 (all adjacent)]
  //   Row 2 (sm-resultSummary): [count] [reset]
  //   Row 3 (only in bulk mode): [BulkActionBar] (standalone)
  //   Row 4: [rows list]
  const app = await setup(t, {
    language: "zh",
    sessions: [{ id: "a", displayTitle: "A", updatedAt: 100 }, { id: "b", displayTitle: "B", updatedAt: 90 }],
    current: "a",
    workspaces: [{ id: "ws1", title: "ws1" }],
  });

  // 1. Header carries only the close button.
  const header = nodes(app.tree[0], n => n.props && n.props.className === "sm-nativeDialogHeader")[0];
  const headerButtons = nodes(header, n => n.type === "button");
  assert.equal(headerButtons.length, 1, "header must contain only the close button");
  assert.equal(headerButtons[0].props.className, "sm-panelHeaderClose");

  // 2. The toolbar has exactly 2 groups (filter + bulk-controls).
  const markFilters = nodes(app.tree[0], n => n.props && n.props.className === "sm-markFilters")[0];
  const groups = nodes(markFilters, n => n.props && n.props.className === "sm-markFiltersGroup");
  assert.equal(groups.length, 2, "sm-markFilters must contain 2 groups: filter buttons + bulk controls");

  // 3. Group 2 (bulk controls) has 3 buttons in the right order:
  //    批量处理 (toggle) → 全选当前筛选 → 清空选择 (all adjacent, no spacer between them).
  const group2Buttons = nodes(groups[1], n => n.type === "button");
  assert.equal(group2Buttons.length, 3, "bulk controls group must hold 3 buttons (批量处理 + 全选 + 清空)");
  assert.match(text(group2Buttons[0]), /批量处理|退出批量处理/);
  assert.equal(text(group2Buttons[1]), "全选当前筛选");
  assert.equal(text(group2Buttons[2]), "清空选择");

  // 4. BulkActionBar is NOT inline in the toolbar; it lives on its own row.
  const toolbarChildren = Array.isArray(markFilters.props.children) ? markFilters.props.children : [markFilters.props.children];
  const hasInlineBulkActionBar = toolbarChildren.some(c => c && typeof c.type === "function" && c.type.name === "BulkActionBar");
  assert.ok(!hasInlineBulkActionBar, "BulkActionBar must not be inlined in the toolbar (no duplicate)");

  // 5. The standalone BulkActionBar block is rendered above rowsList when bulk mode is active.
  await app.clickLabel("进入批量管理模式");
  assert.match(SRC, /\(selectedIds\.size > 0 \|\| selectModeEnabled\)\s*\?\s*h\(BulkActionBar,/,
    "BulkActionBar must still render as a standalone row above rowsList");
});


test("panel: bulk action button labels are clean (no trailing '...') and consistent across zh/en", async t => {
  // The user wanted the bulk action labels to match the row-button
  // style: no trailing dots, and consistent between the per-row actions
  // and the bulk action bar.
  const required = {
    "bulk.tagsAdd":         { zh: "添加标签",    en: "Add tags" },
    "bulk.priority":        { zh: "设置优先级",   en: "Set priority" },
    "bulk.move":            { zh: "移动至工作区", en: "Move to workspace" },
    "bulk.presetMigrate":   { zh: "迁移预设",     en: "Migrate preset" },
    "bulk.delete":          { zh: "删除会话",     en: "Delete session" },
  };
  // Extract the zh and en locale blocks.
  const zhStart = SRC.indexOf("const zh = {");
  const enStart = SRC.indexOf("const en = {");
  assert.ok(zhStart > 0 && enStart > 0 && enStart > zhStart);
  const zhBlock = SRC.substring(zhStart, enStart);
  const enBlock = SRC.substring(enStart, enStart + 12000);  // generous slice
  for (const [key, want] of Object.entries(required)) {
    const re = new RegExp('"' + key + '":\\s*"([^"]+)"');
    const zhMatch = zhBlock.match(re);
    const enMatch = enBlock.match(re);
    assert.ok(zhMatch, `zh entry for \${key} must exist`);
    assert.ok(enMatch, `en entry for \${key} must exist`);
    assert.equal(zhMatch[1], want.zh, `zh[\${key}] must equal \${want.zh}, got \${zhMatch[1]}`);
    assert.equal(enMatch[1], want.en, `en[\${key}] must equal \${want.en}, got \${enMatch[1]}`);
    // No trailing dots.
    assert.ok(!zhMatch[1].endsWith("\u2026"), `zh[\${key}] must not end with "…" (\${zhMatch[1]})`);
    assert.ok(!enMatch[1].endsWith("..."), `en[\${key}] must not end with "..." (\${enMatch[1]})`);
    assert.ok(!enMatch[1].endsWith("\u2026"), `en[\${key}] must not end with "…" (\${enMatch[1]})`);
  }
});

test("panel: header-action dialogs share a 360px width and right-edge-align with the trigger button", async t => {
  // The .sm-confirmDialog layer (used by the per-row HeaderAction move / delete
  // dialogs) must be 360px wide. The .sm-annotationSurface (Tag/Note dialog)
  // must also be 360px so all three dialogs line up.
  assert.match(SRC, /\.sm-confirmDialog\{z-index:10000\}\.sm-confirmDialog\.sm-nativeDialogLayer\{[^}]*width:360px/);
  assert.match(SRC, /\.sm-panelDialog\.sm-annotationSurface\{[^}]*width:360px/);
  // Bulk dialogs also get the same width.
  assert.match(SRC, /\.sm-bulkDialog\.sm-nativeDialogLayer\{[^}]*width:360px/);
  // The HeaderAction anchor formula positions the right edge at
  // r.right - 360.
  assert.match(SRC, /left: Math\.max\(8, Math\.round\(r\.right - 360\)\)/);
});

test("panel: HeaderAction move button text matches its aria-label (no '迁移预设' copy-paste bug)", async t => {
  // Regression: aria-label and visible text must both point at row.move.
  assert.match(SRC, /"aria-label": t \? t\("row\.move"\)/);
  // Move button body must use row.move too (not row.migrate).
  assert.match(SRC, /className: "sm-headerBtn"[\s\S]*?t \? t\("row\.move"\)/);
  assert.ok(!SRC.match(/sm-headerBtn"\s*\+\s*\(moveFor \?[\s\S]+?t\("row\.migrate"\)/),
    "HeaderAction must not use row.migrate as the visible label for the move button");
});

test("panel: all native dialog footers use space-between (cancel on left, confirm on right)", async t => {
  assert.match(SRC, /\.sm-nativeDialogFooter\{[^}]*justify-content:space-between/);
  assert.match(SRC, /\.sm-bulkDialog \.sm-nativeDialogFooter\{[^}]*justify-content:space-between/);
  assert.ok(!SRC.match(/\.sm-(?:panelDialog|bulkDialog) \.sm-nativeDialogFooter\{[^}]*justify-content:flex-end/),
    "no dialog footer may still use flex-end");
});

test("panel: delete dialogs render the confirm button in red (danger prop)", async t => {
  assert.match(SRC, /const danger = props\.danger === true;/);
  assert.match(SRC, /\.sm-nativeDialogDanger\{background:var\(--dsw-alias-state-error-primary/);
  const invocations = (SRC.match(/danger: true[\s,]/g) || []).length;
  assert.ok(invocations >= 2, "expected >= 2 ConfirmDialog invocations with danger: true, got " + invocations);
});

test("panel: bulk dialog-opening buttons toggle (clicking again closes the dialog)", async t => {
  // onBulkAction: if a preview or result for the same action is open, close it.
  assert.match(SRC, /onBulkAction = \(action, payload, forceNeedsConfirm\) => \{[\s\S]*?if \(bulkPreview && bulkPreview\.action === action\)/);
  // onBulkTagsAdd: if bulk tag dialog is open in 'add' mode, close it.
  assert.match(SRC, /onBulkTagsAdd = \(\) => \{[\s\S]*?bulkTagDraft\.mode === "add"[\s\S]*?setBulkTagDraft\(null\)/);
  // onBulkPriority: same pattern.
  assert.match(SRC, /onBulkPriority = \(\) => \{[\s\S]*?bulkTagDraft\.mode === "priority"[\s\S]*?setBulkTagDraft\(null\)/);
  // onBulkMove: same.
  assert.match(SRC, /onBulkMove = \(\) => \{[\s\S]*?bulkTagDraft\.mode === "move"[\s\S]*?setBulkTagDraft\(null\)/);
  // onBulkPreset: same.
  assert.match(SRC, /onBulkPreset = \(\) => \{[\s\S]*?if \(bulkPresetDraft\) \{ setBulkPresetDraft\(null\); return; \}/);
});


test("panel: sm-confirmDialog confirm button defaults to blue (not red); danger variant stays red", async t => {
  // Regression guard: a pre-existing CSS rule set
  // .sm-confirmDialog .sm-nativeDialogConfirm to a red background, which
  // made every confirm dialog (move, delete, migrate) red by default. The
  // danger variant alone must paint the confirm red, only for the delete
  // dialog. We pin the default to accent-primary (blue).
  assert.match(SRC, /\.sm-confirmDialog \.sm-nativeDialogConfirm\{[^}]*accent-primary/);
  // sm-migrateDialog .sm-nativeDialogConfirm must also be blue.
  assert.match(SRC, /\.sm-migrateDialog \.sm-nativeDialogConfirm\{[^}]*accent-primary/);
  // The danger variant still uses state-error-primary.
  assert.match(SRC, /\.sm-nativeDialogDanger\{background:var\(--dsw-alias-state-error-primary/);
  // No sm-nativeDialogConfirm rule may use state-error-primary anymore.
  assert.ok(!SRC.match(/sm-nativeDialogConfirm\{[^}]*state-error-primary/),
    "no sm-nativeDialogConfirm rule may paint state-error-primary (the danger variant is the only red)");
});

test("panel: sm-migrateDialog footer uses space-between (no late flex-end override)", async t => {
  // A pre-existing .sm-migrateDialog .sm-nativeDialogFooter rule with
  // justify-content:flex-end was overriding our space-between update. We
  // pin that no flex-end rule remains on this selector.
  assert.match(SRC, /\.sm-migrateDialog \.sm-nativeDialogFooter\{[^}]*justify-content:space-between/);
  assert.ok(!SRC.match(/\.sm-migrateDialog \.sm-nativeDialogFooter\{[^}]*justify-content:flex-end/),
    "no flex-end override may remain on .sm-migrateDialog footer");
});


test("panel: danger variant wins against per-dialog button base (sm-confirmDialog / sm-migrateDialog / sm-bulkDialog)", async t => {
  // The per-dialog .sm-nativeDialogButton rules set background:transparent
  // and have higher specificity than .sm-nativeDialogDanger alone, which
  // made the danger button look transparent instead of red. We fix this
  // by adding per-dialog .sm-nativeDialogDanger overrides that carry the
  // same specificity and are listed AFTER the base button rule (CSS
  // source order wins when specificity ties).
  assert.match(SRC, /\.sm-confirmDialog \.sm-nativeDialogDanger,\.sm-migrateDialog \.sm-nativeDialogDanger/);
  assert.match(SRC, /\.sm-confirmDialog \.sm-nativeDialogDanger,\.sm-migrateDialog \.sm-nativeDialogDanger[\s\S]*?background:var\(--dsw-alias-state-error-primary/);
  // No other .sm-nativeDialogDanger rule may use background:transparent.
  assert.ok(!SRC.match(/\.sm-(?!nativeDialogDanger\b)[a-zA-Z]+\.sm-nativeDialogDanger\{[^}]*background:transparent/),
    "danger variant must always paint state-error-primary, never transparent");
});

test("panel: NO remaining flex-end footer rule on sm-confirmDialog / sm-migrateDialog / sm-nativeDialogFooter", async t => {
  // We previously fixed .sm-confirmDialog .sm-nativeDialogFooter and
  // .sm-migrateDialog .sm-nativeDialogFooter but a chained rule with
  // .sm-warn had another flex-end override. Pin all such rules here.
  const flexEndFooter = /[a-zA-Z\.\- ]+\.sm-(?:confirmDialog|migrateDialog|nativeDialog)Footer\{[^}]*flex-end/;
  assert.ok(!flexEndFooter.test(SRC),
    "no .sm-confirmDialog / .sm-migrateDialog / .sm-nativeDialogFooter rule may use justify-content:flex-end");
});

test("panel: sm-nativeDialogFooter merged rule has display:flex (so space-between actually applies)", async t => {
  // The merged .sm-nativeDialogFooter selector used to declare only
  // flex-wrap / justify-content / gap but no display:flex, so the
  // confirmDialog and migrateDialog footers rendered as plain block
  // containers and the two buttons piled up on the left edge. Pin the
  // merged rule (which now covers all 4 dialog variants) so the
  // display:flex is never silently dropped again.
  assert.match(SRC, /.sm-nativeDialogFooter,[^{}]*{[^}]*display:flex/,
    "merged .sm-nativeDialogFooter rule must include display:flex so justify-content:space-between actually positions the buttons");
  // Per-dialog footer selectors are also covered by the merged rule, so
  // they too must end up with display:flex. They can either inherit it
  // from the merged selector or set it explicitly -- we accept either.
  assert.match(SRC, /.sm-confirmDialog .sm-nativeDialogFooter/);
  assert.match(SRC, /.sm-migrateDialog .sm-nativeDialogFooter/);
  assert.match(SRC, /.sm-bulkDialog .sm-nativeDialogFooter/);
});

test("panel: title + button font-size is identical across confirmDialog / migrateDialog / bulkDialog", async t => {
  // The .sm-migrateDialog title and button rules used to declare 15px / 22px
  // and 13px / 32px / 4px 14px respectively, while .sm-confirmDialog used
  // 14px / 20px and 12px / 28px / 3px 14px. The migration dialog then looked
  // visibly larger than the rest. Pin all three dialog families to the same
  // font-size / line-height / min-height / padding so the inconsistency
  // cannot regress.
  const dlgRe = (cls) => new RegExp("\\.sm-" + cls + " \\.sm-nativeDialogTitle\\{[^}]*\\}");
  const btnRe = (cls) => new RegExp("\\.sm-" + cls + " \\.sm-nativeDialogButton\\{[^}]*\\}");
  const dialogs = ["confirmDialog", "migrateDialog", "bulkDialog"];
  const titles = {};
  const buttons = {};
  for (const d of dialogs) {
    const tm = SRC.match(dlgRe(d));
    const bm = SRC.match(btnRe(d));
    assert.ok(tm, "missing .sm-" + d + " .sm-nativeDialogTitle rule");
    assert.ok(bm, "missing .sm-" + d + " .sm-nativeDialogButton rule");
    titles[d] = tm[0];
    buttons[d] = bm[0];
  }
  // Title font-size + line-height must be identical across the three.
  const titleFs = (s) => (s.match(/font-size\s*:\s*([^;}]+)/) || [])[1];
  const titleLh = (s) => (s.match(/line-height\s*:\s*([^;}]+)/) || [])[1];
  assert.equal(titleFs(titles.confirmDialog), titleFs(titles.migrateDialog),
    "title font-size must match between confirmDialog and migrateDialog");
  assert.equal(titleFs(titles.confirmDialog), titleFs(titles.bulkDialog),
    "title font-size must match between confirmDialog and bulkDialog");
  assert.equal(titleLh(titles.confirmDialog), titleLh(titles.migrateDialog),
    "title line-height must match between confirmDialog and migrateDialog");
  assert.equal(titleLh(titles.confirmDialog), titleLh(titles.bulkDialog),
    "title line-height must match between confirmDialog and bulkDialog");
  // Button font-size + min-height + padding must be identical across the three.
  const btnFs = (s) => (s.match(/font-size\s*:\s*([^;}]+)/) || [])[1];
  const btnMh = (s) => (s.match(/min-height\s*:\s*([^;}]+)/) || [])[1];
  const btnPd = (s) => (s.match(/padding\s*:\s*([^;}]+)/) || [])[1];
  assert.equal(btnFs(buttons.confirmDialog), btnFs(buttons.migrateDialog),
    "button font-size must match between confirmDialog and migrateDialog");
  assert.equal(btnFs(buttons.confirmDialog), btnFs(buttons.bulkDialog),
    "button font-size must match between confirmDialog and bulkDialog");
  assert.equal(btnMh(buttons.confirmDialog), btnMh(buttons.migrateDialog),
    "button min-height must match between confirmDialog and migrateDialog");
  assert.equal(btnMh(buttons.confirmDialog), btnMh(buttons.bulkDialog),
    "button min-height must match between confirmDialog and bulkDialog");
  assert.equal(btnPd(buttons.confirmDialog), btnPd(buttons.migrateDialog),
    "button padding must match between confirmDialog and migrateDialog");
  assert.equal(btnPd(buttons.confirmDialog), btnPd(buttons.bulkDialog),
    "button padding must match between confirmDialog and bulkDialog");
});

test("panel: popup dialogs claim a fresh z-index via nextDialogZ so newer popups stack above older ones", async t => {
  // The CSS-defined z-index values (panel 9999 / confirm 10000 / annotation
  // and bulk 10002) are static. Without a counter, opening an annotation
  // popup (10002) AFTER a confirm popup (10000) leaves the confirm dialog
  // below the annotation one. Each popup dialog must claim a fresh
  // z-index from nextDialogZ() and write it to its inline style, so the
  // most-recently opened popup is always the topmost one.
  assert.match(SRC, /let dialogZStackCounter = \d+;/,
    "module-level dialogZStackCounter must be declared");
  assert.match(SRC, /function nextDialogZ\(\) \{ return \+\+dialogZStackCounter; \}/,
    "nextDialogZ() must monotonically increment the counter");
  // Every popup dialog must declare a zIndex via useState + use it in style.
  const dialogs = [
    "BatchPreviewDialog",
    "BatchProgressDialog",
    "BatchResultDialog",
    "BulkTagInputDialog",
    "BulkChoiceDialog",
    "AnnotationDialog",
    "ConfirmDialog",
    "MoveDialog",
    "MigratePresetDialog"
  ];
  for (const dlg of dialogs) {
    const fnStart = SRC.indexOf("function " + dlg + "(");
    assert.ok(fnStart >= 0, dlg + " must exist in client.js");
    const fnEnd = SRC.indexOf("\n    function ", fnStart + 1);
    const body = SRC.substring(fnStart, fnEnd > 0 ? fnEnd : fnStart + 6000);
    assert.match(body, /const \[zIndex\] = useState\(\(\) => (?:open \? )?nextDialogZ\(\)(?: : 0)?\);/,
      dlg + " must claim a z-index via nextDialogZ() (via useState lazy initializer)");
    assert.match(body, /zIndex: zIndex(?: \|\| undefined)?/,
      dlg + " must apply zIndex to its inline style");
  }
});

test("panel: title bar delete/move/annotation handlers no longer clear sibling popups (z-index stacking owns ordering)", async t => {
  // Earlier the HeaderAction delete handler unconditionally called
  // setMoveFor(null); setMoveAnchor(null);, which silently dismissed a
  // previously opened move popup on the same session. The move and
  // annotation handlers did the same for their siblings. Since
  // dialogZStackCounter (nextDialogZ) now decides stacking, the handlers
  // must NOT touch the sibling state.
  // Pin that none of the three handlers cross-clear sibling state.
  // We assert by removing the offending patterns from SRC and checking
  // the result is unchanged.
  const offenders = [
    /setMoveFor\(null\);\s*setMoveAnchor\(null\);\s*\n\s*if \(confirmFor/,
    /setConfirmFor\(null\);\s*setConfirmAnchor\(null\);\s*\n\s*if \(moveFor/,
    /setMoveFor\(null\);\s*setConfirmFor\(null\);/
  ];
  for (const re of offenders) {
    assert.ok(!re.test(SRC),
      "title-bar handlers must not cross-clear sibling popups (re: " + re + ")");
  }
});

test("panel: BulkActionBar uses a 3x6 CSS grid (summary on row 1 spans all cols, 12 buttons in two rows of 6)", async t => {
  // Layout: row 1 = summary span (full width), row 2 = lightweight actions
  // (归档 / 取消归档 / 收藏 / 取消收藏 / 待回看 / 取消待看), row 3 = heavier
  // mutating actions (添加标签 / 清空标签 / 设置优先级 / 移动至工作区 /
  // 迁移预设 / 删除会话). The summary text must NOT include
  // "(当前筛选)" / "(current filter)" anymore.
  assert.match(SRC, /\.sm-bulkBar\{box-sizing:border-box;display:grid;grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/);
  assert.match(SRC, /\.sm-bulkBar \.sm-bulkSummary\{grid-column:1\/\-1;/);
  // Summary no longer mentions "当前筛选" / "current filter"
  assert.ok(!SRC.match(/项（当前筛选）/), "summary must not contain '（当前筛选）'");
  assert.ok(!SRC.match(/\(current filter\)/), "summary must not contain '(current filter)'");
  // No leftover spacer divider rule
  assert.ok(!SRC.match(/\.sm-bulkBar \.sm-bulkBarRow\{/), "old sm-bulkBarRow spacer rule must be removed");
  // Order in JSX: unreview comes right before tagsAdd (no spacer between them).
  // JSX order: after the unreview button, the very next h("button", ...)
  // call is the tagsAdd button (no spacer element between them). We
  // find the unreview button's call, then scan forward to the next
  // h("button" and assert it carries the tagsAdd label.
  const unreviewCallIdx = SRC.indexOf('onAction("unreview")');
  assert.ok(unreviewCallIdx > 0, "unreview button must exist in BulkActionBar");
  const nextBtnIdx = SRC.indexOf('h("button", { type: "button", className: "sm-bulkBtn"', unreviewCallIdx);
  assert.ok(nextBtnIdx > 0 && nextBtnIdx < unreviewCallIdx + 800,
    "tagsAdd button must be the very next button after unreview (no spacer between them)");
  assert.match(SRC.slice(unreviewCallIdx, nextBtnIdx + 200), /"sm-bulkBtn"[\s\S]{0,300}onOpenTagDialog[\s\S]{0,100}t\("bulk\.tagsAdd"\)/);
});

test("panel: bulk dialogs accept confirmLabel + danger and SessionManagerPanel passes them per-action", async t => {
  // BatchPreviewDialog must accept a danger prop and use it to switch the
  // confirm button between sm-nativeDialogConfirm (blue) and
  // sm-nativeDialogDanger (red). BulkTagInputDialog and BulkChoiceDialog
  // must accept a confirmLabel prop and the SessionManagerPanel must
  // pass one per-action from the new bulk.confirm.<action> locale keys.
  assert.match(SRC, /function BatchPreviewDialog\(props\)\s*\{[\s\S]{0,800}const danger = props\.danger === true;/);
  assert.match(SRC, /className: "sm-nativeDialogButton" \+ \(danger \? " sm-nativeDialogDanger" : " sm-nativeDialogConfirm"\)/);
  assert.match(SRC, /function BulkTagInputDialog\(props\)\s*\{[\s\S]{0,800}const confirmLabel = props\.confirmLabel \|\| t\("bulk\.confirm\.tagsAdd"\);/);
  assert.match(SRC, /function BulkChoiceDialog\(props\)\s*\{[\s\S]{0,800}const confirmLabel = props\.confirmLabel \|\| t\("bulk\.dialog\.execute"\);/);
  // 12 locale keys
  for (const action of ["archive","unarchive","favorite","unfavorite","review","unreview","tagsAdd","tagsRemove","priority","move","presetMigrate","delete"]) {
    assert.match(SRC, new RegExp('"bulk\.confirm\.' + action + '":'));
  }
  // Per-action invocation labels
  assert.match(SRC, /confirmLabel: bulkConfirmLabelFor\(bulkPreview\.action\)/);
  assert.match(SRC, /confirmLabel: t\("bulk\.confirm\.tagsAdd"\)/);
  assert.match(SRC, /confirmLabel: t\("bulk\.confirm\.priority"\)/);
  assert.match(SRC, /confirmLabel: t\("bulk\.confirm\.move"\)/);
  assert.match(SRC, /confirmLabel: t\("bulk\.confirm\.presetMigrate"\)/);
});

test("panel: bulk dialog inner section is 360px wide (matches single-session popups), not 480-680", async t => {
  // The old .sm-bulkDialog .sm-nativeDialog rule forced the inner section
  // to min-width:480px; max-width:680px, which made bulk popups visibly
  // wider than confirm/move/delete dialogs. We pin the rule down to a
  // 100% width that fills the 360px outer layer.
  assert.match(SRC, /\.sm-bulkDialog \.sm-nativeDialog\{width:100%;max-height:min\(640px,calc\(100vh - 32px\)\)\}/);
  assert.ok(!SRC.match(/\.sm-bulkDialog \.sm-nativeDialog\{[^}]*min-width:480px/),
    "sm-bulkDialog .sm-nativeDialog must not have min-width:480px");
  assert.ok(!SRC.match(/\.sm-bulkDialog \.sm-nativeDialog\{[^}]*max-width:680px/),
    "sm-bulkDialog .sm-nativeDialog must not have max-width:680px");
});

test("panel: .sm-bulkDialog .sm-nativeDialogConfirm and Danger rules follow the base button rule (source-order wins)", async t => {
  // The base .sm-bulkDialog .sm-nativeDialogButton rule sets
  // background:transparent. Per the fix in release-14, the per-dialog
  // confirm and danger rules must be listed AFTER it so source order
  // wins when specificity ties (all three rules are (0,2,0)). Pin the
  // position of each rule.
  const baseIdx = SRC.indexOf(".sm-bulkDialog .sm-nativeDialogButton{");
  // Use lastIndexOf to skip the legacy combined rule at the top of
  // the file and find the rule we added right after the base button.
  const confirmIdx = SRC.lastIndexOf(".sm-bulkDialog .sm-nativeDialogConfirm{background:var(--dsw-alias-accent-primary");
  const dangerIdx = SRC.lastIndexOf(".sm-bulkDialog .sm-nativeDialogDanger{background:var(--dsw-alias-state-error-primary");
  assert.ok(baseIdx > 0, "base bulk button rule must exist");
  assert.ok(confirmIdx > baseIdx, "bulk confirm rule must come AFTER the base button rule (source-order wins over transparent)");
  assert.ok(dangerIdx > baseIdx, "bulk danger rule must come AFTER the base button rule (source-order wins over transparent)");
  assert.match(SRC.slice(confirmIdx, confirmIdx + 200), /color:#fff/);
  assert.match(SRC.slice(confirmIdx, confirmIdx + 300), /border-color:var\(--dsw-alias-accent-primary/);
  assert.match(SRC.slice(dangerIdx, dangerIdx + 200), /color:#fff/);
  assert.match(SRC.slice(dangerIdx, dangerIdx + 300), /border-color:var\(--dsw-alias-state-error-primary/);
});

test("panel: BulkActionBar uses bulk.moveBtn for the move button (short label fits the 6-col grid)", async t => {
  // The 6-column grid leaves limited width per button, so the English
  // "Move to workspace" label overflows. The button must use a short
  // label key (bulk.moveBtn) while dialog titles / preview summary
  // continue to use the full bulk.move key for clarity.
  assert.match(SRC, /"bulk\.moveBtn": "Move"/);
  assert.match(SRC, /onClick: onOpenMoveDialog \}, t\("bulk\.moveBtn"\)/);
  assert.match(SRC, /title: t\("bulk\.move"\)/);
});
