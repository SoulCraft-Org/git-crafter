# <Project name>: instructions

Paste this file into the project's Instructions field. Fill each `<...>` cell, then delete this paragraph and the rows you do not need. [README.md](README.md) says why each row exists. [threads.md](threads.md) lists what a thread loads and each limit.

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
| Ship | Branch `claude/<topic>`. Draft PR within 10 minutes. Push after every step. Stop at the open PR: never merge, never push to `<default branch>` |
| Check | Read the repo's `CLAUDE.md` and `AGENTS.md` first, also after adding a repo. CI is the gate |
| GitHub | `<the GitHub tool this environment allows, such as "gh api, not gh pr">` |
| Ask first | Spend, deletes, posts, credentials: ask in the PR body. Decide the rest |
| Compute | `<where heavy work runs, such as "No GPU or renders in this VM: use <lane> after <owner>'s yes">` |
| Track | A bug or quick fix is a typed issue. A feature or improvement is a card on the owner's board. The PR's first line is `Closes #n`, in every repo the thread touches | Work stays traced, finished or open |
| Model | The smallest model that passes the check. Re-run only what failed | Usage is the shared limit |
| Keys | Never print, copy or commit a key value |
| Write | Tables and diagrams first. One idea per sentence. No em dashes |
| `<org>` | `<one rule for how a new repo in this org starts, such as "a new repo starts as a row in <org>/<repo>/repos.toml">` |
