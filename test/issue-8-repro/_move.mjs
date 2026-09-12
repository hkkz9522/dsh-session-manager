import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { decompressAllZstdFrames } from "../../lib/compat/zstd-frames.js";

async function encodeArtifact(headerLine, rest, isZstd) {
      if (!isZstd) return Buffer.from(`${headerLine}
${rest}`, "utf8");
      const { zstdCompress } = await import("node:zlib");
      if (typeof zstdCompress !== "function") {
        throw new Error("当前 Node 运行时没有 zstd 支持，无法迁移 zstd 编码的会话工件");
      }
      const compress = (buffer) => new Promise((resolve, reject) => {
        zstdCompress(buffer, (error, output) => error == null ? resolve(output) : reject(error));
      });
      const headerFrame = await compress(Buffer.from(`${headerLine}\n`, "utf8"));
      if (rest === "") return headerFrame;
      const bodyFrame = await compress(Buffer.from(rest, "utf8"));
      return Buffer.concat([headerFrame, bodyFrame]);
}

async function writeTempFile(finalPath, data) {
      const temp = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return temp;
}

async function readSessionArtifact(ctx, sessionId, signal) {
      const persistence = ctx.get("sessionPersistence");
      if (persistence !== void 0 && typeof persistence.readRaw === "function") {
        try {
          const raw = await persistence.readRaw(sessionId, signal);
          if (raw !== void 0) {
            const located = typeof persistence.locate === "function" ? persistence.locate(raw.meta) : void 0;
            // After a cross-workspace move, a backend may return a raw artifact
            // whose metadata cache still points at the pre-move cwd. Do not
            // hand that stale path to a mutator; verify it and fall through to
            // the id-based filesystem scan when it no longer exists.
            if (located?.path !== void 0) {
              try {
                if ((await stat(located.path)).isFile()) {
                  return { ...raw, path: located.path };
                }
              } catch { /* stale locate result; scan the durable files below */ }
            } else {
              return { ...raw };
            }
          }
        } catch { /* fall through to direct disk */ }
      }
      const dshHomePath = ctx.get("dshHomePath");
      if (typeof dshHomePath !== "function") return void 0;
      const root = dshHomePath("sessions");
      let projects;
      try { projects = await readdir(root, { withFileTypes: true }); }
      catch { return void 0; }
      const encoded = encodeSessionSegment(sessionId);
      const { createRequire } = await import("node:module"); const require_ = createRequire(import.meta.url); const { zstdDecompressSync } = require_("node:zlib");
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        for (const candidate of [encoded, sessionId]) {
          const dir = join(root, proj.name, candidate);
          for (const filename of ["session.jsonl.zstd", "session.v2.jsonl.zstd", "session.v3.jsonl.zstd", "session.jsonl"]) {
            const filePath = join(dir, filename);
            try {
              const buf = await readFile(filePath);
              let content;
              if (filename.endsWith(".zstd")) {
                // Node's zstdDecompressSync only decodes the FIRST frame in a
                // multi-frame file; DSH writes one frame per batch, so a real
                // artifact contains many concatenated frames and the rest is
                // otherwise silently lost. Walk every magic-prefixed frame and
                // concatenate their plaintexts.
                const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
                const plaintexts = [];
                let pos = 0;
                while (pos < buf.length) {
                  const next = buf.indexOf(ZSTD_MAGIC, pos);
                  if (next < 0) break;
                  try {
                    plaintexts.push(zstdDecompressSync(buf.subarray(next)));
                  } catch {
                    break;
                  }
                  pos = next + 4;
                }
                if (plaintexts.length === 0) continue;
                content = Buffer.concat(plaintexts).toString("utf8");
              } else {
                content = buf.toString("utf8");
              }
              const headerLine = content.split("\n", 1)[0];
              let meta;
              try { meta = JSON.parse(headerLine); } catch { continue; }
              if (typeof meta?.id !== "string" || meta.id !== sessionId) continue;
              return { meta, filename, content, path: filePath };
            } catch { /* keep scanning */ }
          }
        }
      }
      return void 0;
}

const encodeSessionSegment = (id) => {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < id.length; i++) {
    const ch = id[i];
    const code = id.charCodeAt(i);
    if (ch === "/" || ch === String.fromCharCode(92) || ch === ":") {
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
};

const listSessionHeaders = async (persistence) => {
  const out = [];
  try {
    const list = await persistence.list();
    for (const item of list) {
      const hdr = (item && typeof item === 'object' && item.header) ? item.header : item;
      if (hdr && typeof hdr.id === 'string') out.push({ id: hdr.id, cwd: hdr.cwd, origin: hdr.origin });
    }
  } catch {}
  return out;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function liveWriterOf(persistence, sessionId) {
  const writers = persistence?.tracker?.writers;
  return typeof writers?.get === "function" ? writers.get(sessionId) : undefined;
}

/**
 * Retarget the existing live JSONL writer after its artifact is relocated.
 * The agent loop retains the original SessionHandle until the agent is
 * disposed; replacing the tracker entry with a newly opened handle leaves
 * that retained handle stale. The compiled DSH handle exposes a writable
 * runtime header property even though the TypeScript declaration is readonly.
 */
function rebindLiveWriter(persistence, sessionId, newHeader) {
  const writer = liveWriterOf(persistence, sessionId);
  if (writer === undefined || writer === null) {
    throw new Error("当前 DSH 运行时未暴露可重绑定的 live persistence writer，无法安全迁移运行中的会话；请先关闭会话后重试");
  }
  if (typeof writer.header !== "object" || writer.header === null) {
    throw new Error("当前持久化后端的 live writer 不支持安全重绑定；请先关闭会话后重试");
  }
  writer.header = Object.freeze({ ...newHeader });
  return writer;
}


export async function moveSession(ctx, sessionId, targetWorkspaceId) {
  const readSessionArtifactWithCtx = (sid, signal) => readSessionArtifact(ctx, sid, signal);

      const registry = ctx.workspaceRegistry;
      const persistence = ctx.get("sessionPersistence");
      const dshHomePath = ctx.get("dshHomePath");
      if (persistence === void 0) throw new Error("sessionPersistence 服务不可用");
      if (typeof persistence.locate !== "function") {
        throw new Error("当前持久化后端无法定位会话工件，无法跨工作区移动");
      }

      const target = registry.list().find((entity) => entity.id === targetWorkspaceId);
      if (target === void 0) {
        const error = new Error(`目标工作区不存在: ${targetWorkspaceId}`);
        error.code = "workspace-not-found";
        throw error;
      }
      const targetPath = target.path;

      // Fast path: the common case -- the session is already in the
      // persistence index -- costs one .list() + .find(). The previous
      // code called listSessionHeaders() unconditionally, which (before
      // the issue #6 fix) re-read every file in the session library even
      // when the index already had the answer. We still fall through to
      // the disk fallback for raw-id orphans persistence.list() cannot
      // surface (older DSH builds wrote plain-id directories that the
      // index may not know about).
      let storedHeader;
      if (persistence !== void 0 && typeof persistence.list === "function") {
        try {
          const headers = await persistence.list();
          storedHeader = headers.find((header) =>
            header !== void 0 && typeof header.id === "string" && header.id === sessionId
          );
        } catch { /* fall through to disk fallback below */ }
      }
      if (storedHeader === void 0) {
        const storedHeaders = await listSessionHeaders(persistence, dshHomePath);
        storedHeader = storedHeaders.find((header) => header !== void 0 && header.id === sessionId);
      }
      if (storedHeader === void 0) {
        const error = new Error(
          `会话 ${sessionId} 没有磁盘记录（不存在，或是一个尚未发送任何消息的空白会话），无法移动`
        );
        error.code = "session-not-found";
        throw error;
      }
      if (storedHeader.origin === "subagent") {
        const error = new Error("子代理（subagent）会话不支持跨工作区移动");
        error.code = "subagent-unsupported";
        throw error;
      }
      if (storedHeader.cwd !== void 0) {
        let currentCanonical;
        try { currentCanonical = await realpath(storedHeader.cwd); } catch { /* re-home below */ }
        if (currentCanonical === targetPath) {
          return { ok: true, sessionId, moved: false, message: "会话已属于目标工作区" };
        }
      }

      const liveSession = ctx.sessions.get(sessionId);
      if (liveSession !== void 0 && liveWriterOf(persistence, sessionId) === undefined) {
        throw new Error("当前 DSH 运行时未暴露可重绑定的 live persistence writer，无法安全迁移运行中的会话；请先关闭会话后重试");
      }
      let liveAgent;
      try { liveAgent = ctx.agents.get(sessionId); } catch { liveAgent = void 0; }
      // The 0.4.6+ move path is no-teardown: the live agent/session stays
      // alive throughout. We only rewrite the on-disk artifact in place and
      // update the in-memory session header to point at the new cwd; the
      // api-gateway's chat panel keeps the in-memory session as active.
      // The persistence coordinator's per-id serialize() (if available) wraps
      // the rewrite so the write-behind cannot append to the hidden file.
      // client UI never has to re-init. Just flush pending events to
      // disk (still at OLD cwd), then atomically rename the artifact to
      // NEW cwd. The persistence coordinator's serialize() inside the
      // move block holds the per-id lock, so the write-behind can't append
      // to the hidden file. The agent's UI keeps showing the same in-memory
      // session -- no client state flip, no half-initialized resume, no
      // "session unavailable" symptoms.
      if (liveSession !== void 0) {
        try { await ctx.sessions.flush(liveSession); } catch { /* best-effort */ }
      }

            // No teardown -- the agent and session are still live and that's
      // intentional. Move straight to file re-home.
      const coordinator = persistence.coordinator;
      const serialize = typeof coordinator?.serialize === "function"
        ? (operation) => coordinator.serialize(sessionId, operation)
        : (operation) => operation();

      const result = await serialize(async () => {
        const raw = await readSessionArtifactWithCtx(sessionId);
        if (raw === void 0) throw new Error("读取会话工件失败：未找到会话文件");
        const newlineAt = raw.content.indexOf("\n");
        if (newlineAt === -1) throw new Error("会话工件缺少头行，数据可能损坏");
        const rest = raw.content.slice(newlineAt + 1);
        let oldHeader;
        try { oldHeader = JSON.parse(raw.content.slice(0, newlineAt)); }
        catch (error) { throw new Error(`会话工件头行无法解析: ${String(error)}`); }
        if (oldHeader.id !== sessionId) throw new Error("会话工件头行 id 与请求不符，拒绝移动");

        // Keep the stored generation in sync with the filename selected by
        // persistence.locate(). Rewriting a v2 header to v0 while locating it
        // through the same v2 backend creates a v2 filename with v0 content,
        // which makes DSH reject the session on the next startup.
        const newHeader = { ...oldHeader, cwd: targetPath };
        const oldPath = raw.path ?? persistence.locate(raw.meta)?.path;
        const newLocation = persistence.locate(newHeader);
        if (typeof oldPath !== "string" || newLocation === void 0) {
          throw new Error("持久化后端无法定位会话工件路径");
        }
        const newPath = newLocation.path;
        if (oldPath === newPath) throw new Error("会话源路径与目标路径相同，但 cwd 不一致，拒绝覆盖");
        const bytes = await encodeArtifact(JSON.stringify(newHeader), rest, newPath.endsWith(".zstd"));
        await mkdir(dirname(newPath), { recursive: true });
        const tempNew = await writeTempFile(newPath, bytes);
        const oldHidden = `${oldPath}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await rename(oldPath, oldHidden);
        } catch (error) {
          await rm(tempNew, { force: true });
          throw new Error(`移动失败（无法隐藏旧会话工件，已取消，会话保持原状）: ${String(error)}`);
        }
        try {
          await rename(tempNew, newPath);
        } catch (error) {
          try { await rename(oldHidden, oldPath); } catch { /* reported below */ }
          await rm(tempNew, { force: true });
          throw new Error(`移动失败（发布新会话工件失败，已尝试回滚）: ${String(error)}`);
        }

        const state = coordinator?.states?.get?.(sessionId);
        if (state?.owner !== void 0 && liveSession !== void 0 && state.owner !== liveSession) {
          await rm(newPath, { force: true });
          await rename(oldHidden, oldPath);
          throw new Error(`会话 ${sessionId} 的持久化 owner 与当前 live session 不一致，已回滚`);
        }
        const oldStateMeta = state?.meta;
        const oldLiveHeader = liveSession?.header;
        const liveWriter = liveSession === void 0 ? void 0 : liveWriterOf(persistence, sessionId);
        const oldWriterHeader = liveWriter?.header;
        const oldIndexedHeader = registry.headers?.get?.(sessionId);
        const oldIndexedPath = registry.sessionPaths?.get?.(sessionId);
        const oldInvalidPath = registry.invalidSessionPaths?.get?.(sessionId);
        const fromWorkspaceIds = registry.list()
          .filter((entity) => entity.id !== target.id && (entity.record?.sessionIds ?? entity.sessionIds).includes(sessionId))
          .map((entity) => entity.id);
        let targetAttached = false;
        const detachedFrom = [];

        try {
          if (state !== void 0) {
            state.meta = { ...state.meta, ...newHeader, cwd: targetPath };
            state.materialized = true;
          }
          coordinator?.preparations?.invalidate?.(sessionId);
          if (liveSession !== void 0) {
            liveSession.header = Object.freeze({ ...newHeader });
            rebindLiveWriter(persistence, sessionId, newHeader);
          }
          registry.headers?.set?.(sessionId, { ...newHeader });
          registry.sessionPaths?.set?.(sessionId, targetPath);
          registry.invalidSessionPaths?.delete?.(sessionId);

          await registry.enqueueOperation(async () => {
            for (const id of fromWorkspaceIds) {
              const entity = registry.list().find((candidate) => candidate.id === id);
              if (entity === void 0) continue;
              await entity.detachSession(sessionId);
              detachedFrom.push(id);
            }
            await target.attachSession(sessionId);
            targetAttached = true;
          });
        } catch (error) {
          if (state !== void 0 && oldStateMeta !== void 0) state.meta = oldStateMeta;
          coordinator?.preparations?.invalidate?.(sessionId);
          if (liveSession !== void 0 && oldLiveHeader !== void 0) liveSession.header = oldLiveHeader;
          if (liveWriter !== void 0 && oldWriterHeader !== void 0) liveWriter.header = oldWriterHeader;
          if (oldIndexedHeader === void 0) registry.headers?.delete?.(sessionId);
          else registry.headers?.set?.(sessionId, oldIndexedHeader);
          if (oldIndexedPath === void 0) registry.sessionPaths?.delete?.(sessionId);
          else registry.sessionPaths?.set?.(sessionId, oldIndexedPath);
          if (oldInvalidPath === void 0) registry.invalidSessionPaths?.delete?.(sessionId);
          else registry.invalidSessionPaths?.set?.(sessionId, oldInvalidPath);

          const rollbackErrors = [];
          try { if (targetAttached) await target.detachSession(sessionId); } catch (e) { rollbackErrors.push(e); }
          for (const id of detachedFrom) {
            try {
              const entity = registry.list().find((candidate) => candidate.id === id);
              if (entity !== void 0) await entity.attachSession(sessionId);
            } catch (e) { rollbackErrors.push(e); }
          }
          try { await rm(newPath, { force: true }); } catch (e) { rollbackErrors.push(e); }
          try { await rename(oldHidden, oldPath); } catch (e) { rollbackErrors.push(e); }
          // If rebinding closed the old writer before a later step failed,
          // restore a writer bound to the restored source artifact. The live
          // Session itself was never disposed, so it must remain writable.
          if (liveSession !== void 0 && liveWriterOf(persistence, sessionId) === undefined) {
            try { await persistence.open(sessionId, "write"); } catch (e) { rollbackErrors.push(e); }
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], "移动失败且回滚不完整");
          }
          throw error;
        }

        // rebindLiveWriter() above retargeted the existing writer before
        // cleanup, so subsequent routed events use the target cwd without
        // replacing the handle retained by the live agent.
        try { await rm(oldHidden, { force: true }); } catch { /* best-effort */ }
        try { await rm(dirname(oldPath), { recursive: true, force: true }); } catch { /* best-effort */ }

        return {
          ok: true,
          sessionId,
          moved: true,
          fromWorkspaceIds,
          toWorkspaceId: target.id,
          toWorkspaceTitle: target.title || target.id,
          artifactFrom: oldPath,
          artifactTo: newPath,
          wasLive: liveSession !== void 0 || liveAgent !== void 0
        };
      });

      const cache = ctx.get("sessionProjectionCache");
      if (cache !== void 0 && typeof cache.coldSnapshot === "function") {
        try { await cache.coldSnapshot(sessionId); }
        catch (error) { ctx.logger.warn(`session-manager: post-move cache refresh failed for "${sessionId}": ${String(error)}`); }
      }
            // The agent is still live (no teardown). The session's in-memory
      // header was rewritten above and the workspace registry updated;
      // future writes go through persistence.locate() against the new
      // cwd, so the file at the new location accumulates new events.
      // Re-resuming the agent here re-creates a half-initialized
      // Session/agent pair and leaves the client UI in a "session
      // unavailable" state (agent/status is only emitted on PHASE
      // CHANGES, never on agent construction). Leaving the live
      // agent/session in place avoids the broken UI entirely.
            ctx.logger.info(`session-manager: moved "${sessionId}" to workspace "${target.id}" (in-place file rename, live agent retained)`);
      return result;
}
