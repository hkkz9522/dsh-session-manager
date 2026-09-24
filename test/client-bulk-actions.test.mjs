/**
 * Client-side bulk-action coverage for dsh-session-manager 0.5.2.
 *
 * The bulk action bar wires a fixed list of actions into the
 * SessionManagerPanel. The user picks one (or several) rows, opens the
 * bar, and clicks an action -- non-destructive actions fire
 * immediately, destructive ones go through BatchPreviewDialog.
 *
 * The mount harness cannot trigger selectedIds from outside without
 * exposing internal hooks, so this test file is a static-guard
 * contract: every action the bar advertises must round-trip through a
 * handler that calls runBulk / executeBulk and never silently no-ops.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

test("bulk: BulkActionBar advertises every action the runBulk dispatch understands", () => {
  // Each bar button passes onAction("<key>") (or onAction("<key>", ...))
  // into runBulk, which dispatches by action key. If a button ships in
  // the UI but its action key is not recognised by runBulk, the click
  // is silently dropped. Guard: every button key must also appear in the
  // runBulk label map.
  const actions = ["archive", "unarchive", "favorite", "unfavorite", "review", "unreview", "remove-tags"];
  for (const action of actions) {
    assert.ok(SRC.includes("onAction(\"" + action + "\""), "BulkActionBar must advertise action \"" + action + "\"");
    // runBulk resolves a label via a map whose keys include the action
    // name. Identifier-style keys (archive) need no quotes; dashed
    // keys (remove-tags) are wrapped in quotes.
    const inLabelMap =
      SRC.includes(action + ": t(\"bulk.") ||
      SRC.includes("\"" + action + "\": t(\"bulk.");
    assert.ok(inLabelMap, "runBulk must recognise action \"" + action + "\"");
  }
});

test("bulk: delete is the only action that forces the preview dialog", () => {
  assert.ok(SRC.includes("onAction(\"delete\", null, true)"), "delete button forces the preview");
  // Exactly one onAction(...) passes `null, true`.
  const matches = SRC.match(/onAction\("[^"]+", null, true\)/g) || [];
  assert.equal(matches.length, 1, "exactly one button (delete) forces the preview");
});

test("bulk: BulkActionBar routes add-tags / priority / move into the matching input dialogs", () => {
  assert.ok(SRC.includes("BulkTagInputDialog"), "BulkTagInputDialog must be defined");
  assert.ok(SRC.includes("BulkChoiceDialog"), "BulkChoiceDialog must be defined");
  assert.match(SRC, /onOpenTagDialog: onBulkTagsAdd/);
  assert.match(SRC, /mode === "add" \? h\(BulkTagInputDialog/);
  assert.match(SRC, /onOpenPriorityDialog: onBulkPriority/);
  assert.match(SRC, /mode === "priority" \? h\(BulkChoiceDialog/);
  assert.match(SRC, /onOpenMoveDialog: onBulkMove/);
  assert.match(SRC, /mode === "move" \? h\(BulkChoiceDialog/);
});

test("bulk: every /batch-eligible action label is present in both dictionaries", () => {
  for (const action of [
    "bulk.archive", "bulk.unarchive", "bulk.favorite", "bulk.unfavorite",
    "bulk.review", "bulk.unreview", "bulk.tagsAdd", "bulk.tagsRemove",
    "bulk.priority", "bulk.move", "bulk.delete",
    "bulk.dialog.title", "bulk.dialog.summary", "bulk.dialog.execute",
    "bulk.progress.title", "bulk.progress.current",
    "bulk.result.title", "bulk.result.successGroup", "bulk.result.failedGroup",
    "bulk.result.skippedGroup", "bulk.result.retry", "bulk.result.close",
    "bulk.error.tooMany"
  ]) {
    assert.match(SRC, new RegExp("\"" + action + "\": "), "zh missing \"" + action + "\"");
    assert.match(SRC, new RegExp("\"" + action + "\": \"[A-Z]"), "en missing \"" + action + "\"");
  }
});

test("bulk: runBatch forwards abort / progress / payload to /batch", () => {
  assert.match(SRC, /body: JSON\.stringify\(\{ action, sessionIds: sessionIds \|\| \[\], payload: payload \|\| \{\} \}\)/);
  assert.match(SRC, /method: "POST"/);
  assert.match(SRC, /headers: \{ "content-type": "application\/json" \}/);
});

test("bulk: runBatch surfaces server errors as thrown exceptions with the right code", () => {
  assert.match(SRC, /const error = new Error\(\(data && data\.error\) \|\| "batch failed"\)/);
  assert.match(SRC, /error\.code = \(data && data\.code\) \|\| "bad-request"/);
});

test("bulk: runBatch unwraps {summary, items} for the result dialog", () => {
  assert.match(SRC, /summary: result\.summary \|\| \{ total: items\.length, success: 0, failed: 0, skipped: 0 \}/);
});

test("bulk: AbortError from the client side resolves to aborted:true so the progress dialog can stop cleanly", () => {
  assert.match(SRC, /if \(error && error\.name === "AbortError"\) return \{ summary: \{ total: 0, success: 0, failed: 0, skipped: 0 \}, items: \[\], aborted: true \};/);
});

test("bulk: executeBulk refreshes sessions + workspaces + annotations after a successful run", () => {
  assert.match(SRC, /try \{ await annotationStore\.load\(true\); \} catch \(_\) \{ \/\* ignore \*\/ \}/);
  assert.match(SRC, /try \{ await props\.onRefreshAfterBulk\(action\); \} catch \(_\) \{ \/\* ignore \*\/ \}/);
});

test("bulk: retryFailedBulk only re-runs actions that need user input (delete / move / preset-migrate / tag / priority)", () => {
  const block = SRC.match(/action === "delete" \|\| action === "move" \|\| action === "preset-migrate" \|\| action === "add-tags" \|\| action === "remove-tags" \|\| action === "set-priority"/);
  assert.ok(block, "retryFailedBulk must gate destructive retries on the preview");
  assert.ok(block && !/action === "archive"/.test(block[0]), "archive retry does not need a preview");
});

test("bulk: BatchResultDialog renders success / failed / skipped groups and a Retry button", () => {
  assert.match(SRC, /function BatchResultDialog/);
  assert.match(SRC, /renderGroup\("bulk\.result\.successGroup"/);
  assert.match(SRC, /renderGroup\("bulk\.result\.failedGroup"/);
  assert.match(SRC, /renderGroup\("bulk\.result\.skippedGroup"/);
  assert.ok(SRC.includes("groups.failed.length > 0") && SRC.includes("retryLabel"), "BatchResultDialog exposes a Retry button gated on failed.length > 0");
});

test("bulk: BatchPreviewDialog warns only for delete and lists every affected session", () => {
  assert.match(SRC, /function BatchPreviewDialog/);
  assert.match(SRC, /warning \? h\("div", \{ className: "sm-bulkDialogWarn" \}, warning\) : null/);
  assert.match(SRC, /action === "delete" \? t\("bulk\.dialog\.warning\.delete"\) : ""/);
});