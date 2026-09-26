
## 0.5.3 — 2026-09-26

- **fix**: issue #17.2 (panel `MoveDialog` now forwards `t` so labels render translated) and issue #17.4 (row Open unarchives archived sessions first).

- **fix**: issue #18 — `moveSession` stamps `header.version` from the target filename so v4-named artifacts don't carry stale v0 headers (which broke DSH startup's `listArtifacts`).

- **fix**: dialog descriptions (`confirm.move.desc`, `confirm.delete.desc`) show only the friendly `displayTitle`, never the raw id. The title-bar lookup is resolved once per render via IIFE — an earlier attempt invoked `useSessions()` inside an event handler, which crashed the slot framework's `useSyncExternalStore` subscriber and let `SlotErrorBoundary` replace the whole `conversation.session.header.actions` slot with `<div data-slot-error="…" />`, taking every title-bar button down.

- **fix**: drop UTF-8 BOM from `package.json` (`JSON.parse` was rejecting it and surfacing the plugin as "all components disabled").

- **chore**: remove leftover `TEMP DEBUG` block in `lib/index.js` (issue #18 debugging residue that spammed the log every 2 s).

- **test**: regression guard added in `test/issue-17-static-guards.test.mjs`; existing `test/issue-18-move-version.test.mjs` covers #18.

## 0.5.2 — 2026-09-23

- **fix(bulk management)**: add a missing entry-point for batch operations. The previous build gated the row checkboxes and `BulkActionBar` behind `selectedIds.size > 0`, so neither was ever reachable from the UI. A new **Select / 选择** toggle in the panel header now reveals the row checkboxes and the bulk action bar; toggling it a second time clears the selection and exits selection mode. Selection-mode state is also reset whenever the panel closes.

- **fix(bulk management)**: the SessionManagerPanel had a duplicated `return` statement above the bulk-dialog declarations (`bulkPreviewDialog`, `bulkProgressDialog`, `bulkResultDialog`, `bulkTagDialog`, `bulkPriorityDialog`, `bulkMoveDialog`, `bulkPresetDialog`). The early return made every bulk dialog unreachable, so the user never saw the confirmation preview, progress bar, or per-id success / failed / skipped result dialog. The duplicate return has been removed; the panel now keeps every dialog declaration live and renders them all in the final Fragment.

- **feat(bulk management)**: add the **Migrate preset…** button to the bulk action bar. Selecting rows and clicking the new button opens a preset picker (sourced from `/preset-scan`) and, on confirm, runs the `preset-migrate` action against every selected session through the existing `/batch` endpoint. Sessions already on the chosen preset are reported as skipped in the result dialog; failed sessions can be retried individually.

- **fix(host /batch)**: the `/session-manager/api/batch` host handler had four regressions that were hidden by the bulk-dialog UI bug fixed in the same release:

  1. **archive** called `ctx.workspaces.archiveSession(sessionId)` directly from the per-request dispatch; Cordis rejected it with `cannot get property 'workspaces' without inject`. The host now exposes an `archiveSession` helper that mirrors `unarchiveSession` and updates `workspaceRegistry.archivedSessionIds` atomically.

  2. **favorite / review / set-priority / add-tags / remove-tags** threw `annotations is not a function` on the first id because the original `runBatchAction` signature destructured `annotations` from its parameter object and callers did not pass it. `runBatchAction` now resolves the annotation accessor from the surrounding closure so it can never again be silently `undefined`.

  3. **unfavorite / unreview** were not in the `BATCH_ACTIONS` set and were rejected with `action 不支持: unfavorite`. Both are now first-class annotation actions; `annotationPatchFromBatchAction` maps them to `{ favorite: false }` / `{ reviewLater: false }`.

  4. the `BATCH_ACTIONS` set, the annotation action set inside `runBatchAction`, and `annotationPatchFromBatchAction` have been kept in sync.

  As a hygiene cleanup, an orphan copy of the same handler that was left inside the file header JSDoc (between `/**` and the real `* @dsh-session-manager` description) has been removed. **Important:** if any of these errors were seen before this fix, hard-refresh DSH (Ctrl+Shift+R) so the cached plugin bundle is replaced with the new one.

- **fix(bulk dialog positioning)**: the bulk preview / progress / result / tag-input / priority / move / preset-migrate dialogs had only a `z-index` rule on `.sm-bulkDialog.sm-nativeDialogLayer` and inherited the default `position: static`, so they rendered in normal document flow at the bottom of the panel (below the row list). They now reuse the same fixed-position `inset: calc(50vh - 90px) auto auto calc(50vw + 308px)` as `.sm-confirmDialog.sm-nativeDialogLayer` and pop up to the right of the panel, matching every other per-row dialog.

- **fix(bulk dialog dark mode)**: every `[data-sm-theme=dark]` override that previously covered `.sm-panelDialog` / `.sm-confirmDialog` / `.sm-migrateDialog` now also covers `.sm-bulkDialog`. Without this, dark mode rendered the bulk dialog body, header, footer, list, result list, progress bar and progress fill in default white-on-white, making the dialog text invisible.

- **fix(footer)**: FooterAction now reads `props.wide` from `SidebarFooterActionOwnerProps` and renders differently for collapsed (`scope: 'root'` rail, 36x36 icon-only button) vs expanded (full-width row, icon + label, left-aligned) sidebar (DSH 0.1.6+ `sidebar.footer.action` slot contract).
- **test(bulk management)**: add client-side coverage for issue #13:     est/client-bulk-selection.test.mjs (static guards on the selection-state hooks),     est/client-bulk-actions.test.mjs (static guards on the BulkActionBar wiring + locale coverage),     est/client-bulk-runbatch.test.mjs (unit coverage for the runBatch wrapper via runInNewContext with a stubbed fetch), and     est/client-bulk-static-guards.test.mjs (cross-cutting structural invariants -- namespace ownership, panel dialog sibling layout, fan-out refresh, host/client action vocabulary). Total tests: 225 (188 pre-existing + 37 new).
- **feat(bulk management)**: add multi-select checkboxes to session rows plus a sticky bulk action bar with archive, unarchive, favorite, unfavorite, mark-for-review, clear-review, add-tags, clear-tags, set-priority, move-to-workspace, and delete actions. Destructive actions run through a BatchPreviewDialog with per-id skip/fail grouping; non-destructive ones fire immediately. Progress, success/failure counts, per-item error reasons, and a one-click **Retry failed** re-arm the failed ids back into the selection. The /batch endpoint is reused so per-id errors surface as partial failures without aborting the batch. Bulk state is reset when the panel closes or the filter excludes a selected row.
- **feat(sessions)**: `ARTIFACT_NAMES` now lists `session.v4.jsonl.zstd` first so DSH 0.1.7 V4-default session artifacts are picked up by the list-snapshot reader. Existing V3/V2/V1 files remain readable; the reader is version-agnostic and parses the header JSON regardless of declared version, so no per-version code paths are required.

## 0.5.1 — 2026-09-18

- **feat(annotations)**: add favorites, manual review flags, tags, multiline notes and priority (1 highest → 5 lowest, default **3 Normal**) to the manager and title bar. Add annotation search/filtering and priority sorting. Persist separately from session history with atomic writes, an inter-process lock, strict limits, conflict detection and deletion cleanup; synchronize browser surfaces and preserve unsaved drafts on failure.

- **feat(annotations)**: add an opt-in AI-assisted workflow in the annotation editor. A **Copy Prompt** / **复制 Prompt** button copies a strict-JSON prompt (Chinese or English, matched to the UI locale) to the clipboard for the user to paste into the current conversation. An **Import** / **导入** button reads the clipboard, extracts the first JSON object (tolerating Markdown fences, conversational wrappers, smart quotes, stray backslashes and a leading BOM), validates tags/note/priority against the same limits, and populates the editor fields. Oversized notes are truncated and flagged in the status message; invalid tags/priority are dropped with reasons. Importing into a dirty draft triggers a confirm. Both buttons stay out of the conversation history — the plugin never calls the model directly. The parser is also exported as `parseClipboardAnnotation` from `lib/clipboard-parser.js` for tests and potential server-side reuse.

- **feat(annotations)**: add inline clear buttons inside the **Tags** and **Note** fields of the annotation editor. Each button only appears while the corresponding field has content and clears it without touching the other controls. Both buttons are disabled while a save is in flight and respect the existing Escape / IME handling.

- **feat(annotations)**: redesign the annotation editor layout. Favorite and review flags stack vertically on the left; priority and its small help text occupy the right column. The **Tags**, **Note**, and AI **paste** textareas all share the same `sm-noteInput` style and `rows: 3` height (60px min-height), so the three input boxes line up visually. The "{count} / 2000 字符" note counter and the "仅用于会话整理" privacy hint are removed; help text is moved into each input's `placeholder`. In the AI paste block the two buttons now sit **above** the paste textarea (导入 on the left, 复制 Prompt on the right) so the editor footer stays consistent. The priority label now uses the same 13px font as the favorite / review checkboxes.

- **feat(annotations)**: remove the "未设置 / Not set" priority option. Priority is always one of 1–5, and the default is **3 (Normal)**; legacy data with `priority: null` is normalized to 3 in display, sort and filter, so there is no longer a separate "always-sorts-last" state. The priority filter dropdown, row badges and header badge all reflect the unified 1–5 scale; AI-returned `"priority": null` is also normalized to 3 by the clipboard parser. The priority help text now reads "1 最高，5 最低，默认 3（普通）" / "1 is highest, 5 is lowest. Default is 3 (Normal)."

- **fix(annotations)**: in the manager's row badges, P1–P5 now always render (legacy `null` renders as P3) so the priority column is visually consistent across all rows instead of being absent for unset entries. The header shortcut button likewise always shows the current P-number badge.

- **fix(annotations)**: the AI copy/paste prompt now follows the active UI language. The dialog detects the language from the t() function (probing `marks.favorite`) instead of relying on `window.__smActiveLanguage`, which was never set; the prompt button writes Chinese under a Chinese UI and English under an English UI even when the global flag is missing.

- **fix(annotations)**: the AI paste workflow's error message now appends the actual `JSON.parse` error position from each recovery attempt (原始 / 修复引号/反斜杠 / 扫描对象 / 扫描对象+修复), so users can see exactly which character broke parsing when the auto-repair still fails. The parser also strips a leading UTF-8 BOM, normalizes smart quotes, and repairs stray single backslashes inside string values.

- **feat(annotations)**: tag input accepts both English `,` and Chinese `，` as separators (regex `/[,，\n]/`), trims whitespace around each tag, drops empty entries, and merges case-insensitive duplicates — so AI outputs in either locale parse cleanly without the user having to re-type the separator.

- **feat(manager)**: add case-insensitive title/session-ID search, workspace/ungrouped filtering, four time-order modes, matching/total counts and reset controls; combine them with the existing archive filter. Creation times are supplied from cached host headers when DSH summaries omit them, without reading logs. Add workspace load/retry handling, stale-request cancellation, narrow-screen layout, IME-safe Escape handling and real-bundle interaction tests.

- **fix(safety)**: validate session IDs, directory containment, symlinks/junctions and artifact identity before deletion or file rewrites; reject an already occupied move destination.
- **fix(persistence)**: separate backup/publication/rollback phases; never delete the original after a failed backup rename. Preserve recovery files and report their paths if rollback fails, and clean uncommitted temporary files after write failures.
- **fix(zstd)**: use structural frame decoding on every rewrite path and reject corrupt/torn logs instead of publishing a decoded prefix.
- **fix(startup)**: distinguish incomplete scans from empty libraries; normalize snapshot headers, preserve live/concurrently attached sessions, and reconcile using a fresh immutable registry state.
- **perf**: read only orphan artifact headers during enumeration and avoid duplicate full readRaw decoding for mutations.
- **chore(test)**: test the real plugin routes instead of a copied move implementation; cover traversal, junctions, corruption, rollback failures, concurrent mutations, and startup read failures. Run module imports, tests, and package checks on Windows/Linux with Node 22.15.0/24; declare the Zstd-capable Node requirement.

## 0.4.11 — 2026-09-14

- **chore(client)**: drop `@deepseek-ai/dsh-client-runtime` from `dsh.client.inject`. The package is no longer shipped by DSH 0.1.5-rc.2 / 0.1.2-alpha or newer (its client-bootstrap role was folded into `@deepseek-ai/dsh-client-store`). This plugin's bundle never required it, so removing the stale reference is a no-op at runtime and only cleans up the published manifest (#12).

## 0.4.10 — 2026-09-13

- **fix(move)**: cross-workspace move no longer breaks the live JSONL writer. The DSH JSONL backend keeps one `JsonlSessionHandle` per session id in an in-process tracker; its `header.cwd` is captured at construction, and the api-gateway's `session/event` router writes through that handle, so a session whose header was rewritten in memory but whose writer was still pointing at the pre-move directory started throwing `ENOENT` on the first new message (issue #8). `moveSession` now mutates the live writer's `header` in place so its persist path flips to the target `cwd` while the same handle, queue, cursor, and lease are retained; the Agent's owned handle therefore stays consistent with the tracker entry, and no `session/disposed` is fabricated. If the runtime does not expose a rebindable writer (older DSH builds or a custom backend), the move now refuses up front with a clear message instead of silently leaving the live session writing to a deleted path. Adds `test/issue-8-move-enoent.test.mjs` (post-move writer identity stability + a "no-fix ENOENT" regression guard) and `test/issue-8-repro/` (a standalone reproducer script).

- **chore**: bump version to 0.4.10.

## 0.4.9 — 2026-09-12

- **fix(ui)**: Session manager panel and inner dialogs (Delete / Move /
  Migrate confirmations) now close on Esc regardless of focus
  position (issue #7). The original layer-bound onKeyDown was
  unreachable because the sidebar toggle / row button that opened
  each modal stayed focused -- focus is a sibling of the layer,
  not a descendant, so keydown never bubbles into the modal subtree.
  ConfirmDialog / MoveDialog are also used by the title-bar Delete
  / Move actions, so this fix applies there too.

- **fix(ui)**: Modals now close ONLY via Esc or their explicit close
  buttons. The original 0.4.7 behavior (close on backdrop click)
  was removed per user feedback -- a stray click outside the panel
  was dismissing it accidentally. Every `.sm-nativeDialogBackdrop`
  `onMouseDown` handler is gone; the dim backdrop itself is also
  gone so opening a modal never darkens the page (sidebar or
  content area).

- **refactor(ui)**: Esc handling moved from per-layer `onKeyDown`
  to a `window`-level `keydown` listener via `useEffect` on every
  modal. A `useRef` lets the listener see the latest state values
  without re-subscribing on every render. The panel listener
  returns early when any inner dialog is open so the child
  dialog's listener gets the first shot at Esc.

- **fix(ui)**: After a keyboard-driven close (Esc), the originally
  focused trigger button (sidebar toggle / row button / Cancel
  button) no longer leaves a lingering `:focus-visible` ring. The
  four Esc handlers `blur()` the active element after the close
  call. Mouse-driven closes are not affected -- `:focus-visible`
  only activates for keyboard-acquired focus.

- **fix(ui)**: ConfirmDialog no longer listens for Enter at the
  layer level. The previous handler raced with the focused Cancel
  button's native Enter handler -- both fired (`onCancel` +
  `onConfirm`). Enter now lives only on the focused button.

- **cleanup(ui)**: Remove three dead `<section>` `ref={(el) =>
  el.focus()}` callbacks (sections have no `tabindex` and are
  not focusable, so the focus calls were silent no-ops). Also
  remove the now-unused `onPanelKey` callback and `tabIndex: -1`
  attributes on the modal layers. The `.sm-nativeDialogBackdrop`
  divs are no longer rendered at all -- they had no behavior left
  after removing the click-to-close.

- **chore**: bump version to 0.4.9.

## 0.4.7 — 2026-09-10

- **fix(disk scan)**: include `session.v3.jsonl.zstd` in the on-disk
  filename list used by readSessionArtifact() and listSessionHeaders().
  DSH 0.1.5-rc.1's persistence backend writes generation v3 artifacts at
  that filename; the 0.4.6 release scanned only v2/plaintext names, so
  fresh sessions appeared to have no disk record and the move/migrate
  endpoints failed with "会话没有磁盘记录" / "session has no artifact".

- **chore**: bump version to 0.4.7.


## 0.4.6 — 2026-09-05

- **fix(persistence)**: read all concatenated Zstandard frames in a session
  artifact. DSH writes one frame for the header and additional frames for
  event batches; reading only the first frame made sessions appear to lose
  their event history after refresh.
- **fix(move)**: preserve the session generation/header version when
  re-homing an artifact, and synchronize the live session, persistence
  coordinator, registry indexes, and workspace accounting after a move.
  This avoids stale-path `ENOENT` failures and v2/v0 filename/header
  mismatches on the next DSH startup.
- **fix(preset migration)**: fall back to an id-based artifact scan when a
  persistence locate result points at a stale path, and mirror cold-path
  migrations into the live session projection.
- **fix(client)**: stop calling the removed/unavailable
  `noteAgentPreset` client method; refresh the session projection instead.
- **recovery**: add `scripts/heal-v2-sessions.ps1` for the DSH 0.1.1-rc.2
  boot-time quirk where `session.v2.jsonl.zstd` contains a `version: 0`
  header. Run it before starting DSH; this repair must happen before DSH's
  workspace initialization, which is earlier than user plugin `apply()`.

- **docs**: bump version to 0.4.6.
## 0.4.5 — 2026-09-05

- **fix(move)**: keep the live session and agent in place during a cross-workspace
  move. The previous code tore down the live agent/session, moved the file, then
  called `ctx.agents.resume` to re-create the agent. DSH's `agent/status` event
  is only emitted on phase changes, so a freshly resumed agent never told the
  client it was now idle, leaving the sidebar's model selector and send button
  disabled ("会话不可用") until a manual browser refresh. The new path flushes
  pending events to disk, updates the in-memory session header + coordinator
  state + workspace accounting in place, and atomically renames the artifact,
  so the agent's UI keeps showing the same in-memory session with no client
  re-init.
- **fix(preset migration)**: drop the over-strict `persistence.readRaw` /
  `persistence.list` precondition that caused the
  `/session-manager/api/preset-scan` endpoint to fail with
  `current persistence backend does not support readRaw/list` on a default DSH
  build. The actual `JsonlSessionPersistence` backend exposes both methods, so
  the precondition is replaced with a try/catch around `listSessionHeaders` that
  converts any missing-method failure into a useful
  `failed to enumerate sessions: <detail>` message.
- **chore**: remove the now-unused `quietLive` / `releaseLiveSession` helpers
  and squash the per-route indentation noise around `/move` and `/workspaces`.

## 0.4.4 — 2026-09-03

- **docs**: rename the English README wording from `conversation` to `session` to align with the plugin name (`dsh-session-manager`), the Chinese README (`会话`), the DSH host APIs, and the [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) registry entry.
- **chore**: rewrite `package.json` `description` to use `Session manager` / `sessions` for the same alignment, and bump the version to `0.4.4`.
- **chore(repo)**: update the GitHub repository description to match.

## 0.4.3 — 2026-09-03

- **docs**: add the [Awesome DSH Plugin](https://awesome-dsh-plugin.com) badge to `README.md` / `README.zh.md` so the repo surfaces its curated registry membership.

## 0.4.2 — 2026-09-03

- **feat(theme)**: dialogs now auto-follow DSH''s dark/light theme (`data-ds-dark-theme` / ` `code-scheme` / `data-theme`) via a single `data-sm-theme` attribute and scoped CSS variables, with inline `background` / `color` / `border-color` applied to each dialog root so they stay opaque regardless of how DSH resolves its own tokens. The previous manual light/dark toggle button is removed.
- **docs**: aligned bilingual README structure, dropped the obsolete "no bulk migration" wording, and added an Acknowledgments section that thanks the users and the contributors filing issues and opening PRs. Listed [dsh-market](https://github.com/dsh-market/dsh-market) and [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) as install sources.
- **chore**: rewrote `package.json` `description` to match the new English summary.

## 0.4.1 — 2026-08-28

- **fix(ui)**: keep the title-bar **Delete conversation** button readable on hover with a red background, white text, and red border; remove the unused legacy danger-button rules.

## 0.4.0 — 2026-08-28

- **feat(session preset migration)**: replaces the former bulk workflow with a
  per-conversation **Migrate preset** action in Session manager. It resolves the
  effective preset from the latest `agent-preset/selected` event or, when absent,
  the session header, then safely updates that one conversation.
- **fix(lifecycle)**: moving a conversation or migrating its preset now retires stale
  live agents and persistence owners before refresh. This prevents resume failures
  such as `already has a live persistence owner`.
- **fix(move)**: refreshes session and workspace state immediately and once more after
  the host event race, so a moved conversation reappears in its target workspace
  without a manual browser refresh.
- **ui**: finalizes header actions and Session manager dialogs: red delete actions,
  per-row preset migration, consistent dialog placement, readable hover states, and
  a close button beside the manager title.
- **docs**: refreshes bilingual documentation and npm metadata for the single-session
  preset migration workflow.

## 0.3.0 — 2026-08-27

- **feat(preset migration)**: introduced preset migration support for conversations
  whose configured Agent preset was renamed or removed.
- **feat(move)**: added workspace move handling and client-side workspace refreshes.

## 0.2.1 — 2026-08-26

- **fix(move)**: reimplemented cross-workspace moves so the session artifact, stored
  `cwd`, and workspace accounting are moved together while preserving history,
  title, archive state, and derived-session relationships.
- **feat(workspaces API)**: added the workspace projection endpoint used by the move UI.
- **guard**: reject subagent and transient blank-session placeholders for move actions.

## 0.2.0 — 2026-08-16

> ⚠️ The initial workspace-move implementation was superseded by 0.2.1.

- **feat(move)**: added the initial move-to-workspace UI and host endpoints.

## 0.1.2 — 2026-08-16

- **docs**: synchronized package metadata and bilingual README files for publication.

## 0.1.1 — 2026-08-16

- **fix(panel)**: hide transient blank-session placeholders from the manager panel.
- **test**: added the host API smoke test.
- **ci**: added syntax and package-content verification.

## 0.1.0 — 2026-08-16

- **feat**: initial session deletion with confirmation, archive management, and the
  Session manager panel.
