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
- **Move to workspace**: preserves history, title, archive state, and derived-session relationships, and updates the session's working directory to the target workspace.
- **Migrate Agent preset**: change the preset on demand. Typical use case: when the original preset was renamed or removed and the session can no longer resume, you can repair that session.
- **Session manager**: browse active and archived sessions in the sidebar, and run Open, Archive / Unarchive, Move, Delete, or Migrate preset on each row.
- The current session's title area offers Archive / Unarchive, Move to workspace, and a red Delete session button.

## Where to find the UI

- **Session title area (right side):** archive/unarchive, move to workspace, delete session.
- **Sidebar footer → Session manager:** browse all sessions (including archived ones) and operate on each one.

## Agent preset migration

Use this when a session can no longer resume because its original preset no longer exists, for example after removing a custom preset such as `router-standard`.

1. Open **Session manager**.
2. Locate the session and select **Migrate preset**.
3. Choose one of the currently available target presets and confirm.

The plugin determines the session's effective preset from its latest `agent-preset/selected` event when present; otherwise it uses the session header. It safely updates the relevant stored value, releases any live persistence owner, and refreshes the session list. If the migrated session is open, reopen it before continuing the chat.

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

## HTTP API

The following local endpoints are used by the Web UI and are also useful for integration and diagnostics:

```text
POST /session-manager/api/delete         { sessionId }
POST /session-manager/api/unarchive      { sessionId }
GET  /session-manager/api/workspaces
POST /session-manager/api/move           { sessionId, targetWorkspaceId }
GET  /session-manager/api/preset-scan?sessionId=<sessionId>
POST /session-manager/api/preset-migrate { sessionId, toPreset }
```

Example: migrate a session to the `standard` preset.

```bash
curl -s -X POST http://127.0.0.1:3080/session-manager/api/preset-migrate \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-...","toPreset":"standard"}'
```

## Safety and behavior

- **Deletion is permanent**, so the UI always asks for confirmation.
- Moving a running session first interrupts and closes it, then refreshes the sidebar; reopen the session from the target workspace to continue.
- Move rewrites the session's stored `cwd`; subsequent tool calls run in the target workspace.
- Subagent sessions and transient blank-session placeholders are excluded from delete, move, and preset migration.
- File rewrites use temporary files and atomic replacement (when supported by the environment) to avoid partially written session artifacts.

## Compatibility and development

- This is a Cordis plugin with peer dependency `cordis >=4.0.0-rc <5`.
- `lib/index.js` is the host-side ESM plugin, `lib/client.js` is the Web client bundle; no build step is required.
- Before submitting changes, run:

```powershell
node --check lib/client.js
node --check lib/index.js
git diff --check
node scripts/smoke-test.mjs
npm pack --dry-run
```

Release history is in [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

Thanks to everyone who installs and uses dsh-session-manager, and to the people who file issues and open pull requests to help improve it. This plugin is listed in [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Suggestions and feedback are welcome.

## License

[MIT](LICENSE)
