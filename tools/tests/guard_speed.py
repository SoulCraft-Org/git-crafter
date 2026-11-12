"""Time the bash guard on its own corpus, as a session's hook call costs it.

tools/verify.sh runs this right after the guard's self-test, so the reading
comes from the CI runner (a cloud-class machine) with no extra job. Each call
is a fresh python3 -I tools/bash_guard.py --check CMD, as a hook call is a
fresh process: start-up, imports and one verdict. --check parses the command
and never runs it (rules/gates.md).

It prints one line that config/quality/collectors/guard-speed.mjs reads from
the job log (guards.runner_call_ms):

  == guard speed: median 312 ms, p95 401 ms, 40 calls of bash_guard.py --check

A slow reading is a metric, not a failure: the script exits 1 only when the
guard itself errors (an exit other than 0 allowed or 2 blocked).
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
GUARD = os.path.join(os.path.dirname(HERE), "bash_guard.py")
CASES = os.path.join(os.path.dirname(HERE), "bash_guard_cases.json")
CALLS = 40


def sample(cases, n):
    """n commands spread evenly across the corpus, first and last included."""
    if len(cases) <= n:
        return [c for _, c in cases]
    step = (len(cases) - 1) / (n - 1)
    return [cases[round(i * step)][1] for i in range(n)]


def percentile(sorted_ms, p):
    """Nearest-rank percentile of an ascending list."""
    k = max(1, -(-p * len(sorted_ms) // 100))  # ceil(p * n / 100), at least the first
    return sorted_ms[int(k) - 1]


def median(sorted_ms):
    """The middle value, or the mean of the two middle values."""
    n = len(sorted_ms)
    return (sorted_ms[(n - 1) // 2] + sorted_ms[n // 2]) / 2


def main():
    with open(CASES, encoding="utf-8") as fh:
        commands = sample(json.load(fh)["cases"], CALLS)
    times = []
    for cmd in commands:
        start = time.perf_counter()
        r = subprocess.run([sys.executable, "-I", GUARD, "--check", cmd], capture_output=True, text=True, check=False)
        times.append((time.perf_counter() - start) * 1000)
        if r.returncode not in (0, 2):
            print(f"guard speed: the guard exited {r.returncode} on a corpus case: {r.stderr.strip()[:200]}")
            return 1
    times.sort()
    print(f"== guard speed: median {median(times):.0f} ms, p95 {percentile(times, 95):.0f} ms, "
          f"{len(times)} calls of bash_guard.py --check")
    return 0


if __name__ == "__main__":
    sys.exit(main())
