# dsh-session-manager — conversation manager (delete + archive)

[中文](README.zh.md) | English

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-repo-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)

Adds two capabilities that are missing from DeepSeek Harness Web:

1. **Delete conversations** (with an explicit confirmation dialog): physically deletes a
   session — stops and disposes its agent, detaches the session store entry (every tab
   drops the row), removes the JSONL directory from disk, and cleans up workspace
   accounting and the archive set.
2. **Archive management**: archive (`workspace.archiveSession`, built in) and
   **unarchive** (missing in rc.6 — this plugin implements it on the host side through
   the workspace registry's own persistence queue, with
   `host/archived-sessions-changed` frames keeping every client in sync).

## Features

- 🗑 **Delete sessions**: a "Delete session…" button in the conversation header plus a
  per-row delete in the manager panel — every path requires confirmation.
- 📦 **Archive / unarchive**: header button + per-row actions in the panel.
- 📋 **Session manager panel** (sidebar footer entry): filter by All / Active / Archived
  (archived sessions are invisible in the sidebar — the panel is where you find them
  again), with per-row Open / Archive / Unarchive / Delete.
- 🏷 Status badges: archived / running / current; relative time and workspace directory.
- ⚠️ The delete dialog shows the session title and an "irreversible" warning; for a
  running session it warns that deletion will interrupt it immediately.

## Where the UI lives

| Location | Content |
|---|---|
| Conversation header (next to the session title) | "Archive / Unarchive" and "Delete session…" (red, confirmation dialog) buttons |
| Sidebar footer | "会话管理" button that opens the full manager panel |

## Install

### From npm (recommended)

```powershell
dsh plugin --profile web add dsh-session-manager
```

Restart the web app to activate (profile bundle auto-assembles; `lib/` is the runtime
artifact, no build step).

### From GitHub (alternative)

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

### Local development / runtime injection

After cloning, inject in a web session that has
[dsh-super-injector](https://github.com/yjh051108/dsh-super-injector) resident
(activates immediately, no restart):

```
dev_inject_plugin {"dir": "<absolute path to the repo>"}
```

## Uninstall

- Installed via `dsh plugin add`: remove the entry from `dsh.profile.bundles` and
  `dependencies` in `~/.dsh/profiles/web/package.json`, then restart.
- Installed via runtime injection: `dev_uninject_plugin {"name": "dsh-session-manager"}`

## Compatibility (DSH upgrades)

- **Client UI** uses only the official plugin surface (slot contracts
  `conversation.session.header.actions` / `sidebar.footer.action`, the standard toolkit
  `useSessions` / `useWorkspaces` / `t`, locale, client bundle format) — upgrades are
  very likely seamless.
- **Host side** imports no `@deepseek-ai` package (only Node built-ins), so it never
  fails at load time after an upgrade. Delete/unarchive rely on a few internals that
  rc.6 does not expose publicly (accessed defensively); if a future version refactors
  them, you get a runtime error rather than a crash — adapt per the error message.
- `peerDependencies` declares only the `cordis` range; no hard-coded DSH version.
- After an upgrade, self-check once: create a blank session and delete it (end-to-end,
  30 s), or run `node scripts/smoke-test.mjs` (read-only smoke checks of the two host
  endpoints; touches no real session).

## Development & maintenance

- **No build step**: `lib/` is the runtime artifact (host is ESM; client is a hand-written
  loader-factory bundle).
- **Smoke test**: `node scripts/smoke-test.mjs [baseUrl]` (needs a running dsh web).
- **CI** (`.github/workflows/ci.yml`): `node --check` on both files + `npm pack --dry-run`
  content assertion.
- Changes are tracked in [CHANGELOG.md](./CHANGELOG.md).

## Implementation notes

- **Host** (`lib/index.js`): a cordis plugin injecting
  `webServer / workspaceRegistry / sessions / agents / sessionPersistence`, exposing two
  HTTP endpoints:
  - `POST /session-manager/api/delete { sessionId }`
  - `POST /session-manager/api/unarchive { sessionId }`
- **Client** (`lib/client.js`): a loader-factory bundle registering two slots:
  - `conversation.session.header.actions` (per-session actions + delete confirmation)
  - `sidebar.footer.action` (manager panel entry)

Delete of a live session: `agent.cancel` (interrupt) → `agent.scope.dispose` (quietly
dispose the agent fiber, 3 s cap) → drop the zombie entry from the agents registry →
`sessions.flush` → detach the session store entry (`session/disposed` → all clients
remove the row) → workspace accounting cleanup → archive-set cleanup → remove the on-disk
directory.

## Risks & limitations

- Deletion is irreversible (physical file removal); the UI always asks for confirmation.
- Deleting a live session touches host internals (session store / agent registry
  instance fields); a future DSH refactor may require adapting the plugin (all access is
  defensive).
- An archived session whose files were removed externally will just reappear in the list
  on unarchive (the row may not display).

## License

[MIT](./LICENSE)

Free to use, modify, copy, and distribute (including commercially) as long as the
copyright notice and this license text are retained. The project is provided "as is",
without warranty of any kind, express or implied. See [LICENSE](./LICENSE) for the full
terms.
