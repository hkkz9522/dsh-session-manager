import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const sessions = ["Alpha", "Beta", "Gamma", "Delta"].map((title, index) => ({
  id: title.toLowerCase(), displayTitle: title, updatedAt: 100 - index
}));

async function setup(t, options = {}) {
  const app = mountClient({ sessions, ...options });
  t.after(() => app.dispose());
  await app.flush();
  return app;
}

function component(app, name) {
  return app.find(node => node.type?.name === name)[0];
}

function checkedIds(app) {
  return app.find(row => row.props?.["data-session-id"])
    .filter(row => nodes(row, node => node.type === "input" && node.props.type === "checkbox" && node.props.checked).length)
    .map(row => row.props["data-session-id"]);
}

async function selectRow(app, title, shiftKey = false) {
  app.control("选择 " + title).props.onChange({ shiftKey });
  await app.flush();
}

async function clickBulkAction(app, label) {
  const bar = component(app, "BulkActionBar");
  assert.ok(bar, "batch toolbar is visible");
  const mounted = app.mountComponent(bar.type, bar.props);
  try {
    const button = mounted.find(node => node.type === "button" && text(node) === label);
    assert.ok(button && !button.props.disabled, label + " is available");
    button.props.onClick();
  } finally {
    mounted.dispose();
  }
  await app.flush();
}

function batchRequests(app) {
  return app.requests.filter(r => r.url === "/session-manager/api/batch").map(r => JSON.parse(r.options.body));
}

test("batch mode exposes an empty selection, clear keeps it open, and exit drops the selection", async t => {
  const app = await setup(t);
  const boxes = () => app.find(n => n.type === "input" && n.props.type === "checkbox");
  assert.equal(boxes().length, 0);
  assert.equal(component(app, "BulkActionBar"), undefined);
  await app.clickLabel("进入批量管理模式");
  assert.equal(boxes().length, sessions.length);
  assert.ok(component(app, "BulkActionBar"));
  assert.equal(app.control("清空选择").props.disabled, true);

  await selectRow(app, "Gamma");
  assert.deepEqual(checkedIds(app), ["gamma"]);
  await app.clickLabel("清空选择");
  assert.deepEqual(checkedIds(app), []);
  assert.equal(boxes().length, sessions.length);
  assert.ok(component(app, "BulkActionBar"));

  await selectRow(app, "Alpha");
  await app.clickLabel("退出批量管理模式");
  assert.equal(boxes().length, 0);
  assert.equal(component(app, "BulkActionBar"), undefined);
  await app.clickLabel("进入批量管理模式");
  assert.deepEqual(checkedIds(app), []);
});

test("Shift selection uses visible row order and toggles a fully selected range", async t => {
  const app = await setup(t);
  await app.clickLabel("进入批量管理模式");
  await selectRow(app, "Gamma");
  await selectRow(app, "Alpha", true);
  assert.deepEqual(checkedIds(app), ["alpha", "beta", "gamma"]);
  await selectRow(app, "Beta", true);
  assert.deepEqual(checkedIds(app), ["alpha"]);
  await selectRow(app, "Delta", true);
  assert.deepEqual(checkedIds(app), ["alpha", "gamma", "delta"]);
});

test("filtering the selected rows also narrows the IDs sent to the batch endpoint", async t => {
  const app = await setup(t);
  await app.clickLabel("全选筛选");
  await app.change("搜索标题、ID、标签或备注", "Beta");
  await app.change("搜索标题、ID、标签或备注", "");
  assert.deepEqual(checkedIds(app), ["beta"]);
  await clickBulkAction(app, "收藏");
  assert.deepEqual(batchRequests(app).map(r => [r.action, r.sessionIds]), [["favorite", ["beta"]]]);
});

test("select all accepts exactly 200 visible sessions and preserves the previous selection at 201", async t => {
  const many = Array.from({ length: 201 }, (_, i) => ({
    id: "id-" + i, displayTitle: i === 200 ? "extra" : "group " + i
  }));
  const app = await setup(t, { sessions: many });
  await app.clickLabel("进入批量管理模式");
  await selectRow(app, "extra");
  await app.clickLabel("全选筛选");
  assert.match(text(app.tree), /批量操作最多支持 200 项/);
  assert.deepEqual(checkedIds(app), ["id-200"]);
  await app.change("搜索标题、ID、标签或备注", "group");
  await app.clickLabel("全选筛选");
  await clickBulkAction(app, "收藏");
  const [request] = batchRequests(app);
  assert.deepEqual([...request.sessionIds].sort(), many.slice(0, 200).map(s => s.id).sort());
});

for (const [label, dialog, expectedActions] of [
  ["删除会话", "BatchPreviewDialog", []],
  ["添加标签", "BulkTagInputDialog", []],
  ["设置优先级", "BulkChoiceDialog", []],
  ["收藏", "BatchResultDialog", ["favorite"]]
]) {
  test(dialog + " defers a consumed Escape and closes before its parent panel", async t => {
    const app = await setup(t);
    await app.clickLabel("进入批量管理模式");
    await selectRow(app, "Alpha");
    await clickBulkAction(app, label);
    const node = component(app, dialog);
    assert.ok(node, dialog + " opens through the toolbar");
    const mounted = app.mountComponent(node.type, node.props);
    try {
      app.dispatchWindowEvent("keydown", { key: "Escape", defaultPrevented: true });
      await app.flush();
      assert.ok(component(app, dialog));
      const escape = app.dispatchWindowEvent("keydown", { key: "Escape" });
      assert.equal(escape.defaultPrevented, true);
      await app.flush();
      assert.equal(component(app, dialog), undefined);
      assert.equal(app.isOpen(), true);
    } finally {
      mounted.dispose();
    }
    app.dispatchWindowEvent("keydown", { key: "Escape" });
    await app.flush();
    assert.equal(app.isOpen(), false);
    assert.deepEqual(batchRequests(app).map(r => r.action), expectedActions);
  });
}

function mountPreview(app) {
  const preview = component(app, "BatchPreviewDialog");
  assert.ok(preview, "delete preview remains open");
  const mounted = app.mountComponent(preview.type, preview.props);
  const confirm = mounted.find(n => n.type === "button" && text(n) === "确认删除");
  assert.ok(confirm);
  return { mounted, confirm };
}

test("a failed delete preview blocks submission until a new preview succeeds", async t => {
  const first = Promise.withResolvers();
  let attempts = 0;
  const app = await setup(t, {
    fetchDeletePreview: () => ++attempts === 1 ? first.promise : { ok: true, result: { subagentCount: 2 } }
  });
  await app.clickLabel("进入批量管理模式");
  await selectRow(app, "Beta");
  await clickBulkAction(app, "删除会话");

  for (const state of ["loading", "failed"]) {
    if (state === "failed") {
      first.resolve({ ok: false, error: "preview temporarily unavailable" });
      await app.flush();
    }
    const { mounted, confirm } = mountPreview(app);
    try {
      assert.equal(confirm.props.disabled, true, state);
      if (state === "failed") assert.match(text(mounted.tree), /preview temporarily unavailable/);
      confirm.props.onClick();
      await app.flush();
      assert.deepEqual(batchRequests(app), []);
      if (state === "failed") app.dispatchWindowEvent("keydown", { key: "Escape" });
    } finally {
      mounted.dispose();
    }
  }
  await app.flush();
  assert.equal(component(app, "BatchPreviewDialog"), undefined);
  await clickBulkAction(app, "删除会话");
  const { mounted, confirm } = mountPreview(app);
  try {
    assert.equal(confirm.props.disabled, false);
    assert.match(text(mounted.tree), /将连带删除 2 个关联的子智能体会话/);
    confirm.props.onClick();
    await app.flush();
    assert.deepEqual(batchRequests(app).map(r => [r.action, r.sessionIds]), [["delete", ["beta"]]]);
  } finally {
    mounted.dispose();
  }
});

async function reopenDeletePreview(t, { sameSelection = false } = {}) {
  const requests = [];
  const app = await setup(t, {
    fetchDeletePreview(options) {
      const reply = Promise.withResolvers();
      const [ids] = JSON.parse(options.body).sessionIds;
      requests.push({ ids, reply });
      return reply.promise;
    }
  });
  await app.clickLabel("进入批量管理模式");
  await selectRow(app, "Alpha");
  await clickBulkAction(app, "删除会话");
  const original = mountPreview(app);
  try {
    app.dispatchWindowEvent("keydown", { key: "Escape" });
    await app.flush();
    assert.equal(component(app, "BatchPreviewDialog"), undefined);
  } finally {
    original.mounted.dispose();
  }

  if (!sameSelection) {
    await selectRow(app, "Alpha");
    await selectRow(app, "Beta");
  }
  await clickBulkAction(app, "删除会话");
  assert.deepEqual(requests.map(r => r.ids), ["alpha", sameSelection ? "alpha" : "beta"]);
  return { app, oldReply: requests[0].reply, currentReply: requests[1].reply };
}

test("a cancelled delete preview cannot unlock a later selection", async t => {
  const { app, oldReply, currentReply } = await reopenDeletePreview(t);
  oldReply.resolve({ ok: true, result: { subagentCount: 0 } });
  await app.flush();
  const waiting = mountPreview(app);
  try {
    assert.equal(waiting.confirm.props.disabled, true, "Beta must wait for its own preview");
  } finally {
    waiting.mounted.dispose();
  }
  currentReply.resolve({ ok: true, result: { subagentCount: 3 } });
  await app.flush();
  const ready = mountPreview(app);
  try {
    assert.equal(ready.confirm.props.disabled, false);
    assert.match(text(ready.mounted.tree), /将连带删除 3 个关联的子智能体会话/);
    assert.deepEqual(batchRequests(app), []);
  } finally {
    ready.mounted.dispose();
  }
});

for (const [outcome, settleOld] of [
  ["server error", reply => reply.resolve({ ok: false, error: "obsolete preview" })],
  ["network error", reply => reply.reject(new Error("obsolete preview"))]
]) {
  test("a stale " + outcome + " cannot overwrite a completed preview for the same IDs", async t => {
    const { app, oldReply, currentReply } = await reopenDeletePreview(t, { sameSelection: true });
    currentReply.resolve({ ok: true, result: { subagentCount: 2 } });
    await app.flush();
    settleOld(oldReply);
    await app.flush();
    const { mounted, confirm } = mountPreview(app);
    try {
      assert.equal(confirm.props.disabled, false);
      assert.match(text(mounted.tree), /将连带删除 2 个关联的子智能体会话/);
      confirm.props.onClick();
      await app.flush();
      assert.deepEqual(batchRequests(app).map(r => [r.action, r.sessionIds]), [["delete", ["alpha"]]]);
    } finally {
      mounted.dispose();
    }
  });
}

test("a stale success cannot clear the current delete preview error", async t => {
  const { app, oldReply, currentReply } = await reopenDeletePreview(t);
  currentReply.resolve({ ok: false, error: "current preview failed" });
  await app.flush();
  oldReply.resolve({ ok: true, result: { subagentCount: 0 } });
  await app.flush();
  const { mounted, confirm } = mountPreview(app);
  try {
    assert.equal(confirm.props.disabled, true);
    assert.match(text(mounted.tree), /current preview failed/);
    confirm.props.onClick();
    await app.flush();
    assert.deepEqual(batchRequests(app), []);
  } finally {
    mounted.dispose();
  }
});

test("retry previews and executes only failed deletes, keeping an unsuccessful current session open", async t => {
  const app = await setup(t, {
    current: "beta",
    fetchBatch: ({ sessionIds }) => ({
      ok: true, result: { items: sessionIds.map(sessionId => ({
        sessionId, status: sessionId === "beta" ? "failed" : "success"
      })) }
    })
  });
  await app.clickLabel("进入批量管理模式");
  await selectRow(app, "Alpha");
  await selectRow(app, "Beta");
  await clickBulkAction(app, "删除会话");
  const first = mountPreview(app);
  try { first.confirm.props.onClick(); } finally { first.mounted.dispose(); }
  await app.flush();
  assert.deepEqual(app.clearMainCalls, []);
  const result = component(app, "BatchResultDialog");
  const dialog = app.mountComponent(result.type, result.props);
  try {
    const retry = dialog.find(n => n.type === "button" && text(n) === app.t("bulk.result.retry"));
    retry.props.onClick();
  } finally { dialog.dispose(); }
  await app.flush();
  const previews = app.requests.filter(r => r.url.endsWith("/delete-preview"));
  assert.deepEqual(previews.map(r => JSON.parse(r.options.body).sessionIds), [["alpha", "beta"], ["beta"]]);
  const second = mountPreview(app);
  try { second.confirm.props.onClick(); } finally { second.mounted.dispose(); }
  await app.flush();
  assert.deepEqual(batchRequests(app).map(r => r.sessionIds), [["alpha", "beta"], ["beta"]]);
  assert.deepEqual(app.clearMainCalls, []);
});

test("an outstanding host batch shows a waiting status without offering cancellation", async t => {
  const reply = Promise.withResolvers();
  const app = await setup(t, { fetchBatch: () => reply.promise });
  await app.clickLabel("进入批量管理模式");
  await selectRow(app, "Alpha");
  await clickBulkAction(app, "收藏");
  const progress = component(app, "BatchProgressDialog");
  const mounted = app.mountComponent(progress.type, progress.props);
  try {
    assert.match(text(mounted.tree), /宿主正在处理 1 个会话/);
    assert.equal(mounted.findAll(n => n.type === "button").length, 0);
  } finally { mounted.dispose(); }
  reply.resolve({ ok: true, result: { items: [{ sessionId: "alpha", status: "success" }] } });
  await app.flush();
  assert.ok(component(app, "BatchResultDialog"));
});

test("bulk preset picker distinguishes loading, failed and empty results", async t => {
  const pending = Promise.withResolvers();
  let attempt = 0;
  const app = await setup(t, { fetchPresetScan: () => ++attempt === 1 ? pending.promise : { ok: true, result: { availablePresets: [] } } });
  await app.clickLabel("进入批量管理模式");
  await selectRow(app, "Alpha");
  const message = () => {
    const draft = component(app, "BulkChoiceDialog");
    const dialog = app.mountComponent(draft.type, draft.props);
    try { return text(dialog.tree); } finally { dialog.dispose(); }
  };
  await clickBulkAction(app, "迁移预设");
  assert.match(message(), /正在读取预设/);
  pending.resolve({ ok: false, error: "roster unavailable" });
  await app.flush();
  assert.match(message(), /roster unavailable/);
  component(app, "BulkChoiceDialog").props.onCancel();
  await app.flush();
  await clickBulkAction(app, "迁移预设");
  assert.match(message(), /没有可用的目标预设/);
});
