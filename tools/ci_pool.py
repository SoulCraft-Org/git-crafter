#!/usr/bin/env python3
"""ci_pool.py: the org's Blacksmith pool meter, the dollars used of Blacksmith's $12 monthly credit and the stop.

Usage:
    ci_pool.py meter --org=ORG --ledger=FILE [--seconds=N] [--cli-usage=FILE] [--hard-stop=N] [--resume] [--write]
        Reads every repo's job records with $GH_TOKEN (the CI pool App's installation token), saves the ledger as it
        goes and prints the reading. --cli-usage takes `blacksmith usage --since 30d --format json` output: its
        estimated cost is the reading, the job records' cost its floor, and the higher counts. Without that cost the
        reading is complete: false, so no chooser takes Blacksmith. With --write, at the hard stop (default $11.40)
        every runner group whose name starts with Blacksmith is closed to all repos, again on each pass, until a pass
        with --resume opens them to all. $CI_POOL_PREVIOUS, the last reading, carries the stop from pass to pass.
        --write also stores the reading in the org variable CI_POOL. A pass stops on its own after N seconds
        (default 900) and reads complete: false until a later pass catches up.
        Exit 0 read, 2 usage error, 3 could not read.
    ci_pool.py --self-test
        Runs tools/tests/test_ci_pool.py with fake APIs.

Blacksmith's free tier is a credit worth FREE x64 2-vCPU minutes at list price, so the meter works in dollars. Each
job in the floor counts as Blacksmith bills it: rounded up to the minute, weighted against an x64 2-vCPU minute, times
RATE. The stop is STOP_SHARE of the credit and the hard stop HARD_SHARE. A run whose jobs the meter could not all
read makes the reading complete: false, and a chooser treats that as no reading. Standard library only.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
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


def cli_cost(text: str):
    """The highest estimated cost anywhere in `blacksmith usage --format json` output; None when it has none. A total is
    never below its parts, so the highest found is the org's total."""
    try:
        stack, found = [json.loads(text)], []
    except ValueError:
        return None
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(node)
        for key, value in node.items() if isinstance(node, dict) else ():
            name = str(key).lower()
            if isinstance(value, (int, float)) and not isinstance(value, bool) and "cost" in name:
                found.append(float(value))
            else:
                stack.append(value)
    return max(found, default=None)


def cross_check(reading: dict, text) -> dict:
    """The higher of Blacksmith's estimated cost and the job records' floor. No cost read, from no token or output
    without one, makes the reading complete: false: no Blacksmith without Blacksmith's own count."""
    b = reading["blacksmith"]
    b["cli_cost"] = None if text is None else cli_cost(text)
    if b["cli_cost"] is None:
        reading["complete"] = False
        reading.setdefault("notes", []).append("no estimated cost from blacksmith usage; no Blacksmith until one is read")
    elif b["cli_cost"] > b["cost"]:
        b["cost"], b["left"] = round(b["cli_cost"], 2), round(max(b["stop"] - b["cli_cost"], 0), 2)
    return reading


def read_text(path):
    """The file's text; "" when it cannot be read, so cross_check notes it. None when no path was given."""
    if path is None:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def was_stopped(previous) -> bool:
    """Whether the last reading, the org variable's text, says the pool was stopped."""
    try:
        doc = json.loads(previous or "")
    except ValueError:
        return False
    return isinstance(doc, dict) and isinstance(doc.get("blacksmith"), dict) and doc["blacksmith"].get("stopped") is True


def blacksmith_groups(api, org: str) -> list:
    """The org's runner groups whose name starts with Blacksmith; Unreadable past one page."""
    path = f"/orgs/{org}/actions/runner-groups"
    doc = api.get(path, {"per_page": PAGE})
    groups = items_of(doc, "runner_groups", path)
    if doc.get("total_count", 0) > len(groups):
        raise Unreadable(f"GET {path}: more than {PAGE} runner groups")
    return [g for g in groups if str(g.get("name", "")).lower().startswith("blacksmith")]


def last_access(previous) -> dict:
    """The repo access the last stopped reading saved for each Blacksmith group: {group id: {visibility, repos}}."""
    try:
        saved = json.loads(previous or "")["blacksmith"]["access"]
    except (ValueError, KeyError, TypeError):
        return {}
    def whole(a) -> bool:
        """Whether a is a saved access this meter wrote."""
        return (isinstance(a, dict) and a.get("visibility") in ("all", "selected", "private") and isinstance(a.get("repos"), list)
                and all(isinstance(r, int) and not isinstance(r, bool) for r in a["repos"]))
    return {str(k): a for k, a in saved.items() if whole(a)} if isinstance(saved, dict) else {}


def group_access(api, org: str, group: dict):
    """The group's repo access now, or None when it is already closed to every repo, which is no earlier access."""
    visibility, repos = group.get("visibility"), []
    if visibility == "selected":
        path = f"/orgs/{org}/actions/runner-groups/{group['id']}/repositories"
        doc = api.get(path, {"per_page": PAGE})
        found = items_of(doc, "repositories", path)
        if doc.get("total_count", 0) > len(found):
            raise Unreadable(f"GET {path}: more than {PAGE} repos")
        repos = [r["id"] for r in found]
    if visibility not in ("all", "selected", "private") or (visibility == "selected" and not repos):
        return None
    return {"visibility": visibility, "repos": repos}


def save_access(api, org: str, groups: list, previous) -> dict:
    """Each group's repo access to put back on resume: the last stopped reading's, plus any group's now. Every read
    comes before any write, so a group that cannot be read leaves the rest open."""
    saved = last_access(previous)
    for g in groups:
        access = None if str(g["id"]) in saved else group_access(api, org, g)
        saved.update({str(g["id"]): access} if access else {})
    return {str(g["id"]): saved[str(g["id"])] for g in groups if str(g["id"]) in saved}


def set_groups(api, org: str, groups: list, stopped: bool, resume: bool, saved: dict) -> None:
    """Closes each group to all repos while stopped; on resume puts its saved access back, or opens it to all."""
    try:
        for g in groups:
            path = f"/orgs/{org}/actions/runner-groups/{g['id']}"
            before = saved.get(str(g["id"]), {"visibility": "all", "repos": []})
            if stopped:
                api.request("PATCH", path, body={"visibility": "selected"})
                api.request("PUT", path + "/repositories", body={"selected_repository_ids": []})
            elif resume:
                api.request("PATCH", path, body={"visibility": before["visibility"]})
                if before["visibility"] == "selected":
                    api.request("PUT", path + "/repositories", body={"selected_repository_ids": before["repos"]})
    except FileNotFoundError as err:
        raise Unreadable(f"runner group gone mid-pass: {err}") from None


def backstop(api, org: str, reading: dict, hard_stop: float, resume: bool, previous, publish=lambda: None) -> dict:
    """At the hard stop, saves each Blacksmith runner group's repo access once, closes the group to all repos, and closes
    it again each pass until resume. Resume puts each group's saved access back, and opens a group with none saved to
    all, unless the count is still at the hard stop. publish() writes the reading once the access is saved and before any
    group closes, so a failed write to a later group never loses a saved limit. Never GitHub's org-wide self-hosted switch."""
    b = reading["blacksmith"]
    b["hard_stop"] = hard_stop
    b["stopped"] = b["cost"] >= hard_stop or (was_stopped(previous) and not resume)
    groups = blacksmith_groups(api, org)
    if b["stopped"] and not groups:
        raise Unreadable(f"{org} is at its hard stop and has no runner group whose name starts with Blacksmith")
    saved = save_access(api, org, groups, previous) if b["stopped"] else last_access(previous)
    if b["stopped"]:
        b["access"] = saved
        publish()
    set_groups(api, org, groups, b["stopped"], resume, saved)
    b["groups"] = [g.get("name") for g in groups]
    return reading


def write_variable(api, org: str, value: str) -> None:
    """Stores the reading in the org variable CI_POOL, creating it the first time."""
    body = {"name": "CI_POOL", "value": value, "visibility": "all"}
    try:
        api.request("PATCH", f"/orgs/{org}/actions/variables/CI_POOL", body=body)
    except FileNotFoundError:
        api.request("POST", f"/orgs/{org}/actions/variables", body=body)


def save_ledger(path: str, ledger: dict) -> None:
    """Writes the ledger whole or not at all: a pass killed mid-write leaves the last good copy."""
    with open(path + ".tmp", "w", encoding="utf-8") as handle:
        json.dump(ledger, handle, separators=(",", ":"))
    os.replace(path + ".tmp", path)


def load_ledger(path: str) -> dict:
    """The saved ledger; empty when there is none or it cannot be read."""
    try:
        with open(path, encoding="utf-8") as handle:
            ledger = json.load(handle)
        return ledger if isinstance(ledger, dict) else {}
    except (OSError, ValueError):
        return {}


def run_meter(args, api, now: dt.datetime, clock=time.monotonic) -> dict:
    """One pass: the ledger saved as it goes and once more at the end, even when a read fails."""
    ledger = load_ledger(args.ledger)
    try:
        return meter(api, args.org, ledger, now, clock() + args.seconds, clock, lambda x: save_ledger(args.ledger, x))
    finally:
        save_ledger(args.ledger, ledger)


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
    parser = argparse.ArgumentParser(prog="ci_pool.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="mode", required=True)
    p = sub.add_parser("meter")
    p.add_argument("--org", required=True)
    p.add_argument("--ledger", required=True)
    p.add_argument("--seconds", type=int, default=900)
    p.add_argument("--cli-usage")
    p.add_argument("--hard-stop", type=float, default=HARD_STOP)
    p.add_argument("--resume", action="store_true")
    p.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", args.org):
        print(f"::error title=ci-pool usage::not an org name: {args.org!r}")
        return 2
    if not 0 < args.hard_stop <= CREDIT:
        print(f"::error title=ci-pool usage::--hard-stop must be over 0 and at most {CREDIT} dollars, not {args.hard_stop}")
        return 2
    try:
        api = Api(os.environ.get("GH_TOKEN", ""))
        reading = cross_check(run_meter(args, api, dt.datetime.now(dt.timezone.utc)), read_text(args.cli_usage))
        if args.write:
            backstop(api, args.org, reading, args.hard_stop, args.resume, os.environ.get("CI_POOL_PREVIOUS"),
                     lambda: write_variable(api, args.org, json.dumps(reading, separators=(",", ":"))))
        reading["api_calls"] = api.calls
        print(json.dumps(reading, indent=1))
        if args.write:
            write_variable(api, args.org, json.dumps(reading, separators=(",", ":")))
    except Unreadable as err:
        print(f"::warning title=ci-pool could not check::{err}; CI_POOL is left as it was, and goes stale")
        return 3
    b = reading["blacksmith"]
    with open(os.environ.get("GITHUB_STEP_SUMMARY") or os.devnull, "a", encoding="utf-8") as handle:
        handle.write(f"## CI pool\n\n| Cost $ | Stop $ | Left $ | Floor $ | Complete | Stopped |\n|---|---|---|---|---|---|\n"
                     f"| {b['cost']} | {b['stop']} | {b['left']} | {b['floor_cost']} | {reading['complete']} | "
                     f"{b.get('stopped', 'not checked')} |\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
