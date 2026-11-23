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

HERE = os.path.dirname(os.path.abspath(__file__))
# python3 -I leaves this folder off sys.path; the GitHub reads and writes sit beside this file, at the same pin.
sys.path.append(HERE)
from ci_pool_github import Unreadable, parse_time  # noqa: E402,F401

LABEL_RE = re.compile(r"blacksmith-(\d+)vcpu-(ubuntu|windows|macos)-\w+(-arm)?(;scheduling=flex)?")
# Weights against an x64 2-vCPU minute (docs.blacksmith.sh/blacksmith-runners/overview, read 2026-11-20).
ARM, MACOS = 0.625, {6: 20, 12: 40}


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
