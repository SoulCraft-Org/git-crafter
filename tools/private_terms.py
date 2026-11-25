#!/usr/bin/env python3
# Copy of soulcraft-org/compute-crafter tools/private_terms.py at 9ed8c0166ba9ec68a66ffaf039cb8ce2c3ad7a12 (issue 511). Change it there first, then here.
"""The private half of the private-term rule, run by .github/workflows/private-terms.yml.

No tracked file lists the names this public repo must not contain. Those
names are one regex in the org secret PRIVATE_TERMS. This scans every tracked file for it and prints each hit as
path:line only, never the matched text, because a public repo's Actions log is public too. A string listed in
.github/private-terms-allow (public already, on purpose) is removed from each line before the match.

  PRIVATE_TERMS='...' python3 -I tools/private_terms.py

Exit 0 when clean, 1 on a hit, 2 when the secret is missing. A fork's or Dependabot's pull request gets no secrets
by design, so there it only notes the skip; the push to main then runs it in full.
"""
import functools
import json
import os
import re
import subprocess
import sys

ALLOW = ".github/private-terms-allow"


def no_secrets_by_design() -> bool:
    """Whether GitHub withholds secrets from this pull request: a fork's head, or Dependabot. Any other PR must have it."""
    if os.environ.get("GITHUB_ACTOR") == "dependabot[bot]":
        return True
    try:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as fh:
            head = json.load(fh)["pull_request"]["head"]["repo"]["full_name"]
    except (KeyError, OSError, TypeError, ValueError):
        return False
    return head != os.environ.get("GITHUB_REPOSITORY")


def compile_terms(value):
    """The secret as a case-insensitive regex; exit 2, with the reason printed, when it is empty or not a regex."""
    if not value:
        print("::error::PRIVATE_TERMS is empty; set the org secret for this repo")
        sys.exit(2)
    try:
        return re.compile(re.sub(r"^\(\?i\)", "", value), re.I)
    except re.error:  # its message can quote part of the secret, so the log gets none of it
        print("::error::PRIVATE_TERMS is not a valid regex")
        sys.exit(2)


def finder(terms):
    """A function that says whether a text holds a private term once the allowed strings are cut out of it."""
    allowed = []  # Strings already public on purpose (a GitHub handle CODEOWNERS needs, a license attribution), one per line.
    if os.path.isfile(ALLOW):
        with open(ALLOW, encoding="utf-8") as fh:
            allowed = [re.compile(re.escape(s.strip()), re.I) for s in fh if s.strip() and not s.lstrip().startswith("#")]
    return lambda text: bool(terms.search(functools.reduce(lambda t, literal: literal.sub(" ", t), allowed, text)))


def file_text(name):
    """The text of a tracked file, or None when it cannot be read or is binary. UTF-16 text has NUL bytes but is not binary."""
    try:
        with open(name, "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return data.decode("utf-16", "replace")
    return None if b"\0" in data[:8192] else data.decode("utf-8", "replace")


def scan(n, name, has_term):
    """Print each hit in one tracked file as path:line only, and return how many there were."""
    hits, shown = 0, name
    if has_term(name):  # A path is text too. One that holds a term is never printed: the log would publish it.
        print(f"::error::tracked file #{n} (git ls-files order) has a private term in its path")
        hits, shown = 1, f"tracked file #{n}"
    for line_no, line in enumerate((file_text(name) or "").splitlines(), 1):
        if has_term(line):
            where = f" file={name},line={line_no}" if shown == name else ""
            print(f"::error{where}::a private term ({shown}, line {line_no}); name SoulCraft-Org or a public source only")
            hits += 1
    return hits


def main() -> int:
    """Scan every tracked file for the private terms; exit 0 when clean, 1 on a hit, 2 when the secret is missing."""
    os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))  # paths below are the repo root's
    value = os.environ.get("PRIVATE_TERMS", "").strip()
    if not value and os.environ.get("GITHUB_EVENT_NAME") == "pull_request" and no_secrets_by_design():
        print("::notice::PRIVATE_TERMS is not available to this pull request; the push to main runs the scan")
        return 0
    has_term = finder(compile_terms(value))
    listed = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.decode("utf-8", "replace")
    hits = sum(scan(n, name, has_term) for n, name in enumerate(filter(None, listed.split("\0")), 1))
    print(f"private terms: {hits} hit(s)")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
