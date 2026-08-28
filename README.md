# dsh-session-manager — conversation manager for DeepSeek Harness

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)

A DeepSeek Harness (DSH) plugin for managing conversations safely from the Web UI.
It adds archive management, permanent deletion, cross-workspace moves, and
**per-conversation Agent preset migration**.

## Features

- **Archive and unarchive** conversations.
- **Delete conversations** with an explicit irreversible-action confirmation.
- **Move to workspace** while preserving conversation history, title, archive state,
  and derived-session relationships. The session's working directory is updated to
  the target workspace.
- **Migrate Agent preset for one conversation at a time.** This repairs a conversation
  when its original preset was renamed or removed.
- **Session manager** in the sidebar for browsing active and archived conversations,
  with per-row Open, Archive/Unarchive, Move, Delete, and Migrate preset actions.
- Header actions for the current conversation: Archive/Unarchive, Move to workspace,
  and a red Delete conversation action.

## Where to find the UI

- **Conversation header:** archive/unarchive, move to workspace, and delete.
- **Sidebar footer → Session manager:** browse all conversations, including archived
  ones, and perform actions for an individual conversation.
- **Session manager row → Migrate preset:** change the Agent preset for that one
  conversation only. There is no bulk migration action.

## Agent preset migration

Use this when a conversation can no longer resume because its original preset no
longer exists, for example after removing a custom preset such as
`router-standard`.

1. Open **Session manager**.
2. Locate the conversation and select **Migrate preset**.
3. Choose one of the currently available target presets and confirm.

The plugin determines the conversation's effective preset from its latest
`agent-preset/selected` event when present; otherwise it uses the session header.
It safely updates the relevant stored value, releases any live persistence owner,
and refreshes the session list. If the migrated conversation is open, reopen it
before continuing the chat.

> A preset migration changes conversation metadata only. It does not alter message
> history, files, or the selected workspace.

## Install

### From npm

```powershell
dsh plugin --profile web add npm:dsh-session-manager
```

### From GitHub

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

Restart DSH Web after installation. If a browser still has an older client bundle,
perform a hard refresh (`Ctrl+Shift+R`).

### Local development / runtime injection

```text
dev_inject_plugin {"dir": "<absolute path to this repository>"}
```

## HTTP API

The Web UI uses the following local endpoints. They are primarily useful for
integration and diagnostics.

```text
POST /session-manager/api/delete         { sessionId }
POST /session-manager/api/unarchive      { sessionId }
GET  /session-manager/api/workspaces
POST /session-manager/api/move           { sessionId, targetWorkspaceId }
GET  /session-manager/api/preset-scan?sessionId=<sessionId>
POST /session-manager/api/preset-migrate { sessionId, toPreset }
```

Example: migrate one conversation to `standard`.

```bash
curl -s -X POST http://127.0.0.1:3080/session-manager/api/preset-migrate \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-...","toPreset":"standard"}'
```

## Safety and behavior

- **Deletion is permanent.** The confirmation dialog is intentional.
- Moving a running conversation interrupts and closes it first, then refreshes the
  sidebar automatically. Open it from the target workspace to continue.
- Moving a conversation changes its stored `cwd`; subsequent tool calls run in the
  target workspace.
- Subagent and transient blank-session placeholders are excluded from destructive
  or migration operations.
- File rewrites use temporary files and atomic replacement where supported to avoid
  partial session artifacts.

## Compatibility and development

- The plugin is a Cordis plugin and declares `cordis >=4.0.0-rc <5` as a peer
  dependency.
- `lib/index.js` is the host-side ESM plugin and `lib/client.js` is the Web client
  bundle. There is no build step.
- Before submitting changes, run:

```powershell
node --check lib/client.js
node --check lib/index.js
git diff --check
node scripts/smoke-test.mjs
npm pack --dry-run
```

See [CHANGELOG.md](CHANGELOG.md) for release history.

## License

[MIT](LICENSE)
