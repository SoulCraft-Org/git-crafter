#!/usr/bin/env python3
"""test_bash_guard.py: the bash guard's self-test, run by
`python3 -I tools/bash_guard.py --self-test` (tools/verify.sh, CI only).

The checks run in today's order, one group per function; the git, hook,
log and --status groups, and the relative-path one, live in
test_bash_guard_hook.py. It lives beside the guard in the Git Crafter checkout and is never installed:
manifest.json installs the guard's modules and rules, not its tests or the
corpus. The synthetic install for --status is built from manifest.json, so
a module the guard needs but the manifest leaves out fails here.

Every test payload goes to evaluate or a hook run of the guard, which parse
and never execute (rules/gates.md).
"""

import json
import os
import re
import shlex
import sys
import tempfile
import time

TOOLS = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
ROOT = os.path.dirname(TOOLS)
if TOOLS not in sys.path:
    sys.path.append(TOOLS)

from bash_guard_hook import FIX_NOTE, QUEUE_NOTE, block_message  # noqa: E402
from bash_guard_evaluate import evaluate  # noqa: E402
from bash_guard_paths import names_credential, pattern_segments  # noqa: E402
from bash_guard_program import program_of  # noqa: E402
from bash_guard_rules import (  # noqa: E402
    CASES_FILE, KEYS_FILE, PLAN_FILE, RULES_FILE, load_rules, registry_vars)
from bash_guard_scan import Scan  # noqa: E402
from bash_guard_slow import load_slow_modules  # noqa: E402
from bash_guard_words import space_redirects, strip_redirects, tokenize  # noqa: E402

TESTS = os.path.dirname(os.path.realpath(__file__))
if TESTS not in sys.path:
    sys.path.append(TESTS)

import test_bash_guard_hook as hook_tests  # noqa: E402

NEVER_METADATA = {"cat", "head", "tail", "less", "more", "grep", "rg", "sed", "awk",
                  "cp", "base64", "xxd", "dd", "sort", "cut", "open", "source", "."}


def plan_paths(path=None):
    """The credential paths PLAN.md lists, or None when it cannot be read.

    Reads the bullets under "**Credential paths", drops parentheticals (they
    name paths that stay readable), and keeps each backticked ~/ or // path.
    """
    try:
        with open(path or PLAN_FILE, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    bullets = credential_bullets(lines)
    if bullets is None:
        return None
    found = []
    for b in bullets:
        b = re.sub(r"\([^()]*\)", "", b)
        found += re.findall(r"`((?:~/|//)[^`]+)`", b)
    return found or None


def credential_bullets(lines):
    """The bullets under the "**Credential paths" heading, each with its
    wrapped lines joined, or None when there is no heading."""
    start = next((k for k, line in enumerate(lines)
                  if line.startswith("**Credential paths")), None)
    if start is None:
        return None
    body = lines[start + 1:]
    while body and not body[0].strip():
        body = body[1:]  # blank lines between the heading and its list
    return bullet_lines(body)


def bullet_lines(body):
    """The leading "- " bullets of body, a wrapped line joined to its bullet."""
    bullets = []
    for line in body:
        if line.startswith("- "):
            bullets.append(line[2:])
        elif line.startswith(" ") and line.strip() and bullets:
            bullets[-1] += " " + line.strip()
        else:
            break
    return bullets


class Checks:
    """The self-test's state: the failures so far, the rules with the
    owner's local file, and the template alone."""

    def __init__(self):
        self.failures = []
        # Each rule's own examples run against the template plus the owner's local
        # file, when there is one; the corpus runs against the template alone, so
        # every owner's checkout and CI agree on it.
        self.rules = load_rules()
        self.template = load_rules(local=None)

    def check(self, cond, label):
        """Record label as a failure unless cond holds."""
        if not cond:
            self.failures.append(label)

    def ids(self, cmd, cwd=None, rs=None):
        """The ids of the rules cmd breaks, against rs or the rules."""
        return [h[0] for h in evaluate(cmd, rs or self.rules, cwd=cwd)]


def self_test():
    """Every check group in order; 0 when all pass, else 1 with the list."""
    load_slow_modules()
    t = Checks()
    rule_examples(t)
    cases = corpus_cases(t)
    local_rules_file(t)
    engine_scenarios(t)
    reason_and_subfolder(t)
    path_rules(t)
    plan_paths_parser(t)
    key_var_conditions(t)
    key_registry(t)
    hook_tests.relative_paths(t)
    have_git = hook_tests.git_scenarios(t)
    hook_tests.hook_protocol(t)
    hook_tests.block_log(t)
    hook_tests.status_checks(t, have_git)
    return report(t, cases)


def report(t, cases):
    """Print the result line, or each failure; 0 when none failed."""
    rules = t.rules
    total = sum(len(r.get("block", [])) + len(r.get("allow", [])) for r in rules)
    if t.failures:
        print(f"bash_guard self-test: FAIL ({len(t.failures)} checks)")
        for f in t.failures:
            print("  -", f)
        return 1
    print(f"bash_guard self-test: ok ({len(rules)} rules, {total} seeded examples, "
          f"{cases} corpus cases)")
    return 0


def rule_examples(t):
    """Rule ids are unique; each rule has a why, a fix, and block and allow
    examples that behave."""
    check, ids, rules = t.check, t.ids, t.rules
    all_ids = [r["id"] for r in rules]
    check(len(all_ids) == len(set(all_ids)), "rule ids are unique")
    for r in rules:
        check(bool(r.get("why")), f"{r['id']}: has a why")
        check(bool(r.get("fix")), f"{r['id']}: names a fix")
        check(len(r.get("block", [])) >= 1, f"{r['id']}: seeds a block example")
        check(len(r.get("allow", [])) >= 1, f"{r['id']}: seeds an allow example")
        for cmd in r.get("block", []):
            got = ids(cmd)
            check(r["id"] in got, f"{r['id']}: blocks {cmd!r} (got {got})")
        for cmd in r.get("allow", []):
            got = ids(cmd)
            check(got == [], f"{r['id']}: allows {cmd!r} (got {got})")


def corpus_cases(t):
    """The corpus, against the template alone; returns how many cases it holds."""
    check, ids, template = t.check, t.ids, t.template
    with open(CASES_FILE, encoding="utf-8") as fh:
        corpus = json.load(fh)["cases"]
    for expect, cmd in corpus:
        try:
            got = ids(cmd, rs=template)
        except ValueError:
            got = []  # the hook fails open on a parse error, so a block case must find a hit
        check(bool(got) == (expect == "block"), f"corpus: want {expect} for {cmd!r} (got {got})")
    return len(corpus)


def local_rules_file(t):
    """The owner's local rules file: merged when well formed, ignored when not."""
    check, rules, template = t.check, t.rules, t.template
    with tempfile.TemporaryDirectory() as tmp:
        good, bad = os.path.join(tmp, "good.json"), os.path.join(tmp, "bad.json")
        with open(good, "w", encoding="utf-8") as fh:
            json.dump({"rules": [{"id": "zz-local", "why": "w", "fix": "f",
                                  "match": {"program": "zzlocal"}, "when_any": [{"always": True}],
                                  "block": ["zzlocal"], "allow": ["ls"]}],
                       "key_vars": {"names": ["ZZ_LOCAL_SECRET_NAME"]}}, fh)
        with open(bad, "w", encoding="utf-8") as fh:
            fh.write("{not json")
        merged = load_rules(local=good)
        check([h[0] for h in evaluate("zzlocal", merged)] == ["zz-local"],
              "a local rules file adds its rules")
        check(bool(evaluate("export ZZ_LOCAL_SECRET_NAME=x", merged)),
              "a local rules file adds its key variable names")
        with open(good, "w", encoding="utf-8") as fh:
            json.dump({"rules": [{"id": "zz-local-path", "kind": "path", "why": "w", "fix": "f",
                                  "paths": ["~/.zz-local-secret"], "block": ["cat ~/.zz-local-secret"],
                                  "allow": ["ls ~/.zz-local-secret"]}]}, fh)
        check([h[0] for h in evaluate("cat ~/.zz-local-secret", load_rules(local=good))] == ["zz-local-path"],
              "a local rules file adds a path rule")
        check([r["id"] for r in load_rules(local=bad)] == [r["id"] for r in template],
              "a broken local rules file leaves the template alone")
        for n, broken in enumerate([
                {"rules": {"id": "x"}},
                {"rules": [{"id": "x", "why": "w", "match": {"program": "git"},
                            "when_any": [{"joined_regex": "(unclosed"}]}]},
                {"rules": [{"id": "x", "why": "w", "kind": "path", "paths": "~/.x"}]},
                {"rules": [], "key_vars": {"names": "HF_TOKEN"}},
                {"rules": [], "key_vars": {"patterns": ["(bad"]}},
                {"rules": [{"id": "x", "why": "w", "match": {"program": "git"},
                            "when_any": [{"flag_value_not": {"flag": "--force", "regex": "["}}]}]}]):
            with open(bad, "w", encoding="utf-8") as fh:
                json.dump(broken, fh)
            got = [h[0] for h in evaluate("git push --force origin main", load_rules(local=bad))]
            check("git-force-push" in got, f"malformed local file {n}: git push --force origin main still blocks")


def engine_scenarios(t):
    """Engine scenarios: parse errors, comments, redirections, --help, the
    long decoy, and block messages."""
    check, ids, rules = t.check, t.ids, t.rules
    check(ids("") == [], "empty command allowed")
    try:
        evaluate("echo 'unbalanced", rules)
        check(False, "unbalanced quotes raise ValueError, so the hook fails open")
    except ValueError:
        pass
    check(ids("echo ok # git push -f") == [], "comments are ignored")
    check(space_redirects("cmd>out") == "cmd > out", "a glued redirection ends the word")
    check(space_redirects("cmd 2>out") == "cmd  2> out",
          "the file descriptor stays with the operator")
    for quoted in ("echo 'a>b'", 'echo "a>b"', "echo a\\>b"):
        check(space_redirects(quoted) == quoted,
              f"a quoted or escaped redirection is left alone: {quoted!r}")
    check(ids("git push --help") == [], "a help call alone is allowed")
    # A long decoy stays fast against the hook's timeout: s and an unclosed
    # delimiter, 38,000 times; pass 2's letter-delimiter scan is near linear.
    # Under 2 s: holding the long quoted word out of shlex took it from 1.1 s to 0.05 s here (issue 329).
    decoy = "perl -e " + shlex.quote("".join(f"s {chr(0x4E00 + i % 20000)}a" for i in range(38000)))
    start = time.perf_counter()
    got, took = ids(decoy), time.perf_counter() - start
    check(not got and took < 2, f"a {len(decoy) // 1024} KB decoy: want allow in under 2 s (got {got} in {took:.2f} s)")
    check(ids("git push origin feat/x > main") == [], "a redirect target is not a refspec")
    msg = block_message([("a", "why a.", "do x."), ("b", "why b.", None)])
    check(QUEUE_NOTE in msg, "a block with no fix tells the agent to queue it")
    msg = block_message([("a", "why a.", "do x.")])
    check(FIX_NOTE in msg and QUEUE_NOTE not in msg, "a block with a fix names the fix")


def reason_and_subfolder(t):
    """An empty ONE_WAY_REASON gives no reason, and gh's second reading keeps
    the assignment (issue 708); node --test runs one sub-folder two deep
    locally, never a top-level one (issue 618)."""
    check, ids = t.check, t.ids
    for cmd in ("ONE_WAY_REASON= gh repo delete o/r --yes",
                "ONE_WAY_REASON='' gh repo delete o/r --yes",
                "ONE_WAY_REASON=' ' gh repo delete o/r --yes",
                'ONE_WAY_REASON=" " gh api -X DELETE repos/o/r/git/refs/heads/x',
                "ONE_WAY_REASON= gh api -X DELETE repos/o/r/git/refs/heads/x"):
        check("gh-repo-one-way" in ids(cmd), f"an empty or blank reason blocks: {cmd!r}")
    for cmd in ('ONE_WAY_REASON="why" gh api -X DELETE repos/o/r/git/refs/heads/x',
                'ONE_WAY_REASON="why" gh api repos/o/r/git/refs/heads/x -X DELETE',
                'ONE_WAY_REASON="why" gh -R o/r repo delete --yes'):
        check(ids(cmd) == [], f"a reason passes in either order: {cmd!r}")
    check(program_of(["X=", "gh", "repo"], set())["assigns"] == ["X="],
          "an empty assignment is still an assignment")
    for cmd in ("node --test quality/render/", "node --test quality/collectors/site"):
        check(ids(cmd) == [], f"one sub-folder runs locally: {cmd!r}")
    for cmd in ("node --test quality/", "node --test tests/", "node --test ./quality/",
                "node --test quality/../tests/", "node --test quality/render/ tests/",
                "npx vitest run quality/render/"):
        check("local-test-suite" in ids(cmd), f"a top-level folder or a second one blocks: {cmd!r}")


def path_rules(t):
    """Path rules: every pattern compiles, the metadata list stays honest,
    and each rule holds every PLAN.md credential path."""
    check, rules = t.check, t.rules
    for r in rules:
        if r.get("kind") == "path":
            for p in r.get("paths", []):
                check(pattern_segments(p) is not None, f"{r['id']}: pattern {p!r} compiles")
    for r in rules:
        if r.get("kind") != "path":
            continue
        metadata_checks(t, r)
        plan_parity(t, r)


def metadata_checks(t, r):
    """No reader is on a path rule's metadata list, the list stays short, and
    each program on it has an allow seed on a credential path."""
    check = t.check
    meta = set(r.get("metadata", []))
    pats = [p for p in map(pattern_segments, r["paths"]) if p]
    check(not meta & NEVER_METADATA,
          f"{r['id']}: no reader is on the metadata list ({sorted(meta & NEVER_METADATA)})")
    check(len(meta) <= 15, f"{r['id']}: the metadata list stays short")
    exercised = metadata_exercised(r, meta, pats)
    check(meta <= exercised, f"{r['id']}: every metadata program has an allow seed "
          f"on a credential path (missing {sorted(meta - exercised)})")


def metadata_exercised(r, meta, pats):
    """The metadata programs a rule's allow examples run on a credential path."""
    exercised = set()
    for cmd in r.get("allow", []):
        for stages in tokenize(Scan(cmd).run()):
            for raw in stages:
                c = program_of(strip_redirects(raw), set())
                if c["prog"] in meta and any(names_credential(a, None, pats)
                                             for a in c["args"]):
                    exercised.add(c["prog"])
    return exercised


def plan_parity(t, r):
    """A path rule holds every credential path PLAN.md lists, when it reads."""
    check = t.check
    plan = plan_paths()
    if plan is None:
        print(f"bash_guard self-test: no credential list read from {PLAN_FILE or 'BASH_GUARD_PLAN (unset)'}; "
              "path parity skipped")
    else:
        missing = sorted(set(plan) - set(r["paths"]))
        check(not missing, f"{r['id']}: holds every PLAN.md credential path "
              f"(missing {missing})")
        ahead = sorted(set(r["paths"]) - set(plan))
        if ahead:
            print(f"bash_guard self-test: note, {r['id']} is ahead of PLAN.md: {ahead}")


def plan_paths_parser(t):
    """plan_paths keeps listed paths and fails open."""
    check = t.check
    with tempfile.TemporaryDirectory() as tmp:
        sample = os.path.join(tmp, "PLAN.md")
        with open(sample, "w", encoding="utf-8") as fh:
            fh.write("intro `~/.not-this`\n**Credential paths (canonical):**\n\n"
                     "- A: `~/.a/**`, `//**/.env`. (`~/.keep` stays readable,\n"
                     "  `~/.also-keep` too.)\n- B: `~/.b`.\n\nWhy: `~/.c`\n")
        check(plan_paths(sample) == ["~/.a/**", "//**/.env", "~/.b"],
              "plan_paths keeps listed paths and drops parentheticals and other text")
        with open(sample, "w", encoding="utf-8") as fh:
            fh.write("No heading here: `~/.a`\n")
        check(plan_paths(sample) is None, "plan_paths with no heading reads as not found")
        check(plan_paths(os.path.join(tmp, "absent.md")) is None,
              "plan_paths fails open on a missing file")


def key_var_conditions(t):
    """Each key_var condition has a known mode and the names from load_rules."""
    check, rules = t.check, t.rules
    for r in rules:
        for key in ("when_any", "when_all", "unless_any"):
            for c in r.get(key, []):
                if "key_var" in c:
                    check(c["key_var"] in ("expanded", "named", "assigned", "env"),
                          f"{r['id']}: key_var {c['key_var']!r} is a known mode")
                    check(bool(c.get("_key_vars")),
                          f"{r['id']}: load_rules gave its key_var condition the names")


def key_registry(t):
    """keys.toml: the rules file's names hold every variable it lists, and a
    name only it lists blocks."""
    check = t.check
    with open(RULES_FILE, encoding="utf-8") as fh:
        kv = json.load(fh).get("key_vars") or {}
    registry = registry_vars()
    if registry is None:
        print(f"bash_guard self-test: no variables read from {KEYS_FILE or 'BASH_GUARD_KEYS (unset)'}; "
              "key name parity skipped")
    else:
        pats = [re.compile(p) for p in kv.get("patterns", [])]
        missing = sorted(n for n in set(registry) if n not in kv.get("names", [])
                         and not any(p.search(n) for p in pats))
        check(not missing, f"key_vars holds every keys.toml variable (missing {missing})")
    with tempfile.TemporaryDirectory() as tmp:
        sample, absent = os.path.join(tmp, "keys.toml"), os.path.join(tmp, "absent.toml")
        with open(sample, "w", encoding="utf-8") as fh:
            fh.write("# var = \"NOT_A_COMMENT\"\n[[var]]\nname = \"API-Key-X\"\n"
                     "var = \"ZZ_REGISTRY_ONLY\"\naliases = ['ZZ_ALIAS_ONE', \"ZZ_ALIAS_TWO\"]\n"
                     "[[var]]\nname = \"API-Key-Y\"\nvar = \"ZZ_PUBLIC_ID\"\n"
                     "format = \"public\"\npublic = \"local:x\"\n"
                     "[[never]]\nname = \"x\"\nabout = \"var = 'NOT_THIS'\"\n")
        check(registry_vars(sample) == ["ZZ_REGISTRY_ONLY", "ZZ_ALIAS_ONE", "ZZ_ALIAS_TWO"],
              "registry_vars reads each var and alias, and leaves out a public row")
        check(evaluate("echo $ZZ_PUBLIC_ID", load_rules(keys=sample)) == [],
              "a public row's variable is an id, not a key, so printing it is allowed")
        check(registry_vars(absent) is None, "registry_vars fails open on a missing file")
        with_registry, without = load_rules(keys=sample), load_rules(keys=absent)
        for cmd in ("echo $ZZ_REGISTRY_ONLY", "ZZ_ALIAS_TWO=x python3 a.py"):
            check(bool(evaluate(cmd, with_registry)),
                  f"a name only keys.toml lists blocks: {cmd!r}")
            check(evaluate(cmd, without) == [],
                  f"with no keys.toml the same name is allowed: {cmd!r}")
