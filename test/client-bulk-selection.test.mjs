/** Structural checks for panel reset and destructive-action routing.
 * User-visible selection behavior is covered by client-bulk-interactions.test.mjs. */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

test("bulk: SessionManagerPanel exposes a selectedIds Set state hook", () => {
  assert.match(SRC, /const \[selectedIds, setSelectedIds\] = useState\(\(\) => new Set\(\)\)/);
});

test("bulk: panel resets every bulk-state slice when it closes", () => {
  assert.match(SRC, /if \(!open\) \{/);
  assert.match(SRC, /setSelectedIds\(new Set\(\)\)/);
  assert.match(SRC, /setBulkPreview\(null\)/);
  assert.match(SRC, /setBulkProgress\(null\)/);
  assert.match(SRC, /setBulkResult\(null\)/);
});

test("bulk: needsConfirmFor is a delete-only guard", () => {
  // Destructive actions go through the preview; everything else fires
  // immediately. Forcing every action through the preview would surprise
  // users with a confirm dialog on routine tag / priority edits.
  assert.match(SRC, /const needsConfirmFor = \(action\) => action === "delete";/);
});
