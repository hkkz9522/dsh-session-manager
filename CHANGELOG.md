# Changelog

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
