#!/usr/bin/env python3
"""claude_deny.py: the one-way-door deny list for ~/.claude/settings.json.

Canonical source: Git Crafter tools/claude_deny.py, with claude_deny.json and
claude_deny_model.py beside it; the installed copies live in ~/.claude/code-os/.

Claude Code's own permissions.deny rules replace the retired bash guard. A
deny rule blocks in every permission mode, bypassPermissions included
(code.claude.com/docs/en/permission-modes, read 2026-11-14), and Claude Code
evaluates it, so nothing here runs before a tool call. claude_deny.json holds
the rules, the retired guard rules each replaces, and commands each must
block and allow, and the deny rules it has dropped. COMMANDS lists what this
file runs; --self-test checks that every block example matches one of its own
rule's patterns, no allow example matches any pattern, each retired guard rule
is accounted for once, no dropped rule is still listed, a stale settings file
loses only its dropped rules, and the model passes its own self-test.

An account's own rules go in claude_deny.local.json beside this file (the account
overlay's code-os/claude_deny.local.json). It has the same shape; every command
here reads it, so --self-test checks its examples and accounting and --merge
installs its rules. Git Crafter's CI has no such file and tests only its own list.

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
# One account's own rules, installed beside this file from its overlay folder
# (code-os/claude_deny.local.json). Same shape as claude_deny.json; its rules,
# retired ids, uncovered entries and dropped rules are added after Git Crafter's own.
LOCAL = os.path.join(HERE, "claude_deny.local.json")


def _read(path):
    """One deny list file as a JSON object."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def merge_local(data, local):
    """data with a local file's rules, retired ids, uncovered entries and dropped rules added after its own."""
    if not isinstance(local, dict):
        raise ValueError("the local deny list is not a JSON object")
    out = dict(data)
    for key in ("rules", "retired", "uncovered", "dropped"):
        out[key] = list(data.get(key, [])) + list(local.get(key, []))
    return out


def load(path=DATA, local=LOCAL):
    """The deny list data, with the account's local file merged in when one sits beside it."""
    data = _read(path)
    return merge_local(data, _read(local)) if os.path.exists(local) else data


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
    problems += ["retired %s is accounted for nowhere" % rid for rid in data["retired"] if rid not in seen]
    return problems, len(seen)


def merge_problems():
    """Check merge_local on a one-rule list: the local rule lands after the shared ones, and a bad shape is refused."""
    shared = {"rules": [{"id": "a"}], "retired": ["r1"], "uncovered": []}
    got = merge_local(shared, {"rules": [{"id": "b"}], "retired": ["r2"]})
    out = [] if [r["id"] for r in got["rules"]] == ["a", "b"] and got["retired"] == ["r1", "r2"] and got["uncovered"] == [] \
        else ["merge_local does not append the local rules and retired ids"]
    out += [] if shared == {"rules": [{"id": "a"}], "retired": ["r1"], "uncovered": []} else ["merge_local changed its input"]
    try:
        merge_local(shared, [])
        out.append("merge_local accepted a local list that is not an object")
    except ValueError:
        pass  # expected: merge_local refuses a list that is not an object, which is the pass case
    return out


def duplicate_problems(data, rules):
    """A deny rule listed twice, or a rule id used twice."""
    out = ["a deny rule is listed twice"] if len(rules) != sum(len(r["deny"]) for r in data["rules"]) else []
    ids = [r["id"] for r in data["rules"]]
    return out + ["rule id %s is used twice" % i for i in sorted(set(ids)) if ids.count(i) > 1]


def dropped(data):
    """The deny rules the list has dropped, each once; a rule it still lists is never one."""
    rules = set(deny_list(data))
    out = []
    for d in data.get("dropped", []):
        deny = d.get("deny") if isinstance(d, dict) else None
        out += [deny] if isinstance(deny, str) and deny and deny not in out and deny not in rules else []
    return out


def entry_problems(d, rules):
    """One dropped entry with no deny, by or why, a malformed pattern, still listed, or whose unblocks example is still blocked."""
    if not (isinstance(d, dict) and isinstance(d.get("deny"), str)):
        return ["dropped entry %r: needs an object with a deny string" % (d,)]
    deny, unblocks = d["deny"], d.get("unblocks")
    out = [] if d.get("by") and d.get("why") else ["dropped %r: needs by and why" % deny]
    out += list(filter(None, [pattern_problem(deny)]))  # an empty deny fails here
    out += ["dropped %s is still a deny rule" % deny] if deny in rules else []
    return out + ["dropped %s: %s" % (deny, p) for p in _false_hits(rules, [unblocks] if isinstance(unblocks, str) else [], "Bash")]


def dropped_problems(data, rules):
    """Every dropped entry's problems."""
    return [p for d in data.get("dropped", []) for p in entry_problems(d, rules)]


STALE = "Bash(gh pr merge *--auto*)"  # #586 dropped it; #654 found settings files that kept it
OWN = "Bash(my-own-rule *)"


def stale_problems(data, rules):
    """The #654 regression: a settings file synced before #586 fails --check, and --merge --yes removes only the dropped rule."""
    import contextlib
    import io
    import tempfile
    out = [] if STALE in dropped(data) else ["%s is not in the dropped list" % STALE]
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "settings.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"model": "x", "permissions": {"allow": ["Bash(ls)"], "deny": rules + [STALE, OWN]}}, f)
        with contextlib.redirect_stdout(io.StringIO()):
            before, _, after = check(path, data), merge(path, data, True), check(path, data)
        got = read_settings(path)
    out += [] if before == 1 else ["--check passes a settings file that still holds %s" % STALE]
    out += [] if after == 0 else ["--check still fails after --merge --yes"]
    out += [] if got["permissions"]["deny"] == rules + [OWN] else ["--merge --yes did not remove only %s" % STALE]
    out += [] if got["model"] == "x" and got["permissions"]["allow"] == ["Bash(ls)"] else ["--merge --yes changed another key"]
    return out


def self_test(data):
    """Run every rule's examples, the accounting and the model's own test; 0 when all pass."""
    rules = deny_list(data)
    problems = [p for rule in data["rules"] for p in rule_problems(rule, rules)]
    accounting, accounted = accounting_problems(data)
    problems += accounting + duplicate_problems(data, rules) + merge_problems()
    problems += dropped_problems(data, rules) + stale_problems(data, rules)
    for p in problems:
        print("FAIL " + p)
    print("claude_deny self-test: %d rules for %d retired guard rules, %s"
          % (len(rules), accounted, "ok" if not problems else "%d problems" % len(problems)))
    return model.self_test() or (1 if problems else 0)


COMMANDS = {("--self-test",): self_test}


# --- Settings: the rules fire once they sit in ~/.claude/settings.json under
# permissions.deny. claude_os_sync.py never edits settings.json, so after each
# apply that changes the list, run --merge ~/.claude/settings.json --yes.
#   --check FILE        exit 0 when FILE holds every rule and no dropped one, else list
#                       the missing and the dropped ones. A rule in neither list is the
#                       account's own: listed as kept, never a failure. Read-only.
#   --merge FILE [--yes] print the missing and dropped rules; with --yes add the missing
#                       ones to the end of permissions.deny and remove the dropped ones,
#                       keeping every other rule and key, through a temporary file
#                       renamed into place.
#   --table             the Markdown table of retired rules and what replaces each.

def read_settings(path):
    """A settings file as a JSON object."""
    with open(path, encoding="utf-8") as f:
        settings = json.load(f)
    if not isinstance(settings, dict):
        raise ValueError("%s is not a JSON object" % path)
    return settings


def have(settings):
    """A settings file's permissions.deny, in file order."""
    return list(settings.get("permissions", {}).get("deny", []))


def missing(settings, rules):
    """The rules a settings file's permissions.deny lacks, in list order."""
    held = set(have(settings))
    return [r for r in rules if r not in held]


def stale(settings, data):
    """The dropped rules a settings file still holds, in file order."""
    gone = set(dropped(data))
    return [r for r in have(settings) if r in gone]


def own(settings, data):
    """The rules a settings file holds that the list neither has nor dropped: the account's own."""
    known = set(deny_list(data)) | set(dropped(data))
    return [r for r in have(settings) if r not in known]


def merge(path, data, write):
    """Print the missing and dropped rules; with write add the missing ones and remove the dropped ones."""
    settings = read_settings(path)
    rules = deny_list(data)
    add, cut = missing(settings, rules), stale(settings, data)
    for r in add:
        print("add " + r)
    for r in cut:
        print("remove %s (dropped)" % r)
    if write and (add or cut):
        import tempfile
        perms = settings.setdefault("permissions", {})
        perms["deny"] = [r for r in have(settings) if r not in cut] + add
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".settings-")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
        os.chmod(tmp, os.stat(path).st_mode & 0o777)
        os.replace(tmp, path)
    print("%d of %d rules %s, %d dropped rules %s" % (len(add), len(rules), "added" if write else "to add",
                                                       len(cut), "removed" if write else "to remove (pass --yes to write)"))
    return 0


def table(data):
    """Print the Markdown table of retired guard rules and what replaces each."""
    print("| Retired guard rule | Now | Deny rules | Misses |\n|---|---|---|---|")
    for rule in data["rules"]:
        for rid in rule["replaces"]:
            print("| `%s` | `%s` | %d | %s |" % (rid, rule["id"], len(rule["deny"]), rule.get("gaps", "")))
    for u in data["uncovered"]:
        print("| `%s` | %s | 0 | %s |" % (u["id"], u["now"], u["why"]))
    return 0


def check(path, data):
    """Exit 0 when a settings file holds every deny rule and no dropped one; list the missing, dropped and own ones."""
    settings = read_settings(os.path.expanduser(path))
    gone, cut, kept = missing(settings, deny_list(data)), stale(settings, data), own(settings, data)
    lines = ["missing %s" % r for r in gone] + ["dropped %s" % r for r in cut] + ["own %s (kept)" % r for r in kept]
    print("".join(line + "\n" for line in lines) + "%d deny rules missing from %s, %d dropped rules still in it, %d own rules"
          % (len(gone), path, len(cut), len(kept)))
    return 1 if gone or cut else 0


COMMANDS.update({
    ("--table",): table,
    ("--check", "FILE"): lambda data, f: check(f, data),
    ("--merge", "FILE"): lambda data, f: merge(os.path.expanduser(f), data, False),
    ("--merge", "FILE", "--yes"): lambda data, f: merge(os.path.expanduser(f), data, True),
})
# --- End of settings.


def main(argv):
    """Run one command; 2 on a usage or read error."""
    takes_file = {k[0] for k in COMMANDS if "FILE" in k}
    shape = tuple("FILE" if i == 1 and argv[0] in takes_file else a for i, a in enumerate(argv))
    if shape not in COMMANDS:
        print("usage: claude_deny.py " + " | ".join(" ".join(k) for k in COMMANDS), file=sys.stderr)
        return 2
    try:
        return COMMANDS[shape](load(), *argv[1:2])
    except (OSError, ValueError, KeyError, AttributeError, TypeError) as e:
        print("claude_deny: %s" % e, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
