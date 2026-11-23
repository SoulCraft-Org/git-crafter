---
name: block-rm-home
enabled: true
event: bash
action: block
pattern: (?:^|[;&|(\n]|\$\(|`|-c\s+['"])\s*(?:(?:sudo|nohup|nice|command|time|timeout\s+\S+|xargs(?:\s+-\S+)*|env(?:\s+-\S+|\s+\w+=\S*)*)\s+)*(?:[./][^\s;&|]*?/)?(?:rm(?=\s)[^;&|\n]*?(?:\s|['"])(?:~|\$HOME|\$\{HOME\}|/)/*(?:\./+)*(?:(?:\.?\*|\.\[[!^]\.\]\*)/*)?(?=$|[\s;&|)`'">])|find\s+(?:-\S+\s+)*['"]?(?:~|\$HOME|\$\{HOME\}|/)/?['"]?\s[^;&|\n]*?(?:-delete|-exec\s+(?:[./][^\s;&|]*?/)?rm\b))
---

**Recursive delete of the home folder or the root.** On 2026-11-04 a local harness deleted this account's home folder, and nothing on this Mac backs it up.

The `permissions.deny` rules in `tools/claude_deny.json` block `rm` by full path and inside `bash`, `sh` or `zsh -c` in every folder. This rule adds what they cannot write: a glob (`~/*`, `~/.*`) or flags after the path, and `find` with `-delete` or `-exec rm` from `~` or `/`, in sessions that load it. The hookify plugin loads `.claude/hookify.*.local.md` from the session's own working folder, so a project session blocks these forms only when that project's `.claude/` holds a copy of this file. Delete the one folder you mean, by its full path under `~`.

Canonical: Git Crafter `.claude/hookify.block-rm-home.local.md`, installed in `~/.claude/` by `claude_os_sync.py apply user-claude`. `tools/hookify_check.py --self-test` checks its examples.
