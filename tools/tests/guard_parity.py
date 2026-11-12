#!/usr/bin/env python3
"""guard_parity.py: the bash guard's engine reads every known command the same
way at a base commit and at the head (issue #243).

The self-test checks block against allow only, so a refactor that dropped a
second hit, reordered two hits or turned a parse error into another error
would still pass it. This check runs every corpus case and every rule's block
and allow example through the base commit's engine and the head's, each with
the head's rules, from two folders, and fails on any difference in the
ordered list of rule ids or in the error class raised. The rules are the
head's on both sides, so a pull request that only changes rules or cases
passes; one that changes what the engine does fails, on purpose.
Only commands that also exist at the base compare: a command new at the
head is judged by the self-test, which checks its block or allow.

A pull request that changes a verdict on purpose lists each change in its
description, one line per command, naming its id and its new head verdict:

  guard-parity: case 12 -> git-force-push     (rule ids in order)
  guard-parity: case 40 -> none               (no rule hits)
  guard-parity: case 7 -> error ValueError    (an error class)

A listed difference passes; any other still fails, and so does a listed one
that did not happen, so the list stays honest.

It never runs a payload: each command only goes to the guard's evaluate,
which parses and never executes (rules/gates.md).

Commands:
  --base SHA [--expected TEXT]
                  compare SHA's engine with this checkout's; CI passes the pull
                  request's base and description (.github/workflows/guard-parity.yml)
  --dump DIR      internal: print DIR's engine verdicts as JSON
  --self-test     the comparison on seeded verdicts, and one dump

Requires Python 3.9, standard library only.
"""

import io
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
TOOLS = os.path.join(ROOT, "tools")
SHOWN = 20  # differences printed in full; the rest are counted
EXPECT = re.compile(r"^\s*guard-parity:\s*(\S.*?)\s*->\s*(\S.*?)\s*$", re.M)


def commands(tools=TOOLS):
    """Every corpus case, then every rule's block and allow examples, once
    each, as (id, command). The id (case 12, git-force-push block 0) names
    the command in a report, so a payload is never printed."""
    found = {}
    with open(os.path.join(tools, "bash_guard_cases.json"), encoding="utf-8") as fh:
        for k, (_, cmd) in enumerate(json.load(fh)["cases"]):
            found.setdefault(cmd, f"case {k}")
    with open(os.path.join(tools, "bash_guard_rules.json"), encoding="utf-8") as fh:
        for rule in json.load(fh)["rules"]:
            for kind in ("block", "allow"):
                for k, cmd in enumerate(rule.get(kind, [])):
                    found.setdefault(cmd, f"{rule['id']} {kind} {k}")
    return [(label, cmd) for cmd, label in found.items()]


def verdict(guard, cmd, rules, cwd):
    """[rule ids in order, error class or None] for one command."""
    try:
        return [[h[0] for h in guard.evaluate(cmd, rules, cwd)], None]
    except Exception as exc:  # the class is the verdict: ValueError fails open
        return [[], exc.__class__.__name__]


def dump(tools, rules_file, cmds):
    """The verdicts of tools' engine, with rules_file's rules and no local file
    or keys.toml, for each command with no folder and with the home folder."""
    sys.path.append(tools)
    import bash_guard as guard
    if hasattr(guard, "load_slow_modules"):
        guard.load_slow_modules()
    rules = guard.load_rules(rules_file, local=None)
    home = os.path.expanduser("~")
    return [verdict(guard, cmd, rules, cwd) for cmd in cmds for cwd in (None, home)]


def run_dump(tools, rules_file, cmds, scratch):
    """Start a dump of tools' engine in its own interpreter, so two engines
    never share a module. Returns the process; its stdout is the JSON."""
    path = os.path.join(scratch, f"cmds-{len(os.listdir(scratch))}.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(cmds, fh)
    env = {k: v for k, v in os.environ.items() if not k.startswith("BASH_GUARD_")}
    env["BASH_GUARD_LOG"] = os.devnull
    return subprocess.Popen(
        [sys.executable, "-I", os.path.realpath(__file__), "--dump", tools, rules_file, path],
        stdout=subprocess.PIPE, cwd=scratch, env=env, text=True)


def shared(labelled, base_labelled):
    """The (id, command) pairs of labelled whose command the base also lists,
    and how many were left out as new at the head."""
    known = {cmd for _, cmd in base_labelled}
    kept = [(label, cmd) for label, cmd in labelled if cmd in known]
    return kept, len(labelled) - len(kept)


def differences(ids, base, head):
    """[(id, folder, base verdict, head verdict)] wherever the two differ;
    ids holds one id per command."""
    if len(base) != len(head):
        raise ValueError(f"dumps differ in length: {len(base)} and {len(head)}")
    found = []
    for k, (b, h) in enumerate(zip(base, head)):
        if b != h:
            found.append((ids[k // 2], "home" if k % 2 else "none", b, h))
    return found


def expected(text):
    """{id: head verdict} from a pull request's guard-parity lines, or a
    ValueError naming a line that lists one id twice or no verdict."""
    found = {}
    for label, said in EXPECT.findall(text or ""):
        words = said.replace(",", " ").split()
        if words == ["none"]:
            want = [[], None]
        elif words[:1] == ["error"] and len(words) == 2:
            want = [[], words[1]]
        else:
            want = [words, None]
        if label in found:
            raise ValueError(f"{label} is listed twice")
        found[label] = want
    return found


def unexpected(diffs, wanted):
    """(differences not listed with their head verdict, listed ids with no
    such difference)."""
    left = [d for d in diffs if wanted.get(d[0]) != d[3]]
    seen = {d[0] for d in diffs if wanted.get(d[0]) == d[3]}
    return left, sorted(set(wanted) - seen)


def checkout_tools(sha, dest):
    """Extract sha's tools/ folder into dest; return its path."""
    tar = subprocess.run(["git", "-C", ROOT, "archive", "--format=tar", sha, "--", "tools"],
                         capture_output=True, check=True).stdout
    with tarfile.open(fileobj=io.BytesIO(tar)) as tf:
        if hasattr(tarfile, "data_filter"):
            tf.extractall(dest, filter="data")
        else:
            tf.extractall(dest)
    return os.path.join(dest, "tools")


def same_commit(sha):
    """True when sha is the checkout's HEAD, so nothing would be compared."""
    out = subprocess.run(["git", "-C", ROOT, "rev-parse", sha + "^{commit}", "HEAD"],
                         capture_output=True, text=True, check=True).stdout.split()
    return out[0] == out[1]


def compare(sha, text=""):
    """Exit status: 0 when sha's engine and the head's agree on every command
    that sha also lists, apart from the differences text lists. Fails when
    there is nothing to compare: no commands, or sha is HEAD."""
    try:
        wanted = expected(text)
    except ValueError as exc:
        print(f"guard parity: FAIL, the expected differences do not parse: {exc}")
        return 1
    if same_commit(sha):
        print(f"guard parity: FAIL, the base {sha[:12]} is HEAD, so nothing is compared")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        base_tools = checkout_tools(sha, os.path.join(tmp, "base"))
        labelled, new = shared(commands(), commands(base_tools))
        ids, cmds = [k for k, _ in labelled], [c for _, c in labelled]
        if not cmds:
            print("guard parity: FAIL, no commands to compare (corpus and examples empty)")
            return 1
        dumps = run_both(base_tools, cmds, tmp)
    if dumps is None:
        return 1
    base, head = dumps
    diffs = differences(ids, base, head)
    left, missing = unexpected(diffs, wanted)
    for label, cwd, b, h in left[:SHOWN]:
        print(f"  - {label}, cwd {cwd}\n      base {b}\n      head {h}")
    for label in missing:
        print(f"  - {label} is listed as expected, but its verdict did not change to {wanted[label]}")
    if left or missing:
        print(f"guard parity: FAIL, {len(left)} verdicts differ from {sha[:12]} unlisted, "
              f"{len(missing)} listed differences missing")
        return 1
    print(f"guard parity: ok ({len(cmds)} commands, {len(head) - len(diffs)} verdicts match {sha[:12]}, "
          f"{len(diffs)} differ as listed; {new} new at the head, left to the self-test)")
    return 0


def run_both(base_tools, cmds, tmp):
    """(base verdicts, head verdicts) for cmds, each engine with the head's
    rules, or None when a dump crashed. base_tools is the base's extracted
    tools folder; tmp holds the scratch folder."""
    rules_file = os.path.join(TOOLS, "bash_guard_rules.json")
    scratch = os.path.join(tmp, "run")
    os.makedirs(scratch)
    procs = [run_dump(t, rules_file, cmds, scratch) for t in (base_tools, TOOLS)]
    outs = [p.communicate()[0] for p in procs]
    if any(p.returncode for p in procs):
        print("guard parity: FAIL, a dump crashed (exit codes "
              f"{[p.returncode for p in procs]})")
        return None
    return tuple(json.loads(o) for o in outs)


def self_test():
    """Seeded verdicts: equal lists pass; a dropped hit, a reorder and a new
    error class each fail, named by id; a command new at the head is left
    out. Then one real dump of this checkout's engine."""
    failures = seeded_failures() + shared_failures() + expected_failures() + dump_failures()
    for f in failures:
        print("  -", f)
    print("guard parity self-test:", "FAIL" if failures else "ok")
    return 1 if failures else 0


def seeded_failures():
    """The comparison against seeded verdicts: what it got wrong."""
    failures = []
    ids = ["case 0", "case 1"]
    same = [[["x", "y"], None], [[], None], [[], "ValueError"], [["x"], None]]
    seeded = {
        "a dropped second hit": [[["x"], None]] + same[1:],
        "two hits reordered": [[["y", "x"], None]] + same[1:],
        "another error class": same[:2] + [[[], "TypeError"], same[3]],
    }
    if differences(ids, same, [list(v) for v in same]):
        failures.append("equal verdicts read as different")
    for label, head in seeded.items():
        got = differences(ids, same, head)
        if len(got) != 1 or got[0][0] not in ids:
            failures.append(f"{label} is not one difference named by its id")
    try:
        differences(ids, same, same[:3])
        failures.append("dumps of different lengths compare")
    except ValueError:
        pass
    return failures


def shared_failures():
    """A head-only command with a different verdict is no difference; a base
    command with a different verdict still is."""
    kept, new = shared([("case 0", "ls"), ("case 1", "new")], [("case 9", "ls")])
    base, head = [[[], None]] * 2, [[["x"], None]] * 2
    got = differences([k for k, _ in kept], base, head)
    if new != 1 or [k for k, _ in kept] != ["case 0"] or [g[0] for g in got] != ["case 0", "case 0"]:
        return [f"a head-only command is compared, or a base one is not (kept {kept}, got {got})"]
    return []


def expected_failures():
    """One case flips from a block to an allow: it passes with its line in the
    description and fails without it, with a wrong verdict or with a line for
    a case that did not change."""
    ids = ["case 0", "case 1"]
    base = [[["x"], None], [["x"], None], [[], None], [[], None]]
    head = [[[], None], [[], None]] + base[2:]
    diffs = differences(ids, base, head)
    runs = {
        "listed": ("Closes #1\nguard-parity: case 0 -> none\n", True),
        "not listed": ("Closes #1\n", False),
        "listed with another verdict": ("guard-parity: case 0 -> x\n", False),
        "listed with a case that held": ("guard-parity: case 0 -> none\nguard-parity: case 1 -> y\n", False),
    }
    failures = []
    for label, (text, ok) in runs.items():
        left, missing = unexpected(diffs, expected(text))
        if (not left and not missing) != ok:
            failures.append(f"a flipped case {label} {'fails' if ok else 'passes'}")
    if expected("guard-parity: a b block 0 -> r1, r2\nguard-parity: case 3 -> error ValueError") != \
            {"a b block 0": [["r1", "r2"], None], "case 3": [[], "ValueError"]}:
        failures.append("rule ids or an error class read wrong from a guard-parity line")
    try:
        expected("guard-parity: case 0 -> none\nguard-parity: case 0 -> x")
        failures.append("an id listed twice is accepted")
    except ValueError:
        pass
    return failures


def dump_failures():
    """One real dump of this checkout's engine on three probes: a block, an
    allow and a parse error. Payloads are only parsed."""
    with tempfile.TemporaryDirectory() as scratch:
        probe = ["git push --force origin main", "ls", "echo 'unbalanced"]
        proc = run_dump(TOOLS, os.path.join(TOOLS, "bash_guard_rules.json"), probe, scratch)
        got = json.loads(proc.communicate()[0] or "null")
    if not got or "git-force-push" not in got[0][0] or got[2] != [[], None] \
            or got[-1] != [[], "ValueError"]:
        return [f"a dump of this checkout reads the probes wrong (got {got})"]
    return []


def main(argv):
    """Route the command line; see the module docstring."""
    if argv[:1] == ["--dump"] and len(argv) == 4:
        with open(argv[3], encoding="utf-8") as fh:
            cmds = json.load(fh)
        json.dump(dump(argv[1], argv[2], cmds), sys.stdout)
        return 0
    if argv[:1] == ["--base"] and len(argv) == 2:
        return compare(argv[1])
    if argv[:1] == ["--base"] and len(argv) == 4 and argv[2] == "--expected":
        return compare(argv[1], argv[3])
    if argv == ["--self-test"]:
        return self_test()
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
