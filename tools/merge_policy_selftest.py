"""merge_policy_selftest.py: the self-test merge_policy.py --self-test runs.

It checks the policy's own samples, the --pr guards against a fake gh, the
--base file modes in a scratch git repo, and that every bad policy in
merge_policy_fixtures/ is refused as it names.
"""

import contextlib
import io
import json
import os
import subprocess
import tempfile

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
    except mp.InfraError:
        return  # the expected could-not-check
    wrong.append("an empty path list did not raise could-not-check")


def fake_gh(pull, pages, tree=None):
    """A gh stand-in: the head tree for a trees call (by default every listed file, a plain file), the files pages
    for a files call, the pull otherwise."""
    plain = {"truncated": False, "tree": [{"path": f["filename"], "mode": "100644"} for page in pages for f in page]}

    def gh(cmd):
        """The canned answer for one gh api call."""
        if "/git/trees/" in cmd[-1]:
            return json.dumps(plain if tree is None else tree)
        return json.dumps(pages if "files" in cmd[-1] else pull)
    return gh


def ok_path(policy):
    """The first ai_mergeable sample path, or x."""
    return (policy.get("samples", {}).get("ai_mergeable") or [["x"]])[0][0]


def pr_cases(mp, policy, wrong):
    """--pr against a fake gh: the SHA and base guards, renames, a file list cut short, and file modes."""
    sha, ok = "a" * 40, ok_path(policy)
    pull = {"changed_files": 1, "head": {"sha": sha}, "base": {"ref": "main", "repo": {"default_branch": "main"}}}
    page = [[{"filename": ok}]]

    def tree(mode, truncated=False):
        """A head tree holding ok at mode."""
        return {"truncated": truncated, "tree": [{"path": ok, "mode": mode}]}
    cases = [
        ("clean PR", pull, page, sha, mp.EXIT_MERGEABLE),
        ("another head", pull, page, "b" * 40, mp.EXIT_WAITS),
        ("base not the default branch", dict(pull, base={"ref": "dev", "repo": {"default_branch": "main"}}),
         page, sha, mp.EXIT_WAITS),
        ("rename out of a gate", pull, [[{"filename": ok, "previous_filename": ".github/workflows/x.yml"}]],
         sha, mp.EXIT_WAITS),
        ("list cut short", dict(pull, changed_files=2), page, sha, mp.EXIT_INFRA),
        ("over GitHub's cap", dict(pull, changed_files=3001), page, sha, mp.EXIT_INFRA),
        ("a symlink on an AI-mergeable path", pull, page, sha, mp.EXIT_WAITS, tree("120000")),
        ("a submodule on an AI-mergeable path", pull, page, sha, mp.EXIT_WAITS, tree("160000")),
        ("a head tree too large to read", pull, page, sha, mp.EXIT_INFRA, tree("100644", True)),
        ("a changed path missing from the head tree", pull, page, sha, mp.EXIT_INFRA, {"truncated": False, "tree": []}),
        ("a removed symlink", pull, [[{"filename": ok, "status": "removed"}]], sha, mp.EXIT_MERGEABLE, {"tree": []}),
    ]
    for label, p, pages, want_sha, want, *head_tree in cases:
        try:
            got = mp.check_pr(policy, 1, "o/r", want_sha, fake_gh(p, pages, *head_tree))[0]
        except mp.InfraError:
            got = mp.EXIT_INFRA
        if got != want:
            wrong.append("--pr %s gave exit %d, want %d" % (label, got, want))


def git_cases(mp, policy, wrong):
    """--base in a scratch git repo: a plain file on an AI-mergeable path passes; a symlink or a gitlink there waits,
    and so does a file that becomes one; deleting one passes."""
    ok = ok_path(policy)
    with tempfile.TemporaryDirectory() as g:
        def git(*args):
            """One git command in the scratch repo; its stdout."""
            return subprocess.run(["git", "-C", g, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                                  input="", capture_output=True, text=True, check=True).stdout.strip()

        def commit(kind):
            """Puts ok in the index as kind (file, link or gitlink, or gone), commits, and returns the commit."""
            git("rm", "-q", "--cached", "--ignore-unmatch", ok)
            blob = git("hash-object", "-w", "--stdin") if kind != "gitlink" else "b" * 40
            mode = {"file": "100644", "link": "120000", "gitlink": "160000"}.get(kind)
            if mode:
                git("update-index", "--add", "--cacheinfo", "%s,%s,%s" % (mode, blob, ok))
            git("commit", "-q", "--allow-empty", "-m", kind)
            return git("rev-parse", "HEAD")

        git("init", "-q")
        base = commit("none")
        heads = {kind: commit(kind) for kind in ("file", "link", "gitlink")}
        cases = [("a plain file", base, heads["file"], mp.EXIT_MERGEABLE), ("a symlink", base, heads["link"], mp.EXIT_WAITS),
                 ("a gitlink", base, heads["gitlink"], mp.EXIT_WAITS), ("a file that becomes a symlink", heads["file"], heads["link"], mp.EXIT_WAITS),
                 ("a deleted gitlink", heads["gitlink"], commit("none"), mp.EXIT_MERGEABLE)]
        for label, b, h, want in cases:
            got = mp.verdict(policy, *mp.diff_facts(b, h, lambda cmd: mp.run(cmd[:1] + ["-C", g] + cmd[1:])))[0]
            if got != want:
                wrong.append("--base, %s on %r gave exit %d, want %d" % (label, ok, got, want))


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
    git_cases(mp, policy, wrong)
    if os.path.dirname(os.path.abspath(policy_path)) != FIXTURES:
        fixture_cases(mp, wrong)
    for msg in wrong:
        print("self-test: %s" % msg)
    n = sum(len(v) for v in policy.get("samples", {}).values())
    print("merge_policy self-test: %s (%d samples)" % ("FAIL" if wrong else "PASS", n))
    return mp.EXIT_WAITS if wrong else mp.EXIT_MERGEABLE
