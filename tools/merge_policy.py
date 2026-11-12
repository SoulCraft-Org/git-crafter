#!/usr/bin/env python3
"""merge_policy.py: may an agent merge this outside pull request, by its paths?

Default deny: a PR is AI-mergeable only when every changed path matches
ai_mergeable and none matches maintainer_only (skills/merging/outside.md). It
answers the path question only, and never checks out or runs the PR's code.

  python3 -I tools/merge_policy.py PATH [PATH ...]
  python3 -I tools/merge_policy.py --base REF [--head REF]
  python3 -I tools/merge_policy.py --self-test [--policy FILE]

Exit (rules/gates.md): 0 AI-mergeable; 1 not; 2 usage; 3 could not check,
never read as mergeable. Python 3.9 or later, standard library only.
"""

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
POLICY = os.path.join(HERE, "merge_policy.json")
GRANT_ALL = {"**", "*", "**/*"}
EXIT_MERGEABLE, EXIT_WAITS, EXIT_USAGE, EXIT_INFRA = 0, 1, 2, 3


class InfraError(Exception):
    """Could not check. Never reported as mergeable."""


def glob_to_regex(pattern, flags=0):
    """A path glob as an anchored regex: '**/' any folders, '*' and '?' within one segment."""
    out, i = [], 0
    while i < len(pattern):
        for token, rx in (("**/", "(?:.*/)?"), ("**", ".*"), ("*", "[^/]*"), ("?", "[^/]")):
            if pattern.startswith(token, i):
                out.append(rx)
                i += len(token)
                break
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$", flags)


def glob_match(pattern, path, flags=0):
    """True when the path matches the glob."""
    return bool(glob_to_regex(pattern, flags).match(path))


def _string_list(value, where):
    """The value when it is a non-empty list of strings; otherwise could not check."""
    if not isinstance(value, list) or not value or not all(isinstance(v, str) for v in value):
        raise InfraError("%s must be a non-empty list of strings" % where)
    return value


def _check_samples(samples, path):
    """Each samples group is a list of path lists."""
    if not isinstance(samples, dict):
        raise InfraError("samples in %s must be an object" % path)
    for key, groups in samples.items():
        if not isinstance(groups, list):
            raise InfraError("samples.%s in %s must be a list" % (key, path))
        for paths in groups:
            _string_list(paths, "a samples.%s entry in %s" % (key, path))


def load_policy(path=POLICY):
    """The policy, checked: string globs, no grant-everything glob, string samples."""
    try:
        with open(path, encoding="utf-8") as fh:
            policy = json.load(fh)
    except (OSError, ValueError) as exc:
        raise InfraError("cannot read the policy %s (%s)" % (path, exc))
    if not isinstance(policy, dict):
        raise InfraError("policy %s must hold a JSON object" % path)
    for key in ("maintainer_only", "ai_mergeable"):
        _string_list(policy.get(key), "%s in %s" % (key, path))
    # An allowlist glob starts with a literal name, so no file grants every path.
    broad = [g for g in policy["ai_mergeable"] if g in GRANT_ALL or any(c in g.split("/")[0] for c in "*?[")]
    if broad:
        raise InfraError("ai_mergeable in %s grants too much: %s" % (path, broad))
    _check_samples(policy.get("samples", {}), path)
    return policy


def refused(path):
    """Why a path is malformed, or None. A refused path is never mergeable."""
    checks = (
        (not path, "empty path"),
        (any(ord(c) < 0x20 or ord(c) == 0x7F for c in path), "control character"),
        ("\\" in path, "backslash"),
        (path.startswith("/"), "absolute path"),
        (any(s in ("", ".", "..") for s in path.split("/")), "'..', '.' or empty segment"),
    )
    return next((why for bad, why in checks if bad), None)


def why_blocked(policy, path):
    """Why a path is not AI-mergeable, or None; maintainer_only is case-blind, as a macOS checkout is."""
    bad = refused(path)
    if bad:
        return "refused: %s" % bad
    hit = next((g for g in policy["maintainer_only"] if glob_match(g, path, re.IGNORECASE)), None)
    if hit:
        return "maintainer-only (%s)" % hit
    if not any(glob_match(g, path) for g in policy["ai_mergeable"]):
        return "not on the AI-mergeable list"
    return None


def verdict(policy, paths):
    """(exit code, [(path, reason)] for every path that is not AI-mergeable)."""
    if not paths:
        raise InfraError("no changed paths: an empty list is never mergeable")
    blocked = [(p, r) for p, r in ((p, why_blocked(policy, p)) for p in paths) if r]
    return (EXIT_WAITS if blocked else EXIT_MERGEABLE), blocked


def run(cmd):
    """A command's stdout; could not check when it fails to run or exits non-zero."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        raise InfraError("%s could not run (%s)" % (cmd[0], exc))
    if proc.returncode != 0:
        raise InfraError("%s exited %d: %s" % (" ".join(cmd[:3]), proc.returncode, proc.stderr.strip()[:200]))
    return proc.stdout


class _Parser(argparse.ArgumentParser):
    """Usage errors exit 2, the contract's code."""

    def error(self, message):
        """Print the message and the usage, then exit 2."""
        print("usage error: %s" % message, file=sys.stderr)
        self.print_usage(sys.stderr)
        sys.exit(EXIT_USAGE)


def parse(argv):
    """The checked arguments."""
    p = _Parser(description="AI merge policy for outside pull requests")
    p.add_argument("paths", nargs="*", help="changed paths")
    p.add_argument("--base", help="git ref: paths changed since its merge base with --head")
    p.add_argument("--head", default="HEAD", help="git ref for --base (default HEAD)")
    p.add_argument("--policy", default=POLICY, help="policy file (default merge_policy.json beside this script)")
    p.add_argument("--self-test", action="store_true", help="run the policy's samples and the bad fixtures")
    args = p.parse_args(argv)
    if args.paths and args.base:
        p.error("give paths or --base, not both")
    return args


def check(args, policy):
    """(exit code, paths read, paths blocked), printing each blocked path."""
    paths = args.paths
    if args.base:
        out = run(["git", "diff", "--name-only", "--no-renames", "%s...%s" % (args.base, args.head)])
        paths = sorted({l for l in out.splitlines() if l.strip()})
    code, blocked = verdict(policy, paths)
    for path, reason in blocked:
        print("not AI-mergeable: %r: %s" % (path, reason))
    return code, len(paths), len(blocked)


def _selftest():
    """merge_policy_selftest.py from beside this file; python3 -I leaves this folder off sys.path."""
    spec = importlib.util.spec_from_file_location("merge_policy_selftest", os.path.join(HERE, "merge_policy_selftest.py"))
    if spec is None or not os.path.isfile(spec.origin):
        raise InfraError("merge_policy_selftest.py is missing beside merge_policy.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    """Run the CLI; returns the exit code."""
    args = parse(argv)
    try:
        policy = load_policy(args.policy)
        if args.self_test:
            return _selftest().run(sys.modules[__name__], policy, args.policy)
        code, n, nblocked = check(args, policy)
        print("merge_policy: %s (%d path(s), %d not AI-mergeable)"
              % ("ai-mergeable" if code == EXIT_MERGEABLE else "not AI-mergeable", n, nblocked))
        return code
    except InfraError as exc:
        print("could not check: %s" % exc, file=sys.stderr)
        return EXIT_INFRA


if __name__ == "__main__":
    sys.exit(main())
