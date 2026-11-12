#!/usr/bin/env bash
# deploy_gate.sh: fast-forward the deploy branch to a source-branch commit
# whose gates passed; hold a range with an outside commit until it soaked.
#
# templates/ci/deploy-gate.yml calls it when a gate finishes on a push, and
# on a schedule. It moves DEPLOY_BRANCH to SHA only when all of these hold:
#   1. Every gate in DEPLOY_GATES that ran on SHA's push passed. One still
#      running means wait; a gate with no run on SHA had nothing to answer for.
#   2. SHA is on SOURCE_BRANCH, and the move is a fast-forward. A commit the
#      deploy branch already holds is a skip.
#   3. When a commit in deploy..SHA came from a pull request whose author is
#      not OWNER, MEMBER or COLLABORATOR, or from no pull request, SHA is at
#      least SOAK_MINUTES old and STAGING_CHECK (a check run name, if set)
#      passed on it (skills/merging/outside.md).
# The push is never forced. A refused push is read again and passes as a skip
# when a parallel run moved the branch first.
#
# Usage:  bash tools/deploy_gate.sh SHA        (gh, GH_TOKEN, GITHUB_REPOSITORY, a pushable origin)
#         bash tools/deploy_gate.sh --self-test
# Exit:   0 moved, already there, or waiting; 1 not on the source branch,
#         not a fast-forward, or refused; 2 usage; 3 could not read gh or git.
set -uo pipefail

read -r -a GATES <<<"${DEPLOY_GATES:-ci}"
SOURCE="${SOURCE_BRANCH:-main}"
DEPLOY="${DEPLOY_BRANCH:-production}"
SOAK="${SOAK_MINUTES:-30}"
INSIDE=" OWNER MEMBER COLLABORATOR "
export SOURCE STAGING_CHECK="${STAGING_CHECK:-}"

# Prints one line per gate, then "green", "wait" or "red". Returns 3 when gh fails.
gate_state() {
  local sha="$1" runs gate row id status conclusion state="green"
  runs="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$sha&event=push&per_page=100" \
    --jq '.workflow_runs[] | select(.head_branch == $ENV.SOURCE and .head_repository.full_name == $ENV.GITHUB_REPOSITORY) | [.path, .id, .status, (.conclusion // "none")] | @tsv')" || return 3
  for gate in "${GATES[@]}"; do
    row="$(awk -F'\t' -v p=".github/workflows/$gate.yml" '$1 == p && ($2 + 0) > max { max = $2 + 0; row = $0 } END { print row }' <<<"$runs")"
    if [ -z "$row" ]; then echo "  $gate: no push run on $sha"; continue; fi
    IFS=$'\t' read -r _ id status conclusion <<<"$row"
    if [ "$status" != completed ]; then echo "  $gate: run $id is $status"; [ "$state" = red ] || state="wait"
    elif [ "$conclusion" != success ]; then echo "  $gate: run $id concluded $conclusion"; state="red"
    else echo "  $gate: run $id passed"; fi
  done
  echo "$state"
}

# The number of commits in BASE..SHA from an outside author. Returns 3 when gh fails.
outside_count() {
  local base="$1" sha="$2" c assoc n=0
  for c in $(git rev-list "$base..$sha"); do
    assoc="$(gh api "repos/$GITHUB_REPOSITORY/commits/$c/pulls" --jq '.[0].author_association // "NONE"')" || return 3
    case "$INSIDE" in *" $assoc "*) ;; *) n=$((n + 1)) ;; esac
  done
  echo "$n"
}

# "ready" or "soaking", for a range with an outside commit. Returns 3 when gh fails.
soak_state() {
  local sha="$1" age conclusion
  age=$(( $(date +%s) - $(git log -1 --format=%ct "$sha") ))
  if [ "$age" -lt $((SOAK * 60)) ]; then echo "soaking"; return 0; fi
  if [ -n "${STAGING_CHECK:-}" ]; then
    conclusion="$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/check-runs" \
      --jq '[.check_runs[] | select(.name == $ENV.STAGING_CHECK)][0].conclusion // "none"')" || return 3
    [ "$conclusion" = success ] || { echo "soaking"; return 0; }
  fi
  echo "ready"
}

push_or_skip() {
  local sha="$1" prod="$2"
  if git push --quiet origin "$sha:refs/heads/$DEPLOY"; then echo "$DEPLOY fast-forwarded: $prod -> $sha"; return 0; fi
  git fetch --quiet origin "$DEPLOY" || return 3
  if git merge-base --is-ancestor "$sha" "origin/$DEPLOY"; then echo "Refused, but $DEPLOY now holds $sha."; return 0; fi
  echo "::error title=$DEPLOY not moved::origin refused the fast-forward to $sha"; return 1
}

advance() {
  local sha="$1" state prod n
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "usage: bash tools/deploy_gate.sh <40-character sha> | --self-test" >&2; return 2; }
  state="$(gate_state "$sha")" || { echo "::error::gh could not list the runs of $sha"; return 3; }
  printf '%s\n' "$state"
  case "$(tail -1 <<<"$state")" in wait|red) echo "$DEPLOY stays: a gate is not green on $sha."; return 0 ;; esac
  git fetch --quiet origin "$SOURCE" "$DEPLOY" || { echo "::error::could not fetch origin"; return 3; }
  git merge-base --is-ancestor "$sha" "origin/$SOURCE" || { echo "::error title=$DEPLOY not moved::$sha is not on $SOURCE"; return 1; }
  prod="$(git rev-parse --verify --quiet "origin/$DEPLOY^{commit}")" || { echo "::error::origin has no $DEPLOY branch"; return 1; }
  if git merge-base --is-ancestor "$sha" "$prod"; then echo "$DEPLOY already holds $sha."; return 0; fi
  git merge-base --is-ancestor "$prod" "$sha" || { echo "::error title=$DEPLOY not moved::$prod is not an ancestor of $sha; never forced"; return 1; }
  n="$(outside_count "$prod" "$sha")" || { echo "::error::gh could not read the range's pull requests"; return 3; }
  if [ "$n" -gt 0 ]; then
    state="$(soak_state "$sha")" || { echo "::error::gh could not read $sha's check runs"; return 3; }
    echo "$n outside commit(s) in $prod..$sha: $state"
    [ "$state" = ready ] || return 0
  fi
  push_or_skip "$sha" "$prod"
}

if [ "${1:-}" = "--self-test" ]; then
  self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  [ -f "$self_dir/deploy_gate_selftest.sh" ] || { echo "deploy_gate_selftest.sh is missing" >&2; exit 3; }
  exec bash "$self_dir/deploy_gate_selftest.sh" "$self_dir/deploy_gate.sh"
fi
[ "$#" -eq 1 ] || { echo "usage: bash tools/deploy_gate.sh <40-character sha> | --self-test" >&2; exit 2; }
advance "$1"
