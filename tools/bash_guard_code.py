"""bash_guard_code.py: Shell text inside other programs: osascript, expect and one-liners that
start a process (step 6), and the texts pass 2 keeps from them.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import re

from bash_guard_operands import one_liner_code
from bash_guard_perl import (
    perl_letter_blanked,
    perl_letter_e_delims,
    perl_text_kept,
    quote_like_bodies)
from bash_guard_scan import Scan
from bash_guard_words import prog_base, tokenize


# Shell text inside other tools: osascript's do shell script and Terminal's
# do script, and expect's spawn.
OSA_SCRIPT_RE = re.compile(r'(?i)\bdo\s+(?:shell\s+)?script\s+"((?:[^"\\]|\\.)*)"')


# An admin do shell script runs as root, so a leading sudo -u USER only drops
# to that user and asks for no password: brew runs as the user who owns it.
OSA_ADMIN_RE = re.compile(r'(?i)(?:\s+with\s+prompt\s+"(?:[^"\\]|\\.)*")?\s+with\s+administrator\s+privileges')


SUDO_AS_RE = re.compile(r"^\s*sudo\s+(?:-H\s+)?-u\s+[A-Za-z_][\w.-]*(?:\s+-H)?\s+(?=\S)")


EXPECT_SPAWN_RE = re.compile(r"\bspawn\s+([^;\n\]]+)")


# A one-liner that starts a process: its string literals are shell text.
PROC_API_RE = re.compile(
    r"\b(subprocess|os\.system|os\.popen|os\.exec\w*|os\.spawn\w*|pty\.spawn|"
    r"child_process|execSync|spawnSync|execFileSync|IO\.popen|Open3|system\s*\()|`")


PROC_CALL_RE = re.compile(PROC_API_RE.pattern[:-2])  # pass 2 only: PROC_API_RE without the backtick


# A perl s///, tr/// or y/// body is text, not code, unless the e flag makes
# the replacement code: backticks quoted in a doc edit start no process.
PERL_SUBST_RE = re.compile(
    r"(?<![\w$@%&])(?:s|tr|y)(?:\{(?:[^{}\\]|\\.)*\}\s*\{(?:[^{}\\]|\\.)*\}"
    r"|([/|#!,])(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1)([a-z]*)")


CODE_STR_RE = re.compile(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"|`([^`\n]*)`")


# Pass 2 only: CODE_STR_RE with every literal across newlines (perl, ruby,
# node and python strings may hold one, and a shell runs each line), and an
# escaped character (a newline too) kept inside a quoted one.
CODE_STR_WIDE_RE = re.compile(r"'((?:[^'\\]|\\[\s\S])*)'|\"((?:[^\"\\]|\\[\s\S])*)\"|`([^`]*)`")


# Pass 2 only. Process calls PROC_API_RE does not know, by program: perl's qx
# with any delimiter; perl's and ruby's system and exec (perl's readpipe,
# open2 and open3, and ruby's spawn too) with or without parentheses, perl's
# indirect object (system { "sh" } ...) and ruby's send(:system, ...); perl's
# open with a pipe beside a quote in the same statement ("-|", "|-", "| cmd",
# "cmd |"); ruby's %x; bun's and deno's own APIs.
PROC_KEPT_RE = {
    "perl": re.compile(r"(?<![\w$@%&])(?:qx(?:\s*[^\w\s]|\s+\w)"
                       r"|(?:system|exec|readpipe|open[23])(?:\s*[(\"'`$@{+]|\s+\w)"
                       r"|open\b[^;]*?(?:[\"']\s*-?\||\|-?\s*[\"']))"),
    "ruby": re.compile(r"(?<![\w$@%&])(?:system|exec|spawn)(?:\s*[(\"'`$@%*]|\s+\w)|%x[^\w\s]"
                       r"|\b(?:__send__|public_send|send|method)\s*\(?\s*(?::|[\"'])(?:system|exec|spawn|`)"),
    "bun": re.compile(r"\bBun\.(?:spawn\w*|\$)"),
    "deno": re.compile(r"\bDeno\.(?:Command|run)\b"),
}


PERL_PIPE_END_RE = re.compile(r"^\s*\|\s*|\s*\|\s*$")  # pass 2 only


def embedded_shell(cmd):
    """Shell text another tool runs: osascript's do shell script and do
    script strings, the commands expect spawns, and the string literals of a
    python, node, perl or ruby one-liner that starts a process."""
    out = []
    if prog_base(cmd["prog"]) in ("python", "node", "perl", "ruby"):
        out += process_literals(cmd)
    if cmd["prog"] in ("osascript", "expect"):
        out += script_shell(cmd)
    return out


def process_literals(cmd):
    """A one-liner that starts a process: its string literals, then all of
    them joined. A perl s/// with no e flag is text, not code."""
    out = []
    for code in one_liner_code(cmd["args"])[0]:
        if prog_base(cmd["prog"]) == "perl":
            code = PERL_SUBST_RE.sub(lambda m: m.group(0) if "e" in m.group(2) else " ", code)
        if PROC_API_RE.search(code):
            lits = [next(g for g in m.groups() if g is not None)
                    for m in CODE_STR_RE.finditer(code)]
            out += lits + [" ".join(lits)]
    return out


def script_shell(cmd):
    """osascript's do shell script and do script strings, and the commands
    expect spawns."""
    out = []
    for code in one_liner_code(cmd["args"])[0]:
        if cmd["prog"] == "osascript":
            out += osa_commands(code)
        else:
            out += [m.group(1) for m in EXPECT_SPAWN_RE.finditer(code)]
    return out


def osa_commands(code):
    """Each do shell script or do script string in AppleScript code. An
    admin one's leading sudo -u USER goes first: as root it only lowers
    rights."""
    out = []
    for m in OSA_SCRIPT_RE.finditer(code):
        text = re.sub(r"\\(.)", r"\1", m.group(1))
        if re.match(r"(?i)do\s+shell", m.group(0)) and OSA_ADMIN_RE.match(code, m.end()):
            text = SUDO_AS_RE.sub("", text, count=1)
        out.append(text)
    return out


def one_liner_code_kept(args, prog=""):
    """Pass 2's code strings: one_liner_code's, with -E ending a cluster too
    (-pE), plus code attached to its flag: after perl, ruby or node switches
    that take no value (-e'..', -le'..', -Te'..', -fe'..'), python's -c'..'
    (-Bc'..'), and node's --eval=.. and --print=..."""
    codes = [args[k + 1] for k, a in enumerate(args[:-1])
             if a in ("-c", "-e", "-E", "--eval", "-p", "--print")
             or re.match(r"^-[A-Za-z]+[ceE]$", a)]
    attached = [r"^-[nlpawsTtWXUScdfg0-9]*[eE](.+)$"]
    if prog == "python":
        attached = [r"^-[A-Za-z]*c(.+)$"]
    elif prog == "node":
        attached.append(r"^--(?:eval|print)=(.+)$")
    for a in args:
        for pattern in attached:
            m = re.match(pattern, a, re.S)
            if m:
                codes.append(m.group(1))
    return codes


def parses_as_shell(text):
    """True when shell can read text (a literal like `it"s` cannot)."""
    try:
        tokenize(Scan(text).run())
        return True
    except Exception:  # ValueError, or RecursionError on deep $( nesting
        return False


def deno_eval_code(args):
    """deno eval's code: every word after eval that is not an option. An
    option's value is read too, which only adds a reading."""
    k = next((i for i, a in enumerate(args) if not a.startswith("-")), None)
    if k is not None and args[k] == "repl":  # deno repl --eval CODE, --eval=CODE
        return deno_repl_evals(args[k + 1:])
    if k is None or args[k] != "eval":
        return []
    return [a for a in args[k + 1:] if not a.startswith("-")]


def deno_repl_evals(rest):
    """deno repl's --eval CODE and --eval=CODE values."""
    return [a.partition("=")[2] if a.startswith("--eval=") else rest[j + 1]
            for j, a in enumerate(rest)
            if a.startswith("--eval=") or a == "--eval" and j + 1 < len(rest)]


def kept_texts(cmd, exact=False):
    """Pass 2's shell text in a python, node, perl, ruby, bun or deno
    one-liner that starts a process: perl's -e and -E codes read as one
    program through perl_text_kept, and each string literal, then the
    literals joined twice: all of them (quotes split across literals) and
    only those that parse. A call only PROC_KEPT_RE knows, or a perl or ruby
    quote-like string, adds the same readings with those strings in their
    place, and each call (never a bare backtick: markdown in a string is no
    call) adds the strings after it joined, so a module name before the call
    (require('child_process').spawnSync('git', [...])) does not lead the
    command. The readings PROC_API_RE alone gives stay as they were. Where
    CODE_STR_WIDE_RE finds other literals (one across a newline), they add the
    same readings, in perl and ruby, and with a process call in the others.
    exact: cmd's words come from bash_commands, so a backtick in python code
    is a character, not a process (python has no backtick operator)."""
    prog = prog_base(cmd["prog"])
    if prog not in ("python", "node", "perl", "ruby", "bun", "deno"):
        return []
    codes = kept_codes(prog, cmd["args"])
    proc = PROC_CALL_RE if exact and prog == "python" else PROC_API_RE
    out, extra = [], PROC_KEPT_RE.get(prog)
    for code in codes:
        out += code_readings(code, prog, proc, extra)
    return out


def kept_codes(prog, args):
    """The codes a one-liner runs; perl's read as one program, and again
    with each letter delimiter of an s///e blanked."""
    if prog == "deno":
        codes = deno_eval_code(args)
    else:
        codes = one_liner_code_kept(args, "node" if prog == "bun" else prog)
    if prog == "perl" and codes:
        joined = "\n".join(codes)
        # A letter delimiter joins the code to it (s xaxsystem("..")xe), so no word
        # break comes before system(: when such an s/// runs its replacement (an e
        # flag), also read the code with that letter blanked.
        codes = [perl_text_kept(joined)] + [perl_letter_blanked(joined, d) for d in perl_letter_e_delims(joined)]
    return codes


def readings(lits):
    """lits, then all of them joined, then those that parse as shell joined."""
    return lits + [" ".join(lits), " ".join(lit for lit in lits if parses_as_shell(lit))]


def code_readings(code, prog, proc, extra):
    """kept_texts' readings of one code, in its order: the literals around a
    process call, the wide literals, the literals with quote-like bodies,
    perl's pipe opens, and the literals after each call."""
    called = proc.search(code)
    out = readings(literals(code)) if called else []
    if not (called or extra and extra.search(code)):
        return out
    # A backtick runs a command in perl and ruby; in node, bun and deno it is a string, and in
    # python text, so python reads only its quoted literals, and the others only with a process call.
    lits = literals(code)
    out += wide_readings(code, prog, lits, extra)
    bodies = quote_like_bodies(code, prog)
    found = sorted([(m.start(), first_group(m)) for m in CODE_STR_RE.finditer(code)] + bodies)
    lits = [lit for _, lit in found]
    if bodies or not called:
        out += readings(lits)
    if prog == "perl":
        out += pipe_open_commands(lits)
    return out + call_tails(code, found, extra)


def first_group(m):
    """The text of a string-literal match's one group that took part."""
    return next(g for g in m.groups() if g is not None)


def literals(code):
    """Each string literal's text in code, in order (CODE_STR_RE)."""
    return [first_group(m) for m in CODE_STR_RE.finditer(code)]


def pipe_open_commands(lits):
    """perl's pipe opens: open F, "cmd |" or "| cmd" runs cmd."""
    return [PERL_PIPE_END_RE.sub("", lit) for lit in lits if PERL_PIPE_END_RE.search(lit)]


def wide_readings(code, prog, lits, extra):
    """The readings of CODE_STR_WIDE_RE's literals, when they differ from
    lits: in perl and ruby, and elsewhere with a process call."""
    wide = [first_group(m) for m in CODE_STR_WIDE_RE.finditer(code)
            if not (prog == "python" and m.group(3) is not None)]
    if wide != lits and (prog in ("perl", "ruby") or PROC_CALL_RE.search(code) or extra and extra.search(code)):
        return readings(wide)
    return []


def call_tails(code, found, extra):
    """For each of the first 8 process calls, the literals after it joined,
    so a module name before the call does not lead the command."""
    out = []
    ends = sorted({m.end() for r in (PROC_CALL_RE, extra) if r for m in r.finditer(code)})
    for end in ends[:8]:
        tail = [lit for start, lit in found if start >= end]
        if 0 < len(tail) < len(found):
            out.append(" ".join(tail))
    return out
