import { test } from "node:test";
import assert from "node:assert/strict";
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
