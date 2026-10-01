import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

test("delete navigation: deleting the current session from header calls uiWorkspace.clearMain()", async () => {
  const app = mountClient({
    sessions: [
      { id: "s1", displayTitle: "Active Session" },
      { id: "s2", displayTitle: "Other Session" }
    ],
    current: "s1"
  });
  await app.flush();

  await app.mountHeader("s1");
  const deleteBtn = nodes(app.headerTree, n => n.props?.["aria-label"] === "删除会话")[0];
  assert.ok(deleteBtn, "Header delete button must exist");

  deleteBtn.props.onClick({ currentTarget: {} });
  await app.flush();

  const confirmDialog = nodes(app.headerTree, n => n.props?.title === "删除会话")[0];
  assert.ok(confirmDialog, "ConfirmDialog must be open");

  // Confirm delete
  await confirmDialog.props.onConfirm();
  await app.flush();

  assert.ok(
    app.clearMainCalls.includes("clearMain"),
    "uiWorkspace.clearMain() must be called when deleting current session from header"
  );
  assert.equal(app.ctx.sessions.list.getSnapshot().current, "");
  assert.ok(app.refreshCalls.includes("sessions"), "ctx.sessions.refresh must be called");
  assert.ok(app.refreshCalls.includes("workspaces"), "ctx.workspaces.refresh must be called");

  app.dispose();
});

test("delete navigation: deleting current session from panel row calls uiWorkspace.clearMain()", async () => {
  const app = mountClient({
    sessions: [
      { id: "s1", displayTitle: "Active Session" },
      { id: "s2", displayTitle: "Other Session" }
    ],
    current: "s1"
  });
  await app.flush();

  // Find row delete button for s1
  const s1Row = nodes(app.tree, n => n.props?.["data-session-id"] === "s1")[0];
  assert.ok(s1Row, "s1 row must exist");
  const deleteBtn = nodes(s1Row, n => n.type === "button" && text(n) === "删除会话")[0];
  assert.ok(deleteBtn, "Row delete button must exist");

  deleteBtn.props.onClick();
  await app.flush();

  const confirmDialog = nodes(app.tree, n => n.props?.title === "删除会话")[0];
  assert.ok(confirmDialog, "ConfirmDialog must be open");

  await confirmDialog.props.onConfirm();
  await app.flush();

  assert.ok(
    app.clearMainCalls.includes("clearMain"),
    "uiWorkspace.clearMain() must be called when deleting current session from panel row"
  );
  assert.equal(app.ctx.sessions.list.getSnapshot().current, "");

  app.dispose();
});

test("delete navigation: deleting a non-current session does NOT call uiWorkspace.clearMain()", async () => {
  const app = mountClient({
    sessions: [
      { id: "s1", displayTitle: "Active Session" },
      { id: "s2", displayTitle: "Other Session" }
    ],
    current: "s1"
  });
  await app.flush();

  // Find row delete button for s2 (non-current)
  const s2Row = nodes(app.tree, n => n.props?.["data-session-id"] === "s2")[0];
  assert.ok(s2Row, "s2 row must exist");
  const deleteBtn = nodes(s2Row, n => n.type === "button" && text(n) === "删除会话")[0];
  assert.ok(deleteBtn, "Row delete button must exist");

  deleteBtn.props.onClick();
  await app.flush();

  const confirmDialog = nodes(app.tree, n => n.props?.title === "删除会话")[0];
  assert.ok(confirmDialog, "ConfirmDialog must be open");

  await confirmDialog.props.onConfirm();
  await app.flush();

  assert.ok(
    !app.clearMainCalls.includes("clearMain"),
    "uiWorkspace.clearMain() must NOT be called when deleting a non-current session"
  );
  assert.equal(app.ctx.sessions.list.getSnapshot().current, "s1");

  app.dispose();
});

test("delete navigation: bulk deleting a batch containing current session calls clearMain()", async () => {
  const app = mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1" },
      { id: "s2", displayTitle: "Session 2" },
      { id: "s3", displayTitle: "Session 3" }
    ],
    current: "s1"
  });
  await app.flush();

  // Enter batch mode
  const selectModeBtn = nodes(app.tree, n => n.type === "button" && text(n) === "批量处理")[0];
  assert.ok(selectModeBtn, "Batch mode toggle button must exist");
  selectModeBtn.props.onClick();
  await app.flush();

  // Find BulkActionBar and select all
  let bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  assert.ok(bar, "BulkActionBar must exist");
  bar.props.onSelectAll();
  await app.flush();

  // Re-query fresh BulkActionBar after state update
  bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onAction("delete", null, true);
  await app.flush();

  const preview = nodes(app.tree, n => typeof n.type === "function" && n.type.name === "BatchPreviewDialog")[0];
  assert.ok(preview, "BatchPreviewDialog must be open");

  await preview.props.onExecute();
  await app.flush();

  assert.ok(
    app.clearMainCalls.includes("clearMain"),
    "uiWorkspace.clearMain() must be called when bulk delete includes current session"
  );

  app.dispose();
});

test("delete navigation: bulk deleting a batch NOT containing current session does NOT call clearMain()", async () => {
  const app = mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1" },
      { id: "s2", displayTitle: "Session 2" },
      { id: "s3", displayTitle: "Session 3" }
    ],
    current: "s3"
  });
  await app.flush();

  // Enter batch mode
  const selectModeBtn = nodes(app.tree, n => n.type === "button" && text(n) === "批量处理")[0];
  selectModeBtn.props.onClick();
  await app.flush();

  // Select only s1
  const checkboxes = nodes(app.tree, n => n.type === "input" && n.props?.type === "checkbox");
  assert.ok(checkboxes.length > 0, "Checkboxes must exist");
  checkboxes[0].props.onChange({ shiftKey: false });
  await app.flush();

  const bar = nodes(app.tree[0], n => typeof n.type === "function" && n.type.name === "BulkActionBar")[0];
  bar.props.onAction("delete", null, true);
  await app.flush();

  const preview = nodes(app.tree, n => typeof n.type === "function" && n.type.name === "BatchPreviewDialog")[0];
  assert.ok(preview, "BatchPreviewDialog must be open");

  await preview.props.onExecute();
  await app.flush();

  assert.ok(
    !app.clearMainCalls.includes("clearMain"),
    "uiWorkspace.clearMain() must NOT be called when bulk delete does NOT include current session"
  );
  assert.equal(app.ctx.sessions.list.getSnapshot().current, "s3");

  app.dispose();
});

test("delete navigation: archive session navigates to new session view", async () => {
  const app = mountClient({
    sessions: [
      { id: "s1", displayTitle: "Session 1" },
      { id: "s2", displayTitle: "Session 2" }
    ],
    current: "s1"
  });
  await app.flush();

  await app.mountHeader("s1");
  const archiveBtn = nodes(app.headerTree, n => n.props?.["aria-label"] === "归档")[0];
  assert.ok(archiveBtn, "Header archive button must exist");

  archiveBtn.props.onClick();
  await app.flush();

  assert.ok(
    app.clearMainCalls.some(c => c.includes("archiveSession") || c === "clearMain"),
    "Archiving current session must trigger uiWorkspace clear / archive"
  );

  app.dispose();
});
