#!/usr/bin/env python3
"""ci_standard.py: the Git Crafter CI standard's checks, and whether a repo follows it.

The standard is one reusable workflow in Git Crafter, .github/workflows/ci-standard.yml (templates/ci/README.md). Each
repo calls it in about ten lines, pinned to a full Git Crafter commit SHA with a # v1 comment that Dependabot bumps.
GitHub's pool only for now: ubuntu-slim for short jobs, ubuntu-latest for standard ones, and the org's $0 Actions
budget with prevent_further_usage as the hard stop. Free tiers and included minutes only (owner, 2026-11-02).

This file, ci_standard_yaml.py (the parser), ci_standard_rules.py (the rules) and ci_standard_actions.py (the pinned
rule) are the one definition. `embed` writes the four, verbatim, into the workflow's run block, so a caller's run uses the copies at the caller's pin: a
called workflow cannot read private Git Crafter files with the caller's token, and a pull request in the caller cannot
edit them. tools/verify.sh runs `embed` to prove the copies are current. Actions evaluates an expression anywhere in a
workflow, so these sources never spell one (EXPR). The embed command (ci_standard_embed.py) and the self-test
(tests/test_ci_standard.py) stay outside the workflow; there both exit 2 with a pointer.

    ci_standard.py check [--repo DIR] [--json] [--behind]
        every workflow in DIR/.github/workflows; --behind also asks gh how many commits the pin is behind
        Git Crafter main
    ci_standard.py changes --paths=LINES [--base=SHA] [--output=NAME]
        NAME=true (default run) when the change since BASE touched a path glob or .github/workflows/; unknown means
        run. NAME is the step output, so one step can ask twice: the standard job's own paths, a docs-only change.
        A glob that starts with /, ./ or ! can never match a git path: exit 2, so ci-ok fails (#199). A glob that
        matches no file git tracks at HEAD prints a ::warning::
    ci_standard.py embed [--write]
        whether ci-standard.yml holds the four files verbatim; --write puts them there
    ci_standard.py --self-test
        seeded known-good and known-bad repos, changes in a scratch git repo, the parser and the embed

Exit 0 the repo follows the standard, 1 it has findings, 2 usage error, 3 could not check (a workflow the parser
cannot read, a job that is not a mapping, or a malformed .github/ci-standard.json). Could not check is never
counted as following.

Rules, one id each; templates/ci/README.md explains each one:

    caller       a pull_request workflow has a job that uses <owner>/git-crafter/.github/workflows/ci-standard.yml (or code-os, its old name)
    pin          that uses: is at a full 40-character commit SHA, with a version comment such as # v1
    dependabot   .github/dependabot.yml has a github-actions entry, which bumps the pin
    permissions  every workflow has a top-level permissions mapping of read or none; no job has write-all
    concurrency  a pull_request or push workflow has a concurrency group; it cancels superseded runs (a bare group
                 name never does), and never a deploy (cancel-in-progress unset, false, or exactly the templates'
                 expression that is true only on pull requests)
    timeout      every job that runs steps has timeout-minutes
    runner       every job runs on ubuntu-slim or a standard GitHub-hosted label. vars.CI_RUNNER, macOS, Windows, a
                 larger, self-hosted or computed runner needs an exception
    pinned       every remote uses:, on a step or a job, is pinned to a full commit SHA, or a step's is locked in actions.lock;
                 a local action's (uses: ./PATH) own steps too, read from PATH/action.yml
    cache        a job that runs npm ci or pip install uses setup-node or setup-python with cache
    no-share     no per-repo minute guard (build_minutes_guard.py): the org pool replaces per-repo shares
    blacksmith   no Blacksmith label outside ci-standard.yml's chooser, and no Blacksmith sticky disk or Docker layer
                 cache action; no exception waives it, since no meter stops either bill

Exceptions live in the repo's .github/ci-standard.json, each with a reason a reviewer reads:

    {"version": 1, "exceptions": {"deploy.yml/deploy": {"rules": ["runner"], "why": "..."}},
     "skip": {"dependabot.yml": "..."}}

A key is a workflow file name, or file/job for one job. Standard library only: the parser reads the block YAML
subset GitHub workflows use (mappings, sequences, flow lists, block scalars, an anchor on a value and an alias to it)
and refuses merge keys and tags, which GitHub does not read either.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys

# python3 -I leaves this folder off sys.path; the parser and the rules sit beside this file, in Git Crafter and in the
# workflow's $RUNNER_TEMP alike. Appended, so the standard library always wins a name.
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.append(HERE)

from ci_standard_rules import FULL_SHA, UsageError, check_repo  # noqa: E402


def glob_re(pattern: str) -> re.Pattern:
    """A path glob: ** crosses folders, * and ? stay inside one, a trailing / means the whole folder."""
    if pattern.endswith("/"):
        pattern += "**"
    out, i = "", 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif pattern.startswith("**", i):
            out, i = out + ".*", i + 2
        elif pattern[i] in "*?":
            out, i = out + ("[^/]*" if pattern[i] == "*" else "[^/]"), i + 1
        else:
            out, i = out + re.escape(pattern[i]), i + 1
    return re.compile(out)


def known_base(base: str) -> bool:
    """Whether base is a full commit SHA, and not the all-zero SHA of a first push."""
    return bool(FULL_SHA.fullmatch(base or "")) and set(base) != {"0"}


def changed_files(base: str, cwd: str):
    """The files changed since base, or why git could not list them."""
    try:
        r = subprocess.run(["git", "diff", "--name-only", "-z", f"{base}...HEAD"], cwd=cwd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return "git did not run: run"
    if r.returncode != 0:
        return "could not list the change: run"
    return [f for f in r.stdout.decode("utf-8", "replace").split("\0") if f]


def patterns_of(paths: str) -> list:
    """The path globs in paths, one per line; blank lines and # comments dropped."""
    return [p.strip() for p in (paths or "").splitlines() if p.strip() and not p.strip().startswith("#")]


# A glob that starts with one of these can never match a path git lists: git paths are relative, and this filter has
# no negation, though GitHub's on.<event>.paths reads ! as one (#199).
NEVER_MATCH = ("/", "./", "!")


def unmatched(patterns: list, cwd: str = ".") -> list:
    """The patterns that match no file git tracks at HEAD, a likely typo; [] when git cannot list the files."""
    try:
        r = subprocess.run(["git", "ls-files", "-z"], cwd=cwd, capture_output=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return []
    files = [f for f in r.stdout.decode("utf-8", "replace").split("\0") if f] if r.returncode == 0 else []
    return [p for p in patterns if files and not any(glob_re(p).fullmatch(f) for f in files)]


def changes(paths: str, base: str, cwd: str = ".") -> tuple:
    """(run, reason): whether the change since BASE touched one of PATHS. A change to .github/workflows/ always runs,
    and so does anything git cannot say (no base, a first push, a commit it lacks): unknown means run."""
    patterns = patterns_of(paths)
    if not patterns:
        return True, "no paths: every change runs"
    if not known_base(base):
        return True, "no base commit: run"
    files = changed_files(base, cwd)
    if isinstance(files, str):
        return True, files
    regexes = [glob_re(p) for p in patterns + [".github/workflows/**"]]
    hit = any(g.fullmatch(f) for g in regexes for f in files)
    return hit, f"{len(files)} files changed; {'at least one matches' if hit else 'none matches'} the paths"


def exit_code(result: dict) -> int:
    """0 follows, 3 when unread files are the only reason it does not, 1 otherwise."""
    if result["could_not_check"] and not result["findings"]:
        return 3
    return 0 if result["follows"] else 1


def caller_line(c: dict, lag) -> str:
    """The caller, its pin and, when known, how far behind Git Crafter main the pin is."""
    pin = "a local path" if c["local"] else f"{c['pin']} ({c['version'] or 'no version comment'})"
    lagged = "" if not lag else f", {lag['commits']} commits behind Git Crafter main" if "commits" in lag else f", behind: {lag['could_not_check']}"
    return f"  caller: {c['file']}/{c['job']} at {pin}{lagged}"


def report(result: dict) -> int:
    """Prints each finding, exception and unread file, the caller and a summary line; returns the exit code."""
    for label, rows in (("FAIL", result["findings"]), ("EXCEPTED", result["excepted"])):
        for rule, where, why in rows:
            print(f"  {label:<9} {rule:<12} {where}  ({why})")
    for where, why in result["could_not_check"]:
        print(f"  {'UNREAD':<9} {'':<12} {where}  ({why})")
    if result["caller"]:
        print(caller_line(result["caller"], result["behind"]))
    unread = f", {len(result['could_not_check'])} unread" if result["could_not_check"] else ""
    state = "follows the standard" if result["follows"] else f"{len(result['findings'])} finding(s){unread}"
    print(f"ci-standard: {result['workflows']} workflow(s), {len(result['excepted'])} exception(s), {state}")
    return exit_code(result)


def as_json(result: dict) -> str:
    """The result with each finding as an object, as check --json prints it."""
    rows = {key: [dict(zip(names, f)) for f in result[key]] for key, names in
            (("findings", ("rule", "where", "why")), ("excepted", ("rule", "where", "why")), ("could_not_check", ("where", "why")))}
    return json.dumps({**result, **rows}, indent=1)


def beside(name: str, what: str):
    """The path of a Git Crafter file this one runs, or None after printing where it lives (absent in the workflow)."""
    path = os.path.join(HERE, name)
    if os.path.isfile(path):
        return path
    print(f"ci-standard: usage: {what} needs tools/{name}, which only a Git Crafter checkout has")
    return None


def self_test() -> int:
    """Runs tools/tests/test_ci_standard.py; exit 2 where it is absent, as in the workflow's copy."""
    if not beside(os.path.join("tests", "test_ci_standard.py"), "--self-test"):
        return 2
    sys.path.append(os.path.join(HERE, "tests"))
    import test_ci_standard
    return test_ci_standard.run()


def run_embed(write: bool) -> int:
    """The embed command, from ci_standard_embed.py; exit 2 where it is absent, as in the workflow's copy."""
    if not beside("ci_standard_embed.py", "embed"):
        return 2
    import ci_standard_embed
    return ci_standard_embed.embed_all(write)


def run_changes(args) -> int:
    """The changes command: prints NAME=true or false and the reason, and writes NAME to GITHUB_OUTPUT."""
    if not re.fullmatch(r"[a-z][a-z0-9_]*", args.output):
        print(f"ci-standard: usage: --output {args.output!r} is not a step output name (a-z, 0-9, _)")
        return 2
    never = [p for p in patterns_of(args.paths) if p.startswith(NEVER_MATCH)]
    if never:
        print(f"ci-standard: usage: --paths {', '.join(map(repr, never))} can never match a changed file; "
              "write each glob from the repo root, with no leading / or ./, and no ! pattern (this filter has no negation)")
        return 2
    for p in unmatched(patterns_of(args.paths)):
        print(f"::warning::ci-standard: paths glob {p!r} matches no file in the repo; check it for a typo")
    run, reason = changes(args.paths, args.base)
    line = f"{args.output}={'true' if run else 'false'}"
    print(f"{line}\nreason={reason}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    return 0


def run_check(args) -> int:
    """The check command: the repo's findings, as a report or as JSON."""
    if not os.path.isdir(args.repo):
        print(f"ci-standard: usage: {args.repo} is not a folder")
        return 2
    try:
        result = check_repo(args.repo, ask_behind=args.behind)
    except UsageError as exc:
        print(f"ci-standard: could not check: {exc}")
        return 3
    if args.json:
        print(as_json(result))
        return exit_code(result)
    return report(result)


def arg_parser() -> argparse.ArgumentParser:
    """The check, changes and embed commands and their flags."""
    parser = argparse.ArgumentParser(prog="ci_standard.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("check")
    p.add_argument("--repo", default=".")
    p.add_argument("--json", action="store_true")
    p.add_argument("--behind", action="store_true")
    p = sub.add_parser("changes")
    p.add_argument("--paths", default="")
    p.add_argument("--base", default="")
    p.add_argument("--output", default="run")
    sub.add_parser("embed").add_argument("--write", action="store_true")
    return parser


def main(argv: list) -> int:
    """Runs one command; returns its exit code."""
    if argv == ["--self-test"]:
        return self_test()
    args = arg_parser().parse_args(argv)
    if args.command == "embed":
        return run_embed(args.write)
    if args.command == "changes":
        return run_changes(args)
    return run_check(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
