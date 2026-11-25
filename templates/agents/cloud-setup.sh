#!/usr/bin/env bash
# cloud-setup.sh: a setup script for the cloud environment that agent workers run in (README.md beside it).
# Paste it into the environment's Setup script box only after a smoke test shows a gap.
# It runs as root in the folder that holds the repo checkouts, after they are cloned and before Claude starts.
# The environment caches the result, so a session that finds the cache skips this script.
# It cannot read the environment's variables or network secrets, so it needs no key and prints none.
set -euo pipefail

# The repo folders to set up. Empty sets up every git checkout here. A named repo the session lacks is skipped.
REPOS=()

# setup_repo DIR: install DIR's packages from its lockfile, with no package scripts run as root.
setup_repo() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo "cloud-setup: $dir is not cloned, skipped"
    return 0
  fi
  cd "$dir"
  if [ -f package-lock.json ]; then
    npm ci --ignore-scripts --no-audit --no-fund
  elif [ -f pnpm-lock.yaml ]; then
    pnpm install --frozen-lockfile --ignore-scripts
  elif [ -f yarn.lock ]; then
    yarn install --frozen-lockfile --ignore-scripts
  fi
  if [ -f uv.lock ]; then
    uv sync --frozen
  fi
  cd - > /dev/null
  echo "cloud-setup: $dir ready"
}

if [ "${#REPOS[@]}" -eq 0 ]; then
  for git_dir in */.git; do
    if [ -e "$git_dir" ]; then
      REPOS+=("${git_dir%/.git}")
    fi
  done
fi
for repo in "${REPOS[@]}"; do
  setup_repo "$repo"
done
echo "cloud-setup: done, ${#REPOS[@]} repos"
