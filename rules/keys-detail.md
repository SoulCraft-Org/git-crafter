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

This account's keys checkout, tool and naming are under `keys` in `~/.claude/code-os/account.json`, installed from the account's own overlay; change it there by PR. Read it before you name, check or use a key. The `policy` file it names wins.

| Task | Rule |
|---|---|
| Missing key | The session creates, rotates or revokes it, named as `naming` says, piping each value from its issuer straight into its store, never printed or saved (`gh api … --jq .pem \| gh secret set NAME -R owner/repo`). The owner only signs in where an issuer asks (the owner, 2026-11-11). |
| A command needs one | The `use` line, which the session runs when `use_runs` is `session`, with a child that never prints, stores or transforms the value. A Keychain dialog may ask the owner to click Allow. While `use_runs` is `owner`, fix the keys tool by PR; never hand the owner a command. An `owner_runs` command (add, rotate, remove) moves to the session by PR to the keys tool; until then, use the pipe above. A tool that reads the value from a terminal is a bug: fix it by PR. |
| Check one exists | The `check` commands print names only. |
| No `account.json` | The orchestrator runs apply (the `merging` skill). Run no key command until then. |
