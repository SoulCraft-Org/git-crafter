# Git Crafter

Templates for AI agents to run an open-source or open-weight repo with Claude Code or OpenCode. Git Crafter is licensed under [Apache-2.0](LICENSE) and published by SoulCraft. It began as Code-OS by Colorado Startups ([NOTICE](NOTICE)).

![Diagram of the two pages: scores by tab with a work queue, and process maps of steps](.github/assets/pages.svg)

| Part | Gives a repo |
|---|---|
| [Quality, Speed and Consumption page](https://soulcraft-org.github.io/git-crafter/quality/) | 15 categories, each scored against an ideal from current, dated sources |
| [Process page](https://soulcraft-org.github.io/git-crafter/) | Process maps: each step's tool, rule and metric |
| [CI standard](templates/ci/README.md) | One reusable workflow on GitHub's standard hosted runners |
| [Rules](rules/) and [guards](tools/) | What Claude sessions may do, and a bash guard that blocks one-way doors |

Both pages are public.

## Adopt in three steps

| Step | Copy or set | From |
|---|---|---|
| 1 | `<repo>/quality/config.json`, less unused tabs | [templates/quality](templates/quality/README.md) |
| 1 | `<repo>/quality/process/config.json`, with your repo's name | [templates/process](templates/process/README.md) |
| 1 | `<repo>/.github/workflows/ci.yml` and `<repo>/.github/workflows/pages.yml` | [templates/ci](templates/ci/README.md) |
| 1 | `<repo>/.github/dependabot.yml`, which bumps the Git Crafter pin | [templates/ci/dependabot.yml](templates/ci/dependabot.yml) |
| 2 | A ruleset on `main` requiring `ci / ci-ok` | [templates/ci](templates/ci/README.md) |
| 3 | Settings, Pages: source "GitHub Actions" | [templates/ci](templates/ci/README.md) |

## The 15 categories

Each tab scores Quality, Speed and Consumption, a third each, against goals that name their source ([quality/SCORING.md](quality/SCORING.md)).

| Tab ids | What each measures, which to drop |
|---|---|
| `code` `documentation` `issues` `projects` `pull-requests` `actions` `tests` `security` `insights` `settings` `design` `usability` `deploy` `credits` `tools` | [templates/quality](templates/quality/README.md) |

## The maps

```mermaid
flowchart LR
  AD[Adopt] --> DL[Delivery] --> DP[Deploy] --> ME[Measure]
  GU[Guard] --> DL
  CO[Code] --> DL
  ME -->|each miss a fix| DL
  TR[Triage] -->|issue or card| DL
  SE[Secure] --> DL
  SP[Spend] --> DL
```

Each map's steps: [pages/maps](pages/maps/README.md).

## Rules for Claude sessions

| Rule | Loads | Says |
|---|---|---|
| [delegation](rules/delegation.md) | Every turn | Who decides, who merges, what waits for the owner |
| [keys](rules/keys.md) | Every turn | No session handles a key value |
| [compute](rules/compute.md) | Every turn | Cloud first, free and included credits only |
| [writing-and-gates](rules/writing-and-gates.md) | Every turn | Visual docs, plain prose |
| [compute-detail](rules/compute-detail.md), [comfy](rules/comfy.md), [gates](rules/gates.md), [keys-detail](rules/keys-detail.md) | Matching files | CI pool, GPU tiers, how to build a gate |
| [merging](skills/merging/SKILL.md) | Reviewing and merging | Merge conditions and review depth |

What loads when: the [memory](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills) docs, read 2026-11-03. `tools/claude_os_sync.py` copies the rules and guards into `~/.claude` with `apply`, from the public [manifest.json](manifest.json); [CONTRIBUTING](CONTRIBUTING.md#releases) says when.

## Folder map

| Folder | Holds |
|---|---|
| `actions/` | The `pages` action adopters pin |
| `config/` | Git Crafter's own Quality config, its collector in `config/quality/collectors/`, an org's example config, and [account.example.json](config/account.example.json) for a private overlay (`apply --overlay DIR`) |
| `data/` | Snapshots Git Crafter's pages read |
| `pages/` | The Process and Metrics builder and the map library, `pages/maps/` |
| `quality/` | The Quality engine and its collectors ([README](quality/README.md)) |
| `rules/` | Rules for Claude sessions |
| `skills/` | The `merging` skill |
| `templates/` | The two starters, the CI and pages callers, and the agent files |
| `tests/` | Page and verify tests |
| `tools/` | Guards, lints, sync and the org collector |

## Help

| Need | Go to |
|---|---|
| Help, bugs and ideas | [SUPPORT.md](SUPPORT.md) |
| Changes, and template fixes from adopters | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security problems | [SECURITY.md](SECURITY.md) |
| Maintainer | SoulCraft, the publisher |
