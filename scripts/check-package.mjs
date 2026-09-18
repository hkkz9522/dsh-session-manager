import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// npm exposes its JS entry point to npm-run scripts. When invoked directly,
// resolve the bundled npm beside node without invoking another shell.
const npm = process.env.npm_execpath ?? [
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
].find(existsSync);
if (!npm) throw new Error("Cannot find npm; run this check using npm run check:package");
const result = spawnSync(process.execPath, [npm, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
});
if (result.status !== 0) throw new Error(result.stderr || result.error?.message || "npm pack failed");
const files = new Set(JSON.parse(result.stdout)[0].files.map(file => file.path));
for (const required of ["lib/index.js", "lib/client.js", "lib/session-files.js", "lib/annotation-store.js", "lib/compat/dsh-adapter.js", "lib/compat/zstd-frames.js", "cordis.patch.yml", "package.json", "README.md", "README.zh.md", "LICENSE", "CHANGELOG.md", "scripts/heal-v2-sessions.ps1"]) {
  assert.ok(files.has(required), "missing runtime artifact: " + required);
}
assert.ok(![...files].some(file => file.startsWith("test/")), "test fixtures must not ship");
console.log("package contents ok (" + files.size + " files)");
