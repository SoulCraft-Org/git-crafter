# Options, off by default

Two free GitHub features this starter leaves off, each a row of [setup.json](../setup.json) marked `optional`.

```mermaid
flowchart LR
  Q[Merge queue] -->|merge_group in ci.yml| G[each queued merge tests first]
  A[Attestations] -->|a step after the build| P[signed provenance for the artifact]
```

## Merge queue

| Step | Do |
|---|---|
| 1 | Add `merge_group:` under `on:` in `ci.yml`. Under it `changes` finds no base commit, so every job runs |
| 2 | Apply the `rules.merge_queue` row with [apply_setup.mjs](../../tools/apply_setup.mjs) |
| 3 | Merge as before with `gh pr merge`. It stays off `--auto` through `repo.no_auto_merge` |

| Fact | Detail |
|---|---|
| CI cost | Each merge adds a CI run, so a quiet repo gains nothing |
| Price | Free on public org repos (GitHub Docs, read 2026-11-13) |

## Attestations

| Step | Do |
|---|---|
| 1 | After the build step, add the [attest action](https://github.com/actions/attest), pinned to a full SHA like every action, with `subject-path` naming the artifact |
| 2 | Give that job `id-token: write`, `attestations: write` and `contents: read` |
| 3 | Read one back: `gh attestation verify <artifact> --repo <owner>/<repo>` |

| Fact | Detail |
|---|---|
| Who needs it | Only a repo that publishes a built artifact |
| Git Crafter | It ships none, so it has no such step |
| Price | Free on public repos (GitHub Docs, read 2026-11-13) |

## Dependabot auto-merge

| Step | Do |
|---|---|
| 1 | Skip `repo.no_auto_merge`: leave it out of `--only` |
| 2 | In the repo's `settings.general_drift` targets, set `expected_from_setup: true` and `expected: {"allow_auto_merge": true}` |
| 3 | Every other pull request still merges at its head commit |
