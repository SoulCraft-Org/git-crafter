---
name: bump-pins
description: Moves the Claudius pack pin in config/quality.json to its latest release tag. Use when Claudius publishes a release.
compatibility: Requires gh signed in and git.
---

# Bump pins

Dependabot bumps action pins (`uses: ...@<sha> # vX`). It never reads `config/quality.json`, so the pack pin moves here. Git Crafter is the engine, so it has no engine pin to move.

| Step | Do |
|---|---|
| 1 | Latest tag: `gh release view -R Colorado-Startups/claudius --json tagName` |
| 2 | The tag's commit: `git ls-remote https://github.com/Colorado-Startups/claudius refs/tags/<tag>^{}` (no `^{}` line: use the plain tag line) |
| 3 | Replace `Colorado-Startups/claudius@<sha>` in `config/quality.json` `packs` |
| 4 | Read the release notes between the old and new tags for a renamed or removed tab id. A removed id stops the build (exit 2) and names its new tab |
| 5 | Open one pull request. Its pages run is the check: no exit 2, no new "not measured" row |

Never pin a branch name, a short SHA or an untagged commit.
