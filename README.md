# dsh-session-manager — session manager for DeepSeek Harness

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

A DeepSeek Harness (DSH) Web plugin for session management: delete sessions, archive sessions, move sessions across workspaces, and migrate a session's Agent preset. Suggestions are welcome on GitHub.

## Features

- **Archive / unarchive** sessions.
- **Delete sessions** with an explicit irreversible-action confirmation.
- **Move to workspace**: preserves history, title, archive state, and derived-session relationships, and rewrites the session's working directory to the target workspace.
- **Migrate Agent preset**: change the preset on demand. Typical use case: when the original preset was renamed or removed and the session can no longer resume, you can repair that session.
- **Session manager panel**: browse active and archived sessions in the sidebar, and run Open, Archive / Unarchive, Move, Migrate preset, or Delete on each row.
- The current session's title area offers Archive / Unarchive, Move to workspace, and a red Delete session button.
- Each dialog button (Move, Migrate preset, Delete, plus the Session manager toggle) closes its own popup when clicked a second time, matching the built-in title-area buttons.

## Where to find the UI

- **Session title area (right side):** Archive / Unarchive, Move to workspace, Delete session.
- **Sidebar footer → Session manager:** browse all sessions (including archived ones) and operate on each one.

## Agent preset migration

Use this when a session can no longer resume because its original preset no longer exists, for example after removing a custom preset such as `router-standard`.

1. Open **Session manager**.
2. Locate the session and select **Migrate preset**.
3. Choose one of the currently available target presets and confirm.

The plugin determines the session's effective preset from its latest `agent-preset/selected` event when present; otherwise it uses the session header. It then rewrites that event in place (or appends a fresh one if the session has never recorded a selection), so the migration is durable and the prior entry remains visible in the event log as history. For a live session, the new event is appended in memory via `Session.append()` and flushed to disk via `SessionStore.flush()`; the api-gateway's chat panel sees the new preset on the next event fold.

> A preset migration changes session metadata only. It does not alter message history, files, or the selected workspace.

## Install

The plugin is listed in [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin), and can be installed directly from the **Plugin Marketplace** inside DSH.

### From dsh-market

```powershell
dsh plugin --profile web add npm:dsh-session-manager
```

### From GitHub

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

Restart DSH Web after installation. If the browser still holds an older client bundle, force refresh with `Ctrl+Shift+R`.

### Local development / runtime injection

```text
dev_inject_plugin {"dir": "<absolute path to this repository>"}
```

## Safety and behavior

- **Deletion is permanent**, so the UI always asks for confirmation.
- Move and Migrate preset do **not** tear down the live agent or session. They keep the in-memory session/agent alive, write the new artifact in place, update the in-memory session header to point at the new cwd (move) or append the new event (migrate), and refresh the workspace registry. The api-gateway's chat panel therefore stays "available" without a manual refresh.
- Move rewrites the session's stored `cwd`; subsequent tool calls run in the target workspace.
- Subagent sessions and transient blank-session placeholders are excluded from Delete, Move, and Migrate preset.
- The move path encodes the artifact in the backend's own physical layout (zstd frames with a one-header-line first frame, or plain JSONL), matching DSH's own writer. The migrate path rewrites the relevant event in place at the existing file.

## Compatibility

| Plugin version | Verified DSH version |
| --- | --- |
| 0.4.9 | v0.1.5-rc.1 |
| 0.4.8 | v0.1.5-rc.1 |
| 0.4.7 | v0.1.5-rc.1 |
| 0.4.4 | 0.1.3-alpha.2 |
| 0.4.1 | 0.1.3-alpha.2 |
| 0.4.0 | v0.1.2-rc.1 |
| 0.1.2 | v0.1.0-rc.7 |
| 0.1.1 | v0.1.0-rc.7 |
| 0.1.0 | v0.1.0-rc.7 |

The plugin is a Cordis plugin and declares `cordis: ">=4.0.0-rc <5"` as its peer dependency.

## Development

- `lib/index.js` is the host-side ESM plugin; `lib/client.js` is the Web client bundle. No build step is required.
- Before submitting changes, run:

```powershell
node --check lib/client.js
node --check lib/index.js
node --test test/*.test.mjs
node scripts/smoke-test.mjs
git diff --check
npm pack --dry-run
```

Release history is in [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

Thanks to everyone who installs and uses dsh-session-manager, and to the people who file issues and open pull requests to help improve it. This plugin is listed in [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Suggestions and feedback are welcome.

## License

[MIT](LICENSE)
