import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Expand filenames ourselves: no shell/glob-version differences on Windows,
// and helpers/reproduction scripts must never be auto-discovered as tests.
const root = fileURLToPath(new URL("..", import.meta.url));
const files = readdirSync(new URL("../test/", import.meta.url)).filter(name => name.endsWith(".test.mjs")).sort();
if (!files.length) throw new Error("No tests discovered");
const result = spawnSync(process.execPath, ["--test", ...files.map(name => "test/" + name)], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
