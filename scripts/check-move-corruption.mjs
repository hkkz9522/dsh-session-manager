#!/usr/bin/env node
// One-off scanner: locate session artifacts whose header.version disagrees
// with the version baked into the filename. Such files were produced by
// dsh-session-manager before the issue #18 fix (moveSession stamped only
// header.cwd, leaving header.version at the OLD value while persistence
// locate() always returns the latest generation path). DSH startup
// refuses to load them and crashes the workspace registry.
//
// Usage: node scripts/check-move-corruption.mjs [--dsh-home <path>]
//
// Default --dsh-home is %USERPROFILE%/.dsh on Windows or $HOME/.dsh
// elsewhere. Override via --dsh-home or the DSH_HOME environment variable.
//
// Exit codes:
//   0  no corruption found
//   1  one or more corrupt files found (path list on stderr)
//   2  usage / DSH home missing

import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { parseSessionGenerationFromFilename, readSessionHeader } from "../lib/session-files.js";

function parseArgs(argv) {
  const args = { dshHome: undefined, help: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dsh-home") {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("--dsh-home requires a directory");
      args.dshHome = argv[++i];
      continue;
    }
    if (arg === "-h" || arg === "--help") { args.help = true; continue; }
    throw new Error("unknown argument: " + arg);
  }
  return args;
}

function defaultDshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.length > 0) return process.env.DSH_HOME;
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error("cannot infer DSH home: set --dsh-home or DSH_HOME");
  return join(home, ".dsh");
}

function usage() {
  return [
    "Usage: node scripts/check-move-corruption.mjs [--dsh-home <path>]",
    "",
    "Scans every JSONL/Zstd session artifact under <dsh-home>/sessions/ and",
    "reports files whose on-disk header.version disagrees with the version",
    "embedded in the filename. These files were produced by the pre-fix",
    "moveSession path (issue #18) and crash DSH startup; back them up and",
    "rewrite the header.version (or the filename) to match.",
  ].join("\n");
}

async function listJsonlFiles(sessionsRoot) {
  const out = [];
  const projects = await readdir(sessionsRoot, { withFileTypes: true });
  for (const proj of projects) {
    if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
    const projectDir = join(sessionsRoot, proj.name);
    const sessions = await readdir(projectDir, { withFileTypes: true });
    for (const s of sessions) {
      if (!s.isDirectory() || s.isSymbolicLink()) continue;
      const sessionDir = join(projectDir, s.name);
      const entries = await readdir(sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const filename = entry.name;
        if (!/(^session(\.v\d+)?\.jsonl(\.zstd)?$)|(^session\.jsonl$)/.test(filename)) continue;
        out.push(join(sessionDir, filename));
      }
    }
  }
  return out;
}

async function check(path) {
  const header = await readSessionHeader(path);
  const headerVersion = typeof header.version === "number" ? header.version : undefined;
  const filenameVersion = parseSessionGenerationFromFilename(basename(path));
  if (filenameVersion === undefined) return { path, reason: "non-canonical filename" };
  if (headerVersion === undefined) return { path, reason: "header.version missing" };
  if (headerVersion !== filenameVersion) {
    return {
      path,
      reason: "header.version=" + headerVersion + " != filename v" + filenameVersion,
      headerVersion,
      filenameVersion,
    };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(usage()); return; }
  const dshHome = args.dshHome || defaultDshHome();
  const sessionsRoot = join(dshHome, "sessions");

  let paths;
  try { paths = await listJsonlFiles(sessionsRoot); }
  catch (error) {
    console.error("error: cannot read " + sessionsRoot + ": " + error.message);
    process.exitCode = 2;
    return;
  }
  if (paths.length === 0) {
    console.log("no session artifacts under " + sessionsRoot);
    return;
  }

  const corrupt = [];
  for (const path of paths) {
    try {
      const result = await check(path);
      if (result !== null) corrupt.push(result);
    } catch (error) {
      corrupt.push({ path, reason: error.message });
    }
  }

  if (corrupt.length === 0) {
    console.log("scanned " + paths.length + " artifact(s); no version mismatch detected.");
    return;
  }
  console.error("scanned " + paths.length + " artifact(s); " + corrupt.length + " corrupt:");
  for (const c of corrupt) {
    console.error("  " + c.path + " (" + c.reason + ")");
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("fatal: " + (error && error.message ? error.message : String(error)));
  process.exitCode = 2;
});
