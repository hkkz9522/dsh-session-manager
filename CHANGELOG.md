# Changelog

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
