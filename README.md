# dsh-session-manager — session manager for DeepSeek Harness

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

DSH Web session manager: delete, archive, move across workspaces, migrate preset; favorites, review-later, search, sort, priority, add tags and notes (manual / semi-automated). Suggestions are welcome on GitHub.

## Features

### Session lifecycle

- **Archive / unarchive** sessions.
- **Delete sessions** with an explicit irreversible-action confirmation. Deletion is rejected for subagent sessions and transient blank placeholders.
- **Move to workspace**: preserves history, title, archive state, and derived-session relationships, and rewrites the session's working directory (`cwd`) to the target workspace. The move updates the live writer's header in place so any pending tool calls keep landing on the new path.
- **Migrate Agent preset**: change the preset on demand. Typical use case: when the original preset was renamed or removed and the session can no longer resume, you can repair that session. The migration rewrites the latest `agent-preset/selected` event (or the session header if no such event exists) without altering message history.

### Session manager panel (sidebar)

- Browse active and archived sessions, switch workspaces, and filter, sort, search across the list.
- Open a session directly from a row, or click a tag chip to filter the list to that tag.
- Per-row actions: **Open**, **Archive / Unarchive**, **Move**, **Migrate preset**, **Delete**.
- Each popup dialog (Move / Migrate preset / Delete / the panel itself) toggles closed when its trigger is clicked a second time, matching the built-in title-area buttons.

### Search, filters, and sorting

- Case-insensitive title and session-ID search; whitespace is trimmed. Message history is never read.
- Combine a workspace selector (All / Ungrouped / specific) with the archive filter (All / Active / Archived).
- Combine favorite/review flags, tag and priority filters; sort by recently updated (default), least recently updated, newest created, oldest created, or **priority (1 → 5)**.
- See matching/total counts and reset all view controls together. These controls only affect the manager panel — workspace membership, archive state, and the native sidebar ordering are untouched.
- Failed workspace loads can be retried without losing search, sort state.

### Favorites, review flags, tags, notes and priority

- Favorite / Review / **Tags/Notes** / priority controls are reachable from both the **title bar** (current session) and the **manager panel** (every row).
- Favorites and review flags are manual — independent of archive / running state, never cleared automatically.
- Priority is a dropdown **1 Highest, 2 High, 3 Normal, 4 Low, 5 Lowest** with **3 (Normal) as the default**; the manager row and title bar always show a P1–P5 badge. Legacy `null` priorities are normalized to 3.
- Tags: up to 20 per session, 32 characters each. Both English `,` and Chinese `，` are separators, whitespace is trimmed, duplicates are merged case-insensitively.
- Notes: plain multiline text, up to 2000 characters.
- Tags, notes and the AI **paste** textarea all share the same `sm-noteInput` style and `rows: 3` height (60px min-height), so the three input boxes line up visually.
- The "Tags/Notes" editor also surfaces **Copy Prompt** / **Import** controls for AI-assisted tagging (see below).
- Annotations are stored as plain text in `dsh-session-manager/annotations.v1.json` under the DSH home, keyed by session ID. They do not rewrite history or enter model context automatically. Move / Migrate preserve them; Delete cleans them up (and reports cleanup failures separately).
- Both UI surfaces share live state. Same-origin browser tabs receive change notifications via `BroadcastChannel`; refocusing or reopening the manager refreshes data.
- Saves are atomic, use a cross-process lock, and never silently overwrite another editor: revision conflicts surface a "load latest" prompt. Unsaved drafts survive a save failure.
- A crash-left `annotations.v1.lock` is not forcibly removed; verify no writer is active before handling it.

### AI-assisted tagging (manual, opt-in)

The **Tags/Notes** editor has two extra buttons above the paste box. Neither calls a model automatically — both keep you in control:

- **复制 Prompt** / **Copy Prompt** copies a structured prompt (Chinese or English, matched to the active UI language) to the clipboard. Paste it into the current conversation to ask the model to generate tags / note / priority within the plugin's limits.
- **导入** / **Import** reads the clipboard, extracts the first JSON object (tolerating Markdown fences, conversational wrappers, smart quotes, stray backslashes and a leading BOM), validates it against the same limits, and populates the editor fields. Oversized notes are truncated; invalid tags / priority are dropped with reasons. Importing into a dirty draft asks for confirmation first. If parsing still fails, the error message includes the actual `JSON.parse` position from each recovery attempt so you can see exactly which character broke it.

The prompt templates and import parser live in `lib/clipboard-parser.js` and are bundled into the client; no build step or network call is required.

### Current session title bar

The right side of the title area offers:

- **Archive / Unarchive** the current session.
- **Move to workspace** with a workspace picker.
- A red **Delete session** button with confirmation.

The same buttons appear in the manager row.
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

- **Deletion is permanent**, so the UI always asks for confirmation. The API checks the session ID, directory boundary and artifact header before deletion; traversal, symlinks and junctions are refused.
- Move and preset migration retain the live session/agent; deletion cancels and disposes it. Move updates the stored cwd and the existing live writer's header.
- The management list hides subagent sessions and the move API rejects them. Blank sessions without a persisted artifact cannot be moved.
- Cold rewrites preserve the artifact's stored format rather than forcing a v2 → v3 upgrade. Moves and rewrites refuse corrupt/truncated Zstd logs or JSONL logs with incomplete final lines instead of publishing partial history.
- Preset migration separates backup, publication and rollback. If rollback fails, recovery files are retained and their paths are included in the error; do not remove them.
- Incomplete startup scans skip workspace reconciliation. Complete scans preserve live sessions and membership added during the scan.
- Plugin mutations are serialized per session and request bodies are limited to 64 KiB. This queue supplements, rather than replaces, DSH's persistence coordination.

## Compatibility

| Plugin version | Verified DSH version |
| --- | --- |
| 0.5.1 | v0.1.6-alpha.2 |
| 0.4.11 | v0.1.5-rc.2 |
| 0.4.10 | v0.1.5-rc.1 |
| 0.4.9 | v0.1.5-rc.1 |
| 0.4.7 | v0.1.5-rc.1 |
| 0.4.4 | 0.1.3-alpha.2 |
| 0.4.1 | 0.1.3-alpha.2 |
| 0.4.0 | v0.1.2-rc.1 |
| 0.1.2 | v0.1.0-rc.7 |
| 0.1.1 | v0.1.0-rc.7 |
| 0.1.0 | v0.1.0-rc.7 |

Requires Node.js 22.15+ (22.x) or 24+ for built-in Zstd support.

The plugin is a Cordis plugin and declares `cordis: ">=4.0.0-rc <5"` as its peer dependency.

## Development

- `lib/index.js` is the host-side ESM plugin; `lib/client.js` is the Web client bundle. No build step is required.
- Before submitting changes, run:

```powershell
npm run check
npm test
npm run check:package
git diff --check
```

Tests use isolated temporary directories and the real plugin entry point, never real sessions. CI runs these checks on Windows/Linux with Node 22.15.0/24.

Optional integration check: run `node scripts/smoke-test.mjs` against a running test instance of DSH Web. This contacts a real service and is not part of the default unit test suite.

Release history is in [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

Thanks to everyone who installs and uses dsh-session-manager, and to the people who file issues and open pull requests to help improve it. This plugin is listed in [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Suggestions and feedback are welcome.

## License

[MIT](LICENSE)
