import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

test("workspace archive: panel tab navigation switches between sessions and workspaces", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha Project", path: "D:/projects/alpha", updatedAt: 1500, sessionIds: ["s1"] },
      { id: "ws2", name: "Beta Project", path: "D:/projects/beta", updatedAt: 2500, sessionIds: ["s2"] }
    ]
  });
  await app.flush();

  // Tab buttons exist in header nav
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  assert.equal(navTabs.length, 2, "must have 2 navigation tabs");
  assert.equal(text(navTabs[0]), "会话管理");
  assert.equal(text(navTabs[1]), "工作区管理");
  assert.equal(navTabs[0].props["aria-selected"], true);
  assert.equal(navTabs[1].props["aria-selected"], false);

  // Initially showing session management
  let sessionRows = app.rowIds();
  assert.equal(sessionRows.length, 2);

  // Switch to workspace management
  navTabs[1].props.onClick();
  await app.flush();

  const activeTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  assert.equal(activeTabs[1].props["aria-selected"], true);

  // Check workspace rows rendered
  const wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 2, "should render 2 workspace rows");

  // Check workspace row contents
  const titles = wsRows.map(r => text(nodes(r, n => n.props?.className === "sm-rowTitle")[0]));
  assert.ok(titles.some(t => t.includes("Alpha Project")));
  assert.ok(titles.some(t => t.includes("Beta Project")));

  // Switch back to session management
  activeTabs[0].props.onClick();
  await app.flush();
  sessionRows = app.rowIds();
  assert.equal(sessionRows.length, 2);

  app.dispose();
});

test("workspace archive: search, filter, and sort on workspace management page", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 5000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/work/alpha", updatedAt: 500, sessionIds: ["s1"] },
      { id: "ws2", name: "Beta", path: "D:/work/beta", updatedAt: 800, sessionIds: ["s2"] },
      { id: "ws3", name: "Gamma", path: "D:/work/gamma", updatedAt: null, sessionIds: [] }
    ]
  });
  await app.flush();

  // Switch to workspace management
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  // All 3 workspaces initially listed (sorted updated-desc: ws2 has s2 at 5000, ws1 has s1 at 1000, ws3 has null)
  let wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 3);
  assert.equal(wsRows[0].props["data-workspace-id"], "ws2");
  assert.equal(wsRows[1].props["data-workspace-id"], "ws1");
  assert.equal(wsRows[2].props["data-workspace-id"], "ws3");

  // Search by keyword in name
  const searchInput = nodes(app.tree[0], n => n.type === "input" && n.props?.type === "search")[0];
  searchInput.props.onChange({ target: { value: "alpha" } });
  await app.flush();
  wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 1);
  assert.equal(wsRows[0].props["data-workspace-id"], "ws1");

  // Search by keyword in path
  searchInput.props.onChange({ target: { value: "work/gamma" } });
  await app.flush();
  wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 1);
  assert.equal(wsRows[0].props["data-workspace-id"], "ws3");

  // Reset search
  searchInput.props.onChange({ target: { value: "" } });
  await app.flush();

  // Sort updated-asc (ws1 at 1000, ws2 at 5000, ws3 null at end)
  const sortSelect = nodes(app.tree[0], n => n.type === "select" && n.props?.value?.startsWith("updated-"))[0];
  sortSelect.props.onChange({ target: { value: "updated-asc" } });
  await app.flush();
  wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 3);
  assert.equal(wsRows[0].props["data-workspace-id"], "ws1");
  assert.equal(wsRows[1].props["data-workspace-id"], "ws2");
  assert.equal(wsRows[2].props["data-workspace-id"], "ws3");

  // Reset filters button
  const resetBtn = nodes(app.tree[0], n => n.type === "button" && n.props?.className === "sm-resetFilters")[0];
  assert.ok(resetBtn, "reset button must be visible when view is modified");
  resetBtn.props.onClick();
  await app.flush();

  wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows[0].props["data-workspace-id"], "ws2");

  app.dispose();
});

test("workspace archive: toggle switch archives workspace and its sessions with confirmation", async () => {
  const archivedViaCommands = [];
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/work/alpha", updatedAt: 500, sessionIds: ["s1", "s2"] }
    ]
  });

  // Track archive command calls
  app.ctx.uiWorkspace.archiveSession = async (id, opts) => {
    archivedViaCommands.push({ id, opts });
  };
  await app.flush();

  // Switch to workspace management
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  let wsRow = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "ws1")[0];
  let toggle = nodes(wsRow, n => n.props?.role === "switch")[0];
  assert.equal(toggle.props["aria-checked"], true, "switch should be checked initially (active)");
  assert.equal(toggle.props.title, undefined, "switch must have no hover title");

  // Click toggle to turn OFF -> archive workspace directly without confirmation
  await toggle.props.onClick();
  await app.flush();

  const confirmModal = nodes(app.tree, n => n.type?.name === "ConfirmDialog")[0];
  assert.equal(confirmModal, undefined, "confirm dialog must NOT open (no secondary confirmation)");

  // Verify sessions were archived via DSH command with stopActivity: false
  assert.equal(archivedViaCommands.length, 2);
  assert.equal(archivedViaCommands[0].id, "s1");
  assert.equal(archivedViaCommands[0].opts?.stopActivity, false);
  assert.equal(archivedViaCommands[1].id, "s2");

  // Verify switch is now unchecked (archived)
  wsRow = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "ws1")[0];
  toggle = nodes(wsRow, n => n.props?.role === "switch")[0];
  assert.equal(toggle.props["aria-checked"], false, "switch should now be unchecked (archived)");

  // Badge is shown
  assert.ok(text(wsRow).includes("已归档"));

  // Check filter: switching to '未归档' hides it, switching to '已归档' shows it
  const filterBtns = nodes(app.tree[0], n => n.props?.className && n.props.className.includes("sm-filterBtn"));
  const activeFilterBtn = filterBtns.find(b => text(b) === "未归档");
  const archivedFilterBtn = filterBtns.find(b => text(b) === "已归档");

  activeFilterBtn.props.onClick();
  await app.flush();
  let filteredRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(filteredRows.length, 0);

  archivedFilterBtn.props.onClick();
  await app.flush();
  filteredRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(filteredRows.length, 1);

  app.dispose();
});

test("workspace archive: native sidebar hiding and preventing ungrouped spill", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Visible WS", path: "D:/work/ws1", updatedAt: 500, sessionIds: ["s1"] },
      { id: "ws2", name: "To Archive WS", path: "D:/work/ws2", updatedAt: 800, sessionIds: ["s2"] }
    ]
  });
  await app.flush();

  const model = app.ctx.workspaces.list;
  assert.ok(model.__dshSmWorkspaceModel, "model should be marked as wrapped");

  // Initially both are visible in snapshot
  let snapshot = model.getSnapshot();
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.archivedSessionIds.length, 0);

  // Archive ws2
  const store = app.exports.workspaceArchiveStore;
  store.saveArchiveRecord("ws2", {
    workspaceId: "ws2",
    archived: true,
    archivedAt: Date.now(),
    sessionIds: ["s2"],
    pending: []
  });

  // Snapshot now filters ws2 and includes s2 in archivedSessionIds
  snapshot = model.getSnapshot();
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].id, "ws1");
  assert.ok(snapshot.archivedSessionIds.includes("s2"), "s2 must be in archivedSessionIds so DSH does not spill it into ungrouped");

  // Referential stability: consecutive calls with same data return the same reference
  const snapshotAgain = model.getSnapshot();
  assert.strictEqual(snapshot, snapshotAgain, "getSnapshot must return referentially stable snapshot for React useSyncExternalStore");

  // Restore ws2
  store.removeArchiveRecord("ws2");
  snapshot = model.getSnapshot();
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.archivedSessionIds.length, 0);

  app.dispose();
});

test("workspace archive: unarchive restores workspace and previously workspace-archived sessions", async () => {
  const unarchivedViaCommands = [];
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    archivedIds: ["s1", "s2"],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/work/alpha", updatedAt: 500, sessionIds: ["s1", "s2"] }
    ]
  });

  app.ctx.uiWorkspace.unarchiveSession = async (id) => {
    unarchivedViaCommands.push(id);
  };

  // Seed archive store
  app.exports.workspaceArchiveStore.saveArchiveRecord("ws1", {
    workspaceId: "ws1",
    archived: true,
    archivedAt: Date.now(),
    sessionIds: ["s1", "s2"],
    pending: []
  });

  await app.flush();

  // Navigate to workspaces
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  let wsRow = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "ws1")[0];
  let toggle = nodes(wsRow, n => n.props?.role === "switch")[0];
  assert.equal(toggle.props["aria-checked"], false);

  // Turn ON -> restore
  await toggle.props.onClick();
  await app.flush();

  // Verify unarchive called for both sessions
  assert.deepEqual(unarchivedViaCommands.sort(), ["s1", "s2"].sort());

  // Verify switch is now checked
  wsRow = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "ws1")[0];
  toggle = nodes(wsRow, n => n.props?.role === "switch")[0];
  assert.equal(toggle.props["aria-checked"], true);

  app.dispose();
});

test("workspace archive: individually archived sessions stay archived on workspace restore", async () => {
  const unarchivedViaCommands = [];
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Active Session", updatedAt: 1000 },
      { id: "s2", displayTitle: "Already Archived Session", updatedAt: 2000 }
    ],
    archivedIds: ["s2"], // s2 was individually archived beforehand
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/work/alpha", updatedAt: 500, sessionIds: ["s1", "s2"] }
    ]
  });

  app.ctx.uiWorkspace.archiveSession = async (id) => {
    app.ctx.workspaces.list.archivedSessionIds.push(id);
  };
  app.ctx.uiWorkspace.unarchiveSession = async (id) => {
    unarchivedViaCommands.push(id);
  };
  await app.flush();

  // Navigate to workspaces
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  // Toggle switch OFF (archive) directly without confirmation
  let wsRow = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "ws1")[0];
  let toggle = nodes(wsRow, n => n.props?.role === "switch")[0];
  await toggle.props.onClick();
  await app.flush();

  const confirmModal = nodes(app.tree, n => n.type?.name === "ConfirmDialog")[0];
  assert.equal(confirmModal, undefined, "confirm dialog must NOT open");

  // Now record only has s1 in sessionIds
  const record = app.exports.workspaceArchiveStore.getRecord("ws1");
  assert.deepEqual([...record.sessionIds], ["s1"], "only s1 was archived by the workspace archive action");

  // Toggle switch ON (restore)
  wsRow = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "ws1")[0];
  toggle = nodes(wsRow, n => n.props?.role === "switch")[0];
  await toggle.props.onClick();
  await app.flush();

  // Only s1 was unarchived; s2 remains untouched
  assert.deepEqual(unarchivedViaCommands, ["s1"], "s2 remains archived");

  app.dispose();
});

test("workspace archive: refuses archiving if an unarchived session is currently running", async () => {
  const alerts = [];
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Running Session", running: true, updatedAt: 1000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/work/alpha", updatedAt: 500, sessionIds: ["s1"] }
    ]
  });
  app.window.alert = (msg) => alerts.push(msg);
  await app.flush();

  // Switch to workspace management
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  const wsRow = nodes(app.tree[0], n => n.props?.["data-workspace-id"] === "ws1")[0];
  const toggle = nodes(wsRow, n => n.props?.role === "switch")[0];
  toggle.props.onClick();
  await app.flush();

  // Alert fired and confirm dialog is NOT opened
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0], "工作区「Alpha」中的会话「Running Session」正在运行，结束后可归档。");
  const confirmModal = nodes(app.tree[0], n => n.props?.className && n.props.className.includes("sm-confirmDialog"))[0];
  assert.equal(confirmModal, undefined, "confirm dialog must not open when session is running");

  app.dispose();
});

test("workspace archive: rollbacks on partial archive failure", async () => {
  const alerts = [];
  const archived = [];
  const unarchived = [];
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/work/alpha", updatedAt: 500, sessionIds: ["s1", "s2"] }
    ]
  });
  app.window.alert = (msg) => alerts.push(msg);

  app.ctx.uiWorkspace.archiveSession = async (id) => {
    if (id === "s2") throw new Error("Simulated disk error on s2");
    archived.push(id);
  };
  app.ctx.uiWorkspace.unarchiveSession = async (id) => {
    unarchived.push(id);
  };
  await app.flush();

  const result = await app.exports.executeArchiveWorkspace("ws1", {
    allWorkspaces: [{ id: "ws1", sessionIds: ["s1", "s2"] }],
    t: app.t
  });

  assert.equal(result, false, "executeArchiveWorkspace returns false on failure");
  assert.deepEqual(archived, ["s1"]);
  assert.deepEqual(unarchived, ["s1"], "s1 was rolled back (unarchived)");
  assert.equal(app.exports.workspaceArchiveStore.isArchived("ws1"), false, "workspace must NOT be marked archived");
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes("Simulated disk error on s2"));

  app.dispose();
});

test("workspace archive: plugin disposal cleans up wrapped model without memory leaks", async () => {
  const app = await mountClient({
    workspaces: [{ id: "ws1", name: "WS 1", path: "D:/ws1", sessionIds: [] }]
  });
  await app.flush();

  const model = app.ctx.workspaces.list;
  assert.equal(model.__dshSmWorkspaceModel, true);

  // Dispose plugin
  app.dispose();

  assert.equal(model.__dshSmWorkspaceModel, undefined, "model mark must be deleted");

  app.dispose();
});

test("workspace archive: migrates legacy dsh-workspace-hide localStorage and restores immediately on startup", async () => {
  // Seed legacy key in initialStorage
  const legacyPayload = JSON.stringify({
    version: 2,
    hidden: {
      "ws-legacy": ["s-leg-1", "s-leg-2"]
    }
  });

  const app = await mountClient({
    initialStorage: {
      "dsh-workspace-hide.hidden.v2": legacyPayload
    },
    workspaces: [
      { id: "ws-legacy", name: "Legacy WS", path: "D:/legacy", sessionIds: ["s-leg-1", "s-leg-2"] }
    ]
  });
  await app.flush();

  const store = app.exports.workspaceArchiveStore;
  assert.equal(store.isArchived("ws-legacy"), true, "legacy hidden workspace is migrated to archived: true");
  const record = store.getRecord("ws-legacy");
  assert.deepEqual([...record.sessionIds], ["s-leg-1", "s-leg-2"]);

  // Sidebar snapshot hides it immediately
  const snapshot = app.ctx.workspaces.list.getSnapshot();
  assert.equal(snapshot.items.length, 0, "legacy workspace hidden from sidebar items");
  assert.ok(snapshot.archivedSessionIds.includes("s-leg-1"));
  assert.ok(snapshot.archivedSessionIds.includes("s-leg-2"));

  app.dispose();
});

test("workspace archive: partial restore failure retains pending list and alerts user", async () => {
  const alerts = [];
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    archivedIds: ["s1", "s2"],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/work/alpha", updatedAt: 500, sessionIds: ["s1", "s2"] }
    ]
  });
  app.window.alert = (msg) => alerts.push(msg);

  // Seed archive store
  app.exports.workspaceArchiveStore.saveArchiveRecord("ws1", {
    workspaceId: "ws1",
    archived: true,
    archivedAt: Date.now(),
    sessionIds: ["s1", "s2"],
    pending: []
  });

  app.ctx.uiWorkspace.unarchiveSession = async (id) => {
    if (id === "s2") throw new Error("Simulated unarchive failure on s2");
  };

  const result = await app.exports.executeUnarchiveWorkspace("ws1", { t: app.t });
  assert.equal(result, false, "unarchive reports failure");

  const record = app.exports.workspaceArchiveStore.getRecord("ws1");
  assert.equal(record.archived, true, "workspace remains marked archived when partial unarchive fails");
  assert.deepEqual([...record.pending], ["s2"], "failed session is stored in pending list for retry");
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes("失败"));

  app.dispose();
});

test("workspace archive: tab switching preserves search and filter states on both tabs", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Unique Session A", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session B", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha Workspace", path: "D:/alpha", updatedAt: 500, sessionIds: ["s1"] },
      { id: "ws2", name: "Beta Workspace", path: "D:/beta", updatedAt: 800, sessionIds: ["s2"] }
    ]
  });
  await app.flush();

  // Tab 1 (Sessions): enter search query
  const sessionSearch = nodes(app.tree[0], n => n.type === "input" && n.props?.type === "search")[0];
  sessionSearch.props.onChange({ target: { value: "unique" } });
  await app.flush();
  assert.equal(app.rowIds().length, 1);

  // Switch to Tab 2 (Workspaces)
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  // Enter workspace search query
  const wsSearch = nodes(app.tree[0], n => n.type === "input" && n.props?.type === "search")[0];
  wsSearch.props.onChange({ target: { value: "beta" } });
  await app.flush();
  let wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 1);
  assert.equal(wsRows[0].props["data-workspace-id"], "ws2");

  // Switch back to Tab 1 (Sessions)
  const tabsNow = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  tabsNow[0].props.onClick();
  await app.flush();

  // Session search preserved
  assert.equal(app.rowIds().length, 1);
  assert.equal(app.rowIds()[0], "s1");

  // Switch back to Tab 2 (Workspaces)
  tabsNow[1].props.onClick();
  await app.flush();

  // Workspace search preserved
  wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 1);
  assert.equal(wsRows[0].props["data-workspace-id"], "ws2");

  app.dispose();
});

test("workspace archive: workspaceArchiveStore.getSnapshot returns stable object reference", async () => {
  const app = await mountClient();
  const store = app.exports.workspaceArchiveStore;
  const s1 = store.getSnapshot();
  const s2 = store.getSnapshot();
  assert.equal(s1, s2, "getSnapshot must return referentially identical object when store has not changed");

  // Calling getVersion returns a number
  assert.equal(typeof store.getVersion(), "number");

  // After notification, a new snapshot reference is issued
  store.markBusy("ws-dummy", true);
  const s3 = store.getSnapshot();
  assert.notEqual(s1, s3, "getSnapshot must return a new reference after notify");
  const s4 = store.getSnapshot();
  assert.equal(s3, s4, "repeated getSnapshot calls after mutation must be referentially stable");

  store.markBusy("ws-dummy", false);
  app.dispose();
});

test("workspace archive: footer action click renders panel when useSessions/useWorkspaces missing from props", async () => {
  const app = await mountClient({
    sessions: [{ id: "s1", displayTitle: "Alpha Session" }],
    workspaces: [{ id: "ws1", name: "Alpha Ws", path: "D:/ws1", sessionIds: ["s1"] }]
  });
  await app.flush();

  // Find footer button and click it to open
  const footerButton = nodes(app.footerTree, n => n.type === "button" && n.props?.["aria-label"] === "会话与工作区")[0];
  assert.ok(footerButton, "footer action button must exist");

  // SafePanel should mount cleanly without crash
  const safePanels = nodes(app.footerTree, n => typeof n.type === "function" && n.type.name === "SafePanel");
  assert.equal(safePanels.length, 1);

  // Directly instantiate and render SafePanel without useSessions/useWorkspaces to test fallback
  const SafePanelClass = safePanels[0].type;
  const instance = new SafePanelClass({
    t: app.t,
    panelStore: { set() {} },
    props: {
      onOpen() {},
      onArchive() {},
      onUnarchive() {},
      onRemove() {},
      onMove() {}
    }
  });

  const rendered = instance.render();
  assert.ok(rendered, "SafePanel must render without failing");
  assert.equal(rendered.type?.name, "SessionManagerPanel", "must render SessionManagerPanel");

  app.dispose();
});

test("workspace management: sort dropdown and filters share the same row, all 4 sort modes work", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 3000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 1000 },
      { id: "s3", displayTitle: "Session 3", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Charlie", path: "D:/charlie", sessionIds: ["s1"] },
      { id: "ws2", name: "Alpha", path: "D:/alpha", sessionIds: ["s2"] },
      { id: "ws3", name: "Beta", path: "D:/beta", sessionIds: ["s3"] }
    ]
  });
  await app.flush();

  // Switch to workspace management
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  // Verify toolbar layout: sort select is placed after '已归档' button
  const markFilters = nodes(app.tree[0], n => n.props?.className?.includes("sm-wsFilters"))[0];
  assert.ok(markFilters, "sm-wsFilters toolbar must exist");
  const leftGroup = nodes(markFilters, n => n.props?.className === "sm-markFiltersGroup")[0];
  assert.ok(leftGroup, "left group must exist");
  const leftChildren = leftGroup.props.children.filter(Boolean);
  assert.equal(text(leftChildren[0]), "全部");
  assert.equal(text(leftChildren[1]), "未归档");
  assert.equal(text(leftChildren[2]), "已归档");
  assert.ok(nodes(leftChildren[3], n => n.type === "select")[0], "sort dropdown must be placed after 已归档");

  const sortSelect = nodes(app.tree[0], n => n.type === "select" && n.props?.["aria-label"] === "排序")[0];
  assert.ok(sortSelect, "sort dropdown must exist in workspaces tab");
  const options = nodes(sortSelect, n => n.type === "option").map(o => o.props.value);
  assert.deepEqual(options, ["updated-desc", "updated-asc", "name-asc", "name-desc"]);

  const getWsOrder = () => nodes(app.tree[0], n => n.props?.["data-workspace-id"]).map(n => n.props["data-workspace-id"]);

  // 1. Default updated-desc: ws1 (3000) -> ws3 (2000) -> ws2 (1000)
  assert.deepEqual(getWsOrder(), ["ws1", "ws3", "ws2"], "updated-desc sorts newest first");

  // 2. updated-asc: ws2 (1000) -> ws3 (2000) -> ws1 (3000)
  sortSelect.props.onChange({ target: { value: "updated-asc" } });
  await app.flush();
  assert.deepEqual(getWsOrder(), ["ws2", "ws3", "ws1"], "updated-asc sorts oldest first");

  // 3. name-asc: Alpha (ws2) -> Beta (ws3) -> Charlie (ws1)
  sortSelect.props.onChange({ target: { value: "name-asc" } });
  await app.flush();
  assert.deepEqual(getWsOrder(), ["ws2", "ws3", "ws1"], "name-asc sorts alphabetically A-Z");

  // 4. name-desc: Charlie (ws1) -> Beta (ws3) -> Alpha (ws2)
  sortSelect.props.onChange({ target: { value: "name-desc" } });
  await app.flush();
  assert.deepEqual(getWsOrder(), ["ws1", "ws3", "ws2"], "name-desc sorts alphabetically Z-A");

  app.dispose();
});

test("workspace management: bulk processing mode, selection, and direct bulk archive/unarchive", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/alpha", sessionIds: ["s1"] },
      { id: "ws2", name: "Beta", path: "D:/beta", sessionIds: ["s2"] }
    ]
  });
  await app.flush();

  // Switch to workspace management
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  // Find toolbar buttons on the same row
  const filterBtns = nodes(app.tree[0], n => n.type === "button" && n.props?.className && n.props.className.includes("sm-filterBtn"));
  const bulkModeBtn = filterBtns.find(b => text(b) === "批量处理");
  const selectAllBtnInitial = filterBtns.find(b => text(b) === "全选筛选");
  const clearBtnInitial = filterBtns.find(b => text(b) === "清空选择");
  const bulkArchiveBtn = filterBtns.find(b => text(b) === "归档");
  const bulkUnarchiveBtn = filterBtns.find(b => text(b) === "取消归档");

  assert.ok(bulkModeBtn, "批量处理 button must be present");
  assert.ok(selectAllBtnInitial, "全选筛选 button must be present even before clicking 批量处理");
  assert.ok(clearBtnInitial, "清空选择 button must be present even before clicking 批量处理");
  assert.ok(bulkArchiveBtn, "归档 bulk button must be present");
  assert.ok(bulkUnarchiveBtn, "取消归档 bulk button must be present");

  // In non-bulk mode, archive and unarchive buttons must be disabled
  assert.equal(bulkArchiveBtn.props.disabled, true, "bulk archive button must be disabled when not in bulk mode");
  assert.equal(bulkUnarchiveBtn.props.disabled, true, "bulk unarchive button must be disabled when not in bulk mode");

  // No row checkboxes in non-bulk mode
  let rowCheckboxes = nodes(app.tree[0], n => n.type === "input" && n.props?.type === "checkbox");
  assert.equal(rowCheckboxes.length, 0, "no checkboxes when select mode is disabled");

  // Click 批量处理 to enter bulk mode
  bulkModeBtn.props.onClick();
  await app.flush();

  // Row checkboxes now appear
  rowCheckboxes = nodes(app.tree[0], n => n.type === "input" && n.props?.type === "checkbox");
  assert.equal(rowCheckboxes.length, 2, "checkboxes appear for both workspace rows");

  // Select all via onWsBulkSelectAll button
  const allBtns = nodes(app.tree[0], n => n.type === "button" && n.props?.className && n.props.className.includes("sm-filterBtn"));
  const selectAllBtn = allBtns.find(b => text(b) === "全选筛选");
  assert.ok(selectAllBtn, "全选筛选 button must appear in bulk mode");
  selectAllBtn.props.onClick();
  await app.flush();

  // Now bulk archive button is enabled
  const updatedBulkArchiveBtn = nodes(app.tree[0], n => n.type === "button" && text(n) === "归档")[0];
  assert.equal(updatedBulkArchiveBtn.props.disabled, false, "bulk archive button must be enabled when workspaces are selected");

  assert.equal(app.control(app.t("workspace.bulk.unarchive")).props.disabled, true, "none of the selected workspaces can be restored");

  // Click bulk archive -> executes directly WITHOUT secondary confirmation
  await updatedBulkArchiveBtn.props.onClick();
  await app.flush();

  const confirmModal = nodes(app.tree, n => n.type?.name === "ConfirmDialog")[0];
  assert.equal(confirmModal, undefined, "bulk archive must NOT open secondary confirmation dialog");

  // Verify both workspaces are archived in store
  assert.equal(app.exports.workspaceArchiveStore.isArchived("ws1"), true);
  assert.equal(app.exports.workspaceArchiveStore.isArchived("ws2"), true);

  // Switch to archived filter to see them, or select them to test bulk unarchive
  selectAllBtn.props.onClick();
  await app.flush();

  const updatedBulkUnarchiveBtn = nodes(app.tree[0], n => n.type === "button" && text(n) === "取消归档")[0];
  assert.equal(updatedBulkUnarchiveBtn.props.disabled, false, "bulk unarchive button must be enabled");

  // Click bulk unarchive -> executes directly WITHOUT secondary confirmation
  await updatedBulkUnarchiveBtn.props.onClick();
  await app.flush();

  assert.equal(app.exports.workspaceArchiveStore.isArchived("ws1"), false);
  assert.equal(app.exports.workspaceArchiveStore.isArchived("ws2"), false);

  app.dispose();
});

test("sessions management: name-asc and name-desc sorting works", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Zeta Session", updatedAt: 1000 },
      { id: "s2", displayTitle: "Alpha Session", updatedAt: 2000 },
      { id: "s3", displayTitle: "Beta Session", updatedAt: 3000 }
    ],
    workspaces: []
  });
  await app.flush();

  // In sessions tab, check sort dropdown
  const sortSelect = nodes(app.tree[0], n => n.type === "select" && n.props?.["aria-label"] === "排序")[0];
  assert.ok(sortSelect);

  const getSessionOrder = () => nodes(app.tree[0], n => n.props?.["data-session-id"]).map(n => n.props["data-session-id"]);

  // Sort by name-asc
  sortSelect.props.onChange({ target: { value: "name-asc" } });
  await app.flush();
  assert.deepEqual(getSessionOrder(), ["s2", "s3", "s1"], "Alpha -> Beta -> Zeta");

  // Sort by name-desc
  sortSelect.props.onChange({ target: { value: "name-desc" } });
  await app.flush();
  assert.deepEqual(getSessionOrder(), ["s1", "s3", "s2"], "Zeta -> Beta -> Alpha");

  app.dispose();
});

test("workspace management: disabled bulk archive/unarchive in non-bulk mode and CSS disabled rules exist", async () => {
  const SRC = (await import("node:fs")).readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(SRC, /\.sm-filterBtn:disabled\{opacity:\.4;cursor:not-allowed\}/);
  assert.match(SRC, /\.sm-panelDialog \.sm-filterBtn:disabled\{opacity:\.4;cursor:not-allowed\}/);
  assert.match(SRC, /\.sm-filterBtn:hover:not\(:disabled\)/);

  const app = await mountClient({
    sessions: [{ id: "s1", displayTitle: "Session 1" }],
    workspaces: [{ id: "ws1", name: "Alpha", path: "D:/alpha", sessionIds: ["s1"] }]
  });
  await app.flush();

  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  const filterBtns = nodes(app.tree[0], n => n.type === "button" && n.props?.className?.includes("sm-filterBtn"));
  const bulkArchiveBtn = filterBtns.find(b => text(b) === "归档");
  const bulkUnarchiveBtn = filterBtns.find(b => text(b) === "取消归档");
  assert.equal(bulkArchiveBtn.props.disabled, true);
  assert.equal(bulkUnarchiveBtn.props.disabled, true);

  app.dispose();
});

test("workspace management: background sync does not show loading notice or jitter list", async () => {
  const SRC = (await import("node:fs")).readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(SRC, /if \(workspaces\.length === 0\) setWorkspacesLoading\(true\);/);
  assert.match(SRC, /\(workspacesLoading && workspaces\.length === 0\) \? h\("div", \{ className: "sm-workspaceNotice"/);
  assert.match(SRC, /scrollbar-gutter:stable/);
});

test("workspace archive: session row displays '工作区已归档' badge left of '已归档' and alerts on unarchive attempt", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha Project", path: "D:/projects/alpha", updatedAt: 1500, sessionIds: ["s1"] }
    ],
    archivedIds: ["s1"]
  });
  await app.flush();

  // Mark ws1 as archived in workspaceArchiveStore
  app.exports.workspaceArchiveStore.saveArchiveRecord("ws1", {
    workspaceId: "ws1",
    archived: true,
    archivedAt: Date.now(),
    sessionIds: ["s1"],
    pending: []
  });
  await app.flush();

  // Find badges in session row
  const row = nodes(app.tree[0], n => n.props?.["data-session-id"] === "s1")[0];
  assert.ok(row, "session row s1 must exist");

  const titleNode = nodes(row, n => n.props?.className === "sm-rowTitle")[0];
  assert.ok(titleNode, "title node must exist");

  const badgeWs = nodes(titleNode, n => n.props?.className?.includes("sm-badgeWorkspaceArchived"))[0];
  const badgeArchived = nodes(titleNode, n => n.props?.className?.includes("sm-badgeArchived"))[0];

  assert.ok(badgeWs, "must display '工作区已归档' badge");
  assert.equal(text(badgeWs), "工作区已归档");
  assert.ok(badgeArchived, "must display '已归档' badge");
  assert.equal(text(badgeArchived), "已归档");

  // Verify badgeWs is positioned before badgeArchived
  const badges = nodes(titleNode, n => n.props?.className?.includes("sm-badge"));
  const idxWs = badges.indexOf(badgeWs);
  const idxArchived = badges.indexOf(badgeArchived);
  assert.ok(idxWs !== -1 && idxArchived !== -1 && idxWs < idxArchived, "工作区已归档 badge must be to the left of 已归档 badge");

  // Intercept window.alert
  const alerts = [];
  app.window.alert = (msg) => alerts.push(msg);

  try {
    // Attempt to click "取消归档"
    const rowActions = nodes(row, n => n.props?.className === "sm-rowActions")[0];
    const unarchiveBtn = nodes(rowActions, n => n.type === "button" && text(n) === "移出归档")[0];
    assert.ok(unarchiveBtn, "unarchive button must exist on archived session");

    unarchiveBtn.props.onClick();
    await app.flush();

    assert.equal(alerts.length, 1, "must show alert when trying to unarchive session in archived workspace");
    assert.match(alerts[0], /所属工作区已归档/);

    // Session remains archived
    assert.equal(app.exports.workspaceArchiveStore.isArchived("ws1"), true);
  } finally {
    app.dispose();
  }
});

test("ui styling: select dropdowns use modern appearance:none, rounded border, and SVG chevron", async () => {
  const SRC = (await import("node:fs")).readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(SRC, /appearance:none;-webkit-appearance:none;/);
  assert.match(SRC, /stroke='%23888888'/);
  assert.match(SRC, /\.sm-viewSelect:hover:not\(:disabled\)/);
  assert.match(SRC, /\.sm-wsFilters \.sm-wsSortSelect\{[^}]*border-radius:8px/);
});

test("workspace re-add: re-adding an archived workspace reveals it without unknown workspace error, keeping historical sessions archived", async () => {
  const app = await mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1", updatedAt: 1000 },
      { id: "s2", displayTitle: "Session 2", updatedAt: 2000 }
    ],
    workspaces: [
      { id: "ws1", name: "Alpha", path: "D:/projects/alpha", updatedAt: 1500, sessionIds: ["s1", "s2"] }
    ],
    archivedIds: ["s1", "s2"]
  });
  await app.flush();

  const store = app.exports.workspaceArchiveStore;

  // 1. Initially archive ws1
  store.saveArchiveRecord("ws1", {
    workspaceId: "ws1",
    archived: true,
    archivedAt: Date.now(),
    sessionIds: ["s1", "s2"],
    pending: []
  });
  await app.flush();

  assert.equal(store.isArchived("ws1"), true);
  const snapshotBefore = app.ctx.workspaces.list.getSnapshot();
  assert.equal(snapshotBefore.items.some(w => (w.workspaceId || w.id) === "ws1"), false, "archived workspace must be hidden from snapshot");

  // 2. Wrap workspaces.create and uiWorkspace.connectWorkspace
  let connectedWorkspaceId = null;
  app.ctx.workspaces.create = async (options) => {
    // DSH backend recognizes existing path and returns existing workspace ID
    return "ws1";
  };
  app.ctx.uiWorkspace = {
    connectWorkspace: async (workspaceId) => {
      // DSH checks snapshot.items.find(w => w.id === workspaceId)
      const snap = app.ctx.workspaces.list.getSnapshot();
      const found = snap.items.find(w => (w.workspaceId || w.id) === workspaceId);
      if (!found) {
        throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`);
      }
      connectedWorkspaceId = workspaceId;
      return found;
    }
  };

  const disposeCreate = store.installWorkspaceCreate(app.ctx.workspaces);
  const disposeConnect = store.installConnectWorkspace(app.ctx.uiWorkspace);

  try {
    // 3. User re-adds the archived workspace
    const returnedId = await app.ctx.workspaces.create({ path: "D:/projects/alpha" });
    assert.equal(returnedId, "ws1");

    // Workspace is revealed automatically
    assert.equal(store.isArchived("ws1"), false, "workspace must no longer be marked archived");
    const snapshotAfter = app.ctx.workspaces.list.getSnapshot();
    assert.equal(snapshotAfter.items.some(w => (w.workspaceId || w.id) === "ws1"), true, "revealed workspace must appear in snapshot");

    // Historical sessions are NOT automatically unarchived
    const archivedSessionIds = snapshotAfter.archivedSessionIds || [];
    assert.equal(archivedSessionIds.includes("s1"), true, "historical session s1 must remain archived");
    assert.equal(archivedSessionIds.includes("s2"), true, "historical session s2 must remain archived");

    // DSH connectWorkspace succeeds without unknown workspace error
    await assert.doesNotReject(async () => {
      await app.ctx.uiWorkspace.connectWorkspace(returnedId);
    });
    assert.equal(connectedWorkspaceId, "ws1");

    // Retained session IDs are preserved on store record
    const rec = store.getRecord("ws1");
    assert.deepEqual([...rec.sessionIds], ["s1", "s2"]);

    // Notice alert was displayed to inform user that workspace was restored but old sessions remain archived
    assert.ok(app.alerts.includes(app.t("notice.workspaceReAdded")), "must alert notice.workspaceReAdded on re-adding archived workspace");
  } finally {
    if (disposeCreate) disposeCreate();
    if (disposeConnect) disposeConnect();
    app.dispose();
  }
});

test("ui dropdowns: unified art styling and container interactivity", async () => {
  const SRC = (await import("node:fs")).readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // Unified select selector covers all selects across the plugin
  assert.match(SRC, /\.sm-viewSelect,\.sm-settingsSelect,\.sm-wsSortSelect,\.sm-prioritySelectInline,\.sm-panelDialog select,\.sm-nativeDialog select,\.sm-settingsCard select\{/);
  assert.match(SRC, /border-radius:8px!important/);
  assert.match(SRC, /padding-right:26px!important/);

  // wsSort select is wrapped in a <div> rather than an implicit <label> so clicks don't get cancelled by label activation
  assert.match(SRC, /h\("div",\s*\{\s*className:\s*"sm-viewField sm-wsSortField"\s*\},/);
  assert.match(SRC, /className:\s*"sm-viewSelect sm-wsSortSelect"[^}]+onMouseDown:\s*e\s*=>\s*e\.stopPropagation\(\)/);

  // session filter selects are also wrapped in <div>
  assert.match(SRC, /className:\s*"sm-panelSelects"[\s\S]*?h\("div",\s*\{\s*className:\s*"sm-viewField"\s*\}/);

  // SmSwitch does not call preventDefault on onMouseDown
  const smSwitchDef = SRC.match(/function SmSwitch\([\s\S]*?\n    \}/)?.[0] || "";
  assert.ok(smSwitchDef && !smSwitchDef.includes("onMouseDown"), "SmSwitch must not define onMouseDown");

  // Panel modal preserves non-modal overlayLayer
  assert.match(SRC, /className:\s*"sm-overlayLayer"/);
});

test("ui dropdowns: custom select menu renders unified art style and handles selection", async () => {
  const SRC = (await import("node:fs")).readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // Expanded select state highlights border and flips chevron
  assert.match(SRC, /\.sm-selectExpanded\{[^}]*border-color:var\(--dsw-alias-state-business-primary/);
  assert.match(SRC, /\.sm-selectExpanded\{[^}]*d='m18 15-6-6-6 6'/);

  // Custom select menu popup styling: rounded corners (8px), soft border, theme surface, NO shadow
  assert.match(SRC, /\.sm-customSelectMenu\{[^}]*border-radius:8px/);
  assert.match(SRC, /\.sm-customSelectMenu\{[^}]*border:1px solid var\(--dsw-alias-border-l2,/);
  assert.match(SRC, /\.sm-customSelectMenu\{[^}]*background:var\(--dsw-alias-bg-layer-3,var\(--dsw-alias-bg-layer-2,/);
  assert.match(SRC, /\.sm-customSelectMenu\{[^}]*box-shadow:none!important/);
  assert.match(SRC, /\.sm-customSelectMenu-dropUp\{box-shadow:none!important\}/);

  // Theme adaptation: consumes DSH tokens directly for surface, text, and interactive states
  assert.match(SRC, /\.sm-customSelectMenu\{[^}]*color:var\(--dsw-alias-label-primary/);
  assert.match(SRC, /\.sm-customSelectOption\{[^}]*color:var\(--dsw-alias-label-primary/);
  assert.match(SRC, /\.sm-customSelectOptionSelected\{[^}]*background-color:var\(--dsw-alias-interactive-bg-active/);

  // Custom select option styling: 6px radius, hover and selected states, checkmark
  assert.match(SRC, /\.sm-customSelectOption\{[^}]*border-radius:6px/);
  assert.match(SRC, /\.sm-customSelectOption:hover:not\(\.sm-customSelectOptionDisabled\)\{[^}]*background-color:var\(--dsw-alias-interactive-bg-hover/);
  assert.match(SRC, /\.sm-customSelectOptionSelected\{[^}]*color:var\(--dsw-alias-state-business-primary,#356ae6\)/);
  assert.match(SRC, /\.sm-customSelectOptionCheck\{[^}]*color:var\(--dsw-alias-state-business-primary,#356ae6\)/);

  // Verify functional openCustomSelect and selection behavior in DOM environment
  const harness = await mountClient();
  const { openCustomSelect, closeCustomSelect } = harness.exports;

  const mockSelect = {
    tagName: "SELECT",
    disabled: false,
    value: "opt1",
    options: [
      { value: "opt1", text: "Option One", selected: true, disabled: false },
      { value: "opt2", text: "Option Two", selected: false, disabled: false }
    ],
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      remove(c) { this.classes.delete(c); },
      contains(c) { return this.classes.has(c); }
    },
    getAttribute(attr) { return attr === "aria-label" ? "Test Dropdown" : null; },
    getBoundingClientRect() { return { top: 100, bottom: 130, left: 50, right: 180, width: 130, height: 30 }; },
    dispatchEvent(evt) { dispatchedEvents.push(evt.type); },
    focus() { focused = true; }
  };

  let focused = false;
  const dispatchedEvents = [];
  const appendedElements = [];
  const fakeDoc = {
    body: {
      appendChild(el) { appendedElements.push(el); return el; }
    }
  };

  // Run with fake document on harness.window
  const origDoc = harness.window?.document;
  try {
    const fakeDocument = {
      ...fakeDoc,
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          className: "",
          attributes: {},
          style: {},
          children: [],
          setAttribute(k, v) { this.attributes[k] = v; },
          getAttribute(k) { return this.attributes[k]; },
          appendChild(c) { this.children.push(c); return c; },
          querySelector() { return null; },
          addEventListener(type, fn) { this["on" + type] = fn; },
          remove() {
            const idx = appendedElements.indexOf(this);
            if (idx !== -1) appendedElements.splice(idx, 1);
          }
        };
      }
    };
    if (harness.window) harness.window.document = fakeDocument;
    globalThis.document = fakeDocument;

    mockSelect.ownerDocument = fakeDocument;
    openCustomSelect(mockSelect);

    assert.equal(appendedElements.length, 1, "menu must be appended to body");
    const menu = appendedElements[0];
    assert.equal(menu.className, "sm-customSelectMenu");
    assert.equal(menu.attributes.role, "listbox");
    assert.equal(menu.style.width, "130px", "menu width must align with select bounding rect width");
    assert.equal(menu.style.minWidth, "130px", "menu minWidth must align with select bounding rect width");
    assert.equal(mockSelect.classList.contains("sm-selectExpanded"), true);

    // Click option 2
    const opt2Node = menu.children[1];
    opt2Node.onmousedown({ preventDefault() {}, stopPropagation() {} });

    assert.equal(mockSelect.value, "opt2");
    assert.ok(dispatchedEvents.includes("change"));
    assert.ok(dispatchedEvents.includes("input"));
    assert.equal(appendedElements.length, 0, "menu must be removed after selection");
    assert.equal(mockSelect.classList.contains("sm-selectExpanded"), false);

    // Calling closeCustomSelect when closed is a safe no-op
    closeCustomSelect();
  } finally {
    if (harness.window) harness.window.document = origDoc;
    delete globalThis.document;
    harness.dispose();
  }
});

test("workspace re-add: window.revealWorkspace fallback and wrapper unwrap prevent 'revealWorkspace is not defined'", async () => {
  const app = await mountClient({
    workspaces: [{ id: "ws1", name: "Alpha", path: "D:/projects/alpha", sessionIds: [] }]
  });
  const store = app.exports.workspaceArchiveStore;

  // 1. Initial archive
  store.saveArchiveRecord("ws1", {
    workspaceId: "ws1",
    archived: true,
    archivedAt: Date.now(),
    sessionIds: [],
    pending: []
  });
  assert.equal(store.isArchived("ws1"), true);

  // 2. Global fallback exists on window and exports
  assert.equal(typeof app.window.revealWorkspace, "function", "app.window.revealWorkspace must be defined");
  assert.equal(typeof store.revealWorkspace, "function", "store.revealWorkspace must be defined");

  // 3. Simulated legacy/stale wrapper on uiWorkspace.connectWorkspace that previously threw
  let nativeConnectCalled = false;
  const nativeConnect = async (wsId) => {
    nativeConnectCalled = true;
    return { id: wsId };
  };

  const fakeUiService = {
    connectWorkspace: nativeConnect
  };

  // First install
  const dispose1 = store.installConnectWorkspace(fakeUiService);

  // Second install without disposing (simulating hot reload or double wrap)
  const dispose2 = store.installConnectWorkspace(fakeUiService);

  // Executing connectWorkspace successfully reveals workspace and calls native method
  const res = await fakeUiService.connectWorkspace("ws1");
  assert.deepEqual(res, { id: "ws1" });
  assert.equal(nativeConnectCalled, true);
  assert.equal(store.isArchived("ws1"), false, "workspace must be revealed");

  // Disposing clean restores native method
  if (dispose2) dispose2();
  if (dispose1) dispose1();
  assert.equal(fakeUiService.connectWorkspace, nativeConnect);

  app.dispose();
});

test("workspace toolbar responsive: uses flex-wrap wrap without rigid nowrap, aligning select width with dropdown menu", async () => {
  const SRC = (await import("node:fs")).readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  assert.match(SRC, /\.sm-wsFilters\{display:flex;flex-wrap:wrap;align-items:center;/);
  assert.doesNotMatch(SRC, /\.sm-wsFilters\{display:flex!important;flex-wrap:nowrap/);
  assert.doesNotMatch(SRC, /\.sm-wsFilters \.sm-markFiltersGroup\{[^}]*flex-shrink:0/);
  assert.match(SRC, /\.sm-wsFilters \.sm-wsSortSelect\{[^}]*min-width:120px/);
  assert.match(SRC, /\.sm-wsSortSelect-en\{min-width:138px\}/);

  // Mount in English locale and verify sm-wsSortSelect-en class is attached
  const appEn = await mountClient({
    language: "en",
    workspaces: [{ id: "ws1", name: "Alpha", path: "D:/alpha", sessionIds: [] }]
  });
  await appEn.flush();

  // Switch to workspaces tab
  const navTabs = nodes(appEn.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await appEn.flush();

  const sortSelect = nodes(appEn.tree[0], n => n.type === "select" && n.props?.className?.includes("sm-wsSortSelect"))[0];
  assert.ok(sortSelect, "workspace sort select must exist");
  assert.ok(sortSelect.props.className.includes("sm-wsSortSelect-en"), "must have sm-wsSortSelect-en class in English mode");

  appEn.dispose();
});

test("ui dropdowns: single-layer guard eliminates native select double-layer popup and aligns widths", async () => {
  const SRC = (await import("node:fs")).readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

  // Pointer-events: none on inline selects prevents Chromium native OS menu from opening concurrently with custom menu
  assert.match(SRC, /\.sm-wsSortSelect,\.sm-prioritySelectInline,\.sm-panelSelects \.sm-viewSelect\{pointer-events:none!important\}/);

  // Bulk actions wrap into sm-wsFiltersBulk and stack gracefully when window narrows
  assert.match(SRC, /\.sm-wsFiltersBulk\{display:flex;flex-wrap:wrap;align-items:center;gap:6px\}/);
  assert.match(SRC, /@media\(max-width:720px\)\{\.sm-wsFilters \.sm-markFiltersSpacer\{display:none\}\.sm-wsFilters \.sm-wsFiltersBulk\{width:100%\}\}/);
  assert.match(SRC, /className:\s*"sm-markFiltersGroup sm-wsFiltersBulk"/);

  // Custom select locks maxWidth to selectWidth to prevent overflow misalignment
  assert.match(SRC, /menu\.style\.maxWidth = selectWidth \+ "px"/);

  // Purges any duplicate or orphaned menus on close and before opening
  assert.match(SRC, /document\.querySelectorAll\("\.sm-customSelectMenu"\)/);

  // Top-level duplicate install call is removed; lifecycle managed via ctx.effect with singleton guard
  assert.doesNotMatch(SRC, /\n\s*installCustomDropdownInterceptor\(\);\s*\n\s*const inject/);
  assert.match(SRC, /window\.__dshSmDropdownInterceptorOff/);
});

test("workspace panel: excludes subagents and blank sessions from count and latestUpdatedAt, hides duplicate path", async () => {
  const app = await mountClient({
    current: "s1",
    sessions: [
      { id: "s1", displayTitle: "Alpha Main", updatedAt: 1000 },
      { id: "s_sub", displayTitle: "Subagent Task", origin: "subagent", updatedAt: 99999 },
      { id: "s_blank", displayTitle: "Blank Session", blank: true, updatedAt: 88888 },
      { id: "s2", displayTitle: "Beta Main", updatedAt: 5000 }
    ],
    workspaces: [
      {
        id: "ws1",
        name: "Alpha Workspace",
        path: "D:/work/alpha",
        updatedAt: 500,
        sessionIds: ["s1", "s_sub", "s_blank"]
      },
      {
        id: "ws2",
        name: "Beta Workspace",
        path: "D:/work/beta",
        updatedAt: 800,
        sessionIds: ["s2"]
      }
    ]
  });
  await app.flush();

  // Switch to workspace management
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  // Both workspaces rendered
  const wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 2, "must render 2 workspace rows");

  // Sorted by latestUpdatedAt desc:
  // ws2 latest user session is s2 (5000)
  // ws1 latest user session is s1 (1000), ignoring s_sub (99999) and s_blank (88888)
  // So ws2 must be first, ws1 second!
  assert.equal(wsRows[0].props["data-workspace-id"], "ws2");
  assert.equal(wsRows[1].props["data-workspace-id"], "ws1");

  // Check ws1 rowMeta and rowTitle
  const ws1Meta = nodes(wsRows[1], n => n.props?.className === "sm-rowMeta")[0];
  const ws1MetaText = text(ws1Meta);
  // Session count should be 1 (only s1, excluding s_sub and s_blank)
  assert.ok(ws1MetaText.includes("1 个会话"), "ws1 session count must be 1, got: " + ws1MetaText);
  // Must NOT include duplicate path in meta
  assert.ok(!ws1MetaText.includes("alpha ·"), "must not include shortPath in meta: " + ws1MetaText);
  assert.ok(!ws1MetaText.includes("Alpha Workspace ·"), "must not repeat workspace name in meta: " + ws1MetaText);

  // Check rowTitle carries native title tooltip
  const ws1Title = nodes(wsRows[1], n => n.props?.className === "sm-rowTitle")[0];
  assert.equal(ws1Title.props.title, "D:/work/alpha", "row title must have path in title attribute");

  // Check ws2 rowMeta
  const ws2Meta = nodes(wsRows[0], n => n.props?.className === "sm-rowMeta")[0];
  const ws2MetaText = text(ws2Meta);
  assert.ok(ws2MetaText.includes("1 个会话"), "ws2 session count must be 1, got: " + ws2MetaText);
  assert.ok(!ws2MetaText.includes("beta ·"), "ws2 must not include shortPath in meta");

  app.dispose();
});

test("workspace management: empty workspace (0 sessions) shows '—' and sorts to bottom under updated-desc", async () => {
  const now = Date.now();
  const app = await mountClient({
    sessions: [
      { id: "s_active", displayTitle: "Active Session", updatedAt: now - 3600000 } // 1h ago
    ],
    workspaces: [
      {
        id: "ws_empty",
        name: "Empty Old Workspace",
        path: "D:/work/empty",
        updatedAt: now - 1000, // Workspace record touched 1s ago (e.g. sessions moved away)
        createdAt: now - 864000000,
        sessionIds: []
      },
      {
        id: "ws_active",
        name: "Active Workspace",
        path: "D:/work/active",
        updatedAt: now - 7200000,
        createdAt: now - 864000000,
        sessionIds: ["s_active"]
      }
    ]
  });
  await app.flush();

  // Switch to workspace management
  const navTabs = nodes(app.tree[0], n => n.type === "button" && n.props?.role === "tab");
  navTabs[1].props.onClick();
  await app.flush();

  const wsRows = nodes(app.tree[0], n => n.props?.["data-workspace-id"]);
  assert.equal(wsRows.length, 2, "must render 2 workspace rows");

  // Sorted by latestUpdatedAt desc:
  // ws_active has active session s_active (1h ago)
  // ws_empty has 0 sessions, so latestUpdatedAt is null, even though ws.updatedAt was 1s ago!
  // Therefore ws_active MUST come first, ws_empty MUST come second (at the bottom)!
  assert.equal(wsRows[0].props["data-workspace-id"], "ws_active", "active workspace with real session must sort above empty workspace");
  assert.equal(wsRows[1].props["data-workspace-id"], "ws_empty", "empty workspace must sort to bottom");

  // Verify ws_empty meta text shows '0 个会话 · —'
  const emptyMeta = nodes(wsRows[1], n => n.props?.className === "sm-rowMeta")[0];
  const emptyMetaText = text(emptyMeta);
  assert.equal(emptyMetaText, "0 个会话 · —", "empty workspace without sessions must display '0 个会话 · —'");

  // Verify ws_active meta text shows '1 个会话 · 最近更新：1h'
  const activeMeta = nodes(wsRows[0], n => n.props?.className === "sm-rowMeta")[0];
  const activeMetaText = text(activeMeta);
  assert.ok(activeMetaText.includes("1 个会话 · 最近更新：1h"), "active workspace must display relative time of latest session: " + activeMetaText);

  app.dispose();
});

test("host archive snapshot replaces equal-sized ID lists and removes missing records", async t => {
  const app = await mountClient();
  t.after(() => app.dispose());
  const store = app.exports.workspaceArchiveStore;
  const initial = { archived: true, archivedAt: 1, sessionIds: ["a"], pending: [] };
  store.syncFromHost({ ws: initial });
  store.syncFromHost({ ws: { ...initial, sessionIds: ["b"], pending: ["b"] } });
  assert.deepEqual([...store.getRecord("ws").pending], ["b"]);
  assert.deepEqual([...store.getRecord("ws").sessionIds], ["b"]);
  store.syncFromHost({});
  assert.equal(store.getRecord("ws"), null);
});

test("failed workspace archive rollback keeps the outstanding IDs available for recovery", async t => {
  const ws = { id: "ws", sessionIds: ["a", "b"] };
  const app = await mountClient({ workspaces: [ws] });
  t.after(() => app.dispose());
  app.ctx.uiWorkspace.archiveSession = async id => { if (id === "b") throw Error("disk error"); };
  app.ctx.uiWorkspace.unarchiveSession = async () => { throw Error("undo error"); };
  assert.equal(await app.exports.executeArchiveWorkspace("ws", { allWorkspaces: [ws], t: app.t }), false);
  const record = app.exports.workspaceArchiveStore.getRecord("ws");
  assert.equal(record?.archived, false);
  assert.deepEqual([...record.pending], ["a"]);
  assert.match(app.alerts.at(-1), /disk error/);
  assert.match(app.alerts.at(-1), /\ba\b/);
  const restored = [];
  app.ctx.uiWorkspace.unarchiveSession = async id => restored.push(id);
  assert.equal(await app.exports.executeUnarchiveWorkspace("ws", { t: app.t }), true);
  assert.deepEqual(restored, ["a"]);
  assert.equal(app.exports.workspaceArchiveStore.getRecord("ws"), null);
});

for (const operation of ["archive", "restore"]) {
  test("workspace " + operation + " retries the host write without replaying session commands", async t => {
    const ws = { id: "ws", name: "Alpha", sessionIds: ["a"] };
    const writes = [];
    const app = await mountClient({
      workspaces: [ws], archivedIds: operation === "restore" ? ["a"] : [],
      saveWorkspaceRecord(body) {
        writes.push(body);
        if (writes.length === 1) {
          if (operation === "restore") throw new Error("network offline");
          return { ok: false, error: "disk full" };
        }
        return { ok: true };
      }
    });
    t.after(() => app.dispose());
    await app.flush();
    const store = app.exports.workspaceArchiveStore;
    const commands = [];
    app.ctx.uiWorkspace.archiveSession = async id => commands.push(id);
    app.ctx.uiWorkspace.unarchiveSession = async id => commands.push(id);
    let result;
    if (operation === "restore") {
      store.saveArchiveRecord("ws", { workspaceId: "ws", archived: true, archivedAt: 1, sessionIds: ["a"], pending: [] });
      result = await app.exports.executeUnarchiveWorkspace("ws", { t: app.t });
    } else {
      result = await app.exports.executeArchiveWorkspace("ws", { allWorkspaces: [ws], t: app.t });
    }
    assert.equal(result, false);
    assert.equal(store.getRecord("ws").needsSave, true);
    assert.match(app.alerts.at(-1), /disk full|network offline/);
    store.syncFromHost({});
    const key = "dsh-session-manager-workspace-archive-v1";
    assert.equal(JSON.parse(app.localStorage.getItem(key)).archives.ws.needsSave, true);
    const reloaded = await mountClient({
      workspaces: [ws], initialStorage: { [key]: app.localStorage.getItem(key) },
      fetchWorkspaces: () => ({ ok: true, result: { workspaces: [ws], workspaceArchives: {} } }),
      saveWorkspaceRecord(body) { writes.push(body); return { ok: true }; }
    });
    t.after(() => reloaded.dispose());
    reloaded.ctx.uiWorkspace.archiveSession = async id => commands.push(id);
    reloaded.ctx.uiWorkspace.unarchiveSession = async id => commands.push(id);
    await reloaded.flush();
    const tabs = nodes(reloaded.tree[0], n => n.type === "button" && n.props?.role === "tab");
    tabs[1].props.onClick();
    await reloaded.flush();
    await reloaded.click("重试保存");
    assert.deepEqual(commands, ["a"]);
    assert.deepEqual(writes[1], writes[0]);
    assert.ok(!reloaded.exports.workspaceArchiveStore.getRecord("ws")?.needsSave);
    assert.equal(reloaded.exports.workspaceArchiveStore.isArchived("ws"), operation === "archive");
  });
}

test("an unrelated host refresh preserves another window's pending save in local storage", async t => {
  const app = await mountClient();
  t.after(() => app.dispose());
  const key = "dsh-session-manager-workspace-archive-v1";
  const dirty = { workspaceId: "other", archived: false, sessionIds: [], pending: [], needsSave: true };
  app.localStorage.setItem(key, JSON.stringify({ version: 1, archives: { other: dirty } }));
  app.exports.workspaceArchiveStore.syncFromHost({
    saved: { workspaceId: "saved", archived: true, archivedAt: 1, sessionIds: ["a"], pending: [] }
  });
  assert.deepEqual(JSON.parse(app.localStorage.getItem(key)).archives.other, dirty);
});

test("workspace archive refuses unknown prior membership before changing session flags", async t => {
  const ws = { id: "ws", sessionIds: ["previously-archived"] };
  const app = await mountClient({ workspaces: [ws] });
  t.after(() => app.dispose());
  app.exports.workspaceArchiveStore.setReadRaw(() => ({ items: [ws] }));
  const writes = [];
  app.ctx.uiWorkspace.archiveSession = async id => writes.push(id);
  assert.equal(await app.exports.executeArchiveWorkspace("ws", { allWorkspaces: [ws] }), false);
  assert.deepEqual(writes, []);
  assert.equal(app.exports.workspaceArchiveStore.getRecord("ws"), null);
});
