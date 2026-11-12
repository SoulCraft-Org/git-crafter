#!/usr/bin/env bash
# secret_scan.sh: run gitleaks over the commits a CI run is answerable for.
#
# `gitleaks git` with its default log options reads every fetched branch
# (`git log --all`), so one false positive on any pushed branch fails every
# pull request and main until someone adds a fingerprint. This script reads
# only the commits a run answers for:
#   BASE and HEAD given and both resolve: BASE..HEAD, the pull request's own
#     commits, a deleted secret included. A secret on another branch fails
#     that branch's own pull request instead.
#   otherwise: every ancestor of HEAD (default HEAD), so a push to the default
#     branch reads its whole history, which also covers a push replaced while
#     it waited.
#
# Usage:  GITLEAKS=<binary> bash tools/secret_scan.sh REPO [BASE] [HEAD]
#         GITLEAKS=<binary> bash tools/secret_scan.sh --self-test
# Exit:   0 nothing found, 1 a finding, 2 usage error, 4 a broken scanner
#         (gitleaks exited with anything but 0 or 7, its own fatal 1
#         included). 4 is not 3 on purpose: the exit contract's 3 means
#         "could not check", which a CI wrapper may turn into a green
#         warning, and a scanner that did not run is never a pass. Never
#         wrap this script in such a wrapper.
set -uo pipefail

scan() {
  local repo="$1" base="${2:-}" head="${3:-}" range rc
  if [ -z "${GITLEAKS:-}" ] || [ ! -x "$GITLEAKS" ]; then
    echo "secret_scan.sh: set GITLEAKS to the gitleaks binary" >&2
    return 2
  fi
  [ -n "$head" ] || head=HEAD
  if ! git -C "$repo" rev-parse --verify --quiet "$head^{commit}" >/dev/null; then
    echo "HEAD $head is not a commit here; scanning every ancestor of HEAD."
    head=HEAD
  fi
  if [ -n "$base" ] && [ "$base" != "0000000000000000000000000000000000000000" ] \
     && git -C "$repo" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    range="$base..$head"
    echo "Scanning the commits in $range."
  else
    range="$head"
    echo "Scanning every ancestor of $head."
  fi
  rc=0
  "$GITLEAKS" git --no-banner --redact --verbose --exit-code 7 --log-opts="$range" "$repo" || rc=$?
  case "$rc" in
    0) return 0 ;;
    7) return 1 ;;
    *) echo "::error::gitleaks exited $rc: the scanner is broken, not clean"; return 4 ;;
  esac
}

# A throwaway repo with a fake key on a side branch and one inside a pull
# request's own commits. The key is built at run time, never committed here.
self_test() {
  local wrong=0 t c0 c1 c3 rc
  t="$(mktemp -d "${TMPDIR:-/tmp}/secret-scan-selftest.XXXXXX")" || { echo "  FAIL could not make a temp dir"; return 1; }
  fake() { printf 'gh = "ghp_%s%s%s%s"\n' 7Gq2Lm9Xa1 Rt5Wz3Kp8B n4Vc6Yh0Ju2 Ed5Fs > "$t/$1"; }
  (
    cd "$t" || exit 1
    git init -q -b main . && git config user.name selftest && git config user.email selftest@example.com
    echo "nothing to find" > clean.txt && git add clean.txt && git commit -qm clean
  ) || { echo "  FAIL could not seed the throwaway repo"; rm -rf "$t"; return 1; }
  c0="$(git -C "$t" rev-parse HEAD)"
  git -C "$t" checkout -q -b side && fake side.txt && git -C "$t" add side.txt && git -C "$t" commit -qm side \
    || { echo "  FAIL setup"; rm -rf "$t"; return 1; }
  git -C "$t" checkout -q -b pr "$c0" && echo more >> "$t/clean.txt" && git -C "$t" commit -qam more \
    || { echo "  FAIL setup"; rm -rf "$t"; return 1; }
  c1="$(git -C "$t" rev-parse HEAD)"
  want() { # NAME WANT ARGS...
    local name="$1" w="$2"; shift 2
    rc=0; scan "$t" "$@" >/dev/null 2>&1 || rc=$?
    if [ "$rc" = "$w" ]; then echo "  OK   $name: exit $rc"; else echo "  FAIL $name: exit $rc, expected $w"; wrong=$((wrong + 1)); fi
  }
  want "a clean pull request ignores a key on another branch" 0 "$c0" "$c1"
  want "an unusable base scans the clean ancestry" 0 "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" "$c1"
  fake pr.txt && git -C "$t" add pr.txt && git -C "$t" commit -qm seeded \
    || { echo "  FAIL setup"; rm -rf "$t"; return 1; }
  git -C "$t" rm -q pr.txt && git -C "$t" commit -qm removed \
    || { echo "  FAIL setup"; rm -rf "$t"; return 1; }
  c3="$(git -C "$t" rev-parse HEAD)"
  want "a key in the pull request's own commits fails, though deleted" 1 "$c0" "$c3"
  git -C "$t" checkout -q main && git -C "$t" merge -q --no-ff -m merge pr \
    || { echo "  FAIL setup"; rm -rf "$t"; return 1; }
  want "a push to main reads main's whole history" 1 "" ""
  rc=0; GITLEAKS="" scan "$t" "$c0" "$c1" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 2 ]; then echo "  OK   an unset scanner is a usage error: exit 2"; else echo "  FAIL an unset scanner: exit $rc, expected 2"; wrong=$((wrong + 1)); fi
  # A scanner that dies with its own fatal exit 1 must read as broken (4),
  # never as clean (0) or as a finding (1).
  local stub
  stub="$t/broken-gitleaks" && printf '#!/bin/sh\necho "fatal: stub" >&2\nexit 1\n' > "$stub" && chmod +x "$stub" \
    || { echo "  FAIL setup"; rm -rf "$t"; return 1; }
  rc=0; GITLEAKS="$stub" scan "$t" "$c0" "$c1" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = 4 ]; then echo "  OK   a scanner that exits 1 is broken: exit 4"; else echo "  FAIL a scanner that exits 1: exit $rc, expected 4"; wrong=$((wrong + 1)); fi
  rm -rf "$t"
  if [ "$wrong" -eq 0 ]; then echo "secret_scan.sh self-test: PASS"; return 0; fi
  echo "secret_scan.sh self-test: FAIL ($wrong)"
  return 1
}

if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit $?
fi
if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "usage: GITLEAKS=<binary> bash tools/secret_scan.sh REPO [BASE] [HEAD] | --self-test" >&2
  exit 2
fi
scan "$@"
exit $?
