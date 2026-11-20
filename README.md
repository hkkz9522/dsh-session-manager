# dsh-session-manager — session and workspace manager for DeepSeek Harness

English | [中文](README.zh.md)

[![npm version](https://img.shields.io/npm/v/dsh-session-manager)](https://www.npmjs.com/package/dsh-session-manager)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-upstream-1082ff)](https://github.com/deepseek-ai/deepseek-harness)
[![GitHub](https://img.shields.io/badge/GitHub-repository-blue)](https://github.com/hkkz9522/dsh-session-manager)
[![CI](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/hkkz9522/dsh-session-manager/actions/workflows/ci.yml)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

## 0 Overview

DeepSeek Harness session and workspace manager —— Workspaces: archive and visibility. Sessions: move, migrate presets, delete, favorite, review later, prioritize, tag, and annotate. Batch operations.

The Web UI and Desktop app share the same plugin Host/client functionality; environment-specific installation notes are documented below.

## 1 Features

### 1.1 Session lifecycle management

- **Delete** is irreversible and always asks for confirmation. Deleting a parent session also deletes its descendant subagent sessions.
- Deletion cancels Agent work and waits for idle completion and pending session writes, while the host owns Agent scope teardown. A failure or timeout stops further deletion and reports any partial completion.
- **Projection cache cleanup**: session deletion also removes its checkpoint and retained legacy cache entry, including cascaded subagents and batch deletion. Delayed writes from the deleted lifecycle are blocked. Cleanup failures are reported as warnings; they do not undo session deletion. The configured DSH home may be a junction or symbolic link; links inside cache paths remain restricted.
- **Archive / Unarchive** moves a session in and out of the active list while retaining its conversation history. Associated Git worktrees may be cleaned up according to DSH's settings.
- **Move to workspace** keeps history, title, archive state and derived-session relationships intact, rewrites the session's `cwd` to the target workspace, synchronizes the runtime `workingDirectory` projection for active agents, and updates the live writer's header in place so any pending tool calls keep landing on the new path. When the session's `cwd` already equals the target workspace path but its membership was never recorded, only the missing membership is repaired: no `cwd` rewrite, no artifact rewrite or move, and no session restart.
- **Migrate Agent preset** rewrites the latest `agent-preset/selected` event (or the session header if no such event exists) so a session whose preset was renamed or removed can resume. Message history is never altered.
- The preset dialog opens with its choices ready. The action button indicates preparation; click it again to cancel. Preparation failures appear in the panel and can be retried.
- Presets can be switched only while the session is idle. Stop the task or wait for the current turn to finish before switching; no change is queued for a later turn.
- **Git Worktree**: cross-workspace moves are refused when a session has a recorded Worktree association or uses a Git indirection directory. Archiving follows DSH's Worktree cleanup settings. Deleting a session does not remove project directories, Git worktrees, or branches.

### 1.2 Session shortcuts

- **Favorites / Review-later** are manual flags that survive archive and session end; neither is cleared automatically.
- **Search** matches title, session ID, note and tags case-insensitively, trims whitespace, and never reads chat history.
- **Filters and sorting** combine workspace (All / Ungrouped / specific), archive status (All / Active / Archived), run status, favorites, review later, tags, and priority. The **Run status** button cycles through any status, running, and not running. Sort by recently updated (default), least recently updated, newest created, oldest created, name ascending (A-Z), name descending (Z-A), or **priority (1 → 5)**.
- **Priority** is a dropdown **1 Highest, 2 High, 3 Normal, 4 Low, 5 Lowest**, default **3 (Normal)**; legacy `null` priorities are normalized to 3.
- **Tags / Notes**: up to 20 tags per session (≤ 32 characters each) and a 2000-character note. Both English `,` and Chinese `，` are separators, whitespace is trimmed, duplicate tags are merged case-insensitively.
- **AI-assisted tagging.** Choose **Copy Prompt** in the annotation editor and paste it into the conversation you want to organize. The prompt asks for searchable tags and a short note covering confirmed results and any agreed next step. It requests a priority only if you explicitly assigned one. Paste the JSON reply into the editor, choose **Import**, review the fields, then choose **Save annotations**. Omitting `priority` keeps the current setting.
- Annotations live in plain text under the DSH home (`dsh-session-manager/annotations.v1.json`), keyed by session ID. Same-origin client instances stay in sync via `BroadcastChannel`. Saves are durable across crashes; revision conflicts surface a "load latest" prompt.

### 1.3 Bulk management

- **Batch process mode**: click the toggle in the panel toolbar to reveal row checkboxes, a **Select all in filter / Clear selection** toolbar pair, and the bulk action bar. Exiting batch process clears the current selection.
- Select up to 200 sessions to archive or restore them, change their annotations, move them to a workspace, migrate their preset, or delete them. **Add tags** merges tags case-insensitively. If the merged list exceeds 20 tags, that session keeps its original tags and appears under **Failed**.
- For deletion, review the selected sessions and the number of descendant subagents. **Delete** becomes available once the preview for the current selection succeeds.
- While the host processes a batch, the panel shows a waiting message. When DSH processes archive or restore operations one session at a time, you can stop the remaining operations. The result groups sessions under **Success**, **Failed**, and **Skipped**. **Retry failed** targets only failed sessions and opens a fresh preview for deletion.

### 1.4 Plugin updates and settings

- **Self-update check**: An **npm icon button** in the panel header checks for updates and displays a notification dot when a new version is available. One-click updates use DSH's native update operation when available, with a fallback for older hosts. Install-source protection, registry selection, persistent status, post-install checks, and restart/refresh prompts remain available; failures report rollback or manual recovery status.
- **Settings Card**: Registered under DSH Settings (`settings.plugin.item`). Displays current version, latest version, inline check/update buttons, an auto-check toggle, and GitHub repository link.
- **Install Source (Registry)**: Select between **npm official registry** (`registry.npmjs.org`, default) and **China mainland mirror** (`registry.npmmirror.com`) in the Settings Card. Check for updates and download packages directly from the selected registry.
- **Dialog opacity**: A 50%–100% slider (5% steps, default 100%) with a "Reset to default" button in the Settings Card's preferences section. Adjusts the background fill opacity of plugin dialogs in real time while keeping text, buttons, inputs, tags, and borders fully opaque.
- **Theme**: Automatically follows the active DSH theme (including third-party theme plugins). Dialogs, settings cards, title-bar buttons, menus, inputs, and all other UI elements seamlessly adapt to light and dark themes.
- **Unified dropdown styling**: All select dropdowns (sort, filter, priority) use rounded, shadow-free menus matching the active theme. Menus match the trigger width within the visible viewport, choose an opening direction based on available space, and close when zoom, panning, or the soft keyboard changes that viewport.

### 1.5 Workspace Archiving and Management

- **Two-page tab switching**: Seamlessly switch between "Session Management" and "Workspace Management" in the dialog header, preserving each page's distinct search, filter, and sort states.
- **Workspace list**: Displays all registered workspaces with title/name, physical path, session count, latest activity timestamp computed from member sessions, and right-side toggle switch.
- **Search, filter, and sort**: Case-insensitive search across name and path; filter by All / Active / Archived; sort by Recently Updated, Earliest Updated, Name A-Z, or Name Z-A; counter display and adaptive toolbar wrapping.
- **Toggle switch and archiving**:
  - **Turn OFF (Archive)**: Pre-checks session activity (rejects safely if any session is running), cascades archiving to all unarchived member sessions, hides workspace from DSH native sidebar, and attempts to restore sessions changed by this operation if a later session fails.
  - **Turn ON (Restore)**: Removes archive mark, restores workspace in native sidebar, unarchives member sessions previously archived by the workspace operation while keeping individually archived sessions intact. Creating an identical-path workspace restores visibility automatically.
- **Native sidebar hiding without ungrouped spill**: Employs derived snapshot interception with session ID unioning into `archivedSessionIds` so hidden workspace sessions never spill into "Ungrouped", supporting dark/light themes and persistent recovery across DSH restarts.

## 2 UI entry points

### 2.1 Title bar

The right side of the title area exposes actions for the **current session**: **Archive / Unarchive**, **Favorites**, **Review-later**, **Tags / Notes**, **Move to workspace**, **Switch preset**, **Delete session**, and **More actions** (`⋯`), matching the management panel's action order. On narrow screens, More presents the same actions in a floating menu outside the title bar.

### 2.2 Sessions and workspaces management entry and interface

Open **Sessions & Workspaces** from the bottom of DSH's sidebar to browse all sessions and workspaces. Click a session title to open it; there is no separate Open button. Row actions, including **Migrate preset**, use icons with hover descriptions and accessible labels. The session tab supports switching workspaces, searching by title / ID / notes / tags, filtering, and sorting; the workspace tab supports searching, sorting, bulk actions, and visibility toggling.

### 2.3 Bulk management

The **Batch process** button in the session manager toolbar is the entry point: click it once to enter batch process (row checkboxes appear, the **Select all in filter / Clear selection** pair and the bulk action bar show up); click it again to exit batch process.

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
- Moves preserve DSH's persistent POSIX `session.lock`. The destination uses a hard link to the same inode, and the old directory can remain with just this lock. A busy cold-session lease, a different destination lock, or an unexpected source file such as a backup stops the move.
- The management list hides subagent sessions and the move API rejects them. Blank sessions without a persisted artifact cannot be moved.
- Cold rewrites preserve the artifact's stored format (V1 / V2 / V3 / V4 are all readable; the plugin never forces an upgrade). Moves and rewrites refuse corrupt / truncated Zstd logs or JSONL logs with incomplete final lines instead of publishing partial history.
- Preset migration separates backup, publication and rollback. If rollback fails, recovery files are retained and their paths are included in the error; do not remove them.
- If workspace rollback or restore stops partway, workspace management lists the remaining session IDs. Choose **Retry restore** to resume. If the host cannot confirm saving the record, choose **Retry save** in the same client to resend the record without repeating session commands.
- On startup, sessions whose `cwd` names a registered workspace but whose membership record is missing are re-registered through the official DSH API (idempotent). Incomplete scans skip pruning only: existing membership is never dropped, and live sessions or memberships added during the scan are always preserved.
- Plugin mutations are serialized per session and request bodies are limited to 64 KiB. This queue supplements, rather than replaces, DSH's own persistence coordination.
- **Centralized API authentication** requires an authenticated owner on every `/session-manager/api/*` route before reading the request body. WebServer versions that supply a route peer are checked directly. Older, two-argument routes authenticate through `connection.admit()`. The plugin rejects requests with missing or non-owner credentials.
- **Delete API (0.7.11).** For a single session, request `GET /delete-preview?sessionId=…` and send `result.previewToken` with the ID to `POST /delete`. For a batch, preview with `POST /delete-preview` and a `sessionIds` array, then send the same IDs in the same order and the token to `POST /batch` with `action: "delete"`. Receipts expire after two minutes. Reopen the preview after expiry, restart, or a change in scope. The host logs the time and requested IDs upon acceptance.
- **Same-origin trust.** Installed client plugins and other scripts running in an authenticated owner page share that owner's API access, including annotation reads and moves. Such scripts can also request a deletion preview. A receipt binds requests to a preview and does not attest a human click or identify the calling plugin.

## 5 Compatibility

The table below lists compatible version combinations between DeepSeek Harness (DSH) and `dsh-session-manager`.

The maintainer completed manual testing of plugin `0.7.11` on 2026-11-20. Automated projection-cache integration checks also passed with DSH `0.2.2-rc.1`, `rc.3`, and `rc.5`.

| DeepSeek Harness (DSH) | dsh-session-manager | Environment |
| :--- | :--- | :--- |
| **v0.2.2-rc.5** | `0.7.9` | Desktop |
| **v0.2.2-rc.3** | `0.7.8`, `0.7.7` | Desktop |
| **v0.2.2-rc.1** | `0.7.6` | Desktop |
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

With plugin 0.7.9, you can delete a saved conversation without opening it first, including history imported through the experimental DeepSeek chat import plugin. When archiving through DSH's native command, the host may remove an eligible Git worktree while preserving its branch and commits. [DSH worktree archive guide](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.5/docs/upgrade-guide/v0.2.2-rc.1/archive-worktrees/guide.md)

When using a standalone DSH CLI/runtime, Node.js 22.15+ (22.x) or 24+ is required for built-in Zstd support. The official Desktop app ships and manages its matching runtime separately.

This is a Cordis plugin and declares `@deepseek-ai/cordis: ">=4.0.0-rc <5"` as its peer dependency.

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

### Permanent deletion event

Plugins that store session references can subscribe to `session-manager/session-deleted` and await saving their own changes.

```js
ctx.on("session-manager/session-deleted", async ({ sessionId }) => {
  await forgetSessionReference(sessionId);
});
```

The event follows permanent deletion and workspace detachment. It covers single, batch, and cascaded deletion, with descendants announced before their parent. Make handlers idempotent because a repeated delete can send the same ID again. Await your own persistence and avoid calling back into Session Manager mutations from the handler. The delete request waits up to three seconds per notification. A rejection or timeout produces a cleanup warning and preserves the successful deletion result. A timed-out handler can still finish later.

Release history is in [CHANGELOG.md](CHANGELOG.md).

## 7 Acknowledgments

Thanks to everyone who installs and uses dsh-session-manager, and to the people who file issues and open pull requests to help improve it. Suggestions and feedback are welcome.

## 8 License

[MIT](LICENSE)
