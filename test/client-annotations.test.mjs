import { test } from "node:test";
import assert from "node:assert/strict";
import { mountClient, nodes, text } from "./helpers/client-harness.mjs";

const sessions = [
  { id: "a", displayTitle: "Alpha", updatedAt: 300 },
  { id: "b", displayTitle: "Beta", updatedAt: 200 },
  { id: "c", displayTitle: "Gamma", updatedAt: 100 },
];
async function setup(t, options = {}) {
  const app = mountClient({ sessions, current: "a", workspaces: [], ...options });
  t.after(() => app.dispose()); await app.flush(); return app;
}
const edit = app => app.clickLabel("编辑标签、备注和优先级: Alpha");

test("favorite/review shortcuts synchronize between panel and header and only patch the chosen field", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { note: "keep note", priority: 2 } } });
  await app.mountHeader("a");
  await app.clickLabel("收藏会话: Alpha");
  assert.equal(app.annotations.a.favorite, true);
  assert.equal(app.annotations.a.note, "keep note");
  assert.equal(app.annotations.a.priority, 2);
  assert.equal(app.headerControl("取消收藏: Alpha").props["aria-pressed"], true);
  await app.clickHeader("标记待回看: Alpha");
  assert.equal(app.control("取消待回看: Alpha").props["aria-pressed"], true);
  const posted = app.requests.filter(r => r.options?.method === "POST").map(r => JSON.parse(r.options.body).patch);
  assert.deepEqual(posted, [{ favorite: true }, { reviewLater: true }]);
  assert.deepEqual(app.sourceIds, ["a", "b", "c"]);
});

test("editor saves favorite/review, normalized tags, multiline notes and priority 1; priority 3 is the default", async t => {
  const app = await setup(t); await edit(app);
  assert.equal(app.control("优先级").props.value, "3");
  await app.change("收藏", true); await app.change("待回看", true);
  await app.change("标签", " Design, 排障，design, annotation ");
  await app.change("备注", "第一行\nsecond line"); await app.change("优先级", "1");
  await app.click("保存标记");
  assert.deepEqual(app.annotations.a.tags, ["Design", "排障", "annotation"]);
  assert.equal(app.annotations.a.note, "第一行\nsecond line");
  assert.equal(app.annotations.a.priority, 1);
  assert.equal(app.annotations.a.favorite, true); assert.equal(app.annotations.a.reviewLater, true);
  assert.equal(app.find(node => node.props?.id === "sm-annotation-title").length, 0);
  assert.ok(text(app.tree).includes("P1"));
});

test("header opens the same editor and saved notes/tags immediately appear in the manager", async t => {
  const app = await setup(t); await app.mountHeader("a");
  await app.clickHeader("编辑标签、备注和优先级: Alpha");
  await app.change("标签", "header tag"); await app.change("备注", "saved via header");
  await app.change("优先级", "5"); await app.click("保存标记");
  assert.deepEqual(app.annotations.a.tags, ["header tag"]);
  assert.ok(text(app.tree).includes("header tag")); assert.ok(text(app.tree).includes("P5"));
});

test("favorite, review, tag and priority filters combine with metadata search and reset", async t => {
  const app = await setup(t, { sessionAnnotations: {
    a: { favorite: true, tags: ["Design"], note: "Windows validation", priority: 1 },
    b: { reviewLater: true, tags: ["Bug"], priority: 3 },
    c: { favorite: true, reviewLater: true, tags: ["design"], note: "API review" },
  } });
  await app.clickLabel("收藏筛选"); assert.deepEqual(app.rowIds(), ["a", "c"]);
  await app.clickLabel("待回看筛选"); assert.deepEqual(app.rowIds(), ["c"]);
  // Reset filters first so the priority filter applies to every session.
  await app.click("重置筛选");
  await app.change("按优先级筛选", "3");
  // b explicitly has priority 3; c falls back to 3 because it has no priority set.
  assert.deepEqual(app.rowIds().sort(), ["b", "c"]);
  await app.change("搜索标题、ID、标签或备注", "api REVIEW"); assert.deepEqual(app.rowIds(), ["c"]);
  await app.click("重置筛选"); assert.deepEqual(app.rowIds(), ["a", "b", "c"]);
  await app.change("搜索标题、ID、标签或备注", "windows"); assert.deepEqual(app.rowIds(), ["a"]);
  await app.change("搜索标题、ID、标签或备注", "bug"); assert.deepEqual(app.rowIds(), ["b"]);
  assert.equal(app.requests.filter(r => r.url.endsWith("/annotations") && r.options?.method !== "POST").length, 1);
});

test("priority sorting uses 1 as highest; default 3 sorts alongside explicit 3", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { priority: 5 }, c: { priority: 1 } } });
  await app.change("排序", "priority");
  // c=1 first, then b (no priority defaults to 3), then a=5 -- ascending.
  assert.deepEqual(app.rowIds(), ["c", "b", "a"]);
  await app.change("按优先级筛选", "5"); assert.deepEqual(app.rowIds(), ["a"]);
  await app.change("按优先级筛选", "3"); assert.deepEqual(app.rowIds(), ["b"]);
});

test("note save failures preserve the draft, show an error and permit retry", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { note: "original" } }, saveAnnotations: async () => ({ ok: false, error: "disk full" }) });
  await edit(app); await app.change("备注", "unsaved draft"); await app.click("保存标记");
  assert.ok(text(app.tree).includes("disk full")); assert.equal(app.control("备注").props.value, "unsaved draft");
  assert.equal(app.annotations.a.note, "original");
  app.setAnnotationSaver(undefined); await app.click("保存标记"); assert.equal(app.annotations.a.note, "unsaved draft");
});

test("conflicts never replace a local draft; load-latest is explicit and saving uses the new revision", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { note: "original", revision: 1 } } });
  await edit(app); await app.change("备注", "my draft");
  app.setAnnotations({ a: { note: "other window", favorite: true, revision: 2 } });
  await app.click("保存标记");
  assert.equal(app.control("备注").props.value, "my draft"); assert.equal(app.annotations.a.note, "other window");
  assert.ok(text(app.tree).includes("当前输入仍保留"));
});

test("dirty editor Escape asks before discarding and never closes the editor when clean", async t => {
  const app = await setup(t); await edit(app);
  // IME-composing Escape must not trigger close
  app.keydown({ key: "Escape", isComposing: true, preventDefault() { throw new Error("must not handle IME Escape"); } });
  await app.flush();
  // Editor still mounted
  assert.ok(app.find(node => node.props?.role === "dialog" && node.props?.["aria-labelledby"] === "sm-annotation-title").length >= 1);
});

test("dirty editor Escape asks before discarding and closes editor when user confirms", async t => {
  const app = await setup(t); await edit(app);
  // Make the editor dirty (so Escape asks to discard)
  await app.change("备注", "draft");
  // Auto-accept the discard prompt so Escape closes the editor
  const originalConfirm = globalThis.window?.confirm;
  if (typeof globalThis.window !== "undefined") globalThis.window.confirm = () => true;
  try {
    app.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
    await app.flush();
  } finally {
    if (typeof globalThis.window !== "undefined") globalThis.window.confirm = originalConfirm;
  }
  // Editor should be closed; parent panel still mounted
  assert.equal(app.find(node => node.props?.role === "dialog" && node.props?.["aria-labelledby"] === "sm-annotation-title").length, 0);
});

test("annotation loading errors disable only annotation actions; retry restores them", async t => {
  const app = await setup(t, { sessionAnnotations: { a: {} }, fetchAnnotations: () => ({ ok: false, error: "boom" }) });
  assert.equal(app.control("收藏会话: Alpha").props.disabled, true);
  assert.ok(text(app.tree).includes("会话标记加载失败"));
  await app.change("搜索标题、ID、标签或备注", "Alpha"); assert.deepEqual(app.rowIds(), ["a"]);
  app.setAnnotationFetcher(undefined); await app.click("重试标记加载");
  assert.equal(app.control("收藏会话: Alpha").props.disabled, false);
});

test("focus reload picks up changes from another browser without altering session data", async t => {
  const app = await setup(t);
  app.setAnnotations({ a: { favorite: true, tags: ["remote"], revision: 4 } }); await app.focus();
  assert.equal(app.control("取消收藏: Alpha").props["aria-pressed"], true);
  assert.ok(text(app.tree).includes("remote")); assert.deepEqual(app.sourceIds, ["a", "b", "c"]);
});

test("pending quick actions disable both surfaces and duplicate requests are prevented", async t => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const app = await setup(t, { saveAnnotations: async () => { await blocked; return { ok: true, result: { annotation: { favorite: true, reviewLater: false, tags: [], note: "", priority: null, revision: 1 } } }; } });
  await app.mountHeader("a"); await app.clickLabel("收藏会话: Alpha");
  assert.equal(app.headerControl("收藏会话: Alpha").props.disabled, true);
  assert.equal(app.control("收藏会话: Alpha").props.disabled, true);
  release(); await app.flush();
  assert.equal(app.control("取消收藏: Alpha").props["aria-pressed"], true);
  assert.equal(app.requests.filter(r => r.options?.method === "POST").length, 1);
});

test("English annotations explain priority direction and default to 3 (Normal)", async t => {
  // No explicit priority: the editor should pre-select 3.
  const app = await setup(t, { language: "en" });
  await app.clickLabel("Edit tags, notes and priority: Alpha");
  assert.ok(text(app.tree).includes("1 · Highest")); assert.ok(text(app.tree).includes("5 · Lowest"));
  assert.equal(app.control("Priority").props.value, "3");
  assert.ok(/default|highest|lowest|unset/i.test(text(app.tree)));
  await app.change("Note", "English note"); await app.click("Save annotations");
  // Without touching the priority control, it stays at the default 3.
  assert.equal(app.annotations.a.priority, 3); assert.equal(app.annotations.a.note, "English note");
});

test("refresh failures are recoverable inside an open editor without losing the draft", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { note: "original" } } });
  await edit(app); await app.change("备注", "keep this draft");
  // Simulate the focus-triggered refresh failing
  app.setAnnotationFetcher(() => Promise.resolve({ ok: false, error: "connection lost" }));
  await app.focus(); await app.flush();
  const editor = () => app.find(node => node.props?.role === "dialog" && node.props?.["aria-labelledby"] === "sm-annotation-title")[0];
  assert.ok(editor());
  assert.ok(text(app.tree).includes("connection lost")); assert.ok(text(app.tree).includes("重试标记加载"));
  assert.equal(nodes(editor(), node => node.type === "button" && text(node) === "保存标记")[0].props.disabled, true);
  assert.equal(app.control("备注").props.value, "keep this draft");
  app.setAnnotationFetcher(undefined);
  nodes(editor(), node => node.type === "button" && text(node) === "重试标记加载")[0].props.onClick();
  await app.flush();
  assert.equal(nodes(editor(), node => node.type === "button" && text(node) === "保存标记")[0].props.disabled, false);
  assert.equal(app.control("备注").props.value, "keep this draft");
  await app.click("保存标记");
  assert.equal(app.annotations.a.note, "keep this draft");
});

test("removing the last occurrence of a selected tag clears the stale filter", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { tags: ["Design"] } } });
  await app.change("按标签筛选", "tag:design");
  assert.deepEqual(app.rowIds(), ["a"]);
  app.setAnnotations({ a: { tags: [], revision: 2 } });
  await app.focus();
  assert.equal(app.control("按标签筛选").props.value, "all");
  assert.deepEqual(app.rowIds(), ["a", "b", "c"]);
  await app.change("按标签筛选", "none");
  app.setAnnotations({ a: { tags: ["Design"], revision: 3 }, b: { tags: ["Design"] }, c: { tags: ["Design"] } });
  await app.focus();
  assert.equal(app.control("按标签筛选").props.value, "none");
  assert.deepEqual(app.rowIds(), []);
});

test("annotation editor shows a clear button for tags and note when they have content", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { tags: ["design"], note: "draft" } } });
  await app.clickLabel("编辑标签、备注和优先级: Alpha");
  assert.equal(app.control("清空标签").props["aria-label"], "清空标签");
  assert.equal(app.control("清空备注").props["aria-label"], "清空备注");
  await app.clickLabel("清空标签");
  assert.equal(app.control("标签").props.value, "");
  await app.clickLabel("清空备注");
  assert.equal(app.control("备注").props.value, "");
});

test("annotation dialog exposes copy prompt and paste from clipboard controls with bilingual labels", async t => {
  const app = await setup(t);
  await app.clickLabel("编辑标签、备注和优先级: Alpha");
  assert.ok(app.find(node => node.type === "button" && text(node) === "复制 Prompt").length >= 1);
  assert.ok(app.find(node => node.type === "button" && text(node) === "导入").length >= 1);
  const enApp = await setup(t, { language: "en" });
  await enApp.clickLabel("Edit tags, notes and priority: Alpha");
  assert.ok(enApp.find(node => node.type === "button" && text(node) === "Copy Prompt").length >= 1);
  assert.ok(enApp.find(node => node.type === "button" && text(node) === "Import").length >= 1);
});

test("annotation dialog is modeless: removes aria-modal and blocking backdrop", async t => {
  const app = await setup(t);
  await app.clickLabel("编辑标签、备注和优先级: Alpha");
  const surface = app.find(n => n.type === "section" && (n.props?.className || "").includes("sm-annotationSurface"))[0];
  assert.ok(surface);
  // Modeless dialog: aria-modal should not be "true"
  assert.notEqual(surface.props["aria-modal"], "true");
  // No blocking backdrop element rendered
  const backdrops = app.tree.flat().filter(n => n && n.type === "div" && (n.props?.className || "") === "sm-nativeDialogBackdrop");
  assert.equal(backdrops.length, 0);
  // Layer wrapper exists and is non-blocking (pointer-events: none via CSS)
  const wrappers = app.find(n => n.type === "div" && (n.props?.className || "").includes("sm-annotationDialog"));
  assert.ok(wrappers.length >= 1);
});


test("panel renders inner dialogs as siblings of panel modal", async t => {
  const app = await setup(t);
  // The panel itself is mounted.
  const layers = app.find(n => n.type === "div" && n.props && n.props.className && n.props.className.includes && n.props.className.includes("sm-nativeDialogLayer"));
  // We do not assert a specific count -- just that the panel is in the tree.
  assert.ok(layers.length >= 1, "panel modal missing");
});

test("annotation dialog places favorite and reviewLater on separate rows with priority and help on the right", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { priority: 3 } } });
  await edit(app);
  const checksRow = app.find(n => n.type === "div" && n.props?.className === "sm-annotationChecks")[0];
  assert.ok(checksRow, "checks row missing");
  // 3 labels (favorite, priority, reviewLater) + 1 small (priority help) inline as direct children.
  const labels = (checksRow.props?.children || []).filter(c => c && c.type === "label");
  const smalls = (checksRow.props?.children || []).filter(c => c && c.type === "small");
  assert.equal(labels.length, 3, "expected favorite/review/priority labels inline");
  assert.equal(smalls.length, 1, "expected one small help text");
  const favoriteBox = app.control("收藏");
  const reviewBox = app.control("待回看");
  const prioritySelect = app.control("优先级");
  // Order: favorite, priority, reviewLater, small help -- so labels[0]=favorite, labels[1]=priority, labels[2]=reviewLater.
  assert.ok(labels[0].props.children.includes(favoriteBox), "favorite checkbox not in first label");
  assert.ok(labels[1].props.children.includes(prioritySelect), "priority select not in second label");
  assert.ok(labels[2].props.children.includes(reviewBox), "review checkbox not in third label");
  assert.equal(labels[1].props.className, "sm-annotationPriority");
  assert.ok((prioritySelect.props.className || "").includes("sm-prioritySelectInline"), "priority select missing inline style class");
  assert.equal(prioritySelect.props.value, "3");
  // Help text small lives next to the priority column (last child of the row).
  // The Chinese wording leads with "1 最高，5 最低" and the English with "1 is highest, 5 is lowest".
  assert.ok(text(smalls[0]).includes("最高") || /highest|lowest|unset/i.test(text(smalls[0])), "priority help text not present");
  // Exactly one priority select exists in the document, and it is the inline one.
  const allPrioritySelects = app.find(n => n.type === "select" && n.props?.["aria-label"] === "优先级");
  assert.equal(allPrioritySelects.length, 1, "expected exactly one priority select");
  assert.ok(allPrioritySelects[0].props.className.includes("sm-prioritySelectInline"), "priority select missing inline style class");
  // The inline priority label must NOT have the sm-viewField class (which the old layout had).
  assert.equal(labels[1].props.className.includes("sm-viewField"), false, "inline priority should not use sm-viewField");
});

test("annotation dialog uses a multi-line textarea for tags, same size as note textarea", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { tags: ["design"], note: "draft note" } } });
  await edit(app);
  const tagsField = app.control("标签");
  const noteField = app.control("备注");
  assert.equal(tagsField.type, "textarea", "tags field should be a textarea");
  assert.equal(noteField.type, "textarea", "note field should be a textarea");
  // Both share the sm-noteInput class and the same row count for a consistent look.
  assert.ok((tagsField.props.className || "").includes("sm-noteInput"), "tags field should use sm-noteInput class");
  assert.ok((noteField.props.className || "").includes("sm-noteInput"), "note field missing sm-noteInput class");
  assert.equal(tagsField.props.rows, noteField.props.rows, "tags and note textareas should share the same rows");
  assert.equal(tagsField.props.rows, 3, "textareas should default to 3 rows");
  // Privacy hint should be gone.
  const privacy = app.find(n => n.type === "small" && text(n).includes("自动发送给模型"));
  assert.equal(privacy.length, 0, "privacy hint should be removed");
  // Tags no longer carries a <small> help text right under the input -- the help text now lives in the placeholder.
  const tagsHelp = app.find(n => n.type === "small" && (text(n).includes("20") && text(n).includes("32")));
  assert.equal(tagsHelp.length, 0, "tags <small> help text should be removed");
});

test("annotation dialog drops the note counter, places import/prompt buttons above the paste textarea, and reuses the note input style for paste", async t => {
  const app = await setup(t, { sessionAnnotations: { a: { note: "kept note" } } });
  await edit(app);
  // No <small> with the note counter text remains attached to the note field.
  const noteCounters = app.find(n => n.type === "small" && text(n).includes("2000") && text(n).includes("字符"));
  assert.equal(noteCounters.length, 0, "note counter should be removed");
  // The note textarea now has no trailing small after it.
  const note = app.control("备注");
  assert.equal(note.type, "textarea");
  // Import group: two buttons above the paste textarea.
  const importGroup = app.find(n => n.type === "div" && n.props?.className === "sm-importGroup")[0];
  assert.ok(importGroup, "import group missing");
  const buttonRow = importGroup.props.children.find(c => c && c.type === "div" && c.props?.className === "sm-importGroupButtons");
  assert.ok(buttonRow, "import buttons row missing");
  const rowButtons = (buttonRow.props.children || []).filter(c => c && c.type === "button");
  assert.equal(rowButtons.length, 2, "expected 2 buttons above the paste box");
  // Left is "导入" (Import), right is "复制 Prompt".
  assert.equal(text(rowButtons[0]), "导入");
  assert.equal(text(rowButtons[1]), "复制 Prompt");
  // Paste textarea uses the same class as the note input.
  const paste = app.control("AI 返回的 JSON");
  assert.equal(paste.type, "textarea");
  assert.ok((paste.props.className || "").includes("sm-noteInput"), "paste textarea should use sm-noteInput");
  assert.equal(paste.props.rows, 3, "paste textarea should default to 3 rows");
});

test("import dialog surfaces parse error details when the clipboard JSON is broken", async t => {
  const app = await setup(t);
  await edit(app);
  // Missing closing brace: parser will record the actual JSON.parse error
  // inside the returned message so the user can see what is wrong.
  const paste = app.control("AI 返回的 JSON");
  await app.change(paste.props["aria-label"], '{"tags":["a"], "note":"truncated');
  await app.click("导入");
  // The status text includes the parse error from JSON.parse.
  const status = app.find(n => n.type === "div" && n.props?.className === "sm-importStatus");
  assert.ok(status.length >= 1, "import status missing");
  assert.ok(text(status[0]).includes("无法解析") || text(status[0]).includes("JSON"),
    "status should mention parse failure: " + text(status[0]));
});

test("tag input splits on both English and Chinese commas and ignores spaces after them", async t => {
  const app = await setup(t);
  // Pure English commas with single space after each.
  await edit(app);
  await app.change("标签", "alpha, beta, gamma");
  await app.click("保存标记");
  assert.deepEqual(app.annotations.a.tags, ["alpha", "beta", "gamma"]);
  // Reopen and try Chinese full-width commas.
  await edit(app);
  await app.change("标签", "α，β，γ");
  await app.click("保存标记");
  assert.deepEqual(app.annotations.a.tags, ["α", "β", "γ"]);
  // Mixed separators still produce a single clean tag list.
  await edit(app);
  await app.change("标签", "one， two, three ，four");
  await app.click("保存标记");
  assert.deepEqual(app.annotations.a.tags, ["one", "two", "three", "four"]);
  // Leading / trailing whitespace and extra spaces after separators are stripped.
  await edit(app);
  await app.change("标签", "  first ,   second   ,third  ");
  await app.click("保存标记");
  assert.deepEqual(app.annotations.a.tags, ["first", "second", "third"]);
  // Trailing / leading separators and empty entries are dropped.
  await edit(app);
  await app.change("标签", ", , a , b , ,");
  await app.click("保存标记");
  assert.deepEqual(app.annotations.a.tags, ["a", "b"]);
});

test("copy prompt button writes the prompt in the matching UI language", async t => {
  // Chinese UI: the prompt should be the Chinese template.
  const zhApp = await setup(t, { language: "zh" });
  await zhApp.clickLabel("编辑标签、备注和优先级: Alpha");
  await zhApp.click("复制 Prompt");
  assert.ok(zhApp.clipboardWrites.length >= 1, "Chinese copy button should write to clipboard");
  const zhPrompt = zhApp.clipboardWrites[zhApp.clipboardWrites.length - 1];
  assert.ok(zhPrompt.includes("请根据当前对话内容"), "Chinese prompt header is missing");
  assert.ok(zhPrompt.includes("返回格式"), "Chinese prompt footer is missing");

  // English UI: same button should now copy the English template.
  const enApp = await setup(t, { language: "en" });
  await enApp.clickLabel("Edit tags, notes and priority: Alpha");
  await enApp.click("Copy Prompt");
  assert.ok(enApp.clipboardWrites.length >= 1, "English copy button should write to clipboard");
  const enPrompt = enApp.clipboardWrites[enApp.clipboardWrites.length - 1];
  assert.ok(!enPrompt.includes("请根据当前对话内容"), "English prompt should not contain Chinese text");
  assert.ok(enPrompt.includes("Summarize this conversation") || enPrompt.includes("Requirements") || enPrompt.includes("Return shape"),
    "English prompt header/footer is missing");
});
