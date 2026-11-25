# <Project name>: instructions

Paste this file into the project's Instructions field. Fill each `<...>` cell, then delete this paragraph and the rows you do not need. [README.md](README.md) says why each row exists. [threads.md](threads.md) lists what a thread loads and links the limits and spend guards.

| | |
|---|---|
| Purpose | `<one sentence: the stream of work this project keeps moving>` |
| Attached | `<org>/<repo>`, `<org>/<repo>` |
| Add when needed | `<org>/<repo>`, `<org>/<repo>` |
| On the Mac | `~/<folder>/<repo>`, `~/<folder>/<repo>` |
| Runs | Cloud threads, environment `<environment name>` |
| Note | `<one line a thread must know, such as a dot-named repo worked in a thread of its own>` |

| Every thread | Do |
|---|---|
| Ship | Branch `claude/<topic>`. Draft PR within 10 minutes. Push after every step. Review, correct and merge your own PR: one fresh reviewer at head, your corrections, one check of them. On green CI, post `Review: MERGE at <40-hex sha>`, then `gh api repos/<owner>/<repo>/statuses/<sha> -f state=success -f context=review` and `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=<sha> -f merge_method=squash`. Never `--admin`, push to `<default branch>`, force-push or hard-reset. The rule: Git Crafter `skills/merging/SKILL.md` |
| Track | A bug, quick fix or error is an issue typed Bug or Task. A feature or improvement is a draft card on board `<board number>`. A planned feature step is an issue typed Feature, labelled `enhancement`. A thread that cannot reach the board files every feature that way. File each when found, over REST. Record done and to do, and search first ([tracking.md](tracking.md)). The PR's first line is `Closes #n` or `Card: PVTI_id`, in every repo the thread touches. Commands: the repo's `AGENTS.md`, from Git Crafter's `templates/agents/AGENTS.md` |
| Check | Read the repo's `CLAUDE.md` and `AGENTS.md` first, also after adding a repo. CI is the gate |
| GitHub | `<the GitHub tool this environment allows, such as "gh api, not gh pr">` |
| Ask first | Only billing, vision or a critical website decision reaches the owner, as one decision card with options and a recommendation, after research. Human steps wait per Git Crafter `rules/delegation.md`. Decide and execute the rest |
| The owner's actions | Every yes, Allow, copy, paste or quick click goes in the main chat with a direct link to the exact place. Never send the owner into a thread or a browser tab |
| Other owners | Read and pin another owner's template. Never write to it: no push, PR, issue or card |
| Compute | `<where heavy work runs, such as "No GPU or renders in this VM: use <lane> after <owner>'s yes">` |
| Model | The smallest model that passes the check. Re-run only what failed. Usage is the shared limit |
| Keys | Never print, copy or commit a key value |
| Write | Tables and diagrams first. One idea per sentence. No em dashes |
| `<org>` | `<one rule for how a new repo in this org starts, such as "a new repo starts as a row in <org>/<repo>/repos.toml">` |
