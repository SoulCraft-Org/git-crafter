# Collector folders

One folder per collector, each a code area of its own. The contract is in [README.md](README.md).

```mermaid
flowchart LR
  F[A folder] --> C[Its collector] --> T[The tabs it fills]
```

| Folder | Collector | Fills the tabs |
| --- | --- | --- |
| `blockers/` | `blockers.mjs` | Blockers, Claude settings |
| `ci/` | `ci.mjs` | Actions, Pull requests, Issues, Projects, Security and quality, Insights |
| `claude/` | `claude.mjs`, `claude-settings.mjs`, `lead-time.mjs` | Claude, Claude settings, Tokens |
| `code/` | `code.mjs` | Code, Tests |
| `credits/` | `credits.mjs` | Credits |
| `desktop-app/` | `desktop-app.mjs` | Claude desktop app |
| `docs/` | `docs.mjs` | Documentation |
| `github/` | `github.mjs` | Issues, Pull requests, Security and quality, Actions, Projects |
| `insights/` | `insights.mjs` | Insights |
| `instructions/` | `instructions.mjs` | Instructions |
| `lib/` | shared helpers, no collector | none |
| `settings/` | `repo-settings.mjs` | Settings |
| `simplicity/` | `simplicity.mjs` | Instructions, Documentation |
| `site/` | `deploy.mjs`, `design.mjs`, `usability.mjs` | Deploy, Design, Usability |
| `tests/` | `tests.mjs` | Tests |
| `tokens/` | `tokens.mjs` | Tokens, Claude |
| `tools/` | `tools.mjs` | Tools |
