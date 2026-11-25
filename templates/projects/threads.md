# Cloud threads: what loads and what limits

Part of the [Projects setup](README.md). Linked from [instructions.md](instructions.md).

## What a cloud thread loads

A thread clones each attached repo. It does not read everything in `.claude/`.

| In the repo | Cloud thread | If you need it |
|---|---|---|
| `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/` | Loaded. Path-specific rules wait | |
| Skills, agents, commands | Loaded | A dot-named repo skips them: use a local thread |
| `.mcp.json` servers | Not loaded | Use your account's connectors |
| Hooks and permission rules in `.claude/settings.json` | Not run | Use a local thread |
| `env` in `.claude/settings.json` | Not applied | Set it in the cloud environment |

## Limits and cost

| Limit | Value | Do |
|---|---|---|
| Plans | Pro, Max, Ultra. Not Team or Enterprise | Check **Projects** shows in the sidebar |
| New threads | 500 a day across your projects | Start a thread per task, not per step |
| Cache | One hour | Start a fresh thread for new work: an idle thread re-reads its whole history |
| Models | A new project runs Opus at medium effort | Ask for a smaller model on docs and lint threads |
| PR watching | An idle thread wakes on CI or a review comment, and spends usage | Ask the thread to stop watching once the PR merges |
| Usage limit | A thread waits, then continues when the limit resets | Turn off **Continue threads automatically** to stop that |
| Where to read it | **Project settings > Usage** | Check it weekly |

Read 2026-11-25 in [claude-projects](https://code.claude.com/docs/en/claude-projects).
