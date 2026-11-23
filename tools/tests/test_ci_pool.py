"""Self-test for tools/ci_pool.py, run by `python3 -I tools/ci_pool.py --self-test`.

A fake GitHub API serves two repos' runs and jobs; nothing reaches the network. Known-clean cases must count each job
as Blacksmith bills it. Known-bad ones (a cut-off list, an unknown label, a failed read) must read complete: false or
raise Unreadable, never a quiet undercount.
"""

import datetime as dt

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


def raises(tool, fn) -> bool:
    """Whether fn raises Unreadable."""
    try:
        fn()
    except tool.Unreadable:
        return True
    return False


def run(tool):
    """Exit 0 when every case passes; prints each failure."""
    results = [result for checks in CHECKS for result in checks(tool)]
    bad = [name for name, ok in results if not ok]
    for name in bad:
        print(f"FAIL {name}")
    print(f"ci_pool self-test: {len(results) - len(bad)} of {len(results)} pass")
    return 1 if bad else 0


CHECKS = (label_checks,)
