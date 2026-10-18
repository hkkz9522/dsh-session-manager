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
 * Live preset updates use the DSH session store. Cold rewrites and moves
 * validate the durable JSONL/Zstd artifact and preserve its stored format.
 * File mutations are restricted to verified session directories.
 *
 * The move and migrate paths do NOT tear down the live agent or session.
 * The in-memory session stays alive, the file is rewritten in place under
 * a new cwd (move) or a new event is appended to the existing log
 * (migrate), and the workspace registry is updated. The api-gateway's
 * chat panel therefore remains "available" throughout; the user does not
 * have to refresh.
 *
 * The compatibility adapter normalizes service access and list snapshots.
 * Optional live-writer/coordinator internals are guarded before mutation.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { lstat, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createAnnotationStore } from "./annotation-store.js";
import { createWorkspaceArchiveStore, assertWorkspaceId } from "./workspace-archive-store.js";
import { createDshAdapter, normalizeSessionHeader, compareSemver, detectPluginSource, isHmrActive, resolveProfileDir } from "./compat/dsh-adapter.js";
import { ARTIFACT_NAMES, assertSessionId, assertSessionDirectory, candidateSessionDirs, encodeFsSessionSegment, decodeFsSessionSegment, encodeProjectSegment, encodeSessionSegment, parseSessionGenerationFromFilename, readSessionHeader, readSessionFile, writeTempFile, replaceSessionFile } from "./session-files.js";

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
const scanSessionHeaders = async (persistence, dshHome) => {
  const seen = new Set();
  const headers = [];
  const errors = [];
  let listed = false;
  if (typeof persistence?.list === "function") {
    try {
      const rows = await persistence.list();
      if (!Array.isArray(rows)) throw new Error("会话列表返回了无效数据");
      for (const row of rows) {
        const header = normalizeSessionHeader(row);
        if (!header) { errors.push(new Error("会话列表包含无效 header")); continue; }
        try { assertSessionId(header.id); }
        catch (error) { errors.push(error); continue; }
        if (!seen.has(header.id)) { seen.add(header.id); headers.push(header); }
      }
      listed = true;
    } catch (error) { errors.push(error); }
  }
  const result = () => ({ headers, complete: listed && errors.length === 0, errors });
  // Skip known files before fopen; retain the orphan/raw-id compatibility path.
  // Only add canonical session directories that do not start and end with "--"
  // to avoid colliding with legacy projectKey candidates (e.g. "--s1--").
  const knownDirs = new Set();
  for (const id of seen) {
    try {
      const canonical = encodeFsSessionSegment(id);
      if (!canonical.startsWith("--") || !canonical.endsWith("--")) {
        knownDirs.add(canonical);
      }
    } catch (_) {}
  }
  if (typeof dshHome !== "function") return result();
  const root = dshHome("sessions");
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch (error) { errors.push(error); return result(); }
  listed = true;
  for (const proj of projects) {
    if (proj.isSymbolicLink()) { errors.push(new Error("跳过符号链接项目目录")); continue; }
    if (!proj.isDirectory()) continue;
    let dirs;
    try { dirs = await readdir(join(root, proj.name), { withFileTypes: true }); }
    catch (error) { errors.push(error); continue; }
    for (const entry of dirs) {
      if (entry.isSymbolicLink()) { errors.push(new Error("跳过符号链接会话目录")); continue; }
      if (!entry.isDirectory()) continue;
      if (knownDirs.has(entry.name)) continue;
      let found = false;
      for (const filename of ARTIFACT_NAMES) {
        try {
          const header = await readSessionHeader(join(root, proj.name, entry.name, filename));
          if (!candidateSessionDirs(header.id).includes(entry.name)) {
            throw new Error("会话目录与 header id 不一致");
          }
          if (!seen.has(header.id)) { seen.add(header.id); headers.push(header); }
          found = true;
          break;
        } catch (error) {
          if (error.code !== "ENOENT") { errors.push(error); break; }
        }
      }
      if (!found) errors.push(new Error("无法完整读取会话目录: " + join(root, proj.name, entry.name)));
    }
  }
  return result();
};

const listSessionHeaders = async (persistence, dshHome) => (await scanSessionHeaders(persistence, dshHome)).headers;

const UPDATE_STATUS_FILE = ".dsh-session-manager-update.json";
const ACTIVE_TASK_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes

let activeUpdateTask = null; // { taskId, startedAt }

function getUpdateStatusFilePath(profileDir) {
  return profileDir ? join(profileDir, UPDATE_STATUS_FILE) : null;
}

function writeUpdateStatus(profileDir, statusObj) {
  const filePath = getUpdateStatusFilePath(profileDir);
  if (!filePath) return;
  const tmpPath = filePath + ".tmp." + Date.now();
  try {
    writeFileSync(tmpPath, JSON.stringify(statusObj, null, 2), "utf8");
    try {
      renameSync(tmpPath, filePath);
    } catch {
      try { rmSync(filePath, { force: true }); } catch (_) {}
      renameSync(tmpPath, filePath);
    }
  } catch (_) {
    try { if (existsSync(tmpPath)) rmSync(tmpPath, { force: true }); } catch (_) {}
  }
}

function readUpdateStatus(profileDir) {
  const filePath = getUpdateStatusFilePath(profileDir);
  if (!filePath) return null;
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf8"));
    }
  } catch (_) { /* best-effort */ }
  return null;
}

const ACTIVE_TASK_STATUSES = new Set([
  "preparing",
  "removing",
  "removed",
  "installing",
  "verifying",
  "rolling-back"
]);

function isTaskActive(statusObj) {
  if (!statusObj || typeof statusObj !== "object") return false;
  if (!ACTIVE_TASK_STATUSES.has(statusObj.status)) return false;
  const startedAt = typeof statusObj.startedAt === "number" ? statusObj.startedAt : 0;
  if (Date.now() - startedAt > ACTIVE_TASK_TIMEOUT_MS) return false;
  return true;
}

function verifyInstalledPackage(profileDir, expectedVersion) {
  if (!profileDir) {
    return { ok: false, error: "无法定位插件运行 profile 目录，无法进行安装校验" };
  }
  const pkgDir = join(profileDir, "node_modules", "dsh-session-manager");
  const pkgFile = join(pkgDir, "package.json");
  const entryIndex = join(pkgDir, "lib", "index.js");
  const entryClient = join(pkgDir, "lib", "client.js");

  if (!existsSync(pkgFile)) {
    return { ok: false, error: "未找到安装目录或 package.json: " + pkgFile };
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  } catch (err) {
    return { ok: false, error: "package.json 解析失败: " + safeErrorMessage(err) };
  }
  if (!pkg || typeof pkg !== "object") {
    return { ok: false, error: "package.json 内容无效" };
  }
  if (pkg.name !== "dsh-session-manager") {
    return { ok: false, error: "安装包名称不符: 预期 dsh-session-manager，实际 " + pkg.name };
  }
  if (!expectedVersion || expectedVersion === "latest") {
    return { ok: false, error: "缺少明确的目标版本号，无法完成安装校验" };
  }
  if (pkg.version !== expectedVersion) {
    return {
      ok: false,
      error: "安装版本不匹配: 预期 " + expectedVersion + "，实际安装 " + pkg.version
    };
  }
  if (!existsSync(entryIndex)) {
    return { ok: false, error: "缺少服务端入口文件: lib/index.js" };
  }
  if (!existsSync(entryClient)) {
    return { ok: false, error: "缺少客户端入口文件: lib/client.js" };
  }
  return { ok: true, version: pkg.version };
}

export function apply(ctx) {
  try {
    const buildId = "dsh-session-manager v0.7.3 (workspace-archive)";
    if (typeof ctx?.logger?.info === "function") ctx.logger.info(buildId);
    else if (typeof console !== "undefined" && console?.info) console.info(buildId);
  } catch (_) { /* ignore logging failures */ }
  const adapter = createDshAdapter(ctx);
  let annotationStore;
  const annotations = () => {
    if (!annotationStore) {
      const home = adapter.homePath;
      if (typeof home !== "function") throw Object.assign(new Error("会话标记存储不可用"), { code: "annotations-unavailable" });
      annotationStore = createAnnotationStore(home("dsh-session-manager"));
    }
    return annotationStore;
  };
  let workspaceArchiveStore;
  const workspaceArchives = () => {
    if (!workspaceArchiveStore) {
      const home = adapter.homePath;
      if (typeof home === "function") {
        try {
          workspaceArchiveStore = createWorkspaceArchiveStore(home("dsh-session-manager"));
        } catch (_) {}
      }
      if (!workspaceArchiveStore) {
        workspaceArchiveStore = createWorkspaceArchiveStore(null, { memory: true });
      }
    }
    return workspaceArchiveStore;
  };
  const safeGetAgent = (sessionId) => {
    try { return ctx.agents?.get?.(sessionId); } catch { return undefined; }
  };
  const assertAnnotatable = id => {
    const registry = adapter.workspaceRegistry;
    if (adapter.getSession(id) !== undefined || registry?.headers?.has?.(id)
      || adapter.workspaceList().some(ws => (ws.record?.sessionIds ?? ws.sessionIds ?? []).includes(id))) return;
    throw Object.assign(new Error("会话不存在或尚未加载，请先打开该会话后重试"), { code: "session-not-found" });
  };
  const operations = new Map();
  const mutate = (id, operation) => {
    const pending = (operations.get(id) ?? Promise.resolve()).then(operation);
    const settled = pending.catch(() => {}).finally(() => {
      if (operations.get(id) === settled) operations.delete(id);
    });
    operations.set(id, settled);
    return pending;
  };
  const readBody = async (req) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024) throw Object.assign(new Error("请求体超过 64 KiB"), { code: "body-too-large" });
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString("utf8");
  };

  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  /** Remove one id from the registry-global archive set (durable, serialized). */
  const unarchiveSession = async (sessionId) => {
    const ui = adapter.uiWorkspace;
    if (ui && typeof ui.unarchiveSession === "function") {
      await ui.unarchiveSession(sessionId);
      return;
    }
    const registry = ctx.get("workspaceRegistry") ?? ctx.workspaceRegistry ?? adapter.workspaceRegistry;
    if (registry && typeof registry.unarchiveSession === "function") {
      await registry.unarchiveSession(sessionId);
      return;
    }
    if (!registry || typeof registry.enqueueOperation !== "function" || typeof registry.requireState !== "function" || typeof registry.setState !== "function") {
      const error = new Error(`cannot unarchive session '${sessionId}': workspaceRegistry service is unavailable`);
      error.code = "workspace-registry-unavailable";
      throw error;
    }
    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      if (!state.archivedSessionIds.includes(sessionId)) return;
      await registry.setState({
        ...state,
        archivedSessionIds: state.archivedSessionIds.filter((id) => id !== sessionId)
      });
    });
  };

  /** Add one id to the registry-global archive set (durable, serialized).
   *  Prefers official uiWorkspace or workspaceRegistry services without bypassing rejections.
   *  Default preserves running agents (stopActivity: false). When active, archive fails unless explicitly told to stop.
   *  Direct write fallback mirrors official DSH semantics: checks activity when stopActivity !== true,
   *  updates archived/pinned state, and stops activity after writing when requested.
   *  If equivalent semantics cannot be guaranteed (e.g. stop requested but no stop interface available),
   *  safely rejects without modifying registry state. */
  const archiveSession = async (sessionId, options = {}) => {
    const stopActivity = options.stopActivity === true;
    const ui = adapter.uiWorkspace;
    if (ui && typeof ui.archiveSession === "function") {
      await ui.archiveSession(sessionId, { stopActivity });
      return;
    }
    const registry = ctx.get("workspaceRegistry") ?? ctx.workspaceRegistry ?? adapter.workspaceRegistry;
    if (registry && typeof registry.archiveSession === "function") {
      await registry.archiveSession(sessionId, { stopActivity });
      return;
    }
    if (!registry || typeof registry.enqueueOperation !== "function" || typeof registry.requireState !== "function" || typeof registry.setState !== "function") {
      const error = new Error(`cannot archive session '${sessionId}': workspaceRegistry service is unavailable`);
      error.code = "workspace-registry-unavailable";
      throw error;
    }

    if (stopActivity) {
      const hasStopFn = typeof registry.stopSessionActivity === "function" || typeof ctx.parallel === "function";
      if (!hasStopFn) {
        const error = new Error(`cannot archive session '${sessionId}': no valid stop activity interface available`);
        error.code = "stop-activity-unavailable";
        throw error;
      }
    }

    await registry.enqueueOperation(async () => {
      const state = registry.requireState();
      if (state.archivedSessionIds.includes(sessionId)) return;

      if (typeof registry.sessionKnown === "function") {
        const known = await registry.sessionKnown(sessionId);
        if (!known) {
          const error = new Error(`cannot archive session '${sessionId}': session not found`);
          error.code = "workspace/unknown-session";
          throw error;
        }
      }

      if (!stopActivity) {
        const liveSession = ctx.sessions?.get?.(sessionId);
        const liveAgent = safeGetAgent(sessionId);
        const activeTurn = liveSession?.activeTurn;
        const agentRunning = liveAgent?.status === "running" || liveAgent?.busy === true;
        if (activeTurn !== undefined || agentRunning) {
          const kinds = [
            ...(activeTurn !== undefined ? ["active turn"] : []),
            ...(agentRunning ? ["agent running"] : [])
          ].join(", ");
          const error = new Error(`cannot archive session '${sessionId}': the session is active (${kinds})`);
          error.code = "workspace/session-active";
          throw error;
        }

        if (typeof ctx.waterfall !== "function") {
          const error = new Error(`cannot archive session '${sessionId}': activity inspection interface (ctx.waterfall) is unavailable`);
          error.code = "activity-inspection-unavailable";
          throw error;
        }

        let waterfallActivities;
        try {
          waterfallActivities = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
        } catch (err) {
          const error = new Error(`cannot archive session '${sessionId}': failed to inspect session activity: ${safeErrorMessage(err)}`, { cause: err });
          error.code = "activity-check-failed";
          throw error;
        }

        if (Array.isArray(waterfallActivities) && waterfallActivities.length > 0) {
          const kinds = waterfallActivities.map(entry => entry?.kind || "task").join(", ");
          const error = new Error(`cannot archive session '${sessionId}': the session is active (${kinds})`);
          error.code = "workspace/session-active";
          throw error;
        }
      }

      await registry.setState({
        ...state,
        archivedSessionIds: [...state.archivedSessionIds, sessionId],
        pinnedSessionIds: (state.pinnedSessionIds ?? []).filter((id) => id !== sessionId)
      });

      if (stopActivity) {
        if (typeof registry.stopSessionActivity === "function") {
          await registry.stopSessionActivity(sessionId);
        } else if (typeof ctx.parallel === "function") {
          try {
            await ctx.parallel("workspace/session-stop", { sessionId });
          } catch (err) {
            ctx.logger?.warn?.(`workspace: stopping session '${sessionId}' for archive failed: ${String(err)}`);
          }
        }
      }
    });
  };

  /** Detach one session from every workspace's ordered accounting. */
  const detachFromWorkspaces = async (sessionId) => {
    const registry = ctx.get("workspaceRegistry") ?? ctx.workspaceRegistry ?? adapter.workspaceRegistry;
    for (const entity of registry.list()) {
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
      const selfUpdatedAt = entity.updatedAt ?? entity.record?.updatedAt ?? null;
      return {
        id: entity.id,
        name: entity.title || entity.id,
        title: entity.title || entity.id,
        path: entity.path,
        sessionCount: rawIds.length,
        sessionIds: rawIds,
        updatedAt: selfUpdatedAt,
        createdAt: entity.createdAt ?? entity.record?.createdAt ?? null
      };
    });
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
     * Resolve the exact inheritedEventCount for a session.
     * Unseeded sessions strictly require 0.
     * For seeded sessions, the official SessionHeader specification does NOT store
     * inheritedEventCount. We resolve it from:
     * 1. Live session object (session.inheritedEventCount)
     * 2. Persistence live writer or handle (writer.inheritedEventCount, handle.inheritedEventCount via open("read"))
     * 3. Parsed event stream: the index of the FINAL { type: "session/end-seed", data: { inherited: true } } marker event
     * 4. Fallback to header.inheritedEventCount if present (e.g. test fixture/mocks)
     * If isSeeded is true but inheritedEventCount cannot be determined, returns undefined to prevent
     * poisoning the projection cache with an invalid 0 cut.
     */
    const resolveInheritedEventCount = async ({ sessionId, header, events, persistence, liveSession }) => {
      if (!header?.isSeeded) return 0;
      if (typeof liveSession?.inheritedEventCount === "number" && liveSession.inheritedEventCount >= 0) {
        return liveSession.inheritedEventCount;
      }
      const writer = liveWriterOf(persistence, sessionId);
      if (typeof writer?.inheritedEventCount === "number" && writer.inheritedEventCount >= 0) {
        return writer.inheritedEventCount;
      }
      if (persistence && typeof persistence.open === "function") {
        let handle;
        try {
          handle = await persistence.open(sessionId, "read");
          if (typeof handle?.inheritedEventCount === "number" && handle.inheritedEventCount >= 0) {
            return handle.inheritedEventCount;
          }
        } catch { /* best-effort */ }
        finally {
          try { await handle?.close?.(); } catch {}
        }
      }
      if (Array.isArray(events) && events.length > 0) {
        for (let i = events.length - 1; i >= 0; i--) {
          const e = events[i];
          if (e?.type === "session/end-seed" && (e?.data?.inherited === true || e?.inherited === true)) {
            return i;
          }
        }
      }
      if (typeof header?.inheritedEventCount === "number" && header.inheritedEventCount >= 0) {
        return header.inheritedEventCount;
      }
      return undefined;
    };

    const MAX_BOOT_REFOLD_COUNT = 50;
    const MAX_BOOT_REFOLD_MS = 2000;
    const MAX_SINGLE_ARTIFACT_BYTES = 5 * 1024 * 1024; // 5 MB

    const getSessionSizeBytes = async (sessionId, fallbackPath) => {
      if (typeof adapter.statSession === "function") {
        try {
          const stat = await adapter.statSession(sessionId);
          const size = stat?.sizeBytes ?? stat?.size;
          if (typeof size === "number") return size;
        } catch { /* proceed */ }
      }
      try {
        const resolvedPath = fallbackPath ?? (await adapter.resolveSessionPath?.(sessionId));
        if (typeof resolvedPath === "string") {
          const fileStat = await lstat(resolvedPath);
          return fileStat.size;
        }
      } catch { /* proceed */ }
      return undefined;
    };

    /**
     * Refold the projection cache for a session using properly decoded/migrated logical events.
     * Prioritizes the official persistence interface (openSessionRead) to obtain logical events
     * (expanding packed rows and handling generational migrations). Falls back to disk reading
     * only when the official interface is unavailable, strictly verifying continuous logical seq
     * and safe JSON parsing without swallowing corruption. (Issue #32)
     */
    const refoldSessionProjection = async ({
      sessionId,
      header,
      movedArtifactRest,
      isThreeArgCache,
      cache: cacheParam,
      liveSession: liveSessionParam,
      caller = "boot"
    }) => {
      const cache = cacheParam ?? (ctx.get("sessionProjectionCache") ?? adapter.projectionCache);
      if (typeof cache?.coldSnapshot !== "function") return false;
      const isThreeArg = isThreeArgCache ?? (typeof cache.cachedSnapshot === "function" || cache.coldSnapshot.length >= 3);

      // Check file size budget across all reconstruction paths before any decoding/reading
      let artifactSize = await getSessionSizeBytes(sessionId);
      if (typeof movedArtifactRest === "string") {
        const restBytes = Buffer.byteLength(movedArtifactRest);
        artifactSize = artifactSize !== undefined ? Math.max(artifactSize, restBytes) : restBytes;
      }
      if (artifactSize !== undefined && artifactSize > MAX_SINGLE_ARTIFACT_BYTES) {
        ctx.logger.info(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for large artifact "${sessionId}" (${artifactSize} bytes)`);
        return false;
      }

      let events = null;
      let inheritedEventCount = undefined;
      let effectiveHeader = header;

      // Priority 1: Official persistence handle via adapter.openSessionRead
      const hasOfficialReader = typeof adapter.persistence?.open === "function";

      if (hasOfficialReader) {
        let handle = null;
        try {
          handle = await adapter.openSessionRead(sessionId);
          if (handle && typeof handle.read === "function") {
            try {
              const readResult = await handle.read(0);
              const handleEvents = Array.isArray(readResult) ? readResult : readResult?.events;
              if (Array.isArray(handleEvents)) {
                // Verify all events are contiguous logical events
                if (handleEvents.length === 0 || handleEvents.every((e, idx) => e && typeof e === "object" && e.seq === idx)) {
                  events = handleEvents;
                  inheritedEventCount = handle.inheritedEventCount;
                  if (handle.header && typeof handle.header === "object") {
                    effectiveHeader = { ...effectiveHeader, ...handle.header };
                  }
                } else {
                  ctx.logger.warn(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for "${sessionId}": official handle returned non-contiguous logical events`);
                  return false;
                }
              } else {
                ctx.logger.warn(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for "${sessionId}": official handle returned empty or invalid events`);
                return false;
              }
            } catch (readErr) {
              ctx.logger.warn(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for "${sessionId}": official read/migration failed: ${safeErrorMessage(readErr)}`);
              return false;
            }
          }
        } catch (err) {
          const msg = safeErrorMessage(err);
          if (!msg.includes("unavailable")) {
            ctx.logger.warn(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for "${sessionId}": official read/migration failed: ${msg}`);
            return false;
          }
        } finally {
          if (typeof handle?.close === "function") {
            try { await handle.close(); } catch { /* best-effort */ }
          }
        }
      }

      // Priority 2: Fallback to reading disk artifact or moved rest ONLY when official API is unavailable or handle lacks read
      if (events === null) {
        let rest = movedArtifactRest;
        if (typeof rest !== "string") {
          const raw = await readSessionArtifact(sessionId, undefined, { storedHeader: effectiveHeader });
          if (!raw || typeof raw.content !== "string") return false;
          const newlineAt = raw.content.indexOf("\n");
          rest = newlineAt === -1 ? "" : raw.content.slice(newlineAt + 1);
        }

        if (typeof rest === "string" && rest.length > 0) {
          const rawEvents = [];
          let parseFailed = false;
          for (const line of rest.split("\n")) {
            if (!line.trim()) continue;
            try {
              rawEvents.push(JSON.parse(line));
            } catch {
              parseFailed = true;
              break;
            }
          }

          if (parseFailed) {
            ctx.logger.warn(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for "${sessionId}": JSON parse error in artifact events`);
            return false;
          }

          // Strictly check that all rows are contiguous logical events with valid seq starting at 0.
          // Physical rows without seq (like packed tool-call-chunks) MUST NOT be passed to coldSnapshot.
          const isContiguous = rawEvents.length === 0 || rawEvents.every((e, idx) => e && typeof e === "object" && e.seq === idx);
          if (!isContiguous) {
            ctx.logger.warn(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for "${sessionId}": physical rows cannot be restored as logical events without official migration`);
            return false;
          }

          events = rawEvents;
          inheritedEventCount = await resolveInheritedEventCount({
            sessionId,
            header: effectiveHeader,
            events,
            persistence: adapter.persistence,
            liveSession: liveSessionParam ?? adapter.getSession(sessionId)
          });
        }
      }

      if (events !== null) {
        if (effectiveHeader?.isSeeded && inheritedEventCount === undefined) {
          ctx.logger.warn(`session-manager: skipping ${caller === "post-move" ? "post-move cache refresh" : "cache refold"} for seeded session "${sessionId}": cannot determine inheritedEventCount`);
          return false;
        }
        if (isThreeArg) {
          await cache.coldSnapshot(effectiveHeader, inheritedEventCount, events);
        } else {
          try {
            await cache.coldSnapshot(effectiveHeader.id);
          } catch (error) {
            if (String(error).includes("SessionLogOffset") && effectiveHeader) {
              await cache.coldSnapshot(effectiveHeader, inheritedEventCount, events);
            } else {
              throw error;
            }
          }
        }
        return true;
      }
      return false;
    };

    /**
     * TRUE cross-workspace move. See the module docstring for the full design:
     * re-home the stored cwd, migrate the artifact, then swap accounting.
     * Throws an Error with a readable message on every failure path; the
     * artifact is restored (or its location reported) whenever a mid-move
     * step fails, so the session never ends up in a half-moved state.
     */
    const moveSession = async (sessionId, targetWorkspaceId) => {
      assertSessionId(sessionId);
      const registry = ctx.workspaceRegistry;
      const persistence = adapter.persistence;
      const dshHomePath = adapter.homePath;
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
          const headers = (await persistence.list()).map(normalizeSessionHeader);
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

      let movedArtifact = null;
      const result = await serialize(async () => {
        const raw = await readSessionArtifact(sessionId, undefined, { storedHeader });
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
        // For live sessions, the active writer targets the latest generation returned by persistence.locate().
        // For cold sessions, preserve the source artifact's filename and generation to avoid producing an
        // artifact claiming a newer format version without its event contents being migrated. (Issue #32)
        const targetFilename = liveSession !== void 0 ? basename(newLocation.path) : (raw.filename ?? basename(oldPath));
        const targetDir = dirname(newLocation.path);
        const newPath = join(targetDir, targetFilename);
        const expectedVersion = parseSessionGenerationFromFilename(targetFilename);
        if (typeof expectedVersion === "number") newHeader.version = expectedVersion;
        const root = typeof dshHomePath === "function" ? dshHomePath("sessions") : undefined;
        await assertSessionDirectory(root, dirname(oldPath), sessionId);
        await assertSessionDirectory(root, dirname(newPath), sessionId, { allowMissing: true });
        try {
          await lstat(newPath);
          throw new Error("目标位置已有会话工件，拒绝覆盖");
        } catch (error) { if (error.code !== "ENOENT") throw error; }
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
          try { await rename(oldHidden, oldPath); }
          catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "移动发布失败且回滚失败；原始会话保留在 " + oldHidden + "，新文件保留在 " + tempNew);
          }
          try { await rm(tempNew, { force: true }); } catch { /* original restored */ }
          throw new Error("移动发布失败，原始会话已恢复: " + safeErrorMessage(error), { cause: error });
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
        try {
          await assertSessionDirectory(root, dirname(oldPath), sessionId);
          await rm(dirname(oldPath), { recursive: true, force: true });
        } catch (error) { ctx.logger.warn(`session-manager: old directory retained: ${String(error)}`); }

        movedArtifact = { header: newHeader, rest };

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

      const cache = ctx.get("sessionProjectionCache") ?? adapter.projectionCache;
      if (cache !== void 0 && typeof cache.coldSnapshot === "function") {
        try {
          const isThreeArg = typeof cache.cachedSnapshot === "function" || cache.coldSnapshot.length >= 3;
          await refoldSessionProjection({
            sessionId,
            header: movedArtifact?.header,
            movedArtifactRest: movedArtifact?.rest,
            isThreeArgCache: isThreeArg,
            cache,
            liveSession,
            caller: "post-move"
          });
        } catch (error) {
          ctx.logger.warn(`session-manager: post-move cache refresh failed for "${sessionId}": ${String(error)}`);
        }
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

      const persistence = adapter.persistence;
      if (persistence === void 0) throw new Error("sessionPersistence service unavailable");
      // Enumeration normalizes backend snapshots and retains the legacy
      // raw-id disk fallback. Incomplete reads never authorize reconciliation.
      let headers = [];
      try {
        headers = await listSessionHeaders(persistence, adapter.homePath);
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
      if (requestedSessionId !== "") assertSessionId(requestedSessionId);
      const out = [];
      for (const header of headers) {
        if (requestedSessionId !== "" && header.id !== requestedSessionId) continue;
        if (allowedIds !== null && !allowedIds.has(header.id)) continue;
        if (header.origin === "subagent") continue;
        const raw = await readSessionArtifact(header.id, undefined, { storedHeader: header });
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
      const persistence = adapter.persistence;
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
        const home = adapter.homePath;
        await assertSessionDirectory(typeof home === "function" ? home("sessions") : undefined, dirname(artifactPath), sessionId);
        const published = await replaceSessionFile(artifactPath, bytes);
        if (published.backupPath) ctx.logger.warn("session-manager: retained backup " + published.backupPath);

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
      const persistence = adapter.persistence;
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
    const readSessionArtifact = async (sessionId, signal, { headerOnly = false, storedHeader } = {}) => {
      assertSessionId(sessionId);
      const persistence = adapter.persistence;
      const dshHomePath = adapter.homePath;
      const root = typeof dshHomePath === "function" ? dshHomePath("sessions") : undefined;
      const read = async (path) => headerOnly
        ? { meta: await readSessionHeader(path), path }
        : readSessionFile(path);
      // Use cheap index metadata as a location hint, never a decoded readRaw
      // payload. Move/preset scans can reuse headers they already enumerated.
      let header = storedHeader;
      if (header === undefined && typeof persistence?.list === "function") {
        try {
          header = (await persistence.list()).map(normalizeSessionHeader).find(item => item?.id === sessionId);
        } catch (error) { if (signal?.aborted) throw error; }
      }
      if (header !== undefined && typeof persistence?.locate === "function") {
        const path = persistence.locate(header)?.path;
        if (typeof path === "string") {
          try {
            await assertSessionDirectory(root, dirname(path), sessionId);
            const artifact = await read(path);
            if (artifact.meta.id !== sessionId) throw new Error("会话工件 header id 与请求不一致");
            return artifact;
          } catch (error) { if (error.code !== "ENOENT") throw error; }
        }
      }
      if (typeof root !== "string") throw new Error("无法定位并验证会话工件目录");
      let projects;
      try { projects = await readdir(root, { withFileTypes: true }); }
      catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
      for (const proj of projects) {
        if (!proj.isDirectory() || proj.isSymbolicLink()) continue;
        for (const candidate of candidateSessionDirs(sessionId)) {
          const dir = join(root, proj.name, candidate);
          try { await assertSessionDirectory(root, dir, sessionId); }
          catch (error) { if (error.code === "ENOENT") continue; throw error; }
          for (const filename of ARTIFACT_NAMES) {
            try {
              const artifact = await read(join(dir, filename));
              if (artifact.meta.id !== sessionId) {
                if (candidate === candidateSessionDirs(sessionId)[0]) {
                  throw new Error("会话工件 header id 与请求不一致");
                }
                break;
              }
              return artifact;
            } catch (error) { if (error.code !== "ENOENT") throw error; }
          }
        }
      }
      return undefined;
    };

  const sessionDirOf = async (sessionId, storedHeader) => {
    // Require a matching artifact header instead of deleting an arbitrary
    // directory merely because its name matches user input.
    const artifact = await readSessionArtifact(sessionId, undefined, { headerOnly: true, storedHeader });
    return artifact === undefined ? undefined : dirname(artifact.path);
  };

  /**
   * Enumerate all descendant subagent session headers for one or more root session IDs.
   * Recursively traverses subagent relations (origin === "subagent" && parentSession === parentId).
   * Normal fork sessions (origin !== "subagent") are strictly ignored.
   * Only returns verified local sessions with valid directories or live runtime state.
   */
  const findDescendantSubagents = async (rootSessionIds) => {
    const roots = Array.from(new Set((rootSessionIds || []).filter(id => typeof id === "string" && id.trim() !== "")));
    if (roots.length === 0) return [];
    for (const id of roots) assertSessionId(id);

    const headerMap = new Map();
    try {
      const cached = adapter.cachedSessionHeaders?.();
      if (Array.isArray(cached)) {
        for (const h of cached) if (h?.id) headerMap.set(h.id, h);
      }
    } catch { /* proceed */ }

    try {
      const live = adapter.sessions?.list?.();
      if (Array.isArray(live)) {
        for (const s of live) if (s?.header?.id) headerMap.set(s.header.id, s.header);
      }
    } catch { /* proceed */ }

    const scanResult = await scanSessionHeaders(adapter.persistence, adapter.homePath);
    if (!scanResult || !scanResult.complete || (Array.isArray(scanResult.errors) && scanResult.errors.length > 0)) {
      const errSummary = (scanResult?.errors || []).map(safeErrorMessage).join("; ") || "扫描未完成";
      throw new Error("扫描子智能体会话失败 (元数据不完整): " + errSummary);
    }
    if (Array.isArray(scanResult.headers)) {
      for (const h of scanResult.headers) {
        if (h?.id) {
          headerMap.set(h.id, { ...(headerMap.get(h.id) || {}), ...h });
        }
      }
    }

    const allHeaders = [...headerMap.values()];
    const visited = new Set(roots);
    const descendants = [];
    let currentParents = new Set(roots);

    while (currentParents.size > 0) {
      const nextParents = new Set();
      for (const header of allHeaders) {
        if (!header || !header.id || !header.parentSession) continue;
        if (header.origin === "subagent" && currentParents.has(header.parentSession)) {
          if (!visited.has(header.id)) {
            visited.add(header.id);
            nextParents.add(header.id);
            descendants.push(header);
          }
        }
      }
      currentParents = nextParents;
    }

    const verifiedDescendants = [];
    for (const sub of descendants) {
      assertSessionId(sub.id);
      const dir = await sessionDirOf(sub.id, sub);
      const isLive = ctx.sessions?.get?.(sub.id) !== undefined || safeGetAgent(sub.id) !== undefined;
      if (dir !== undefined || isLive) {
        verifiedDescendants.push({ ...sub, dir });
      }
    }

    return verifiedDescendants;
  };

  /**
   * Safety check and activity stop for a session before deletion.
   * If running, attempts safe stop via cancel, dispose, and activity stop interfaces.
   * If it cannot be safely stopped, rejects deletion.
   */
  const assertAndStopActiveSession = async (sessionId, isSubagent = false) => {
    assertSessionId(sessionId);
    const liveSession = ctx.sessions?.get?.(sessionId);
    const liveAgent = safeGetAgent(sessionId);

    const activeTurn = liveSession?.activeTurn;
    const agentRunning = liveAgent?.status === "running" || liveAgent?.busy === true;
    let waterfallActivities = [];
    if (typeof ctx.waterfall === "function") {
      try {
        waterfallActivities = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
      } catch (err) {
        throw new Error(`无法检查会话 '${sessionId}' 的活动状态: ${safeErrorMessage(err)}`);
      }
    }

    const isActive = activeTurn !== undefined || agentRunning || (Array.isArray(waterfallActivities) && waterfallActivities.length > 0);
    if (!isActive) return;

    const registry = ctx.get("workspaceRegistry") ?? ctx.workspaceRegistry ?? adapter.workspaceRegistry;
    const hasAgent = liveAgent !== void 0;
    const hasStopFn = typeof registry?.stopSessionActivity === "function" || typeof ctx.parallel === "function" || typeof liveAgent?.cancel === "function";

    if (!hasStopFn) {
      const label = isSubagent ? `子智能体 '${sessionId}'` : `会话 '${sessionId}'`;
      throw new Error(`无法安全停止运行中的${label}: 没有可用的停止接口`);
    }

    if (hasAgent) {
      if (typeof liveAgent.cancel === "function") {
        liveAgent.cancel({ kind: "disposed" });
      }
      if (typeof liveAgent.scope?.dispose === "function") {
        await Promise.race([liveAgent.scope.dispose(), sleep(3000)]);
      }
    }

    if (typeof registry?.stopSessionActivity === "function") {
      try { await registry.stopSessionActivity(sessionId); }
      catch (err) {
        throw new Error(`停止会话 '${sessionId}' 活动失败: ${safeErrorMessage(err)}`);
      }
    } else if (typeof ctx.parallel === "function") {
      try { await ctx.parallel("workspace/session-stop", { sessionId }); }
      catch (err) {
        throw new Error(`停止会话 '${sessionId}' 活动失败: ${safeErrorMessage(err)}`);
      }
    }

    const postAgent = safeGetAgent(sessionId);
    if (postAgent?.status === "running" || postAgent?.busy === true) {
      const label = isSubagent ? `子智能体 '${sessionId}'` : `会话 '${sessionId}'`;
      throw new Error(`${label} 仍在运行中，无法安全停止`);
    }
  };

  /**
   * Delete one session end to end. Returns a summary of what was torn down.
   * Recursively cascades to all descendant subagents (origin === "subagent").
   * Idempotent-ish: unknown sessions resolve to { ok: true, deleted: false }.
   */
  const deleteSession = async (sessionId, options = {}) => {
    assertSessionId(sessionId);

    let deletedSubagentIds = [];
    const cleanupWarnings = [];

    if (!options.skipSubagents) {
      // 1. Discover all descendant subagents (verifying scan completeness)
      const descendants = await findDescendantSubagents([sessionId]);

      // 2. Pre-delete validation for BOTH main session and all descendants BEFORE any deletion
      // 2.1 Identity validation
      assertSessionId(sessionId);
      for (const sub of descendants) {
        assertSessionId(sub.id);
      }

      // 2.2 Directory validation (prevent traversal / outside directory issues)
      const mainDir = await sessionDirOf(sessionId);
      if (mainDir !== undefined) {
        await assertSessionDirectory(adapter.homePath("sessions"), mainDir, sessionId);
      }
      for (const sub of descendants) {
        const subDir = sub.dir ?? (await sessionDirOf(sub.id, sub));
        if (subDir !== undefined) {
          await assertSessionDirectory(adapter.homePath("sessions"), subDir, sub.id);
        }
      }

      // 2.3 Activity validation and safe stop
      for (const sub of descendants) {
        await assertAndStopActiveSession(sub.id, true);
      }
      await assertAndStopActiveSession(sessionId, false);

      // 3. Deletion order: descendant-first (reverse), parent-last
      const deletePlan = [...descendants].reverse();
      const remainingSubagentIds = descendants.map(d => d.id);

      for (const sub of deletePlan) {
        try {
          const subResult = await mutate(sub.id, async () => {
            return await deleteSession(sub.id, { skipSubagents: true });
          });
          deletedSubagentIds.push(sub.id);
          const rIdx = remainingSubagentIds.indexOf(sub.id);
          if (rIdx !== -1) remainingSubagentIds.splice(rIdx, 1);

          if (Array.isArray(subResult?.warnings)) {
            cleanupWarnings.push(...subResult.warnings);
          } else if (subResult?.warning) {
            cleanupWarnings.push(subResult.warning);
          }

          try {
            await workspaceArchives().removeSession(sub.id);
          } catch (archErr) {
            cleanupWarnings.push(`子智能体 '${sub.id}' 归档记录清理失败: ${safeErrorMessage(archErr)}`);
          }
        } catch (subErr) {
          const err = new Error(`删除子智能体 '${sub.id}' 失败: ${safeErrorMessage(subErr)}`);
          err.deletedSubagentIds = [...deletedSubagentIds];
          err.remainingSessionIds = [sessionId, ...remainingSubagentIds];
          err.partialFailure = deletedSubagentIds.length > 0;
          if (subErr?.code) err.code = subErr.code;
          throw err;
        }
      }
    } else {
      await assertAndStopActiveSession(sessionId, true);
    }

    try {
      // Resolve/validate before cancelling the agent or changing registry state.
      let dir = await sessionDirOf(sessionId);
      const session = ctx.sessions?.get?.(sessionId);
      let agent = safeGetAgent(sessionId);

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
          ctx.agents?.store?.delete?.(sessionId);
        } catch { /* best-effort */ }
      }

      let detached = false;
      if (session !== void 0) {
        // Flush buffered events to disk first so the retirement drain is a no-op.
        try {
          await ctx.sessions?.flush?.(session);
        } catch { /* best-effort */ }
        // Detach the session store entry: emits session/disposed, which the
        // persistence write-path answers with a final drain, and the API proxy
        // relays as host/session-removed so every connected client drops the row.
        try {
          const entry = ctx.sessions?.store?.get?.(sessionId);
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

      // A blank live session may have materialized its first artifact during
      // flush/retirement. Re-resolve after teardown rather than leaking that file.
      dir = await sessionDirOf(sessionId);

      // Workspace accounting + archive-set membership.
      await detachFromWorkspaces(sessionId);
      await unarchiveSession(sessionId);

      // Physical artifact (session.jsonl / session.jsonl.zstd) + any extras.
      if (dir !== void 0) {
        await assertSessionDirectory(adapter.homePath("sessions"), dir, sessionId);
        await rm(dir, { recursive: true, force: true });
      }

      try {
        await annotations().remove(sessionId);
      } catch (error) {
        const warn = "会话已删除，但独立标记清理失败: " + safeErrorMessage(error);
        cleanupWarnings.push(warn);
        ctx.logger.warn("session-manager: " + warn);
      }

      try {
        await workspaceArchives().removeSession(sessionId);
      } catch (error) {
        const warn = "会话已删除，但工作区归档记录清理失败: " + safeErrorMessage(error);
        cleanupWarnings.push(warn);
        ctx.logger.warn("session-manager: " + warn);
      }

      const aggregatedWarning = cleanupWarnings.length > 0 ? cleanupWarnings.join("; ") : undefined;

      return {
        ok: true,
        ...(aggregatedWarning ? { warning: aggregatedWarning, warnings: cleanupWarnings } : {}),
        sessionId,
        wasLive: session !== void 0 || agent !== void 0,
        filesRemoved: dir !== void 0,
        deletedSubagents: deletedSubagentIds,
        subagentCount: deletedSubagentIds.length
      };
    } catch (parentErr) {
      const err = deletedSubagentIds.length > 0
        ? new Error(`删除主会话 '${sessionId}' 失败: ${safeErrorMessage(parentErr)}`)
        : parentErr;
      err.deletedSubagentIds = [...deletedSubagentIds];
      err.remainingSessionIds = [sessionId];
      err.partialFailure = deletedSubagentIds.length > 0;
      if (parentErr?.code && err !== parentErr) err.code = parentErr.code;
      throw err;
    }
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
  /**
   * On plugin boot:
   * 1. Reconcile workspace session membership using header metadata only.
   *    This step is fast, safe, and completely separated from projection cache refolding. (Issue #32)
   * 2. Perform a budgeted background projection cache sweep for missing cache records,
   *    prioritizing sessions in active workspaces, yielding to the event loop, and
   *    safely skipping unmigrated physical rows or corrupt artifacts. (Issue #32)
   */
  ctx.effect(async () => {
    const cache = adapter.projectionCache;
    const persistence = adapter.persistence;
    const registry = adapter.workspaceRegistry;
    if (typeof persistence?.list !== "function" || typeof registry?.list !== "function") return;

    try {
      // Remember only ids that existed before the async scan. Concurrently
      // attached ids must never be removed using this older disk snapshot.
      const initialIds = new Map(registry.list().map(ws => [ws.id, new Set(ws.record?.sessionIds ?? [])]));
      const scan = await scanSessionHeaders(persistence, adapter.homePath);
      if (!scan.complete) {
        ctx.logger.warn("session-manager: incomplete session scan; workspace reconciliation skipped: " + scan.errors.map(safeErrorMessage).join("; "));
        return;
      }
      const headers = scan.headers;
      const validIds = new Set(headers.map(header => header.id));

      // Step 1: Immediate Workspace Member Reconciliation (isolated from projection rebuild)
      let removed = 0;
      let added = 0;
      await registry.enqueueOperation(async () => {
        const state = registry.requireState();
        const pathById = new Map(registry.list().map(ws => [ws.id, ws.path]));
        const assignedIds = new Set((state.workspaces ?? []).flatMap(ws => ws.sessionIds ?? []));
        const workspaces = (state.workspaces ?? []).map(ws => {
          const original = ws.sessionIds ?? [];
          const sessionIds = original.filter(id => validIds.has(id)
            || !initialIds.get(ws.id)?.has(id) || adapter.getSession(id) !== undefined);
          const removedHere = original.length - sessionIds.length;
          removed += removedHere;
          for (const header of headers) {
            if (header.cwd === undefined || header.cwd !== pathById.get(ws.id) || assignedIds.has(header.id)) continue;
            sessionIds.unshift(header.id);
            assignedIds.add(header.id);
            added += 1;
          }
          if (sessionIds.length === original.length && sessionIds.every((id, i) => id === original[i])) return ws;
          return { ...ws, sessionIds, updatedAt: new Date().toISOString() };
        });
        if (removed || added) await registry.setState({ ...state, workspaces });
      });
      if (removed || added) {
        ctx.logger.info('session-manager: post-boot workspace reconcile removed ' + removed + ' orphans, attached ' + added + ' disk-only sessions');
      }

      // Step 2: Budgeted Background Projection Cache Rebuild
      if (typeof cache?.coldSnapshot !== "function") return;
      const isThreeArgCache = typeof cache.cachedSnapshot === "function" || cache.coldSnapshot.length >= 3;

      const assignedIds = new Set(registry.list().flatMap(ws => ws.record?.sessionIds ?? []));
      const candidates = headers.filter(header => assignedIds.has(header.id) || headers.length <= MAX_BOOT_REFOLD_COUNT);

      const startTime = Date.now();
      let attemptedCount = 0;
      let refoldCount = 0;

      for (const header of candidates) {
        if (attemptedCount >= MAX_BOOT_REFOLD_COUNT || Date.now() - startTime > MAX_BOOT_REFOLD_MS) {
          ctx.logger.info(`session-manager: boot projection cache refold budget reached (${attemptedCount} attempted, ${refoldCount} refolded, ${candidates.length - attemptedCount} remaining deferred)`);
          break;
        }

        try {
          if (typeof cache.cachedSnapshot === "function" && cache.cachedSnapshot(header) !== undefined) {
            continue;
          }

          attemptedCount++;

          // Check file size budget before any I/O
          const size = await getSessionSizeBytes(header.id);
          if (typeof size === "number" && size > MAX_SINGLE_ARTIFACT_BYTES) {
            ctx.logger.info(`session-manager: skipping boot cache refold for large artifact "${header.id}" (${size} bytes)`);
            continue;
          }

          // Yield to event loop between sessions so other tasks/HTTP requests stay responsive
          await new Promise(resolve => setImmediate(resolve));

          if (!isThreeArgCache) {
            try {
              await cache.coldSnapshot(header.id);
              refoldCount++;
            } catch (error) {
              if (String(error).includes("SessionLogOffset")) break;
              ctx.logger.warn('session-manager: post-boot cache refold failed: ' + safeErrorMessage(error));
            }
            continue;
          }

          const ok = await refoldSessionProjection({
            sessionId: header.id,
            header,
            isThreeArgCache,
            cache
          });
          if (ok) refoldCount++;
        } catch (error) {
          ctx.logger.warn('session-manager: post-boot cache refold failed for "' + header.id + '": ' + safeErrorMessage(error));
        }
      }
    } catch (error) {
      ctx.logger.warn("session-manager: post-boot reconcile failed: " + safeErrorMessage(error));
    }
  }, "session-manager: post-boot re-fold stale projection cache rows");

  /** Build a normalized annotation patch from one bulk action + payload.
   * Returns null when the payload is missing or malformed so the caller can
   * surface a 400 instead of letting the store throw on a bad value.
   */
  const annotationPatchFromBatchAction = (action, payload) => {
    if (!payload || typeof payload !== "object") return null;
    if (action === "favorite" || action === "unfavorite") return { favorite: action === "favorite" };
    if (action === "review" || action === "unreview") return { reviewLater: action === "review" };
    if (action === "set-priority") {
      const p = Number(payload.priority);
      if (!Number.isInteger(p) || p < 1 || p > 5) return null;
      return { priority: p };
    }
    if (action === "add-tags" || action === "remove-tags") {
      if (!Array.isArray(payload.tags)) return null;
      return action === "add-tags" ? { tags: payload.tags } : { tags: [] };
    }
    return null;
  };

  /** Run one batch action against a single session id. Annotation-affecting
   *  actions resolve the annotation accessor from the surrounding closure
   *  so it can never be silently undefined. Session-management actions reuse
   *  the existing helpers verbatim so move/preset-migrate validation and
   *  live-session handling stay identical to the per-row buttons.
   */
  const runBatchAction = async ({ action, sessionId, payload, mutate, deleteSession, unarchiveSession, moveSession, migratePreset, adapter }) => {
    const annotationsAccessor = annotations;
    if (action === "favorite" || action === "unfavorite" || action === "review" || action === "unreview" || action === "set-priority" || action === "add-tags" || action === "remove-tags") {
      const patch = annotationPatchFromBatchAction(action, payload);
      if (patch === null) {
        const e = new Error("invalid batch payload for " + action); e.code = "bad-request"; throw e;
      }
      try {
        await annotationsAccessor().batchUpdate([sessionId], patch);
      } catch (error) {
        throw error;
      }
      return;
    }
    if (action === "archive") { await mutate(sessionId, () => archiveSession(sessionId, { stopActivity: payload?.stopActivity === true })); return; }
    if (action === "unarchive") { await mutate(sessionId, () => unarchiveSession(sessionId)); return; }
    if (action === "delete") { await mutate(sessionId, () => deleteSession(sessionId)); return; }
    if (action === "move") {
      const targetWorkspaceId = typeof payload?.targetWorkspaceId === "string" ? payload.targetWorkspaceId.trim() : "";
      if (!targetWorkspaceId) { const e = new Error("targetWorkspaceId required"); e.code = "bad-request"; throw e; }
      await mutate(sessionId, () => moveSession(sessionId, targetWorkspaceId));
      return;
    }
    if (action === "preset-migrate") {
      const toPreset = typeof payload?.toPreset === "string" ? payload.toPreset.trim() : "";
      if (!toPreset) { const e = new Error("toPreset required"); e.code = "bad-request"; throw e; }
      await mutate(sessionId, () => migratePreset({ sessionId, toPreset }));
      return;
    }
    const snapshot = adapter.workspaceRegistry?.headers?.get?.(sessionId)
      ?? adapter.sessions?.list?.()?.find(s => s?.id === sessionId)?.header
      ?? null;
    const isSubagent = snapshot?.origin === "subagent";
    const isBlank = snapshot?.blank === true;
    if (isSubagent) { const e = new Error("subagent"); e.code = "subagent-skip"; throw e; }
    if (isBlank) { const e = new Error("blank"); e.code = "blank-skip"; throw e; }
  };

  ctx.effect(() => ctx.webServer.register({    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || "/" : "/";
        let body = {};
        if (req.method === "POST") {
          const raw = await readBody(req);
          if (raw.trim() !== "") {
            try { body = JSON.parse(raw); }
            catch { return send(res, 400, { ok: false, error: "请求体不是合法 JSON" }); }
          }
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return send(res, 400, { ok: false, error: "请求体必须是 JSON 对象" });
        }
        const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
        if (req.method === "GET" && path === "/annotations") {
          return send(res, 200, { ok: true, result: { annotations: await annotations().list() } });
        }
        if (req.method === "POST" && path === "/annotations") {
          assertSessionId(sessionId);
          const annotation = await mutate(sessionId, async () => {
            assertAnnotatable(sessionId);
            return annotations().update(sessionId, body.patch, body.expectedRevision);
          });
          return send(res, 200, { ok: true, result: { sessionId, annotation } });
        }
        if (req.method === "POST" && ["/delete", "/unarchive", "/move", "/preset-migrate"].includes(path)) {
          assertSessionId(sessionId);
          let result;
          if (path === "/delete") {
            try {
              result = await mutate(sessionId, () => deleteSession(sessionId));
              try { await workspaceArchives().removeSession(sessionId); } catch (_) {}
            } catch (delErr) {
              const status = delErr?.code === "bad-request" ? 400 : 500;
              return send(res, status, {
                ok: false,
                error: safeErrorMessage(delErr),
                ...(typeof delErr?.code === "string" ? { code: delErr.code } : {}),
                deletedSubagents: Array.isArray(delErr?.deletedSubagentIds) ? delErr.deletedSubagentIds : [],
                remainingSessions: Array.isArray(delErr?.remainingSessionIds) ? delErr.remainingSessionIds : [sessionId],
                partialFailure: Boolean(delErr?.partialFailure)
              });
            }
          } else if (path === "/unarchive") {
            await mutate(sessionId, () => unarchiveSession(sessionId));
            result = { sessionId };
          } else if (path === "/move") {
            const targetWorkspaceId = typeof body.targetWorkspaceId === "string" ? body.targetWorkspaceId.trim() : "";
            if (!targetWorkspaceId) return send(res, 400, { ok: false, error: "targetWorkspaceId 必填" });
            result = await mutate(sessionId, () => moveSession(sessionId, targetWorkspaceId));
          } else {
            const toPreset = typeof body.toPreset === "string" ? body.toPreset.trim() : "";
            if (!toPreset) return send(res, 400, { ok: false, error: "toPreset 必填" });
            result = await mutate(sessionId, () => migratePreset({ sessionId, toPreset }));
          }
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "POST" && path === "/workspace-archive") {
          const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
          assertWorkspaceId(workspaceId);
          const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds : [];
          for (const id of sessionIds) assertSessionId(id);
          const pending = Array.isArray(body.pending) ? body.pending : [];
          for (const id of pending) assertSessionId(id);
          const record = await workspaceArchives().setArchive(workspaceId, {
            sessionIds,
            pending,
            archivedAt: typeof body.archivedAt === "number" ? body.archivedAt : Date.now()
          });
          return send(res, 200, { ok: true, result: { workspaceId, record } });
        }
        if (req.method === "POST" && path === "/workspace-unarchive") {
          const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
          assertWorkspaceId(workspaceId);
          const pending = Array.isArray(body.pending) ? body.pending : [];
          for (const id of pending) assertSessionId(id);
          const retainSessionIds = body.retainSessionIds === true;
          const record = await workspaceArchives().setUnarchive(workspaceId, { pending, retainSessionIds });
          return send(res, 200, { ok: true, result: { workspaceId, record } });
        }
        if (req.method === "GET" && path === "/workspace-archives") {
          let archives = {};
          try {
            archives = await workspaceArchives().getAll();
          } catch (err) {
            return send(res, 500, { ok: false, error: safeErrorMessage(err) });
          }
          return send(res, 200, { ok: true, result: { archives } });
        }
        if (req.method === "POST" && path === "/batch") {
          // Per-action body shape (each action validates its own payload):
          //   archive       : no payload
          //   unarchive     : no payload
          //   delete        : no payload
          //   move          : { targetWorkspaceId }
          //   preset-migrate: { toPreset }
          //   favorite      : no payload (defaults to true)
          //   unfavorite    : no payload
          //   review        : no payload
          //   unreview      : no payload
          //   set-priority  : { priority: 1..5 }
          //   add-tags      : { tags: string[] }
          //   remove-tags   : { tags: string[] }
          const rawAction = typeof body.action === "string" ? body.action : "";
          const rawIds = Array.isArray(body.sessionIds) ? body.sessionIds : [];
          const ids = Array.from(new Set(rawIds.filter(id => typeof id === "string" && id.trim() !== "").map(id => id.trim())));
          for (const id of ids) assertSessionId(id);
          if (ids.length === 0) return send(res, 400, { ok: false, error: "sessionIds 必须是非空数组", code: "bad-request" });
          if (ids.length > 200) return send(res, 400, { ok: false, error: "单次批量最多 200 条，请缩小筛选范围后重试", code: "batch-too-large" });
          const payload = body.payload && typeof body.payload === "object" ? body.payload : {};
          const BATCH_ACTIONS = new Set(["archive", "unarchive", "delete", "move", "preset-migrate", "favorite", "unfavorite", "review", "unreview", "set-priority", "add-tags", "remove-tags"]);
          if (!BATCH_ACTIONS.has(rawAction)) return send(res, 400, { ok: false, error: "action 不支持: " + rawAction, code: "bad-request" });
          const items = [];
          let success = 0, failed = 0, skipped = 0;
          if (rawAction === "delete") {
            const deletedSet = new Set();
            for (const sessionId of ids) {
              if (deletedSet.has(sessionId)) {
                items.push({ sessionId, status: "success", cascaded: true, subagentCount: 0 });
                success++;
                continue;
              }
              try {
                const res = await mutate(sessionId, () => deleteSession(sessionId));
                deletedSet.add(sessionId);
                if (Array.isArray(res?.deletedSubagents)) {
                  for (const subId of res.deletedSubagents) {
                    deletedSet.add(subId);
                  }
                }
                items.push({
                  sessionId,
                  status: "success",
                  deletedSubagents: res?.deletedSubagents || [],
                  subagentCount: res?.subagentCount || 0,
                  warnings: res?.warnings || (res?.warning ? [res.warning] : [])
                });
                success++;
              } catch (error) {
                const code = error && typeof error.code === "string" ? error.code : undefined;
                if (Array.isArray(error?.deletedSubagentIds)) {
                  for (const subId of error.deletedSubagentIds) {
                    deletedSet.add(subId);
                  }
                }
                items.push({
                  sessionId,
                  status: "failed",
                  code,
                  error: safeErrorMessage(error),
                  deletedSubagents: error?.deletedSubagentIds || [],
                  remainingSessions: error?.remainingSessionIds || [sessionId],
                  partialFailure: Boolean(error?.partialFailure)
                });
                failed++;
              }
            }
          } else {
            for (const sessionId of ids) {
              try {
                await runBatchAction({ action: rawAction, sessionId, payload, mutate, deleteSession, unarchiveSession, moveSession, migratePreset, adapter });
                items.push({ sessionId, status: "success" });
                success++;
              } catch (error) {
                const code = error && typeof error.code === "string" ? error.code : undefined;
                if (code === "subagent-skip" || code === "blank-skip") {
                  items.push({ sessionId, status: "skipped", reason: code });
                  skipped++;
                } else {
                  items.push({ sessionId, status: "failed", code, error: safeErrorMessage(error) });
                  failed++;
                }
              }
            }
          }
          return send(res, 200, { ok: true, result: {
            summary: { total: ids.length, success, failed, skipped },
            items,
            aborted: false,
          } });
        }
        if (req.method === "GET" && path === "/delete-preview") {
          const rawId = url.searchParams.get("sessionId") || "";
          const sessionId = rawId.trim();
          if (sessionId) assertSessionId(sessionId);
          const rawIds = url.searchParams.get("sessionIds");
          let sessionIds = sessionId ? [sessionId] : [];
          if (rawIds) {
            const split = rawIds.split(",").map(s => s.trim()).filter(Boolean);
            for (const id of split) assertSessionId(id);
            sessionIds = Array.from(new Set([...sessionIds, ...split]));
          }
          if (sessionIds.length === 0) {
            return send(res, 400, { ok: false, error: "sessionId 或 sessionIds 必填" });
          }
          try {
            const descendants = await findDescendantSubagents(sessionIds);
            return send(res, 200, {
              ok: true,
              result: {
                subagentCount: descendants.length,
                subagents: descendants.map(d => ({ id: d.id, parentSession: d.parentSession }))
              }
            });
          } catch (err) {
            return send(res, 500, { ok: false, error: safeErrorMessage(err) });
          }
        }
        if (req.method === "GET" && path === "/workspaces") {
          const cachedHeaders = adapter.cachedSessionHeaders();
          const sessionCreatedAt = Object.fromEntries(cachedHeaders
            .filter(header => typeof header.createdAt === "number" || typeof header.createdAt === "string")
            .map(header => [header.id, header.createdAt]));
          const sessionUpdatedAt = Object.fromEntries(cachedHeaders
            .filter(header => header && (typeof header.updatedAt === "number" || typeof header.updatedAt === "string" || typeof header.lastModified === "number"))
            .map(header => [header.id, header.updatedAt ?? header.lastModified]));
          let workspaceArchivesMap = {};
          try {
            workspaceArchivesMap = await workspaceArchives().getAll();
          } catch (_) {}
          return send(res, 200, { ok: true, result: { workspaces: listWorkspaces(), sessionCreatedAt, sessionUpdatedAt, workspaceArchives: workspaceArchivesMap } });
        }
        if (req.method === "GET" && path === "/preset-scan") {
          const sessionId = url.searchParams.get("sessionId") || "";
          if (sessionId) assertSessionId(sessionId);
          const result = await scanPreset({ id: url.searchParams.get("workspaceId") || "", sessionId });
          return send(res, 200, { ok: true, result });
        }
        if (req.method === "GET" && path === "/update/check") {
          const currentVersion = adapter.pluginVersion() || "0.7.3";
          const pm = adapter.pluginManager;
          let bundles = [];
          if (typeof pm?.listBundles === "function") {
            try { bundles = await pm.listBundles(); } catch (_) {}
          }
          const source = detectPluginSource(adapter, ctx, bundles);
          if (source === "linked") {
            return send(res, 200, {
              ok: true,
              result: {
                currentVersion,
                latestVersion: currentVersion,
                hasUpdate: false,
                source: "linked",
                message: "开发模式（本地链接），请手动修改或拉取代码"
              }
            });
          }
          if (source === "github") {
            return send(res, 200, {
              ok: true,
              result: {
                currentVersion,
                latestVersion: currentVersion,
                hasUpdate: false,
                source: "github",
                message: "通过 Git/GitHub 安装，请通过 DSH 插件市场或 git 更新"
              }
            });
          }
          if (source === "installation") {
            return send(res, 200, {
              ok: true,
              result: {
                currentVersion,
                latestVersion: currentVersion,
                hasUpdate: false,
                source: "installation",
                message: "系统内置插件，无法独立更新"
              }
            });
          }
          if (source === "unknown") {
            return send(res, 200, {
              ok: true,
              result: {
                currentVersion,
                latestVersion: currentVersion,
                hasUpdate: false,
                source: "unknown",
                message: "无法确认插件安装来源，为保证安全已禁止自动更新"
              }
            });
          }
          let latestVersion = currentVersion;
          let hasUpdate = false;
          try {
            const envRegistry = process.env.NPM_CONFIG_REGISTRY?.trim();
            const requestedRegistry = url.searchParams.get("registry")?.trim();
            let registry = "https://registry.npmjs.org";
            if (requestedRegistry && requestedRegistry !== "https://registry.npmjs.org" && /^https?:\/\//i.test(requestedRegistry)) {
              registry = requestedRegistry;
            } else if (envRegistry && /^https?:\/\//i.test(envRegistry)) {
              registry = envRegistry;
            } else if (requestedRegistry && /^https?:\/\//i.test(requestedRegistry)) {
              registry = requestedRegistry;
            }
            const base = registry.endsWith("/") ? registry : registry + "/";
            const pkgUrl = new URL("dsh-session-manager/latest", base).toString();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            try {
              const response = await fetch(pkgUrl, {
                signal: controller.signal,
                headers: { "accept": "application/json" }
              });
              if (response.ok) {
                const data = await response.json();
                if (data && typeof data.version === "string") {
                  latestVersion = data.version;
                }
              }
            } finally {
              clearTimeout(timer);
            }
            hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
            return send(res, 200, {
              ok: true,
              result: { currentVersion, latestVersion, hasUpdate, source: "npm" }
            });
          } catch (err) {
            return send(res, 200, {
              ok: false,
              code: "update-check-failed",
              error: "检查更新失败: " + safeErrorMessage(err),
              result: { currentVersion, latestVersion: currentVersion, hasUpdate: false, source: "npm" }
            });
          }
        }
        if (req.method === "POST" && path === "/update/install") {
          const rawVersion = typeof body?.version === "string" ? body.version.trim() : "";
          if (rawVersion && !/^[a-zA-Z0-9_.-]+$/.test(rawVersion)) {
            return send(res, 400, { ok: false, code: "bad-request", error: "Invalid version format" });
          }

          const pm = adapter.pluginManager;
          if (!pm || typeof pm.installBundle !== "function") {
            return send(res, 501, {
              ok: false,
              code: "plugin-manager-unavailable",
              error: "当前宿主环境未提供 PluginManager 安装服务，请通过 DSH 插件市场或命令行更新"
            });
          }

          const profileDir = resolveProfileDir(adapter, ctx);

          // P1-3: Concurrency Mutex check
          if (activeUpdateTask && (Date.now() - activeUpdateTask.startedAt < ACTIVE_TASK_TIMEOUT_MS)) {
            return send(res, 409, {
              ok: false,
              code: "update-in-progress",
              error: "已有正在执行的更新任务 (" + activeUpdateTask.taskId + ")，请勿重复操作",
              taskId: activeUpdateTask.taskId
            });
          }
          const diskStatus = readUpdateStatus(profileDir);
          if (isTaskActive(diskStatus)) {
            return send(res, 409, {
              ok: false,
              code: "update-in-progress",
              error: "已有正在执行的更新任务 (" + diskStatus.taskId + ")，请勿重复操作",
              taskId: diskStatus.taskId
            });
          }

          // P1-4: Source check
          let bundles = [];
          if (typeof pm?.listBundles === "function") {
            try { bundles = await pm.listBundles(); } catch (_) {}
          }
          const source = detectPluginSource(adapter, ctx, bundles);
          if (source === "linked" || source === "github" || source === "installation") {
            return send(res, 400, {
              ok: false,
              code: "source-protected",
              error: "当前插件为 " + source + " 安装来源，无法通过 npm 覆盖更新"
            });
          }
          if (source === "unknown") {
            return send(res, 400, {
              ok: false,
              code: "source-unknown",
              error: "无法确认插件安装来源，已禁止自动更新以防破坏环境"
            });
          }

          const currentVersion = adapter.pluginVersion() || "0.7.3";
          const targetVersion = rawVersion || "latest";
          let resolvedTargetVersion = (targetVersion !== "latest") ? targetVersion : null;
          const envRegistry = process.env.NPM_CONFIG_REGISTRY?.trim();
          const requestedRegistry = typeof body?.registry === "string" && /^https?:\/\//i.test(body.registry.trim()) ? body.registry.trim() : "";
          const registry = (requestedRegistry && requestedRegistry !== "https://registry.npmjs.org")
            ? requestedRegistry
            : (envRegistry || requestedRegistry || "");

          if (!resolvedTargetVersion) {
            try {
              const regUrl = registry || process.env.NPM_CONFIG_REGISTRY || "https://registry.npmjs.org";
              const base = regUrl.endsWith("/") ? regUrl : regUrl + "/";
              const pkgUrl = new URL("dsh-session-manager/latest", base).toString();
              const ctrl = new AbortController();
              const timer = setTimeout(() => ctrl.abort(), 4000);
              try {
                const resp = await fetch(pkgUrl, { signal: ctrl.signal, headers: { accept: "application/json" } });
                if (resp.ok) {
                  const d = await resp.json();
                  if (d && typeof d.version === "string") {
                    resolvedTargetVersion = d.version;
                  }
                }
              } finally {
                clearTimeout(timer);
              }
            } catch (_) { /* fallback to outcome.version after install */ }
          }

          if (resolvedTargetVersion && currentVersion && currentVersion !== "unknown") {
            if (compareSemver(resolvedTargetVersion, currentVersion) <= 0) {
              return send(res, 400, {
                ok: false,
                code: "not-upgrade",
                error: "目标版本 (" + resolvedTargetVersion + ") 不高于当前安装版本 (" + currentVersion + ")"
              });
            }
          }
          const spec = "dsh-session-manager@" + (resolvedTargetVersion || targetVersion);
          const oldSpec = "dsh-session-manager@" + currentVersion;

          const taskId = (typeof body?.taskId === "string" && body.taskId.trim())
            ? body.taskId.trim()
            : ("update-" + Date.now() + "-" + randomBytes(4).toString("hex"));

          activeUpdateTask = { taskId, startedAt: Date.now() };

          writeUpdateStatus(profileDir, {
            taskId,
            status: "preparing",
            targetVersion: resolvedTargetVersion || targetVersion,
            currentVersion,
            source: "npm",
            startedAt: Date.now()
          });

          const isHmr = isHmrActive(adapter, ctx);
          const prevRegistry = process.env.NPM_CONFIG_REGISTRY;
          if (registry) {
            process.env.NPM_CONFIG_REGISTRY = registry;
          }

          // Capture locals before any potential scope teardown
          const localProfileDir = profileDir;
          const localSpec = spec;
          const localOldSpec = oldSpec;
          const localPm = pm;
          const localTaskId = taskId;
          const localTargetVersion = targetVersion;
          const localCurrentVersion = currentVersion;
          const localRegistry = registry;
          let localResolvedTargetVersion = resolvedTargetVersion;

          // Backup original package.json text if exists
          let originalPackageJsonText = null;
          try {
            if (localProfileDir) {
              const pkgPath = join(localProfileDir, "package.json");
              if (existsSync(pkgPath)) {
                originalPackageJsonText = readFileSync(pkgPath, "utf8");
              }
            }
          } catch (_) {}

          // Helper: perform rollback and record state
          const performRollback = async (triggerError, { newVersionInstalled = false } = {}) => {
            // Restore registry environment first so rollback is not blocked by custom registry failure
            if (registry) {
              if (prevRegistry !== undefined) {
                process.env.NPM_CONFIG_REGISTRY = prevRegistry;
              } else {
                delete process.env.NPM_CONFIG_REGISTRY;
              }
            }

            writeUpdateStatus(localProfileDir, {
              taskId: localTaskId,
              status: "rolling-back",
              targetVersion: localResolvedTargetVersion || localTargetVersion,
              currentVersion: localCurrentVersion,
              error: triggerError,
              rollingBackAt: Date.now()
            });

            // P0-2: In HMR mode, if new version was already installed into profile,
            // calling installBundle(oldSpec) directly throws "already-installed".
            // Therefore, we must remove the new version first.
            let cleanError = null;
            if (isHmr && newVersionInstalled) {
              if (typeof localPm.removeBundle === "function") {
                try {
                  const rmOutcome = await localPm.removeBundle("dsh-session-manager");
                  if (rmOutcome && (rmOutcome.application === "failed" || rmOutcome.application === "cancelled" || rmOutcome.ok === false)) {
                    cleanError = rmOutcome.error?.message || rmOutcome.error?.code || safeErrorMessage(rmOutcome.error) || ("application: " + rmOutcome.application);
                  }
                } catch (rmErr) {
                  cleanError = safeErrorMessage(rmErr);
                }
              }
            }

            if (cleanError) {
              const rbDetail = "清理安装失败的新版本失败: " + cleanError;
              activeUpdateTask = null;
              if (originalPackageJsonText && localProfileDir) {
                try { writeFileSync(join(localProfileDir, "package.json"), originalPackageJsonText, "utf8"); } catch (_) {}
              }
              writeUpdateStatus(localProfileDir, {
                taskId: localTaskId,
                status: "recovery-required",
                targetVersion: localResolvedTargetVersion || localTargetVersion,
                currentVersion: localCurrentVersion,
                rolledBack: false,
                error: triggerError,
                rollbackError: rbDetail,
                failedAt: Date.now()
              });
              if (!res.writableEnded) {
                return send(res, 500, {
                  ok: false,
                  code: "recovery-required",
                  error: "安装更新失败: " + triggerError + "（自动恢复旧版本失败: " + rbDetail + "，请手动重新安装插件）",
                  rolledBack: false,
                  rollbackError: rbDetail,
                  taskId: localTaskId
                });
              }
              return;
            }

            let rbOutcome = null;
            let rbError = null;
            try {
              rbOutcome = await (localRegistry ? localPm.installBundle(localOldSpec, { registry: localRegistry }) : localPm.installBundle(localOldSpec));
            } catch (err) {
              rbError = safeErrorMessage(err);
              // Fallback to default installBundle without registry option if custom registry fails
              if (localRegistry) {
                try {
                  rbOutcome = await localPm.installBundle(localOldSpec);
                  rbError = null;
                } catch (err2) {
                  rbError = safeErrorMessage(err2);
                }
              }
            }
            let installOk = rbOutcome && rbOutcome.application !== "failed" && rbOutcome.application !== "cancelled" && rbOutcome.ok !== false && !rbError;

            // If install failed, restore original package.json so user profile is not left without plugin
            if (!installOk && originalPackageJsonText && localProfileDir) {
              try {
                writeFileSync(join(localProfileDir, "package.json"), originalPackageJsonText, "utf8");
              } catch (_) {}
            }

            if (installOk && typeof localPm.selectBundle === "function") {
              try { await localPm.selectBundle("dsh-session-manager", true); } catch (_) {}
            }

            let verifiedOk = false;
            let verifyError = null;
            if (installOk) {
              const v = verifyInstalledPackage(localProfileDir, localCurrentVersion);
              verifiedOk = v.ok;
              if (!v.ok) verifyError = v.error;
            }
            activeUpdateTask = null;
            if (installOk && verifiedOk) {
              writeUpdateStatus(localProfileDir, {
                taskId: localTaskId,
                status: "rolled-back",
                targetVersion: localResolvedTargetVersion || localTargetVersion,
                currentVersion: localCurrentVersion,
                rolledBack: true,
                error: triggerError,
                failedAt: Date.now()
              });
              if (!res.writableEnded) {
                return send(res, 500, {
                  ok: false,
                  code: "install-failed",
                  error: "安装更新失败: " + triggerError + "（已自动恢复旧版本 v" + localCurrentVersion + "）",
                  rolledBack: true,
                  taskId: localTaskId
                });
              }
            } else {
              const rbDetail = rbError || verifyError || (rbOutcome?.error ? safeErrorMessage(rbOutcome.error) : "回滚安装未成功");
              writeUpdateStatus(localProfileDir, {
                taskId: localTaskId,
                status: "recovery-required",
                targetVersion: localResolvedTargetVersion || localTargetVersion,
                currentVersion: localCurrentVersion,
                rolledBack: false,
                error: triggerError,
                rollbackError: rbDetail,
                failedAt: Date.now()
              });
              if (!res.writableEnded) {
                return send(res, 500, {
                  ok: false,
                  code: "recovery-required",
                  error: "安装更新失败: " + triggerError + "（自动恢复旧版本失败: " + rbDetail + "，请手动重新安装插件）",
                  rolledBack: false,
                  rollbackError: rbDetail,
                  taskId: localTaskId
                });
              }
            }
          };

          try {
            if (isHmr && typeof localPm.removeBundle === "function") {
              // P0-1 & P0-2: Remove old bundle first in HMR
              writeUpdateStatus(localProfileDir, {
                taskId: localTaskId,
                status: "removing",
                targetVersion: localTargetVersion,
                currentVersion: localCurrentVersion,
                source: "npm",
                startedAt: activeUpdateTask.startedAt
              });

              let removeResult;
              try {
                removeResult = await localPm.removeBundle("dsh-session-manager");
              } catch (rmErr) {
                const failReason = safeErrorMessage(rmErr);
                activeUpdateTask = null;
                writeUpdateStatus(localProfileDir, {
                  taskId: localTaskId,
                  status: "failed",
                  stage: "removing",
                  targetVersion: localTargetVersion,
                  currentVersion: localCurrentVersion,
                  error: "卸载旧版本失败: " + failReason,
                  failedAt: Date.now()
                });
                return send(res, 500, {
                  ok: false,
                  code: "remove-failed",
                  error: "卸载旧版本失败: " + failReason,
                  taskId: localTaskId
                });
              }

              // P0-2: Strictly check removeBundle return value
              if (removeResult && (removeResult.application === "failed" || removeResult.application === "cancelled" || removeResult.ok === false)) {
                const failReason = removeResult.error?.message || removeResult.error?.code || safeErrorMessage(removeResult.error) || ("application: " + removeResult.application);
                if (removeResult.changed && typeof localPm.selectBundle === "function") {
                  try { await localPm.selectBundle("dsh-session-manager", true); } catch (_) {}
                }
                activeUpdateTask = null;
                writeUpdateStatus(localProfileDir, {
                  taskId: localTaskId,
                  status: "failed",
                  stage: "removing",
                  targetVersion: localTargetVersion,
                  currentVersion: localCurrentVersion,
                  error: "卸载旧版本失败: " + failReason,
                  failedAt: Date.now()
                });
                return send(res, 500, {
                  ok: false,
                  code: "remove-failed",
                  error: "卸载旧版本失败: " + failReason,
                  taskId: localTaskId
                });
              }

              writeUpdateStatus(localProfileDir, {
                taskId: localTaskId,
                status: "removed",
                targetVersion: localTargetVersion,
                currentVersion: localCurrentVersion,
                source: "npm",
                startedAt: activeUpdateTask.startedAt
              });
            }

            // Install target bundle
            writeUpdateStatus(localProfileDir, {
              taskId: localTaskId,
              status: "installing",
              targetVersion: localResolvedTargetVersion || localTargetVersion,
              currentVersion: localCurrentVersion,
              source: "npm",
              startedAt: activeUpdateTask.startedAt
            });

            let outcome;
            try {
              outcome = await (localRegistry ? localPm.installBundle(localSpec, { registry: localRegistry }) : localPm.installBundle(localSpec));
            } catch (err) {
              const errMsg = safeErrorMessage(err);
              if (isHmr) {
                // In HMR, old bundle was removed -> execute rollback (new version was not installed)
                return await performRollback(errMsg, { newVersionInstalled: false });
              } else {
                // In non-HMR, old bundle was not removed -> fail directly
                activeUpdateTask = null;
                writeUpdateStatus(localProfileDir, {
                  taskId: localTaskId,
                  status: "failed",
                  targetVersion: localResolvedTargetVersion || localTargetVersion,
                  currentVersion: localCurrentVersion,
                  error: errMsg,
                  failedAt: Date.now()
                });
                return send(res, 500, {
                  ok: false,
                  code: "install-failed",
                  error: "安装更新失败: " + errMsg,
                  taskId: localTaskId
                });
              }
            }

            // Check outcome application
            if (outcome && (outcome.application === "failed" || outcome.application === "cancelled" || outcome.ok === false)) {
              const failReason = outcome.error?.message || outcome.error || ("application: " + outcome.application);
              if (isHmr) {
                return await performRollback(failReason, { newVersionInstalled: false });
              } else {
                activeUpdateTask = null;
                writeUpdateStatus(localProfileDir, {
                  taskId: localTaskId,
                  status: "failed",
                  targetVersion: localResolvedTargetVersion || localTargetVersion,
                  currentVersion: localCurrentVersion,
                  error: failReason,
                  failedAt: Date.now()
                });
                return send(res, 500, {
                  ok: false,
                  code: "install-failed",
                  error: "安装更新失败: " + failReason,
                  taskId: localTaskId
                });
              }
            }

            if (!localResolvedTargetVersion && typeof outcome?.version === "string") {
              localResolvedTargetVersion = outcome.version;
            }
            const concreteTargetVersion = localResolvedTargetVersion || (localTargetVersion !== "latest" ? localTargetVersion : null);

            // P1-2: Strict post-install verification
            writeUpdateStatus(localProfileDir, {
              taskId: localTaskId,
              status: "verifying",
              targetVersion: concreteTargetVersion || localTargetVersion,
              currentVersion: localCurrentVersion,
              source: "npm",
              startedAt: activeUpdateTask.startedAt
            });

            const verifyResult = verifyInstalledPackage(localProfileDir, concreteTargetVersion);
            if (!verifyResult.ok) {
              const vError = "安装后校验失败: " + verifyResult.error;
              return await performRollback(vError, { newVersionInstalled: true });
            }

            // Completed!
            const application = outcome?.application || (isHmr ? "refresh-required" : "restart-required");
            activeUpdateTask = null;
            const finalInstalledVersion = verifyResult.version || concreteTargetVersion || localTargetVersion;
            writeUpdateStatus(localProfileDir, {
              taskId: localTaskId,
              status: "completed",
              targetVersion: finalInstalledVersion,
              currentVersion: localCurrentVersion,
              application,
              completedAt: Date.now()
            });

            if (!res.writableEnded) {
              return send(res, 200, {
                ok: true,
                result: {
                  application,
                  spec: localSpec,
                  version: finalInstalledVersion,
                  taskId: localTaskId
                }
              });
            }
          } finally {
            if (registry) {
              if (prevRegistry !== undefined) {
                process.env.NPM_CONFIG_REGISTRY = prevRegistry;
              } else {
                delete process.env.NPM_CONFIG_REGISTRY;
              }
            }
          }
        }
        if (req.method === "GET" && path === "/update/status") {
          const profileDir = resolveProfileDir(adapter, ctx);
          const currentVersion = adapter.pluginVersion() || "0.7.3";
          const updateStatus = readUpdateStatus(profileDir);
          const queryTaskId = url.searchParams.get("taskId")?.trim();

          if (queryTaskId) {
            if (updateStatus && updateStatus.taskId === queryTaskId) {
              return send(res, 200, {
                ok: true,
                result: {
                  ...updateStatus,
                  currentVersion
                }
              });
            }
            if (updateStatus && updateStatus.taskId && updateStatus.taskId !== queryTaskId) {
              return send(res, 200, {
                ok: true,
                result: {
                  status: "superseded",
                  taskId: queryTaskId,
                  activeTaskId: updateStatus.taskId,
                  currentVersion
                }
              });
            }
            return send(res, 200, {
              ok: true,
              result: {
                status: "idle",
                taskId: queryTaskId,
                currentVersion
              }
            });
          }

          const now = Date.now();
          if (updateStatus && (now - (updateStatus.completedAt || updateStatus.failedAt || updateStatus.startedAt || 0) < 10 * 60 * 1000)) {
            return send(res, 200, {
              ok: true,
              result: {
                ...updateStatus,
                currentVersion
              }
            });
          }
          return send(res, 200, {
            ok: true,
            result: {
              status: "idle",
              currentVersion
            }
          });
        }
        return send(res, 404, { ok: false, error: "not found: " + req.method + " " + path });
      } catch (error) {
        ctx.logger.warn("session-manager: api error: " + safeErrorMessage(error) + "; json=" + safeJson(error));
        const status = error?.code === "bad-request" ? 400 : error?.code === "body-too-large" ? 413
          : error?.code === "annotation-conflict" || error?.code === "annotations-busy" ? 409
          : error?.code === "session-not-found" ? 404 : error?.code?.startsWith("annotations-") ? 503 : 500;
        return send(res, status, {
          ok: false,
          error: safeErrorMessage(error),
          ...(typeof error?.code === "string" ? { code: error.code } : {}),
          ...(Array.isArray(error?.deletedSubagentIds) ? { deletedSubagents: error.deletedSubagentIds } : {}),
          ...(Array.isArray(error?.remainingSessionIds) ? { remainingSessions: error.remainingSessionIds } : {}),
          ...(typeof error?.partialFailure === "boolean" ? { partialFailure: error.partialFailure } : {})
        });
      }
    }
  }), "session-manager: http api");
}

export { listSessionHeaders, scanSessionHeaders, candidateSessionDirs, encodeFsSessionSegment, decodeFsSessionSegment, encodeProjectSegment, encodeSessionSegment, compareSemver };
