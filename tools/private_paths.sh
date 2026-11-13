#!/usr/bin/env bash
# private_paths.sh: name each tracked path that must stay off this public repo. tests/verify.test.mjs runs it.
#
# Private: each tracked path .gitignore ignores (the one list of local data files: data/ but data/quality/ less
# local.json, history/ and plan-usage.json, config/accounts/, config/private-terms.txt), and each config/*.json
# that names an "org" (the org config, tools/org_base.mjs findOrgConfig), which has no pattern.
#
# Usage:  bash tools/private_paths.sh
# Exit:   0 none tracked, 1 a private path is tracked, git's own code when git cannot list the files.
set -euo pipefail
cd "$(dirname "$0")/.."

# Each list goes through a file: a failing git stops the check here, where a process substitution hides it.
list=$(mktemp)
trap 'rm -f "$list"' EXIT

bad=0
git ls-files -z -c -i --exclude-from=.gitignore > "$list"
while IFS= read -r -d '' f; do
  echo "private_paths.sh: a private path is tracked: $f" >&2
  bad=1
done < "$list"
git ls-files -z -- 'config/*.json' > "$list"
while IFS= read -r -d '' f; do
  case "$f" in
    config/*/*) continue ;;
    config/*.json) [ -f "$f" ] && grep -Eq '^[[:space:]]*"org"[[:space:]]*:' "$f" || continue ;;
    *) continue ;;
  esac
  echo "private_paths.sh: a private path is tracked: $f" >&2
  bad=1
done < "$list"
exit "$bad"
