@AGENTS.md

## Claude Code only

| Topic | Rule |
| --- | --- |
| Reviews | Load the `merging` skill before reviewing or merging a pull request |
| Cloud | A cloud thread has no GraphQL (seen 2026-11-25), so `gh pr create` and `gh pr merge` fail. Use `gh api` REST: `gh api repos/<owner>/<repo>/statuses/<sha> -f state=success -f context=review` posts the `review` status the ruleset requires, then `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=<sha> -f merge_method=squash` merges at a reviewed commit |
