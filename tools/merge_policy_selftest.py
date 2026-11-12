"""merge_policy_selftest.py: the self-test merge_policy.py --self-test runs.

It checks the policy's own samples, the --pr guards against a fake gh, and
that every bad policy in merge_policy_fixtures/ is refused as it names.
"""

import contextlib
import io
import json
import os

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "merge_policy_fixtures")
GROUPS = (("maintainer_only", "maintainer-only"), ("default_deny", "not on the"), ("refused", "refused"))


def missing_groups(policy, wrong):
    """Every samples group has at least one case."""
    samples = policy.get("samples", {})
    for key in ("ai_mergeable",) + tuple(k for k, _ in GROUPS):
        if not samples.get(key):
            wrong.append("no %s samples" % key)


def sample_cases(mp, policy, wrong):
    """Each samples group gets the verdict its name says."""
    samples = policy.get("samples", {})
    missing_groups(policy, wrong)
    for paths in samples.get("ai_mergeable", []):
        got, blocked = mp.verdict(policy, paths)
        if got != mp.EXIT_MERGEABLE:
            wrong.append("%r gave exit %d, want 0 (%s)" % (paths, got, blocked))
    for key, prefix in GROUPS:
        for paths in samples.get(key, []):
            got, blocked = mp.verdict(policy, paths)
            if got != mp.EXIT_WAITS or not any(r.startswith(prefix) for _, r in blocked):
                wrong.append("%r should wait as %s, got exit %d %s" % (paths, key, got, blocked))
    try:
        mp.verdict(policy, [])
        wrong.append("an empty path list did not raise could-not-check")
    except mp.InfraError:
        pass


def fake_gh(pull, pages):
    """A gh stand-in: the files pages for a files call, the pull otherwise."""
    return lambda cmd: json.dumps(pages if "files" in cmd[-1] else pull)


def pr_cases(mp, policy, wrong):
    """--pr against a fake gh: the SHA and base guards, renames, and a file list cut short."""
    sha, ok = "a" * 40, (policy.get("samples", {}).get("ai_mergeable") or [["x"]])[0][0]
    pull = {"changed_files": 1, "head": {"sha": sha}, "base": {"ref": "main", "repo": {"default_branch": "main"}}}
    page = [[{"filename": ok}]]
    cases = [
        ("clean PR", pull, page, sha, mp.EXIT_MERGEABLE),
        ("another head", pull, page, "b" * 40, mp.EXIT_WAITS),
        ("base not the default branch", dict(pull, base={"ref": "dev", "repo": {"default_branch": "main"}}),
         page, sha, mp.EXIT_WAITS),
        ("rename out of a gate", pull, [[{"filename": ok, "previous_filename": ".github/workflows/x.yml"}]],
         sha, mp.EXIT_WAITS),
        ("list cut short", dict(pull, changed_files=2), page, sha, mp.EXIT_INFRA),
        ("over GitHub's cap", dict(pull, changed_files=3001), page, sha, mp.EXIT_INFRA),
    ]
    for label, p, pages, want_sha, want in cases:
        try:
            got = mp.check_pr(policy, 1, "o/r", want_sha, fake_gh(p, pages))[0]
        except mp.InfraError:
            got = mp.EXIT_INFRA
        if got != want:
            wrong.append("--pr %s gave exit %d, want %d" % (label, got, want))


def _expect(name):
    """(exit, text) a fixture names in _expect."""
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        want = json.load(fh)["_expect"]
    return int(want["exit"]), str(want["text"])


def fixture_cases(mp, wrong):
    """The FAIL path: every bad policy is refused with the exit and text it names."""
    names = sorted(f for f in os.listdir(FIXTURES) if f.endswith(".json")) if os.path.isdir(FIXTURES) else []
    if not names:
        wrong.append("no bad-policy fixtures in %s" % FIXTURES)
    for name in names:
        try:
            want_exit, want_text = _expect(name)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            wrong.append("fixture %s does not name its _expect exit and text (%s)" % (name, exc))
            continue
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            got = mp.main(["--self-test", "--policy", os.path.join(FIXTURES, name)])
        if got != want_exit or want_text not in out.getvalue():
            wrong.append("fixture %s gave exit %d without %r, want exit %d with it" % (name, got, want_text, want_exit))


def run(mp, policy, policy_path):
    """Exit 0 when every case holds, 1 otherwise; fixtures run for every policy but their own."""
    wrong = []
    sample_cases(mp, policy, wrong)
    pr_cases(mp, policy, wrong)
    if os.path.dirname(os.path.abspath(policy_path)) != FIXTURES:
        fixture_cases(mp, wrong)
    for msg in wrong:
        print("self-test: %s" % msg)
    n = sum(len(v) for v in policy.get("samples", {}).values())
    print("merge_policy self-test: %s (%d samples)" % ("FAIL" if wrong else "PASS", n))
    return mp.EXIT_WAITS if wrong else mp.EXIT_MERGEABLE
