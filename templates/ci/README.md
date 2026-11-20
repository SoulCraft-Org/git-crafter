# The CI standard

| What | Holds |
| --- | --- |
| A repo's CI | runs through one reusable workflow, [ci-standard.yml](../../.github/workflows/ci-standard.yml), on free and included minutes only (the owner, 2026-11-02) |
| The workflow's checks | [ci_standard.py](../../tools/ci_standard.py), with exit codes and exceptions, and the parser and rules it imports. All three are embedded verbatim. |
| Where this page and `rules/compute-detail.md` disagree | the rule wins |
| Each dated decision, with how to reverse it | [DECISIONS.md](DECISIONS.md) |

## Adopt Git Crafter

```mermaid
flowchart LR
  C["1 Copy the five files<br/>in one pull request, and nothing else"] --> R["2 Require ci / ci-ok<br/>in a ruleset on the default branch"]
  R --> G["3 Settings, Pages<br/>source: GitHub Actions"]
  G --> P[PR: ci.yml checks<br/>Push to main: pages.yml publishes]
```

| File | Copy to | Then |
| --- | --- | --- |
| [templates/quality/config.json](../quality/config.json) | `<repo>/quality/config.json` | drop unused tabs ([table](../quality/README.md)) |
| [templates/process/config.json](../process/config.json) | `<repo>/quality/process/config.json` | set `repos`, `repo_url` and `heading` |
| [ci.yml](ci.yml) | `<repo>/.github/workflows/ci.yml` | set `paths`, `short` and `standard` |
| [pages.yml](pages.yml) | `<repo>/.github/workflows/pages.yml` | add the repo's doc globs to its `pull_request` paths |
| [dependabot.yml](dependabot.yml) | `<repo>/.github/dependabot.yml` | or add its `github-actions` entry to the repo's own; it bumps both Git Crafter pins together |
| [wiki.yml](wiki.yml) | `<repo>/.github/workflows/wiki.yml` | optional; publishes `wiki/` ([setup](../open/README.md#settings)) |

[pages.yml](pages.yml) calls `actions/pages` with `pages: process quality` and both configs.

## Jobs

| Job | Runner | Does |
| --- | --- | --- |
| `changes` | `ubuntu-slim` | The `paths` and `standard-paths` filters, then the conformance check |
| `short` | `ubuntu-slim` | The `short` commands, under 15 minutes (the `short` input's limit in ci-standard.yml, read 2026-11-04), no Docker |
| `standard` | `ubuntu-latest` | The `standard` commands, when the change touched `standard-paths` (default `paths`) |
| `ci-ok` | `ubuntu-slim` | Fails on a failed job, a failed check, or work skipped although its paths changed |

| Source | 1-core minute | 2-core minute |
| --- | --- | --- |
| [GitHub's runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) (read 2026-11-03) | $0.002 | $0.006 |

## Rules

| Rule | Passes when |
| --- | --- |
| `caller` | a `pull_request` workflow calls `ci-standard.yml` |
| `pin` | at a full SHA with a `# v7.0.0` comment |
| `dependabot` | a `github-actions` entry exists |
| `permissions` | top-level `read` or `none`; no `write-all` |
| `concurrency` | a group that cancels superseded runs, never a deploy |
| `timeout` | every job has `timeout-minutes` |
| `runner` | `ubuntu-slim` or a standard hosted label. Another runner needs an exception with a reason in `<repo>/.github/ci-standard.json` |
| `pinned` | every remote `uses:` at a full SHA, or a step's reference locked in `.github/workflows/actions.lock` |
| `cache` | `npm ci` or `pip install` with a setup cache |
| `no-share` | no per-repo minute guard |
| `blacksmith` | no Blacksmith label outside the chooser, and no Blacksmith sticky disk or Docker layer cache action. No exception waives it |

## Overflow switch

Git Crafter's `pages.yml`, and the standard job of any caller that opts in through `ci-overflow.yml`. [DECISIONS.md](DECISIONS.md) has the meter.

```mermaid
flowchart LR
  V[CI_OVERFLOW_RUNNER] -->|unset| G[ubuntu-latest]
  V -->|a lane label| M[tools/ci_overflow.py]
  M -->|under stop| L[lane label]
  M -->|at stop, unread or repo off the lane| G
```

| Do | How |
| --- | --- |
| On | `gh variable set CI_OVERFLOW_RUNNER --body blacksmith-2vcpu-ubuntu-2404` |
| Off | `gh variable delete CI_OVERFLOW_RUNNER` |
| Opt in | a `runner` job that calls `ci-overflow.yml` with `actions: read`, and `runner:` its label on the `ci` job ([example](../../.github/workflows/ci-overflow.yml)) |
| A second repo | the org's [CI pool](#ci-pool), which serves every repo |
| Meter | `runner` job log |
| New lane | a `lanes` entry, `.github/ci-overflow.json` |
| Exception | `runner`, five jobs, `.github/ci-standard.json` |

## CI pool

One meter per org counts every repo's Blacksmith minutes over a rolling 31 days, as Blacksmith bills them. Every repo's chooser reads its reading, `vars.CI_POOL`, with no token. [DECISIONS.md](DECISIONS.md) has why.

```mermaid
flowchart LR
  C[ci-pool.yml, hourly] --> P[tools/ci_pool.py]
  P -->|reading| V[org variable CI_POOL]
  P -->|at hard stop| R[Blacksmith runner groups: no repos]
  V --> O[tools/ci_overflow.py]
  O -->|fresh, whole, under stop| L[lane label]
  O -->|anything else| G[ubuntu-latest]
```

| Do | How |
| --- | --- |
| App | create it from [`ci-pool-app.json`](ci-pool-app.json) and install it on all repos: Actions read, org Variables write, org Self-hosted runners write, no webhook |
| Meter | copy [`ci-pool.yml`](ci-pool.yml) to `<org>/.github/.github/workflows/`, pinned to the first release with `actions/ci-pool` |
| Variable | `CI_POOL_APP_CLIENT_ID`, the App's client id, at the org |
| Secrets | `CI_POOL_APP_KEY`, the App's private key, in the `.github` repo. Optional: `BLACKSMITH_ORG_TOKEN`, so the reading takes the higher of the meter's count and Blacksmith's own |
| Runner groups | each Blacksmith group's name starts with `Blacksmith`. At the hard stop, 2,850 by default (a goal), the meter sets each to selected repos, with none |
| Resume | run `ci-pool` by hand with `resume` ticked; the groups go back to all repos |
| Repos | `CI_OVERFLOW_RUNNER` set to a lane label, at the org or the repo, and the `runner` job above |
| Reading | version 2; `complete: false` until the meter has caught up; stale after 75 minutes |

