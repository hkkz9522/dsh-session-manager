/** Compatibility boundary for DSH services used by dsh-session-manager.
 *
 * DSH service names are the supported seam. Concrete implementations
 * expose optional surfaces that changed during the 0.1.x line; keep all
 * probes here so route code can fail closed and diagnostics may
 * explain what this build actually provides.
 *
 * @module dsh-session-manager/compat/dsh-adapter
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);

/** Pull one service out of the Cordis ctx, tolerating direct property fallbacks. */
function getService(ctx, name) {
  try {
    const value = typeof ctx?.get === "function" ? ctx.get(name) : undefined;
    if (value !== undefined) return value;
  } catch { /* fall through to the legacy direct property */ }
  return ctx && ctx[name];
}

/** Read one package's version from its package.json if resolvable from this plugin. */
function packageVersion(name) {
  try {
    const manifest = require(name + "/package.json");
    return typeof manifest?.version === "string" ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Locate the dsh-cli installation by scanning process.argv for an
 * `apps/cli/` segment and reading its package.json (or the workspace root).
 * Falls back silently when the host is not the dsh CLI (e.g. a test harness).
 */
function versionFromArgv() {
  // process.argv on Windows mixes single backslashes, escaped double backslashes,
  // and forward slashes depending on how the host launched the binary. Match
  // "/apps/cli/" by normalizing any of those separators to a single "/" first,
  // then fall back to checking the parent of bin.js (covers dist bundles that
  // relocate the bin path under lib/bin.js).
  for (const arg of process.argv) {
    const normalized = String(arg).replaceAll("\\\\", "/").replaceAll("\\", "/");
    let at = normalized.indexOf("/apps/cli/");
    if (at < 0) {
      // dist/ build: bin.js sits under apps/cli/lib/ rather than directly
      // under apps/cli/, so anchor on the bin file basename instead.
      const binIdx = normalized.lastIndexOf("/bin.");
      if (binIdx >= 0) at = normalized.indexOf("/apps/cli/", binIdx);
    }
    if (at < 0) continue;
    const root = normalized.slice(0, at);
    for (const file of [join(root, "apps", "cli", "package.json"), join(root, "package.json")]) {
      try {
        const manifest = JSON.parse(readFileSync(file, "utf8"));
        if (typeof manifest.version === "string") return manifest.version;
      } catch { /* try the next candidate */ }
    }
  }
  return undefined;
}

/** Normalize a persistence list item from both snapshot (header field) and raw header shapes. **/
export function normalizeSessionHeader(value) {
  if (value === undefined || value === null) return undefined;
  const header = value?.header && typeof value.header === "object" ? value.header : value;
  return header && typeof header.id === "string" ? header : undefined;
}


export function normalizeSessionHeaders(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    const header = normalizeSessionHeader(value);
    if (header !== undefined) out.push(header);
  }
  return out;
}

/**
 * Build the adapter. Exposes the public DSH surfaces this plugin needs and a
 * `capabilities()` snapshot for diagnostics.
 */
export function createDshAdapter(ctx) {
  const adapter = {
    get workspaceRegistry() { return getService(ctx, "workspaceRegistry"); },
    get sessions() { return getService(ctx, "sessions"); },
    get agents() { return getService(ctx, "agents"); },
    get persistence() { return getService(ctx, "sessionPersistence"); },
    get agentPresets() { return getService(ctx, "agentPresets"); },
    get projectionCache() { return getService(ctx, "sessionProjectionCache"); },
    get homePath() { return getService(ctx, "dshHomePath"); },

    getSession(id) {
      try { return adapter.sessions && adapter.sessions.get && adapter.sessions.get(id); } catch { return undefined; }
    },
    getAgent(id) {
      try { return adapter.agents && adapter.agents.get && adapter.agents.get(id); } catch { return undefined; }
    },
    getSessionEvents(session) {
      if (Array.isArray(session && session.events)) return session.events;
      return [];
    },
    normalizeSessionHeader,
    normalizeSessionHeaders,
    async listSessionHeaders() {
      const persistence = adapter.persistence;
      if (!persistence || typeof persistence.list !== "function") return [];
      return normalizeSessionHeaders(await persistence.list());
    },
    capabilities() {
      const persistence = adapter.persistence;
      const registry = adapter.workspaceRegistry;
      const sessions = adapter.sessions;
      let workspaces = [];
      try { workspaces = registry && typeof registry.list === "function" ? registry.list() : []; } catch { /* diagnostic only */ }
      let sampleSession;
      try { sampleSession = sessions && sessions.list && sessions.list() && sessions.list()[0]; } catch { /* diagnostic only */ }
      return {
        sessionList: !!(persistence && typeof persistence.list === "function"),
        sessionStat: !!(persistence && typeof persistence.stat === "function"),
        sessionHandleOpen: !!(persistence && typeof persistence.open === "function"),
        persistenceLocate: !!(persistence && typeof persistence.locate === "function"),
        persistenceResolveLog: !!(persistence && typeof persistence.resolveLog === "function"),
        workspaceList: !!(registry && typeof registry.list === "function"),
        workspaceAttach: !!(workspaces[0] && typeof workspaces[0].attachSession === "function"),
        workspaceDetach: !!(workspaces[0] && typeof workspaces[0].detachSession === "function"),
        sessionStore: !!(sessions && typeof sessions.get === "function"),
        liveSessionEvents: !!(sampleSession && Array.isArray(sampleSession.events)),
      };
    },
    dshVersion() {
      return process.env.DSH_VERSION
        || packageVersion("@deepseek-ai/dsh")
        || packageVersion("@deepseek-ai/dsh-cli")
        || versionFromArgv()
        || "unknown";
    },    async openSessionRead(id) {
      const persistence = adapter.persistence;
      if (!persistence || typeof persistence.open !== "function") {
        throw new Error("dsh-session-manager: SessionPersistence.open is unavailable; the read path will fall back to disk");
      }
      return await persistence.open(id, "read");
    },
    async statSession(id) {
      const persistence = adapter.persistence;
      if (!persistence || typeof persistence.stat !== "function") return undefined;
      return await persistence.stat(id);
    },
    async resolveSessionPath(id) {
      const persistence = adapter.persistence;
      if (!persistence) return undefined;
      if (typeof persistence.resolveLog === "function") {
        try { return await persistence.resolveLog(id); } catch { return undefined; }
      }
      if (typeof persistence.locate === "function") {
        const header = { id: id };
        try {
          const located = persistence.locate(header);
          return located && located.path;
        } catch { return undefined; }
      }
      return undefined;
    },
    async listSessionSnapshots() {
      const persistence = adapter.persistence;
      if (!persistence || typeof persistence.list !== "function") return [];
      try { return await persistence.list(); } catch { return []; }
    },
    workspaceEntityFor(workspaceId) {
      const registry = adapter.workspaceRegistry;
      if (!registry || typeof registry.get !== "function") return undefined;
      try { return registry.get(workspaceId); } catch { return undefined; }
    },
    workspaceList() {
      const registry = adapter.workspaceRegistry;
      if (!registry || typeof registry.list !== "function") return [];
      try { return registry.list(); } catch { return []; }
    },
    async readSessionEvents(id, max) {
      const handle = await adapter.openSessionRead(id);
      try {
        return await handle.read(0, typeof max === "number" ? max : 1024);
      } finally {
        if (typeof handle.close === "function") {
          try { await handle.close(); } catch { /* best-effort */ }
        }
      }
    },
    pluginVersion() {
      return packageVersion("dsh-session-manager") || "unknown";
    },
  };
  return adapter;
}
