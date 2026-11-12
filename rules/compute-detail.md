---
paths:
  - "**/.github/workflows/**"
  - "**/.github/scripts/**"
  - "**/ci_runner*"
  - "**/ci_standard*"
  - "**/ci-standard.json"
  - "**/wrangler.{jsonc,json,toml}"
  - "**/playwright*"
  - "**/e2e/**"
  - "**/*[Cc]omfy*"
  - "**/*[Cc]omfy*/**"
---

# Compute detail

Canonical: Git Crafter `rules/compute-detail.md`, the on-demand half of
`rules/compute.md`, whose precedence it shares. It loads when Claude opens
a file these paths match.

## Browsers and deploys

| Work | Runs on |
|---|---|
| Browsers, Playwright, e2e | The repo's e2e job, or `visual-check.yml` where one exists |
| Deploys | The host's own build on merge (`compute.deploys`) |

## The CI pool

| Fact | Source |
|---|---|
| Every repo calls one reusable workflow, Git Crafter `.github/workflows/ci-standard.yml`, pinned to a full SHA with a `# v1` comment Dependabot bumps. The pool is shared: no repo gets a share or a per-repo minute guard | Git Crafter |
| `tools/ci_standard.py`, run in the workflow at the caller's pin, says whether a repo follows the standard | Git Crafter |
| It runs on GitHub's pool only: `ubuntu-slim` for short jobs, since Linux 1-core bills at a third of 2-core; `ubuntu-latest` for standard ones | [runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing) |
| Hard stop: the budget `ci.budget` names. No pool runs without one | `account.json` |
| Overflow: only the lane `ci.overflow` names, and only once the stop it names exists | `account.json` |
| Paid security features stay off unless `ci.paid_features` lists one; the free secret scan and Dependabot stay on | `account.json` |

| Runner labels | Rule |
|---|---|
| CI jobs | run inside `ci-standard.yml`, on `ubuntu-slim` or `ubuntu-latest`. Its standard job takes a lane label only from `ci-overflow.yml`, which a caller opts in to with `actions: read`, while the meter reads it under its stop |
| Any other workflow | hard-codes `ubuntu-slim` or a standard GitHub-hosted label |
| `CI_RUNNER` | reaches a job only through the shared `cloud-test` validator |
| Any other label | needs an exception with a reason in `<repo>/.github/ci-standard.json` |

## Cloudflare CLIs

| Fact | Source |
|---|---|
| Wrangler when the project root has `wrangler.jsonc`, `wrangler.json` or `wrangler.toml`; otherwise `cf`, adding `--profile write` when a plain `cf` call hits a scope error. The default `cf` profile is read-only, so that error means the command writes | Cloudflare's [agent setup prompt](https://developers.cloudflare.com/agent-setup/prompt.md), adopted 2026-10-05; if it disagrees, it wins |

## Gates

| Gate | Covers |
|---|---|
| The bash guard's `local-test-suite` and `local-heavy-compute` rules | the certain local cases; a case they miss still applies |
| [`rules/comfy.md`](comfy.md) | Comfy tiers, and Comfy's own gates. Each account's standing yes, stop and guard are `compute.comfy` fields in `~/.claude/code-os/account.json` |

OpenCode and Goose follow these rules too. A managed policy
(`/Library/Application Support/ClaudeCode/CLAUDE.md`) that allows more,
such as unit tests, yields to the stricter `rules/compute.md`. The options
live in the folder `compute.options` names in
`~/.claude/code-os/account.json`.
