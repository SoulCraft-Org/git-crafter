---
name: merging
description: Read before reviewing or merging any pull request, or orchestrating sessions. The merge conditions, review depth by risk, the merge command and the orchestrator's duties.
---

# Merging

Canonical: Git Crafter `skills/merging/SKILL.md`, installed in
`~/.claude/skills/merging/`. It is the on-demand half of
`rules/delegation.md`, whose authority and precedence it shares.

## Who merges

The orchestrator that started a worker reviews its PR, fixes it, and
merges when, at the head commit:

| # | Condition |
|---|---|
| 1 | `python3 -I ~/.claude/code-os/claude_deny.py --check ~/.claude/settings.json` passes. |
| 2 | Every CI check passed; the repo's verify command passed in the cloud (CI or a `cloud-test` run) after the last change. |
| 3 | The review its risk needs ([reviewing.md](reviewing.md)), in at most three rounds. After a third, rethink the approach, not a fourth round (Anthropic, "How the Claude Code team does code review", 2026-10-15). |

The owner ranks quality, speed and token use above safety, privacy and
security, and wants no over-engineering. A rule fix keeps one regression
case, and a new rule needs a real incident.

| Merge | Rule |
|---|---|
| Order | Post each verdict, then merge passes in order. |
| Checks | Wait once (`gh pr checks N --watch --interval 60`; the 10 s default spends the shared API allowance, #707), then merge, never asking the owner (2026-11-10). |
| Pace | Merges a day stay under included Actions money left ÷ days to reset ÷ cost per merge, read each wave (#648). |
| Waiting | A green PR is any orchestrator's at once unless it carries a live claim: a PR comment whose first line is `Reviewing <40-hex head sha>`, posted when its review starts. A claim lasts 2 minutes and its session renews it every minute while the review runs (the lease pattern of Amazon SQS's visibility timeout, read 2026-11-23). A claim on an older SHA, or from a session that has ended, counts for nothing. A second merge attempt fails harmlessly under `--match-head-commit`. Basis: 22 reviews on 2026-11-23 took 5 s to 3.6 min, median about 1 min (the owner, 2026-11-23; replaces 2026-11-10's 20 minutes; `pull_requests.green_waiting_minutes`). |
| Branch rule | Keep "require branches to be up to date" off on `main`, so no merge re-runs the others' CI. |
| Issues first | File any issues first (`gh issue create --type Bug --label <area>`, or `--type Task` for a quick fix; an improvement is a draft board card), then post the verdict. Never edit it: an edit retimes the merge. |
| Verdict | Before merging, post a PR comment whose first line is exactly `Review: MERGE at <sha>` (or `BLOCK`), with the full 40-hex SHA. GitHub records no review when one account authors and merges, so `quality/collectors/github/github-reviews.mjs` (`MARKER`) reads this line as the review. |
| Command | Merge with `gh pr merge N --<method> --match-head-commit <sha>` in an allowed method, typing the literal SHA that passed, never one read at merge time. Never use `--auto` or `--admin`. |
| Stack | Past the `pull_requests.latest_lines` goal, a PR per layer atop the last, each reviewed at head. `gh api -X POST repos/{owner}/{repo}/stacks -F 'pull_requests[]=<n>'`, bottom up, joins them. `gh api -X PUT …/pulls/<top>/merge-async -f sha=<sha> -f merge_method=squash` merges it and those under; `…/merge-async/<uuid>` reads it. |
| Tier 1 | After a tier 1 merge (`user-claude` in `manifest.json`): `git -C <checkout> pull --ff-only`, then `claude_os_sync.py apply user-claude --yes --overlay <account folder>`, then `claude_deny.py --merge ~/.claude/settings.json --yes`. A `cp` leaves the sync record stale (#657). |
| Live site | Load and confirm a live page each merge deploys. |
| Repo `CLAUDE.md` | On main, it may name its orchestrator and merge method within these conditions, never wider. |

| When | Read next |
|---|---|
| Before any review | [Reviewing](reviewing.md) |
| Orchestrating or delegating | [Orchestrating](orchestrating.md) |
| Outside PR | [Outside](outside.md) |
