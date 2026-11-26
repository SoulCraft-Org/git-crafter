# Merging from a cloud thread

Part of the [`merging`](SKILL.md) skill, with its authority and precedence. A cloud thread has no `gh pr`, no GraphQL and no `~/.claude`.

| Step | Cloud form |
|---|---|
| Deny check | Skip `claude_deny.py`: there is no settings file to check |
| Wait for checks | Read `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` once CI has had time, never a poll loop |
| Verdict | Post a PR comment whose first line is `Review: MERGE at <40-hex sha>` |
| Review status | Skip it. The cloud proxy refuses commit status writes (HTTP 403), so a ruleset that requires `review` cannot merge from the cloud. The verdict comment is the review |
| Merge | GitHub MCP `merge_pull_request` with `expectedHeadSha`, or `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=<sha> -f merge_method=squash`, with the literal SHA that passed |
| Never | `--admin`, a force-push or a push to the default branch |

## Lessons

| Lesson | Do instead |
|---|---|
| A Claude cloud session refuses GraphQL, so `gh pr` and `gh project` fail | `gh api` REST, or the GitHub MCP tools |
| The cloud proxy refuses commit status writes (HTTP 403) | Post `Review: MERGE at <sha>`, then merge with that SHA as the guard (the table above) |
| A ruleset save asks for a passkey | The owner saves it in the browser |
| Dependabot never reads `packs` in the Quality config | Move them with [bump-pins](../../.claude/skills/bump-pins/SKILL.md). `tools.packs_latest_share` flags one behind |
