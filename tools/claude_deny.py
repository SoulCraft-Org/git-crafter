#!/usr/bin/env python3
"""claude_deny.py: the one-way-door deny list for ~/.claude/settings.json.

Canonical source: Git Crafter tools/claude_deny.py, with claude_deny.json and
claude_deny_model.py beside it; the installed copies live in ~/.claude/code-os/.

Claude Code's own permissions.deny rules replace the retired bash guard. A
deny rule blocks in every permission mode, bypassPermissions included
(code.claude.com/docs/en/permission-modes, read 2026-11-14), and Claude Code
evaluates it, so nothing here runs before a tool call. claude_deny.json holds
the rules, the retired guard rules each replaces, and commands each must
block and allow.

Fires or waits: the rules fire once they sit in ~/.claude/settings.json under
permissions.deny. claude_os_sync.py never edits settings.json, so after each
apply that changes the list:

  python3 -I ~/.claude/code-os/claude_deny.py --merge ~/.claude/settings.json --yes

  --self-test        every block example matches one of its own rule's
                     patterns, no allow example matches any pattern, each
                     retired guard rule is accounted for once, and the model
                     passes its own self-test.
  --check FILE       exit 0 when FILE's permissions.deny holds every rule,
                     else list the missing ones and exit 1. Read-only.
  --merge FILE       print what --yes would add. Read-only.
  --merge FILE --yes add the missing rules to the end of permissions.deny,
                     never removing or reordering one and keeping every other
                     key; it writes a temporary file and renames it into place.
  --table            the Markdown table of retired rules and what replaces each.

Exit 0 = ok, 1 = a check failed or rules are missing, 2 = usage or read error.
Requires Python 3.9, standard library only.
"""

import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:
    sys.path.append(HERE)  # python3 -I leaves this folder off sys.path
import claude_deny_model as model  # noqa: E402  # pyright: ignore[reportMissingImports]

DATA = os.path.join(HERE, "claude_deny.json")


def load(path=DATA):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def deny_list(data):
    """Every deny rule, in file order, each once."""
    out = []
    for rule in data["rules"]:
        out += [d for d in rule["deny"] if d not in out]
    return out


def rule_problems(rule, rules):
    """What is wrong with one rule: a malformed pattern, or an example that misbehaves."""
    out = []
    for d in rule["deny"]:
        m = model.RULE_RE.match(d)
        if not m:
            out.append("%r is not Bash(...) or Read(...)" % d)
        elif m.group(2).strip() in ("", "*"):
            out.append("%r would remove the whole tool" % d)
        elif m.group(1) == "Read":
            try:
                model.read_regex(m.group(2))
            except ValueError as e:
                out.append(str(e))
    for kind, block, allow in (("Bash", "blocks", "allows"), ("Read", "read_blocks", "read_allows")):
        out += ["no rule of its own blocks %r" % c for c in rule.get(block, [])
                if not any(model.matches(d, c, kind) for d in rule["deny"])]
        for c in rule.get(allow, []):
            hit = [d for d in rules if model.matches(d, c, kind)]
            out += ["%r should pass but %s blocks it" % (c, hit[0])] if hit else []
    if not (rule.get("blocks") or rule.get("read_blocks")) or not (rule.get("allows") or rule.get("read_allows")):
        out.append("needs a block and an allow example")
    return ["%s: %s" % (rule["id"], p) for p in out]


def self_test(data):
    rules = deny_list(data)
    problems = [p for rule in data["rules"] for p in rule_problems(rule, rules)]
    seen = {}
    for rule in data["rules"]:
        for rid in rule["replaces"]:
            seen.setdefault(rid, []).append(rule["id"])
    for u in data["uncovered"]:
        seen.setdefault(u["id"], []).append("uncovered")
        problems += [] if u.get("why") and u.get("now") else ["uncovered %s: needs why and now" % u["id"]]
    problems += ["%s is accounted for %d times, not once" % (rid, len(v)) for rid, v in seen.items() if len(v) != 1]
    problems += ["%s is no retired guard rule" % rid for rid in seen if rid not in data["retired"]]
    if len(rules) != sum(len(r["deny"]) for r in data["rules"]):
        problems.append("a deny rule is listed twice")
    for p in problems:
        print("FAIL " + p)
    print("claude_deny self-test: %d rules for %d retired guard rules, %s"
          % (len(rules), len(seen), "ok" if not problems else "%d problems" % len(problems)))
    return model.self_test() or (1 if problems else 0)


def read_settings(path):
    with open(path, encoding="utf-8") as f:
        settings = json.load(f)
    if not isinstance(settings, dict):
        raise ValueError("%s is not a JSON object" % path)
    return settings


def missing(settings, rules):
    have = set(settings.get("permissions", {}).get("deny", []))
    return [r for r in rules if r not in have]


def merge(path, rules, write):
    settings = read_settings(path)
    add = missing(settings, rules)
    for r in add:
        print("add " + r)
    if write and add:
        perms = settings.setdefault("permissions", {})
        perms["deny"] = list(perms.get("deny", [])) + add
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".settings-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
        os.chmod(tmp, os.stat(path).st_mode & 0o777)
        os.replace(tmp, path)
    print("%d of %d rules %s" % (len(add), len(rules), "added" if write else "to add (pass --yes to write)"))
    return 0


def table(data):
    print("| Retired guard rule | Now | Deny rules | Misses |\n|---|---|---|---|")
    for rule in data["rules"]:
        for rid in rule["replaces"]:
            print("| `%s` | `%s` | %d | %s |" % (rid, rule["id"], len(rule["deny"]), rule.get("gaps", "")))
    for u in data["uncovered"]:
        print("| `%s` | %s | 0 | %s |" % (u["id"], u["now"], u["why"]))
    return 0


def main(argv):
    try:
        data = load()
        if argv == ["--self-test"]:
            return self_test(data)
        if argv == ["--table"]:
            return table(data)
        if len(argv) == 2 and argv[0] == "--check":
            gone = missing(read_settings(os.path.expanduser(argv[1])), deny_list(data))
            print("".join("missing %s\n" % r for r in gone) + "%d deny rules missing from %s" % (len(gone), argv[1]))
            return 1 if gone else 0
        if argv[:1] == ["--merge"] and len(argv) in (2, 3) and argv[2:] in ([], ["--yes"]):
            return merge(os.path.expanduser(argv[1]), deny_list(data), argv[2:] == ["--yes"])
    except (OSError, ValueError, KeyError) as e:
        print("claude_deny: %s" % e, file=sys.stderr)
        return 2
    print("usage: claude_deny.py --self-test | --table | --check FILE | --merge FILE [--yes]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
