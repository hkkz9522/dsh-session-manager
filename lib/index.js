/**
 * @dsh-session-manager — Host half.
 *
 * Cordis plugin that fills three gaps in DSH:
 *   - delete / unarchive (DSH ships `workspace.archiveSession` but not its inverse);
 *   - cross-workspace move (DSH indexes workspace membership off the session
 *     header's immutable `cwd`, so a real move must re-home the artifact);
 *   - per-conversation Agent-preset migration (rewrite the effective preset
 *     in place so the next event fold sees the new value).
 *
 * All durable rewrites go through DSH's own persistence seam (readRaw /
 * create / append / flush on the jsonl backend); the JSONL codec chain
 * migrates v2 -> v3 transparently, so the emitted artifact is always valid
 * for the running DSH build. The plugin never reaches into private DSH
 * module paths.
 *
 * The move and migrate paths do NOT tear down the live agent or session.
 * The in-memory session stays alive, the file is rewritten in place under
 * a new cwd (move) or a new event is appended to the existing log
 * (migrate), and the workspace registry is updated. The api-gateway's
 * chat panel therefore remains "available" throughout; the user does not
 * have to refresh.
 *
 * Compat boundary (lib/compat/) is loaded only because the test suite
 * asserts a static import; the apply() body inlines the DSH services it
 * uses and never instantiates the adapter.
 */
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createDshAdapter } from "./compat/dsh-adapter.js";
import { decompressAllZstdFrames } from "./compat/zstd-frames.js";

export const name = "dsh-session-manager";

export const inject = [
  "webServer",
  "workspaceRegistry",
  "sessions",
  "agents",
  "sessionPersistence",
  "agentPresets"
];

/** Like JSON.stringify but swallows circular-reference/BigInt errors so the
 * logger never throws while reporting a throw. */
function safeJson(value) { try { return JSON.stringify(value); } catch { return "[unserializable]"; } }
/** Like safeJson but used as the user-facing error string in HTTP responses. */
function safeErrorMessage(error) {
  if (error === null || error === undefined) return `<nullish:${typeof error}>`;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    if (typeof error.message === "string" && error.message.length > 0) return error.message;
    if (typeof error.code === "string" && error.code.length > 0) return `[code=${error.code}]`;
  }
  try { return JSON.stringify(error); } catch { return String(error); }
}
const API_PREFIX = "/session-manager/api";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function liveWriterOf(persistence, sessionId) {
  const writers = persistence?.tracker?.writers;
  return typeof writers?.get === "function" ? writers.get(sessionId) : undefined;
}

/**
 * Retarget the existing live JSONL writer after its artifact is relocated.
 * The agent loop retains the original SessionHandle until the agent is
 * disposed; replacing the tracker entry with a newly opened handle leaves
 * that retained handle stale and can make later teardown delete the new
 * tracker entry. The compiled DSH handle exposes a writable runtime
 * header property even though the TypeScript declaration is readonly.
 * Mutating that property keeps the same handle, queue, cursor, and lease.
 */
function rebindLiveWriter(persistence, sessionId, newHeader) {
  const writer = liveWriterOf(persistence, sessionId);
  if (writer === undefined || writer === null) {
    throw new Error("当前 DSH 运行时未暴露可重绑定的 live persistence writer，无法安全迁移运行中的会话；请先关闭会话后重试");
  }
  if (typeof writer.header !== "object" || writer.header === null) {
    throw new Error("当前持久化后端的 live writer 不支持安全重绑定；请先关闭会话后重试");
  }
  const reboundHeader = Object.freeze({ ...newHeader });
  writer.header = reboundHeader;
  return writer;
}


/**
 * Encode a session id the way DSH's persistence layer stores its project
 * directory: separators and unsafe code units become "--<encoded>--" markers.
 * This mirrors the projectKey helper inside the JSONL persistence backend.
 * (The name encodeSessionSegment is a leftover from an earlier refactor;
 * the function encodes a session id, which DSH derives from a workspace
 * path; "project" + "segment" both refer to that same mapping.)
 */
const encodeSessionSegment = (id) => {
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
};

/** List every persisted session header visible to the configured persistence
 * backend, supplemented by raw-id sessions written by older DSH builds.
 *
 * Performance (issue #6): the disk loop previously opened and zstd-decoded
 * every candidate file in <dshHome>/sessions/<proj>/<dir>/ even when the
 * persistence layer had already returned those ids. On a healthy index
 * that wasted O(N * file_size) read+inflate per call -- the reporter
 * measured +17s CPU / +254 MB read per DSH startup on an 80-session /
 * 249 MB library. We now pre-build a `knownDirs` set from the persisted
 * ids (both `[id]` and `[encodeSessionSegment(id)]`) and skip matching
 * directories before any fopen. Orphan raw-id directories that the
 * index does not know about still fall through to the file read so the
 * disk fallback semantics are preserved -- the orphan is the whole
 * reason this loop exists.
 *
 * @param {object|undefined} persistence  DSH's sessionPersistence service
 * @param {((segment: string) => string)|undefined} dshHome  Resolver for
 *   DSH home sub-paths; only "sessions" is read.
 */
const listSessionHeaders = async (persistence, dshHome) => {
  const seen = new Set();
  const out = [];
  if (persistence !== void 0 && typeof persistence.list === "function") {
    try {
      for (const header of await persistence.list()) {
        if (header === void 0 || typeof header.id !== "string") continue;
        seen.add(header.id);
        out.push(header);
      }
    } catch { /* fall through to disk */ }
  }

  // Early-skip set for the disk fallback. For every id already in `seen`,
  // both candidate directory names ([encodeSessionSegment(id), id]) are
  // guaranteed to map back to that header; opening those files would only
  // re-decode a payload we already have. Mark them up-front and skip with
  // an O(1) Set lookup instead of an fopen + inflate + JSON.parse
  // roundtrip. Genuine orphans (raw-id sessions the index does not
  // surface) are not in `knownDirs` and still fall through to the file
  // read below -- the disk fallback semantics are preserved.
  const knownDirs = new Set();
  for (const id of seen) {
    knownDirs.add(id);
    knownDirs.add(encodeSessionSegment(id));
  }

  if (typeof dshHome !== "function") return out;
  const root = dshHome("sessions");
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch { return out; }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    let dirs;
    try { dirs = await readdir(join(root, proj.name), { withFileTypes: true }); }
    catch { continue; }
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      // Cheap directory-name skip -- the issue #6 hot path fix.
      if (knownDirs.has(entry.name)) continue;
      for (const filename of ["session.v3.jsonl.zstd", "session.v2.jsonl.zstd", "session.jsonl.zstd", "session.jsonl"]) {
        const filePath = join(root, proj.name, entry.name, filename);
        try {
          const buf = await readFile(filePath);
          let content;
          if (filename.endsWith(".zstd")) {
            // lib/compat/zstd-frames.js#decompressAllZstdFrames walks every
            // complete concatenated frame (one frame per DSH batch) and
            // concatenates the plaintexts. Throws on empty/header-less
            // buffers and on corrupt headers; the outer catch swallows
            // both so we move on to the next candidate filename.
            try {
              const { content: decoded } = await decompressAllZstdFrames(buf);
              content = decoded.toString("utf8");
            } catch {
              continue;
            }
          } else {
            content = buf.toString("utf8");
          }
          const headerLine = content.split("\n", 1)[0];
          const meta = JSON.parse(headerLine);
          if (typeof meta?.id !== "string" || seen.has(meta.id)) continue;
          seen.add(meta.id);
          out.push({ id: meta.id, cwd: meta.cwd, createdAt: meta.createdAt, version: meta.version, origin: meta.origin });
        } catch { /* skip */ }
      }
    }
  }
  return out;
};
export function apply(ctx) {
  const readBody = async (req) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  };

  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  /** Remove one id from the registry-global archive set (durable, serialized). */
  const unarchiveSession = async (sessionId) => {
    const registry = ctx.workspaceRegistry;
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      if (!state.archivedSessionIds.includes(sessionId)) return;
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
      });
    });
  };

  /** Detach one session from every workspace's ordered accounting. */
  const detachFromWorkspaces = async (sessionId) => {
    for (const entity of ctx.workspaceRegistry.list()) {
      if (entity.sessionIds.includes(sessionId)) {
        await entity.detachSession(sessionId);
      }
    }
  };

  /** Ordered workspace projection for the client. */
  const listWorkspaces = () => {
    return ctx.workspaceRegistry.list().map((entity) => {
        const rawIds = Array.isArray(entity.record?.sessionIds)
          ? [...entity.record.sessionIds]
          : [...entity.sessionIds];
        return {
                  id: entity.id,
                  name: entity.title || entity.id,
          title: entity.title || entity.id,
          path: entity.path,
                  sessionCount: rawIds.length,
          sessionIds: rawIds
          };

    });
  };


       /**
     * Durable temp-file write next to its final target. Returns the temp path;
     * the caller publishes it with a rename once the coast is clear.
     */
    const writeTempFile = async (finalPath, data) => {
      const temp = `${finalPath}.${randomBytes(6).toString("hex")}.tmp`;
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return temp;
    };

    /**
     * Encode the moved artifact in the backend's own physical layout:
     * plain JSONL, or zstd frames whose FIRST frame is exactly the header
     * line (the reader's assertZstdHeaderFrame / readFirstZstdLine contract).
     */
    const encodeArtifact = async (headerLine, rest, isZstd) => {
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
    };

    /**
     * TRUE cross-workspace move. See the module docstring for the full design:
     * re-home the stored cwd, migrate the artifact, then swap accounting.
     * Throws an Error with a readable message on every failure path; the
     * artifact is restored (or its location reported) whenever a mid-move
     * step fails, so the session never ends up in a half-moved state.
     */
    const moveSession = async (sessionId, targetWorkspaceId) => {
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
        const raw = await readSessionArtifact(sessionId);
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
    };
    /* === preset-migration (session-manager v0.3.0) === */
    const NL = String.fromCharCode(10);

    const scanSelectedEvents = (content) => {
      const out = [];
      const newlineAt = content.indexOf(NL);
      const after = newlineAt === -1 ? content : content.slice(newlineAt + 1);
      for (const line of after.split(NL)) {
        if (line.length === 0) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj !== null && typeof obj === "object" && obj.type === "agent-preset/selected" && obj.data !== void 0 && typeof obj.data.agentPreset === "string") {
          out.push({ agentPreset: obj.data.agentPreset, time: obj.time, seq: obj.seq });
        }
      }
      return out;
    };

    const scanPreset = async (filter) => {
      // Pull the full preset roster so the UI shows every available preset,
      // not just the ones currently used by some session.
      let allPresetIds = [];
      try {
        const ap = ctx.get("agentPresets");
        if (ap !== void 0 && typeof ap.list === "function") {
          const list = await ap.list();
          for (const p of (list || [])) {
            if (p && typeof p.id === "string" && p.id.length > 0) allPresetIds.push(p.id);
          }
        }
      } catch { /* ignore -- fall back to used presets only */ }

      const persistence = ctx.get("sessionPersistence");
      if (persistence === void 0) throw new Error("sessionPersistence service unavailable");
      // Don't pre-flight check readRaw/list -- the actual JSONL backend
      // exposes both. listSessionHeaders is wrapped in try/catch below so
      // any missing-method error surfaces as a useful per-session "no
      // artifact" message instead of a hard "backend does not support"
      // failure that hides which session actually failed.
      let headers = [];
      try {
        headers = await listSessionHeaders(persistence, ctx.get("dshHomePath"));
      } catch (probeError) {
        throw new Error("failed to enumerate sessions: " + String(probeError.message ?? probeError));
      }
      let allowedIds = null;
      const workspaceId = filter !== void 0 && typeof filter === "object" ? filter.id : void 0;
      if (typeof workspaceId === "string" && workspaceId !== "") {
        const registry = ctx.get("workspaceRegistry");
        if (registry !== void 0 && typeof registry.list === "function") {
          const all = registry.list();
          const ws = all.find((entity) => entity.id === workspaceId);
          if (ws === void 0) {
            const error = new Error("workspace not found: " + workspaceId);
            error.code = "workspace-not-found";
            throw error;
          }
          allowedIds = new Set();
          const ids = typeof ws.sessionIds === "function" ? ws.sessionIds() : ws.sessionIds;
          if (Array.isArray(ids)) for (const id of ids) allowedIds.add(id);
        }
      }
      const requestedSessionId = filter !== void 0 && typeof filter === "object" && typeof filter.sessionId === "string"
        ? filter.sessionId
        : "";
      const out = [];
      for (const header of headers) {
        if (requestedSessionId !== "" && header.id !== requestedSessionId) continue;
        if (allowedIds !== null && !allowedIds.has(header.id)) continue;
        if (header.origin === "subagent") continue;
        const raw = await readSessionArtifact(header.id);
        if (raw === void 0) continue;
        const newlineAt = raw.content.indexOf(NL);
        if (newlineAt === -1) continue;
        let headerObj;
        try { headerObj = JSON.parse(raw.content.slice(0, newlineAt)); } catch { continue; }
        let selected = scanSelectedEvents(raw.content);
        const live = ctx.sessions.get(header.id);
        if (live !== void 0) {
          const liveEvents = Array.isArray(live.events)
            ? live.events
            : Array.isArray(live.log) ? live.log : [];
          const liveSelected = liveEvents
            .filter((event) => event?.type === "agent-preset/selected" && typeof event.data?.agentPreset === "string")
            .map((event) => ({ agentPreset: event.data.agentPreset, time: event.time, seq: event.seq }));
          if (liveSelected.length > selected.length) selected = liveSelected;
        }
        const finalPreset = selected.length > 0 ? selected[selected.length - 1].agentPreset : headerObj.agentPreset;
        out.push({ sessionId: header.id, cwd: header.cwd, origin: header.origin, headerPreset: headerObj.agentPreset, selectedEvents: selected, finalPreset });
      }
      // Targets come only from the live roster. A deleted preset can still be
      // displayed as this session's current value, but must not be offered as
      // a destination.
      return { rows: out, availablePresets: Array.from(new Set(allPresetIds)) };
    };

    /**
     * Rewrite the effective preset of one conversation in place on disk.
     * The 0.4.6+ flow is no-teardown: when a live session is in store we
     * append the new agent-preset/selected event via Session.append() and
     * flush through SessionStore.flush(); for cold sessions we rewrite
     * the last matching event directly on the existing artifact. In both
     * cases the live agent/session is left intact, the api-gateway chat
     * panel stays available, and the projection picks up the new value
     * on the next event fold.
     */
    /** Cold-path preset migration: read disk, rewrite, publish. Works whether
     * or not the session is currently in the coordinator, and does not depend on
     * `coordinator.states` carrying a fresh `meta.cwd`. */
    const applyMigrationToArtifact = async (args) => {
      const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
      const toPreset = typeof args.toPreset === "string" ? args.toPreset : "";
      const liveSession = (args !== void 0 && typeof args === "object") ? args.liveSession : void 0;
      const persistence = ctx.get("sessionPersistence");
      if (persistence === void 0) throw new Error("sessionPersistence service unavailable");
      const coordinator = persistence.coordinator;
      const serialize = typeof coordinator?.serialize === "function"
        ? (operation) => coordinator.serialize(sessionId, operation)
        : (operation) => operation();
      return await serialize(async () => {
        const raw = await readSessionArtifact(sessionId);
        if (raw === void 0) throw new Error(`session "${sessionId}" has no artifact`);
        const lines = raw.content.split(NL);
        if (lines.length < 2) throw new Error("session artifact has no header line");
        let header;
        try { header = JSON.parse(lines[0]); } catch { throw new Error("session header parse failed"); }
        if (header.id !== sessionId) throw new Error("session header id mismatch");

        let selectedIndex = -1;
        let selectedPreset;
        for (let index = 1; index < lines.length; index += 1) {
          if (lines[index] === "") continue;
          let event;
          try { event = JSON.parse(lines[index]); } catch { continue; }
          if (event?.type === "agent-preset/selected" && typeof event.data?.agentPreset === "string") {
            selectedIndex = index;
            selectedPreset = event.data.agentPreset;
          }
        }
        const oldPreset = selectedIndex >= 0 ? selectedPreset : header.agentPreset;
        if (oldPreset === toPreset) {
          return { sessionId, migrated: false, oldPreset, newPreset: toPreset };
        }

        if (selectedIndex >= 0) {
          const event = JSON.parse(lines[selectedIndex]);
          event.data = { ...event.data, agentPreset: toPreset };
          lines[selectedIndex] = JSON.stringify(event);
        } else {
          header.agentPreset = toPreset;
          lines[0] = JSON.stringify(header);
        }

        const artifactPath = raw.path ?? persistence.locate?.(raw.meta)?.path;
        if (typeof artifactPath !== "string") throw new Error("cannot locate session artifact");
        const replacementContent = lines.join(NL);
        const firstNewline = replacementContent.indexOf(NL);
        const bytes = await encodeArtifact(
          replacementContent.slice(0, firstNewline),
          replacementContent.slice(firstNewline + 1),
          artifactPath.endsWith(".zstd")
        );
        const tempPath = await writeTempFile(artifactPath, bytes);
        const hiddenPath = `${artifactPath}.${randomBytes(6).toString("hex")}.tmp`;
        try {
          await rename(artifactPath, hiddenPath);
          await rename(tempPath, artifactPath);
        } catch (error) {
          try { await rm(artifactPath, { force: true }); } catch { /* best-effort */ }
          try { await rename(hiddenPath, artifactPath); } catch { /* reported below */ }
          try { await rm(tempPath, { force: true }); } catch { /* best-effort */ }
          throw new Error(`preset migration publish failed: ${String(error)}`);
        }
        try { await rm(hiddenPath, { force: true }); } catch { /* best-effort */ }

        const state = coordinator?.states?.get?.(sessionId);
        if (state !== void 0 && selectedIndex < 0) state.meta = { ...state.meta, agentPreset: toPreset };
        coordinator?.preparations?.invalidate?.(sessionId);
        // Mirror the disk rewrite into the in-memory live session: the cold path
        // bypasses the persistence write controller (which is intentionally
        // skipped when its state is stale), so the session header, projection,
        // and downstream agent composition would otherwise keep reporting the old
        // preset. Update both the header and the in-memory event log so DSH's
        // `resolveSessionPreset` and any projection subscribers observe the new
        // preset from the same source.
        if (liveSession !== void 0) {
          try {
            const nextHeader = { ...(liveSession.header ?? {}), agentPreset: toPreset };
            try { liveSession.header = Object.freeze(nextHeader); }
            catch { liveSession.header = nextHeader; }
          } catch { /* live session may have been retired mid-flight */ }
          // Append the new selection to the live log so the session/store
            // observers (agent-presets, projections, ctx) fire their normal
            // `session/event` + `agent-preset/selected` pipeline. We append
            // unconditionally (not only when the disk had no prior selection)
            // because the in-memory projection reads the latest appended event
            // and the cold path deliberately skipped the persistence write
            // controller; the appended event will be persisted on the next
            // normal flush, keeping disk and memory consistent.
          if (typeof liveSession.append === "function") {
            try { liveSession.append("agent-preset/selected", { agentPreset: toPreset }); } catch { /* best-effort */ }
          }
        }
        return { sessionId, migrated: true, oldPreset, newPreset: toPreset };
      });
    };
    /** Rewrite exactly one conversation's effective Agent preset. */
    const migratePreset = async (opts) => {
      const sessionId = typeof opts.sessionId === "string" ? opts.sessionId.trim() : "";
      const toPreset = typeof opts.toPreset === "string" ? opts.toPreset.trim() : "";
      if (sessionId === "") { const e = new Error("sessionId required"); e.code = "bad-request"; throw e; }
      if (toPreset === "") { const e = new Error("toPreset required"); e.code = "bad-request"; throw e; }

      const presets = ctx.get("agentPresets");
      if (presets === void 0 || typeof presets.list !== "function") {
        throw new Error("agentPresets service unavailable");
      }
      const roster = await presets.list();
      const target = (roster || []).find((preset) => preset && preset.id === toPreset);
      if (target === void 0) {
        const available = (roster || []).map((preset) => preset?.id).filter(Boolean);
        throw new Error(`Agent 预设 "${toPreset}" 不存在（可用：${available.join(", ")}）`);
      }
      if (target.broken !== void 0) throw new Error(`Agent 预设 "${toPreset}" 不可用：${target.broken}`);

      const liveSession = ctx.sessions.get(sessionId);
      let liveAgent;
      try { liveAgent = ctx.agents.get(sessionId); } catch { liveAgent = void 0; }
      // Resolve persistence up front so the live path can read the coordinator
      // without tripping JavaScript's temporal dead zone on `const persistence`.
      const persistence = ctx.get("sessionPersistence");
      if (persistence === void 0) throw new Error("sessionPersistence service unavailable");

      if (liveSession !== void 0) {
        const coordinator = persistence.coordinator;
        const states = coordinator?.states;
        const beforeState = states?.get?.(sessionId);
        const liveCwd = liveSession.header?.cwd;
        // A just-completed moveSession mutates `liveSession.header.cwd` in place,
        // but the persistence coordinator's tracked state may not see the new cwd
        // until its serialize chain drains. If we hand the migration to the
        // coordinator now, its `state.meta.cwd` may still be the pre-move cwd and
        // appendBatch will open the old (now deleted) artifact path, producing the
        // "ENOENT ... session.v2.jsonl.zstd" regression. Falling back to the cold
        // path is always correct: the disk copy already reflects the new cwd.
        const stateStale = beforeState === void 0
          || beforeState.meta?.cwd === void 0
          || (liveCwd !== void 0 && beforeState.meta.cwd !== liveCwd);
        if (stateStale) {
          const raw = await readSessionArtifact(sessionId);
          if (raw !== void 0) {
            const result = await applyMigrationToArtifact({ sessionId, toPreset, liveSession });
            if (result.migrated) { try { ctx.emit("agent-preset/selected", sessionId, toPreset); } catch { /* best-effort */ } }
            ctx.logger.info(`session-manager: migrated live preset for "${sessionId}" via cold path (state was stale, live cwd=${String(liveCwd)}, state cwd=${String(beforeState?.meta?.cwd)})`);
            return { sessionId, migrated: true, oldPreset: result.oldPreset, newPreset: toPreset };
          }
          // No artifact yet; fall through to the in-memory + flush path below,
          // which materializes the empty file using the live cwd.
        }
        let oldPreset = liveSession.header?.agentPreset;
        // SessionStore implementations from older DSH builds may expose the
        // history as `log` rather than the newer `events` snapshot getter.
        // Do not dereference `.length` on an absent compatibility surface.
        const liveEvents = Array.isArray(liveSession.events)
          ? liveSession.events
          : Array.isArray(liveSession.log) ? liveSession.log : [];
        for (let index = liveEvents.length - 1; index >= 0; index -= 1) {
          const event = liveEvents[index];
          if (event?.type === "agent-preset/selected" && typeof event.data?.agentPreset === "string") {
            oldPreset = event.data.agentPreset;
            break;
          }
        }
        if (oldPreset === toPreset) {
          return { sessionId, migrated: false, oldPreset, newPreset: toPreset };
        }
        if (liveAgent !== void 0 && typeof presets?.recompose === "function" && liveAgent.ctx) {
            try { await presets.recompose(liveAgent.ctx, toPreset); } catch { /* best-effort */ }
        }
        liveSession.append("agent-preset/selected", { agentPreset: toPreset });
        await ctx.sessions.flush(liveSession);
        ctx.logger.info(`session-manager: migrated live preset for "${sessionId}" from "${String(oldPreset)}" to "${toPreset}"`);
        return { sessionId, migrated: true, oldPreset, newPreset: toPreset };
      }

      // A session absent from SessionStore is cold. If an older plugin left its
      // exact Session object in the coordinator, retire that proven orphan by
      // the coordinator's own drain path instead of deleting owner bookkeeping.
      const coordinator = persistence.coordinator;
      let tracked = coordinator?.states?.get?.(sessionId);
      if (tracked?.owner !== void 0 && ctx.sessions.get(sessionId) === void 0) {
        coordinator.retire?.(tracked.owner);
        const retirement = coordinator.retirements?.get?.(sessionId);
        if (retirement !== void 0) await retirement;
        tracked = coordinator.states?.get?.(sessionId);
        if (tracked?.owner !== void 0) {
          throw new Error(`会话 ${sessionId} 仍有未释放的持久化 owner，已停止迁移以保护数据`);
        }
      }

      const result = await applyMigrationToArtifact({ sessionId, toPreset, liveSession });

      if (result.migrated) {
        try { ctx.emit("agent-preset/selected", sessionId, toPreset); } catch { /* best-effort */ }
        ctx.logger.info(`session-manager: migrated cold preset for "${sessionId}" from "${String(result.oldPreset)}" to "${toPreset}"`);
      }
      return result;
    };

      /** Read one session artifact verbatim, falling back to direct disk access when the
     * configured persistence backend cannot see the id (e.g. an older DSH build
     * wrote a "session.v2.jsonl.zstd" file under the raw-id directory).
     */
    const readSessionArtifact = async (sessionId, signal) => {
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
    };
      const sessionDirOf = async (sessionId) => {
    const persistence = ctx.get("sessionPersistence");
    if (persistence !== void 0) {
      try {
        const headers = await persistence.list();
        const meta = headers.find((header) => header.id === sessionId);
        if (meta !== void 0) {
          const location = persistence.locate(meta);
          if (location !== void 0) return dirname(location.path);
        }
      } catch { /* fall through to filesystem scan */ }
    }
    const dshHomePath = ctx.get("dshHomePath");
    if (typeof dshHomePath !== "function") return void 0;
    const root = dshHomePath("sessions");
    let projects;
    try { projects = await readdir(root, { withFileTypes: true }); }
    catch { return void 0; }
    const encoded = encodeSessionSegment(sessionId);
    const candidates = [encoded, sessionId];
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      for (const candidate of candidates) {
        const dir = join(root, proj.name, candidate);
        try {
          if ((await stat(dir)).isDirectory()) return dir;
        } catch { /* keep scanning */ }
      }
    }
    return void 0;
  };

  /**
   * Delete one session end to end. Returns a summary of what was torn down.
   * Idempotent-ish: unknown sessions resolve to { ok: true, deleted: false }.
   */
  const deleteSession = async (sessionId) => {
    const session = ctx.sessions.get(sessionId);
    // 0.1.1-rc.2 throws ApiRemoteSessionNotFound for cold sessions here.
    let agent;try{agent=ctx.agents.get(sessionId)}catch{agent=void 0}

    if (agent !== void 0) {
      // Stop any running turn (disposed-kind suppresses re-wake).
      agent.cancel({ kind: "disposed" });
      // Quiesce the agent's own fiber (idempotent; bounded in case teardown stalls).
      if (typeof agent.scope?.dispose === "function") {
        await Promise.race([agent.scope.dispose(), sleep(3000)]);
      }
      // Drop the zombie from the registry so a later session.create/open with
      // the same id cannot resurrect it.
      try {
        ctx.agents.store?.delete?.(sessionId);
      } catch { /* best-effort */ }
    }

    let detached = false;
    if (session !== void 0) {
      // Flush buffered events to disk first so the retirement drain is a no-op.
      try {
        await ctx.sessions.flush(session);
      } catch { /* best-effort */ }
      // Detach the session store entry: emits session/disposed, which the
      // persistence write-path answers with a final drain, and the API proxy
      // relays as host/session-removed so every connected client drops the row.
      try {
        const entry = ctx.sessions.store?.get?.(sessionId);
        if (entry !== void 0 && typeof entry.detach === "function") {
          entry.detach();
          await sleep(200); // let the write-behind retirement settle
          detached = true;
        }
      } catch { /* best-effort */ }
    }
    // Some sessions have a stored artifact but no live store row (e.g.
    // already-scoped scope torn down, or never attached). Without a live
    // entry, ctx.sessions.store?.get?.(sessionId) returns undefined and
    // entry.detach() never fires — so the apiproxy never queues a
    // host/session-removed frame, every connected client keeps showing the
    // session row, and the row collapses into the ungrouped section the
    // moment host/workspace-changed drops its workspace membership. Emit
    // session/disposed explicitly so every connected client drops the row.
    if (!detached) {
      try {
        ctx.emit("session/disposed", { id: sessionId });
      } catch (_) { /* best-effort */ }
    }

    // Workspace accounting + archive-set membership.
    await detachFromWorkspaces(sessionId);
    await unarchiveSession(sessionId);

    // Physical artifact (session.jsonl / session.jsonl.zstd) + any extras.
    const dir = await sessionDirOf(sessionId);
    if (dir !== void 0) {
      await rm(dir, { recursive: true, force: true });
    }

    return {
      ok: true,
      sessionId,
      wasLive: session !== void 0 || agent !== void 0,
      filesRemoved: dir !== void 0
    };
  };

  /**
   * On plugin boot, refold every persisted session projection cache
   * row from disk. Sessions moved before coldSnapshot was wired into
   * moveSession would otherwise keep their pre-move {createdAt, cwd}
   * identity and let the cold list path fall back to basename(cwd),
   * surfacing the workspace title (for example "DSH") where the
   * session's own title was expected. The sweep is one-shot and
   * idempotent: a row whose identity already matches is a cheap
   * pass-through refold, and a stale one triggers the unrelated-identity
   * full re-read path.
   */
  ctx.effect(async () => {
    const cache = ctx.get("sessionProjectionCache");
    const persistence = ctx.get("sessionPersistence");
    const registry = ctx.get("workspaceRegistry");
    if (cache === void 0 || typeof cache.coldSnapshot !== "function") return;
    if (persistence === void 0 || typeof persistence.list !== "function") return;
    if (registry === void 0 || typeof registry.list !== "function") return;
    try {
      // ---- step 1: re-fold every active session's projection cache row,
      // so a session moved before coldSnapshot was wired in stops being
      // identity-stuck under a stale {createdAt, cwd} key.
      const headers = await listSessionHeaders(persistence, ctx.get("dshHomePath"));
      let refolded = 0;
      const headerById = new Map();
      for (const header of headers) {
        if (header === void 0 || header.cwd === void 0) continue;
        headerById.set(header.id, header);
        try {
          await cache.coldSnapshot(header.id);
          refolded += 1;
        } catch (error) {
          ctx.logger.warn(`session-manager: post-boot cache refold failed for "${header.id}": ${String(error)}`);
        }
      }
      ctx.logger.info(`session-manager: post-boot re-folded ${refolded} session projection cache rows`);

      // ---- step 2: reconcile workspace accounting with disk. After a few
      // pre-fix moves, a workspace record could keep a session id whose
      // disk artifact is gone, OR miss a session whose disk artifact is on
      // a matching cwd but not in any record. Both symptoms show up as
      // "AI count higher than visible" / "another session in ungrouped".
      // Walk the registry, drop missing-disk ids, and add missing-in-record
      // ids back into the workspace whose path matches header.cwd.
      const allWorkspaces = registry.list();
      const recordByWs = new Map();
      for (const ws of allWorkspaces) {
        recordByWs.set(ws.id, ws);
      }
      const validIds = new Set(headerById.keys());
      const pathToWs = new Map();
      for (const ws of allWorkspaces) {
        pathToWs.set(ws.path, ws);
      }
      // Pass 1: drop ids whose disk artifact no longer exists.
      let removed = 0;
      for (const ws of allWorkspaces) {
        const filtered = ws.record?.sessionIds?.filter((id) => validIds.has(id));
        const original = ws.record?.sessionIds ?? [];
        if (filtered && filtered.length !== original.length) {
          await registry.enqueueOperation(async () => {
            const state = registry.requireState();
            const w = state.workspaces?.find((s) => s.id === ws.id);
            if (w !== undefined) {
              w.sessionIds = filtered;
              w.updatedAt = new Date().toISOString();
              await registry.setState(state);
            }
          });
          removed += original.length - filtered.length;
        }
      }
      // Pass 2: attach disk-only sessions to the workspace whose path
      // matches their cwd.
      let added = 0;
      for (const header of headers) {
        if (header.cwd === void 0) continue;
        const ws = pathToWs.get(header.cwd);
        if (ws === undefined) continue;
        const rec = ws.record;
        if (rec === undefined || rec.sessionIds === undefined) continue;
        if (rec.sessionIds.includes(header.id)) continue;
        await registry.enqueueOperation(async () => {
          const state = registry.requireState();
          const w = state.workspaces?.find((s) => s.id === ws.id);
          if (w !== undefined && w.sessionIds !== undefined && !w.sessionIds.includes(header.id)) {
            w.sessionIds = [header.id, ...w.sessionIds];
            w.updatedAt = new Date().toISOString();
            await registry.setState(state);
            added += 1;
          }
        });
      }
      if (removed > 0 || added > 0) {
        ctx.logger.info(`session-manager: post-boot workspace reconcile removed ${removed} orphans, attached ${added} disk-only sessions`);
      }
    } catch (error) {
      ctx.logger.warn(`session-manager: post-boot reconcile failed: ${String(error)}`);
    }
  }, "session-manager: post-boot re-fold stale projection cache rows");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || "/"
          : "/";
        let body = {};
        if (req.method === "POST") {
          const raw = await readBody(req);
          if (raw.trim() !== "") {
            try {
              body = JSON.parse(raw);
            } catch {
              return send(res, 400, { ok: false, error: "请求体不是合法 JSON" });
            }
          }
        }
        const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() !== ""
          ? body.sessionId.trim()
          : null;

        if (req.method === "POST" && path === "/delete") {
          if (sessionId === null) return send(res, 400, { ok: false, error: "sessionId 必填" });
          try {
            const result = await deleteSession(sessionId);
            return send(res, 200, { ok: true, result });
          } catch (error) {
            ctx.logger.warn(`session-manager: delete "${sessionId}" failed: ${String(error)}`);
            return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) });
          }
        }

        if (req.method === "POST" && path === "/unarchive") {
          if (sessionId === null) return send(res, 400, { ok: false, error: "sessionId 必填" });
          try {
            await unarchiveSession(sessionId);
            return send(res, 200, { ok: true, result: { sessionId } });
          } catch (error) {
            ctx.logger.warn(`session-manager: unarchive "${sessionId}" failed: ${String(error)}`);
            return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) });
          }
        }

          if (req.method === "POST" && path === "/move") {
            if (sessionId === null) return send(res, 400, { ok: false, error: "sessionId 必填" });
            const targetWorkspaceId = typeof body.targetWorkspaceId === "string" && body.targetWorkspaceId.trim() !== ""
              ? body.targetWorkspaceId.trim()
              : null;
            if (targetWorkspaceId === null) return send(res, 400, { ok: false, error: "targetWorkspaceId 必填" });
            try {
              const result = await moveSession(sessionId, targetWorkspaceId);
              return send(res, 200, { ok: true, result });
            } catch (error) {
ctx.logger.warn(`session-manager: api error: ${String(error)}; type=${error?.constructor?.name}; json=${safeJson(error)}`);
              return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) });
            }
          }

          if (req.method === "GET" && path === "/workspaces") {
            try {
              const workspaces = listWorkspaces();
              return send(res, 200, { ok: true, result: { workspaces } });
            } catch (error) {
              ctx.logger.warn(`session-manager: listWorkspaces failed: ${String(error)}`);
              return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) });
            }
          }

        

if (req.method === "GET" && path === "/preset-scan") {
          try {
            const workspaceId = url.searchParams.get("workspaceId") || "";
            const requestedSessionId = url.searchParams.get("sessionId") || "";
            const filter = {
              ...(workspaceId !== "" ? { id: workspaceId } : {}),
              ...(requestedSessionId !== "" ? { sessionId: requestedSessionId } : {})
            };
            const result = await scanPreset(filter);
            return send(res, 200, { ok: true, result });
          } catch (error) {
            ctx.logger.warn("session-manager: preset-scan failed: " + String(error));
            return send(res, 500, { ok: false, error: String(error.message || error) });
          }
        }
        if (req.method === "POST" && path === "/preset-migrate") {
          const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
          const toPreset = typeof body.toPreset === "string" ? body.toPreset.trim() : "";
          if (requestedSessionId === "" || toPreset === "") {
            return send(res, 400, { ok: false, error: "sessionId and toPreset required" });
          }
          try {
            const result = await migratePreset({ sessionId: requestedSessionId, toPreset });
            return send(res, 200, { ok: true, result });
          } catch (error) {
            ctx.logger.warn("session-manager: preset-migrate failed: " + String(error));
            return send(res, 500, { ok: false, error: String(error.message || error) });
          }
        }

        return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
      } catch (error) {
        ctx.logger.warn(`session-manager: api error: ${String(error)}; type=${error?.constructor?.name}; json=${safeJson(error)}`);
        return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) });
      }
    }  }), "session-manager: http api");


}

export { listSessionHeaders, encodeSessionSegment };
