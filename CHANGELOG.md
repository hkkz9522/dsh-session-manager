# Changelog

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
