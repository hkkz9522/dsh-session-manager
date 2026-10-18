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

test("UpdateDialog: renders in 'done' status with refresh-required notice", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "done";
  updateStore.state.application = "refresh-required";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(componentHost.tree);
  const refreshExpected = harness.t("update.done.refresh", { from: "1.0.0", to: "1.2.0" });
  assert.ok(dialogText.includes(refreshExpected), "Should display refresh notice: " + refreshExpected);

  componentHost.dispose();
  harness.dispose();
});

test("UpdateDialog: displays source warning notes for linked or github sources", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.status = "idle";
  updateStore.state.notes = "update.source.linked";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(componentHost.tree);
  assert.ok(dialogText.includes(harness.t("update.source.linked")), "Should display linked source note");

  componentHost.dispose();
  harness.dispose();
});

test("Update styling: confirm button hover maintains solid blue background, white text and darkens slightly", () => {
  const harness = mountClient();
  const css = harness.styleTags.map(tag => tag.textContent ?? "").join("\n");

  assert.ok(
    css.includes(".sm-updateDialog .sm-nativeDialogButton.sm-nativeDialogConfirm:hover:not(:disabled)"),
    "Must include hover rule for update dialog confirm button"
  );
  assert.ok(
    css.includes("background:var(--dsw-alias-state-business-primary,#356ae6)!important"),
    "Must preserve primary blue background on hover with !important"
  );
  assert.ok(
    css.includes("color:var(--dsw-alias-label-primary-foreground,#fff)!important"),
    "Must preserve white text on hover with !important"
  );
  assert.ok(
    css.includes("filter:brightness(.94)!important"),
    "Must apply brightness(.94) to slightly darken confirm button on hover"
  );

  harness.dispose();
});

test("Update styling: confirm is blue with !important and cancel is transparent with !important", () => {
  const harness = mountClient();
  const css = harness.styleTags.map(tag => tag.textContent ?? "").join("\n");

  assert.ok(
    css.includes(".sm-updateDialog .sm-nativeDialogConfirm,.sm-updateDialog .sm-nativeDialogButton.sm-nativeDialogConfirm")
    && css.includes("background:var(--dsw-alias-state-business-primary,#356ae6)!important"),
    "Must style confirm button as solid primary blue"
  );
  assert.ok(
    css.includes(".sm-updateDialog .sm-nativeDialogCancel,.sm-updateDialog .sm-nativeDialogButton.sm-nativeDialogCancel")
    && css.includes("background:transparent!important"),
    "Must style cancel button as transparent / white"
  );

  harness.dispose();
});

test("updateStore.startUpdate: calls /update/install directly without dsh-market", async () => {
  let installCalled = false;
  let passedBody = null;

  const harness = mountClient({
    fetchUpdateInstall: async (body) => {
      installCalled = true;
      passedBody = body;
      return {
        ok: true,
        result: { application: "restart-required", spec: "dsh-session-manager@1.5.0", version: "1.5.0" }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "1.5.0";

  await updateStore.startUpdate();

  assert.equal(installCalled, true, "Must call /update/install directly");
  assert.equal(passedBody.version, "1.5.0");
  assert.equal(updateStore.state.status, "done");
  assert.equal(updateStore.state.application, "restart-required");

  harness.dispose();
});

test("updateStore.startUpdate: polls /update/status when connection is lost during HMR update", async () => {
  let installAttempted = false;
  let statusPolls = 0;

  const harness = mountClient({
    fetchUpdateInstall: async () => {
      installAttempted = true;
      // Simulate network disconnect / route unmounting during HMR reload
      throw new Error("Failed to fetch");
    },
    fetchUpdateStatus: async () => {
      statusPolls++;
      if (statusPolls === 1) {
        return { ok: true, result: { status: "updating", targetVersion: "1.5.0" } };
      }
      return {
        ok: true,
        result: {
          status: "completed",
          application: "refresh-required",
          targetVersion: "1.5.0"
        }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "1.5.0";

  await updateStore.startUpdate();

  assert.equal(installAttempted, true, "Must attempt install");
  assert.ok(statusPolls >= 2, "Must poll /update/status to reconcile");
  assert.equal(updateStore.state.status, "done");
  assert.equal(updateStore.state.application, "refresh-required");

  harness.dispose();
});

test("updateStore.startUpdate: reports rollback details on installation failure", async () => {
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      return {
        ok: false,
        code: "install-failed",
        error: "安装更新失败: 网络超时 （已自动恢复旧版本 v0.7.3）",
        rolledBack: true
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "1.5.0";

  await updateStore.startUpdate();

  assert.equal(updateStore.state.status, "error");
  assert.ok(updateStore.state.error.includes("网络超时"));
  assert.ok(updateStore.state.error.includes("已自动恢复旧版本"));

  harness.dispose();
});

test("UpdateDialog: in checking status, keeps check button mounted and disabled to prevent layout shift", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.status = "checking";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  const buttons = nodes(componentHost.tree, n => n.type === "button");

  const closeBtn = buttons.find(b => text(b).includes(harness.t("update.btn.close")));
  const checkBtn = buttons.find(b => text(b).includes(harness.t("update.checking")));

  assert.ok(closeBtn, "Close button must remain mounted in footer during checking");
  assert.ok(checkBtn, "Check button must remain mounted in footer during checking");
  assert.equal(checkBtn.props.disabled, true, "Check button must be disabled during checking");

  const statusBox = nodes(componentHost.tree, n => n.props?.className?.includes("sm-updateStatusBox sm-checking"))[0];
  assert.ok(statusBox, "Status box must include sm-checking class");
  assert.ok(text(statusBox).includes(harness.t("update.checking")), "Status box should show checking message");

  componentHost.dispose();
  harness.dispose();
});

test("UpdateDialog styling: contains locked height, body geometry and animation:none to prevent jitter", () => {
  const harness = mountClient();
  const css = harness.styleTags.map(tag => tag.textContent ?? "").join("\n");

  assert.ok(
    css.includes(".sm-updateDialogLayer .sm-nativeDialog") && css.includes("height:248px!important"),
    "Native dialog frame must lock exact height:248px!important"
  );
  assert.ok(
    css.includes(".sm-updateDialog .sm-nativeDialogBody") && css.includes("height:152px!important"),
    "Dialog body must lock exact height:152px!important"
  );
  assert.ok(
    css.includes(".sm-updateDialogLayer .sm-nativeDialog") && css.includes("animation:none!important"),
    "Must disable sm-confirmPop animation with animation:none!important"
  );
  assert.ok(
    css.includes(".sm-updateStatusBox") && css.includes("min-height:38px") && css.includes("box-sizing:border-box"),
    "Status box must have consistent box-sizing and min-height:38px"
  );
  assert.ok(
    css.includes(".sm-updateStatusBox.sm-checking"),
    "Must include styled sm-checking rule"
  );
  assert.ok(
    css.includes(".sm-nativeDialogButton:disabled") && css.includes("cursor:not-allowed!important"),
    "Must style disabled buttons with cursor:not-allowed"
  );

  harness.dispose();
});

test("UpdateDialog: renders strictly one mutually exclusive status box without stacking", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  // Simulate linked notes present initially
  updateStore.state.status = "idle";
  updateStore.state.notes = "update.source.linked";
  updateStore.state.dialogOpen = true;

  const componentHost = harness.mountComponent(UpdateDialog, { t: harness.t });
  let boxes = nodes(componentHost.tree, n => n.props?.className?.includes("sm-updateStatusBox") && !n.props?.className?.includes("sm-placeholder"));
  assert.equal(boxes.length, 1, "Must render exactly 1 visible status box initially");
  assert.ok(boxes[0].props.className.includes("sm-warn"), "Initial box should be sm-warn for notes");

  // Checking started
  updateStore.state.status = "checking";
  updateStore.state.notes = null; // Cleared on check
  updateStore._notify();
  componentHost.render();

  boxes = nodes(componentHost.tree, n => n.props?.className?.includes("sm-updateStatusBox") && !n.props?.className?.includes("sm-placeholder"));
  assert.equal(boxes.length, 1, "Must render strictly 1 status box during checking");
  assert.ok(boxes[0].props.className.includes("sm-checking"), "Should render sm-checking box only");

  componentHost.dispose();
  harness.dispose();
});
