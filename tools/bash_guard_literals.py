"""bash_guard_literals.py: Variables a command sets to a literal before
anything else runs, for the rules that read them (resolve_vars_regex).

Part of tools/bash_guard.py, which says how the guard reads a command.
A rule with resolve_vars_regex reads $NAME or ${NAME} as its value when the
text opens with NAME=value and the value matches the regex: gh-api-merge
then sees the SHA in SHA=3f2a9c1d; gh api -X PUT ... -f sha=$SHA. Only the
opening run counts, each assignment ended by ;, && or a newline, since it
always runs and runs first. Any later sign the name may change drops it.
"""

import re

# One opening NAME=value, the value a plain word with no quote or expansion.
LEAD_RE = re.compile(r"[ \t]*([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:@%+,-]*)[ \t]*(?:;|&&|\n)")
# The rest runs a file or a string as shell, which may set any name.
RUNS_SHELL_RE = re.compile(r"(?:^|[\s;&|(`])(?:source|\.|eval)(?=\s)")
# NAME inside (( )) or $(( )), where any operator may set it: (( NAME = 3 )), NAME++,
# NAME <<= 1. A read there counts too, which only keeps the rule strict.
ARITH_RE = r"\(\([^)]*(?<![\w$])%s\b"
# Commands that set, read into or unset a named variable.
SETTERS = r"unset|read|export|declare|typeset|local|readonly|mapfile|readarray|getopts|printf|let|for|select"


def changes(name, rest):
    """True when rest may give name another value: NAME= or NAME+=, a
    ${NAME:=x} default, arithmetic in (( )), or a setter (unset, read,
    export, let, for ...) naming it."""
    n = re.escape(name)
    if re.search(r"(?<![\w$])%s\+?=|\$\{%s:?=" % (n, n), rest):
        return True
    if re.search(ARITH_RE % n, rest):
        return True
    return re.search(r"\b(?:%s)\b[^;&|\n]*(?<![\w$])%s\b" % (SETTERS, n), rest) is not None


def leading_literals(text):
    """{NAME: value} for each NAME=value that opens text and that nothing
    later may change; empty once the rest sources a file or evals."""
    found, pos = {}, 0
    while True:
        m = LEAD_RE.match(text, pos)
        if not m:
            break
        found[m.group(1)] = m.group(2)
        pos = m.end()
    rest = text[pos:]
    if not found or RUNS_SHELL_RE.search(rest):
        return {}
    return {k: v for k, v in found.items() if not changes(k, rest)}


def resolved(cmd, literals, value_regex):
    """cmd with each $NAME and ${NAME} in its args read as its literal, for
    the literals whose value matches value_regex; cmd itself when none do."""
    keep = {k: v for k, v in literals.items() if re.fullmatch(value_regex, v)}
    if not keep:
        return cmd
    alt = "|".join(map(re.escape, keep))
    ref = re.compile(r"\$(?:\{(%s)\}|(%s)(?![A-Za-z0-9_]))" % (alt, alt))
    args = [ref.sub(lambda m: keep[m.group(1) or m.group(2)], a) for a in cmd["args"]]
    return dict(cmd, args=args)


def literal_prefix(literals):
    """The literals as the assignments that open a text, NAME=value; each,
    so a text pass 2 rebuilds from one command still runs after them."""
    return "".join(f"{k}={v}; " for k, v in literals.items())
