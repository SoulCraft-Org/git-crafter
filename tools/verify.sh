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
# The pages and quality suites run once. On a push, each runs with coverage: it writes an lcov file, and
# code-lcov.mjs prints its summary to this log, where the Quality page's code.test_coverage_pct reads it from
# the newest successful run on main (params.test_suites). A pull request's run is read by no one for coverage,
# so it runs the same tests without it (2026-11-23). No second run either way.
cov="$(mktemp -d)"
trap 'rm -rf "$cov"' EXIT
COVER=(--experimental-test-coverage "--test-coverage-exclude=**/*.test.mjs" --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov)
LCOV=quality/collectors/code/code-lcov.mjs

# suite LABEL FILE TEST...: one node --test run, with coverage unless this is a pull request.
suite() {
  local label="$1" file="$2"
  shift 2
  if [ "${GITHUB_EVENT_NAME:-}" = "pull_request" ]; then
    node --test --test-reporter=spec "$@"
  else
    node --test "${COVER[@]}" --test-reporter-destination="$cov/$file" "$@"
    node "$LCOV" "$label" "$cov/$file"
  fi
}

echo "== deny rules";   python3 -I tools/claude_deny.py --self-test
echo "== hookify rules"; python3 -I tools/hookify_check.py --self-test
echo "== voice lint";   python3 -I tools/voice_lint.py --self-test
echo "== sync tool";    python3 -I tools/claude_os_sync.py --self-test
echo "== ci standard";  python3 -I tools/ci_standard.py --self-test
echo "== ci embed";     python3 -I tools/ci_standard.py embed
echo "== ci overflow";  python3 -I tools/ci_overflow.py --self-test
echo "== ci pool";      python3 -I tools/ci_pool.py --self-test
echo "== shell tools";  python3 -I tools/shell_selftests.py
echo "== public scan";  python3 -I tools/public_scan.py --self-test
echo "== comfy guard";  python3 -I tools/comfy_guard.py --self-test
echo "== json facts";   python3 -I tools/json_facts.py --self-test
echo "== merge policy"; python3 -I tools/merge_policy.py --self-test --policy templates/open/merge_policy.json
echo "== clauses";      python3 -I tools/clause_check.py --self-test
                        python3 -I tools/clause_check.py
echo "== prose";        python3 -I tools/voice_lint.py README.md rules/*.md skills/*/SKILL.md
echo "== pages";        suite Pages pages.lcov tests/pages*.test.mjs
echo "== quality";      node quality/selftest.mjs
                        suite Quality quality.lcov 'quality/**/*.test.mjs' 'config/**/*.test.mjs'
echo "== cloud setup";  node --test tests/cloud-setup.test.mjs
echo "== setup list";   node --test tools/apply_setup*.test.mjs tools/merge_pr*.test.mjs tools/doc_reread.test.mjs
echo "== private terms"; node --test tests/private-terms.test.mjs
echo "== verify";       node --test tests/verify.test.mjs
echo "verify: ok"
