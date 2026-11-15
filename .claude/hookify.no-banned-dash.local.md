---
name: no-banned-dash
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.(md|mdx|txt)$
  - field: content
    operator: regex_match
    pattern: \u2014|[ ]\u2013[ ]
---

**Banned dash in prose.** The new text holds an em dash, or an en dash with a space on each side, which reads as one. House rule: `rules/writing-and-gates.md`; the checks are `em-dash` and `spaced-en-dash` in `tools/voice_lint.py`.

Use a comma, a semicolon, a period or parentheses, then write the text again. An unspaced en dash in a range, such as 3 to 4 written with an en dash, is fine.

Canonical: Git Crafter `.claude/hookify.no-banned-dash.local.md`, installed in `~/.claude/` by `claude_os_sync.py apply user-claude`. `tools/hookify_check.py --self-test` checks it against voice_lint.
