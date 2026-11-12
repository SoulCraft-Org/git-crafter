#!/usr/bin/env python3
"""json_facts.py: print facts from a JSON file that can hold a key, never a key value.

Canonical source: Git Crafter tools/json_facts.py. The installed copy lives at
~/.claude/code-os/json_facts.py. If the two disagree, Git Crafter wins.

  python3 -I ~/.claude/code-os/json_facts.py claude cachedGrowthBookFeatures.tengu_wise_newt

The bash guard's credential-file-read rule blocks reads of ~/.claude.json,
which keeps Claude Code's flag cache beside MCP server keys. This reader
takes a file's name from FILES, never a path, and dotted field names. It
prints true, false, null and numbers as they are, a string as its length,
a list as its length and an object as its field names. So no key value
reaches the output (rules/keys.md). Add a file to FILES by pull request.
"""
import json
import os
import sys

FILES = {"claude": "~/.claude.json"}


def fact(value):
    """A value as a fact that holds no secret: scalars as they are, else a length or field names."""
    if value is None or isinstance(value, (bool, int, float)):
        return json.dumps(value)
    if isinstance(value, str):
        return f"<string, {len(value)} chars>"
    if isinstance(value, list):
        return f"<list, {len(value)} items>"
    return "<object> " + ", ".join(sorted(map(str, value)))


def lookup(data, field):
    """The fact at a dotted field path, or <absent>."""
    for part in field.split("."):
        if not isinstance(data, dict) or part not in data:
            return "<absent>"
        data = data[part]
    return fact(data)


def self_test():
    """Check facts on a sample with a fake key; 0 when none leaks, 1 otherwise."""
    data = {"flags": {"on": True, "n": 3, "off": None},
            "mcp": {"env": {"TOKEN": "sk-secret-value"}}, "list": ["sk-secret-value"]}
    want = {"flags.on": "true", "flags.n": "3", "flags.off": "null",
            "mcp.env.TOKEN": "<string, 15 chars>", "mcp.env": "<object> TOKEN",
            "list": "<list, 1 items>", "flags.gone": "<absent>", "flags.on.x": "<absent>"}
    bad = [f"{f}: {lookup(data, f)!r}, want {w!r}" for f, w in want.items() if lookup(data, f) != w]
    if "sk-secret" in "".join(lookup(data, f) for f in want):
        bad.append("a string value reached the output")
    if main(["~/.claude.json", "flags"]) != 2:
        bad.append("a path in place of a FILES name was read")
    for b in bad:
        print(f"json_facts self-test: FAIL {b}")
    print("json_facts self-test: " + ("ok" if not bad else f"{len(bad)} failed"))
    return 1 if bad else 0


def main(argv):
    """Print the facts for each field of a FILES file; 2 on bad usage."""
    if argv == ["--self-test"]:
        return self_test()
    if len(argv) < 2 or argv[0] not in FILES:
        print(f"usage: json_facts.py {'|'.join(FILES)} FIELD [FIELD ...]", file=sys.stderr)
        return 2
    with open(os.path.expanduser(FILES[argv[0]]), encoding="utf-8") as fh:
        data = json.load(fh)
    for field in argv[1:]:
        print(f"{field}: {lookup(data, field)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
