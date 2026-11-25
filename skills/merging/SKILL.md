---
name: merging
description: Read before reviewing or merging any pull request, or orchestrating sessions. The merge conditions, review depth by risk, the merge command and the orchestrator's duties.
---

# Merging

Canonical: Git Crafter `skills/merging/SKILL.md`, installed in
`~/.claude/skills/merging/`. It is the on-demand half of
`rules/delegation.md`, whose authority and precedence it shares.

## Who merges

The session that opened a PR reviews it, fixes it and merges it, with no
person in the loop (the owner, 2026-11-25), when, at the head commit:

| # | Condition |
|---|---|
| 1 | `python3 -I ~/.claude/code-os/claude_deny.py --check ~/.claude/settings.json` passes. |
| 2 | Every CI check passed; the repo's verify command passed in the cloud (CI or a `cloud-test` run) after the last change. |
| 3 | The review its risk needs ([reviewing.md](reviewing.md)), one fresh reviewer, the corrections, one check of them. CI decides after that. |

The owner ranks quality, speed and token use above safety, privacy and
security, and wants no over-engineering. A rule fix keeps one regression
case, and a new rule needs a real incident.

| Merge | Rule |
|---|---|
| Order | Post each verdict, then merge passes in order. |
| Checks | Wait once with `gh pr checks N --watch --interval 60` (the 10 s default spends the shared API allowance, #707), then merge without asking the owner (2026-11-10). |
| Pace | Merges a day stay under included Actions money left ÷ days to reset ÷ cost per merge, read each wave (#648). |
| Waiting | A green PR is any orchestrator's at once unless a live claim holds it ([Claim](reviewing.md#claim); the owner, 2026-11-23; `pull_requests.green_waiting_minutes`). |
| Branch rule | Keep "require branches to be up to date" off on `main`, so no merge re-runs the others' CI. |
| Issues first | File issues first ([Tracking](../../rules/gates.md#tracking), each with `--label <area>`), then the verdict. Never edit it: an edit retimes the merge. |
| Verdict | Post a PR comment whose first line is exactly `Review: MERGE at <sha>` (or `BLOCK`), with the full 40-hex SHA. `github-reviews.mjs` (`MARKER`) reads it as the review, since GitHub records none when one account authors and merges. |
| Command | Set `review` on that SHA (`gh api repos/<owner>/<repo>/statuses/<sha> -f state=success -f context=review`) and merge with `gh pr merge N --<method> --auto --match-head-commit <sha>` in an allowed method, typing the literal SHA that passed, never one read at merge time. A push needs a new review. Never use `--admin`. Cloud: [cloud.md](cloud.md). |
| Stack | Past the `pull_requests.latest_lines` goal, stack one PR per layer, each reviewed at head. `gh api -X POST repos/{owner}/{repo}/stacks -F 'pull_requests[]=<n>'`, bottom up, joins them. `gh api -X PUT …/pulls/<top>/merge-async -f sha=<sha> -f merge_method=squash` merges it and those under; `…/merge-async/<uuid>` reads it. |
| Tier 1 | After a tier 1 merge (`user-claude` in `manifest.json`): `git -C <checkout> pull --ff-only`, then `claude_os_sync.py apply user-claude --yes --overlay <account folder>`, then `claude_deny.py --merge ~/.claude/settings.json --yes`. A `cp` leaves the sync record stale (#657). |
| Live site | Load and confirm a live page each merge deploys. |
| Repo `CLAUDE.md` | On main, it may name its orchestrator and merge method within these conditions, never wider. |

| When | Read next |
|---|---|
| Before any review | [Reviewing](reviewing.md) |
| Orchestrating or delegating | [Orchestrating](orchestrating.md) |
| Outside PR | [Outside](outside.md) |
