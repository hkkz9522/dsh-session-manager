/**
 * Client-side bulk-selection coverage for dsh-session-manager 0.5.2.
 *
 * Issue #13 (批量管理功能) ships a Set<SessionId> selection state in
 * SessionManagerPanel whose visibility (and the BulkActionBar that
 * hosts the destructive actions) is gated on `selectedIds.size === 0 && !selectModeEnabled`,
 * which keeps the checkbox reachable from the panel header toggle (issue #16/#13 entry-point fix).
 * The harness cannot trigger toggleSelect from outside the panel
 * without exposing internal hooks, so the regression value here is
 * static: every source-level invariant the bulk-selection feature
 * relies on must remain in lib/client.js.
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

test("bulk: SessionManagerPanel exposes a selectedIds Set state hook", () => {
  assert.match(SRC, /const \[selectedIds, setSelectedIds\] = useState\(\(\) => new Set\(\)\)/);
});

test("bulk: shift-click invokes toggleSelect with shiftKey=true and rank", () => {
  assert.match(
    SRC,
    /onChange: \(e\) => toggleSelect\(s\.id, e\.shiftKey === true, rank\)/
  );
});

test("bulk: toggleSelect implements a shift-range selection (lo/hi across rows.slice)", () => {
  assert.match(SRC, /Math\.min\(lastClickedRank, currentIndex\)/);
  assert.match(SRC, /Math\.max\(lastClickedRank, currentIndex\)/);
  assert.match(SRC, /rows\.slice\(lo, hi \+ 1\)\.every\(r => next\.has\(r\.id\)\)/);
});

test("bulk: row checkbox label is gated on selectedIds.size === 0 && !selectModeEnabled", () => {
  // The entry-point fix: the checkbox is reachable from the panel
  // header toggle, not only from a non-empty selection.
  assert.match(
    SRC,
    /const checkbox = \(selectedIds\.size === 0 && !selectModeEnabled\)[\s\S]{0,200}h\("label", \{ className: "sm-bulkRowCheckbox"/
  );
});

test("bulk: BulkActionBar appears when selections exist or select-mode is on", () => {
  // The bar shows as soon as the panel header toggle is on,
  // not only after the first checkbox is ticked.
  assert.match(
    SRC,
    /\(selectedIds\.size > 0 \|\| selectModeEnabled\) \? h\(BulkActionBar/
  );
});

test("bulk: panel removes stale selections when the current filter excludes them", () => {
  assert.match(SRC, /const allowed = new Set\(currentFilterIds\)/);
  assert.match(SRC, /for \(const id of prev\) if \(allowed\.has\(id\)\) next\.add\(id\); else changed = true/);
});

test("bulk: panel resets every bulk-state slice when it closes", () => {
  assert.match(SRC, /if \(!open\) \{/);
  assert.match(SRC, /setSelectedIds\(new Set\(\)\)/);
  assert.match(SRC, /setBulkPreview\(null\)/);
  assert.match(SRC, /setBulkProgress\(null\)/);
  assert.match(SRC, /setBulkResult\(null\)/);
});

test("bulk: selectAllFiltered refuses to act when more than 200 rows match the filter", () => {
  // The cap protects the /batch endpoint from payloads the server would
  // 400 as batch-too-large. Any change to this threshold must stay in
  // sync with the host's batch-too-large rule (200).
  assert.match(
    SRC,
    /if \(rows\.length > 200\) \{ setError\(t\("bulk\.error\.tooMany"\)\); return; \}/
  );
});

test("bulk: needsConfirmFor is a delete-only guard", () => {
  // Destructive actions go through the preview; everything else fires
  // immediately. Forcing every action through the preview would surprise
  // users with a confirm dialog on routine tag / priority edits.
  assert.match(SRC, /const needsConfirmFor = \(action\) => action === "delete";/);
});