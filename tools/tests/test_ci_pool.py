"""Self-test for tools/ci_pool.py, run by `python3 -I tools/ci_pool.py --self-test`.

A fake GitHub API serves two repos' runs and jobs; nothing reaches the network. Known-clean cases must count each job
as Blacksmith bills it. Known-bad ones (a cut-off list, an unknown label, a failed read) must read complete: false or
raise Unreadable, never a quiet undercount.
"""

import datetime as dt
import json
import os
import tempfile
from types import SimpleNamespace

NOW = dt.datetime(2026, 11, 20, 10, 0, tzinfo=dt.timezone.utc)
BS = {"labels": ["blacksmith-2vcpu-ubuntu-2404"], "runner_name": "bs"}


def job(label: str, start: str, end, **extra) -> dict:
    """A Blacksmith job on 2026-11-20 from start to end; end None is still running."""
    return {**BS, "labels": [label], "started_at": f"2026-11-20T{start}Z", "completed_at": end and f"2026-11-20T{end}Z", **extra}


JOBS = {
    1: [job("blacksmith-2vcpu-ubuntu-2404", "08:00:00", "08:01:30"),  # 2
        job("blacksmith-4vcpu-ubuntu-2404", "08:00:00", "08:02:00"),  # 2 x 2 = 4
        job("blacksmith-2vcpu-ubuntu-2404-arm", "08:00:00", "08:04:00")],  # 4 x 0.625 = 2.5
    2: [job("blacksmith-2vcpu-ubuntu-2404", "09:58:10", None)],  # 2, to NOW
    3: [job("ubuntu-latest", "08:00:00", "08:05:00", runner_name="gh"), job("ubuntu-latest", "08:00:00", None, runner_name=None)],
}


RUNS = {"alpha": [(2, "in_progress", "2026-11-20T09:00:00Z"), (1, "completed", "2026-11-20T08:00:00Z"),
                  (0, "completed", "2026-09-01T08:00:00Z")], "beta": [(3, "completed", "2026-11-19T08:00:00Z")]}


class FakeApi:
    """alpha: a run still going, a Blacksmith run of 3 jobs, then a run before the window that must end the list.
    beta: one GitHub-hosted run. old: archived."""

    tool = None

    def __init__(self, fail: str = "", job_total=None):
        self.fail, self.job_total, self.calls, self.paths, self.written = fail, job_total, 0, [], None

    def get(self, path: str, params=None):
        """Serves the repos, then each repo's runs and each run's jobs; a path containing fail is Unreadable."""
        self.calls += 1
        params = params or {}
        self.paths.append((path, params.get("page")))
        if self.fail and self.fail in path:
            raise self.tool.Unreadable(f"GET {path}: HTTP 500")
        if path.endswith("/repos"):
            return [{"name": "alpha"}, {"name": "beta"}, {"name": "old", "archived": True}]
        if "created" in params or (path.endswith("/jobs") and params.get("filter") != "all"):
            raise self.tool.Unreadable(f"GET {path}: a capped list, or one attempt only")
        return self.runs_or_jobs(path)

    def runs_or_jobs(self, path: str) -> dict:
        """A repo's runs from RUNS, or a run's jobs from JOBS."""
        listed = RUNS.get(path.split("/")[3]) if path.endswith("/actions/runs") else None
        if listed is not None:
            return {"total_count": len(listed), "workflow_runs": [
                {"id": i, "status": s, "updated_at": f"u{i}", "created_at": c} for i, s, c in listed]}
        run_id = int(path.split("/runs/")[1].split("/")[0])
        return {"total_count": self.job_total or len(JOBS[run_id]), "jobs": JOBS[run_id]}

    def request(self, method, path, params=None, body=None):
        """Records a write; a PATCH finds no variable, so the meter creates it."""
        if method == "PATCH":
            raise FileNotFoundError(path)
        self.written = body


class CappedApi(FakeApi):
    """One repo with 2,500 runs in the window, served as GitHub serves a filtered list: 10 pages, then empty."""

    def get(self, path: str, params=None):
        """The one repo, then its runs ten pages deep."""
        self.calls += 1
        if path.endswith("/repos"):
            return [{"name": "busy"}]
        page = (params or {}).get("page", 1)
        return {"total_count": 2500, "workflow_runs": [] if page > 10 else [
            {"id": page * 1000 + i, "status": "completed", "updated_at": "u", "created_at": "2026-11-20T08:00:00Z"}
            for i in range(100)]}


def label_checks(tool):
    """Each label's weight, each job's rounding, and the labels Blacksmith does not list."""
    weights = {"blacksmith-2vcpu-ubuntu-2404": 1, "blacksmith-8vcpu-ubuntu-2204": 4, "blacksmith-4vcpu-ubuntu-2404-arm": 1.25,
               "blacksmith-2vcpu-windows-2025": 2, "blacksmith-4vcpu-windows-2025": 4, "blacksmith-6vcpu-macos-latest": 20,
               "blacksmith-12vcpu-macos-15": 40, "blacksmith-4vcpu-ubuntu-2404;scheduling=flex": 2}
    yield "each label weighs as Blacksmith bills it", all(tool.weight(k) == v for k, v in weights.items())
    for label in ("blacksmith-macos", "blacksmith-0vcpu-ubuntu-2404", "blacksmith-8vcpu-macos-latest",
                  "blacksmith-2vcpu-windows-2025-arm", "blacksmith-2vcpu-ubuntu-2404;scheduling=cheap"):
        yield f"an unknown label is Unreadable: {label}", raises(tool, lambda: tool.weight(label))
    mins = [tool.job_minutes(j, NOW) for j in JOBS[1] + JOBS[2] + JOBS[3]]
    yield "jobs round up, run to now, and GitHub's own count 0", mins == [2, 4, 2.5, 2, 0, 0]
    yield "no token is Unreadable", raises(tool, lambda: tool.Api(""))


def list_checks(tool):
    """The repo, run and job lists, whole or not, and a failed read."""
    api = FakeApi()
    runs, whole = tool.repo_runs(api, "org", "alpha", NOW - tool.WINDOW)
    yield "the run list ends at the first run before the window", [r["id"] for r in runs] == [2, 1] and whole and api.calls == 1
    yield "a run list cut off at 1,000 of 2,500 is not whole", tool.repo_runs(CappedApi(), "org", "busy", NOW - tool.WINDOW)[1] is False
    yield "a job list short of its total_count is not whole", tool.run_jobs(FakeApi(job_total=500), "org", "alpha", 1)[2] is False
    yield "a failed run list is Unreadable", raises(tool, lambda: tool.repo_runs(FakeApi("/actions/runs"), "org", "alpha", NOW))
    yield "the repo list skips archived repos", tool.org_repos(FakeApi(), "org") == ["alpha", "beta"]


def meter_checks(tool):
    """The count, the stop, the ledger across passes, and the time budget."""
    api = FakeApi()
    ledger = {}
    got = tool.meter(api, "org", ledger, NOW)
    b = got["blacksmith"]
    yield "the meter counts 8.5 finished and 2 still going", b["used"] == 10.5 and b["by_repo"] == {"alpha": 10.5} and got["complete"]
    yield "the ledger keeps only finished runs", sorted(ledger["runs"]) == ["alpha/1", "beta/3"] and got["repos"] == 2
    yield "the stop sits 1.25 hours of the floor's burn under 3,000", b["stop"] == 2250 and got["max_age_minutes"] == 75
    again = FakeApi()
    yield "a second pass reads only what changed", tool.meter(again, "org", ledger, NOW)["blacksmith"]["used"] == 10.5 and again.calls < api.calls
    busy = {"version": 2, "runs": {"alpha/9": {"u": "x", "h": "2026-11-19T15", "m": 1000}}}
    yield "a busier hour lowers the stop", tool.meter(FakeApi(), "org", busy, NOW)["blacksmith"]["stop"] == 1750 and tool.stop_for(5000) == 0
    for name, old in (("a version 1 ledger", {"runs": {"alpha/1": {"u": "u1", "h": "2026-11-20T08", "m": 999}}}),
                      ("a ledger run from before the window", {"version": 2, "runs": {"alpha/0": {"u": "x", "h": "2026-09-01T08", "m": 999}}})):
        yield f"the meter does not trust {name}", tool.meter(FakeApi(), "org", old, NOW)["blacksmith"]["used"] == 10.5
    yield "a pass out of reads is not complete", tool.meter(FakeApi(), "org", {}, NOW, reads=1)["complete"] is False
    ticks, ledger = iter(range(100)), {}
    cut = tool.meter(FakeApi(), "org", ledger, NOW, deadline=3, clock=lambda: next(ticks))
    yield "a pass past its deadline stops and is not complete", cut["complete"] is False and sorted(ledger["runs"]) == ["alpha/1"]
    yield "the next pass resumes and catches up", tool.meter(FakeApi(), "org", ledger, NOW)["complete"] is True


def ledger_checks(tool):
    """The ledger saved as the pass goes and across a failed read, and the org variable."""
    saves, tool.SAVE_EVERY = [], 1
    tool.meter(FakeApi(), "org", {}, NOW, save=lambda x: saves.append(len(x["runs"])))
    tool.SAVE_EVERY = 50
    yield "the ledger is saved as the pass goes", saves == [0, 1, 2]
    with tempfile.TemporaryDirectory() as tmp:
        args = SimpleNamespace(org="org", ledger=os.path.join(tmp, "ledger.json"), seconds=60)
        failed = raises(tool, lambda: tool.run_meter(args, FakeApi("/beta/"), NOW))
        with open(args.ledger, encoding="utf-8") as fh:
            yield "a failed read still saves the runs read so far", failed and sorted(json.load(fh)["runs"]) == ["alpha/1"]
    fake = FakeApi()
    tool.write_variable(fake, "org", "{}")
    yield "write_variable creates CI_POOL when it is missing", (fake.written or {}).get("name") == "CI_POOL"


def cli_checks(tool):
    """Blacksmith's own count, read from its CLI's JSON, and the higher count kept."""
    nested = json.dumps({"billable_minutes": 120.0, "repos": [{"name": "a", "billable_minutes": 80}], "free_minutes": 3000})
    yield "the CLI's total is its highest billable count", tool.cli_minutes(nested) == 120.0
    yield "a camelCase field counts too", tool.cli_minutes('{"usage": {"billingMinutes": 30}}') == 30.0
    for name, text in (("not JSON", "Error: not signed in"), ("no billable field", '{"minutes": 5, "billable": true}')):
        yield f"CLI output with {name} gives no count", tool.cli_minutes(text) is None

    def reading():
        """A fresh reading of 10.5 minutes."""
        return {"blacksmith": {"used": 10.5, "stop": 2250, "left": 2239.5}}
    up = tool.cross_check(reading(), nested)["blacksmith"]
    yield "a higher CLI count raises used and lowers left", up["used"] == 120.0 and up["left"] == 2130.0
    yield "a lower CLI count leaves the meter's", tool.cross_check(reading(), '{"billable_minutes": 3}')["blacksmith"]["used"] == 10.5
    yield "no CLI output leaves the reading as it was", tool.cross_check(reading(), None) == reading()
    noted = tool.cross_check(reading(), "")
    yield "unreadable CLI output becomes a note", noted["notes"] and noted["blacksmith"]["used"] == 10.5


class GroupApi:
    """An org's runner groups; records each write as (method, last path part, body)."""

    def __init__(self, names=("Blacksmith", "blacksmith-arm", "Default")):
        self.groups, self.writes = [{"id": i, "name": n} for i, n in enumerate(names, 7)], []

    def get(self, path, params=None):
        """The groups, on one page."""
        return {"total_count": len(self.groups), "runner_groups": self.groups}

    def request(self, method, path, params=None, body=None):
        """Records the write."""
        self.writes.append((method, path.rsplit("/", 1)[-1], body))


def backstop_checks(tool):
    """The hard stop closes the Blacksmith groups, holds them closed, and opens them only on resume."""
    def at(used, previous=None, resume=False, api=None):
        """(stopped, the writes) for a pass at used minutes."""
        api = api or GroupApi()
        b = tool.backstop(api, "org", {"blacksmith": {"used": used}}, 2850, resume, previous)["blacksmith"]
        return b["stopped"], api.writes
    closed = [("PATCH", "7", {"visibility": "selected"}), ("PUT", "repositories", {"selected_repository_ids": []}),
              ("PATCH", "8", {"visibility": "selected"}), ("PUT", "repositories", {"selected_repository_ids": []})]
    stopped = json.dumps({"blacksmith": {"stopped": True}})
    yield "under the hard stop nothing changes", at(2849) == (False, [])
    yield "at the hard stop both Blacksmith groups close and Default does not", at(2850) == (True, closed)
    yield "once stopped, each pass closes them again", at(100, stopped) == (True, closed)
    yield "resume opens them to all", at(100, stopped, True) == (False, [("PATCH", "7", {"visibility": "all"}),
                                                                         ("PATCH", "8", {"visibility": "all"})])
    yield "resume at the hard stop stays stopped", at(2900, stopped, True) == (True, closed)
    yield "a garbled last reading is not a stop", at(100, "{not json") == (False, [])
    yield "a stop with no Blacksmith group is Unreadable", raises(tool, lambda: at(2850, api=GroupApi(("Default",))))


def manifest_checks(tool):
    """The CI pool App asks for exactly what the meter and the backstop use, and no webhook."""
    with open(os.path.join(tool.HERE, "..", "templates", "ci", "ci-pool-app.json"), encoding="utf-8") as fh:
        app = json.load(fh)
    yield "the App reads Actions, writes org variables and runner groups, nothing more", app["default_permissions"] == {
        "actions": "read", "organization_actions_variables": "write", "organization_self_hosted_runners": "write"}
    yield "the App's webhook is off", app["hook_attributes"]["active"] is False and app["default_events"] == []
    with open(os.path.join(tool.HERE, "..", "actions", "ci-pool", "action.yml"), encoding="utf-8") as fh:
        action = fh.read()
    yield "the action's hard stop default is the meter's", f'default: "{tool.HARD_STOP}"' in action


def raises(tool, fn) -> bool:
    """Whether fn raises Unreadable."""
    try:
        fn()
    except tool.Unreadable:
        return True
    return False


def run(tool):
    """Exit 0 when every case passes; prints each failure."""
    FakeApi.tool = tool
    results = [result for checks in CHECKS for result in checks(tool)]
    bad = [name for name, ok in results if not ok]
    for name in bad:
        print(f"FAIL {name}")
    print(f"ci_pool self-test: {len(results) - len(bad)} of {len(results)} pass")
    return 1 if bad else 0


CHECKS = (label_checks, list_checks, meter_checks, ledger_checks, cli_checks, backstop_checks, manifest_checks)
