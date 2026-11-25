---
paths:
  - "**/code-os/account.json"
  - "**/config/accounts/**"
  - "**/.env*"
  - "**/.dev.vars*"
  - "**/*[Ss]ecret*"
---

# Key detail

Canonical: Git Crafter `rules/keys-detail.md`, the on-demand half of `rules/keys.md`, whose precedence it shares.

| Source | Rule |
|---|---|
| `keys` in `~/.claude/code-os/account.json` | Holds this account's keys checkout, tool and naming. It is installed from the account's own overlay. |
| A change to it | Goes to that overlay by PR. |
| When to read it | Before you name, check or use a key. |
| The `policy` file it names | Wins. |

| Task | Rule |
|---|---|
| Missing key | The session creates, rotates or revokes it, named as `naming` says. It pipes each value from its issuer straight into its store, never printed or saved (`gh api … --jq .pem \| gh secret set NAME -R owner/repo`). The owner only signs in where an issuer asks (the owner, 2026-11-11). |
| Check one exists | The `check` commands print names only. |
| No `account.json` | The orchestrator runs apply (the `merging` skill). Run no key command until then. |

| A command needs a key | Rule |
|---|---|
| `use_runs` is `session` | The session runs the `use` line, with a child that never prints, stores or transforms the value. A Keychain dialog may ask the owner to click Allow. |
| `use_runs` is `owner` | Fix the keys tool by PR. Never hand the owner a command. |
| An `owner_runs` command (add, rotate, remove) | It moves to the session by PR to the keys tool. Until then, use the Missing key pipe. |
| A tool reads the value from a terminal | That is a bug: fix it by PR. |
