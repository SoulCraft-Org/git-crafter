#!/usr/bin/env python3
"""merge_policy.py: may an agent merge this outside pull request, by its paths?

Reads a policy file (default: merge_policy.json beside this script; the
starter is templates/open/merge_policy.json). Default deny: a PR is
AI-mergeable only when every changed path matches ai_mergeable and none
matches maintainer_only. Anything else is rebuilt by the orchestrator or waits
for a maintainer (skills/merging/outside.md). The checker answers the path
question only; required checks and both reviews still have to pass. It never
checks out or runs the PR's code: --pr reads the PR through the GitHub API.

A path is refused (it waits) when it is absolute, has a '..', '.' or empty
segment, a backslash, or a control character.

Usage:
  python3 -I tools/merge_policy.py PATH [PATH ...]
  python3 -I tools/merge_policy.py --pr N --sha HEAD_SHA [--repo OWNER/NAME]
      checks that HEAD_SHA is the PR's head and the repo's default branch its
      base, then prints the SHA it checked: merge with --match-head-commit at
      that SHA, never another
  python3 -I tools/merge_policy.py --base REF [--head REF]
  python3 -I tools/merge_policy.py --self-test [--policy FILE]

Exit codes (rules/gates.md):
  0  ai-mergeable: every path is on the allowlist
  1  not AI-mergeable: a path is maintainer-only, off the allowlist or
     refused; or the PR's head is not --sha, or its base is not the default
     branch
  2  usage error
  3  could not check: no paths, a policy that is unreadable or grants
     everything, a failed gh or git call, a file list GitHub cut short.
     Never read as mergeable.

Python 3.9 or later, standard library only.
"""

import argparse
import contextlib
import io
import json
import os
import re
import subprocess
import sys

sys.dont_write_bytecode = True

HERE = os.path.dirname(os.path.abspath(__file__))
POLICY = os.path.join(HERE, "merge_policy.json")
FIXTURES = os.path.join(HERE, "merge_policy_fixtures")
# gh api fills {owner} and {repo} from the checkout it runs in (gh help api).
DEFAULT_REPO = "{owner}/{repo}"
# GitHub's pull request files API lists at most 3,000 files (REST docs,
# "List pull requests files"); a longer PR cannot be read whole.
GITHUB_FILES_CAP = 3000
GRANT_ALL = {"**", "*", "**/*"}

EXIT_MERGEABLE, EXIT_WAITS, EXIT_USAGE, EXIT_INFRA = 0, 1, 2, 3


class InfraError(Exception):
    """Could not check. Never reported as mergeable."""


def glob_to_regex(pattern):
    """A path glob as an anchored regex: '**/' any folders, '*' and '?' within one segment."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def glob_match(pattern, path):
    return bool(glob_to_regex(pattern).match(path))


def _string_list(value, where, allow_empty=False):
    if not isinstance(value, list) or (not value and not allow_empty) or not all(isinstance(v, str) for v in value):
        raise InfraError("%s must be a %slist of strings" % (where, "" if allow_empty else "non-empty "))
    return value


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
    # An allowlist glob must start with a literal folder or file name, so the
    # file can never grant every path ('**', '*', '**/*', '*.md').
    broad = [g for g in policy["ai_mergeable"] if g in GRANT_ALL or any(c in g.split("/")[0] for c in "*?[")]
    if broad:
        raise InfraError("ai_mergeable in %s grants too much: %s" % (path, broad))
    samples = policy.get("samples", {})
    if not isinstance(samples, dict):
        raise InfraError("samples in %s must be an object" % path)
    for key, groups in samples.items():
        if not isinstance(groups, list):
            raise InfraError("samples.%s in %s must be a list" % (key, path))
        for paths in groups:
            _string_list(paths, "a samples.%s entry in %s" % (key, path))
    return policy


def refused(path):
    """Why a path is malformed, or None. A refused path is never mergeable."""
    if not path:
        return "empty path"
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in path):
        return "control character"
    if "\\" in path:
        return "backslash"
    if path.startswith("/"):
        return "absolute path"
    if any(s in ("", ".", "..") for s in path.split("/")):
        return "'..', '.' or empty segment"
    return None


def why_blocked(policy, path):
    """Why a path is not AI-mergeable, or None when an agent may merge it."""
    bad = refused(path)
    if bad:
        return "refused: %s" % bad
    hit = next((g for g in policy["maintainer_only"] if glob_match(g, path)), None)
    if hit:
        return "maintainer-only (%s)" % hit
    if not any(glob_match(g, path) for g in policy["ai_mergeable"]):
        return "not on the AI-mergeable list"
    return None


def verdict(policy, paths):
    """(exit code, [(path, reason)] for every path that is not AI-mergeable)."""
    if not paths:
        raise InfraError("no changed paths: an empty list is never mergeable")
    blocked = [(p, why_blocked(policy, p)) for p in paths]
    blocked = [(p, r) for p, r in blocked if r]
    return (EXIT_WAITS if blocked else EXIT_MERGEABLE), blocked


def run(cmd):
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        raise InfraError("%s could not run (%s)" % (cmd[0], exc))
    if proc.returncode != 0:
        raise InfraError("%s exited %d: %s" % (" ".join(cmd[:3]), proc.returncode, proc.stderr.strip()[:200]))
    return proc.stdout


def pr_facts(number, repo, gh=run):
    """The PR's head SHA, base branch, the repo's default branch, and every path, whole or not at all.

    Both names of a rename count. GitHub lists at most 3,000 files, so a PR
    over that, or a list shorter than changed_files, could not be checked.
    """
    try:
        pull = json.loads(gh(["gh", "api", "repos/%s/pulls/%d" % (repo, number)]))
        files = json.loads(gh(["gh", "api", "--paginate", "--slurp", "repos/%s/pulls/%d/files" % (repo, number)]))
    except ValueError as exc:
        raise InfraError("gh api returned something that is not JSON (%s)" % exc)
    try:
        changed, head = int(pull["changed_files"]), pull["head"]["sha"]
        base, default = pull["base"]["ref"], pull["base"]["repo"]["default_branch"]
        entries = [f for page in files for f in page]
        paths = set()
        for f in entries:
            paths.add(f["filename"])
            if f.get("previous_filename"):
                paths.add(f["previous_filename"])
    except (KeyError, TypeError, ValueError) as exc:
        raise InfraError("gh api returned an unexpected shape (%s)" % exc)
    if changed > GITHUB_FILES_CAP:
        raise InfraError("the PR changes %d files; GitHub lists at most %d" % (changed, GITHUB_FILES_CAP))
    if len(entries) != changed:
        raise InfraError("read %d files, but the PR says it changes %d" % (len(entries), changed))
    return head, base, default, sorted(paths)


def diff_paths(base, head):
    out = run(["git", "diff", "--name-only", "--no-renames", "%s...%s" % (base, head)])
    return sorted(set(l for l in out.splitlines() if l.strip()))


def check_pr(policy, number, repo, sha, gh=run):
    """(exit code, lines to print, paths read, paths blocked) for one PR at one head SHA."""
    head, base, default, paths = pr_facts(number, repo, gh)
    if head != sha:
        return EXIT_WAITS, ["not AI-mergeable: head is %s, not --sha %s" % (head, sha)], len(paths), 0
    if base != default:
        return EXIT_WAITS, ["not AI-mergeable: base is %s, not %s" % (base, default)], len(paths), 0
    code, blocked = verdict(policy, paths)
    lines = ["not AI-mergeable: %r: %s" % b for b in blocked]
    lines.append("checked head %s" % head)
    return code, lines, len(paths), len(blocked)


def _fake_gh(pull, pages):
    def gh(cmd):
        return json.dumps(pages if "files" in cmd[-1] else pull)
    return gh


def _fixture_cases(wrong):
    """The FAIL path: every bad policy in merge_policy_fixtures/ must be refused as it names."""
    fixtures = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json")) if os.path.isdir(FIXTURES) else []
    if not fixtures:
        wrong.append("no bad-policy fixtures in %s" % FIXTURES)
    for name in fixtures:
        try:
            with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
                want = json.load(fh)["_expect"]
            want_exit, want_text = int(want["exit"]), str(want["text"])
        except (OSError, ValueError, KeyError, TypeError) as exc:
            wrong.append("fixture %s does not name its _expect exit and text (%s)" % (name, exc))
            continue
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            got = main(["--self-test", "--policy", os.path.join(FIXTURES, name)])
        if got != want_exit or want_text not in out.getvalue():
            wrong.append("fixture %s gave exit %d without %r, want exit %d with it" % (name, got, want_text, want_exit))


def self_test(policy, policy_path=POLICY):
    wrong = []
    samples = policy.get("samples", {})
    for key in ("ai_mergeable", "maintainer_only", "default_deny", "refused"):
        if not samples.get(key):
            wrong.append("no %s samples" % key)
    for paths in samples.get("ai_mergeable", []):
        got, blocked = verdict(policy, paths)
        if got != EXIT_MERGEABLE:
            wrong.append("%r gave exit %d, want 0 (%s)" % (paths, got, blocked))
    for key, prefix in (("maintainer_only", "maintainer-only"), ("default_deny", "not on the"), ("refused", "refused")):
        for paths in samples.get(key, []):
            got, blocked = verdict(policy, paths)
            if got != EXIT_WAITS or not any(r.startswith(prefix) for _, r in blocked):
                wrong.append("%r should wait as %s, got exit %d %s" % (paths, key, got, blocked))
    try:
        verdict(policy, [])
        wrong.append("an empty path list did not raise could-not-check")
    except InfraError:
        pass

    # --pr, against a fake gh: the SHA and base checks, and a file list cut short.
    sha = "a" * 40
    ok_path = samples["ai_mergeable"][0][0] if samples.get("ai_mergeable") else "x"
    pull = {"changed_files": 1, "head": {"sha": sha}, "base": {"ref": "main", "repo": {"default_branch": "main"}}}
    page = [[{"filename": ok_path}]]
    cases = [
        ("clean PR", pull, page, sha, EXIT_MERGEABLE),
        ("another head", pull, page, "b" * 40, EXIT_WAITS),
        ("base not the default branch", dict(pull, base={"ref": "production", "repo": {"default_branch": "main"}}),
         page, sha, EXIT_WAITS),
        ("rename out of a gate", pull, [[{"filename": ok_path, "previous_filename": ".github/workflows/x.yml"}]],
         sha, EXIT_WAITS),
        ("list cut short", dict(pull, changed_files=2), page, sha, EXIT_INFRA),
        ("over GitHub's cap", dict(pull, changed_files=3001), page, sha, EXIT_INFRA),
    ]
    for label, p, pages, want_sha, want in cases:
        try:
            got = check_pr(policy, 1, "o/r", want_sha, _fake_gh(p, pages))[0]
        except InfraError:
            got = EXIT_INFRA
        if got != want:
            wrong.append("--pr %s gave exit %d, want %d" % (label, got, want))

    # Fixtures run for every policy but the fixtures themselves, so none recurses.
    if os.path.dirname(os.path.abspath(policy_path)) != os.path.abspath(FIXTURES):
        _fixture_cases(wrong)
    for msg in wrong:
        print("self-test: %s" % msg)
    n = sum(len(v) for v in samples.values())
    print("merge_policy self-test: %s (%d samples)" % ("FAIL" if wrong else "PASS", n))
    return EXIT_WAITS if wrong else EXIT_MERGEABLE


class _Parser(argparse.ArgumentParser):
    def error(self, message):
        print("usage error: %s" % message, file=sys.stderr)
        self.print_usage(sys.stderr)
        sys.exit(EXIT_USAGE)


def main(argv=None):
    parser = _Parser(description="AI merge policy for outside pull requests")
    parser.add_argument("paths", nargs="*", help="changed paths")
    parser.add_argument("--pr", type=int, help="read this PR through gh api; needs --sha")
    parser.add_argument("--sha", help="the head SHA the merge will name in --match-head-commit")
    parser.add_argument("--repo", default=DEFAULT_REPO, help="OWNER/NAME for --pr (default: the checkout's repo)")
    parser.add_argument("--base", help="git ref: paths changed since its merge base with --head")
    parser.add_argument("--head", default="HEAD", help="git ref for --base (default HEAD)")
    parser.add_argument("--policy", default=POLICY, help="policy file (default merge_policy.json beside this script)")
    parser.add_argument("--self-test", action="store_true", help="run the policy's samples and the bad fixtures")
    args = parser.parse_args(argv)
    if sum(bool(x) for x in (args.paths, args.pr, args.base)) > 1:
        parser.error("give paths, --pr or --base, not more than one")
    if args.pr and not args.sha:
        parser.error("--pr needs --sha, the head SHA the merge will name")
    if args.sha and not args.pr:
        parser.error("--sha goes with --pr; alone it would check nothing")
    try:
        policy = load_policy(args.policy)
        if args.self_test:
            return self_test(policy, args.policy)
        if args.pr:
            code, lines, n, nblocked = check_pr(policy, args.pr, args.repo, args.sha)
            print("\n".join(lines))
        else:
            paths = diff_paths(args.base, args.head) if args.base else args.paths
            code, blocked = verdict(policy, paths)
            n, nblocked = len(paths), len(blocked)
            for path, reason in blocked:
                print("not AI-mergeable: %r: %s" % (path, reason))
        print("merge_policy: %s (%d path(s), %d not AI-mergeable)"
              % ("ai-mergeable" if code == EXIT_MERGEABLE else "not AI-mergeable", n, nblocked))
        return code
    except InfraError as exc:
        print("could not check: %s" % exc, file=sys.stderr)
        return EXIT_INFRA


if __name__ == "__main__":
    sys.exit(main())
