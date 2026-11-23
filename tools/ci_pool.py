#!/usr/bin/env python3
"""ci_pool.py: the org's Blacksmith pool meter, the dollars used of Blacksmith's $12 monthly credit and the stop.

Usage:
    ci_pool.py --self-test
        Runs tools/tests/test_ci_pool.py with fake APIs.

Each job counts as Blacksmith bills it: rounded up to the minute and weighted against an x64 2-vCPU minute. Standard
library only.
"""

from __future__ import annotations

import datetime as dt
import math
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# python3 -I leaves this folder off sys.path; the GitHub reads and writes sit beside this file, at the same pin.
sys.path.append(HERE)
from ci_pool_github import Api, Unreadable, items_of, iso, parse_time  # noqa: E402,F401

# Blacksmith's free minutes per organization a month (docs.blacksmith.sh/blacksmith-runners/overview, read 2026-11-20).
FREE = 3000
# The meter runs hourly. 75 minutes trusts one reading plus 15 minutes of schedule delay; a missed pass goes stale.
MAX_AGE = dt.timedelta(minutes=75)
# Free: 3,000 x64 2vCPU minutes a month per org (docs.blacksmith.sh runners overview FAQ); list price $0.004 a minute
# (flex scheduling page), both read 2026-11-20: $12 of credit. Goals: stop at 90 %, close the groups at 95 %.
RATE, STOP_SHARE, HARD_SHARE = 0.004, 0.90, 0.95
CREDIT = FREE * RATE
STOP, HARD_STOP = round(CREDIT * STOP_SHARE, 2), round(CREDIT * HARD_SHARE, 2)
WINDOW = dt.timedelta(days=31)
LABEL_RE = re.compile(r"blacksmith-(\d+)vcpu-(ubuntu|windows|macos)-\w+(-arm)?(;scheduling=flex)?")
# Weights against an x64 2-vCPU minute (docs.blacksmith.sh/blacksmith-runners/overview, read 2026-11-20).
ARM, MACOS = 0.625, {6: 20, 12: 40}
READS_PER_PASS, RUN_PAGES, JOB_PAGES, PAGE, SAVE_EVERY = 3000, 500, 10, 100, 50


def weight(label: str) -> float:
    """Free minutes one minute on this Blacksmith label uses. A label Blacksmith does not list is Unreadable."""
    m = LABEL_RE.fullmatch(label)
    vcpus, family, arm = (int(m[1]), m[2], bool(m[3])) if m else (0, "", False)
    rates = {("ubuntu", False): vcpus / 2, ("ubuntu", True): vcpus / 2 * ARM, ("windows", False): vcpus,
             ("macos", False): MACOS.get(vcpus, 0)}
    rate = rates.get((family, arm), 0)
    if rate <= 0:
        raise Unreadable(f"unknown Blacksmith runner label {label!r}")
    return float(rate)


def job_minutes(job: dict, now: dt.datetime) -> float:
    """Free minutes one job used: 0 unless a Blacksmith runner took it. A job still running counts to now."""
    labels = [str(x) for x in job.get("labels") or [] if str(x).startswith("blacksmith-")]
    if not labels or not job.get("started_at") or not job.get("runner_name"):
        return 0.0
    end = parse_time(job["completed_at"]) if job.get("completed_at") else now
    seconds = (end - parse_time(job["started_at"])).total_seconds()
    return math.ceil(max(seconds, 1.0) / 60) * max(weight(x) for x in labels)


def repo_runs(api, org: str, repo: str, start: dt.datetime) -> tuple:
    """(runs created at or after start, newest first; whether that is all of them). No `created` filter: GitHub caps a
    filtered list at 1,000 runs. A list that ends short of total_count is cut off, so it is not complete."""
    path, runs, seen, total = f"/repos/{org}/{repo}/actions/runs", [], 0, None
    for page in range(1, RUN_PAGES + 1):
        doc = api.get(path, {"per_page": PAGE, "page": page})
        items = items_of(doc, "workflow_runs", path)
        total = doc.get("total_count") if total is None else total
        for run in items:
            seen += 1
            if parse_time(run["created_at"]) < start:
                return runs, True
            runs.append(run)
        if len(items) < PAGE:
            return runs, isinstance(total, int) and seen >= total
    return runs, False


def run_jobs(api, org: str, repo: str, run_id) -> tuple:
    """(every job of every attempt, pages read, whether that is all of them per total_count)."""
    path, jobs, total, pages = f"/repos/{org}/{repo}/actions/runs/{run_id}/jobs", [], None, 0
    for page in range(1, JOB_PAGES + 1):
        doc = api.get(path, {"filter": "all", "per_page": PAGE, "page": page})
        pages += 1
        items = items_of(doc, "jobs", path)
        total = doc.get("total_count") if total is None else total
        jobs.extend(items)
        if len(items) < PAGE:
            break
    return jobs, pages, isinstance(total, int) and len(jobs) >= total


def org_repos(api, org: str) -> list:
    """The org's repos that are not archived, sorted; Unreadable past 5,000."""
    repos = []
    for page in range(1, 51):
        items = items_of(api.get(f"/orgs/{org}/repos", {"type": "all", "per_page": PAGE, "page": page}), "", "repos")
        repos += [r["name"] for r in items if not r.get("archived")]
        if len(items) < PAGE:
            return sorted(repos)
    raise Unreadable(f"GET /orgs/{org}/repos: more than 5,000 repos")


class Pass:
    """One pass of the meter: what it reads, its limits (a deadline on clock, job pages left) and the runs it read."""

    def __init__(self, api, org: str, now: dt.datetime, runs: dict, limits: tuple):
        self.api, self.org, self.now, self.start = api, org, now, now - WINDOW
        self.runs, self.going, self.fresh = runs, {}, 0
        self.deadline, self.clock, self.save, self.reads = limits

    def has_time(self) -> bool:
        """Whether the deadline is still ahead."""
        return self.clock() < self.deadline

    def read_run(self, repo: str, run: dict) -> bool:
        """Reads one run's jobs into runs (finished, every job read) or going; whether every job was read."""
        key, done = f"{repo}/{run['id']}", run.get("status") == "completed"
        jobs, pages, all_jobs = run_jobs(self.api, self.org, repo, run["id"])
        self.reads, self.fresh = self.reads - pages, self.fresh + 1
        self.runs.pop(key, None)
        (self.runs if done and all_jobs else self.going)[key] = {
            "u": run.get("updated_at"), "h": parse_time(run["created_at"]).strftime("%Y-%m-%dT%H"),
            "m": sum(job_minutes(j, self.now) for j in jobs)}
        if self.fresh % SAVE_EVERY == 0:
            self.save()
        return all_jobs

    def read_repo(self, repo: str) -> bool:
        """Reads the repo's runs in the window that the ledger lacks; whether all of them were read."""
        listed, whole = repo_runs(self.api, self.org, repo, self.start) if self.has_time() else ([], False)
        for run in listed:
            if run.get("status") == "completed" and self.runs.get(f"{repo}/{run['id']}", {}).get("u") == run.get(
                    "updated_at"):
                continue
            if self.reads <= 0 or not self.has_time():
                whole = False
                continue
            whole = self.read_run(repo, run) and whole
        return whole


def kept_runs(ledger: dict, start: dt.datetime) -> dict:
    """The ledger's runs created in the window. Resets the ledger in place to version 2, holding only those."""
    floor = start.strftime("%Y-%m-%dT%H")
    old = ledger.get("runs") if ledger.get("version") == 2 and isinstance(ledger.get("runs"), dict) else {}
    runs = {k: v for k, v in old.items() if isinstance(v, dict) and str(v.get("h", "")) >= floor}
    ledger.clear()
    ledger.update({"version": 2, "runs": runs})
    return runs


def tally(entries: dict) -> tuple:
    """(minutes by repo, the busiest hour's minutes) over "repo/run id" entries."""
    by_repo, by_hour = {}, {}
    for key, v in entries.items():
        repo = key.split("/", 1)[0]
        by_repo[repo] = by_repo.get(repo, 0) + v["m"]
        by_hour[v["h"]] = by_hour.get(v["h"], 0) + v["m"]
    return by_repo, max(by_hour.values(), default=0.0)


def meter(api, org: str, ledger: dict, now: dt.datetime, deadline: float = math.inf, clock=time.monotonic,
          save=lambda _ledger: None, reads: int = READS_PER_PASS) -> dict:
    """The reading. ledger maps "repo/run id" to {"u": updated_at, "h": created hour, "m": minutes} for finished runs
    whose jobs were all read, and is updated in place; save gets it every SAVE_EVERY runs read. Past deadline on clock,
    or out of reads, the pass reads no more runs and says complete: false."""
    p = Pass(api, org, now, kept_runs(ledger, now - WINDOW), (deadline, clock, lambda: save(ledger), reads))
    repos = org_repos(api, org)
    complete = all([p.read_repo(repo) for repo in repos])
    by_repo, peak = tally({**p.runs, **p.going})
    used = sum(by_repo.values())
    cost = round(used * RATE, 2)
    return {"version": 3, "at": iso(now), "complete": complete, "max_age_minutes": int(MAX_AGE.total_seconds() // 60),
            "window_start": iso(p.start), "repos": len(repos),
            "blacksmith": {"cost": cost, "credit": CREDIT, "stop": STOP, "left": round(max(STOP - cost, 0), 2),
                           "floor_cost": cost, "floor_minutes": round(used, 1), "peak_hour": round(peak, 1),
                           "by_repo": {k: round(v, 1) for k, v in sorted(by_repo.items()) if v}}}


def self_test() -> int:
    """Runs tools/tests/test_ci_pool.py; exit 2 where it is absent."""
    tests = os.path.join(HERE, "tests")
    if not os.path.isfile(os.path.join(tests, "test_ci_pool.py")):
        sys.stderr.write("ci_pool: no self-test here; run it from a Git Crafter checkout\n")
        return 2
    sys.path.append(tests)
    import test_ci_pool
    return test_ci_pool.run(sys.modules[__name__])


def main(argv: list) -> int:
    """The command line; the exit code."""
    if argv == ["--self-test"]:
        return self_test()
    print("usage: ci_pool.py --self-test", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
