"""bash_guard_rules.py: Loading the rules: the template, the owner's local file and keys.toml.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import json
import os
import re
import sys

from bash_guard_evaluate import evaluate
from bash_guard_paths import pattern_segments


HERE = os.path.dirname(os.path.realpath(__file__))


RULES_FILE = os.path.join(HERE, "bash_guard_rules.json")


CASES_FILE = os.path.join(HERE, "bash_guard_cases.json")


# One owner's extra rules, kept out of the template: the same format as the
# rules file, merged at load. Absent or broken, the template runs alone.
LOCAL_FILE = os.environ.get("BASH_GUARD_LOCAL",
                            os.path.join(HERE, "bash_guard_rules.local.json"))


# An owner's own credential list and key registry, when it keeps them: the
# self-test checks the rules against each, and load_rules adds every name the
# registry lists. Unset, both are skipped.
PLAN_FILE = os.environ.get("BASH_GUARD_PLAN", "")


KEYS_FILE = os.environ.get("BASH_GUARD_KEYS", "")


def check_local(data):
    """Raise ValueError unless data is a well-formed local rules file: rules
    a list of rule objects, every regex compiling, every path pattern
    parsing, and key_vars lists of strings and compiling patterns."""
    if not isinstance(data, dict) or not isinstance(data.get("rules", []), list):
        raise ValueError("not an object with a rules list")
    for r in data.get("rules", []):
        check_rule_shape(r)
        if r.get("kind") == "path":
            check_strings(r.get("paths"), f"{r['id']}: paths")
            if any(pattern_segments(x) is None for x in r["paths"]):
                raise ValueError(f"{r['id']}: a path does not parse")
        check_regexes(r)
    kv = data.get("key_vars", {})
    if not isinstance(kv, dict):
        raise ValueError("key_vars is not an object")
    check_strings(kv.get("names", []), "key_vars.names")
    check_strings(kv.get("patterns", []), "key_vars.patterns")
    for x in kv.get("patterns", []):
        re.compile(x)


def check_rule_shape(r):
    """Raise ValueError unless r has an id, a why, a match or kind, list
    conditions and examples, and an object match."""
    if not (isinstance(r, dict) and isinstance(r.get("id"), str) and r.get("why")
            and ("match" in r or "kind" in r)):
        raise ValueError("a rule lacks id, why, or match or kind")
    for key in ("when_any", "when_all", "unless_any", "block", "allow"):
        if key in r and not isinstance(r[key], list):
            raise ValueError(f"{r['id']}: {key} is not a list")
    if not isinstance(r.get("match", {}), dict):
        raise ValueError(f"{r['id']}: match is not an object")


def check_strings(v, what):
    """Raise ValueError unless v is a list of strings."""
    if not (isinstance(v, list) and all(isinstance(x, str) for x in v)):
        raise ValueError(f"{what} is not a list of strings")


def check_regexes(node):
    """Compile every string under a key ending in regex, at any depth."""
    if isinstance(node, dict):
        for k, v in node.items():
            if isinstance(v, str) and k.endswith("regex"):
                re.compile(v)
            else:
                check_regexes(v)
    elif isinstance(node, list):
        for v in node:
            check_regexes(v)


def load_local(path):
    """The owner's local rules file as a dict, or None when there is none or
    it is broken. Broken prints a one-line warning and fails open to the
    template, never to no rules."""
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        check_local(data)
        return data
    except (OSError, ValueError, TypeError, re.error) as exc:
        print(f"bash_guard: {path} ignored ({exc}); the template runs alone", file=sys.stderr)
        return None


def load_rules(path=RULES_FILE, keys=None, local=LOCAL_FILE):
    """The rules, each key_var condition given the key names: the rules
    file's key_vars names and patterns, plus every variable keys.toml lists
    (KEYS_FILE, or keys) when it can be read. The local file's rules follow
    the template's (a local rule may not reuse a template id), and its
    key_vars add to the template's."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    rules = data["rules"]
    kv = data.get("key_vars")
    extra = load_local(local)
    if extra:
        rules, kv = merge_local(rules, kv, extra)
    if isinstance(kv, dict):
        attach_key_vars(rules, kv, keys)
    if extra and not canary_holds(rules, local):
        return load_rules(path, keys, local=None)
    return rules


def merge_local(rules, kv, extra):
    """The template's rules and key_vars with the local file's added: a
    local rule may not reuse a template id."""
    ids = {r["id"] for r in rules}
    rules = rules + [r for r in extra.get("rules", []) if r["id"] not in ids]
    more = extra.get("key_vars") if isinstance(extra.get("key_vars"), dict) else {}
    if isinstance(kv, dict) or more:
        kv = dict(kv or {})
        kv["names"] = list(kv.get("names", [])) + list(more.get("names", []))
        kv["patterns"] = list(kv.get("patterns", [])) + list(more.get("patterns", []))
    return rules, kv


def attach_key_vars(rules, kv, keys):
    """Give each key_var condition the key names: kv's names and patterns,
    and every variable keys.toml lists when it can be read."""
    spec = {"names": set(kv.get("names", [])) | set(registry_vars(keys) or []),
            "patterns": [re.compile(p) for p in kv.get("patterns", [])]}
    for r in rules:
        for key in ("when_any", "when_all", "unless_any"):
            for c in r.get(key, []):
                if "key_var" in c:
                    c["_key_vars"] = spec


def canary_holds(rules, local):
    """True when git push --force origin main still blocks with the local
    rules merged; otherwise say why the local file is ignored."""
    try:
        if "git-force-push" not in [h[0] for h in evaluate("git push --force origin main", rules)]:
            raise ValueError("the force-push canary no longer blocks")
    except Exception as exc:  # any fault in a local rule: the template alone
        print(f"bash_guard: {local} ignored ({exc}); the template runs alone", file=sys.stderr)
        return False
    return True


def registry_vars(path=None):
    """The secret variables keys.toml lists, each [[var]] var and its
    aliases, or None when it cannot be read. A format = "public" row holds
    an id, which keys.toml itself calls not secret, so it is left out.
    keys.toml holds names, never a value, and keeps to one-line keys (its
    header), so reading lines is enough."""
    try:
        with open(path or KEYS_FILE, encoding="utf-8") as fh:
            text = fh.read()
    except (OSError, UnicodeDecodeError):
        return None
    names = []
    for block in re.split(r"(?m)^\[\[", text)[1:]:
        kind, _, body = block.partition("]]")
        if kind.strip() != "var" or re.search(
                r"""(?m)^format\s*=\s*["']public["']""", body):
            continue
        names += re.findall(r"""(?m)^var\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']""", body)
        for line in re.findall(r"(?m)^aliases\s*=\s*\[([^\]\n]*)\]", body):
            names += re.findall(r"""["']([A-Za-z_][A-Za-z0-9_]*)["']""", line)
    return names or None
