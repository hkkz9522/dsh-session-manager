# Changelog

All notable changes to this project will be documented in this file.

## 0.7.5 — 2026-10-22

- **fix(security)**: Enforce centralized API authentication on all `/session-manager/api/*` routes using DSH official `ctx.connection.admit(req)`. Enforce strict Owner-only authorization (`peer.principal.kind === "owner"`), reject untrusted, unauthenticated, empty, or non-owner requests before body reading and database queries, and fail closed with HTTP 503 (`auth-unavailable`) if connection service is missing or unready, preventing unauthorized access across public tunnels, reverse proxies, and local networks (#43).
- **fix(move)**: Synchronize the effective `workingDirectory` projection upon moving sessions across workspaces. For active sessions, call official `workingDirectory.set(agent, path)` when active or fall back to appending `working-directory/change` events to fold the projection in real time, and flush to disk via projection cache; for cold sessions, rewrite headers when un-diverged or append change events for sequential logs. For unmigrated packed rows with conflicting historical working-directory events, safely refuse moves with HTTP 409 (`working-directory-sync-unsafe`) before any file write to prevent destination directory drift upon restart (#42).
- **fix(ui)**: Align session header action buttons with native DSH session title bar style: unify height to 28px, remove idle border and background (transparent ghost buttons), add standard 6px border-radius, use official hover and active tokens, style danger buttons cleanly, and replace raw Unicode emojis with crisp 14×14 SVG vector icons (#44).
- **fix(ui)**: Optimize session header and manager panel layout: set header slot order to 0 to sit immediately after static session preset and team entries and before dynamic subagent and task status indicators; switch header action buttons to a fixed-width (flex-shrink: 0, 28px square) icon-only layout with corner priority badge; in session manager panel row actions, convert buttons matching header (archive, favorite, review, edit, move, delete) to clean icon-only buttons with hover tooltips while keeping non-header ("Open", "Migrate") and bulk action buttons with visible text labels (#46).
- **test**: Add comprehensive test suites for API authentication gating (`issue-43-api-auth.test.mjs`), cross-workspace working directory synchronization (`issue-42-working-directory-after-move.test.mjs`), header action button styling with SVG vector icons (`issue-44-header-styles.test.mjs`), and header/panel row layout optimization (`issue-46-header-layout.test.mjs`).
- **compat**: Compatible with DSH Desktop v0.2.1-rc.2 (and v0.2.0-rc.2).

## 0.7.4 — 2026-10-20

- **fix(workspace)**: Repair workspace session membership on DSH 0.2.x. New and forked sessions are now attributed to the workspace owning their `cwd` as soon as the session is announced (runtime repair, no restart needed), and historical sessions whose `cwd` matches a registered workspace are re-registered on startup — all through the official DSH workspace entity API (#41).
- **fix(move)**: "Move to workspace" on a session whose `cwd` already equals the target workspace path now repairs the missing membership instead of returning a silent no-op. The response reports whether a membership was written (`attached`); the artifact's content, size and mtime are untouched and running sessions are never restarted (#41).
- **fix(compat)**: Resolve the DSH home through the official `$DSH_HOME` → `~/.dsh` order (tilde-expanded, absolute) when the `dshHomePath` service is not visible to the plugin scope, so session scans and stores work with a custom DSH home (#41).
- **fix(workspace)**: Read durable workspace membership from the registry record instead of the runtime-filtered projection when deleting sessions, so stale runtime indexes can no longer leave dead entries behind.
- **test**: Add regression coverage for runtime new/forked session attribution, boot repair, same-path move repair (including artifact byte/size/mtime invariants), idempotence, cross-workspace moves, cwd mismatch safety, incomplete-scan safety, restart stability, archived-session preservation, and custom DSH home resolution (#41).
- **compat**: Compatible with DSH Desktop v0.2.1-rc.2 (and v0.2.0-rc.2); workspace membership repair uses the official workspace registry entity API.
- **fix(safety)**: Workspace membership repair never migrates a session that is already accounted by another workspace: such a conflict is refused with `409 workspace-membership-conflict` and both records stay untouched, because an account removed from a different workspace cannot be restored through the official API. Completing a missing membership still goes through the official `attachSession()` after its validation conditions (header readability, cwd resolution, canonical path equality) are pre-checked, so a predictable rejection fails before any write (#41).
- **fix(api)**: "Move to workspace" no longer reports success when a repair cannot be completed: hosts without the official `attachSession` API answer `501 workspace-attach-unavailable`, an unconfirmable membership state is refused, a membership conflict answers `409 workspace-membership-conflict`, and unsafe or failed repairs answer `500` with `workspace-repair-unsafe` / `workspace-repair-failed`. Successful repairs report `membership` (`already-member` / `attached`) next to the existing `moved` / `attached` fields (#41).

## 0.7.3 — 2026-10-18

- **fix(update)**: Fix built-in one-click update and resolve `cannot get property "remote" without inject` by routing update requests through the plugin's own Host API instead of client-side `remote.pluginManager`.
- **feat(update)**: Implement completely independent one-click self-update without relying on `dsh-market`. Support both HMR (`removeBundle` -> `installBundle` sequence with automatic rollback to previous version on failure) and non-HMR environments.
- **feat(update)**: Add persistent update status tracking (`.dsh-session-manager-update.json` in profile directory) and `GET /update/status` polling recovery, ensuring seamless result delivery even if the client connection is temporarily interrupted during HMR reload.
- **feat(update)**: Install source protection: automatically identify `linked` (local development) and `github` install sources to refuse npm package overwrites and protect local workspaces.
- **fix(update)**: Prevent accidental version downgrades with `400 not-upgrade` checks, properly handle `application: "failed"` responses from the bundle installer, and add post-install disk file/entry point verification.
- **fix(ui)**: Fix button hover contrast in light and dark themes: ensure `.sm-nativeDialogConfirm` retain blue background and white text when hovered.
- **test**: Add comprehensive regression tests covering update checking, install source protection, HMR safe self-update and automatic rollback, status polling recovery, and button hover styling.
- **compat**: Compatible with DSH Desktop V0.2.1-rc.2 (and V0.2.0-rc.2).

## 0.7.2 — 2026-10-17

- **fix(encoding)**: Correct session directory encoding and candidate matching for IM and non-UUID sessions (`encodeFsSessionSegment` matching DSH `encodeSegment` with `~XXXX` hex escapes). Support colons and non-alphanumeric characters in session IDs without directory traversal risks, distinguish project keys from session directory segments, and maintain multi-candidate fallback compatibility for existing sessions (#39).
- **fix(ui)**: Scope custom dropdown interceptor to Session Manager elements only (`getTargetSmSelect`), preventing global interception of third-party plugin selects and DSH native dropdowns and eliminating unwanted `preventDefault` / `stopPropagation` calls (#36).
- **fix(ui)**: Prevent scrolling within the custom select menu from closing the menu, enabling smooth wheel scrolling and scrollbar dragging across long option lists (PR #37).
- **fix(ui)**: Improve sidebar footer layout compatibility when multiple plugins inject actions into `sidebar.footer.action`. Apply scoped `flex-wrap: wrap` on the footer actions container and update `.sm-footerBtn-wide` to `flex: 1 1 100%`, preventing overlapping buttons and horizontal squishing without fragile CSS module hashes or targeting other plugins' private classes (#38).
- **compat**: Compatible with DSH Desktop V0.2.1-rc.2 (and V0.2.0-rc.2).

## 0.7.1 — 2026-10-15

- **fix(cache)**: Decouple boot-time workspace session membership reconciliation from projection cache reconstruction, preventing background event-loop blocking and watchdog recovery timeouts on large session libraries (#32).
- **fix(cache)**: Fix projection cache reconstruction error on packed rows (e.g. `tool-call-chunks` without sequential `seq`); prioritize official `adapter.openSessionRead()` logical events and safely skip unmigrated physical rows during disk fallback without triggering missing seq warnings (#32).
- **fix(move)**: Preserve source artifact filename and generation version when moving cold sessions across workspaces, preventing forged `version: 4` headers on unmigrated physical event content (#32).
- **fix(safety)**: Safely skip corrupted JSON lines and unresolvable seeded session boundaries during cache refold, preserving original session artifacts without poisoning projection caches (#32).
- **feat(perf)**: Introduce budget controls (50 sessions max, 2000ms timeout, 5MB artifact limit) and event-loop yielding (`setImmediate`) during boot projection cache sweeps (#32).
- **feat(update)**: Support on-demand silent update checks when opening session manager panel with a 6-hour interval, 30-minute failure cooldown, and concurrent request protection.
- **feat(ui)**: Refine settings card layout and preferences order (Auto-check -> Registry -> Opacity), harmonize control widths, and inline background opacity description hint.
- **test**: Add comprehensive regression tests covering packed rows, old format moves, cache hits/misses, large history library budget limits, post-move cache consistency (#32), and on-demand panel update checks.

## 0.7.0 — 2026-10-15

- **fix(ui)**: Unify select dropdown styling across all dialogs and panels with shadow-free custom floating menus, strictly align popup width with triggers, and isolate pointer events to eliminate duplicate native OS popups on Chromium.
- **fix(ui)**: Fix workspace bulk action buttons wrapping to next row when overflowing in English mode, preventing the unarchive button from exceeding the window boundary.
- **fix(ui)**: Align dropdown trigger box width and dropdown menu content width in workspace management panel.
- **fix(ui)**: Make workspace management toolbar buttons adaptively wrap when the window narrows, matching session management panel behavior.
- **feat(workspace)**: Automatically reveal and restore archived workspaces when creating a workspace with an identical directory path.
- **feat(workspace)**: Add Workspace Management tab to the Session Manager panel with dedicated search, active/archived filters, and update-time & alphabetical sorting.
- **feat(workspace)**: Support single and bulk workspace archiving via toggle switch and bulk actions without secondary confirmation.
- **fix(ui)**: Remove hover tooltip on workspace switch and stabilize layout against window jitter during hover and toggle.
- **ui**: Reorder workspace toolbar with sort dropdown placed after the active filter button, with responsive multi-row layout for bulk action controls.
- **ui**: Simplify select-all button label to "Select All Filtered" in both session and workspace management panels.
- **ui**: Remove duplicate "Reset Filters" button in the Session Management panel.
- **feat(workspace)**: Support workspace restoration, unarchiving only sessions archived during the workspace archive operation while keeping individually archived sessions intact.
- **feat(workspace)**: Support workspace bulk management with selection mode, row checkboxes, select-all/clear, and bulk archive/unarchive controls aligned on the same toolbar row as filters and sort.
- **feat(workspace)**: Consolidate workspace toolbar row layout placing sort dropdown, filter buttons, and bulk action buttons on a single harmonious row.
- **feat(workspace)**: Robust workspace and session update timestamp extraction supporting live member sessions, backend cache, and filesystem mtimes.
- **feat(sessions)**: Add Name Ascending (`name-asc`) and Name Descending (`name-desc`) sorting in both session management and workspace management.
- **ui**: Rename sidebar footer entry from "Sessions" to "Sessions & Workspaces".
- **feat(workspace)**: Integrate native DSH sidebar hiding via wrapped `workspaces.list.getSnapshot()`, filtering hidden workspaces and merging session IDs into `archivedSessionIds` so sessions never spill into "Ungrouped".
- **feat(workspace)**: Durable host-side persistence in `workspace-archives.v1.json` with file locking, and zero-flash synchronous `localStorage` caching with automatic migration from legacy `dsh-workspace-hide.hidden.v2`.
- **feat(safety)**: Refuse workspace archiving if any session has running activity, and implement automatic rollback on partial archive failures.
- **test**: Add comprehensive test suites covering workspace listing, search/filter/sort, toggle archiving/unarchiving, bulk mode and batch archive/unarchive, sidebar hiding, ungrouped isolation, running session safety, and failure rollbacks.

## 0.6.4 — 2026-10-13

- **fix(ui)**: Portal `SessionManagerPanel` into `#dsh-session-manager-overlay-root` to resolve overlay occlusion and interaction blocking by DSH sidebar/main view (#28).
- **fix(responsive)**: Align compact header menu item order with expanded state across folding modes, hide visible primary actions from menu in medium fold, open menu rightwards under 420px ultra-narrow view, and clamp dialog positioning to avoid left sidebar occlusion.
- **fix(ui)**: Close secondary dialogs in LIFO order on Escape, align action button styles, and unify tooltip wrappers.
- **fix(compat)**: Support DSH 0.2.0-rc.2+ 3-argument `coldSnapshot` signature, fixing log offset warnings and projection refresh after workspace move (#25).
- **fix(workspace)**: Sync sidebar state on archive/unarchive via official `uiWorkspace`/`workspaces` commands, unpin archived sessions, and stop active sessions on archive (#26).
- **test**: Add automated test coverage for issues #25, #26, and #28.
- **docs**: Streamline dialog opacity and theming documentation in README files.

## 0.6.3 — 2026-10-03

- **feat(settings)**: Add "Dialog opacity" preference (50%–100%) in Settings card to adjust plugin dialog background transparency without affecting text, borders, or controls (#23).
- **fix(theme)**: Directly consume official DSH `--dsw-alias-*` theme tokens instead of locally redefining them, removing hardcoded backgrounds and `!important` locks that broke custom themes (#23).
- **fix(theme)**: Subscribe to DSH `theme/change` event for reliable theme synchronization across light and dark modes.
- **fix(ui)**: Keep modal layers within DSH's 1000–1100 floating tier (`1020` panel, `1050` overlay root) so DSH tooltips remain visible above dialogs (#21).
- **fix(ui)**: Standardize dialog action buttons to 28px height with unified transparent border and hover styles.
- **fix(ui)**: Style dropdown `<option>` elements with DSH `--dsw-alias-bg-layer-3` to fix white popup backgrounds in dark mode.
- **fix(ui)**: Improve delete button contrast across custom themes using `--dsw-alias-button-floating-fill`.
- **fix(ui)**: Align AI prompt copy and import layout with standard field structure in Annotation dialog.
- **fix(css)**: Rewrite injected plugin stylesheet on reload to ensure styles update during client hot reloads.
- **test**: Add comprehensive test suites for dialog opacity, theme tokens, and z-index layering.
- **docs**: Clarify that validation is targeted primarily for the official DSH Desktop client.

## 0.6.2 — 2026-10-02

- **feat(update)**: Add self-update checking and installation workflow with header whale icon, modal `UpdateDialog`, and host API endpoints.
- **feat(settings)**: Add `SessionManagerSettingsCard` in DSH Settings with version info, auto-check toggle, update actions, and npm registry source selection (npm official or China mirror).
- **feat(ui)**: Add responsive container queries for header actions (720px / 520px) transitioning between full labels, 32×32 icon buttons, and overflow menu (`⋯`).
- **fix(ui)**: Reset main view to welcome screen when deleting the active session via `ctx.uiWorkspace.clearMain()`, matching archive behavior.
- **fix(ui)**: Mount dialogs into dedicated `#dsh-session-manager-overlay-root` with dynamic z-index stacking (`nextDialogZ()`) to escape ancestor stacking contexts (#19).
- **fix(ui)**: Render `FooterAction` directly as native buttons in wide/rail modes, eliminating duplicate container wrappers (#20).
- **fix(ui)**: Optimize title bar button ordering with Archive first and vertically centered icons.
- **fix(css)**: Remove unscoped global tooltip selectors (`[role=tooltip]`, `.bubble`) that interfered with DSH core message bubbles (#21).
- **test**: Add coverage for updates, settings card, responsive headers, registry switching, and active session deletion.

## 0.5.4 — 2026-09-30

- **docs**: Update project description and metadata to reflect official Web UI and Desktop app support; clarify client synchronization, install profiles, and runtime requirements.

## 0.5.3 — 2026-09-26

- **fix(ui)**: Forward translation function `t` to panel `MoveDialog` and unarchive archived sessions when opening from row (#17).
- **fix(persistence)**: Stamp `header.version` from target filename during `moveSession` to ensure valid headers on V4 artifacts (#18).
- **fix(ui)**: Display friendly `displayTitle` instead of raw ID in confirmation descriptions and avoid crashes in title-bar action lookups.
- **fix**: Strip UTF-8 BOM from `package.json` to prevent JSON parse errors.
- **test**: Add regression guards for issues #17 and #18.

## 0.5.2 — 2026-09-23

- **fix(bulk management)**: add a missing entry-point for batch operations with a new **Select** toolbar toggle in the panel header.
- **fix(bulk management)**: Remove duplicate return statement in `SessionManagerPanel` that prevented bulk dialogs from rendering.
- **feat(bulk management)**: Add multi-select checkboxes to session rows with a sticky bulk action bar for archiving, unarchiving, favorites, review flags, tags, priority, moving, and deletion.
- **feat(bulk management)**: Add batch preset migration action via `/preset-scan` and `/batch` endpoint.
- **fix(host)**: Fix Cordis dependency injection for `archiveSession`, resolve annotation accessor closure in `runBatchAction`, and add `unfavorite`/`unreview` to supported batch actions.
- **fix(ui)**: Position bulk dialogs consistently with other dialogs and apply proper dark theme styling.
- **feat(sessions)**: Prioritize `session.v4.jsonl.zstd` in artifact filename list for DSH 0.1.7+ compatibility.
- **test(bulk management)**: Add test coverage for bulk selection, actions, batch execution, and static invariants.

## 0.5.1 — 2026-09-18

- **feat(annotations)**: Add favorites, review-later flags, tags, multiline notes, and priority levels (1 highest to 5 lowest, default 3 Normal) with atomic persistence, conflict detection, and search/sort integration.
- **feat(annotations)**: Add opt-in AI assistance with **Copy Prompt** and **Import** JSON from clipboard, supporting schema validation, smart quote normalization, and repair heuristics.
- **feat(annotations)**: Add inline clear buttons for Tags and Note fields, and streamline dialog layout with unified textarea heights and locale-aware prompts.
- **feat(manager)**: Add case-insensitive title/ID search, workspace and ungrouped filters, creation time sorting, and count indicators.
- **fix(safety)**: Validate session IDs, directory containment, symlinks/junctions, and artifact identity before file operations; prevent overwriting occupied destinations.
- **fix(persistence)**: Separate backup, publication, and rollback phases; preserve recovery files and cleanly abort on write failures.
- **fix(zstd)**: Use structural frame decoding on rewrite paths and reject corrupt or torn log frames.
- **fix(startup)**: Normalize snapshot headers, preserve active sessions during startup scan, and reconcile cleanly.
- **test**: Expand tests covering traversal, junctions, corruption, rollback, and concurrency.

## 0.4.11 — 2026-09-14

- **chore(client)**: Drop obsolete `@deepseek-ai/dsh-client-runtime` reference from `dsh.client.inject` manifest (#12).

## 0.4.10 — 2026-09-13

- **fix(move)**: Rebind live JSONL writer's header path during cross-workspace moves to prevent `ENOENT` on subsequent writes (#8).

## 0.4.9 — 2026-09-12

- **fix(ui)**: Handle Escape key at window level so manager panel and confirmation dialogs close reliably regardless of focus position (#7).
- **fix(ui)**: Remove backdrop click-to-dismiss behavior and dim backdrops to prevent accidental dismissal and page dimming.
- **fix(ui)**: Blur trigger button on Escape close to remove lingering focus rings, and eliminate Enter key race conditions.

## 0.4.7 — 2026-09-10

- **fix(disk scan)**: Include `session.v3.jsonl.zstd` in artifact scanner filenames to detect generation v3 sessions from DSH 0.1.5-rc.1.

## 0.4.6 — 2026-09-05

- **fix(persistence)**: Read all concatenated Zstandard frames in session artifacts to prevent event history truncation.
- **fix(move)**: Synchronize live session state, persistence coordinator, registry indexes, and workspace accounting during move operations.
- **fix(preset migration)**: Fall back to ID-based artifact scan when persistence locate returns stale paths, and mirror migrations into live session projections.
- **recovery**: Add `scripts/heal-v2-sessions.ps1` helper for DSH 0.1.1-rc.2 v2/v0 header anomalies.

## 0.4.5 — 2026-09-05

- **fix(move)**: Keep live agent and session instance in place during cross-workspace moves to preserve UI responsiveness without full re-initialization.
- **fix(preset migration)**: Handle persistence backends gracefully without strict preconditions on `readRaw`/`list`.

## 0.4.4 — 2026-09-03

- **docs**: Standardize terminology from "conversation" to "session" across documentation and package manifests.

## 0.4.3 — 2026-09-03

- **docs**: Add Awesome DSH Plugin badge and registry listing references.

## 0.4.2 — 2026-09-03

- **feat(theme)**: Follow DSH dark/light theme automatically via `data-sm-theme` attribute and scoped CSS variables.

## 0.4.1 — 2026-08-28

- **fix(ui)**: Improve hover contrast and styling on title-bar delete button.

## 0.4.0 — 2026-08-28

- **feat(preset migration)**: Add per-session preset migration action in Session Manager.
- **fix(lifecycle)**: Retire stale live agents and persistence owners prior to move or migration.
- **fix(move)**: Refresh session and workspace state immediately after moving.

## 0.3.0 — 2026-08-27

- **feat(preset migration)**: Introduce preset migration for sessions with renamed or missing Agent presets.
- **feat(move)**: Add cross-workspace move handling and client-side refreshes.

## 0.2.1 — 2026-08-26

- **fix(move)**: Move session artifact, stored working directory, and workspace accounting together while preserving history, title, and metadata.
- **feat(workspaces API)**: Add workspace projection endpoint for move UI.

## 0.2.0 — 2026-08-16

- **feat(move)**: Initial move-to-workspace UI and host endpoints (superseded by 0.2.1).

## 0.1.2 — 2026-08-16

- **docs**: Synchronize package metadata and documentation for initial release.

## 0.1.1 — 2026-08-16

- **fix(panel)**: Hide transient blank-session placeholders from Session Manager panel.
- **test**: Add host API smoke test and CI package verification.

## 0.1.0 — 2026-08-16

- **feat**: Initial release with session deletion, confirmation dialogs, archive management, and Session Manager panel.
