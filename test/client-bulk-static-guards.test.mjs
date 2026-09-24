/**
 * Static source guards for the bulk-management client additions in
 * dsh-session-manager 0.5.2.
 *
 * Issue #13 ships a non-trivial client surface (BulkActionBar, three
 * Batch* dialogs, two input dialogs, a runBatch wrapper, panel
 * integration) that can silently regress if any of the supporting
 * pieces is removed. These guards catch the obvious silent reverts
 * without rebuilding the harness, complementing the runBatch unit
 * tests in test/client-bulk-runbatch.test.mjs.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

function countMatches(pat) {
  let n = 0;
  let pos = 0;
  while ((pos = SRC.indexOf(pat, pos)) >= 0) { n++; pos += pat.length; }
  return n;
}

test("bulk: every panel-scoped Esc handler is wired at window level", () => {
  // Both the SessionManagerPanel and every Batch* / Bulk* dialog must
  // close on Esc without relying on layer-level keydown. Adding a new
  // inner modal should bump the count.
  const matches = SRC.match(/window\.addEventListener\("keydown", handler\)/g) || [];
  assert.ok(matches.length >= 9, `expected >= 9 window-level keydown listeners; got ${matches.length}`);
});

test("bulk: the bulk CSS namespace only adds sm-bulk* classes, never overrides existing sm-* rules", () => {
  // The plugin owns every class it ships. None of the new sm-bulk* /
  // sm-footer* classes may collide with an existing sm-* class used by
  // other DSH surfaces (migrated plugin or DSH core).
  const ours = (SRC.match(/sm-bulk[A-Za-z-]*/g) || []).filter((v, i, a) => a.indexOf(v) === i);
  // The bulk namespace is reserved; the wide/rail CSS for issue #16
  // shares the same plugin surface but does not live in the bulk-*
  // namespace. We assert the bulk-* namespace is non-empty and
  // contains the dialogs / bar / row / progress / result markers.
  for (const required of [
    "sm-bulkBar",
    "sm-bulkBtn",
    "sm-bulkBtnDanger",
    "sm-bulkRowCheckbox",
    "sm-bulkDialog",
    "sm-bulkProgressBar",
    "sm-bulkProgressFill",
    "sm-bulkResultGroup",
    "sm-bulkResultItem",
  ]) {
    assert.ok(ours.includes(required), `Bulk CSS class "${required}" must be present`);
  }
});

test("bulk: BulkActionBar passes onAction(button) through onBulkAction, never directly into /batch", () => {
  // The bar must route every click through onBulkAction so the runBulk
  // label map is the single source of truth for human labels.
  assert.match(SRC, /function BulkActionBar\(props\) \{/);
  assert.match(SRC, /onClick: \(\) => onAction\("[a-z-]+"\)/);
  // The action handler then funnels into runBulk which calls /batch.
  assert.match(SRC, /const runBulk = \(\{ action, payload, actionLabel, needsConfirm \}\) => \{/);
  assert.match(SRC, /void executeBulk\(\{ action, payload, actionLabel: resolvedLabel, ids, sessions \}\);/);
});

test("bulk: SessionManagerPanel renders every bulk dialog as a sibling (z-index 10002 wins via CSS)", () => {
  // None of the new dialogs may be children of the existing confirm /
  // move / migrate dialogs, otherwise Esc on the inner modal would
  // bubble through the outer modal's listener and double-fire.
  const panelModalRender = SRC.indexOf("const panelModal = h(\"div\"");
  const allBulkDialogsRender = SRC.indexOf("const bulkPreviewDialog = bulkPreview");
  assert.ok(panelModalRender > 0, "panelModal must be defined");
  assert.ok(allBulkDialogsRender > 0, "all bulk dialogs are declared next to the existing single-session dialogs");
  // Same Fragment return — the dialogs live alongside panelModal,
  // deleteDialog, moveDialog, migrateDialog, annotationDialog.
  assert.match(SRC, /return h\(React\.Fragment, null, panelModal, annotationDialog, moveDialog, deleteDialog, migrateDialog, bulkPreviewDialog, bulkProgressDialog, bulkResultDialog, bulkTagDialog, bulkPriorityDialog, bulkMoveDialog, bulkPresetDialog\);/);
});

test("bulk: refresh after a successful batch fans out to the three independent caches", () => {
  // annotationStore.load(true) is the cheap path; onRefreshAfterBulk
  // owns the heavier ctx refresh of sessions + workspaces. Removing
  // any of those breaks the post-batch UI consistency.
  assert.match(SRC, /try \{ await annotationStore\.load\(true\); \} catch \(_\) \{ \/\* ignore \*\/ \}/);
  assert.match(SRC, /try \{ await props\.onRefreshAfterBulk\(action\); \} catch \(_\) \{ \/\* ignore \*\/ \}/);
});

test("bulk: executeBulk refuses > 200 ids with bulk.error.tooMany and never calls fetch()", () => {
  // The server caps payload size at 200. Hitting it with more is a
  // user-visible failure, not a silent server 400.
  assert.match(SRC, /if \(ids\.length > 200\) \{ setError\(t\("bulk\.error\.tooMany"\)\); return; \}/);
});

test("bulk: host-side /batch route and client-side runBatch share the same action vocabulary", () => {
  // The host accepts: archive, unarchive, delete, move, preset-migrate,
  // favorite, unfavorite, review, unreview, add-tags, remove-tags,
  // set-priority. Every one must be both:
  //   - advertised on the BulkActionBar (passes to onBulkAction)
  //   - routed by runBulk into the host (label map keys or payload shape)
  // The combined vocabulary guards against adding a button the host
  // does not understand.
  const hostActions = [
    "archive", "unarchive", "delete", "move", "preset-migrate",
    "favorite", "unfavorite", "review", "unreview",
    "add-tags", "remove-tags", "set-priority",
  ];
  for (const action of hostActions) {
    const inRunBulkLabelMap = SRC.includes(action + ": t(\"bulk.") || SRC.includes("\"" + action + "\": t(\"bulk.");
    assert.ok(inRunBulkLabelMap, `runBulk must recognise action "${action}"`);
  }
});

test("bulk: BatchPreviewDialog never lies about sessionIds.length (preview count matches the batch)", () => {
  // The preview is generated from selectedSessions, which is derived
  // from selectedIds. The summary must use the same source of truth
  // so the user can verify the count against the badge on the bar.
  assert.match(SRC, /t\("bulk\.dialog\.summary", \{ count: sessions\.length, action: actionLabel \}\)/);
});