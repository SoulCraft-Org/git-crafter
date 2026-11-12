"""Self-test for tools/ci_overflow.py, run by `python3 -I tools/ci_overflow.py --self-test`.

A fake GitHub API serves seeded runs, jobs and state artifacts; nothing reaches the network. Seeded known-bad cases
(at and over the stop, an unreadable API, an untrusted state, a backlog, a repo off the lane, a bad workflow name)
must give GitHub's runner, and the known-clean one (under the stop) the lane's label. The routing cases carry each
label through ci-standard.yml's own runs-on rule for its standard job, read from the workflow file.
"""

import copy
import io
import json
import os
import re
import tempfile
import urllib.error
import zipfile
from datetime import datetime, timedelta, timezone

NOW = datetime(2026, 11, 20, 12, 0, tzinfo=timezone.utc)
LANE = "blacksmith-2vcpu-ubuntu-2404"
REPO = "example-org/example-repo"
ON = {"CI_OVERFLOW_RUNNER": LANE, "GITHUB_REPOSITORY": REPO}
MAIN = {**ON, "CI_OVERFLOW_SAVE": "true"}
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
CFG_PATH = os.path.join(ROOT, ".github", "ci-overflow.json")


def fixture_cfg() -> dict:
    """The repo's lanes with REPO as each lane's one repo: the cases test the meter, not who is on it."""
    with open(CFG_PATH, encoding="utf-8") as fh:
        cfg = json.load(fh)
    for lane in cfg["lanes"].values():
        lane["repos"] = [REPO]
    return cfg
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")


def t(minutes_ago: float) -> str:
    """NOW less minutes_ago, as GitHub writes a time."""
    return (NOW - timedelta(minutes=minutes_ago)).strftime("%Y-%m-%dT%H:%M:%SZ")


def job(label: str, minutes: float, ago: float = 100, done: bool = True) -> dict:
    """A job that started `ago` minutes back and ran `minutes`; not done has no completed_at."""
    return {"labels": [label], "started_at": t(ago), "completed_at": t(ago - minutes) if done else None}


class FakeApi:
    """GitHub's list-runs, list-jobs and artifact endpoints over seeded data; fail raises on every call."""

    def __init__(self, runs=(), artifacts=(), fail=False):
        """Seeded runs and artifacts; fail makes every call raise."""
        self.runs, self.artifacts, self.fail, self.calls, self.paths = list(runs), list(artifacts), fail, 0, []

    def get(self, path, **params):
        """One fake GET: artifacts, a run's jobs or the run list."""
        self.calls += 1
        self.paths.append(path)
        if self.fail:
            raise urllib.error.URLError("seeded outage")
        if path == "actions/artifacts":
            return {"artifacts": [a for a in self.artifacts if a["name"] == params["name"]]}
        if path.endswith("/jobs"):
            jobs = next(r["jobs"] for r in self.runs if path == f"actions/runs/{r['id']}/jobs")
            return {"total_count": len(jobs), "jobs": jobs}
        return self.list_runs(params)

    def list_runs(self, params):
        """created=>=T counts; created=<T pages newest first, as GitHub's list-runs endpoint does."""
        created = params["created"]
        if created.startswith(">="):
            return {"total_count": sum(r["created_at"] >= created[2:] for r in self.runs)}
        rows = sorted((r for r in self.runs if r["created_at"] < created[1:]), key=lambda r: r["created_at"], reverse=True)
        n, page = params["per_page"], params["page"]
        return {"workflow_runs": [dict(r, jobs=None) for r in rows[(page - 1) * n:page * n]]}

    def download(self, artifact_id):
        """A seeded artifact's zip bytes."""
        self.calls += 1
        return next(a["zip"] for a in self.artifacts if a["id"] == artifact_id)


def seed_run(rid, ago, jobs, status="completed"):
    """A run created `ago` minutes back, with its jobs."""
    return {"id": rid, "created_at": t(ago), "status": status, "jobs": jobs}


def one_run(minutes):
    """A month with one completed run of `minutes` on the lane, plus a GitHub-hosted job that never counts."""
    return FakeApi([seed_run(1, 300, [job(LANE, minutes, ago=290), job("ubuntu-latest", 9, ago=290)])])


def artifact(aid, state, branch="main", fork=False):
    """A state artifact as GitHub lists it, from branch, or from another repo."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("state.json", json.dumps(state))
    return {"id": aid, "name": f"ci-overflow-blacksmith-{state['period'][:10]}", "expired": False, "zip": buf.getvalue(),
            "workflow_run": {"head_branch": branch, "repository_id": 7, "head_repository_id": 8 if fork else 7}}


def checks(tool, cfg):
    """(name, passed) for each case."""
    lane = cfg["lanes"]["blacksmith"]
    decide = lambda env, api, c=cfg: tool.decide(env, c, api, NOW)
    under, at, over = (decide(ON, one_run(m))[0] for m in (2699, 2700, 3100))
    yield "under 2700: the lane's label", under["label"] == LANE and under["minutes"] == "2699"
    yield "at 2700: GitHub's runner", at["label"] == "ubuntu-latest" and at["minutes"] == "2700"
    yield "over 2700: GitHub's runner", over["label"] == "ubuntu-latest"
    down = FakeApi(fail=True)
    out, state = decide(ON, down)
    yield "unreadable API: GitHub's runner, no state", out["label"] == "ubuntu-latest" and "could not read" in out["reason"] and state is None
    off = FakeApi()
    yield "off: GitHub's runner, no call", decide({}, off)[0]["label"] == "ubuntu-latest" and off.calls == 0
    yield "an unknown label: GitHub's runner", decide({"CI_OVERFLOW_RUNNER": "self-hosted"}, off)[0]["label"] == "ubuntu-latest" and off.calls == 0
    yield "rounds up and weights by vCPUs", (tool.job_minutes(job(LANE, 0.5), lane, NOW), tool.job_minutes(job("blacksmith-4vcpu-ubuntu-2404", 1.5), lane, NOW)) == (1, 4)
    yield "a skipped job counts 0", tool.job_minutes({"labels": [LANE], "started_at": t(5), "completed_at": t(6)}, lane, NOW) == 0
    yield "cycle start", (tool.iso(tool.period_start(NOW, 1)), tool.iso(tool.period_start(NOW, 25)), tool.iso(tool.period_start(datetime(2026, 1, 3, tzinfo=timezone.utc), 5))) == (
        "2026-11-01T00:00:00Z", "2026-10-25T00:00:00Z", "2025-12-05T00:00:00Z")
    yield from state_checks(tool, cfg)


def state_checks(tool, cfg):
    """The frontier: open runs, a backlog settled over two runs, and which saved states are trusted."""
    decide = lambda env, api, c=cfg: tool.decide(env, c, api, NOW)
    going = FakeApi([seed_run(1, 400, [job(LANE, 10, ago=390)]), seed_run(2, 200, [job(LANE, 5, ago=190, done=False)], "in_progress"),
                     seed_run(3, 100, [job(LANE, 7, ago=95)])])
    out, state = decide(MAIN, going)
    yield "an open run counts live and holds the frontier", out["minutes"] == "207" and state["through"] == t(200) and state["base"] == 10
    going.runs[1] = seed_run(2, 200, [job(LANE, 20, ago=190)])
    out2, _ = decide(MAIN, FakeApi(going.runs, [artifact(1, state)]))
    yield "it settles once, never twice", out2["minutes"] == "37"
    yield from backlog_checks(tool, cfg)


def backlog_checks(tool, cfg):
    """A backlog over the budget, and which saved states are trusted."""
    decide = lambda env, api, c=cfg: tool.decide(env, c, api, NOW)
    many =[seed_run(i, 5000 - i, [job(LANE, 1, ago=4999 - i)]) for i in range(150)]
    pr = FakeApi(many)
    yield "a backlog over the pull request budget: GitHub's runner", "backlog" in decide(ON, pr)[0]["reason"] and pr.calls <= 1 + len(cfg["workflows"])
    tight = copy.deepcopy(cfg)
    tight["budget_calls"]["main"] = 60
    out, saved = decide(MAIN, FakeApi(many), tight)
    passes = [out]
    while "backlog" in passes[-1]["reason"] and len(passes) < 5:
        out, saved = decide(MAIN, FakeApi(many, [artifact(len(passes), saved)]), tight)
        passes.append(out)
    yield "main settles a backlog over runs", len(passes) == 3 and passes[-1]["minutes"] == "150" and passes[-1]["label"] == LANE
    high = dict(tool.fresh("blacksmith", tool.period_start(NOW, 1)), base=2800)
    trusted = FakeApi([seed_run(1, 10, [job(LANE, 1, ago=9)])], [artifact(4, high)])
    yield "a saved stop: GitHub's runner, no run read", decide(ON, trusted)[0]["label"] == "ubuntu-latest" and trusted.calls == 2
    for name, art in (("a pull request's", artifact(5, high, branch="claude/x")), ("a fork's", artifact(6, high, fork=True))):
        yield f"{name} state is ignored", decide(ON, FakeApi([seed_run(1, 10, [job(LANE, 1, ago=9)])], [art]))[0]["minutes"] == "1"


def cli_checks(tool):
    """choose: GITHUB_OUTPUT and the state file on the trusted branch; a missing config is GitHub's runner."""
    with tempfile.TemporaryDirectory() as tmp:
        out, state, cfg_path = os.path.join(tmp, "out"), os.path.join(tmp, "s", "state.json"), os.path.join(tmp, "cfg.json")
        with open(cfg_path, "w", encoding="utf-8") as fh:
            json.dump(fixture_cfg(), fh)
        env = {**MAIN, "GITHUB_OUTPUT": out}
        tool.choose(["--config", cfg_path, "--state-out", state], env, NOW, one_run(12))
        with open(out, encoding="utf-8") as fh:
            lines = fh.read()
        yield "choose writes the label and the state", f"label={LANE}\n" in lines and os.path.isfile(state)
        for name, brk in (("a newline", "\n"), ("a carriage return", "\r")):
            open(out, "w").close()
            bad = {"CI_OVERFLOW_RUNNER": f"{LANE}{brk}label=blacksmith-16vcpu-ubuntu-2404", "GITHUB_OUTPUT": out}
            tool.choose(["--config", cfg_path], bad, NOW, one_run(12))
            with open(out, encoding="utf-8", newline="") as fh:
                text = fh.read()
            yield f"{name} in the variable: GitHub's runner, one label line", text.count("label=") == 1 and "label=ubuntu-latest\n" in text and "16vcpu" not in text
        yield "an unsafe output value: the stock outputs", tool.safe({"label": LANE, "reason": "x\nlabel=y"})["label"] == "ubuntu-latest"
        code = tool.choose(["--config", os.path.join(tmp, "none.json")], {**ON, "GITHUB_OUTPUT": out}, NOW, FakeApi())
        with open(out, encoding="utf-8") as fh:
            yield "a missing config: GitHub's runner, exit 0", code == 0 and fh.read().endswith("reason=could not start (FileNotFoundError)\n")


def read(name):
    """A workflow file's text."""
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as fh:
        return fh.read()


def standard_runner(label):
    """The runner ci-standard.yml's standard job takes for a runner input: its runs-on rule, read from the file."""
    lanes = json.loads(re.search(r"standard:.*?runs-on: .*?fromJSON\('(\[.*?\])'\)", read("ci-standard.yml"), re.S).group(1))
    return label if label in lanes else "ubuntu-latest"


def caller_checks(tool, cfg):
    """Repos and workflows the lane serves, and each label routed through ci-standard.yml's standard job."""
    decide = lambda env, api, c=cfg: tool.decide(env, c, api, NOW)
    for name, repo, want in (("a repo off the lane", "example-org/other", "ubuntu-latest"),
                             ("the lane's repo in another case", ON["GITHUB_REPOSITORY"].swapcase(), LANE)):
        api = one_run(12)
        yield f"{name}: {want}", decide({**ON, "GITHUB_REPOSITORY": repo}, api)[0]["label"] == want and (want == LANE or api.calls == 0)
    ref = f"{REPO}/.github/workflows/verify.yml@refs/pull/9/merge"
    yield "a workflow ref meters its file", tool.workflows_of(ref, cfg) == ["verify.yml"] and tool.workflows_of("", cfg) == cfg["workflows"]
    api = one_run(12)
    decide({**ON, "CI_OVERFLOW_WORKFLOWS": "verify.yml"}, api)
    yield "the caller's workflows are the ones read", "actions/workflows/verify.yml/runs" in api.paths and not any("pages.yml" in p for p in api.paths)
    bad = FakeApi()
    out = decide({**ON, "CI_OVERFLOW_WORKFLOWS": "verify.yml?per_page=100"}, bad)[0]
    yield "a name that is not a workflow file: GitHub's runner, no call", out["label"] == "ubuntu-latest" and bad.calls == 0
    routed = [standard_runner(decide(env, one_run(m))[0]["label"]) for env, m in ((ON, 2699), (ON, 2700), (ON, 3100), ({}, 0))]
    yield "ci-standard.yml's standard job: the lane under 2700, ubuntu-latest at, over and unset", routed == [LANE] + ["ubuntu-latest"] * 3
    yield "ci-standard.yml routes no label of its own", standard_runner("self-hosted") == "ubuntu-latest" and standard_runner("") == "ubuntu-latest"
    lanes = sorted(lab for lane in cfg["lanes"].values() for lab in lane["labels"])
    yield "ci-standard.yml's lane labels are the config's", all(standard_runner(lab) == lab for lab in lanes) and \
        sorted(json.loads(re.search(r"fromJSON\('(\[.*?\])'\)", read("ci-standard.yml")).group(1))) == lanes
    named = re.search(r"uses: \./\.github/workflows/ci-overflow\.yml.*?workflows: ([^\n]+)", read("verify.yml"), re.S).group(1)
    yield "verify.yml meters the config's workflows", tool.workflows_of(named, cfg) == sorted(cfg["workflows"])


def run_all(tool, cfg):
    """Every case's (name, passed)."""
    return list(checks(tool, cfg)) + list(cli_checks(tool)) + list(caller_checks(tool, cfg))


def run(tool):
    """Exit 0 when every case passes; prints each failure."""
    results = run_all(tool, fixture_cfg())
    bad = [name for name, ok in results if not ok]
    for name in bad:
        print(f"FAIL {name}")
    print(f"ci_overflow self-test: {len(results) - len(bad)} of {len(results)} pass")
    return 1 if bad else 0
