/**
 * Static source guards for the issue #17 client-side fixes.
 *
 * Three regressions that previously shipped silently and only surfaced at
 * runtime:
 *
 *   17.2  The in-panel "move to workspace" dialog was rendered without
 *         forwarding the locale function, so MoveDialog fell back to its
 *         identity `t` and rendered raw keys like `confirm.move.select` in
 *         place of translated text. Mirror the title-bar entry: pass `t`.
 *   17.4  The row "Open" button called `onOpen` even on archived sessions.
 *         DSH refuses to surface an archived session as the current view,
 *         so the chat panel flashes and bounces back to "no session".
 *         The row must unarchive first when `isArchived` is true.
 *
 * These guards re-read the source on every test invocation so they catch
 * silent reverts without rebuilding the harness.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/** Extract the body of the first SessionManagerPanel moveDialog JSX call. */
function panelMoveDialogBlock() {
  const anchor = "      const moveDialog = moveFor === null ? null : h(MoveDialog, {";
  const start = SRC.indexOf(anchor);
  if (start < 0) throw new Error("panel moveDialog anchor not found in lib/client.js");
  // Walk to the matching closing `});` of the JSX object literal. The block
  // ends with `onConfirm:` followed by a nested arrow body; the simplest
  // robust slice is from the anchor up to the panel moveDialog section
  // terminator, which is the `});` that closes the JSX call. We rely on the
  // next `\n      });\n` after the anchor (the canonical closing pattern in
  // this codebase).
  const closeMarker = "\r\n      });\r\n      const migrateDialog";
  const end = SRC.indexOf(closeMarker, start);
  if (end < 0) throw new Error("panel moveDialog close marker not found");
  return SRC.slice(start, end);
}

test("issue #17.2: panel MoveDialog forwards the locale function (issue #17.2)", () => {
  const block = panelMoveDialogBlock();
  assert.match(block, /\bt:\s*t\b/, "panel MoveDialog must pass `t: t` so inner labels render translated");
});

test("issue #17.2: panel MoveDialog description uses the raw session id (matches title-bar entry)", () => {
  const block = panelMoveDialogBlock();
  // Mirrors the title-bar entry: `setMoveFor({ id: sessionId, displayTitle: sessionId })`,
  // so both move entry points render `confirm.move.desc` with the same id.
  assert.match(
    block,
    /description:\s*t\("confirm\.move\.desc",\s*\{\s*title:\s*moveFor\.id\s*\}\)/,
    "panel MoveDialog description must use moveFor.id (matches title-bar)"
  );
  assert.doesNotMatch(
    block,
    /description:\s*t\("confirm\.move\.desc",\s*\{\s*title:\s*moveFor\.displayTitle/,
    "panel MoveDialog description must not fall back to friendly displayTitle"
  );
});

test("issue #17.4: row Open button unarchives archived sessions before opening (issue #17.4)", () => {
  // The row Open handler is the only call to onOpen(s.id) on the row button;
  // we assert it now guards with `isArchived` + `onUnarchive`.
  const rowOpenAnchor = 'h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick:';
  let pos = 0;
  const rowOpenHandlers = [];
  while (true) {
    const next = SRC.indexOf(rowOpenAnchor, pos);
    if (next < 0) break;
    // Capture the next onClick body, up to the closing `}, t(...))` tail.
    const tail = SRC.indexOf("t(\"row.open\")", next);
    if (tail < 0) break;
    const end = SRC.indexOf(")", tail) + 1;
    rowOpenHandlers.push(SRC.slice(next, end));
    pos = end;
  }
  assert.ok(rowOpenHandlers.length > 0, "expected at least one rowBtn onClick handler");
  const openHandler = rowOpenHandlers.find((s) => s.includes("onOpen(s.id)"));
  assert.ok(openHandler, "expected a row Open handler that calls onOpen(s.id)");
  assert.match(
    openHandler,
    /if\s*\(\s*isArchived\s*\)/,
    "row Open handler must guard with isArchived (issue #17.4)"
  );
  assert.match(
    openHandler,
    /onUnarchive\(s\.id\)/,
    "row Open handler must call onUnarchive(s.id) before onOpen(s.id) for archived rows"
  );
});
