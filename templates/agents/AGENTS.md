# <Repo name>

Instructions for every coding agent in this repo. OpenCode reads this file, and Claude Code reads it through `CLAUDE.md` ([OpenCode rules](https://opencode.ai/docs/rules), [Claude Code memory](https://code.claude.com/docs/en/memory), read 2026-11-11).

| Topic | Rule |
| --- | --- |
| What this repo is | <one sentence> |
| Build and test | <the commands>. Suites run in CI through Git Crafter's `ci-standard.yml`; locally, run one test file at a time |
| Shipping | Branch, commit, push the branch and open a pull request. Never push to `main` |
| Secrets | Never print, copy or commit a key value. Use each CLI's own login |
| Writing | One idea per sentence, no em dashes. Attribute every figure in its sentence |
