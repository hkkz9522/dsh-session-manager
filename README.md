# dsh-session-manager — session manager for DeepSeek Harness

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## 0 Overview

DSH Web session manager: delete, archive, move across workspaces, migrate preset; favorites, review-later, search, sort, priority, add tags and notes; bulk processing. Suggestions and feedback are welcome on GitHub.

## 1 Features

### 1.1 Session lifecycle management

- **Delete** is irreversible and always asks for confirmation. Subagent sessions and transient blank placeholders (no persisted artifact) cannot be deleted.
- **Archive / Unarchive** moves a session in and out of the active list without touching its disk content.
- **Move to workspace** keeps history, title, archive state and derived-session relationships intact, rewrites the session's `cwd` to the target workspace, and updates the live writer's header in place so any pending tool calls keep landing on the new path.
- **Migrate Agent preset** rewrites the latest `agent-preset/selected` event (or the session header if no such event exists) so a session whose preset was renamed or removed can resume. Message history is never altered.

### 1.2 Session shortcuts

- **Favorites / Review-later** are manual flags that survive archive and session end; neither is cleared automatically.
- **Search** matches title, session ID, note and tags case-insensitively, trims whitespace, and never reads chat history.
- **Filters and sorting** combine a workspace selector (All / Ungrouped / specific) with an archive filter (All / Active / Archived), then layer favorites / review, tag and priority filters on top. Sort by recently updated (default), least recently updated, newest created, oldest created, or **priority (1 → 5)**.
- **Priority** is a dropdown **1 Highest, 2 High, 3 Normal, 4 Low, 5 Lowest**, default **3 (Normal)**; legacy `null` priorities are normalized to 3.
- **Tags / Notes**: up to 20 tags per session (≤ 32 characters each) and a 2000-character note. Both English `,` and Chinese `，` are separators, whitespace is trimmed, duplicate tags are merged case-insensitively.
- **AI-assisted tagging** is manual and opt-in: **Copy Prompt** writes a structured prompt (Chinese or English, matched to the active UI) to the clipboard; **Import** parses the clipboard JSON (tolerating Markdown fences, conversational wrappers, smart quotes, stray backslashes and a leading BOM), validates it against the same limits, and populates the editor fields. Neither button calls a model automatically.
- Annotations live in plain text under the DSH home (`dsh-session-manager/annotations.v1.json`), keyed by session ID. Same-origin browser tabs stay in sync via `BroadcastChannel`. Saves are durable across crashes; revision conflicts surface a "load latest" prompt.

### 1.3 Bulk management

- **Batch process mode**: click the toggle in the panel header to reveal row checkboxes, a **Select all in filter / Clear selection** toolbar pair, and the bulk action bar. Exiting batch process clears the current selection.
- **Action bar** lists every batch action:
  - **Annotation toggles**: **Archive / Unarchive / Favorite / Unfavorite / Mark for review / Clear review flag**.
  - **Mutating actions**: **Add tags / Clear tags / Set priority / Move to workspace / Migrate preset / Delete session**.
- **Confirmation flow**:
  - Non-destructive actions (archive / unarchive / favorite / unfavorite / review / unreview / add-tags / clear-tags / set-priority / move / preset-migrate) fire immediately and report per-session results in a **result dialog** with **Success / Failed / Skipped** groups and a one-click **Retry failed** that re-arms the failed IDs into the selection.
  - Destructive actions (**delete session**) first open a **preview dialog** listing the targeted sessions, then show a progress bar, then a per-id result dialog.

## 2 UI entry points

### 2.1 Title bar

The right side of the title area exposes actions for the **current session**: **Archive / Unarchive**, **Tags / Notes**, **Move to workspace**, **Delete session**.

### 2.2 Session manager panel

Open the **Session manager** panel from the bottom of DSH's sidebar to browse every session, switch workspaces, search by title or ID, apply filters and sorting, and run **Open / Archive / Unarchive / Tags / Notes / Move / Migrate preset / Delete** on any row. The panel header carries the workspace selector, archive filter, favorites / review flags, tag and priority filters, sort order, and matching / total counts plus a reset action.

### 2.3 Bulk management

The **Batch process** button in the session manager panel header is the entry point: click it once to enter batch process (row checkboxes appear, the **Select all in filter / Clear selection** pair and the bulk action bar show up); click it again to exit batch process.

## 3 Install

### 3.1 From the official plugin management

Go to **plugin management** inside DSH, search for `dsh-session-manager`, and install it.

### 3.2 From dsh-market

```powershell
dsh plugin --profile web add npm:dsh-session-manager
```

### 3.3 From GitHub

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

After installing, restart DSH Web. If the browser still holds an older client bundle, force-refresh with `Ctrl+Shift+R`.

### 3.4 Local development / runtime injection

```text
dev_inject_plugin {"dir": "<absolute path to this repository>"}
```

## 4 Safety and behavior

- **Deletion is permanent**, so the UI always asks for confirmation. The API checks the session ID, directory boundary and artifact header before deletion; traversal, symlinks and junctions are refused.
- Move and preset migration keep the live session / agent alive; only deletion cancels and disposes the session. Move updates the stored `cwd` and the existing live writer's header.
- The management list hides subagent sessions and the move API rejects them. Blank sessions without a persisted artifact cannot be moved.
- Cold rewrites preserve the artifact's stored format (V1 / V2 / V3 / V4 are all readable; the plugin never forces an upgrade). Moves and rewrites refuse corrupt / truncated Zstd logs or JSONL logs with incomplete final lines instead of publishing partial history.
- Preset migration separates backup, publication and rollback. If rollback fails, recovery files are retained and their paths are included in the error; do not remove them.
- Incomplete startup scans skip workspace reconciliation. Complete scans preserve live sessions and any membership added during the scan.
- Plugin mutations are serialized per session and request bodies are limited to 64 KiB. This queue supplements, rather than replaces, DSH's own persistence coordination.

## 5 Compatibility

| Plugin version | Verified DSH version |
| --- | --- |
| 0.5.2 | v0.1.7-rc.1 |
| 0.5.1 | v0.1.6-alpha.2 |
| 0.4.11 | v0.1.5-rc.2 |
| 0.4.10 | v0.1.5-rc.1 |
| 0.4.9 | v0.1.5-rc.1 |
| 0.4.7 | v0.1.5-rc.1 |
| 0.4.6 | 0.1.3-alpha.2 |
| 0.4.4 | 0.1.3-alpha.2 |
| 0.4.1 | 0.1.3-alpha.2 |
| 0.4.0 | v0.1.2-rc.1 |
| 0.1.2 | v0.1.0-rc.7 |
| 0.1.1 | v0.1.0-rc.7 |
| 0.1.0 | v0.1.0-rc.7 |

Requires Node.js 22.15+ (22.x) or 24+ for built-in Zstd support.

This is a Cordis plugin and declares `cordis: ">=4.0.0-rc <5"` as its peer dependency.

## 6 Development

- `lib/index.js` is the host-side ESM plugin; `lib/client.js` is the Web client bundle. No build step is required.
- Before submitting changes, run:

```powershell
npm run check
npm test
npm run check:package
git diff --check
```

Tests use isolated temporary directories and the real plugin entry point, never real sessions. CI runs these checks on Windows / Linux with Node 22.15.0 / 24.

Optional integration check: run `node scripts/smoke-test.mjs` against a running test instance of DSH Web. It contacts a real service and is not part of the default unit test suite.

Release history is in [CHANGELOG.md](CHANGELOG.md).

## 7 Acknowledgments

Thanks to everyone who installs and uses dsh-session-manager, and to the people who file issues and open pull requests to help improve it. The plugin is listed in [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin). Suggestions and feedback are welcome.

## 8 License

[MIT](LICENSE)
