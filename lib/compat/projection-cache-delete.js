import * as fs from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertSessionId, replaceSessionFile } from "../session-files.js";

// rc.1 cache.write() may await sessions.flush() before reaching table.put().
// A queue barrier alone cannot drain such a delayed writer. Keep a lifecycle
// tombstone at the table entry point: queued puts precede delete(), later puts
// of the deleted lifecycle are ignored. A recreated id with a new identity is
// independent. The guard lives with the table (including across plugin reloads).
const guards = new WeakMap();
const lifecycleKey = identity => Number.isSafeInteger(identity?.createdAt)
  ? JSON.stringify([identity.createdAt, identity.cwd ?? null, identity.isSeeded ?? false])
  : undefined;
export function beginProjectionCacheDeletion(cache, id, header) {
  assertSessionId(id);
  const table = typeof cache?.requireTable === "function" ? cache.requireTable() : cache?.table;
  if (!table || !["get", "put", "delete"].every(key => typeof table[key] === "function")) return undefined;
  let guard = guards.get(table);
  if (!guard) {
    const removed = new Map();
    const put = table.put;
    table.put = function(key, record) {
      if (removed.get(key)?.has(lifecycleKey(record?.identity))) return Promise.resolve();
      return put.call(this, key, record);
    };
    guard = { removed };
    guards.set(table, guard);
  }
  const identity = table.get(id)?.identity;
  const stamps = [header, identity].map(lifecycleKey).filter(key => key !== undefined);
  if (!stamps.length && (header || identity)) throw new Error("无法确认投影缓存的会话生命周期");
  const previous = guard.removed.get(id);
  const blocked = new Set([...(previous ?? []), ...stamps]);
  guard.removed.set(id, blocked);
  return {
    remove: () => table.delete(id),
    legacyRetained: table.host?.unit?.descriptor?.layout === "per-record",
    legacyManaged: Boolean(table.host?.unit?.descriptor) && table.host.unit.descriptor.layout !== "per-record",
    rollback() {
      if (guard.removed.get(id) !== blocked) return;
      if (previous) guard.removed.set(id, previous); else guard.removed.delete(id);
    }
  };
}

async function regular(path, directory = false) {
  const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) {
    throw new Error("投影缓存路径不是安全的普通" + (directory ? "目录" : "文件") + ": " + path);
  }
}

// The configured home is a trusted root and may itself be a junction/symlink.
// Resolve only that root; descendants still need lstat so links inside it
// cannot redirect cache cleanup outside the configured data tree.
async function canonicalHome(home) {
  try { return await fs.realpath(home); }
  catch (error) { if (error.code === "ENOENT") return home; throw error; }
}

export async function assertProjectionCachePath(home, id) {
  assertSessionId(id);
  home = await canonicalHome(home);
  const paths = [home, join(home, "storages"), join(home, "storages", "session_projcache"),
    join(home, "storages", "session_projcache", "sessions"), join(home, "storages", "session_projcache", "sessions", `${id}.json`)];
  for (let i = 0; i < paths.length; i++) {
    try { await regular(paths[i], i < paths.length - 1); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
  }
}

/** rc.1 bootstraps but never writes its retained legacy unit. Serialize our
 * read/modify/publish across deletes and processes; preserve its stamp/schema
 * and every unrelated table/record. Unknown shapes fail without publication.
 */
export async function removeLegacyProjectionCache(home, id) {
  assertSessionId(id);
  home = await canonicalHome(home);
  const root = join(home, "storages");
  const path = join(root, "session_projcache.json");
  try {
    await regular(home, true);
    await regular(root, true);
    await regular(path);
  } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const lockPath = join(root, "session_projcache.session-manager.lock");
  const token = randomBytes(16).toString("hex");
  const deadline = Date.now() + 3000;
  let lock;
  while (!lock) {
    try { lock = await fs.open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("投影缓存清理锁正被占用: " + lockPath);
      await delay(25);
    }
  }
  let stamped = false;
  try {
    await lock.writeFile(token);
    stamped = true;
    await regular(root, true);
    await regular(path);
    const document = JSON.parse(await fs.readFile(path, "utf8"));
    const records = document?.tables?.sessions;
    if (document?.unit?.name !== "session_projcache" || ![3, 4, 5, 6, 7].includes(document.unit.version)
      || !records || typeof records !== "object" || Array.isArray(records)) {
      throw new Error("未知的旧版投影缓存格式，未修改文件");
    }
    if (!Object.hasOwn(records, id)) return;
    delete records[id];
    const result = await replaceSessionFile(path, JSON.stringify(document) + "\n");
    if (result.backupPath) throw new Error("旧版投影缓存已更新，但备份清理失败: " + result.backupPath);
  } finally {
    await lock.close();
    if (!stamped || await fs.readFile(lockPath, "utf8").catch(() => undefined) === token) await fs.rm(lockPath, { force: true });
  }
}
