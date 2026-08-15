/**
 * @dsh-external/dsh-session-manager — Host half.
 *
 * DSH 0.1.0-rc.6 ships `workspace.archiveSession` (归档) but has NO session
 * deletion and NO unarchive. This plugin fills both gaps:
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
 *
 * All mutations go through the workspace registry's own serialized
 * `enqueueOperation` + `setState` durability path (the same one the built-in
 * archiveSession uses), so a restart cannot resurrect a removed session.
 */
import { rm } from "node:fs/promises";
import { dirname } from "node:path";

export const name = "dsh-session-manager";

export const inject = [
  "webServer",
  "workspaceRegistry",
  "sessions",
  "agents",
  "sessionPersistence"
];

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

  /** Resolve the on-disk session directory (parent of its artifact), if any. */
  const sessionDirOf = async (sessionId) => {
    const persistence = ctx.get("sessionPersistence");
    if (persistence === void 0) return void 0;
    const headers = await persistence.list();
    const meta = headers.find((header) => header.id === sessionId);
    if (meta === void 0) return void 0;
    const location = persistence.locate(meta);
    if (location === void 0) return void 0;
    return dirname(location.path);
  };

  /**
   * Delete one session end to end. Returns a summary of what was torn down.
   * Idempotent-ish: unknown sessions resolve to { ok: true, deleted: false }.
   */
  const deleteSession = async (sessionId) => {
    const session = ctx.sessions.get(sessionId);
    const agent = ctx.agents.get(sessionId);

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
        }
      } catch { /* best-effort */ }
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

        return send(res, 404, { ok: false, error: `not found: ${req.method} ${path}` });
      } catch (error) {
        ctx.logger.warn(`session-manager: api error: ${String(error)}`);
        return send(res, 500, { ok: false, error: String(error instanceof Error ? error.message : error) });
      }
    }
  }), "session-manager: http api");
}
