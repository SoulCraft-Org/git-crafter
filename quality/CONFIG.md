# Repo config and overrides

A repo's Quality page settings (`config.mjs`), and how its targets lie over the template's (`overlay.mjs`). Back to [README.md](README.md).

## Repo config

| Key | Default | Means |
| --- | --- | --- |
| `repo` | `GITHUB_REPOSITORY` | `owner/name`, for issue, commit and review links |
| `name` | the repo's name | the page title |
| `tabs` | every template tab but the web tabs | tab ids in order; `["id", "Name"]` adds a tab of the repo's own |
| `web` | `false` | `true` shows Design and Usability, the tabs that score a website |
| `targets` | `<repo>/quality/targets` | the repo's overrides and own metrics |
| `collectors` | `<repo>/quality/collectors` | the repo's own collectors; a template collector's name is a usage error |
| `ideals` | `<repo>/quality/ideals` | the repo's ideal states, one file per tab, in place of the template's |
| `packs` | `[]` | tabs and maps from other repos ([below](#packs)) |
| `reviews`, `data`, `history`, `out` | `<repo>/quality/<key>`; `out` is `<repo>/quality/dist` | folders |
| `tokens_css` | `render/tokens.css` | the color tokens the page draws with |
| `budget` | 1,000,000, per `config.mjs` (read 2026-11-04) | page bytes; one over is exit 1 |
| `issue_sync` | `null`, off | `{ "label", "labels", "project", "quick", "waiting" }` turns on [`sync-issues.mjs`](sync-issues.mjs): on main, one draft card per missed metric on org project `project`, Todo, or Waiting on data for ids in `waiting`. Ids in `quick` open a Task issue instead, labeled `labels[tab]` or `label`; with no `project`, every id does. Cards need env `BOARD_TOKEN` |
| `comment` | | allowed |
| an unknown key | | a usage error |

## Packs

A pack adds Quality tabs and Process maps from another repo ([`packs.mjs`](packs.mjs)). Its collectors run in CI, so it is pinned like an action. `actions/pages` fetches packs only from its `quality-config` file.

| Entry | Means |
| --- | --- |
| `"owner/repo@<40-hex sha>"` | `actions/pages` fetches that commit ([`pack-checkouts.mjs`](pack-checkouts.mjs)) |
| a tag, branch or short SHA | refused: each can move |
| a folder path | `--local` runs only |

| Pack file | Adds |
| --- | --- |
| `pack.json` | `{ "tabs": [["id", "Name"]] }`, each id new |
| `targets/`, `ideals/`, `maps/` | beside the template's, never over it |
| `collectors/` | run with `lib` ([contract](collectors/README.md)) |

Fixture: [`fixtures/pack/`](fixtures/pack/), drawn by [`packs.test.mjs`](packs.test.mjs).

## Overrides

A repo's `targets/<name>.json` lies over the template's by metric id.

```mermaid
flowchart LR
  T[template targets/*.json] --> O[overlay.mjs]
  R[repo targets/*.json] -->|goal, params or drop,<br/>by id| O
  C[repo config tabs] -->|hidden tab: off| O
  O --> D[the page's metric definitions]
```

| Entry | Effect |
| --- | --- |
| `{ "id": "ci.pass_rate", "goal": 98, "near": 90, "goal_source": "…" }` | the repo's goal for a template metric |
| `{ "id": "…", "params": { … } }` | merged key by key over the template's params |
| `{ "id": "…", "drop": true }` | the metric is off: not shown, not scored; collected only when it also has `gate` |
| `{ "id": "…", "gate": true }` | a miss fails the repo's pull request ([SCORING.md](SCORING.md)), even with `drop: true` |
| `{ "id": "…", "gate": "warn" }` | a miss prints a warning; the pull request passes |
| an id the template lacks | the repo's own metric, a full definition |
| any other field on a template id | usage error: tab, kind, direction and label stay the template's |
| a collector whose metrics are all off, by `drop` or a hidden tab | does not run |
