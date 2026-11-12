#!/usr/bin/env bash
# verify.sh: every Git Crafter check in one place. CI runs this file; sessions
# read its result with gh pr checks and never run it on this Mac
# (rules/compute.md). One file, so the checks cannot drift. Exit 0 only when
# all pass.
#
# One command per line: set -e stops the script at a failing command only
# when it is not inside an && or || list short of its last, so `a && b` on
# one line let a failing `a` reach "verify: ok" (issue #70).
# tests/verify.test.mjs fails any command in turn and expects verify to stop.
set -euo pipefail
cd "$(dirname "$0")/.."
# The pages and quality suites run once, with coverage: each writes an lcov
# file, and code-lcov.mjs prints its summary to this log, where the Quality
# page's code.test_coverage_pct reads it (params.test_suites). No second run.
cov="$(mktemp -d)"
trap 'rm -rf "$cov"' EXIT
COVER=(--experimental-test-coverage "--test-coverage-exclude=**/*.test.mjs" --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov)
LCOV=quality/collectors/code/code-lcov.mjs

echo "== bash guard";   python3 -I tools/bash_guard.py --self-test
echo "== guard speed";  python3 -I tools/tests/guard_speed.py
echo "== guard parity"; python3 -I tools/tests/guard_parity.py --self-test
echo "== voice lint";   python3 -I tools/voice_lint.py --self-test
echo "== sync tool";    python3 -I tools/claude_os_sync.py --self-test
echo "== ci standard";  python3 -I tools/ci_standard.py --self-test
echo "== ci embed";     python3 -I tools/ci_standard.py embed
echo "== ci overflow";  python3 -I tools/ci_overflow.py --self-test
echo "== shell tools";  python3 -I tools/shell_selftests.py
echo "== public scan";  python3 -I tools/public_scan.py --self-test
echo "== write guard";  python3 -I tools/write_guard.py --self-test
echo "== comfy guard";  python3 -I tools/comfy_guard.py --self-test
echo "== turn check";   python3 -I tools/turn_check.py --self-test
echo "== json facts";   python3 -I tools/json_facts.py --self-test
echo "== clauses";      python3 -I tools/clause_check.py --self-test
                        python3 -I tools/clause_check.py
echo "== prose";        python3 -I tools/voice_lint.py README.md rules/*.md skills/*/SKILL.md
echo "== pages";        node --test "${COVER[@]}" --test-reporter-destination="$cov/pages.lcov" tests/pages*.test.mjs
                        node "$LCOV" Pages "$cov/pages.lcov"
echo "== quality";      node quality/selftest.mjs
                        node --test "${COVER[@]}" --test-reporter-destination="$cov/quality.lcov" 'quality/**/*.test.mjs' 'config/**/*.test.mjs'
                        node "$LCOV" Quality "$cov/quality.lcov"
echo "== verify";       node --test tests/verify.test.mjs
echo "verify: ok"
