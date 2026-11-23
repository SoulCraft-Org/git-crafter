# Collector folders

One folder per collector, each a code area of its own. The contract is in [README.md](README.md).

```mermaid
flowchart LR
  F[A folder] --> C[Its collector] --> T[The tabs it fills]
```

| Folder | Collector | Fills the tabs |
| --- | --- | --- |
| `ci/` | `ci.mjs` | Actions, Code, Insights, Issues, Projects, Pull requests, Scanning |
| `code/` | `code.mjs` | Code |
| `docs/` | `docs.mjs` | Documentation |
| `github/` | `github.mjs` | Actions, Code, Dependabot, Discussions, Issues, Pages, Projects, Pull requests, Scanning, Security and quality, Settings |
| `insights/` | `insights.mjs` | Insights |
| `lib/` | shared helpers, no collector | none |
| `settings/` | `repo-settings.mjs` | Settings |
| `site/` | `deploy.mjs`, `design.mjs`, `usability.mjs` | Pages |
| `tests/` | `tests.mjs` | Actions |
| `tools/` | `tools.mjs` | Dependabot |
