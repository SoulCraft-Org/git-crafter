# Setup check result card

Part of the [Projects setup](README.md). The setup check answers pass or fail per line. This card records the answer, so a later thread reads what the project had on a given day. The [readiness scorecard](scorecard.md) rolls every repo's card into one row.

```mermaid
flowchart LR
  C[Setup check] --> S[Smoke test]
  S --> K[This card: 11 lines a repo]
  K -->|fail| I[One issue per cause]
  K -->|pass| R[Scorecard row: ready]
  R --> G[Scrub gate]
  G --> N[Threads start]
```

## The card

Copy the table into the first thread's result file or a pull request. One row per line of the check, and the same 11 lines for every repo.

| # | Line | Result | What I saw | Read (UTC) | Source |
|---|---|---|---|---|---|
| 1 | `<repo>`: Claude GitHub App installed | ✔ or ✖ | `<installation listed>` | `<time>` | `<repo settings>` |
| 2 | `<repo>`: attached to the project | ✔ or ✖ | `<project name>` | `<time>` | `<Project settings>` |
| 3 | `<repo>`: `CLAUDE.md` or `AGENTS.md` read | ✔ or ✖ | `<what the thread's context showed>` | `<time>` | `<thread>` |
| 4 | `<repo>`: push access | ✔ or ✖ | `<dry-run result>` | `<time>` | `<thread>` |
| 5 | Environment `<name>`: network access set | ✔ or ✖ | `<access level>` | `<time>` | `<Project settings>` |
| 6 | Setup script empty, or proven by a smoke test | ✔ or ✖ | `<empty, or the gap it fixes>` | `<time>` | `<Project settings>` |
| 7 | Each expected key is a network secret | ✔ or ✖ | `<key names only>` | `<time>` | `<Project settings>` |
| 8 | Connectors: none unfinished | ✔ or ✖ | `<n connected, n unfinished>` | `<time>` | `<thread>` |
| 9 | `<repo>`: default branch requires a pull request and `ci / ci-ok` | ✔ or ✖ | `<ruleset names>` | `<time>` | `<API path>` |
| 10 | `<repo>`: master score read | ✔ or ✖ | `<score and build time>` | `<time>` | `<page URL>` |
| 11 | `<repo>`: scrub gate clean | ✔ or ✖ | `<exit code of each scan>` | `<time>` | `<command>` |

| Total | Count |
|---|---|
| ✔ pass | `<n>` |
| ✖ fail | `<n>` |
| All lines | `<n>` |

Lines 5 to 8 belong to the project, not a repo: read them once. A thread reads lines 1 to 8. The orchestrator reads lines 9 to 11, which need the repo's settings, its page and its tree.

## Rules

| Rule | Detail |
|---|---|
| Result | Pass or fail. A line that was not read is a fail, and its row says so |
| What I saw | The value or message read. Names only for keys, never a value |
| Read | The UTC time of the read, and the page or API path, in the same row |
| A fail | One issue per cause in the repo it belongs to, filed after searching ([tracking.md](tracking.md)) |
| Public repos | No private name, path, key or account detail on a card |

## Sources

Read 2026-11-25: [claude-projects](https://code.claude.com/docs/en/claude-projects) for the first message of a project and the threads it starts.
