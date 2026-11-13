# Quality starter

[config.json](config.json) turns on all 13 tabs of the Quality, Speed and Consumption page. Copy it to `<repo>/quality/config.json`, then drop the tabs your repo has no use for. Keys: [quality/CONFIG.md](../../quality/CONFIG.md).

```mermaid
flowchart LR
  S[templates/quality/config.json] -->|copy| C[quality/config.json]
  C -->|drop tabs| C
  C --> A[actions/pages<br/>pages: quality]
  A --> P[the repo's Quality page]
```

## What each tab measures

| Tab | Measures |
| --- | --- |
| `code` | size, complexity, copies, dead code, test coverage, Code Quality |
| `documentation` | dead paths, links, visuals, reading time |
| `issues` | bugs and quick fixes, forms, types, labels, time to close |
| `pull-requests` | size, review at head, side-branch merges, wait after green |
| `discussions` | no metrics yet |
| `actions` | CI speed, red time, runner cost, tests, locked and hardened workflows |
| `projects` | board flow, cards at a glance, cycle time |
| `security` (Security and quality) | policy, threat model, alert age, paid features |
| `dependabot` | alerts, malware, updates, dependencies and actions current |
| `scanning` | code scanning, secret scanning, scan minutes |
| `insights` | health files, leftover branches, failed minutes |
| `settings` | rules with no bypass, outside access, unused secrets, rules that wait for a person, settings that bill |
| `pages` | deploys (DORA), design tokens, contrast, Core Web Vitals, axe, task clicks |

## Which tabs to drop

✓ keeps the tab, ✗ drops it.

| Tab | Library | Web app | Docs site | Data or ML |
| --- | :-: | :-: | :-: | :-: |
| `code`, `documentation`, `issues`, `pull-requests`, `discussions`, `actions`, `security`, `dependabot`, `scanning`, `insights`, `settings` | ✓ | ✓ | ✓ | ✓ |
| `pages` (a site the repo serves) | ✗ | ✓ | ✓ | ✗ |
| `projects` | ✓ with a GitHub Project board, else ✗ | same | same | same |
| The six Claude tabs | moved to `Colorado-Startups/claudius`; load them through the `packs` key | same | same | same |
| `credits` (free allowances the repo draws on) | moved to `SoulCraft-Org/compute-crafter`; load it through the `packs` key | same | same | same |

The web tab needs `params.origin` (the production URL) or `params.site_dir` (a built site folder) in `<repo>/quality/targets/`. A dropped tab is not collected, shown or scored.

## From v6 to v7

v7.0.0 maps the tabs onto GitHub's. Every id stays. A removed tab id stops (exit 2) and names its new home.

| Old tab | New tab |
| --- | --- |
| `tests` | `actions`; `code.test_coverage_pct` to `code` |
| `tools` | `dependabot` |
| `deploy`, `design`, `usability` | `pages`, a web tab |
| `security` | `security`; Dependabot to `dependabot`, scanning to `scanning`, workflow hardening to `actions`, Code Quality to `code`, `security.headers` to `pages` |
| `settings`, `pull-requests` | same; `*.dependabot_*` to `dependabot`, `settings.pages_private` to `pages` |
| new | `discussions` |

Each id: [quality/ledger/tab-remap.json](../../quality/ledger/tab-remap.json).

## The Issues tab

| To reach its goal | Do |
| --- | --- |
| `issues.intake_ready` | Copy [bug.yml, fix.yml and config.yml](../../.github/ISSUE_TEMPLATE); each form sets its issue type |
| `issues.parked_open` | Keep work that is not a bug or a quick fix as a draft card on the board. `params.issue_types` lists the types an issue may have; empty turns the check off |
| `issues.area_labeled`, `issues.stray_labels` | Name your area labels in `params.area_labels`, and archive each label nothing uses |

Two ids changed on 2026-11-10: `issues.templates_present` became `issues.intake_ready`, and `issues.oldest_open_bug_days` became `issues.oldest_open_days`. An override that still names an old id stops the build (exit 2).

## Next

| Step | File |
| --- | --- |
| The Process page | [templates/process](../process/README.md) |
| CI, the pages workflow and Dependabot | [templates/ci](../ci/README.md) |
