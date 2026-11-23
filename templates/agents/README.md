# Agent files

```mermaid
flowchart LR
  A[AGENTS.md] --> O[OpenCode and other agents]
  A -->|@AGENTS.md| C[CLAUDE.md] --> CC[Claude Code]
  A -.->|no CLAUDE.md| CC
```

| Copy to the repo root | Read by | Fill |
|---|---|---|
| `AGENTS.md` | every coding agent; Claude Code when the repo has no `CLAUDE.md` | each `<...>` cell |
| `CLAUDE.md` | Claude Code: `@AGENTS.md`, then the Claude-only rows | nothing, or Claude-only rows |

Claude Code reads `AGENTS.md` directly when no `CLAUDE.md` exists, and an `@AGENTS.md` import never loads it twice (code.claude.com/docs/en/memory, read 2026-11-13). The Claude-only repo files (`.claude/settings.json`, a reviewer agent, a skill, `REVIEW.md`) are in the Claudius pack's [Claude templates](https://github.com/Colorado-Startups/claudius/tree/main/templates/claude).
