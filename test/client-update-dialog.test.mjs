import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

test("UpdateDialog: renders in 'available' status with version info and action buttons", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "available";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialog = nodes(componentHost.tree, n => n.props?.role === "dialog")[0];
  assert.ok(dialog, "Dialog role should be rendered");

  const dialogText = text(componentHost.tree);
  assert.ok(dialogText.includes("v1.0.0"), "Should display current version");
  assert.ok(dialogText.includes("v1.2.0"), "Should display latest version");
  assert.ok(dialogText.includes(harness.t("update.newVersion")), "Should display available title or notice");

  const buttons = nodes(componentHost.tree, n => n.type === "button");
  const laterBtn = buttons.find(b => text(b).includes(harness.t("update.btn.later")));
  const updateBtn = buttons.find(b => text(b).includes(harness.t("update.btn.update", { version: "1.2.0" })));
  assert.ok(laterBtn, "Later button must exist");
  assert.ok(updateBtn, "Update button must exist");

  // Clicking later button closes dialog
  laterBtn.props.onClick();
  assert.equal(updateStore.getSnapshot().dialogOpen, false);

  componentHost.dispose();
  harness.dispose();
});

test("UpdateDialog: renders in 'updating' status with disabled state", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.status = "updating";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(componentHost.tree);
  assert.ok(dialogText.includes(harness.t("update.installing")), "Should display updating status");

  const updatingBtn = nodes(componentHost.tree, n => n.type === "button" && n.props.disabled)[0];
  assert.ok(updatingBtn, "Updating button should be disabled");

  // Close button in header is absent when updating to avoid interrupting
  const closeBtn = nodes(componentHost.tree, n => n.props?.className?.includes("sm-panelHeaderClose"))[0];
  assert.equal(closeBtn, undefined, "Close button must not be present while updating");

  componentHost.dispose();
  harness.dispose();
});

test("UpdateDialog: renders in 'done' status with restart notice", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "done";
  updateStore.state.application = "restart-required";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(componentHost.tree);
  const restartExpected = harness.t("update.done.restart", { from: "1.0.0", to: "1.2.0" });
  assert.ok(dialogText.includes(restartExpected), "Should display restart notice: " + restartExpected);

  const doneBtn = nodes(componentHost.tree, n => n.type === "button" && text(n).includes(harness.t("update.btn.done")))[0];
  assert.ok(doneBtn, "Done button should exist");

  doneBtn.props.onClick();
  assert.equal(updateStore.getSnapshot().dialogOpen, false);

  componentHost.dispose();
  harness.dispose();
});

test("UpdateDialog: renders in 'done' status with hot-applied notice", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.status = "done";
  updateStore.state.application = "applied";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(componentHost.tree);
  const appliedExpected = harness.t("update.done.applied");
  assert.ok(dialogText.includes(appliedExpected), "Should display hot-applied notice: " + appliedExpected);

  componentHost.dispose();
  harness.dispose();
});

test("UpdateDialog: renders in 'error' status with retry and close buttons", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.status = "error";
  updateStore.state.error = "Connection timeout";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(componentHost.tree);
  assert.ok(dialogText.includes("Connection timeout"), "Should display error description");

  const buttons = nodes(componentHost.tree, n => n.type === "button");
  const retryBtn = buttons.find(b => text(b).includes(harness.t("update.btn.retry")));
  const closeBtn = buttons.find(b => text(b).includes(harness.t("update.btn.close")));
  assert.ok(retryBtn, "Retry button must exist");
  assert.ok(closeBtn, "Close button must exist");

  closeBtn.props.onClick();
  assert.equal(updateStore.getSnapshot().dialogOpen, false);

  componentHost.dispose();
  harness.dispose();
});

test("Panel header: includes Whale update button with click and keydown triggers", () => {
  const harness = mountClient();
  const { updateStore } = harness.exports;

  // Find whale button in panel header
  const whaleBtn = harness.find(n => n.props?.className?.includes("sm-panelHeaderWhale"))[0];
  assert.ok(whaleBtn, "Whale icon button must exist in panel header");

  updateStore.state.status = "idle";
  updateStore.state.dialogOpen = false;

  // Trigger click
  whaleBtn.props.onClick({ preventDefault() {} });
  assert.equal(updateStore.getSnapshot().dialogOpen, true);

  // Reset to idle and closed to trigger Enter key
  updateStore.state.status = "idle";
  updateStore.state.dialogOpen = false;
  whaleBtn.props.onKeyDown({ key: "Enter", preventDefault() {} });
  assert.equal(updateStore.getSnapshot().dialogOpen, true);

  harness.dispose();
});
