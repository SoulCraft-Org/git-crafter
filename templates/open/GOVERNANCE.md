# Governance

<Owner> owns the project. AI agents run its day-to-day work under [`AGENTS.md`](AGENTS.md); people hold the seats in [`MAINTAINERS.md`](MAINTAINERS.md).

| Decision | Who decides |
|---|---|
| An idea becomes an issue | The orchestrator, or a maintainer, in Discussions |
| An AI-mergeable PR merges | An AI agent, after the required checks and both AI reviews pass ([`CONTRIBUTING.md`](CONTRIBUTING.md)) |
| A PR on any other path | The orchestrator rebuilds it with credit, or a maintainer reviews it |
| Product, vision and spending | <Owner> |
| The merge policy, the gates, the license, these rules | <Owner>, by pull request |

## The maintainer seat

| Question | Rule |
|---|---|
| Who may ask | A contributor with five merged pull requests over three months who keeps the code of conduct |
| Who decides | <Owner> |
| What the seat can do | Review and merge PRs on maintainer-only paths; turn ideas into issues; welcome new contributors |
| What stays <Owner>'s | The merge policy, the gates, secrets, deploy settings and production |
| How it ends | Stepping down at any time, or six months with no review; <Owner> can end it |

Every seat is held by a person. AI agents never hold one and never approve a pull request.
