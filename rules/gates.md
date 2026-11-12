---
paths:
  - "**/.githooks/**"
  - "**/.claude/hooks/**"
  - "**/.claude/settings*.json"
  - "**/.github/workflows/**"
  - "**/*lint*"
  - "**/*guard*"
  - "**/*_rules.json"
  - "**/*selftest*"
  - "**/verify.sh"
  - "**/contract_test.py"
---

# Gates

Canonical: Git Crafter `rules/gates.md`, the on-demand half of
`rules/writing-and-gates.md`, whose precedence it shares. A gate is any
automated check: a lint, a hook, a guard, a parity or token check.

| Principle | Rule |
|---|---|
| One definition, many call sites | The rule lives in one place, in a real language with a self-test. The agent hook, pre-commit and CI shell out to it; CI never reimplements a check in YAML, which is how gates drift. A call site on this Mac runs only fast single-file checks; suites run in CI ([`rules/compute.md`](compute.md)). |
| Say whether it fires or waits | A gate on a tool-use event fires on every edit; one behind a slash command waits. A comment that claims a call site the settings file does not wire is a defect. |
| The hook routes, it does not decide | Rules inside a hook cannot be reused or tested. |
| Ship a self-test | that seeds a known-bad and a known-clean sample, and fails if either behaves wrong. |
| A guard's test payload never runs | Test commands go only to `bash_guard.py --check` or its self-test, which parse and never execute. Showing what a shell really does runs in CI, never locally (`rules/compute.md`), with a harmless marker such as `echo PWNED` in the payload's place. That harness stops before running anything if one template lacks the placeholder. It starts each shell in its own process group and kills the group on timeout, since `subprocess.run(timeout=)` kills only the shell it started. On 2026-11-04 a local harness ran a template with no placeholder, and bash joined `r\` and `m -rf ~` into `rm -rf ~`. |
| Exempt lists rot | One that must exist gets its own contract test. |
| Block on the certain, warn on the likely | Block fast, deterministic, auto-fixable things. Warn on what a tool's docs call a heuristic, because blocking on one teaches people to bypass the gate. |
| Fail open on infrastructure | A missing interpreter, unreadable file or parse error is "could not verify", never a content violation. |
| A gate an agent can skip is not a gate | A bypass flag is a human call, kept out of the agent's reach. Match narrowly: a guardrail that fires on prose about itself trains people to disable it. |
| Rules belong in data | One machine-readable file holds the terms, tokens and figures, and a test asserts every surface agrees with it. |
