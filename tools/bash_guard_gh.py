"""bash_guard_gh.py: gh command words as cobra reads them, for pass 2.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import re
import shlex


# gh's flags that take no value: at its root, then at a group such as pr.
# gh registers --help with no -h shorthand, so cobra gives -h the next word,
# and gh auth's commands read it as --hostname (gh auth -h github.com token).
GH_BOOL_FLAGS = ({"--help", "--version"}, {"--help"})


def gh_next_command(args, bools):
    """Where gh finds its next command word, as cobra's stripFlags reads one
    level: -- ends the scan; --x with no = and a two-character -x take the
    next word as their value, unless they are that level's bools; any other
    dash word (-ds, --x=v) takes nothing; the first word left is the
    command."""
    k = 0
    while k < len(args):
        a = args[k]
        if a == "--":
            return None
        if "=" not in a and a not in bools and (
                a.startswith("--") or (a.startswith("-") and len(a) == 2)):
            k += 2
        elif a and not a.startswith("-"):
            return k
        else:
            k += 1
    return None


def gh_cobra_order(cmd):
    """gh with its first two command words first and every other word after
    them in order, found as cobra finds them (gh_next_command), its opening
    assignments kept (gh_text), when that differs from the command as
    written. gh takes options before or between its command words (gh -R
    o/r pr --squash --admin merge 5), where a rule matched by subcommand
    does not look."""
    if cmd["prog"] != "gh":
        return []
    words, rest = gh_command_words(cmd["args"])
    out = [*words, *rest]
    return [gh_text(cmd, out)] if out != list(cmd["args"]) else []


def gh_text(cmd, args):
    """gh with args, after the NAME=value assignments the command opens with,
    so a reading keeps the reason a rule looks for (issue 708)."""
    lead = [f"{t.partition('=')[0]}={shlex.quote(t.partition('=')[2])}" for t in cmd.get("assigns", [])]
    return " ".join([*lead, shlex.join(["gh", *args])])


def gh_command_words(args):
    """gh's first two command words, found as cobra finds them, and every other
    word in order."""
    rest, words = list(args), []
    for bools in GH_BOOL_FLAGS:
        k = gh_next_command(rest, bools)
        if k is None:
            break
        words.append(rest.pop(k))
    return words, rest


GH_TEXT_OPTS = {"-A", "--author-email", "-b", "--body", "-F", "--body-file", "-t", "--subject"}


def gh_without_values(cmd):
    """gh in cobra's order (gh_command_words), its opening assignments kept,
    with each text option and its value taken out of the words after the
    command (-A x, --body x, -sb x, --subject=x), when it holds one. pflag gives the option the next word
    whatever it is, so in -A --match-head-commit --admin the --admin is a
    flag; the text a command sets changes no rule."""
    if cmd["prog"] != "gh":
        return []
    words, args = gh_command_words(cmd["args"])
    out, k = [], 0
    while k < len(args):
        a = args[k]
        if a == "--":
            out += args[k:]
            break
        if a in GH_TEXT_OPTS or (re.match(r"^-[A-Za-z]+$", a) and a[-1] in "AbFt"):
            k += 2
        elif a.partition("=")[0] in GH_TEXT_OPTS:
            k += 1
        else:
            out.append(a)
            k += 1
    return [gh_text(cmd, [*words, *out])] if len(out) < len(args) else []
