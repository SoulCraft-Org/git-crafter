"""bash_guard_conditions.py: Rule conditions: key variables, cond_holds and match_simple.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import os
import re

from bash_guard_args import FALSE_VALUES, flag_value, has_flag, norm_path, parse_args
from bash_guard_slow import git_branch_facts
from bash_guard_words import ASSIGN_RE, prog_base, prog_matches


# A shell parameter expansion: $NAME, ${NAME...}, and zsh's ${(flags)NAME},
# ${=NAME}, ${^NAME} and ${~NAME}. Group 2 holds what comes between the $ (or
# ${) and the name: # is a length, + a zsh set test.
KEY_REF_RE = re.compile(r"\$(\{?)((?:\([^()]*\)|[#!=^~+])*)([A-Za-z_][A-Za-z0-9_]*)")


def is_key_var(name, spec):
    """True when name is a key variable: one keys.toml lists, or one named
    like a key (the rules' key_vars patterns)."""
    return name in spec["names"] or any(p.search(name) for p in spec["patterns"])


def key_expansions(tok, spec):
    """The key variables a word expands. The word comes without its quotes,
    so a $NAME the shell would print as text ('$NAME', \\$NAME) counts too.
    ${#NAME}, $#NAME and zsh's ${+NAME} print a length or a set test, and
    ${NAME:+word} or ${NAME+word} print word, which is read on its own; none
    of them prints the value."""
    found = []
    for m in KEY_REF_RE.finditer(tok):
        brace, between, name = m.groups()
        if not is_key_var(name, spec) or between in ("#", "+"):
            continue
        if brace and not between and re.match(r":?\+", tok[m.end():]):
            continue
        found.append(name)
    return found


def key_assignment(tok, spec):
    """True when a word puts a key on the command line or copies one: it
    expands a key variable anywhere (X=$HF_TOKEN, $HF_TOKEN), or it gives a
    key variable a value (HF_TOKEN=x, HF_TOKEN[0]=x, an array HF_TOKEN=(x),
    which tokenize puts back in the word). An empty value (HF_TOKEN=) sets
    none."""
    if key_expansions(tok, spec):
        return True
    m = ASSIGN_RE.match(tok)
    return bool(m and is_key_var(m.group(1), spec) and tok[m.end():] != "")


def cond_holds(cond, f, block=False):
    """True when one rule condition holds for the command facts f (see
    match_simple). sub, sub_in, program_in and via_xargs narrow it first;
    then the first key CONDITION_TESTS lists that cond holds decides, so a
    condition with several keys reads as it always has. block: the
    condition blocks (when_any, when_all) rather than exempts (unless_any)."""
    view = narrowed(cond, f)
    if view is None:
        return False
    if cond.get("always"):
        return True
    flags, positionals = view
    for key, test in CONDITION_TESTS:
        if key in cond:
            return test(cond, f, flags, positionals, block)
    return False


def narrowed(cond, f):
    """(flags, positionals) as cond reads them, past its subcommand, or None
    when via_xargs, program_in, sub or sub_in rules the command out."""
    if "via_xargs" in cond and bool(f.get("via_xargs")) != cond["via_xargs"]:
        return None  # xargs runs the command with words from its stdin
    if "program_in" in cond and not prog_matches(f["prog"], cond["program_in"]):
        return None
    n = sub_length(cond, f["rest"])
    if n is None:
        return None
    if n:
        _r, flags, positionals, _c = parse_args(f["rest"], n, f["prog"])
        return f["lead"] + flags, positionals
    return f["flags"], f["positionals"]


def sub_length(cond, rest):
    """How many words of rest cond's sub or sub_in takes as its subcommand
    (0 for neither), or None when they do not match."""
    n = 0
    if "sub" in cond:
        if rest[: len(cond["sub"])] != cond["sub"]:
            return None
        n = len(cond["sub"])
    if "sub_in" in cond:
        if not rest or rest[0] not in cond["sub_in"]:
            return None
        n = 1
    return n


def when_lead_flag(cond, f, flags, positionals, block):
    """An option before the subcommand: security -i."""
    return has_flag(f["lead"], cond["lead_flag"])


def when_no_args(cond, f, flags, positionals, block):
    """The command has no arguments, or has some."""
    return (not f["args"]) == cond["no_args"]


def when_flag(cond, f, flags, positionals, block):
    """A flag is on. An exemption (block=False) needs the exact spelling;
    git's block conditions take an abbreviation."""
    return has_flag(flags, cond["flag"], block and prog_base(f["prog"]) == "git",
                    cond.get("any_value", False), exempt=not block)


def when_flag_in(cond, f, flags, positionals, block):
    """Any of a list of flags is on, each read as when_flag reads one."""
    return any(when_flag({**cond, "flag": x}, f, flags, positionals, block) for x in cond["flag_in"])


def when_missing_flag(cond, f, flags, positionals, block):
    """A flag is absent; an off copy counts as missing, the stricter reading."""
    return not has_flag(flags, cond["missing_flag"], exempt=True)


def when_flag_last_off(cond, f, flags, positionals, block):
    """The flag ends off, as gh and pflag read it: its last copy reads off
    (--x --x=false), or no copy is left once option values are skipped
    (-A --x)."""
    opts, short = set(cond.get("value_opts", [])), cond.get("value_short", "")
    rest, on, k = f["rest"], False, 0
    while k < len(rest):  # the words after the subcommand, each option's value skipped
        tok = rest[k]
        k += 1
        if tok == "--":
            break
        if tok in opts:
            k += 1
        elif re.match(r"^-[A-Za-z]+$", tok):  # -sb, -dA: a value letter takes the rest or the next word
            k += cluster_value_words(tok, short)
        elif tok.partition("=")[0] == cond["flag_last_off"]:
            value = tok.partition("=")[2]
            on = not ("=" in tok and value.lower() in FALSE_VALUES | {"f"})
    return not on


def when_flag_last_value_not(cond, f, flags, positionals, block):
    """The last copy's value fails the regex: --x a --x "$SHA", as gh reads it."""
    spec = cond["flag_last_value_not"]
    opts, short = set(spec.get("value_opts", [])), spec.get("value_short", "")
    rest, last, k = f["rest"], None, 0
    while k < len(rest):  # the words after the subcommand, each option's value skipped
        tok = rest[k]
        k += 1
        if tok == "--":
            break
        if tok == spec["flag"]:
            last = rest[k] if k < len(rest) else ""
            k += 1
        elif tok.startswith(spec["flag"] + "="):
            last = tok.partition("=")[2]
        elif tok in opts:
            k += 1
        elif re.match(r"^-[A-Za-z]+$", tok):  # -sb: a value letter takes the rest or the next word
            k += cluster_value_words(tok, short)
    return last is not None and not re.search(spec["regex"], last)


def cluster_value_words(tok, short):
    """1 when the first value letter in a -xyz cluster is its last letter, so
    the next word is its value; 0 when it takes the rest of the word, or the
    cluster holds none."""
    for j, ch in enumerate(tok[1:]):
        if ch in short:
            return 1 if j == len(tok) - 2 else 0
    return 0


def when_flag_value_not(cond, f, flags, positionals, block):
    """The flag's value fails the regex."""
    spec = cond["flag_value_not"]
    value = flag_value(f["args"], spec["flag"])
    return value is not None and not re.search(spec["regex"], value)


def when_arg_regex(cond, f, flags, positionals, block):
    """A positional matches; with not_after, one that is an option's value
    (--config x.test.ts) does not count."""
    if "not_after" in cond:  # --config x.test.ts: x.test.ts is the option's value
        args, skip = f["args"], set(cond["not_after"])
        positionals = [a for k, a in enumerate(args)
                       if a in positionals and not (k and args[k - 1] in skip)]
    return any(re.search(cond["arg_regex"], p) for p in positionals)


def when_arg_in(cond, f, flags, positionals, block):
    """A positional is one of the words."""
    return any(p in cond["arg_in"] for p in positionals)


def when_path_in(cond, f, flags, positionals, block):
    """A positional is one of the paths, trailing slashes aside."""
    wanted = {norm_path(x) for x in cond["path_in"]}
    return any(norm_path(p) in wanted for p in positionals)


def when_has_positional(cond, f, flags, positionals, block):
    """The command has a positional, or has none."""
    return bool(positionals) == cond["has_positional"]


def when_joined_regex(cond, f, flags, positionals, block):
    """The arguments, joined by spaces, match."""
    return re.search(cond["joined_regex"], " ".join(f["args"])) is not None


def when_env_regex(cond, f, flags, positionals, block):
    """A variable assigned a value before the program matches. An empty or
    blank value (NAME=, NAME="", NAME=" ") sets none, so ONE_WAY_REASON=
    gives no reason (issues 708, 820)."""
    named = [t.partition("=")[0].rstrip("+") for t in f.get("assigns", []) if t.partition("=")[2].strip()]
    return any(re.search(cond["env_regex"], e) for e in named)


def when_word_in(cond, f, flags, positionals, block):
    """Any argument, option values included, is one of the words:
    claude -c setup-token."""
    return any(a in cond["word_in"] for a in f["args"])


def when_key_var(cond, f, flags, positionals, block):
    """A key variable shows, by mode: expanded (echo "$HF_TOKEN"), named
    (declare -p HF_TOKEN), assigned (export X=$HF_TOKEN) or env
    (HF_TOKEN=x cmd). With no names from load_rules, could not check."""
    spec, mode = cond.get("_key_vars"), cond["key_var"]
    if not spec:
        return False  # load_rules gave it no names: could not check
    if mode == "expanded":  # echo "$HF_TOKEN"
        return any(key_expansions(a, spec) for a in f["args"])
    if mode == "named":  # declare -p HF_TOKEN
        return any(is_key_var(p, spec) for p in positionals)
    if mode == "assigned":  # export HF_TOKEN=x, export X=$HF_TOKEN
        return any(key_assignment(a, spec) for a in f["args"])
    if mode == "env":  # HF_TOKEN=x cmd, env X=$HF_TOKEN cmd, a bare HF_TOKEN=x
        return any(key_assignment(a, spec) for a in f["assigns"])
    return False


def when_push_from_branch(cond, f, flags, positionals, block):
    """git push from one of the branches: a bare push or one of HEAD, read
    from the checkout the command runs in."""
    refs = positionals[1:]
    if f["cwd"] is None:
        return False
    if refs and not any(r in ("HEAD", "@") for r in refs):
        return False
    path = f["cwd"]
    if f["cpath"]:
        path = os.path.join(f["cwd"], os.path.expanduser(f["cpath"]))
    branch, upstream = git_branch_facts(path)
    names = cond["push_from_branch"]
    if branch in names:
        return True
    if refs:
        return False  # HEAD pushes to the branch's own name
    return bool(upstream) and upstream.split("/", 1)[-1] in names


# First match wins, in this order, so a condition with several keys reads as
# it did when these were one if chain. A tuple, never a dict: the order is
# the behaviour.
CONDITION_TESTS = (
    ("lead_flag", when_lead_flag),
    ("no_args", when_no_args),
    ("flag", when_flag),
    ("flag_in", when_flag_in),
    ("missing_flag", when_missing_flag),
    ("flag_last_off", when_flag_last_off),
    ("flag_last_value_not", when_flag_last_value_not),
    ("flag_value_not", when_flag_value_not),
    ("arg_regex", when_arg_regex),
    ("arg_in", when_arg_in),
    ("path_in", when_path_in),
    ("has_positional", when_has_positional),
    ("joined_regex", when_joined_regex),
    ("env_regex", when_env_regex),
    ("word_in", when_word_in),
    ("key_var", when_key_var),
    ("push_from_branch", when_push_from_branch),
)


def help_skips(rule, cmd):
    """True when --help in cmd turns rule off. Help text never changes
    anything, so --help skips every rule except those marked past_help,
    whose program still acts past it (macOS rm reads it as a file, git
    commit -m --help takes it as a value, echo prints the word with the
    value). Those skip only a plain help call (help_call)."""
    if "--help" not in cmd["args"]:
        return False
    return not rule.get("past_help") or help_call(rule, cmd)


def help_call(rule, cmd):
    """True when cmd is only a help call for a past_help rule: --help after
    the program and words the rule names as subcommands, and nothing else
    (crontab --help, security import --help, sudo --help). An assignment
    before it keeps the rules on, since its value is on the line either
    way (HF_TOKEN=x tool --help)."""
    if cmd.get("env") or cmd.get("assigns"):
        return False
    subs = set(rule["match"].get("sub", []))
    for cond in rule.get("when_any", []) + rule.get("when_all", []):
        subs.update(cond.get("sub", []))
        subs.update(cond.get("sub_in", []))
    return all(a == "--help" or a in subs for a in cmd["args"])


def match_simple(rule, cmd, cwd):
    """True when a simple rule holds for cmd: its program and subcommand
    match, no unless_any condition holds, every when_all one does, and one
    when_any one does (or it has none)."""
    m = rule.get("match", {})
    progs = m.get("program")
    progs = [progs] if isinstance(progs, str) else (progs or [])
    if not m.get("any_program") and not prog_matches(cmd["prog"], progs):
        return False
    f = command_facts(cmd, cwd, m.get("sub", []))
    return f is not None and conditions_hold(rule, f)


def command_facts(cmd, cwd, want_sub):
    """The facts a condition reads about cmd, past the subcommand want_sub,
    or None when cmd's subcommand is not want_sub."""
    rest, flags, positionals, cpath = parse_args(cmd["args"], len(want_sub), cmd["prog"])
    if rest[: len(want_sub)] != want_sub:
        return None
    lead = cmd["args"][: len(cmd["args"]) - len(rest)]
    return {"env": cmd["env"], "assigns": cmd.get("assigns", []), "prog": cmd["prog"], "args": cmd["args"],
            "rest": rest[len(want_sub):], "lead": lead, "flags": flags,
            "positionals": positionals, "cpath": cpath, "cwd": cwd,
            "via_xargs": cmd.get("via_xargs", False)}


def conditions_hold(rule, f):
    """No unless_any condition holds, every when_all one does, and one
    when_any one does, or the rule has no when_any."""
    if any(cond_holds(c, f) for c in rule.get("unless_any", [])):
        return False
    if not all(cond_holds(c, f, block=True) for c in rule.get("when_all", [])):
        return False
    when_any = rule.get("when_any")
    return True if when_any is None else any(cond_holds(c, f, block=True) for c in when_any)
