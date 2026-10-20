import { readFileSync } from "node:fs";
import { test } from "node:test";

import { strict as assert } from "node:assert";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

// The running plugin version reported by the Host falls back to this build's
// package.json version; derive it so a release bump does not stale fixtures.
const PLUGIN_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

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
  assert.notEqual(harness.t("update.btn.close"), "update.btn.close", "update.btn.close must be localized");
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

test("UpdateDialog: renders clear rollback notification with title, restored version and reason", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.status = "error";
  updateStore.state.dialogOpen = true;
  updateStore.state.rollbackInfo = {
    rolledBack: true,
    currentVersion: "0.7.3",
    reason: "校验包失败：Unexpected token"
  };

  const host = harness.mountComponent(UpdateDialog, { t: harness.t });
  const title = nodes(host.tree, n => n.props?.id === "sm-update-dialog-title")[0];
  assert.equal(text(title), harness.t("update.rolledBack.title"));

  const dialogText = text(host.tree);
  assert.ok(dialogText.includes("0.7.3"), "Should mention restored version 0.7.3");
  assert.ok(dialogText.includes("校验包失败：Unexpected token"), "Should mention rollback reason");

  host.dispose();
  harness.dispose();
});

test("UpdateDialog: renders success notification with restart requirement", () => {
  const harness = mountClient();
  const { UpdateDialog, updateStore } = harness.exports;

  updateStore.state.status = "done";
  updateStore.state.application = "restart-required";
  updateStore.state.currentVersion = "0.7.3";
  updateStore.state.latestVersion = "0.7.4";
  updateStore.state.dialogOpen = true;

  const host = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(host.tree);
  assert.ok(dialogText.includes("重启 DSH"), "Should mention restart requirement");
  assert.ok(dialogText.includes("0.7.4"), "Should mention target version");

  host.dispose();
  harness.dispose();
});

test("updateStore.checkRecentStatus: retrieves and displays rolled-back task on startup", async () => {
  const harness = mountClient({
    fetchUpdateStatus: async () => ({
      ok: true,
      result: {
        taskId: "task-roll-123",
        status: "rolled-back",
        targetVersion: "0.7.4-test.1",
        currentVersion: "0.7.3",
        rolledBack: true,
        error: "pnpm fetch 404",
        failedAt: Date.now() - 5000
      }
    })
  });
  const { updateStore } = harness.exports;

  await updateStore.checkRecentStatus();

  assert.equal(updateStore.state.status, "error");
  assert.equal(updateStore.state.dialogOpen, true);
  assert.ok(updateStore.state.rollbackInfo);
  assert.equal(updateStore.state.rollbackInfo.currentVersion, "0.7.3");
  assert.ok(updateStore.state.rollbackInfo.reason.includes("pnpm fetch 404"));

  harness.dispose();
});

test("updateStore.checkRecentStatus: retrieves and displays completed task on startup", async () => {
  const harness = mountClient({
    fetchUpdateStatus: async () => ({
      ok: true,
      result: {
        taskId: "task-done-456",
        status: "completed",
        targetVersion: "0.7.4-test.4",
        currentVersion: "0.7.4-test.3",
        application: "applied",
        completedAt: Date.now() - 2000
      }
    })
  });
  const { UpdateDialog, updateStore } = harness.exports;

  await updateStore.checkRecentStatus();

  assert.equal(updateStore.state.status, "done");
  assert.equal(updateStore.state.dialogOpen, true);
  assert.equal(updateStore.state.currentVersion, "0.7.4-test.4");
  assert.equal(updateStore.state.latestVersion, "0.7.4-test.4");

  const host = harness.mountComponent(UpdateDialog, { t: harness.t });
  const title = nodes(host.tree, n => n.props?.id === "sm-update-dialog-title")[0];
  assert.equal(text(title), harness.t("update.done.title"));

  host.dispose();
  harness.dispose();
});

test("UpdateDialog & SettingsCard: closing dialog preserves installedVersion and shows pending restart in settings", () => {
  const harness = mountClient();
  const { SessionManagerSettingsCard, updateStore } = harness.exports;

  updateStore.state.currentVersion = "1.0.0";
  updateStore.state.runningVersion = "1.0.0";
  updateStore.state.installedVersion = "1.2.0";
  updateStore.state.latestVersion = "1.2.0";
  updateStore.state.status = "done";
  updateStore.state.application = "restart-required";
  updateStore.state.dialogOpen = true;

  updateStore.closeDialog();
  assert.equal(updateStore.state.dialogOpen, false);
  assert.equal(updateStore.state.installedVersion, "1.2.0");
  assert.equal(updateStore.state.currentVersion, "1.0.0");

  const host = harness.mountComponent(SessionManagerSettingsCard, { t: harness.t });
  const cardText = text(host.tree);
  assert.ok(cardText.includes(harness.t("update.runningVersion")), "Card must show running version label");
  assert.ok(cardText.includes("v1.0.0"), "Card must show current running v1.0.0");
  assert.ok(cardText.includes(harness.t("update.installedVersion")), "Card must show installed version label");
  assert.ok(cardText.includes("v1.2.0"), "Card must show installed v1.2.0");

  host.dispose();
  harness.dispose();
});

test("updateStore.checkRecentStatus: does not popup completed dialog if DSH restarted and already running targetVersion", async () => {
  const harness = mountClient({
    fetchUpdateStatus: async () => ({
      ok: true,
      result: {
        taskId: "task-restarted-789",
        status: "completed",
        targetVersion: "1.2.0",
        runningVersion: "1.2.0",
        currentVersion: "1.2.0",
        installedVersion: "1.2.0",
        application: "restart-required",
        completedAt: Date.now() - 60000
      }
    })
  });
  const { updateStore } = harness.exports;
  updateStore.state.currentVersion = "1.2.0";
  updateStore.state.runningVersion = "1.2.0";
  updateStore.state.dialogOpen = false;

  await updateStore.checkRecentStatus();

  assert.equal(updateStore.state.dialogOpen, false, "Dialog must not open when already running target version");
  assert.equal(harness.localStorage.getItem("dsh-sm-ack-task"), "task-restarted-789", "Task must be marked acknowledged");

  harness.dispose();
});

test("updateStore.startUpdate: concurrent update from Page B adopts active task from Page A and polls to completion", async () => {
  let serverActiveTask = null;
  let taskStatus = "installing";
  let pollCount = 0;

  // Shared server behavior for both clients
  const fetchUpdateInstall = async (body) => {
    if (serverActiveTask) {
      return {
        ok: false,
        code: "update-in-progress",
        error: "已有正在执行的更新任务 (" + serverActiveTask.taskId + ")，请勿重复操作",
        taskId: serverActiveTask.taskId
      };
    }
    serverActiveTask = {
      taskId: body.taskId || "task-A-shared",
      version: body.version || "2.0.0"
    };
    return {
      ok: true,
      result: {
        application: "restart-required",
        spec: "dsh-session-manager@" + serverActiveTask.version,
        version: serverActiveTask.version,
        taskId: serverActiveTask.taskId
      }
    };
  };

  const fetchUpdateStatus = async (options, url) => {
    pollCount++;
    assert.ok(url.includes(serverActiveTask.taskId), "Polling must query adopted taskId");
    if (taskStatus === "installing") {
      return {
        ok: true,
        result: {
          taskId: serverActiveTask.taskId,
          status: "installing",
          targetVersion: serverActiveTask.version,
          currentVersion: PLUGIN_VERSION
        }
      };
    }
    return {
      ok: true,
      result: {
        taskId: serverActiveTask.taskId,
        status: "completed",
        targetVersion: serverActiveTask.version,
        currentVersion: PLUGIN_VERSION,
        application: "restart-required"
      }
    };
  };

  const harnessA = mountClient({ fetchUpdateInstall, fetchUpdateStatus });
  const harnessB = mountClient({ fetchUpdateInstall, fetchUpdateStatus });

  const { updateStore: storeA, UpdateDialog: DialogA } = harnessA.exports;
  const { updateStore: storeB, UpdateDialog: DialogB } = harnessB.exports;

  storeA.state.status = "available";
  storeA.state.latestVersion = "2.0.0";
  storeB.state.status = "available";
  storeB.state.latestVersion = "2.0.0";

  // Page A initiates update
  const promiseA = storeA.startUpdate();

  // Page B initiates update concurrently
  const promiseB = storeB.startUpdate();

  // Task completes on server while Page B is polling
  taskStatus = "completed";

  await Promise.all([promiseA, promiseB]);

  // Both pages must show successful completion
  assert.equal(storeA.state.status, "done");
  assert.equal(storeA.state.installedVersion, "2.0.0");
  assert.equal(storeA.state.runningVersion, PLUGIN_VERSION);

  assert.equal(storeB.state.status, "done");
  assert.equal(storeB.state.installedVersion, "2.0.0");
  assert.equal(storeB.state.runningVersion, PLUGIN_VERSION);
  assert.equal(storeB.state.taskId, serverActiveTask.taskId, "Page B must have adopted Page A taskId");
  assert.ok(pollCount >= 1, "Page B must have executed status polling loop");

  // Verify UI in Page B renders restart message
  const hostB = harnessB.mountComponent(DialogB, { t: harnessB.t });
  const dialogTextB = text(hostB.tree);
  assert.ok(dialogTextB.includes("v" + PLUGIN_VERSION), "Page B must show running version");
  assert.ok(dialogTextB.includes("v2.0.0"), "Page B must show installed version");
  assert.ok(dialogTextB.includes(harnessB.t("update.done.restart", { from: PLUGIN_VERSION, to: "2.0.0" })), "Page B must show restart notice");

  hostB.dispose();
  harnessA.dispose();
  harnessB.dispose();
});

test("updateStore.startUpdate: Page B adopting active task correctly displays rollback when task fails", async () => {
  let serverActiveTask = { taskId: "task-A-rollback", version: "2.0.0" };

  const harness = mountClient({
    fetchUpdateInstall: async () => ({
      ok: false,
      code: "update-in-progress",
      error: "已有正在执行的更新任务",
      taskId: serverActiveTask.taskId
    }),
    fetchUpdateStatus: async () => ({
      ok: true,
      result: {
        taskId: serverActiveTask.taskId,
        status: "rolled-back",
        targetVersion: "2.0.0",
        currentVersion: "0.7.3",
        error: "安装包校验失败"
      }
    })
  });

  const { updateStore, UpdateDialog } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  const res = await updateStore.startUpdate();
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.equal(updateStore.state.status, "error");
  assert.equal(updateStore.state.rollbackInfo.rolledBack, true);
  assert.equal(updateStore.state.rollbackInfo.taskId, "task-A-rollback");

  const host = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(host.tree);
  assert.ok(dialogText.includes(harness.t("update.rolledBack.title")));

  host.dispose();
  harness.dispose();
});

test("updateStore.startUpdate: status polling recovers from transient network failure", async () => {
  let polls = 0;
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Failed to fetch"); // Triggers polling
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      polls++;
      if (polls === 1) {
        throw new Error("Network connection dropped"); // Transient status poll network error
      }
      return {
        ok: true,
        result: { status: "completed", targetVersion: "2.0.0", application: "restart-required" }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  await updateStore.startUpdate();

  assert.equal(updateStore.state.status, "done");
  assert.equal(updateStore.state.installedVersion, "2.0.0");
  assert.equal(polls, 2, "Must retry after transient network failure");

  harness.dispose();
});

test("updateStore.startUpdate: status polling recovers from transient HTTP 404 response", async () => {
  let polls = 0;
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Failed to fetch");
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      polls++;
      if (polls === 1) {
        return { ok: false, error: "Task not written yet 404" }; // Transient 404
      }
      return {
        ok: true,
        result: { status: "completed", targetVersion: "2.0.0", application: "restart-required" }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  await updateStore.startUpdate();

  assert.equal(updateStore.state.status, "done");
  assert.equal(updateStore.state.installedVersion, "2.0.0");
  assert.equal(polls, 2, "Must retry after transient 404 response");

  harness.dispose();
});

test("updateStore.startUpdate: business failure containing '404' immediately reports error and does not loop", async () => {
  let polls = 0;
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Connection reset");
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      polls++;
      return {
        ok: true,
        result: {
          status: "failed",
          error: "npm ERR! 404 Not Found - GET https://registry.npmjs.org/dsh-session-manager/-/dsh-session-manager-9.9.9.tgz"
        }
      };
    }
  });

  const { updateStore, UpdateDialog } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "9.9.9";

  const res = await updateStore.startUpdate();

  assert.equal(res.ok, false);
  assert.equal(updateStore.state.status, "error");
  assert.ok(updateStore.state.error.includes("404 Not Found"));
  assert.equal(polls, 1, "Must immediately report error without swallowing or looping");

  const host = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(host.tree);
  assert.ok(dialogText.includes("404 Not Found"));

  host.dispose();
  harness.dispose();
});

test("updateStore.startUpdate: business failure containing 'network' immediately reports error", async () => {
  let polls = 0;
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Connection reset");
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      polls++;
      return {
        ok: true,
        result: {
          status: "failed",
          error: "npm ERR! network socket timeout at tls.js"
        }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  const res = await updateStore.startUpdate();

  assert.equal(res.ok, false);
  assert.equal(updateStore.state.status, "error");
  assert.ok(updateStore.state.error.includes("network socket timeout"));
  assert.equal(polls, 1);

  harness.dispose();
});

test("updateStore.startUpdate: rollback containing 'fetch' immediately displays rollback result", async () => {
  let polls = 0;
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Connection reset");
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      polls++;
      return {
        ok: true,
        result: {
          status: "rolled-back",
          currentVersion: "0.7.3",
          targetVersion: "2.0.0",
          error: "npm ERR! fetch failed: https://registry.npmjs.org/package.tgz"
        }
      };
    }
  });

  const { updateStore, UpdateDialog } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  const res = await updateStore.startUpdate();

  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.equal(updateStore.state.status, "error");
  assert.equal(updateStore.state.rollbackInfo.rolledBack, true);
  assert.equal(updateStore.state.rollbackInfo.currentVersion, "0.7.3");
  assert.ok(updateStore.state.rollbackInfo.reason.includes("fetch failed"));
  assert.equal(polls, 1);

  const host = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(host.tree);
  assert.ok(dialogText.includes(harness.t("update.rolledBack.title")));

  host.dispose();
  harness.dispose();
});

test("updateStore.startUpdate: recovery-required displays failure and manual recovery hint", async () => {
  let polls = 0;
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Connection reset");
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      polls++;
      return {
        ok: true,
        result: {
          status: "recovery-required",
          error: "checksum mismatch 404",
          rollbackError: "EPERM file locked",
          currentVersion: "0.7.3"
        }
      };
    }
  });

  const { updateStore, UpdateDialog } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  const res = await updateStore.startUpdate();

  assert.equal(res.ok, false);
  assert.equal(updateStore.state.status, "error");
  assert.ok(updateStore.state.error.includes("自动恢复旧版本失败"));
  assert.ok(updateStore.state.error.includes("请手动重新安装"));
  assert.equal(polls, 1);

  const host = harness.mountComponent(UpdateDialog, { t: harness.t });
  const dialogText = text(host.tree);
  assert.ok(dialogText.includes("自动恢复旧版本失败"));

  host.dispose();
  harness.dispose();
});

test("updateStore.startUpdate: superseded task stops polling and does not report success", async () => {
  let polls = 0;
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Connection reset");
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      polls++;
      return {
        ok: true,
        result: {
          status: "superseded",
          taskId: "old-task"
        }
      };
    }
  });

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  const res = await updateStore.startUpdate();

  assert.equal(res.ok, false);
  assert.equal(updateStore.state.status, "error");
  assert.ok(updateStore.state.error.includes("已被其他操作覆盖"));
  assert.notEqual(updateStore.state.status, "done");
  assert.equal(polls, 1);

  harness.dispose();
});

test("updateStore.startUpdate: polling timeout reports unconfirmed status without assuming failure", async () => {
  const harness = mountClient({
    fetchUpdateInstall: async () => {
      throw new Error("Connection reset");
    },
    fetchUpdateStatus: async (options, url) => {
      if (!url.includes("taskId=")) return { ok: true, result: { status: "idle" } };
      // Status remains in-progress
      return {
        ok: true,
        result: {
          status: "installing",
          targetVersion: "2.0.0"
        }
      };
    }
  });

  // Fast timeout for testing
  harness.window.__DSH_SM_POLL_TIMEOUT_MS__ = 5;

  const { updateStore } = harness.exports;
  updateStore.state.status = "available";
  updateStore.state.latestVersion = "2.0.0";

  const res = await updateStore.startUpdate();

  assert.equal(res.ok, false);
  assert.equal(updateStore.state.status, "error");
  assert.ok(updateStore.state.error.includes("更新结果尚未确认"));
  assert.notEqual(updateStore.state.status, "done");

  harness.dispose();
});
