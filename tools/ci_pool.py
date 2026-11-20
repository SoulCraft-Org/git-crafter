#!/usr/bin/env python3
"""ci_pool.py: the org's Blacksmith pool meter, the minutes every repo used of Blacksmith's free minutes.

Usage:
    ci_pool.py --self-test
        Runs tools/tests/test_ci_pool.py with fake APIs.

Each job counts as Blacksmith bills it: rounded up to the minute, then weighted against an x64 2-vCPU minute. A list
the meter could not read whole says so, and a failed read raises Unreadable, never a count of zero. Standard library
only.
"""

from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.github.com"
WINDOW = dt.timedelta(days=31)
LABEL_RE = re.compile(r"blacksmith-(\d+)vcpu-(ubuntu|windows|macos)-\w+(-arm)?(;scheduling=flex)?")
# Weights against an x64 2-vCPU minute (docs.blacksmith.sh/blacksmith-runners/overview, read 2026-11-20).
ARM, MACOS = 0.625, {6: 20, 12: 40}
RUN_PAGES, JOB_PAGES, PAGE = 500, 10, 100


class Unreadable(Exception):
    """A reading the meter cannot trust: exit 3, and never a count of zero."""


def parse_time(value) -> dt.datetime:
    """A GitHub time; ValueError when it is not one or has no zone."""
    t = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if t.tzinfo is None:
        raise ValueError(f"time without a zone: {value!r}")
    return t


class Api:
    """The GitHub REST reads and writes the meter makes. The self-test passes fakes with the same methods."""

    def __init__(self, token: str):
        if not token:
            raise Unreadable("no GH_TOKEN: the meter needs the CI pool App's installation token")
        self.token, self.calls = token, 0

    def request(self, method: str, path: str, params: dict | None = None, body: dict | None = None):
        url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "git-crafter-ci-pool"})
        self.calls += 1
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as err:
            if method != "GET" and err.code == 404:
                raise FileNotFoundError(path) from None
            raise Unreadable(f"{method} {path}: HTTP {err.code}") from None
        except Exception as err:  # noqa: BLE001 - any failed read is unknown, never zero
            raise Unreadable(f"{method} {path}: {type(err).__name__}") from None

    def get(self, path: str, params: dict | None = None):
        return self.request("GET", path, params)


def items_of(doc, key: str, path: str) -> list:
    items = doc.get(key) if isinstance(doc, dict) and key else doc
    if not isinstance(items, list):
        raise Unreadable(f"GET {path}: no {key or 'item'} list")
    return items


def weight(label: str) -> float:
    """Free minutes one minute on this Blacksmith label uses. A label Blacksmith does not list is Unreadable."""
    m = LABEL_RE.fullmatch(label)
    vcpus, family, arm = (int(m[1]), m[2], bool(m[3])) if m else (0, "", False)
    if vcpus > 0 and family == "ubuntu":
        return vcpus / 2 * (ARM if arm else 1.0)
    if vcpus > 0 and family == "windows" and not arm:
        return float(vcpus)
    if family == "macos" and not arm and vcpus in MACOS:
        return float(MACOS[vcpus])
    raise Unreadable(f"unknown Blacksmith runner label {label!r}")


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
    repos = []
    for page in range(1, 51):
        items = items_of(api.get(f"/orgs/{org}/repos", {"type": "all", "per_page": PAGE, "page": page}), "", "repos")
        repos += [r["name"] for r in items if not r.get("archived")]
        if len(items) < PAGE:
            return sorted(repos)
    raise Unreadable(f"GET /orgs/{org}/repos: more than 5,000 repos")


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
    if argv == ["--self-test"]:
        return self_test()
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
