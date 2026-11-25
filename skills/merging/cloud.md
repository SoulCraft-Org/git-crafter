# Merging from a cloud thread

Part of the [`merging`](SKILL.md) skill, with its authority and precedence. A cloud thread has no `gh pr`, no GraphQL and no `~/.claude`.

| Step | Cloud form |
|---|---|
| Deny check | Skip `claude_deny.py`: there is no settings file to check |
| Wait for checks | Read `gh api repos/<owner>/<repo>/commits/<sha>/check-runs` once CI has had time, never a poll loop |
| Verdict | Post a PR comment whose first line is `Review: MERGE at <40-hex sha>` |
| Merge | `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=<sha> -f merge_method=squash`, with the literal SHA that passed |
| Never | `--auto`, `--admin`, a force-push or a push to the default branch |
