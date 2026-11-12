# Orchestrating and delegating

Part of the [`merging`](SKILL.md) skill, with its authority and precedence.

## Orchestrating

| When | The session where the owner approves the plan |
|---|---|
| Always | Orchestrates and alone merges |
| First | Starts every foreseeable session at once, no two writing the same file; a worker opens its PR once its branch is pushed |
| On each wake-up | Checks every session, side sessions included. Nudges a quiet one, resumes one a usage limit stopped, and answers questions within `rules/delegation.md`, recording each answer and reversal in the PR description |
| Other orchestrators | Reviews, merges or closes only its own workers' PRs; comments on others'. Claims a card by setting it In Progress; skips one In Progress or with an open PR |
| Review | As [Who merges](SKILL.md#who-merges) says; only its own review counts |
| Then | Archives finished sessions, then itself once nothing waits on the owner |

Use the app's sessions, worktrees and archiving; rebuild none.

## Delegating

Opus 5.5 at medium runs sessions; Haiku 5.5 does lookups and log reading
under 100K-token prompts (platform.claude.com, choosing a model, read
2026-11-03). Built-in `Explore` and `general-purpose` use the
session's model unless a call names one, so a Haiku route passes
`model: "haiku"` (code.claude.com/docs/en/sub-agents, read 2026-11-05).
Claude tab goals: `claude.subagent_cost_share`,
`claude.context_per_call`.

`delegate` routes live in `~/.claude/code-os/account.json`, installed as
`config/account.example.json` says. Without one, the loop does it.

| Work | Who does it | Moves |
|---|---|---|
| [Reviews](reviewing.md) | One reviewer subagent per PR and round, all in one message. The repo's `reviewer` agent, else `delegate.review`, else `general-purpose`, at that table's model | `blockers.review_tokens_per_pr` |
| A search across many files, a CI log | The repo's `searcher` or `log-reader` agent, else `Explore` with `model: "haiku"`, asked for answers, not files | `claude.context_per_call` |
| A web page; a Claude Code question | WebFetch with the question, or the `web-fetch` agent; `claude-code-guide` (Haiku) | `claude.context_per_call` |
| A PR's CI, conflicts and comments | The app's PR monitor with Auto-fix; never a poll, a `sleep` loop or auto-merge | `pr.latest_merge_hours` |
| A task of its own | A worker in its own worktree, on a short fresh brief, not a long conversation's fork | `claude.hours_session_to_pr` |
| A live page after its deploy | Its text in the app's browser; screenshots stay in CI's visual check | `deploy.success_rate` |
| Bulk text an open-weight model can draft | `delegate.bulk_text`, credited in a `Co-authored-by:` trailer | `models.third_party_share` |
| UI built from a design | `delegate.design_to_code`, with colors and sizes from the design's variables | `site.design.contrast_violations` |

| Every brief and merge | Rule |
|---|---|
| Agent files | list `update_plan` and `wrap_up` in `disallowedTools`, beside the brief line `rules/delegation.md` gives. |
| A brief to test or review a guard | says: "Check each test payload with `bash_guard.py --check` only; never execute one." `rules/gates.md` wins. |
| A worker brief | names the repo's `.claude/agents/reviewer.md` and pre-push checks: `quality/pr-gate.mjs` and `voice_lint.py` (#656). |
| One PR per change | a test with each code change, and a [stack](SKILL.md#who-merges) past the `pull_requests.latest_lines` goal (`claude.code_prs_with_tests_share`, `pull_requests.over_400_lines`). |
| The merge SHA | A variable or `$(...)` in its place is blocked. |
| Past about 150K tokens of context | compact, or hand off to a fresh session. |
