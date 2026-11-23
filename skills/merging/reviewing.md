# Reviewing

Part of the [`merging`](SKILL.md) skill, with its authority and precedence.

Every review is a subagent with a fresh context from Anthropic's
`pr-review-toolkit` plugin (claude-plugins-official), with the Agent call's
`model` set by the table below. When several pull requests are ready, the
orchestrator starts one reviewer per pull request, all in one message, and
never reads the diffs itself.

| The change | Reviewer |
|---|---|
| Guard, workflow, settings, rules or engine changes, or anything over about 200 changed lines | `pr-review-toolkit:code-reviewer` at `model: "sonnet"` (Sonnet 5.5), plus `pr-review-toolkit:silent-failure-hunter` when the diff adds error handling or a fallback. It reads the diff and that SHA's cloud runs (`gh pr checks`, `gh run view --log`), lists its commands, and finds nothing blocking |
| Docs, config, data, and code under about 200 changed lines with green CI | `pr-review-toolkit:code-reviewer` at `model: "haiku"` (Haiku 5.5). It reads the diff and the checks |

| Review | Rule |
|---|---|
| Brief | Names the pull request and its 40-hex head SHA, and says: "You are a subagent: never call update_plan or wrap_up. Read with `gh pr diff N` and `gh pr checks N`; never check out a branch, run tests or builds, or merge, approve or comment." |
| Reply | The brief asks for at most 120 words: `MERGE <sha>` or `BLOCK <sha>`, then each fix as location, problem, replacement. |
| Verdict | The orchestrator, not the reviewer, posts the `Review: MERGE at <sha>` line ([Who merges](SKILL.md#who-merges)). |
| Passes | A reviewer works in two passes, mechanical then judgment. Two real problems beat ten vague ones. |
| A fix after a passed review | needs only its delta from the reviewed SHA reviewed, at the row its files fall in. |

## Claim

| Claim | Rule |
|---|---|
| Post | When a review starts, the orchestrator comments `Reviewing <40-hex head sha>` on the PR. It never starts with `Review:`, so no reader takes it for a verdict. |
| Lease | A claim lasts 2 minutes; its session renews it every minute while the review runs (Amazon SQS visibility timeout, read 2026-11-23). |
| Void | A claim on an older SHA, or from a session that has ended, counts for nothing. A second merge attempt fails harmlessly under `--match-head-commit`. |
| Basis | 22 reviews on 2026-11-23 took 5 s to 3.6 min, median about 1 min. |
