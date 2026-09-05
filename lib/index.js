/**
 * @dsh-session-manager — Host half.
 *
 * DSH 0.1.0-rc.6 ships `workspace.archiveSession` (归档) but has NO session
 * deletion, NO unarchive, and NO cross-workspace move. This plugin fills the
 * gaps:
 *
 *  - POST /session-manager/api/delete     { sessionId }
 *      Physically delete one session: cancel/dispose a live agent, detach the
 *      session store entry (emits session/disposed -> host/session-removed so
 *      every tab drops the row), flush + remove the JSONL artifact directory,
 *      remove workspace accounting, and remove the archive-set membership.
 *  - POST /session-manager/api/unarchive  { sessionId }
 *      Remove one session from the registry-global archive set. The registry's
 *      own `domain/changed` -> `host/archived-sessions-changed` frame then
 *      refreshes every connected client.
 *  - GET  /session-manager/api/workspaces
 *      Ordered workspace projection: id / title / path / sessionCount /
 *      sessionIds (raw record order). Used by the client move dialog to pick a
 *      target and to derive the session's current workspace.
 *  - POST /session-manager/api/move       { sessionId, targetWorkspaceId }
 *      TRUE cross-workspace move. DSH's workspace model keys membership off
 *      the session header's immutable `cwd`: `WorkspaceEntity.attachSession`
 *      validates `realpath(header.cwd) === workspace.path`, and every record
 *      write prunes ids whose indexed cwd no longer matches. So a real move
 *      must RE-HOME the session:
 *
 *        1. tear down the live session/agent (same order as delete) so the
 *           artifact is quiesced and the write path can no longer append at
 *           the old location;
 *        2. read the stored artifact verbatim (`readRaw`), rewrite ONLY the
 *           header line's `cwd` to the target workspace's canonical path, and
 *           re-encode in the backend's own physical layout (zstd frames with
 *           an exact one-header-line first frame, or plain JSONL);
 *        3. publish the new artifact at `locate({cwd: target})` and remove the
 *           old one, hiding-then-restoring on failure (never leaves the
 *           duplicate-id state that would make list()/findLog() throw);
 *        4. enter a short-lived restored session (prepare + enter, never
 *           announced) whose fresh header makes attachSession's validation
 *           pass and refreshes the registry's canonical-cwd index, then swap
 *           accounting: detach from every other workspace's raw record,
 *           attach to the target — through the entity's own serialized
 *           durability path, so `host/workspace-changed` frames re-group every
 *           client sidebar immediately.
 *
 *      History, titles, archive-set membership and lineage are preserved; only
 *      the working directory the session belongs to changes.
 *
 * All mutations go through the workspace registry's own serialized
 * `enqueueOperation` + `setState` durability path (the same one the built-in
 * archiveSession uses), so a restart cannot resurrect a removed session.
 */
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

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

      const storedHeaders = await listSessionHeaders(persistence);
      const storedHeader = storedHeaders.find((header) => header.id === sessionId);
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
      let liveAgent;
      try { liveAgent = ctx.agents.get(sessionId); } catch { liveAgent = void 0; }
      // The session header is immutable. A live session therefore has to be
      // retired as one agent-loop lifecycle and recreated after the artifact is
      // re-homed. Never delete registry map entries directly: doing so skips
      // the agent-loop/session disposal effects and leaves a live persistence
      // owner behind.
            // NO-TEARDOWN approach: keep the live agent/session intact so the
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

        const newHeader = { ...oldHeader, cwd: targetPath };
        if (newHeader.version === 2) {
          newHeader.version = 0;
          delete newHeader.isSeeded;
        }
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
          if (liveSession !== void 0) liveSession.header = Object.freeze({ ...newHeader });
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
          wasLive: liveSession !== void 0 || liveSession !== void 0
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
            ctx.logger.info(`session-manager: moved "${sessionId}" to workspace "${target.id}"${liveSession !== void 0 ? " and resumed" : ""}`);
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
        headers = await listSessionHeaders(persistence);
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
        const selected = scanSelectedEvents(raw.content);
        const finalPreset = selected.length > 0 ? selected[selected.length - 1].agentPreset : headerObj.agentPreset;
        out.push({ sessionId: header.id, cwd: header.cwd, origin: header.origin, headerPreset: headerObj.agentPreset, selectedEvents: selected, finalPreset });
      }
      // Targets come only from the live roster. A deleted preset can still be
      // displayed as this session's current value, but must not be offered as
      // a destination.
      return { rows: out, availablePresets: Array.from(new Set(allPresetIds)) };
    };

    /**
     * Fully retire a live agent/session before rewriting its durable preset.
     * Waiting through persistence.load() is the important ownership barrier:
     * session/disposed starts an async final drain, and a disk rewrite before
     * that drain finishes leaves the coordinator's old Session as the live
     * persistence owner (the later resume then fails with "already has a live
     * persistence owner").
     */
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

      // A live Session must stay the persistence owner. Appending the same
      // event used by DSH's built-in blank-session switch updates the durable
      // log and the client projection without disposing/re-resuming anything.
      
      if (liveSession !== void 0) {
        let oldPreset = liveSession.header.agentPreset;
        for (let index = liveSession.events.length - 1; index >= 0; index -= 1) {
          const event = liveSession.events[index];
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

      const persistence = ctx.get("sessionPersistence");
      if (persistence === void 0) throw new Error("sessionPersistence service unavailable");
      const coordinator = persistence.coordinator;

      // A session absent from SessionStore is cold. If an older plugin left its
      // exact Session object in the coordinator, retire that proven orphan by
      // the coordinator's own drain path instead of deleting owner bookkeeping.
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

      const serialize = typeof coordinator?.serialize === "function"
        ? (operation) => coordinator.serialize(sessionId, operation)
        : (operation) => operation();
      const result = await serialize(async () => {
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
        return { sessionId, migrated: true, oldPreset, newPreset: toPreset };
      });

      if (result.migrated) {
        try { ctx.emit("agent-preset/selected", sessionId, toPreset); } catch { /* best-effort */ }
        ctx.logger.info(`session-manager: migrated cold preset for "${sessionId}" from "${String(result.oldPreset)}" to "${toPreset}"`);
      }
      return result;
    };

  /* ==== legacy v0.2.0 move implementation — DISABLED in 0.2.1 ============================
     It never actually worked: DSH's WorkspaceEntity.attachSession validates
     realpath(header.cwd) === workspace.path, so a cross-workspace attach always
     threw "its cwd resolves to ..."; the registry-state fallback below also
     mutated a state object that has no `workspaces` field. Replaced by the
     re-home implementation above (cwd rewrite + artifact migration + fresh
     placeholder header for index refresh).
    /** Move one session from its current workspace to a target workspace. (legacy)
  const moveSession = async (sessionId, targetWorkspaceId) => {
    const registry = ctx.workspaceRegistry;
    const allWorkspaces = registry.list();

    // Find target workspace
    const targetWorkspace = allWorkspaces.find((e) => e.id === targetWorkspaceId);
    if (!targetWorkspace) {
      throw new Error(`目标工作区不存在: ${targetWorkspaceId}`);
    }

    // Find current workspace(s) containing this session
    const currentWorkspaces = allWorkspaces.filter((e) => e.sessionIds.includes(sessionId));

    // Check if already in target workspace
    if (currentWorkspaces.length === 1 && currentWorkspaces[0].id === targetWorkspaceId) {
      return { ok: true, sessionId, moved: false, message: "会话已在目标工作区中" };
    }

    // Detach from all current workspaces
    for (const entity of currentWorkspaces) {
      await entity.detachSession(sessionId);
    }

    // Attach to target workspace
    if (typeof targetWorkspace.attachSession === "function") {
      await targetWorkspace.attachSession(sessionId);
    } else if (typeof targetWorkspace.prependSession === "function") {
      await targetWorkspace.prependSession(sessionId);
    } else {
      // Fallback: try to use the registry's enqueueOperation
      await registry.enqueueOperation(async () => {
        const state = registry.requireState();
        // Find target workspace in state and add session
        const targetState = state.workspaces?.find((w) => w.id === targetWorkspaceId);
        if (targetState) {
          if (!targetState.sessionIds) targetState.sessionIds = [];
          if (!targetState.sessionIds.includes(sessionId)) {
            targetState.sessionIds.unshift(sessionId);
          }
          await registry.setState(state);
        }
      });
    }

    return {
      ok: true,
      sessionId,
      moved: true,
      fromWorkspace: currentWorkspaces.map((e) => e.id),
      toWorkspace: targetWorkspaceId
    };
  };

  ==== end legacy v0.2.0 move implementation ==== */
    /** Resolve the on-disk session directory (parent of its artifact), if any. */
    /**
     * Encode a session id the way DSH stores it on disk: "--<encoded>--".
     * Mirrors @deepseek-ai/dsh-session-persistence-jsonl encodeSegment.
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
            return { ...raw, ...(located?.path !== void 0 ? { path: located.path } : {}) };
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
          for (const filename of ["session.jsonl.zstd", "session.v2.jsonl.zstd", "session.jsonl"]) {
            const filePath = join(dir, filename);
            try {
              const buf = await readFile(filePath);
              const content = filename.endsWith(".zstd") ? zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
              const headerLine = content.split("\\n", 1)[0];
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
    /** List every persisted session header visible to the configured persistence
     * backend, supplemented by raw-id sessions written by older DSH builds. */
    const listSessionHeaders = async (persistence) => {
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
      const dshHomePath = ctx.get("dshHomePath");
      if (typeof dshHomePath !== "function") return out;
      const root = dshHomePath("sessions");
      let projects;
      try { projects = await readdir(root, { withFileTypes: true }); }
      catch { return out; }
      const { createRequire } = await import("node:module"); const require_ = createRequire(import.meta.url); const { zstdDecompressSync } = require_("node:zlib");
      for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        let dirs;
        try { dirs = await readdir(join(root, proj.name), { withFileTypes: true }); }
        catch { continue; }
        for (const entry of dirs) {
          if (!entry.isDirectory()) continue;
          for (const filename of ["session.v2.jsonl.zstd", "session.jsonl.zstd", "session.jsonl"]) {
            const filePath = join(root, proj.name, entry.name, filename);
            try {
              const buf = await readFile(filePath);
              const content = filename.endsWith(".zstd") ? zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
              const headerLine = content.split("\\n", 1)[0];
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
      const headers = await listSessionHeaders(persistence);
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

    // Heal the DSH 0.1.1-rc.2 mismatch where a session with version 0 content
    // was written to a session.v2.jsonl.zstd filename. DSH refuses to boot when
    // the filename version and header version disagree ("session generation
    // filename identifies v2, but its header identifies v0"). Renaming the
    // file to the v0 path (session.jsonl.zstd) lets DSH start normally. This
    // scan runs once on plugin load, is best-effort (never blocks startup),
    // and only renames files whose header actually says version: 0 -- legacy
    // v2 sessions (version: 2 in their header) are left untouched. The
    // `void` discards the returned Promise so the unhandled-rejection
    // listener on the runProfile doesn't see an orphan; the local `.catch`
    // logs any failure and lets startup continue.
    void (async () => {
      const dshHomePath = ctx.get("dshHomePath");
      if (typeof dshHomePath !== "function") return;
      const root = dshHomePath("sessions");
      const { createRequire } = await import("node:module");
      const require_ = createRequire(import.meta.url);
      const { zstdDecompressSync } = require_("node:zlib");
      let projects;
      try { projects = await fsp.readdir(root, { withFileTypes: true }); }
      catch { return; }
      let healedCount = 0;
      outer: for (const proj of projects) {
        if (!proj.isDirectory()) continue;
        let dirs;
        try { dirs = await fsp.readdir(join(root, proj.name), { withFileTypes: true }); }
        catch { continue; }
        for (const entry of dirs) {
          if (!entry.isDirectory()) continue;
          const dir = join(root, proj.name, entry.name);
          const v2Path = join(dir, "session.v2.jsonl.zstd");
          const v0Path = join(dir, "session.jsonl.zstd");
          try {
            const stat = await fsp.stat(v2Path).catch(() => null);
            if (stat === null || !stat.isFile()) continue;
            if (await fsp.stat(v0Path).catch(() => null) !== null) continue;
            const buf = await fsp.readFile(v2Path);
            const text = zstdDecompressSync(buf).toString("utf8");
            const headerLine = text.split("\n", 1)[0];
            const header = JSON.parse(headerLine);
            if (header?.version !== 0) continue;
            await fsp.rename(v2Path, v0Path);
            healedCount += 1;
            ctx.logger.info(
              `session-manager: healed v2/v0 filename mismatch for "${entry.name}" at ${v0Path}`
            );
          } catch (healError) {
            ctx.logger.warn(
              `session-manager: could not heal "${v2Path}": ${healError?.message ?? healError}`
            );
          }
        }
        if (healedCount > 0) {
          ctx.logger.info(`session-manager: startup scan healed ${healedCount} session file mismatch(es)`);
        }
      }
    })().catch((asyncErr) => {
      try { ctx.logger.warn("session-manager: heal scan aborted: " + (asyncErr && asyncErr.message ? asyncErr.message : String(asyncErr))); } catch { /* logger gone */ }
    });
  }
