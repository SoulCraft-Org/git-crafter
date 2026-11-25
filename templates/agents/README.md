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

## Cloud environment for workers

```mermaid
flowchart LR
  E[Environment] --> F{Cache fresh?}
  F -->|yes| S[Session]
  F -->|"no: new, script or hosts changed, or expired"| U[Setup script, as root]
  U -->|exit 0, in time| C[Cache: filesystem snapshot] --> S
  U -->|non-zero| X[Session fails to start, or starts without the install]
```

| Piece | Rule |
|---|---|
| Environment | Limited network with package managers allowed. Keys are network secrets, never variables |
| Setup script | Paste [cloud-setup.sh](cloud-setup.sh) only after a smoke test shows a gap. It installs each repo's lockfile with package scripts off |
| Cache | Keeps what the script wrote to disk, never a running process |
| Session | Starts from the cache. Variables are set here, after the script ran |

The cloud-environments docs cache a script that ends in about 5 minutes, and rebuild the cache after about 7 days ([code.claude.com](https://code.claude.com/docs/en/cloud-environments), read 2026-11-25).
