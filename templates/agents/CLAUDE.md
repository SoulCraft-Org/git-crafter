@AGENTS.md

## Claude Code only

| Topic | Rule |
| --- | --- |
| Reviews | Load the `merging` skill before reviewing or merging a pull request |
| Cloud | A cloud thread has no GraphQL (seen 2026-11-25), so `gh pr create` and `gh pr merge` fail. Use `gh api` REST: `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=<sha> -f merge_method=squash` merges at a reviewed commit |
