import { hostMessage } from "./host-locale.js";
/**
 * Workspace archive persistence.
 *
 * Persists workspace archive state (workspaceId, archived, archivedAt, sessionIds, pending)
 * outside DSH's own registry so restarting DSH retains the archive list without modifying
 * or corrupting DSH native workspace records.
 * Atomic file writes with advisory file lock protect multi-process / multi-window concurrent access.
 */
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertSessionId, writeTempFile } from "./session-files.js";

const fail = (message, code = "bad-request") => Object.assign(new Error(message), { code });
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function assertWorkspaceId(id) {
  if (typeof id !== "string" || !id.trim() || id.includes("\0") || id.includes("..")) {
    throw fail(hostMessage("无效的工作区标识"), "invalid-workspace-id");
  }
}

export function normalizeWorkspaceArchiveRecord(record) {
  if (!isRecord(record)) throw fail(hostMessage("工作区归档记录必须为对象"));
  assertWorkspaceId(record.workspaceId);
  const archived = record.archived === true;
  const archivedAt = typeof record.archivedAt === "number" && Number.isFinite(record.archivedAt)
    ? record.archivedAt
    : Date.now();
  const sessionIds = Array.isArray(record.sessionIds) ? [...record.sessionIds] : [];
  for (const sid of sessionIds) assertSessionId(sid);
  const pending = Array.isArray(record.pending) ? [...record.pending] : [];
  for (const sid of pending) assertSessionId(sid);

  return {
    workspaceId: record.workspaceId,
    archived,
    archivedAt,
    sessionIds,
    pending
  };
}

function unarchivedRecord(workspaceId, previous, { pending, retainSessionIds = false, sessionIds } = {}) {
  const retained = retainSessionIds || pending?.length ? (sessionIds ?? previous?.sessionIds ?? []) : [];
  const outstanding = pending ?? (retainSessionIds ? previous?.pending ?? [] : []);
  if (!retained.length && !outstanding.length) return null;
  return normalizeWorkspaceArchiveRecord({
    ...previous, workspaceId, archived: false, sessionIds: retained, pending: outstanding
  });
}

export function createWorkspaceArchiveStore(directory, { io = fs, lockWaitMs = 3000, memory = false } = {}) {
  if (memory || !directory) {
    let state = { version: 1, workspaces: Object.create(null) };
    return {
      async read() {
        return structuredClone(state);
      },
      async get(workspaceId) {
        assertWorkspaceId(workspaceId);
        return state.workspaces[workspaceId] ? structuredClone(state.workspaces[workspaceId]) : null;
      },
      async getAll() {
        return structuredClone(state.workspaces);
      },
      async setArchive(workspaceId, patch) {
        assertWorkspaceId(workspaceId);
        const record = normalizeWorkspaceArchiveRecord({ ...patch, workspaceId, archived: true });
        state.workspaces[workspaceId] = record;
        return structuredClone(record);
      },
      async setUnarchive(workspaceId, options) {
        assertWorkspaceId(workspaceId);
        const record = unarchivedRecord(workspaceId, state.workspaces[workspaceId], options);
        if (record) state.workspaces[workspaceId] = record;
        else delete state.workspaces[workspaceId];
        return structuredClone(record);
      },
      async removeSession(sessionId) {
        let changed = false;
        for (const [wsId, rec] of Object.entries(state.workspaces)) {
          if (rec.sessionIds.includes(sessionId) || rec.pending.includes(sessionId)) {
            rec.sessionIds = rec.sessionIds.filter(id => id !== sessionId);
            rec.pending = rec.pending.filter(id => id !== sessionId);
            changed = true;
          }
        }
        return changed;
      },
      async clear() {
        state = { version: 1, workspaces: Object.create(null) };
      }
    };
  }

  const root = resolve(directory);
  const path = join(root, "workspace-archives.v1.json");
  const lockPath = join(root, "workspace-archives.v1.lock");

  let queue = Promise.resolve();
  const enqueue = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };

  const read = async () => {
    let content;
    try {
      const parent = await io.lstat(root);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail(hostMessage("工作区归档目录不能是符号链接"), "workspace-archives-unavailable");
      const info = await io.lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw fail(hostMessage("工作区归档文件必须是普通文件"), "workspace-archives-unavailable");
      content = await io.readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, workspaces: Object.create(null) };
      throw error;
    }
    try {
      const state = JSON.parse(content);
      if (state?.version !== 1 || !isRecord(state.workspaces)) throw new Error("schema");
      const normalizedWorkspaces = Object.create(null);
      for (const [id, item] of Object.entries(state.workspaces)) {
        normalizedWorkspaces[id] = normalizeWorkspaceArchiveRecord({ ...item, workspaceId: id });
      }
      return { version: 1, workspaces: normalizedWorkspaces };
    } catch {
      throw fail(hostMessage("工作区归档文件损坏或版本不兼容，已停止写入；请先检查 ") + path, "workspace-archives-corrupt");
    }
  };

  const withLock = async operation => {
    await io.mkdir(root, { recursive: true, mode: 0o700 });
    const parent = await io.lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail(hostMessage("工作区归档目录不能是符号链接"), "workspace-archives-unavailable");
    const token = JSON.stringify({ pid: process.pid, token: randomBytes(12).toString("hex") });
    const deadline = Date.now() + lockWaitMs;
    let handle;
    while (!handle) {
      try {
        handle = await io.open(lockPath, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw fail(hostMessage("工作区归档正由其他进程写入，请稍后重试"), "workspace-archives-busy");
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
    let stamped = false;
    try {
      await handle.writeFile(token, "utf8");
      stamped = true;
      return await operation();
    } finally {
      try { await handle.close(); } catch (_) {}
      if (!stamped || await io.readFile(lockPath, "utf8").catch(() => undefined) === token) await io.rm(lockPath, { force: true });
    }
  };

  const write = async state => {
    const raw = JSON.stringify(state, null, 2) + "\n";
    const tempPath = await writeTempFile(path, raw, io);
    try { await io.rename(tempPath, path); }
    catch (error) {
      await io.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  return {
    async read() {
      return enqueue(read);
    },
    async get(workspaceId) {
      assertWorkspaceId(workspaceId);
      const state = await enqueue(read);
      return state.workspaces[workspaceId] ? structuredClone(state.workspaces[workspaceId]) : null;
    },
    async getAll() {
      const state = await enqueue(read);
      return structuredClone(state.workspaces);
    },
    async setArchive(workspaceId, patch) {
      assertWorkspaceId(workspaceId);
      const record = normalizeWorkspaceArchiveRecord({ ...patch, workspaceId, archived: true });
      return enqueue(() => withLock(async () => {
        const state = await read();
        state.workspaces[workspaceId] = record;
        await write(state);
        return structuredClone(record);
      }));
    },
    async setUnarchive(workspaceId, options) {
      assertWorkspaceId(workspaceId);
      return enqueue(() => withLock(async () => {
        const state = await read();
        const record = unarchivedRecord(workspaceId, state.workspaces[workspaceId], options);
        if (record) state.workspaces[workspaceId] = record;
        else delete state.workspaces[workspaceId];
        await write(state);
        return record;
      }));
    },
    async removeSession(sessionId) {
      assertSessionId(sessionId);
      return enqueue(() => withLock(async () => {
        const state = await read();
        let changed = false;
        for (const [wsId, rec] of Object.entries(state.workspaces)) {
          if (rec.sessionIds.includes(sessionId) || rec.pending.includes(sessionId)) {
            rec.sessionIds = rec.sessionIds.filter(id => id !== sessionId);
            rec.pending = rec.pending.filter(id => id !== sessionId);
            changed = true;
          }
        }
        if (changed) await write(state);
        return changed;
      }));
    },
    async clear() {
      return enqueue(() => withLock(async () => {
        await write({ version: 1, workspaces: Object.create(null) });
      }));
    }
  };
}
