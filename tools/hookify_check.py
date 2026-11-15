#!/usr/bin/env python3
"""hookify_check.py: examples for Git Crafter's hookify rules.

Canonical source: Git Crafter tools/hookify_check.py. The rules are
.claude/hookify.*.local.md, which the hookify plugin (claude-plugins-official)
loads from .claude/ under a session's working folder, so they fire in Git
Crafter sessions, and in sessions run from the home folder once
claude_os_sync.py apply user-claude installs them in ~/.claude/. Hookify
compiles each pattern with re.IGNORECASE.

--self-test compiles each pattern as hookify does, runs the examples below,
and times each pattern on long decoys (under DECOY_SECONDS each). For
no-banned-dash it also checks that voice_lint.py grades the same examples
FAIL, so the two definitions agree. Examples are text, never run. Exit 0 =
ok, 1 = an example misbehaves, 2 = usage or read error. Python 3.9, stdlib.
"""

import glob
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.realpath(__file__))
ROOT = os.path.dirname(HERE)
EM, EN = "\u2014", "\u2013"
# A command example is built from parts, so no source line reads as the command.
RM, HOME_T = "r" + "m", "~"

EXAMPLES = {
    "no-banned-dash": {
        "block": [("notes.md", "Light moves data " + EM + " fast."), ("a/B.MDX", "x " + EN + " y"), ("t.txt", "a" + EM + "b")],
        "allow": [("notes.md", "See sections 3" + EN + "4."), ("notes.md", "A comma, then more."), ("app.ts", "a " + EM + " b")],
    },
    "block-rm-home": {
        "block": [RM + " -rf " + HOME_T, "/bin/" + RM + " -rf " + HOME_T, "bash -c '" + RM + " -rf " + HOME_T + "'",
                  RM + " -rf " + HOME_T + "/*", RM + " -rf -- -e " + HOME_T, RM + " -rf " + HOME_T + " --help",
                  RM + " -rf \"$HOME\"", RM + " -rf \"${HOME}/\"", RM + " -rf /", "cd /tmp && " + RM + " -r " + HOME_T + "/",
                  "find " + HOME_T + " -delete", "find -L " + HOME_T + " -type f -exec /bin/" + RM + " {} ;", "find / -exec " + RM + " -rf {} +",
                  "x=$(" + RM + " -rf " + HOME_T + ")"],
        "allow": [RM + " -rf " + HOME_T + "/tmp/x", RM + " -rf dist", RM + " -f " + HOME_T + "/.cache/x.tmp", RM + " -rf /tmp/scratch-123",
                  "find . -name '*.pyc' -delete", "find " + HOME_T + "/tmp/x -delete", "find " + HOME_T + " -name x -print",
                  "git commit -m 'never " + RM + " -rf " + HOME_T + "'", "echo " + RM + " -rf " + HOME_T, "grep -rn " + RM + " rules/"],
    },
}


# Long inputs a careless pattern backtracks on. Hookify gives each hook 10 s
# (hooks/hooks.json), so each pattern must finish one well inside that.
DECOYS = ["x;" * 70000, ";/" * 70000, "|x" * 70000, "\n x" * 50000, RM + " " + "-x " * 50000,
          "/a" * 70000, "echo $(" * 30000, "env " + "a=1 " * 40000 + "q", "find " + "-L " * 50000 + "x"]
DECOY_SECONDS = 1.0


def rule_files():
    return sorted(glob.glob(os.path.join(ROOT, ".claude", "hookify.*.local.md")))


def parse(path):
    """The name, event and conditions of one rule file: the two shapes Git Crafter uses."""
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    if not m:
        raise ValueError("%s has no frontmatter" % path)
    front, conds, cur = {}, [], None
    for line in m.group(1).split("\n"):
        if not line.strip():
            continue
        key, _, value = line.strip().lstrip("- ").partition(":")
        value = value.strip()
        if line.startswith("  - "):
            cur = {key: value}
            conds.append(cur)
        elif line.startswith("    ") and cur is not None:
            cur[key] = value
        else:
            front[key] = value
    if "pattern" in front and not conds:
        conds = [{"field": "command" if front.get("event") == "bash" else "new_text",
                  "operator": "regex_match", "pattern": front["pattern"]}]
    return front["name"], front.get("event"), front.get("action"), conds


def matches(conds, example):
    path, text = example if isinstance(example, tuple) else ("", example)
    for c in conds:
        value = path if c["field"] == "file_path" else text
        if not re.search(c["pattern"], value, re.IGNORECASE):
            return False
    return True


def voice_fails(text):
    if HERE not in sys.path:
        sys.path.append(HERE)
    import voice_lint
    return any(check in ("em-dash", "spaced-en-dash") and severity == "FAIL"
               for _line, severity, check, _message in voice_lint.lint_text(text))


def self_test():
    problems, names = [], []
    for path in rule_files():
        name, _event, action, conds = parse(path)
        names.append(name)
        if action != "block":
            problems.append("%s: action is %r, not block" % (name, action))
        for c in conds:
            try:
                re.compile(c["pattern"], re.IGNORECASE)
            except re.error as e:
                problems.append("%s: pattern does not compile: %s" % (name, e))
                conds = []
        for c in conds:
            for d in DECOYS:
                start = time.perf_counter()
                re.search(c["pattern"], d, re.IGNORECASE)
                took = time.perf_counter() - start
                if took > DECOY_SECONDS:
                    problems.append("%s: %.1f s on a %d-character decoy, over %.1f s" % (name, took, len(d), DECOY_SECONDS))
        ex = EXAMPLES.get(name)
        if ex is None:
            problems.append("%s: no examples in hookify_check.py" % name)
            continue
        problems += ["%s: should block %r" % (name, e) for e in ex["block"] if not matches(conds, e)]
        problems += ["%s: should allow %r" % (name, e) for e in ex["allow"] if matches(conds, e)]
        if name == "no-banned-dash":
            for e in ex["block"] + ex["allow"]:
                prose = e[0].lower().endswith((".md", ".mdx", ".txt"))
                if prose and voice_fails(e[1]) != matches(conds, e):
                    problems.append("%s: voice_lint and the rule disagree on %r" % (name, e[1]))
    problems += ["%s: examples but no rule file" % n for n in EXAMPLES if n not in names]
    for p in problems:
        print("FAIL " + p)
    print("hookify_check self-test: %d rules, %s" % (len(names), "ok" if not problems else "%d problems" % len(problems)))
    return 0 if not problems else 1


def main(argv):
    try:
        if argv == ["--self-test"]:
            return self_test()
    except (OSError, ValueError, KeyError) as e:
        print("hookify_check: %s" % e, file=sys.stderr)
        return 2
    print("usage: hookify_check.py --self-test", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
