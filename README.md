# Git Crafter

Templates for AI agents to run an open-source or open-weight repo with Claude Code or OpenCode.

| License | Publisher | Began as |
|---|---|---|
| [Apache-2.0](LICENSE) | SoulCraft | Code-OS by Colorado Startups ([NOTICE](NOTICE)) |

![The two pages: scores by tab with a work queue, and process maps of steps](.github/assets/pages.svg)

| Part | Gives a repo |
|---|---|
| [Quality, Speed and Consumption page](https://soulcraft-org.github.io/git-crafter/quality/) | 13 tabs, each scored against an ideal from current, dated sources |
| [Process page](https://soulcraft-org.github.io/git-crafter/) | Process maps: each step's tool, rule and metric |
| [CI standard](templates/ci/README.md) | One reusable workflow on GitHub's standard hosted runners |
| [Rules](rules/) and [guards](tools/) | What Claude sessions may do, and the `permissions.deny` list and hookify rules that block one-way doors |

Both pages are public.

## Quickstart: 3 steps

Re-run end to end in an empty repo on 2026-11-25. Step 1 took under a second, and `ci_standard.py check` then reported that the repo follows the standard.

| Step | Do | From |
|---|---|---|
| 1 | Copy the five starter files with the commands below. Then set `paths`, `short` and `standard` in `ci.yml`, and the `my-repo` and `OWNER` placeholders in the process config | [quality](templates/quality/README.md), [process](templates/process/README.md), [ci](templates/ci/README.md) |
| 2 | A ruleset on `main` requiring `ci / ci-ok` | [templates/ci](templates/ci/README.md) |
| 3 | Settings, Pages: source "GitHub Actions" | [templates/ci](templates/ci/README.md) |

```bash
GC=../git-crafter   # a checkout of this repo, beside yours
mkdir -p quality/process .github/workflows
cp $GC/templates/quality/config.json quality/config.json
cp $GC/templates/process/config.json quality/process/config.json
cp $GC/templates/ci/ci.yml $GC/templates/ci/pages.yml .github/workflows/
cp $GC/templates/ci/dependabot.yml .github/dependabot.yml
python3 -I $GC/tools/ci_standard.py check --repo .   # follows the standard
```

More, each optional:

| Add | From |
|---|---|
| Community files | [open](templates/open/README.md) |
| Switches | [setup.json](templates/setup.json) with `tools/apply_setup.mjs` |
| Agent files | [agents](templates/agents/README.md) |
| Projects | [projects](templates/projects/README.md) |
| CI pool | [CI-POOL.md](templates/ci/CI-POOL.md) |

## The 13 tabs

| Each tab scores | Weight | Against |
|---|---|---|
| Quality, Speed and Consumption | A third each | Sourced goals ([quality/SCORING.md](quality/SCORING.md)) |

| Tab ids | Default |
|---|---|
| `code` `documentation` `issues` `pull-requests` `discussions` `actions` `projects` `security` `dependabot` `scanning` `insights` `settings` | On |
| `pages` | Off: it scores a site, so a repo's config turns it on |

What each measures, and which to drop: [templates/quality](templates/quality/README.md).

## The maps

```mermaid
flowchart LR
  AD[Adopt] --> DL[Delivery] --> DP[Deploy] --> ME[Measure]
  DL --> RE[Release] -->|Dependabot bump| AD
  ME --> SC[Score] -->|issue or card| DL
  DI[Discuss] -->|issue or card| DL
  CT[Contribute] --> DL
  CO[Code] --> DL
  DO[Document] --> DL
  SE[Secure] --> DL
  TR[Triage] -->|issue or card| BO[Board] --> DL
  ME -->|each miss a fix| DL
```

Each map's steps: [pages/maps](pages/maps/README.md).

## Rules for Claude sessions

| Rule | Loads | Says |
|---|---|---|
| [delegation](rules/delegation.md) | Every turn | Who decides and merges |
| [keys](rules/keys.md) | Every turn | No session handles a key |
| [compute](rules/compute.md) | Every turn | Cloud first, free credits, flat plans |
| [writing-and-gates](rules/writing-and-gates.md) | Every turn | Visual docs, plain prose |
| [compute-detail](rules/compute-detail.md), [comfy](rules/comfy.md), [gates](rules/gates.md), [keys-detail](rules/keys-detail.md) | Matching files | CI pool, GPU tiers, gates |
| [merging](skills/merging/SKILL.md) | Reviewing and merging | Merge conditions |

| Item | Detail |
|---|---|
| What loads when | [memory](https://code.claude.com/docs/en/memory) and [skills](https://code.claude.com/docs/en/skills) docs, read 2026-11-03 |
| Install | `tools/claude_os_sync.py apply` copies rules and guards into `~/.claude` from [manifest.json](manifest.json) |
| When | [CONTRIBUTING](CONTRIBUTING.md#releases) |

## Folder map

| Folder | Holds |
|---|---|
| `actions/` | The `pages` and `ci-pool` actions |
| `config/` | Its Quality config, its collector in `config/quality/collectors/`, and [account.example.json](config/account.example.json) for a private overlay (`apply --overlay DIR`) |
| `pages/` | The Process and Metrics builder and map library, `pages/maps/` |
| `quality/` | The Quality engine and collectors ([README](quality/README.md)) |
| `rules/` | Rules for Claude sessions |
| `skills/` | The `merging` skill |
| `templates/` | Starters: `quality/`, `process/`, `ci/`, `open/`, `setup.json`, `agents/`, `projects/` |
| `tests/` | Page, verify tests |
| `tools/` | Guards, lints, sync, org collector |
| `wiki/` | Wiki pages, published on merge |

## Help

| Need | Go to |
|---|---|
| Help, bugs, ideas | [SUPPORT.md](SUPPORT.md) |
| Changes and template fixes | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security problems | [SECURITY.md](SECURITY.md) |
| Maintainer | SoulCraft, publisher |
