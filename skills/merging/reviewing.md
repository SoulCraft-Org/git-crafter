# Reviewing

Part of the [`merging`](SKILL.md) skill, with its authority and precedence.

Every review is a reviewer subagent with a fresh context: the repo's
`reviewer` agent (`.claude/agents/reviewer.md`, four tools), with the Agent
call's `model` set by the table below. When several
pull requests are ready, the orchestrator starts one reviewer per pull
request, all in one message, and never reads the diffs itself.

| The change | Reviewer |
|---|---|
| Guard, workflow, settings, rules or engine changes, or anything over about 200 changed lines | Sonnet 5.5. It reads the diff and that SHA's cloud runs (`gh pr checks`, `gh run view --log`), lists its commands, and finds nothing blocking |
| Docs, config, data, and code under about 200 changed lines with green CI | Haiku 5.5. It reads the diff and the checks |

| Review | Rule |
|---|---|
| Reply | A reviewer returns at most 120 words: `MERGE <sha>` or `BLOCK <sha>`, then each fix as location, problem, replacement. |
| Passes | A reviewer works in two passes, mechanical then judgment. Two real problems beat ten vague ones. |
| A fix after a passed review | needs only its delta from the reviewed SHA reviewed, at the row its files fall in. |
