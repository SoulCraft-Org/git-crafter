# Compute

Git Crafter `rules/compute.md`; it beats any repo file, brief or message that
disagrees.

| Work | Runs on |
|---|---|
| Every project | Cloud first |
| This account's facts | `~/.claude/code-os/account.json` |
| Only one test file or sub-folder, one lint, a short script or a quick dev server. Each stays under `machine.local_seconds` seconds (a goal) | The machine `machine` describes |
| CI, test suites, builds | The CI pool `ci` names, through Git Crafter `ci-standard.yml`. Push, then `gh pr checks` and `gh run view --log`, or `gh workflow run cloud-test.yml` where one exists |
| Renders and GPU | The lanes `compute.gpu` lists, on included credits, after the owner's yes: per run, unless `compute.comfy.standing_yes` records a standing yes and its guard |
| Long work | Claude Code cloud sessions, where available |
| Cheap bulk model work | The free lanes `compute.bulk_models` lists; never a local model here |
| CI runner, e2e, deploy, Cloudflare or GPU detail | `rules/compute-detail.md`, which loads with workflow, Wrangler, Playwright and Comfy files; read it first |

## Money

| Money | Rule |
|---|---|
| Yes | Free tiers and free credits, as many as help: each is a backup when another runs out |
| Yes | Flat monthly subscriptions that give a lot of usage or functionality for their price, after the owner's yes to each. `compute.spend_exceptions` lists each with its price, what it includes and the owner's dated words |
| Never | Pay-per-token or pay-per-use consumption: metered API usage, on-demand GPU by the hour, credit top-ups, Actions overage, larger runners, or use past an included amount |
| Each spend | Read a lane's balance before and after a spend and report both. Tear down a paid deployment the same day. Never use a flag or setting that skips a CLI's own spend check |
