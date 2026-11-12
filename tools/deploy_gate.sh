#!/usr/bin/env bash
# deploy_gate.sh: fast-forward the deploy branch to a source-branch commit
# whose gates passed; hold a range with an outside commit until it soaked.
#
# templates/ci/deploy-gate.yml calls it when a gate finishes on a push, and
# on a schedule. It moves DEPLOY_BRANCH to SHA only when all of these hold:
#   1. Every gate in DEPLOY_GATES that ran on SHA's push passed, and at least
#      one ran. One still running means wait; a gate with no run had nothing
#      to answer for.
#   2. SHA is on SOURCE_BRANCH, and the move is a fast-forward. A commit the
#      deploy branch already holds is a skip.
#   3. When a commit in deploy..SHA is outside (no pull request, any of its
#      pull requests opened by someone not OWNER, MEMBER or COLLABORATOR, or
#      an author other than its pull request's opener), SHA's push is at
#      least SOAK_MINUTES old, by its gate run's created_at, never the
#      committer time a contributor sets, and STAGING_CHECK (a check run
#      name, if set) passed on it (skills/merging/outside.md).
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
  local sha="$1" runs gate row id status conclusion state="green" ran=0
  runs="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$sha&event=push&per_page=100" \
    --jq '.workflow_runs[] | select(.head_branch == $ENV.SOURCE and .head_repository.full_name == $ENV.GITHUB_REPOSITORY) | [.path, .id, .status, (.conclusion // "none")] | @tsv')" || return 3
  for gate in "${GATES[@]}"; do
    row="$(awk -F'\t' -v p=".github/workflows/$gate.yml" '$1 == p && ($2 + 0) > max { max = $2 + 0; row = $0 } END { print row }' <<<"$runs")"
    if [ -z "$row" ]; then echo "  $gate: no push run on $sha"; continue; fi
    IFS=$'\t' read -r _ id status conclusion <<<"$row"
    ran=$((ran + 1))
    if [ "$status" != completed ]; then echo "  $gate: run $id is $status"; [ "$state" = red ] || state="wait"
    elif [ "$conclusion" != success ]; then echo "  $gate: run $id concluded $conclusion"; state="red"
    else echo "  $gate: run $id passed"; fi
  done
  if [ "$ran" -eq 0 ]; then echo "  no gate ran on $sha yet"; state="wait"; fi
  echo "$state"
}

# 0 when commit C is inside: it has a pull request, every one opened by an
# inside author, and its author opened one of them. 1 when outside, 3 when gh fails.
is_outside() {
  local c="$1" prs author assoc login seen=1
  prs="$(gh api "repos/$GITHUB_REPOSITORY/commits/$c/pulls" --jq '.[] | "\(.author_association) \(.user.login)"')" || return 3
  author="$(gh api "repos/$GITHUB_REPOSITORY/commits/$c" --jq '.author.login // ""')" || return 3
  [ -n "$prs" ] || return 1
  while read -r assoc login; do
    case "$INSIDE" in *" $assoc "*) ;; *) return 1 ;; esac
    [ "$login" = "$author" ] && seen=0
  done <<<"$prs"
  return "$seen"
}

# The number of outside commits in BASE..SHA. Returns 3 when gh fails.
outside_count() {
  local base="$1" sha="$2" c rc n=0
  for c in $(git rev-list "$base..$sha"); do
    is_outside "$c"; rc=$?
    [ "$rc" -eq 3 ] && return 3
    [ "$rc" -eq 0 ] || n=$((n + 1))
  done
  echo "$n"
}

# "ready" or "soaking", for a range with an outside commit. Returns 3 when gh fails.
soak_state() {
  local sha="$1" pushed age conclusion name
  pushed="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$sha&event=push&per_page=100" \
    --jq '[.workflow_runs[] | select(.head_repository.full_name == $ENV.GITHUB_REPOSITORY) | .created_at | fromdateiso8601] | min // empty')" || return 3
  [ -n "$pushed" ] || { echo "soaking"; return 0; }
  age=$(( $(date +%s) - pushed ))
  if [ "$age" -lt $((SOAK * 60)) ]; then echo "soaking"; return 0; fi
  if [ -n "${STAGING_CHECK:-}" ]; then
    name="$(jq -rn --arg s "$STAGING_CHECK" '$s | @uri')"
    conclusion="$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/check-runs?per_page=100&check_name=$name" \
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
