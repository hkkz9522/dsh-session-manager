# dsh-session-manager — conversation manager for DeepSeek Harness

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)

A DeepSeek Harness (DSH) Web plugin for conversation management: delete conversations, archive conversations, move conversations across workspaces, and migrate a conversation's Agent preset. Suggestions are welcome on GitHub.

## Features

- **Archive / unarchive** conversations.
- **Delete conversations** with an explicit irreversible-action confirmation.
- **Move to workspace**: preserves history, title, archive state, and derived-session relationships, and updates the conversation's working directory to the target workspace.
- **Migrate Agent preset**: change the preset on demand. Typical use case: when the original preset was renamed or removed and the conversation can no longer resume, you can repair that conversation.
- **Session manager**: browse active and archived conversations in the sidebar, and run Open, Archive / Unarchive, Move, Delete, or Migrate preset on each row.
- The current conversation's title area offers Archive / Unarchive, Move to workspace, and a red Delete conversation button.

## Where to find the UI

- **Conversation title area (right side):** archive/unarchive, move to workspace, delete conversation.
- **Sidebar footer → Session manager:** browse all conversations (including archived ones) and operate on each one.

## Agent preset migration

1. Open **Session manager**.
2. Locate the target conversation and click **Migrate preset**.
3. Pick a target preset from the currently available presets and confirm.

Example: when a conversation can no longer resume and the error indicates the original Agent preset no longer exists (for example, after deleting `router-standard`), use the migration feature.

The plugin prefers the most recent `agent-preset/selected` event with a valid preset; if that event does not exist, it falls back to the preset recorded in the session header. Migration safely rewrites the corresponding persisted value, releases any lingering live persistence owner, and refreshes the session list. If the migrated conversation is currently active, reopen it after the migration to continue.

> Preset migration only changes conversation metadata. It does not rewrite message history, files, or the current workspace.

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

Example: migrate a conversation to the `standard` preset.

```bash
curl -s -X POST http://127.0.0.1:3080/session-manager/api/preset-migrate \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-...","toPreset":"standard"}'
```

## Safety and behavior

- **Deletion is permanent**, so the UI always asks for confirmation.
- Moving a running conversation first interrupts and closes it, then refreshes the sidebar; reopen the conversation from the target workspace to continue.
- Move rewrites the conversation's stored `cwd`; subsequent tool calls run in the target workspace.
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

Thanks to everyone who installs and uses dsh-session-manager, and to the people who file issues and open pull requests to help improve it.

This plugin is listed in [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).

Suggestions and feedback are welcome.

## License

[MIT](LICENSE)
