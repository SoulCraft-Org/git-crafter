#!/usr/bin/env python3
"""claude_deny.py: the one-way-door deny list for ~/.claude/settings.json.

Canonical source: Git Crafter tools/claude_deny.py, with claude_deny.json and
claude_deny_model.py beside it; the installed copies live in ~/.claude/code-os/.

Claude Code's own permissions.deny rules replace the retired bash guard. A
deny rule blocks in every permission mode, bypassPermissions included
(code.claude.com/docs/en/permission-modes, read 2026-11-14), and Claude Code
evaluates it, so nothing here runs before a tool call. claude_deny.json holds
the rules, the retired guard rules each replaces, and commands each must
block and allow. COMMANDS lists what this file runs; --self-test checks that
every block example matches one of its own rule's patterns, no allow example
matches any pattern, each retired guard rule is accounted for once, and the
model passes its own self-test.

Exit 0 = ok, 1 = a check failed or rules are missing, 2 = usage or read error.
Requires Python 3.9, standard library only.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:
    sys.path.append(HERE)  # python3 -I leaves this folder off sys.path
import claude_deny_model as model  # noqa: E402  # pyright: ignore[reportMissingImports]

DATA = os.path.join(HERE, "claude_deny.json")


def load(path=DATA):
    """The deny list data."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def deny_list(data):
    """Every deny rule, in file order, each once."""
    out = []
    for rule in data["rules"]:
        out += [d for d in rule["deny"] if d not in out]
    return out


def pattern_problem(d):
    """What is wrong with one deny pattern, or None."""
    m = model.RULE_RE.match(d)
    if not m:
        return "%r is not Bash(...) or Read(...)" % d
    if m.group(2).strip() in ("", "*"):
        return "%r would remove the whole tool" % d
    if m.group(1) == "Read":
        try:
            model.read_regex(m.group(2))
        except ValueError as e:
            return str(e)
    return None


EXAMPLE_KEYS = (("Bash", "blocks", "allows"), ("Read", "read_blocks", "read_allows"))


def _misses(rule, kind, key):
    """The block examples no pattern of the rule's own matches."""
    return ["no rule of its own blocks %r" % c for c in rule.get(key, [])
            if not any(model.matches(d, c, kind) for d in rule["deny"])]


def _false_hits(rules, examples, kind):
    """The allow examples some pattern in the whole list matches, each with the first that does."""
    out = []
    for c in examples:
        hit = [d for d in rules if model.matches(d, c, kind)]
        out += ["%r should pass but %s blocks it" % (c, hit[0])] if hit else []
    return out


def example_problems(rule, rules):
    """The block examples no pattern of the rule's own matches, and the allow examples any pattern does."""
    out = []
    for kind, block, allow in EXAMPLE_KEYS:
        out += _misses(rule, kind, block) + _false_hits(rules, rule.get(allow, []), kind)
    has = lambda keys: any(rule.get(k) for k in keys)  # noqa: E731
    return out + ([] if has(("blocks", "read_blocks")) and has(("allows", "read_allows")) else ["needs a block and an allow example"])


def rule_problems(rule, rules):
    """What is wrong with one rule: a malformed pattern, or an example that misbehaves."""
    out = [p for p in map(pattern_problem, rule["deny"]) if p] + example_problems(rule, rules)
    return ["%s: %s" % (rule["id"], p) for p in out]


def _accounted(data):
    """Each retired id the data names, with the rules (or "uncovered") that name it."""
    seen = {}
    for rule in data["rules"]:
        for rid in rule["replaces"]:
            seen.setdefault(rid, []).append(rule["id"])
    for u in data["uncovered"]:
        seen.setdefault(u["id"], []).append("uncovered")
    return seen


def accounting_problems(data):
    """Each retired guard rule must be replaced, or named uncovered, exactly once."""
    seen = _accounted(data)
    problems = ["uncovered %s: needs why and now" % u["id"] for u in data["uncovered"] if not (u.get("why") and u.get("now"))]
    problems += ["%s is accounted for %d times, not once" % (rid, len(v)) for rid, v in seen.items() if len(v) != 1]
    problems += ["%s is no retired guard rule" % rid for rid in seen if rid not in data["retired"]]
    return problems, len(seen)


def self_test(data):
    """Run every rule's examples, the accounting and the model's own test; 0 when all pass."""
    rules = deny_list(data)
    problems = [p for rule in data["rules"] for p in rule_problems(rule, rules)]
    accounting, accounted = accounting_problems(data)
    problems += accounting
    if len(rules) != sum(len(r["deny"]) for r in data["rules"]):
        problems.append("a deny rule is listed twice")
    for p in problems:
        print("FAIL " + p)
    print("claude_deny self-test: %d rules for %d retired guard rules, %s"
          % (len(rules), accounted, "ok" if not problems else "%d problems" % len(problems)))
    return model.self_test() or (1 if problems else 0)


COMMANDS = {("--self-test",): self_test}


def main(argv):
    """Run one command; 2 on a usage or read error."""
    takes_file = {k[0] for k in COMMANDS if "FILE" in k}
    shape = tuple("FILE" if i == 1 and argv[0] in takes_file else a for i, a in enumerate(argv))
    if shape not in COMMANDS:
        print("usage: claude_deny.py " + " | ".join(" ".join(k) for k in COMMANDS), file=sys.stderr)
        return 2
    try:
        return COMMANDS[shape](load(), *argv[1:2])
    except (OSError, ValueError, KeyError) as e:
        print("claude_deny: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
