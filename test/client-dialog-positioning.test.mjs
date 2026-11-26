import assert from "node:assert/strict";
import test from "node:test";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const SESSIONS = [
  { id: "s1", displayTitle: "Alpha Session", workspaceId: "ws1", agentPreset: "PresetA", updatedAt: 3 },
  { id: "s2", displayTitle: "Beta Session", workspaceId: "ws2", agentPreset: "PresetB", updatedAt: 2 },
];
const WORKSPACES = [
  { id: "ws1", name: "Workspace 1", path: "/path/ws1" },
  { id: "ws2", name: "Workspace 2", path: "/path/ws2" },
];

const targetTrigger = host => nodes(host.tree, n => n.props?.className === "sm-targetDropdownTrigger")[0];
const targetPopup = host => nodes(host.tree, n => n.props?.className === "sm-targetDropdownOptions")[0];
const targetConfirm = host => nodes(host.tree, n => n.props?.className?.includes("sm-nativeDialogConfirm"))[0];

function openTargetPopup(host) {
  targetTrigger(host).props.onClick();
  host.render();
  return targetPopup(host);
}

function choosePreset(host, name) {
  const popup = openTargetPopup(host);
  nodes(popup, n => n.props?.role === "option" && text(n) === name)[0].props.onClick();
  host.render();
}

function createMockPanel(rect) {
  return {
    nodeType: 1,
    getBoundingClientRect: () => ({
      width: rect.width ?? (rect.right - rect.left),
      height: rect.height ?? (rect.bottom - rect.top),
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    }),
    contains: () => false,
  };
}

test("secondary dialog positioning: horizontally and vertically centered relative to session management panel", async () => {
  let panelRect = { top: 200, bottom: 700, left: 500, right: 1100, width: 600, height: 500 };
  const customQuerySelector = (sel) => {
    if (sel === ".sm-panelDialog:not(.sm-annotationSurface)") {
      return createMockPanel(panelRect);
    }
  };

  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    innerWidth: 1600,
    innerHeight: 900,
    querySelector: customQuerySelector
  });
  await app.flush();

  // Open delete confirm dialog
  const row = nodes(app.tree, node => node.props?.["data-session-id"] === "s1")[0];
  const deleteBtn = nodes(row, node => node.type === "button" && text(node) === "删除会话")[0];
  assert.ok(deleteBtn, "delete button must exist");
  deleteBtn.props.onClick();
  await app.flush();

  const confirmDialogEl = nodes(app.tree, node => node.type?.name === "ConfirmDialog" && node.props?.open)[0];
  assert.ok(confirmDialogEl, "ConfirmDialog element must be open");

  const dialogHost = app.mountComponent(confirmDialogEl.type, confirmDialogEl.props);
  const confirmLayer = dialogHost.tree;

  assert.ok(confirmLayer, "confirm dialog layer must be rendered");
  assert.ok(confirmLayer.props.className.includes("sm-confirmDialog-anchored"), "must carry sm-confirmDialog-anchored");

  // Center calculation:
  // Panel center: left = 500 + 600/2 = 800px, top = 200 + 500/2 = 450px
  // CSS transform: translate(-50%, -50%) geometrically centers dialog over panel
  assert.equal(confirmLayer.props.style?.left, "800px", "dialog should be horizontally centered over panel");
  assert.equal(confirmLayer.props.style?.top, "450px", "dialog should be vertically centered over panel");
  assert.equal(confirmLayer.props.style?.transform, "translate(-50%, -50%)", "must apply centering transform");
  assert.equal(confirmLayer.props.style?.position, "fixed");
  assert.equal(confirmLayer.props.style?.inset, "450px auto auto 800px");

  // Verify geometric centers coincide
  const panelCenterX = panelRect.left + panelRect.width / 2;
  const panelCenterY = panelRect.top + panelRect.height / 2;
  const dialogCenterX = parseInt(confirmLayer.props.style?.left, 10);
  const dialogCenterY = parseInt(confirmLayer.props.style?.top, 10);
  assert.equal(dialogCenterX, panelCenterX, "horizontal center of dialog must match panel");
  assert.equal(dialogCenterY, panelCenterY, "vertical center of dialog must match panel");

  // Portal into overlay root verification
  const portal = app.portals.find(p => p.node === confirmLayer);
  assert.ok(portal, "dialog must be portaled");
  assert.equal(portal.container?.id, "dsh-session-manager-overlay-root", "must portal to overlay root");

  app.dispose();
});

test("secondary dialog positioning: tracks movement when session management panel moves", async () => {
  let panelRect = { top: 200, bottom: 700, left: 500, right: 1100, width: 600, height: 500 };
  const customQuerySelector = (sel) => {
    if (sel === ".sm-panelDialog:not(.sm-annotationSurface)") {
      return createMockPanel(panelRect);
    }
  };

  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    innerWidth: 1600,
    innerHeight: 900,
    querySelector: customQuerySelector
  });
  await app.flush();

  const row = nodes(app.tree, node => node.props?.["data-session-id"] === "s1")[0];
  const deleteBtn = nodes(row, node => node.type === "button" && text(node) === "删除会话")[0];
  deleteBtn.props.onClick();
  await app.flush();

  const confirmDialogEl = nodes(app.tree, node => node.type?.name === "ConfirmDialog" && node.props?.open)[0];
  const dialogHost = app.mountComponent(confirmDialogEl.type, confirmDialogEl.props);
  assert.equal(dialogHost.tree.props.style?.left, "800px");
  assert.equal(dialogHost.tree.props.style?.top, "450px");
  assert.equal(dialogHost.tree.props.style?.transform, "translate(-50%, -50%)");

  // Move panel: simulate panel repositioning / dragging / window resize
  panelRect = { top: 150, bottom: 650, left: 400, right: 1000, width: 600, height: 500 };
  app.dispatchWindowEvent("resize");
  dialogHost.render();

  // Horizontal: 400 + 300 = 700px; Vertical: 150 + 250 = 400px
  assert.equal(dialogHost.tree.props.style?.left, "700px", "dialog should follow horizontal movement of panel");
  assert.equal(dialogHost.tree.props.style?.top, "400px", "dialog should follow vertical movement of panel");

  // Move panel again
  panelRect = { top: 80, bottom: 640, left: 212, right: 812, width: 600, height: 560 };
  app.dispatchWindowEvent("resize");
  dialogHost.render();

  // Horizontal: 212 + 300 = 512px; Vertical: 80 + 280 = 360px
  assert.equal(dialogHost.tree.props.style?.left, "512px", "dialog should continue to follow panel movement");
  assert.equal(dialogHost.tree.props.style?.top, "360px", "dialog should continue to follow panel movement");

  app.dispose();
});

test("secondary dialog positioning: clamps within viewport to preserve minimum 16px margin", async () => {
  // Narrow viewport with panel close to top-left edge
  let panelRect = { top: 5, bottom: 505, left: 5, right: 505, width: 500, height: 500 };
  const customQuerySelector = (sel) => {
    if (sel === ".sm-panelDialog:not(.sm-annotationSurface)") {
      return createMockPanel(panelRect);
    }
  };

  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    innerWidth: 600,
    innerHeight: 600,
    querySelector: customQuerySelector
  });
  await app.flush();

  const row = nodes(app.tree, node => node.props?.["data-session-id"] === "s1")[0];
  const deleteBtn = nodes(row, node => node.type === "button" && text(node) === "删除会话")[0];
  deleteBtn.props.onClick();
  await app.flush();

  const confirmDialogEl = nodes(app.tree, node => node.type?.name === "ConfirmDialog" && node.props?.open)[0];
  const dialogHost = app.mountComponent(confirmDialogEl.type, confirmDialogEl.props);

  const left = parseInt(dialogHost.tree.props.style?.left, 10);
  const top = parseInt(dialogHost.tree.props.style?.top, 10);

  // Must not violate minimum margin:
  // With translate(-50%, -50%), the dialog's visual bounds are [left - 180, top - 90] to [left + 180, top + 90]
  assert.ok(left - 180 >= 16, `left edge (${left - 180}) must be >= 16px margin`);
  assert.ok(top - 90 >= 16, `top edge (${top - 90}) must be >= 16px margin`);
  assert.ok(left + 180 <= 600 - 16, "right edge must keep >= 16px margin");
  assert.ok(top + 90 <= 600 - 16, "bottom edge must keep >= 16px margin");

  app.dispose();
});

test("secondary dialog positioning: MoveDialog, MigratePresetDialog, and AnnotationDialog center over panel", async () => {
  let panelRect = { top: 200, bottom: 700, left: 500, right: 1100, width: 600, height: 500 };
  const customQuerySelector = (sel) => {
    if (sel === ".sm-panelDialog:not(.sm-annotationSurface)") {
      return createMockPanel(panelRect);
    }
  };

  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    innerWidth: 1600,
    innerHeight: 900,
    querySelector: customQuerySelector
  });
  await app.flush();

  const row = nodes(app.tree, node => node.props?.["data-session-id"] === "s1")[0];

  // 1. MoveDialog (360x320)
  const moveBtn = nodes(row, node => node.type === "button" && text(node) === "移动至工作区")[0];
  assert.ok(moveBtn, "move button must exist");
  moveBtn.props.onClick();
  await app.flush();

  const moveDialogEl = nodes(app.tree, node => node.type?.name === "MoveDialog" && node.props?.open)[0];
  assert.ok(moveDialogEl, "MoveDialog element must be open");

  const moveHost = app.mountComponent(moveDialogEl.type, moveDialogEl.props);
  assert.equal(moveHost.tree.props.style?.left, "800px", "MoveDialog should be horizontally centered");
  assert.equal(moveHost.tree.props.style?.top, "450px", "MoveDialog should be vertically centered");
  assert.equal(moveHost.tree.props.style?.transform, "translate(-50%, -50%)");

  assert.equal(targetTrigger(moveHost).props["aria-label"], "选择工作区");
  assert.match(text(targetTrigger(moveHost)), /^选择工作区/);
  assert.equal(targetConfirm(moveHost).props.disabled, true);
  assert.equal(nodes(moveHost.tree, n => n.props?.className === "sm-migrateWarn").length, 0);
  assert.equal(targetTrigger(moveHost).props["aria-expanded"], false);
  assert.equal(targetPopup(moveHost), undefined);
  const tree = openTargetPopup(moveHost);
  assert.equal(tree.props.role, "tree");
  const options = nodes(tree, n => n.props?.role === "treeitem");
  assert.equal(options.length, 2);
  assert.match(text(options[0]), /Workspace 1/);
  assert.equal(options[0].props["aria-selected"], false);
  assert.equal(tree.props["aria-activedescendant"], options[0].props.id);
  assert.match(text(options[1]), /Workspace 2/);
  options[0].props.onClick();
  moveHost.render();

  // Confirm button disabled when current workspace is selected
  const confirmBtn = nodes(moveHost.tree, n => n.type === "button" && n.props?.className?.includes("sm-nativeDialogConfirm"))[0];
  assert.ok(confirmBtn, "Confirm button must exist");
  assert.equal(confirmBtn.props.disabled, true, "Confirm button must be disabled when same workspace is selected");

  // Warning must be shown
  const warn = nodes(moveHost.tree, n => n.props?.className === "sm-migrateWarn")[0];
  assert.ok(warn, "Warning must be shown when same workspace is selected");

  // Changing selection enables confirm button
  const reopened = openTargetPopup(moveHost);
  nodes(reopened, n => n.props?.role === "treeitem")[1].props.onClick();
  moveHost.render();
  assert.equal(targetPopup(moveHost), undefined);
  assert.match(text(targetTrigger(moveHost)), /Workspace 2/);
  const updatedConfirmBtn = nodes(moveHost.tree, n => n.type === "button" && n.props?.className?.includes("sm-nativeDialogConfirm"))[0];
  assert.equal(updatedConfirmBtn.props.disabled, false, "Confirm button should be enabled when target differs");

  // Cancel move dialog
  moveDialogEl.props.onCancel();
  await app.flush();

  // 2. MigratePresetDialog (360x320)
  const freshRow = nodes(app.tree, node => node.props?.["data-session-id"] === "s1")[0];
  const migrateBtn = nodes(freshRow, node => node.type === "button" && text(node) === "迁移预设")[0];
  assert.ok(migrateBtn, "migrate button must exist");
  migrateBtn.props.onClick();
  await app.flush();

  const migrateDialogEl = nodes(app.tree, node => node.type?.name === "MigratePresetDialog" && node.props?.open)[0];
  assert.ok(migrateDialogEl, "MigratePresetDialog element must be open");

  const migrateHost = app.mountComponent(migrateDialogEl.type, migrateDialogEl.props);
  assert.equal(migrateHost.tree.props.style?.left, "800px", "MigratePresetDialog horizontally centered");
  assert.equal(migrateHost.tree.props.style?.top, "450px", "MigratePresetDialog vertically centered");
  assert.equal(migrateHost.tree.props.style?.transform, "translate(-50%, -50%)");
  assert.equal(migrateHost.tree.props.className.includes("sm-confirmDialog"), true, "must use sm-confirmDialog layer");
  const migrateSection = nodes(migrateHost.tree, n => n.type === "section")[0];
  assert.equal(migrateSection.props.className, "sm-nativeDialog", "must use standard sm-nativeDialog class");
  const migrateBody = nodes(migrateHost.tree, n => n.props?.className === "sm-nativeDialogBody")[0];
  assert.ok(migrateBody, "must use sm-nativeDialogBody for 16px lateral padding");

  await app.flush();
  migrateHost.render();
  assert.equal(targetTrigger(migrateHost).props["aria-haspopup"], "listbox");
  assert.equal(targetTrigger(migrateHost).props["aria-label"], "选择预设");
  assert.match(text(targetTrigger(migrateHost)), /^选择预设/);

  // No separate current preset row and no warning prompt
  const currentPresetEl = nodes(migrateHost.tree, n => n.props?.className === "sm-migrateCurrent")[0];
  assert.equal(currentPresetEl, undefined, "MigratePresetDialog must not have separate current preset row");

  const migrateWarn = nodes(migrateHost.tree, n => n.props?.className === "sm-migrateWarn")[0];
  assert.equal(migrateWarn, undefined, "MigratePresetDialog must not show same preset warning prompt");

  // Confirm stays disabled until the user picks a different preset.
  const migrateConfirmBtn = nodes(migrateHost.tree, n => n.type === "button" && n.props?.className?.includes("sm-nativeDialogConfirm"))[0];
  assert.ok(migrateConfirmBtn, "Confirm button must exist");
  assert.equal(migrateConfirmBtn.props.disabled, true);
  choosePreset(migrateHost, "PresetA");
  assert.equal(targetConfirm(migrateHost).props.disabled, true);

  // Changing selection enables confirm button
  choosePreset(migrateHost, "PresetB");
  const updatedMigrateConfirmBtn = nodes(migrateHost.tree, n => n.type === "button" && n.props?.className?.includes("sm-nativeDialogConfirm"))[0];
  assert.equal(updatedMigrateConfirmBtn.props.disabled, false, "Confirm button should be enabled when target differs");

  // Cancel migrate dialog
  migrateDialogEl.props.onCancel();
  await app.flush();

  // 3. AnnotationDialog (360x460) from row (unanchored)
  await app.clickLabel("编辑标签、备注和优先级: Alpha Session");
  await app.flush();

  const annDialogEl = nodes(app.tree, node => node.type?.name === "AnnotationDialog")[0];
  assert.ok(annDialogEl, "AnnotationDialog element must exist");

  const annHost = app.mountComponent(annDialogEl.type, annDialogEl.props);
  assert.equal(annHost.tree.props.style?.left, "800px", "AnnotationDialog horizontally centered");
  assert.equal(annHost.tree.props.style?.top, "450px", "AnnotationDialog vertically centered");
  assert.equal(annHost.tree.props.style?.transform, "translate(-50%, -50%)");

  app.dispose();
});

test("secondary dialog positioning: bulk dialogs center over panel and portal to overlay root", async () => {
  let panelRect = { top: 200, bottom: 700, left: 500, right: 1100, width: 600, height: 500 };
  const customQuerySelector = (sel) => {
    if (sel === ".sm-panelDialog:not(.sm-annotationSurface)") {
      return createMockPanel(panelRect);
    }
  };

  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    innerWidth: 1600,
    innerHeight: 900,
    querySelector: customQuerySelector
  });
  await app.flush();

  // Enter batch mode
  const selectModeBtn = nodes(app.tree, n => n.type === "button" && text(n) === "批量处理")[0];
  assert.ok(selectModeBtn, "Batch mode toggle button must exist");
  selectModeBtn.props.onClick();
  await app.flush();

  // Select all
  let bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  assert.ok(bar, "BulkActionBar must exist");
  bar.props.onSelectAll();
  await app.flush();

  // Trigger bulk delete action (BatchPreviewDialog, 360x320)
  bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onAction("delete", null, true);
  await app.flush();

  const bulkPreviewEl = nodes(app.tree, node => node.type?.name === "BatchPreviewDialog" && node.props?.open)[0];
  assert.ok(bulkPreviewEl, "BatchPreviewDialog element must be open");

  const bulkHost = app.mountComponent(bulkPreviewEl.type, bulkPreviewEl.props);
  const bulkLayer = bulkHost.tree;

  assert.ok(bulkLayer, "bulk dialog layer must be rendered");
  assert.ok(bulkLayer.props.className.includes("sm-bulkDialog-anchored"), "must carry sm-bulkDialog-anchored");
  assert.equal(bulkLayer.props.style?.left, "800px", "bulk dialog horizontally centered");
  assert.equal(bulkLayer.props.style?.top, "450px", "bulk dialog vertically centered");
  assert.equal(bulkLayer.props.style?.transform, "translate(-50%, -50%)");

  // Verify portal into overlay root
  const bulkPortal = app.portals.find(p => p.node === bulkLayer);
  assert.ok(bulkPortal, "bulk dialog must be portaled");
  assert.equal(bulkPortal.container?.id, "dsh-session-manager-overlay-root", "must portal to overlay root");

  app.dispose();
});

test("secondary dialog: title-bar MoveDialog prompts for a workspace and focuses the current workspace on open", async () => {
  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    current: "s1"
  });
  await app.flush();
  await app.mountHeader("s1");

  const headerMoveBtn = nodes(app.headerTree, n => n.type === "button" && text(n).includes("移动至工作区"))[0];
  assert.ok(headerMoveBtn, "Title bar move button must exist");
  headerMoveBtn.props.onClick();
  await app.flush();

  const titleMoveDialogEl = nodes(app.headerTree, n => n.type?.name === "MoveDialog" && n.props?.open)[0];
  assert.ok(titleMoveDialogEl, "MoveDialog from title bar must be open");

  const titleMoveHost = app.mountComponent(titleMoveDialogEl.type, titleMoveDialogEl.props);
  assert.equal(targetTrigger(titleMoveHost).props["aria-label"], "选择工作区");
  assert.equal(targetPopup(titleMoveHost), undefined);
  const tree = openTargetPopup(titleMoveHost);
  const active = nodes(tree, n => n.props?.id === tree.props["aria-activedescendant"])[0];
  assert.match(text(active), /Workspace 1/);
  assert.equal(active.props["aria-selected"], false);

  app.dispose();
});

test("PR #68: move dropdown reveals ancestors and separates keyboard selection from execution", async t => {
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES, current: "s1" });
  t.after(() => app.dispose());
  await app.mountHeader("s1");
  await app.clickHeader("移动至工作区");
  const dialog = nodes(app.headerTree, n => n.type?.name === "MoveDialog")[0];
  const confirmed = [];
  const host = app.mountComponent(dialog.type, {
    ...dialog.props,
    workspaces: [
      { id: "win", path: "C:\\Work\\" },
      { id: "ws1", title: "Nested", path: "c:/work/current" },
      { id: "win-next", title: "Nested", path: "C:\\Work\\next" },
      { id: "posix", path: "/Work" },
      { id: "child", path: "/Work/child" },
      { id: "case", path: "/work/different-case" },
      { id: "prefix", path: "/Workspace/child" },
      { id: "no-path" },
    ],
    onConfirm: id => confirmed.push(id),
  });
  t.after(() => host.dispose());
  const tree = () => targetPopup(host);
  const items = () => nodes(tree(), n => n.props?.role === "treeitem");
  const confirm = () => targetConfirm(host);
  const selected = () => items().find(n => n.props["aria-selected"]);
  const press = (key) => {
    let prevented = false;
    let stopped = false;
    tree().props.onKeyDown({ key, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
    assert.equal(prevented, true, key);
    assert.equal(stopped, true, key);
    host.render();
  };
  assert.equal(tree(), undefined);
  assert.equal(app.document.activeElement.vnode.props["aria-haspopup"], "tree");
  targetTrigger(host).props.onKeyDown({ key: "ArrowDown", preventDefault() {} });
  host.render();
  assert.equal(tree().props.tabIndex, -1);
  assert.equal(app.document.activeElement.vnode.props.role, "tree");
  assert.equal(selected(), undefined);
  const current = items().find(n => n.props.id === tree().props["aria-activedescendant"]);
  assert.equal(current.props.title, "c:/work/current");
  assert.equal(current.props["aria-level"], 2);
  assert.equal(items()[0].props["aria-expanded"], true);
  assert.equal(items().some(n => n.props.title === "/Work/child"), false);
  assert.equal(items().find(n => n.props.title === "/work/different-case").props["aria-level"], 1);
  assert.equal(items().find(n => n.props.title === "/Workspace/child").props["aria-level"], 1);
  assert.equal(confirm().props.disabled, true);

  press("ArrowDown");
  assert.equal(tree().props["aria-activedescendant"], items()[2].props.id);
  assert.equal(selected(), undefined);
  assert.equal(confirm().props.disabled, true);
  press("Escape");
  assert.equal(tree(), undefined);
  assert.equal(targetTrigger(host).props["aria-label"], "选择工作区");
  assert.equal(app.document.activeElement.vnode.props["aria-haspopup"], "tree");
  openTargetPopup(host);
  press("ArrowDown");
  press("Enter");
  assert.equal(tree(), undefined);
  assert.match(text(targetTrigger(host)), /C:\\Work\\next/);
  assert.deepEqual(confirmed, []);
  assert.equal(confirm().props.disabled, false);
  confirm().props.onClick();
  assert.deepEqual(confirmed, ["win-next"]);

  openTargetPopup(host);
  const otherBranch = items().find(n => n.props.title === "/Work");
  nodes(otherBranch, n => n.props?.className === "sm-moveTreeToggle")[0].props.onClick({ stopPropagation() {} });
  host.render();
  assert.equal(selected().props.title, "C:\\Work\\next");
  assert.equal(items().find(n => n.props.title === "/Work/child").props["aria-level"], 2);
  press("Escape");
  openTargetPopup(host);
  press("ArrowLeft");
  assert.equal(tree().props["aria-activedescendant"], items()[0].props.id);
  press("ArrowLeft");
  assert.equal(items()[0].props["aria-expanded"], false);
  press("ArrowRight");
  assert.equal(items()[0].props["aria-expanded"], true);
  press("End");
  press("Enter");
  assert.match(text(targetTrigger(host)), /no-path/);
  host.props = { ...host.props, workspaces: host.props.workspaces.filter(ws => ws.id !== "no-path") };
  host.render();
  assert.equal(confirm().props.disabled, true);
  confirm().props.onClick();
  assert.deepEqual(confirmed, ["win-next"]);
});

test("bulk move uses the same dropdown tree and submits its selected child only after confirmation", async t => {
  const app = mountClient({
    sessions: SESSIONS,
    workspaces: [{ id: "root", path: "/work" }, { id: "child", path: "/work/nested" }]
  });
  t.after(() => app.dispose());
  await app.flush();
  await app.click("批量处理");
  const bar = () => nodes(app.tree, n => n.type?.name === "BulkActionBar")[0];
  bar().props.onSelectAll();
  await app.flush();
  bar().props.onOpenMoveDialog();
  await app.flush();
  const dialog = nodes(app.tree, n => n.type === app.exports.MoveDialog && n.props.bulk)[0];
  const host = app.mountComponent(dialog.type, dialog.props);
  t.after(() => host.dispose());
  assert.equal(targetTrigger(host).props["aria-label"], "选择工作区");
  assert.equal(targetConfirm(host).props.disabled, true);
  const tree = openTargetPopup(host);
  assert.equal(tree.props.role, "tree");
  const roots = nodes(tree, n => n.props?.role === "treeitem");
  assert.equal(roots.length, 1);
  assert.equal(roots[0].props["aria-expanded"], false);
  nodes(roots[0], n => n.props?.className === "sm-moveTreeToggle")[0].props.onClick({ stopPropagation() {} });
  host.render();
  const child = nodes(targetPopup(host), n => n.props?.title === "/work/nested")[0];
  child.props.onClick();
  host.render();
  assert.match(text(targetTrigger(host)), /child/);
  assert.equal(app.requests.some(r => r.url === "/session-manager/api/batch"), false);
  targetConfirm(host).props.onClick();
  await app.flush();
  const batch = app.requests.find(r => r.url === "/session-manager/api/batch");
  assert.deepEqual(JSON.parse(batch.options.body), {
    action: "move", sessionIds: ["s1", "s2"], payload: { targetWorkspaceId: "child" }
  });
});

test("title-bar buttons do not disappear or throw when SessionManagerPanel is open (Node.contains guard)", async () => {
  const panelRect = { top: 200, bottom: 700, left: 500, right: 1100, width: 600, height: 500 };
  const customQuerySelector = (sel) => {
    if (sel === ".sm-panelDialog:not(.sm-annotationSurface)") {
      return {
        nodeType: 1,
        getBoundingClientRect: () => ({ ...panelRect }),
        contains: (node) => {
          if (!node || typeof node.contains !== "function") {
            throw new TypeError("Failed to execute 'contains' on 'Node': parameter 1 is not of type 'Node'.");
          }
          return false;
        }
      };
    }
  };

  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    current: "s1",
    querySelector: customQuerySelector
  });
  await app.flush();
  await app.mountHeader("s1");

  // Clicking move button in header while panel is open must not throw
  const headerMoveBtn = nodes(app.headerTree, n => n.type === "button" && text(n).includes("移动至工作区"))[0];
  assert.ok(headerMoveBtn, "Title bar move button must exist");
  assert.doesNotThrow(() => {
    headerMoveBtn.props.onClick();
  });
  await app.flush();

  const titleMoveDialogEl = nodes(app.headerTree, n => n.type?.name === "MoveDialog" && n.props?.open)[0];
  assert.ok(titleMoveDialogEl, "MoveDialog must open safely without crashing");

  // Clicking delete button in header while panel is open must not throw
  const headerDelBtn = nodes(app.headerTree, n => n.type === "button" && text(n).includes("删除会话"))[0];
  assert.ok(headerDelBtn, "Title bar delete button must exist");
  assert.doesNotThrow(() => {
    headerDelBtn.props.onClick();
  });
  await app.flush();

  const titleDelDialogEl = nodes(app.headerTree, n => n.type?.name === "ConfirmDialog" && n.props?.open)[0];
  assert.ok(titleDelDialogEl, "ConfirmDialog must open safely without crashing");

  app.dispose();
});

test("unified first line text formatting across single and bulk dialogs", async () => {
  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
    current: "s1"
  });
  await app.flush();

  // 1. Single Delete dialog first line
  const row = nodes(app.tree, node => node.props?.["data-session-id"] === "s1")[0];
  const deleteBtn = nodes(row, node => node.type === "button" && text(node) === "删除会话")[0];
  deleteBtn.props.onClick();
  await app.flush();
  let confirmDialogEl = nodes(app.tree, node => node.type?.name === "ConfirmDialog" && node.props?.open)[0];
  let host = app.mountComponent(confirmDialogEl.type, confirmDialogEl.props);
  let desc = nodes(host.tree, n => n.props?.className === "sm-nativeDialogDescription")[0];
  assert.equal(text(desc), "「Alpha Session」：删除，不可恢复");
  let warn = nodes(host.tree, n => n.props?.className?.includes("sm-bulkDialogWarn"))[0];
  assert.ok(warn, "Single delete dialog must render warning banner");
  assert.equal(text(warn), "删除操作不可撤销，请确认后再继续。");

  // 2. Single Move dialog first line
  const moveBtn = nodes(row, node => node.type === "button" && text(node) === "移动至工作区")[0];
  moveBtn.props.onClick();
  await app.flush();
  let moveDialogEl = nodes(app.tree, node => node.type?.name === "MoveDialog" && node.props?.open)[0];
  host = app.mountComponent(moveDialogEl.type, moveDialogEl.props);
  desc = nodes(host.tree, n => n.props?.className === "sm-nativeDialogDescription")[0];
  assert.equal(text(desc), "「Alpha Session」：移动至目标工作区");
  assert.equal(nodes(host.tree, n => n.props?.className === "sm-moveLabel").length, 0, "MoveDialog should not render extra sm-moveLabel above select");

  // 3. Single Migrate dialog first line
  const migrateBtn = nodes(row, node => node.type === "button" && text(node) === "迁移预设")[0];
  migrateBtn.props.onClick();
  await app.flush();
  let migrateDialogEl = nodes(app.tree, node => node.type?.name === "MigratePresetDialog" && node.props?.open)[0];
  host = app.mountComponent(migrateDialogEl.type, migrateDialogEl.props);
  desc = nodes(host.tree, n => n.props?.className === "sm-nativeDialogDescription")[0];
  assert.equal(text(desc), "「Alpha Session」：迁移至目标预设");
  assert.equal(nodes(host.tree, n => n.props?.className === "sm-moveLabel").length, 0, "MigratePresetDialog should not render extra sm-moveLabel above select");

  // 4. Single Annotation dialog first line
  await app.mountHeader("s1");
  const markBtn = nodes(app.headerTree, n => n.type === "button" && text(n).includes("标签/备注"))[0];
  markBtn.props.onClick();
  await app.flush();
  let annotDialogEl = nodes(app.headerTree, n => n.type?.name === "AnnotationDialog")[0];
  host = app.mountComponent(annotDialogEl.type, annotDialogEl.props);
  let target = nodes(host.tree, n => n.props?.className === "sm-annotationTarget")[0];
  assert.equal(text(target), "「Alpha Session」：编辑标记与备注");
  const saveBtn = nodes(host.tree, n => n.type === "button" && n.props?.className?.includes("sm-nativeDialogConfirm"))[0];
  assert.ok(saveBtn, "AnnotationDialog save button must have sm-nativeDialogConfirm");

  // 5. Bulk actions first line
  const selectModeBtn = nodes(app.tree, n => n.type === "button" && text(n) === "批量处理")[0];
  selectModeBtn.props.onClick();
  await app.flush();
  let bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onSelectAll();
  await app.flush();

  // 5a. Bulk Delete
  bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onAction("delete", null, true);
  await app.flush();
  let bulkPreviewEl = nodes(app.tree, node => node.type?.name === "BatchPreviewDialog" && node.props?.open)[0];
  host = app.mountComponent(bulkPreviewEl.type, bulkPreviewEl.props);
  let summary = nodes(host.tree, n => n.props?.className === "sm-bulkDialogSummary")[0];
  assert.equal(text(summary), "「2条会话」：删除，不可恢复");

  // 5b. Bulk Move
  bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onOpenMoveDialog();
  await app.flush();
  let bulkMoveEl = nodes(app.tree, node => node.type?.name === "MoveDialog" && node.props?.bulk)[0];
  host = app.mountComponent(bulkMoveEl.type, bulkMoveEl.props);
  summary = nodes(host.tree, n => n.props?.className === "sm-bulkDialogSummary")[0];
  assert.equal(text(summary), "「2条会话」：移动至目标工作区");

  // 5c. Bulk Preset Migrate
  bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onOpenPresetDialog();
  await app.flush();
  let bulkPresetEl = nodes(app.tree, node => node.type?.name === "BulkChoiceDialog" && node.props?.open && node.props?.title === "迁移预设")[0];
  host = app.mountComponent(bulkPresetEl.type, bulkPresetEl.props);
  summary = nodes(host.tree, n => n.props?.className === "sm-bulkDialogSummary")[0];
  assert.equal(text(summary), "「2条会话」：迁移至目标预设");
  assert.equal(targetTrigger(host).props["aria-haspopup"], "listbox");
  assert.equal(targetTrigger(host).props["aria-label"], "选择预设");
  assert.equal(targetConfirm(host).props.disabled, true);

  // 5d. Bulk Tags Add
  bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onOpenTagDialog();
  await app.flush();
  let bulkTagEl = nodes(app.tree, node => node.type?.name === "BulkTagInputDialog" && node.props?.open)[0];
  host = app.mountComponent(bulkTagEl.type, bulkTagEl.props);
  summary = nodes(host.tree, n => n.props?.className === "sm-bulkDialogSummary")[0];
  assert.equal(text(summary), "「2条会话」：添加标签");

  app.dispose();
});

test("Escape key closes secondary dialogs in LIFO order (topmost/newest first)", async () => {
  const app = mountClient({
    sessions: SESSIONS,
    workspaces: WORKSPACES,
  });
  await app.mountHeader("s1");

  // 1. Open MoveDialog from header
  const moveBtn = nodes(app.headerTree, n => n.type === "button" && text(n).includes("移动"))[0];
  assert.ok(moveBtn, "Header move button must exist");
  moveBtn.props.onClick();
  await app.flush();

  const moveEl = nodes(app.headerTree, n => n.type?.name === "MoveDialog" && n.props?.open)[0];
  assert.ok(moveEl, "MoveDialog element exists in headerTree");
  const moveHost = app.mountComponent(moveEl.type, moveEl.props);

  // 2. Open AnnotationDialog from header (while MoveDialog is already open)
  const markBtn = nodes(app.headerTree, n => n.type === "button" && text(n).includes("标签/备注"))[0];
  assert.ok(markBtn, "Header mark button must exist");
  markBtn.props.onClick();
  await app.flush();

  const annotEl = nodes(app.headerTree, n => n.type?.name === "AnnotationDialog")[0];
  assert.ok(annotEl, "AnnotationDialog element exists in headerTree");

  // Both dialogs are currently open in headerTree
  assert.ok(nodes(app.headerTree, n => n.type?.name === "MoveDialog" && n.props?.open)[0], "MoveDialog is open");
  assert.ok(nodes(app.headerTree, n => n.type?.name === "AnnotationDialog")[0], "AnnotationDialog is open");

  // 3. Press Escape: the newer/topmost dialog (AnnotationDialog) must close first
  app.keydown({ key: "Escape" });
  await app.flush();

  assert.equal(nodes(app.headerTree, n => n.type?.name === "AnnotationDialog").length, 0, "AnnotationDialog should have closed first on Escape");
  assert.ok(nodes(app.headerTree, n => n.type?.name === "MoveDialog" && n.props?.open)[0], "MoveDialog should still remain open");

  // 4. Press Escape again: the remaining dialog (MoveDialog) must now close
  app.keydown({ key: "Escape" });
  await app.flush();

  assert.equal(nodes(app.headerTree, n => n.type?.name === "MoveDialog" && n.props?.open).length, 0, "MoveDialog should now be closed on second Escape");

  moveHost.dispose();
  app.dispose();
});

test('prepared preset dialog is immediately usable and focuses without scrolling', async t => {
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES });
  t.after(() => app.dispose());
  await app.flush();
  const host = app.mountComponent(app.exports.MigratePresetDialog, {
    open: true, sessionId: 's1', currentPreset: 'PresetA', t: app.t,
    scan: { ok: true, row: { finalPreset: 'PresetA' }, availablePresets: ['PresetA', 'PresetB'] }
  });
  t.after(() => host.dispose());
  const trigger = targetTrigger(host);
  assert.equal(trigger.props.disabled, false);
  assert.equal(trigger.props["aria-label"], "选择预设");
  assert.equal(trigger.props.autoFocus, undefined);
  assert.ok(!text(host.tree).includes('处理中'));
  assert.ok(app.focusCalls.some(call => call.options?.preventScroll === true));
  const firstStyle = { ...host.tree.props.style };
  choosePreset(host, "PresetB");
  assert.deepEqual({ ...host.tree.props.style }, firstStyle);
  assert.equal(nodes(host.tree, n => n.props?.className?.includes('sm-nativeDialogConfirm'))[0].props.disabled, false);
});

test('preset migration opens with complete data and does not request again inside the dialog', async t => {
  let finish;
  let requests = 0;
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES,
    fetchPresetScan: () => { requests++; return new Promise(resolve => { finish = resolve; }); } });
  t.after(() => app.dispose());
  await app.flush();
  await app.clickLabel('迁移预设: Alpha Session');
  assert.equal(nodes(app.tree, n => n.type?.name === 'MigratePresetDialog').length, 0);
  assert.equal(app.control('迁移预设: Alpha Session').props['aria-busy'], true);
  finish({ ok: true, result: { rows: [{ sessionId: 's1', finalPreset: 'PresetA' }], availablePresets: ['PresetA', 'PresetB'] } });
  await app.flush();
  const dialog = nodes(app.tree, n => n.type?.name === 'MigratePresetDialog')[0];
  assert.ok(dialog);
  const host = app.mountComponent(dialog.type, dialog.props);
  t.after(() => host.dispose());
  const trigger = targetTrigger(host);
  assert.equal(trigger.props.disabled, false);
  assert.equal(trigger.props["aria-label"], "选择预设");
  assert.ok(!text(host.tree).includes('处理中'));
  await app.flush();
  assert.equal(requests, 1);
});

test('late preset responses cannot open the wrong session dialog', async t => {
  const completions = [];
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES,
    fetchPresetScan: () => new Promise(resolve => completions.push(resolve)) });
  t.after(() => app.dispose());
  await app.flush();
  await app.clickLabel('迁移预设: Alpha Session');
  await app.clickLabel('迁移预设: Beta Session');
  completions[0]({ ok: true, result: { availablePresets: ['Stale'] } });
  await app.flush();
  assert.equal(nodes(app.tree, n => n.type?.name === 'MigratePresetDialog').length, 0);
  completions[1]({ ok: true, result: { availablePresets: ['PresetB'] } });
  await app.flush();
  assert.equal(nodes(app.tree, n => n.type?.name === 'MigratePresetDialog')[0].props.sessionId, 's2');
});

test('preset preparation failure stays in the panel and allows a retry', async t => {
  let failed = true;
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES,
    fetchPresetScan: async () => failed ? { ok: false, error: 'scan unavailable' } : { ok: true, result: { availablePresets: ['PresetB'] } } });
  t.after(() => app.dispose());
  await app.flush();
  await app.clickLabel('迁移预设: Alpha Session');
  assert.equal(nodes(app.tree, n => n.type?.name === 'MigratePresetDialog').length, 0);
  assert.match(text(app.tree), /scan unavailable/);
  assert.equal(app.control('迁移预设: Alpha Session').props['aria-busy'], false);
  failed = false;
  await app.clickLabel('迁移预设: Alpha Session');
  assert.ok(nodes(app.tree, n => n.type?.name === 'MigratePresetDialog').length);
});

test('closing the panel cancels pending preset preparation', async t => {
  let finish;
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES,
    fetchPresetScan: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => app.dispose());
  await app.flush();
  await app.clickLabel('迁移预设: Alpha Session');
  app.keydown({ key: 'Escape' });
  await app.flush();
  finish({ ok: true, result: { availablePresets: ['PresetB'] } });
  await app.flush();
  assert.equal(nodes(app.tree, n => n.type?.name === 'MigratePresetDialog').length, 0);
});

test('prepared preset dialog respects focus moved while waiting for data', async t => {
  let finish;
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES,
    fetchPresetScan: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => app.dispose());
  await app.flush();
  app.document.activeElement = { tagName: 'BUTTON', id: 'origin' };
  await app.clickLabel('迁移预设: Alpha Session');
  app.document.activeElement = { tagName: 'BUTTON', id: 'other' };
  finish({ ok: true, result: { availablePresets: ['PresetB'] } });
  await app.flush();
  const dialog = nodes(app.tree, n => n.type?.name === 'MigratePresetDialog')[0];
  const host = app.mountComponent(dialog.type, dialog.props);
  t.after(() => host.dispose());
  assert.equal(app.focusCalls.length, 0);
});

test('clicking the pending preset action again cancels preparation', async t => {
  let finish;
  const app = mountClient({ sessions: SESSIONS, workspaces: WORKSPACES,
    fetchPresetScan: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => app.dispose());
  await app.flush();
  await app.clickLabel('迁移预设: Alpha Session');
  await app.clickLabel('迁移预设: Alpha Session');
  finish({ ok: true, result: { availablePresets: ['PresetB'] } });
  await app.flush();
  assert.equal(nodes(app.tree, n => n.type?.name === 'MigratePresetDialog').length, 0);
  assert.equal(app.control('迁移预设: Alpha Session').props['aria-busy'], false);
});
