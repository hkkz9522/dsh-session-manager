/**
 * Static source guards for the issue #17 client-side fixes plus the
 * follow-up "display-name only" rule:
 *
 *   17.2        The in-panel "move to workspace" dialog was rendered without
 *               forwarding the locale function, so MoveDialog fell back to its
 *               identity `t` and rendered raw keys like `confirm.move.select`
 *               in place of translated text. Mirror the title-bar entry: pass `t`.
 *   17.4        The row "Open" button called `onOpen` even on archived sessions.
 *               DSH refuses to surface an archived session as the current view,
 *               so the chat panel flashes and bounces back to "no session".
 *               The row must unarchive first when `isArchived` is true.
 *   name-only   After 0.5.3 round 2: every dialog that names a session
 *               (`confirm.move.desc`, `confirm.delete.desc`) must use the
 *               friendly displayTitle only, never the raw id. When the real
 *               name is unknown the description collapses to an empty string
 *               instead of leaking the id into the dialog body.
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
  const closeMarker = "\r\n      });\r\n      const migrateDialog";
  const end = SRC.indexOf(closeMarker, start);
  if (end < 0) throw new Error("panel moveDialog close marker not found");
  return SRC.slice(start, end);
}

/** Extract the title-bar (HeaderAction) moveDialog block. */
function titleBarMoveDialogBlock() {
  const anchor = "        moveFor === null ? null : h(MoveDialog, {";
  const start = SRC.indexOf(anchor);
  if (start < 0) throw new Error("title-bar moveDialog anchor not found");
  // The title-bar JSX closes with `);` then the HeaderAction function closes with `}`.
  const closeMarker = "      );\r\n    }\r\n\r\n    class SafePanel";
  const end = SRC.indexOf(closeMarker, start);
  if (end < 0) throw new Error("title-bar moveDialog close marker not found");
  return SRC.slice(start, end);
}

test("issue #17.2: panel MoveDialog forwards the locale function (issue #17.2)", () => {
  const block = panelMoveDialogBlock();
  assert.match(block, /\bt:\s*t\b/, "panel MoveDialog must pass `t: t` so inner labels render translated");
});

test("issue #17.2 + display-name-only: panel MoveDialog description uses displayTitle only, never raw id", () => {
  const block = panelMoveDialogBlock();
  assert.match(
    block,
    /description:\s*\(\s*moveFor\.displayTitle\s*&&\s*t\("confirm\.move\.desc",\s*\{\s*title:\s*moveFor\.displayTitle\s*\}\)\s*\)\s*\|\|\s*""/,
    "panel MoveDialog description must guard on displayTitle and pass it to the template"
  );
  assert.doesNotMatch(
    block,
    /description:[^,}\n]*moveFor\.id[^,}\n]*\}/,
    "panel MoveDialog description must not embed moveFor.id anywhere"
  );
});

test("issue #17.2 + display-name-only: title-bar MoveDialog description uses displayTitle only, never raw id", () => {
  const block = titleBarMoveDialogBlock();
  // Title-bar pattern: `description: (moveFor && moveFor.displayTitle && (t ? t("confirm.move.desc", { title: moveFor.displayTitle }) : "")) || ""`.
  assert.match(
    block,
    /description:\s*\(\s*moveFor\s*&&\s*moveFor\.displayTitle\s*&&\s*\(\s*t\s*\?\s*t\("confirm\.move\.desc",\s*\{\s*title:\s*moveFor\.displayTitle\s*\}\)\s*:\s*""\s*\)\s*\)\s*\|\|\s*""/,
    "title-bar MoveDialog description must guard on displayTitle and pass it to the template"
  );
  assert.doesNotMatch(
    block,
    /description:[^,}\n]*moveFor\.id[^,}\n]*\}/,
    "title-bar MoveDialog description must not embed moveFor.id anywhere"
  );
});

test("issue #17.2 + display-name-only: delete dialogs (panel + title-bar) use displayTitle only", () => {
  // Both delete descriptions must mirror the move-dialog pattern. The panel
  // uses `(confirmFor.displayTitle && t("confirm.delete.desc", { title: confirmFor.displayTitle })) || ""`;
  // the title-bar wraps it in `(confirmFor && confirmFor.displayTitle && (t ? t(...) : ...)) || ""`.
  // Accept any line containing `confirm.delete.desc` whose title argument is
  // `displayTitle` (never `id`).
  const deleteSnippets = SRC.match(/description:[^;\n]*confirm\.delete\.desc[^;\n]*/g) || [];
  assert.ok(deleteSnippets.length >= 2, "expected at least 2 delete descriptions, found " + deleteSnippets.length);
  for (const snippet of deleteSnippets) {
    assert.match(
      snippet,
      /title:\s*\w+\.displayTitle\b/,
      `delete description must pass displayTitle to confirm.delete.desc: ${snippet}`
    );
    assert.doesNotMatch(
      snippet,
      /title:\s*\w+\.id\b/,
      `delete description leaks raw id: ${snippet}`
    );
  }
});

test("display-name-only: title-bar setMoveFor / setConfirmFor / setAnnotationFor capture the friendly displayTitle at render time", () => {
  // The header bar MUST resolve the friendly session name during render
  // (top of HeaderAction) and reuse the captured const in the onClick
  // handlers. Calling useSessions() inside an event handler broke the
  // slot framework`s useSyncExternalStore subscriber ("Cannot read
  // properties of null (reading ''current'')") which then tripped
  // SlotErrorBoundary and replaced the whole conversation.session.header.actions
  // slot with <div data-slot-error="..." />, taking every title-bar button
  // down. Keep this regression test strict.
  const anchorA = '                setMoveFor({ id: sessionId, displayTitle, workspaceId: "" });';
  const anchorB = '                setConfirmFor({ id: sessionId, displayTitle });';
  const anchorC = '            setAnnotationFor(current => current?.id === sessionId ? null : { id: sessionId, displayTitle });';
  assert.ok(SRC.indexOf(anchorA) >= 0, "setMoveFor must reuse the captured displayTitle const, not call realDisplayTitle() inside the handler");
  assert.ok(SRC.indexOf(anchorB) >= 0, "setConfirmFor must reuse the captured displayTitle const, not call realDisplayTitle() inside the handler");
  assert.ok(SRC.indexOf(anchorC) >= 0, "setAnnotationFor must reuse the captured displayTitle const, not call realDisplayTitle() inside the handler");
  assert.doesNotMatch(
    SRC,
    /setMoveFor\(\s*\{\s*id:\s*sessionId,\s*displayTitle:\s*sessionId\s*,/,
    "setMoveFor must not fall back to displayTitle: sessionId"
  );
  assert.doesNotMatch(
    SRC,
    /setConfirmFor\(\s*\{\s*id:\s*sessionId,\s*displayTitle:\s*sessionId\s*\}\s*;/,
    "setConfirmFor must not fall back to displayTitle: sessionId"
  );
  assert.doesNotMatch(
    SRC,
    /setAnnotationFor\([^)]*displayTitle:\s*props\.displayTitle\s*\|\|\s*sessionId/,
    "setAnnotationFor must not fall back to props.displayTitle || sessionId"
  );
  // Guard against the original bug: realDisplayTitle() must not be called
  // from event handlers (which would invoke useSessions outside React render).
  assert.doesNotMatch(
    SRC,
    /realDisplayTitle\s*\(\s*sessionId\s*,\s*props\.displayTitle\s*\)/,
    "realDisplayTitle must not be invoked from event handlers; resolve the name at render time instead"
  );
  assert.doesNotMatch(
    SRC,
    /function\s+HeaderAction\(props\)\s*\{[\s\S]*?const\s+realDisplayTitle\s*=/,
    "realDisplayTitle helper is gone; the friendly name is now resolved inline at render time"
  );
});

test("display-name-only: HeaderAction resolves the friendly displayTitle at render time and collapses to empty when unknown", () => {
  // Top of HeaderAction must compute displayTitle once per render using
  // useSessions((s) => s).byId[sessionId].displayTitle (with a fallback
  // through props.displayTitle) and finally "" so dialog descriptions
  // collapse to an empty string instead of leaking the raw id.
  const headerActionStart = SRC.indexOf("function HeaderAction(props) {");
  assert.ok(headerActionStart >= 0, "HeaderAction must exist");
    // Walk braces from `function HeaderAction(props) {` to find the body's
  // closing `}` (the next top-level class or function starts after it).
  let headerActionEnd = -1;
  let depth = 0;
  let sawOpen = false;
  let inStr = false;
  let esc = false;
  let quote = "";
  for (let i = headerActionStart; i < SRC.length; i++) {
    const c = SRC[i], n = SRC[i + 1];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { inStr = true; quote = c; continue; }
    if (c === "/" && n === "/") { while (i < SRC.length && SRC[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < SRC.length && !(SRC[i] === "*" && SRC[i + 1] === "/")) i++; i++; continue; }
    if (c === "{") { depth++; sawOpen = true; }
    else if (c === "}") { depth--; if (sawOpen && depth === 0) { headerActionEnd = i + 1; break; } }
  }
  assert.ok(headerActionEnd > headerActionStart, "HeaderAction must terminate before the next top-level class");
  const body = SRC.slice(headerActionStart, headerActionEnd);
  assert.match(
    body,
    /const\s+displayTitle\s*=\s*\(\s*\(\s*\)\s*=>\s*\{/,
    "HeaderAction must compute displayTitle once per render via an IIFE"
  );
  assert.match(
    body,
    /displayTitle\s*=\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?useSessions\s*\(\s*\(\s*s\s*\)\s*=>\s*s\s*\)/,
    "HeaderAction must call useSessions((s) => s) during render (top-level, not inside an event handler)"
  );
  assert.match(
    body,
    /list\.byId\[sessionId\][\s\S]*?displayTitle/,
    "HeaderAction must look up the real friendly name from list.byId[sessionId].displayTitle"
  );
  assert.match(
    body,
    /return\s*\(\s*found\s*&&\s*found\.displayTitle\s*\)\s*\|\|\s*""\s*;/,
    "HeaderAction must collapse to empty string when the friendly name is unknown"
  );
});

test("issue #17.4: row Open button unarchives archived sessions before opening (issue #17.4)", () => {
  const rowOpenAnchor = 'h("button", { type: "button", className: "sm-rowBtn", disabled: busy, onClick:';
  let pos = 0;
  const rowOpenHandlers = [];
  while (true) {
    const next = SRC.indexOf(rowOpenAnchor, pos);
    if (next < 0) break;
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
