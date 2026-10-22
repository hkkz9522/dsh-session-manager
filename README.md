# dsh-session-manager — session and workspace manager for DeepSeek Harness

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-upstream-1082ff)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## 0 Overview

DeepSeek Harness session and workspace manager —— Workspaces: archive and visibility. Sessions: move, migrate presets, delete, favorite, review later, prioritize, tag, and annotate. Batch operations.

Verified with the official DSH Desktop client; see [5 Compatibility](#5-compatibility) for the current verification scope. Both environments share the same plugin Host/client functionality; environment-specific installation notes are documented below.

## 1 Features

### 1.1 Session lifecycle management

- **Delete** is irreversible and always asks for confirmation. Subagent sessions and transient blank placeholders (no persisted artifact) cannot be deleted.
- **Archive / Unarchive** moves a session in and out of the active list without touching its disk content.
- **Move to workspace** keeps history, title, archive state and derived-session relationships intact, rewrites the session's `cwd` to the target workspace, synchronizes the runtime `workingDirectory` projection for active agents, and updates the live writer's header in place so any pending tool calls keep landing on the new path. When the session's `cwd` already equals the target workspace path but its membership was never recorded, only the missing membership is repaired: no `cwd` rewrite, no artifact rewrite or move, and no session restart.
- **Migrate Agent preset** rewrites the latest `agent-preset/selected` event (or the session header if no such event exists) so a session whose preset was renamed or removed can resume. Message history is never altered.

### 1.2 Session shortcuts

- **Favorites / Review-later** are manual flags that survive archive and session end; neither is cleared automatically.
- **Search** matches title, session ID, note and tags case-insensitively, trims whitespace, and never reads chat history.
- **Filters and sorting** combine a workspace selector (All / Ungrouped / specific) with an archive filter (All / Active / Archived), then layer favorites / review, tag and priority filters on top. Sort by recently updated (default), least recently updated, newest created, oldest created, name ascending (A-Z), name descending (Z-A), or **priority (1 → 5)**.
- **Priority** is a dropdown **1 Highest, 2 High, 3 Normal, 4 Low, 5 Lowest**, default **3 (Normal)**; legacy `null` priorities are normalized to 3.
- **Tags / Notes**: up to 20 tags per session (≤ 32 characters each) and a 2000-character note. Both English `,` and Chinese `，` are separators, whitespace is trimmed, duplicate tags are merged case-insensitively.
- **AI-assisted tagging** is manual and opt-in: **Copy Prompt** writes a structured prompt (Chinese or English, matched to the active UI) to the clipboard; **Import** parses the clipboard JSON (tolerating Markdown fences, conversational wrappers, smart quotes, stray backslashes and a leading BOM), validates it against the same limits, and populates the editor fields. Neither button calls a model automatically.
- Annotations live in plain text under the DSH home (`dsh-session-manager/annotations.v1.json`), keyed by session ID. Same-origin client instances stay in sync via `BroadcastChannel`. Saves are durable across crashes; revision conflicts surface a "load latest" prompt.

### 1.3 Bulk management

- **Batch process mode**: click the toggle in the panel header to reveal row checkboxes, a **Select all in filter / Clear selection** toolbar pair, and the bulk action bar. Exiting batch process clears the current selection.
- **Action bar** lists every batch action:
  - **Annotation toggles**: **Archive / Unarchive / Favorite / Unfavorite / Mark for review / Clear review flag**.
  - **Mutating actions**: **Add tags / Clear tags / Set priority / Move to workspace / Migrate preset / Delete session**.
- **Confirmation flow**:
  - Non-destructive actions (archive / unarchive / favorite / unfavorite / review / unreview / add-tags / clear-tags / set-priority / move / preset-migrate) fire immediately and report per-session results in a **result dialog** with **Success / Failed / Skipped** groups and a one-click **Retry failed** that re-arms the failed IDs into the selection.
  - Destructive actions (**delete session**) first open a **preview dialog** listing the targeted sessions, then show a progress bar, then a per-id result dialog.

### 1.4 Plugin updates and settings

- **Self-update check**: An **npm icon button** (Check for updates) in the session manager panel header checks for updates and displays a notification dot when a new version is available. Click to open the update dialog with current and latest versions, and one-click update via the DSH Plugin Manager with support for both HMR and non-HMR environments, persistent status tracking, automatic rollback on failure, and restart/refresh prompts.
- **Settings Card**: Registered under DSH Settings (`settings.plugin.item`). Displays current version, latest version, inline check/update buttons, an auto-check toggle, and GitHub repository link.
- **Install Source (Registry)**: Select between **npm official registry** (`registry.npmjs.org`, default) and **China mainland mirror** (`registry.npmmirror.com`) in the Settings Card. Check for updates and download packages directly from the selected registry.
- **Dialog opacity**: A 50%–100% slider (5% steps, default 100%) with a "Reset to default" button in the Settings Card's preferences section. Adjusts the background fill opacity of plugin dialogs in real time while keeping text, buttons, inputs, tags, and borders fully opaque.
- **Theme**: Automatically follows the active DSH theme (including third-party theme plugins). Dialogs, settings cards, title-bar buttons, menus, inputs, and all other UI elements seamlessly adapt to light and dark themes.
- **Unified dropdown styling**: All select dropdowns (sort, filter, priority) use unified shadow-free rounded custom floating menus matching active themes, strictly aligned with trigger widths, eliminating Chromium duplicate native popups.

### 1.5 Workspace Archiving and Management

- **Two-page tab switching**: Seamlessly switch between "Session Management" and "Workspace Management" in the dialog header, preserving each page's distinct search, filter, and sort states.
- **Workspace list**: Displays all registered workspaces with title/name, physical path, session count, latest activity timestamp computed from member sessions, and right-side toggle switch.
- **Search, filter, and sort**: Case-insensitive search across name and path; filter by All / Active / Archived; sort by Recently Updated, Earliest Updated, Name A-Z, or Name Z-A; counter display and adaptive toolbar wrapping.
- **Toggle switch and archiving**:
  - **Turn OFF (Archive)**: Pre-checks session activity (rejects safely if any session is running), cascades archiving to all unarchived member sessions, hides workspace from DSH native sidebar, and automatically rolls back if partial failure occurs.
  - **Turn ON (Restore)**: Removes archive mark, restores workspace in native sidebar, unarchives member sessions previously archived by the workspace operation while keeping individually archived sessions intact. Creating an identical-path workspace restores visibility automatically.
- **Native sidebar hiding without ungrouped spill**: Employs derived snapshot interception with session ID unioning into `archivedSessionIds` so hidden workspace sessions never spill into "Ungrouped", supporting dark/light themes and persistent recovery across DSH restarts.

## 2 UI entry points

### 2.1 Title bar

The right side of the title area exposes actions for the **current session**: **Archive / Unarchive**, **Favorites**, **Review-later**, **Tags / Notes**, **Move to workspace**, **Delete session**, and **More actions** (`⋯`), matching native DSH title-bar button sizing (28px height, transparent ghost style) and vector SVG icon design.

### 2.2 Sessions and workspaces management entry and interface

Open **Sessions & Workspaces** from the bottom of DSH's sidebar to browse all sessions and workspaces: the session management tab supports switching workspaces, searching by title / ID / notes / tags, applying filters and sorting, and running **Open / Archive / Unarchive / Tags / Notes / Move / Migrate preset / Delete** on any session row; the workspace management tab supports searching, sorting, bulk actions, and visibility toggling.

### 2.3 Bulk management

The **Batch process** button in the session manager panel header is the entry point: click it once to enter batch process (row checkboxes appear, the **Select all in filter / Clear selection** pair and the bulk action bar show up); click it again to exit batch process.

### 2.4 Settings Card

Navigate to DSH Settings -> Plugins -> Session Manager to inspect versions, switch between npm official and China mainland mirror registries, toggle auto-update checks, or trigger updates.

## 3 Installation

### 3.1 Install from Plugins

In DSH, open **Plugins**, add a plugin, search for `dsh-session-manager`, and install it. This method is supported by both the official Web UI and Desktop app.

### 3.2 Install from Third-Party Plugin Markets

This plugin is listed in [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).

### 3.3 Install to the Web profile via CLI

Install from npm:

```powershell
dsh plugin --profile web add npm:dsh-session-manager
```

Install from GitHub:

```powershell
dsh plugin --profile web add github:hkkz9522/dsh-session-manager
```

Restart DSH Web after installation. If the browser still loads an older client bundle, use `Ctrl+Shift+R` to force-refresh the page.

> The `desktop` profile is managed by the official Desktop app and is not intended to be modified with the regular `dsh` CLI. Desktop users should install the plugin through **Plugins** in the app.

### 3.4 Local Development / Testing

#### Web profile

Install the local repository via CLI:

```powershell
dsh plugin --profile web add <path-to-this-repository>
```

The local repository is linked to the current profile as a plugin checkout, making it suitable for modifying the source code directly and testing changes.

#### Desktop app

Open **Plugins** in the official Desktop app and use the absolute path to the local repository as the installation source.

For client-side code, changes can be reloaded automatically after saving when HMR is working normally. If a change does not take effect immediately, reload the current interface or restart the corresponding DSH Web / Desktop client.

After changing plugin dependencies, `package.json`, bundle configuration, or other installation- or loading-related settings, reinstalling the plugin or restarting the corresponding client is recommended.

## 4 Safety and behavior

- **Deletion is permanent**, so the UI always asks for confirmation. The API checks the session ID, directory boundary and artifact header before deletion; traversal, symlinks and junctions are refused.
- Move and preset migration keep the live session / agent alive; only deletion cancels and disposes the session. Move updates the stored `cwd` and the existing live writer's header.
- The management list hides subagent sessions and the move API rejects them. Blank sessions without a persisted artifact cannot be moved.
- Cold rewrites preserve the artifact's stored format (V1 / V2 / V3 / V4 are all readable; the plugin never forces an upgrade). Moves and rewrites refuse corrupt / truncated Zstd logs or JSONL logs with incomplete final lines instead of publishing partial history.
- Preset migration separates backup, publication and rollback. If rollback fails, recovery files are retained and their paths are included in the error; do not remove them.
- **Workspace archiving rollback protection**: archiving is refused if active sessions are present, and batch session archiving automatically rolls back on partial failures to preserve state consistency.
- On startup, sessions whose `cwd` names a registered workspace but whose membership record is missing are re-registered through the official DSH API (idempotent). Incomplete scans skip pruning only: existing membership is never dropped, and live sessions or memberships added during the scan are always preserved.
- Plugin mutations are serialized per session and request bodies are limited to 64 KiB. This queue supplements, rather than replaces, DSH's own persistence coordination.
- **Centralized API authentication**: All `/session-manager/api/*` routes are protected by DSH official `connection.admit()` and `requestRejection()` gates, strictly enforcing Owner-only privileges (`peer.principal.kind === "owner"`) and failing closed (HTTP 503) if connection services are absent, ensuring that exposed network tunnels or local proxies cannot bypass access control.

## 5 Compatibility

The table below lists verified version combinations between DeepSeek Harness (DSH) and `dsh-session-manager`.

> **Verification note**: From version 0.6.3 onwards, this plugin is verified with the official DSH Desktop client only (the Web UI shares the same Host/client codebase but is no longer covered by the verification matrix).

| DeepSeek Harness (DSH) | dsh-session-manager | Verified Environment |
| :--- | :--- | :--- |
| **v0.2.1-rc.2** | `0.7.5`, `0.7.4`, `0.7.3`, `0.7.2` | Desktop |
| **v0.2.0-rc.2** | `0.7.1`, `0.7.0`, `0.6.4`, `0.6.3`, `0.6.2`, `0.5.4` | Desktop |
| **v0.1.7-rc.2** | `0.5.3` | Desktop / Web UI |
| **v0.1.7-rc.1** | `0.5.2` | Desktop / Web UI |
| **v0.1.6-alpha.2** | `0.5.1` | Web UI |
| **v0.1.5-rc.2** | `0.4.11` | Web UI |
| **v0.1.5-rc.1** | `0.4.10`, `0.4.9`, `0.4.7` | Web UI |
| **v0.1.3-alpha.2** | `0.4.6`, `0.4.4`, `0.4.1` | Web UI |
| **v0.1.2-rc.1** | `0.4.0` | Web UI |
| **v0.1.0-rc.7** | `0.1.2`, `0.1.1`, `0.1.0` | Web UI |

The version combinations above have been tested with either the official Web UI or Desktop app. Other version combinations may also work but have not been individually verified.

When using a standalone DSH CLI/runtime, Node.js 22.15+ (22.x) or 24+ is required for built-in Zstd support. The official Desktop app ships and manages its matching runtime separately.

This is a Cordis plugin and declares `cordis: ">=4.0.0-rc <5"` as its peer dependency.

## 6 Development

- `lib/index.js` is the host-side ESM plugin; `lib/client.js` is the client UI bundle. No build step is required.
- Before submitting changes, run:

```powershell
npm run check
npm test
npm run check:package
git diff --check
```

Tests use isolated temporary directories and the real plugin entry point, never real sessions. CI runs these checks on Windows / Linux with Node 22.15.0 / 24.

Optional integration check: run `node scripts/smoke-test.mjs` against a running DSH Web-profile test instance. It contacts a real service and is not part of the default unit test suite.

Release history is in [CHANGELOG.md](CHANGELOG.md).

## 7 Acknowledgments

Thanks to everyone who installs and uses dsh-session-manager, and to the people who file issues and open pull requests to help improve it. Suggestions and feedback are welcome.

## 8 License

[MIT](LICENSE)
