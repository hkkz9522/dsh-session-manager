/** User annotations live outside session artifacts: no history rewriting, no
 * workspace changes, and no model calls. Atomic publication + an advisory
 * inter-process lock protect independent browser/profile updates. */
import * as fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assertSessionId, writeTempFile } from "./session-files.js";

export const DEFAULT_ANNOTATION = Object.freeze({ favorite: false, reviewLater: false, tags: Object.freeze([]), note: "", priority: null, revision: 0 });
export const ANNOTATION_LIMITS = Object.freeze({ tags: 20, tagLength: 32, noteLength: 2000 });
const FIELDS = new Set(["favorite", "reviewLater", "tags", "note", "priority"]);
const fail = (message, code = "bad-request") => Object.assign(new Error(message), { code });
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizeAnnotationPatch(patch) {
  if (!isRecord(patch) || Object.keys(patch).length === 0) throw fail("标记更新不能为空");
  const out = {};
  for (const key of Object.keys(patch)) {
    if (!FIELDS.has(key)) throw fail("未知的标记字段: " + key);
    const value = patch[key];
    if (key === "favorite" || key === "reviewLater") {
      if (typeof value !== "boolean") throw fail("收藏和待回看必须是布尔值");
      out[key] = value;
    } else if (key === "priority") {
      if (value !== null && (!Number.isInteger(value) || value < 1 || value > 5)) throw fail("优先级必须为 1–5 的整数，或未设置（null）");
      out.priority = value;
    } else if (key === "note") {
      if (typeof value !== "string" || value.length > ANNOTATION_LIMITS.noteLength || value.includes("\0")) throw fail("备注最多 2000 字符，不能包含空字符");
      out.note = value;
    } else {
      if (!Array.isArray(value)) throw fail("标签必须是数组");
      const tags = []; const seen = new Set();
      for (const item of value) {
        if (typeof item !== "string") throw fail("标签必须是文本");
        const tag = item.trim();
        if (!tag) continue;
        if (tag.length > ANNOTATION_LIMITS.tagLength || /[,，\x00-\x1f]/.test(tag)) throw fail("每个标签最多 32 字符，不能包含逗号或控制字符");
        const key = tag.toLowerCase();
        if (!seen.has(key)) { tags.push(tag); seen.add(key); }
      }
      if (tags.length > ANNOTATION_LIMITS.tags) throw fail("每个会话最多 20 个标签");
      out.tags = tags;
    }
  }
  return out;
}

export function createAnnotationStore(directory, { io = fs, lockWaitMs = 1500 } = {}) {
  if (typeof directory !== "string" || !directory) throw fail("无法定位会话标记目录", "annotations-unavailable");
  const root = resolve(directory);
  const path = join(root, "annotations.v1.json");
  const lockPath = join(root, "annotations.v1.lock");
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
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail("会话标记目录不能是符号链接", "annotations-unavailable");
      const info = await io.lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw fail("会话标记文件必须是普通文件", "annotations-unavailable");
      content = await io.readFile(path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, sessions: {} };
      throw error;
    }
    try {
      const state = JSON.parse(content);
      if (state?.version !== 1 || !isRecord(state.sessions)) throw new Error("schema");
      for (const [id, item] of Object.entries(state.sessions)) {
        assertSessionId(id);
        if (!isRecord(item) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("revision");
        const { revision, updatedAt, ...fields } = item;
        if (Object.keys(fields).length !== FIELDS.size || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) throw new Error("fields");
        normalizeAnnotationPatch(fields);
      }
      return state;
    } catch {
      // Never include note text or JSON parser excerpts in HTTP errors/logs.
      throw fail("会话标记文件损坏或版本不兼容，已停止写入；请先备份并检查 " + path, "annotations-corrupt");
    }
  };
  const withLock = async operation => {
    await io.mkdir(root, { recursive: true, mode: 0o700 });
    const parent = await io.lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail("会话标记目录不能是符号链接", "annotations-unavailable");
    const token = JSON.stringify({ pid: process.pid, token: randomBytes(12).toString("hex") });
    const deadline = Date.now() + lockWaitMs;
    let handle;
    while (!handle) {
      try { handle = await io.open(lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw fail("会话标记正由其他进程写入，请稍后重试；若进程异常退出，请确认无写入后检查锁文件 " + lockPath, "annotations-busy");
        await delay(Math.min(25, Math.max(1, deadline - Date.now())));
      }
    }
    let stamped = false;
    try {
      await handle.writeFile(token);
      stamped = true;
      return await operation();
    } finally {
      await handle.close();
      // Never unlink a lock that somebody replaced while we were working.
      if (!stamped || await io.readFile(lockPath, "utf8").catch(() => undefined) === token) await io.rm(lockPath, { force: true });
    }
  };
  const publish = async state => {
    const temp = await writeTempFile(path, JSON.stringify(state, null, 2) + "\n", io);
    try {
      // Replace directly: a failed rename leaves the old file intact; readers
      // never see a backup/publication gap or a half-written JSON document.
      await io.rename(temp, path);
    } catch (error) {
      try { await io.rm(temp, { force: true }); } catch { /* uncommitted temp only */ }
      throw error;
    }
  };
  return {
    path,
    async list() { return (await read()).sessions; },
    update(id, patch, expectedRevision) {
      assertSessionId(id);
      const normalized = normalizeAnnotationPatch(patch);
      if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) throw fail("标记版本号无效");
      return enqueue(() => withLock(async () => {
        const state = await read();
        const previous = Object.hasOwn(state.sessions, id) ? state.sessions[id] : DEFAULT_ANNOTATION;
        if (expectedRevision !== undefined && expectedRevision !== previous.revision) {
          throw fail("标记已被其他窗口修改，请载入最新内容后再保存；当前输入尚未丢弃", "annotation-conflict");
        }
        if (Object.keys(normalized).every(key => JSON.stringify(previous[key]) === JSON.stringify(normalized[key]))) return { ...previous };
        const next = { ...previous, ...normalized, revision: previous.revision + 1, updatedAt: Date.now() };
        if (!Number.isSafeInteger(next.revision)) throw fail("标记版本号已超出范围", "annotations-unavailable");
        await publish({ version: 1, sessions: { ...state.sessions, [id]: next } });
        return next;
      }));
    },
    batchUpdate(ids, patch, expectedRevisions) {
      const normalized = normalizeAnnotationPatch(patch);
      const idList = Array.from(new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.trim() !== '').map(id => id.trim())));
      if (idList.length === 0) throw fail('sessionIds 必须是非空数组');
      if (idList.length > 200) throw fail('单次批量最多 200 条');
      for (const id of idList) assertSessionId(id);
      return enqueue(() => withLock(async () => {
        const state = await read();
        const nextSessions = { ...state.sessions };
        const items = [];
        let success = 0, failed = 0, skipped = 0;
        for (const id of idList) {
          try {
            const previous = Object.hasOwn(nextSessions, id) ? nextSessions[id] : DEFAULT_ANNOTATION;
            const expected = expectedRevisions instanceof Map ? expectedRevisions.get(id) : undefined;
            if (expected !== undefined) {
              if (!Number.isSafeInteger(expected) || expected < 0) throw fail('标记版本号无效');
              if (expected !== previous.revision) throw fail('标记已被其他窗口修改，请载入最新内容后再保存', 'annotation-conflict');
            }
            if (Object.keys(normalized).every(key => JSON.stringify(previous[key]) === JSON.stringify(normalized[key]))) {
              items.push({ sessionId: id, status: 'success', annotation: { ...previous }, unchanged: true });
              success++;
              continue;
            }
            const next = { ...previous, ...normalized, revision: previous.revision + 1, updatedAt: Date.now() };
            if (!Number.isSafeInteger(next.revision)) throw fail('标记版本号已超出范围', 'annotations-unavailable');
            nextSessions[id] = next;
            items.push({ sessionId: id, status: 'success', annotation: next });
            success++;
          } catch (error) {
            const code = error && typeof error.code === 'string' ? error.code : undefined;
            items.push({ sessionId: id, status: 'failed', code, error: error && error.message ? error.message : String(error) });
            failed++;
          }
        }
        const anyChanged = items.some(item => item.status === 'success' && !item.unchanged);
        if (anyChanged) await publish({ version: 1, sessions: nextSessions });
        return { summary: { total: idList.length, success, failed, skipped }, items };
      }));
    },
        async remove(id) {
      assertSessionId(id);
      // A plugin that has never used annotations should not create a directory
      // just because an ordinary session was deleted.
      if (!Object.hasOwn((await read()).sessions, id)) return false;
      return enqueue(() => withLock(async () => {
        const state = await read();
        if (!Object.hasOwn(state.sessions, id)) return false;
        const sessions = { ...state.sessions }; delete sessions[id];
        await publish({ version: 1, sessions });
        return true;
      }));
    },
  };
}
