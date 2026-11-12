#!/usr/bin/env python3
"""shell_selftests.py: run each shell tool's --self-test, for tools/verify.sh.

verify.sh calls only python3 and node, one command per line, so its own test
(tests/verify.test.mjs) can stand in for both. The shell tools' self-tests run
here. Exit 0 when every one passes, 1 at the first that fails, 3 when bash is
missing. Standard library only.
"""
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = ["tools/deploy_gate.sh"]


def main():
    """Run each self-test in order; stop at the first failure."""
    bash = shutil.which("bash")
    if not bash:
        print("shell self-tests: could not check, no bash", file=sys.stderr)
        return 3
    for tool in TOOLS:
        if subprocess.run([bash, os.path.join(ROOT, tool), "--self-test"], cwd=ROOT).returncode != 0:
            print("shell self-tests: %s failed" % tool, file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
