"""test_ci_standard.py: the CI standard's self-test, run by `python3 -I tools/ci_standard.py --self-test`.

Seeded known-good and known-bad repos, changes in a scratch git repo, the parser, the embed, and the three embedded
files run alone, as on a runner with no Git Crafter checkout. It stays out of ci-standard.yml, so the workflow's copy of
ci_standard.py exits 2 for --self-test. ci_standard.py puts tools/ on sys.path before it imports this file.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

from ci_standard import changes
from ci_standard_embed import EMBEDS, OVERFLOW, WORKFLOW, embed
from ci_standard_rules import LOCAL_STANDARD, UsageError, behind, check_repo
from ci_standard_yaml import EXPR, ParseError, parse

TOOLS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(TOOLS, "ci_standard.py")

PIN = "9bae29e959285af46ace7afee32d22658a9fefa2"
EXAMPLE = "example-org/code-os/.github/workflows/ci-standard.yml"
CALLER = f"""name: ci
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-@{{ github.ref }}}}
  cancel-in-progress: @{{ github.event_name == 'pull_request' }}}}
jobs:
  ci:
    uses: {EXAMPLE}@{PIN} # v1
    with:
      paths: |
        src/**
      short: npm run lint
      standard: npm test
""".replace("@{", EXPR)
DEPLOY = """name: deploy
on:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: deploy
  cancel-in-progress: false
jobs:
  deploy:
    runs-on: ubuntu-slim
    timeout-minutes: 10
    environment: production
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1
        with:
          node-version: 26
          cache: npm
      - run: |
          npm ci
          npx wrangler deploy
"""
DEPENDABOT = """version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
"""


def repo_with(files: dict) -> dict:
    """check_repo over a scratch repo holding files, or {"usage": why}."""
    with tempfile.TemporaryDirectory() as tmp:
        for rel, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
            with open(os.path.join(tmp, rel), "w", encoding="utf-8") as fh:
                fh.write(text)
        try:
            return check_repo(tmp)
        except UsageError as exc:
            return {"usage": str(exc)}


GOOD = {".github/workflows/ci.yml": CALLER, ".github/workflows/deploy.yml": DEPLOY, ".github/dependabot.yml": DEPENDABOT}


def edit(path: str, old: str, new: str) -> dict:
    """GOOD's file at path with old replaced once by new."""
    if old not in GOOD[path]:
        raise AssertionError(old)
    return {path: GOOD[path].replace(old, new, 1)}


def expect(wrong: list, label: str, change: dict, want: set):
    """Appends to wrong unless GOOD with change (None deletes a file) finds exactly the rules in want."""
    files = {k: v for k, v in {**GOOD, **change}.items() if v is not None}
    r = repo_with(files)
    if "usage" in r:
        wrong.append(f"{label}: usage error {r['usage']}")
        return
    got = {f[0] for f in r["findings"]} | ({"unread"} if r["could_not_check"] else set())
    if got != want:
        wrong.append(f"{label}: rules {sorted(got)}, want {sorted(want)}: {r['findings']}")


# gh actions-lock's file: the workflows it has onboarded and each one's locked uses: lines.
LOCK = "version: 'v0.0.3'\nworkflows:\n    '.github/workflows/deploy.yml':\n        - '{ref}'\ndependencies: {{}}\n"
TAGGED = edit(".github/workflows/deploy.yml", "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", "actions/setup-node@v7.1.0")
CANCEL = f"  cancel-in-progress: {EXPR} github.event_name == 'pull_request' }}}}\n"
# (label, change to GOOD, the rules it must find): one row a seeded known-bad or known-good repo.
CASES = [
    ("no caller", {".github/workflows/ci.yml": None}, {"caller"}),
    ("a caller only on push", edit(".github/workflows/ci.yml", "  pull_request:\n", ""), {"caller"}),
    ("another owner's Git Crafter", edit(".github/workflows/ci.yml", "example-org/code-os", "another.org/code-os"), set()),
    ("a repo that is not Git Crafter", edit(".github/workflows/ci.yml", "example-org/code-os", "example-org/other"), {"caller"}),
    ("a tag pin", edit(".github/workflows/ci.yml", f"@{PIN} # v1", "@v1"), {"pin", "pinned"}),
    ("a short SHA pin", edit(".github/workflows/ci.yml", f"@{PIN}", f"@{PIN[:7]}"), {"pin", "pinned"}),
    ("no version comment", edit(".github/workflows/ci.yml", " # v1", ""), {"pin"}),
    ("no dependabot", {".github/dependabot.yml": None}, {"dependabot"}),
    ("dependabot without github-actions", edit(".github/dependabot.yml", "github-actions", "npm"), {"dependabot"}),
    ("no permissions", edit(".github/workflows/ci.yml", "permissions:\n  contents: read\n", ""), {"permissions"}),
    ("no concurrency", edit(".github/workflows/ci.yml", f"concurrency:\n  group: ci-{EXPR} github.ref }}}}\n{CANCEL}", ""), {"concurrency"}),
    ("concurrency that never cancels", edit(".github/workflows/ci.yml", CANCEL, ""), {"concurrency"}),
    ("a deploy that cancels", edit(".github/workflows/deploy.yml", "  cancel-in-progress: false\n", "  cancel-in-progress: true\n"), {"concurrency"}),
    ("no timeout", edit(".github/workflows/deploy.yml", "    timeout-minutes: 10\n", ""), {"timeout"}),
    ("a hard-coded Blacksmith label", edit(".github/workflows/deploy.yml", "runs-on: ubuntu-slim", "runs-on: blacksmith-2vcpu-ubuntu-2404"), {"runner"}),
    ("vars.CI_RUNNER read directly", edit(".github/workflows/deploy.yml", "runs-on: ubuntu-slim", f"runs-on: {EXPR} vars.CI_RUNNER || 'ubuntu-latest' }}}}"), {"runner"}),
    ("a fallback to a larger runner", edit(".github/workflows/deploy.yml", "runs-on: ubuntu-slim",
                                                 f"runs-on: {EXPR} needs.x.outputs.runner || 'ubuntu-latest-64-cores' }}}}"), {"runner"}),
    ("permissions: write-all", edit(".github/workflows/ci.yml", "permissions:\n  contents: read\n", "permissions: write-all\n"), {"permissions"}),
    ("a top-level write", edit(".github/workflows/ci.yml", "  contents: read\n", "  contents: write\n"), {"permissions"}),
    ("a job with write-all", edit(".github/workflows/deploy.yml", "    environment: production\n", "    environment: production\n    permissions: write-all\n"), {"permissions"}),
    ("a job-level write on one scope passes", edit(".github/workflows/deploy.yml", "    environment: production\n", "    environment: production\n    permissions:\n      pages: write\n"), set()),
    ("a job-level reusable call at @main", {".github/workflows/other.yml": "on: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  x:\n    uses: org/repo/.github/workflows/x.yml@main\n"}, {"pinned"}),
    ("a job that is not a mapping", {".github/workflows/odd2.yml": "on: workflow_dispatch\npermissions: {}\njobs:\n  x: 1\n"}, {"unread"}),
    ("macOS", edit(".github/workflows/deploy.yml", "runs-on: ubuntu-slim", "runs-on: macos-15"), {"runner"}),
    ("a fixed ubuntu-latest outside the standard passes", edit(".github/workflows/deploy.yml", "runs-on: ubuntu-slim", "runs-on: ubuntu-latest"), set()),
    ("a tag-pinned action", edit(".github/workflows/deploy.yml", "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1", "actions/setup-node@v7"), {"pinned"}),
    ("a tag-pinned action the lockfile lists passes", {**TAGGED, ".github/workflows/actions.lock": LOCK.format(ref="actions/setup-node@v7.1.0")}, set()),
    ("a tag-pinned action the lockfile does not list", {**TAGGED, ".github/workflows/actions.lock": LOCK.format(ref="actions/setup-node@v7.0.0")}, {"pinned"}),
    ("a lockfile that lists another workflow", {**TAGGED, ".github/workflows/actions.lock": LOCK.format(ref="actions/setup-node@v7.1.0").replace("deploy.yml", "ci.yml")}, {"pinned"}),
    ("a lockfile that does not parse locks nothing", {**TAGGED, ".github/workflows/actions.lock": "workflows: [unclosed\n"}, {"pinned"}),
    ("this repo's own $/ action passes", {".github/workflows/own.yml": "on: workflow_dispatch\npermissions:\n  contents: read\njobs:\n  x:\n    runs-on: ubuntu-slim\n    timeout-minutes: 5\n    steps:\n      - uses: $/actions/x\n"}, set()),
    ("npm ci with no cache", edit(".github/workflows/deploy.yml", "        with:\n          node-version: 26\n          cache: npm\n", "        with:\n          node-version: 26\n"), {"cache"}),
    ("pip with no cache", edit(".github/workflows/deploy.yml", "          npx wrangler deploy\n", "          pip install -r requirements.txt\n          npx wrangler deploy\n"), {"cache"}),
    ("npm ci in a heredoc is data", edit(".github/workflows/deploy.yml", "        with:\n          node-version: 26\n          cache: npm\n      - run: |\n          npm ci\n",
                                               "        with:\n          node-version: 26\n      - run: |\n          cat > x <<'END'\n          npm ci\n          END\n"), set()),
    ("npm ci after a heredoc still counts", edit(".github/workflows/deploy.yml", "        with:\n          node-version: 26\n          cache: npm\n      - run: |\n          npm ci\n",
                                                       "        with:\n          node-version: 26\n      - run: |\n          cat > x <<'END'\n          y\n          END\n          npm ci\n"), {"cache"}),
    ("a per-repo minute guard", {".github/scripts/build_minutes_guard.py": ""}, {"no-share"}),
    ("an unreadable workflow", {".github/workflows/odd.yml": "on: push\nx: !!str 1\n"}, {"unread"}),
]


def test_repos(wrong: list):
    """The known-good repo, the template and the standard as callers, every seeded case, and exceptions."""
    expect(wrong, "the known-good repo", {}, set())
    r = repo_with(GOOD)
    if r.get("caller") != {"file": "ci.yml", "job": "ci", "pin": PIN, "version": "v1", "local": False, "owner": "example-org", "repo": "code-os"}:
        wrong.append(f"caller read as {r.get('caller')}")
    with open(os.path.join(TOOLS, "..", "templates", "ci", "ci.yml"), encoding="utf-8") as fh:
        expect(wrong, "templates/ci/ci.yml as the caller", {".github/workflows/ci.yml": fh.read()}, set())
    # Its actions are locked, so it is checked beside the lockfile that records them, and its standard job's runner
    # input beside Git Crafter's written exception for it.
    with open(WORKFLOW, encoding="utf-8") as fh, open(os.path.join(os.path.dirname(WORKFLOW), "actions.lock"), encoding="utf-8") as lock:
        own, locks = fh.read(), lock.read()
    with open(os.path.join(TOOLS, "..", ".github", "ci-standard.json"), encoding="utf-8") as fh:
        exc = {"version": 1, "exceptions": {"ci-standard.yml/standard": json.load(fh)["exceptions"]["ci-standard.yml/standard"]}}
    for label, files, want in (("ci-standard.yml keeps the house rules itself", {".github/ci-standard.json": json.dumps(exc)}, set()),
                               ("ci-standard.yml's runner input needs its exception", {}, {"runner"})):
        expect(wrong, label, {".github/workflows/ci-standard.yml": own, ".github/workflows/actions.lock": locks, **files}, want)
    for name, _mark in EMBEDS:
        with open(os.path.join(TOOLS, name), encoding="utf-8") as fh:
            if EXPR in fh.read():
                wrong.append(f"{name} spells an Actions expression; ci-standard.yml cannot embed it")
    for label, change, want in CASES:
        expect(wrong, label, change, want)


def test_lock_link(wrong: list):
    """A lockfile that is a link is never read, so the tag it would lock is still a finding."""
    with tempfile.TemporaryDirectory() as tmp:
        for rel, text in {**GOOD, **TAGGED, "real.lock": LOCK.format(ref="actions/setup-node@v7.1.0")}.items():
            os.makedirs(os.path.dirname(os.path.join(tmp, rel)), exist_ok=True)
            with open(os.path.join(tmp, rel), "w", encoding="utf-8") as fh:
                fh.write(text)
        os.symlink(os.path.join(tmp, "real.lock"), os.path.join(tmp, ".github", "workflows", "actions.lock"))
        got = {f[0] for f in check_repo(tmp)["findings"]}
    if got != {"pinned"}:
        wrong.append(f"a lockfile that is a link: rules {sorted(got)}, want ['pinned']")


def test_exceptions(wrong: list):
    """An exception with a why applies; a bad one is a usage error; the local caller and an empty repo."""
    r = repo_with({**GOOD, ".github/workflows/deploy.yml": DEPLOY.replace("runs-on: ubuntu-slim", "runs-on: macos-15"),
                   ".github/ci-standard.json": json.dumps({"version": 1, "exceptions": {"deploy.yml/deploy": {"rules": ["runner"], "why": "a test"}}})})
    if not r.get("follows") or len(r.get("excepted", [])) != 1:
        wrong.append(f"an exception with a why did not apply: {r}")
    for label, cfg in [("no why", {"deploy.yml": {"rules": ["runner"], "why": ""}}),
                       ("an unknown rule", {"deploy.yml": {"rules": ["speed"], "why": "x"}}),
                       ("an exception to the pin", {"ci.yml": {"rules": ["pin"], "why": "x"}})]:
        if "usage" not in repo_with({**GOOD, ".github/ci-standard.json": json.dumps({"version": 1, "exceptions": cfg})}):
            wrong.append(f"accepted an exception with {label}")
    local = repo_with({".github/workflows/verify.yml": CALLER.replace(f"{EXAMPLE}@{PIN} # v1", LOCAL_STANDARD)})
    if not local.get("follows") or local["caller"]["local"] is not True or local["behind"] != {"commits": 0, "note": "Git Crafter calls the standard by local path"}:
        wrong.append(f"Git Crafter's own local caller: {local}")
    renamed = repo_with({**GOOD, ".github/workflows/ci.yml": GOOD[".github/workflows/ci.yml"].replace("/code-os/", "/git-crafter/")})
    if not renamed.get("follows") or renamed["caller"].get("repo") != "git-crafter":
        wrong.append(f"a caller of <owner>/git-crafter is not the standard: {renamed}")
    if repo_with({})["follows"]:
        wrong.append("a repo with no workflows follows the standard")
    if behind("main", "example-org") != {"could_not_check": "no full SHA pin"}:
        wrong.append("behind() accepted a branch pin")


def test_changes(wrong: list):
    """changes: globs and the unknown-means-run rule, and --output, in a scratch git repo."""
    with tempfile.TemporaryDirectory() as g:
        def git(*args):
            return subprocess.run(["git", "-C", g, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                                  capture_output=True, text=True, check=True).stdout.strip()

        git("init", "-q")
        git("commit", "-q", "--allow-empty", "-m", "base")
        base = git("rev-parse", "HEAD")
        os.makedirs(os.path.join(g, "docs"))
        open(os.path.join(g, "docs", "a.md"), "w").close()
        git("add", ".")
        git("commit", "-q", "-m", "docs")
        for label, paths, b, want in [
            ("a change that misses the paths", "src/**\n*.ts", base, False),
            ("a change that matches **", "docs/**", base, True),
            ("a trailing slash", "docs/", base, True),
            ("* stays in one folder", "*.md", base, False),
            ("**/ matches any depth", "**/*.md", base, True),
            ("no paths", "# only a comment", base, True),
            ("no base", "src/**", "", True),
            ("a first push", "src/**", "0" * 40, True),
            ("not a SHA", "src/**", "main", True),
            ("a commit git does not have", "src/**", "1" * 40, True),
        ]:
            if changes(paths, b, cwd=g)[0] is not want:
                wrong.append(f"changes, {label}: not {want}")
        os.makedirs(os.path.join(g, ".github", "workflows"))
        open(os.path.join(g, ".github", "workflows", "ci.yml"), "w").close()
        git("add", ".")
        git("commit", "-q", "-m", "ci")
        if changes("src/**", base, cwd=g)[0] is not True:
            wrong.append("a change to a workflow file did not run")

        output_flag(g, git, wrong)


def output_flag(g: str, git, wrong: list):
    """--output names the step output, so one step asks twice (pages.yml: a full build or the docs gate only)."""
    after = git("rev-parse", "HEAD")
    open(os.path.join(g, "docs", "b.md"), "w").close()
    git("add", ".")
    git("commit", "-q", "-m", "docs b")

    def cli(*extra):
        out = os.path.join(g, "..", os.path.basename(g) + ".out")
        open(out, "w").close()
        r = subprocess.run([sys.executable, "-I", CLI, "changes", "--base=" + after, *extra], cwd=g,
                           capture_output=True, text=True, env={**os.environ, "GITHUB_OUTPUT": out})
        with open(out, encoding="utf-8") as fh:
            written = fh.read()
        os.remove(out)
        return r.returncode, written
    for label, extra, want in [
        ("--output names the step output", ["--paths=docs/**", "--output=docs"], (0, "docs=true\n")),
        ("--output on a miss", ["--paths=src/**", "--output=full"], (0, "full=false\n")),
        ("no --output keeps run", ["--paths=docs/**"], (0, "run=true\n")),
        ("--output that is not a name", ["--paths=docs/**", "--output=a=b"], (2, "")),
    ]:
        if cli(*extra) != want:
            wrong.append(f"changes, {label}: {cli(*extra)} not {want}")


def test_parser(wrong: list):
    """The YAML subset: block scalars, flow lists, anchors, and what it refuses."""
    doc = parse(CALLER)
    if doc["jobs"]["ci"]["with"]["paths"] != "src/**" or doc["on"]["push"]["branches"] != ["main"]:
        wrong.append("block scalar or flow list misread")
    block = parse("a: |\n  def f():\n      return 1\n\n  x = 2\n")
    if block != {"a": "def f():\n    return 1\n\nx = 2"}:
        wrong.append(f"a block scalar lost its indentation: {block!r}")
    anchored = parse("a:\n  s: &steps\n    - run: x\nb:\n  s: *steps\n")
    if anchored != {"a": {"s": [{"run": "x"}]}, "b": {"s": [{"run": "x"}]}}:
        wrong.append(f"anchor and alias read as {anchored!r}")
    for label, text in [
        ("an alias to no anchor", "a: 1\nb: *a\n"),
        ("a merge key", "a: &x\n  k: 1\nb:\n  <<: *x\n"),
        ("a tag", "a: !!str 1\n"),
        ("a duplicate key", "on: push\non: pull_request\n"),
        ("a multi-line flow list", "on: [push,\n  pull_request]\n"),
        ("a top-level list", "- a\n- b\n"),
    ]:
        try:
            parse(text)
            wrong.append(f"parsed {label}")
        except ParseError:
            pass


def quiet(fn, *args):
    """fn(*args) with its printing kept out of the self-test's output."""
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*args)


def test_embed(wrong: list):
    """embed passes on the real workflow and fails when any one embedded copy differs from its source."""
    with open(WORKFLOW, encoding="utf-8") as fh:
        text = fh.read()
    with tempfile.TemporaryDirectory() as tmp:
        copy = os.path.join(tmp, "ci-standard.yml")
        for label, mark in [("the real workflow", None)] + [(f"a changed line in {n}", m) for n, m in EMBEDS]:
            changed = text if mark is None else text.replace(f"<<'{mark}'\n", f"<<'{mark}'\n          # tampered\n", 1)
            with open(copy, "w", encoding="utf-8") as fh:
                fh.write(changed)
            if quiet(embed, False, copy) != (0 if mark is None else 1):
                wrong.append(f"embed, {label}: wrong exit")
        with open(copy, "w", encoding="utf-8") as fh:
            fh.write(text.replace("CI_STANDARD_RULES_PY", "OTHER"))
        if quiet(embed, False, copy) != 3:
            wrong.append("embed, a missing heredoc: not exit 3")
        overflow, embeds = OVERFLOW
        with open(overflow, encoding="utf-8") as fh:
            text = fh.read()
        for label, mark in [("ci-overflow.yml", None)] + [(f"ci-overflow.yml, a changed line in {n}", m) for n, m in embeds]:
            changed = text if mark is None else text.replace(f"<<'{mark}'\n", f"<<'{mark}'\n          # tampered\n", 1)
            with open(copy, "w", encoding="utf-8") as fh:
                fh.write(changed)
            if quiet(embed, False, copy, embeds) != (0 if mark is None else 1):
                wrong.append(f"embed, {label}: wrong exit")


def test_alone(wrong: list):
    """The three embedded files alone, as the workflow writes them: check and changes run; embed and the self-test
    exit 2."""
    with tempfile.TemporaryDirectory() as tmp:
        for name, _mark in EMBEDS:
            shutil.copy(os.path.join(TOOLS, name), tmp)
        repo = os.path.join(tmp, "repo")
        for rel, text in GOOD.items():
            os.makedirs(os.path.dirname(os.path.join(repo, rel)), exist_ok=True)
            with open(os.path.join(repo, rel), "w", encoding="utf-8") as fh:
                fh.write(text)
        for label, args, want in [("check", ["check", "--repo", repo], 0), ("changes", ["changes", "--paths=src/**"], 0),
                                  ("embed", ["embed"], 2), ("--self-test", ["--self-test"], 2)]:
            r = subprocess.run([sys.executable, "-I", os.path.join(tmp, "ci_standard.py"), *args], cwd=tmp, capture_output=True, text=True)
            if r.returncode != want:
                wrong.append(f"the embedded files alone, {label}: exit {r.returncode}, want {want}: {r.stdout}{r.stderr}")


def run() -> int:
    """Every part; prints each failure and PASS or FAIL, and returns 0 or 1."""
    wrong = []
    for part in (test_repos, test_lock_link, test_exceptions, test_changes, test_parser, test_embed, test_alone):
        part(wrong)
    for line in wrong:
        print(f"ci-standard self-test: FAIL: {line}")
    if wrong:
        return 1
    print("ci-standard self-test: PASS")
    return 0
