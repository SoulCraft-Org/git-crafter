# API keys

Git Crafter `rules/keys.md`. Before you name, check or use a key, read
[`rules/keys-detail.md`](keys-detail.md).

| A session never holds a key value | it never prints, reads, copies, pastes or stores one, or puts one on a command line. The bash guard blocks most of the ways, and a case it misses still applies. Commands that only look at names (`ls`, `test -e`, `stat`, `chmod`) are fine. |
|---|---|
| Never put a secret in | `settings.json` `env`, the Code tab's environment editor, `~/.zshrc` or a cloud environment's variables. |
| Never set `ANTHROPIC_API_KEY` on this Mac | Claude Code ranks it above the subscription login, so it bills the API (code.claude.com/docs/en/iam, read 2026-11-05). Use OAuth connectors or each CLI's login. |
