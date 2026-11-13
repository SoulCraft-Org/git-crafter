#!/usr/bin/env bash
# export_public.sh: copy this checkout's tracked files into OUT, less what is the org's own, as the tree a public
# Git Crafter ships. CI's public-export job builds it and runs verify, the pages build and both public scans on it
# (.github/workflows/public-export.yml).
#
# Left out: data/ but data/quality/ less local.json, history/ and plan-usage.json (this account's machine and plan data); tools/bash_guard_{cases,rules}.json ship with
# the account after "sudo -u" replaced by "someone" (home paths there already read /Users/someone), the same in both so the guard's self-test still passes,
# config/accounts/, config/private-terms.txt,
# and each config/*.json that names an "org" (the org config, tools/org_base.mjs findOrgConfig).
#
# Usage:  bash tools/export_public.sh OUT      OUT must be missing or empty
#         bash tools/export_public.sh --check  names each tracked private path; tests/verify.test.mjs runs it on this repo
# Exit:   0 written or none tracked, 1 a private path is tracked, 2 usage error. Prints the count of files copied.
set -euo pipefail

out="${1:-}"
if [ -z "$out" ] || [ "$#" -ne 1 ]; then
  echo "usage: export_public.sh OUT | --check" >&2
  exit 2
fi
check=0
[ "$out" = "--check" ] && check=1
if [ "$check" = 0 ] && [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then
  echo "export_public.sh: $out is not empty" >&2
  exit 2
fi
if [ "$check" = 0 ]; then
  mkdir -p "$out"
  out="$(cd "$out" && pwd)"
fi
cd "$(dirname "$0")/.."

# 0 when a tracked path stays private.
private() {
  case "$1" in
    # Generated machine data of this Mac.
    data/quality/local.json | data/quality/history/* | data/quality/plan-usage.json) return 0 ;;
    data/quality/*) return 1 ;;
    data/* | config/accounts/* | config/private-terms.txt) return 0 ;;
    config/*/*) return 1 ;;
    config/*.json) grep -Eq '^[[:space:]]*"org"[[:space:]]*:' "$1" ;;
    *) return 1 ;;
  esac
}

if [ "$check" = 1 ]; then
  bad=0
  while IFS= read -r -d '' f; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if private "$f"; then
      echo "export_public.sh: a private path is tracked: $f" >&2
      bad=1
    fi
  done < <(git ls-files -z)
  exit "$bad"
fi

n=0
while IFS= read -r -d '' f; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  private "$f" && continue
  mkdir -p "$out/$(dirname "$f")"
  cp -P "$f" "$out/$f"
  case "$f" in
    tools/bash_guard_cases.json | tools/bash_guard_rules.json)
      # The guard names another account (`sudo -u NAME`) on purpose; the public copy keeps the shape, not the name.
      sed -E 's#(sudo -u )[a-z][a-z0-9_-]*#\1someone#g' "$f" >"$out/$f" ;;
  esac
  n=$((n + 1))
done < <(git ls-files -z)
echo "export_public.sh: copied $n files to $out"
