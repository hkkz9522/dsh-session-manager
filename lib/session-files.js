import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { decompressAllZstdFrames, decompressZstdFrame, scanZstdFrames } from "./compat/zstd-frames.js";

export const ARTIFACT_NAMES = ["session.v3.jsonl.zstd", "session.v2.jsonl.zstd", "session.jsonl.zstd", "session.jsonl"];
const MAX_HEADER_BYTES = 1024 * 1024;

export function assertSessionId(id) {
  if (typeof id !== "string" || id.trim() === "" || id === "." || id === ".."
    || /[\\/\x00-\x1f<>:"|?*]/.test(id) || /[. ]$/.test(id)) {
    throw Object.assign(new Error("sessionId 必须是合法的会话标识，不能包含路径或特殊目录名"), { code: "bad-request" });
  }
  return id;
}

export function encodeSessionSegment(id) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    const code = id.charCodeAt(i);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return "--" + (readable.replace(/^-+/, "") || "root").slice(0, 251) + "--";
}

/** Only an actual <sessions>/<project>/<session> directory may be mutated.
 * The root itself may be configured through a symlink, but neither child may
 * be a symlink/junction. Check again immediately before destructive cleanup.
 */
export async function assertSessionDirectory(root, directory, id, { allowMissing = false } = {}) {
  assertSessionId(id);
  if (typeof root !== "string" || typeof directory !== "string") {
    throw new Error("无法验证会话目录，已停止文件操作");
  }
  const base = resolve(root);
  const target = resolve(directory);
  const rel = relative(base, target);
  const parts = rel.split(sep);
  if (isAbsolute(rel) || parts.length !== 2 || parts.some(p => p === ".." || p === "." || p === "")
    || ![id, encodeSessionSegment(id)].includes(parts[1])) {
    throw new Error("会话目录超出允许范围，已停止文件操作");
  }
  const canonicalRoot = await fs.realpath(base);
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if (allowMissing && error.code === "ENOENT") return target;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("会话目录不能是符号链接、junction 或普通文件");
    }
    const canonical = await fs.realpath(current);
    const child = relative(canonicalRoot, canonical);
    if (isAbsolute(child) || child === "" || child.split(sep).includes("..")) {
      throw new Error("会话目录解析到了允许范围之外");
    }
  }
  return target;
}

function parseHeader(content) {
  const newline = content.indexOf("\n");
  if (newline < 0) throw new Error("会话工件缺少完整头行");
  const header = JSON.parse(content.slice(0, newline));
  assertSessionId(header?.id);
  return header;
}

async function assertRegularFile(path) {
  const info = await fs.lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("会话工件必须是普通文件，不能是符号链接");
}

/** Header-only discovery: never inflate the history just to list an orphan. */
export async function readSessionHeader(path) {
  await assertRegularFile(path);
  const handle = await fs.open(path, "r");
  try {
    let buffer = Buffer.alloc(0);
    while (buffer.length < MAX_HEADER_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - buffer.length));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, buffer.length);
      if (bytesRead === 0) break;
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      if (path.endsWith(".zstd")) {
        const { frames } = scanZstdFrames(buffer, 1);
        if (frames.length) {
          const frame = frames[0];
          const decoded = await decompressZstdFrame(buffer.subarray(frame.start, frame.end), { maxOutputLength: MAX_HEADER_BYTES });
          return parseHeader(decoded.toString("utf8"));
        }
      } else if (buffer.includes(10)) {
        return parseHeader(buffer.toString("utf8"));
      }
    }
    throw new Error("会话头行不完整或超过大小限制");
  } finally {
    await handle.close();
  }
}

/** Mutators must never publish a successfully decoded prefix as a full log. */
export async function readSessionFile(path) {
  await assertRegularFile(path);
  const bytes = await fs.readFile(path);
  let content;
  if (path.endsWith(".zstd")) {
    const decoded = await decompressAllZstdFrames(bytes);
    if (decoded.torn) throw new Error("会话日志存在截断的 Zstd 帧，拒绝重写；请先备份并修复");
    content = decoded.content.toString("utf8");
  } else {
    content = bytes.toString("utf8");
  }
  if (!content.endsWith("\n")) throw new Error("会话日志存在不完整的尾行，拒绝重写");
  return { meta: parseHeader(content), content, path, filename: basename(path) };
}

/** Inject only filesystem operations for deterministic fault-injection tests. */
export async function writeTempFile(finalPath, data, io = fs) {
  const temp = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await io.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    try { await handle.close(); } catch { /* retain the original write error */ }
    try { await io.rm(temp, { force: true }); } catch { /* uncommitted temp only */ }
    throw error;
  }
  try { await handle.close(); }
  catch (error) {
    try { await io.rm(temp, { force: true }); } catch { /* uncommitted temp only */ }
    throw error;
  }
  return temp;
}

/** Backup, publish, and rollback are distinct phases. Never remove the source
 * when creating its backup failed. A failed rollback leaves the backup intact
 * and reports its exact recovery path rather than silently swallowing failure.
 */
export async function replaceSessionFile(path, bytes, io = fs) {
  const temp = await writeTempFile(path, bytes, io);
  const backup = `${path}.${randomBytes(6).toString("hex")}.bak`;
  try {
    await io.rename(path, backup);
  } catch (error) {
    try { await io.rm(temp, { force: true }); } catch { /* uncommitted temp only */ }
    throw new Error(`无法备份会话工件，未删除原文件: ${error.message}`, { cause: error });
  }
  try {
    await io.rename(temp, path);
  } catch (error) {
    try {
      await io.rename(backup, path);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `发布失败且回滚失败；原始会话保留在 ${backup}，新文件保留在 ${temp}`);
    }
    try { await io.rm(temp, { force: true }); } catch { /* original already restored */ }
    throw new Error(`发布失败，原始会话已恢复: ${error.message}`, { cause: error });
  }
  try { await io.rm(backup, { force: true }); }
  catch { return { backupPath: backup }; }
  return {};
}
