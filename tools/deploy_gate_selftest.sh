#!/usr/bin/env bash
# deploy_gate_selftest.sh: the self-test `deploy_gate.sh --self-test` runs.
#
# A throwaway origin and clone: main c0..c3 (c3 backdated), production at c0, and a fork
# branch. A stub gh on PATH answers each API path from STUB_RUNS, STUB_PULLS or
# STUB_CHECKS through jq, as gh --jq does. Usage: bash deploy_gate_selftest.sh GATE_SCRIPT
set -uo pipefail
gate="$1"
wrong=0
t="$(mktemp -d "${TMPDIR:-/tmp}/deploy-gate-selftest.XXXXXX")" || { echo "  FAIL no temp dir"; exit 1; }
trap 'rm -rf "$t"' EXIT
mkdir -p "$t/bin"
cat > "$t/bin/gh" <<'STUB'
#!/usr/bin/env bash
[ "${STUB_FAIL:-}" = 1 ] && exit 1
[ "${3:-}" = "--jq" ] || exit 1
member='[{"author_association":"MEMBER","user":{"login":"m"}}]'
author='{"author":{"login":"m"}}'
none='{"check_runs":[]}'
case "$2" in
  */pulls) body="${STUB_PULLS:-$member}" ;;
  */check-runs*) body="${STUB_CHECKS:-$none}" ;;
  */commits/*) body="${STUB_COMMIT:-$author}" ;;
  *) body="$STUB_RUNS" ;;
esac
printf '%s' "$body" | jq -r "$4"
STUB
chmod +x "$t/bin/gh"
(
  set -e
  git init -q --bare -b main "$t/origin.git"
  git init -q -b main "$t/work"
  cd "$t/work"
  git remote add origin "$t/origin.git"
  git config user.name selftest && git config user.email selftest@example.com
  for c in c0 c1 c2; do echo "$c" > f.txt && git add f.txt && git commit -qm "$c"; done
  # c3 claims a committer time years old: the soak must not believe it.
  echo c3 > f.txt && git add f.txt && GIT_COMMITTER_DATE="2020-01-01T00:00:00Z" git commit -qm c3
  git push -q origin main
  git push -q origin "$(git rev-parse HEAD~3):refs/heads/production"
  git checkout -q -b fork && echo f1 > f.txt && git commit -qam f1 && git push -q origin fork
) || { echo "  FAIL could not build the throwaway repos"; exit 1; }
rev() { git -C "$t/work" rev-parse "$1"; }
c0="$(rev main~3)"; c1="$(rev main~2)"; c2="$(rev main~1)"; c3="$(rev main)"; f1="$(rev fork)"

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
runs() { # ci STATUS CONCLUSION, then secret-scan's; "-" for no run. Created now, or at $AT.
  local at="${AT:-$now}"
  local a=("$@") i=0 g rows=('{"path":".github/workflows/ci.yml","id":3,"status":"completed","conclusion":"failure","head_branch":"main","head_repository":{"full_name":"o/r"},"created_at":"'"$at"'"}')
  for g in ci secret-scan; do
    [ "${a[$i]}" = - ] || rows+=("{\"path\":\".github/workflows/$g.yml\",\"id\":$((i + 10)),\"status\":\"${a[$i]}\",\"conclusion\":\"${a[$((i + 1))]}\",\"head_branch\":\"main\",\"head_repository\":{\"full_name\":\"o/r\"},\"created_at\":\"$at\"}")
    i=$((i + 2))
  done
  printf '{"workflow_runs":[%s]}' "$(IFS=,; echo "${rows[*]}")"
}
green="$(runs completed success completed success)"
outside='[{"author_association":"FIRST_TIME_CONTRIBUTOR","user":{"login":"x"}}]'
both='[{"author_association":"MEMBER","user":{"login":"m"}},{"author_association":"CONTRIBUTOR","user":{"login":"x"}}]'
check() { # NAME WANT_EXIT WANT_PRODUCTION SHA ENV...
  local name="$1" want="$2" wantprod="$3" sha="$4" rc got; shift 4
  (cd "$t/work" && env PATH="$t/bin:$PATH" GITHUB_REPOSITORY=o/r DEPLOY_GATES="ci secret-scan" STUB_RUNS="$green" "$@" bash "$gate" "$sha" >"$t/log" 2>&1); rc=$?
  got="$(git -C "$t/origin.git" rev-parse production)"
  if [ "$rc" = "$want" ] && [ "$got" = "$wantprod" ]; then echo "  OK   $name"
  else echo "  FAIL $name: exit $rc (want $want), production ${got:0:7} (want ${wantprod:0:7})"; sed 's/^/       /' "$t/log"; wrong=$((wrong + 1)); fi
}
check "a usage error" 2 "$c0" "not-a-sha"
check "gh cannot list the runs" 3 "$c0" "$c1" STUB_FAIL=1
check "a gate still running waits" 0 "$c0" "$c1" STUB_RUNS="$(runs completed success in_progress none)"
check "a failed gate leaves production" 0 "$c0" "$c1" STUB_RUNS="$(runs completed success completed failure)"
check "a member's fast-forward advances" 0 "$c1" "$c1"
check "a commit production holds is a skip" 0 "$c1" "$c0"
check "a commit not on main is refused" 1 "$c1" "$f1"
check "no gate ran yet waits" 0 "$c1" "$c2" STUB_RUNS="$(runs - - - -)"
check "a gate with no run is not waited for" 0 "$c2" "$c2" STUB_RUNS="$(runs completed success - -)"
check "an outside commit soaks first" 0 "$c2" "$c3" STUB_PULLS="$outside" SOAK_MINUTES=30
check "a member PR holding another PR's outside commit soaks" 0 "$c2" "$c3" STUB_PULLS="$both" SOAK_MINUTES=30
check "a commit its PR's opener did not write soaks" 0 "$c2" "$c3" STUB_COMMIT='{"author":{"login":"x"}}' SOAK_MINUTES=30
check "a commit with no PR soaks" 0 "$c2" "$c3" STUB_PULLS='[]' SOAK_MINUTES=30
check "a backdated commit soaks from its push run, not its committer time" 0 "$c2" "$c3" STUB_PULLS="$outside" SOAK_MINUTES=30
check "a soaked outside commit waits for staging" 0 "$c2" "$c3" STUB_PULLS="$outside" SOAK_MINUTES=0 STAGING_CHECK=staging
check "a soaked outside commit with staging green advances" 0 "$c3" "$c3" STUB_PULLS="$outside" SOAK_MINUTES=0 \
  STAGING_CHECK=staging STUB_CHECKS='{"check_runs":[{"name":"staging","conclusion":"success"}]}'
(cd "$t/work" && git fetch -q origin && git checkout -q -B production origin/production \
 && echo p1 > f.txt && git commit -qam p1 && git push -q origin production && git checkout -q main \
 && echo c4 > f.txt && git commit -qam c4 && git push -q origin main)
check "a non-fast-forward is refused, never forced" 1 "$(git -C "$t/origin.git" rev-parse production)" "$(rev main)"

# The workflow's trigger list must name DEPLOY_GATES' workflows.
root="$(cd "$(dirname "$gate")/.." && pwd)"
wf="$root/.github/workflows/deploy-gate.yml"; [ -f "$wf" ] || wf="$root/templates/ci/deploy-gate.yml"
listed="$(sed -n 's/^ *workflows: *\[\(.*\)\] *$/\1/p' "$wf" | tr -d ' ')"
gates="$(sed -n 's/^ *DEPLOY_GATES: *//p' "$wf" | tr ' ' ',')"
if [ -n "$listed" ] && [ "$listed" = "$gates" ]; then echo "  OK   $(basename "$wf") triggers on DEPLOY_GATES: $listed"
else echo "  FAIL $(basename "$wf"): workflows [$listed] is not DEPLOY_GATES ($gates)"; wrong=$((wrong + 1)); fi
[ "$wrong" -eq 0 ] && { echo "deploy_gate.sh self-test: PASS"; exit 0; }
echo "deploy_gate.sh self-test: FAIL ($wrong)"; exit 1
