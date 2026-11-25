# Readiness scorecard

Part of the [Projects setup](README.md). It rolls the [result card](check-card.md) of each repo into one row. The scrub column is read by the [scrub gate](scrub.md). The [audit](audit.md) lists what is on and unused.

One row per repo, one column for each of the 11 lines of the card, in the same order, then a total. A cell is ✔/✖ and nothing else. A repo is ready when all 11 are ✔.

| Repo | App | Attached | Files | Push | Env | Script | Keys | Connectors | Ruleset | Score | Scrub | Ready |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `<repo>` | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | ✔/✖ | `<n>` of 11 |
| Repos ready | | | | | | | | | | | | `<n>` of `<n>` |

| Rule | Detail |
|---|---|
| Source | Each cell copies the result of the same-numbered line on that repo's card. Columns 5 to 8 repeat the project's single read on every row |
| Date | The card's read time heads the scorecard. A cell older than a day is read again |
| Master score | Column 10 passes when the repo's Quality, Speed and Consumption page loads and states a master score. The score itself goes on the card's row, never in the cell |
| Order | Rows by `Ready`, lowest first, so the work to do leads |


## Sources

Read 2026-11-25: [claude-projects](https://code.claude.com/docs/en/claude-projects) for the project's threads and settings the 11 lines read.
