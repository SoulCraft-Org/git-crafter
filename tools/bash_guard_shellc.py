"""bash_guard_shellc.py: The text a shell's -c option runs, by each shell's own option grammar.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

from bash_guard_words import SHELLS, inline_code, prog_base


# Pass 2 only. How each shell reads the option words before its -c command:
# (letters that take a value, a value may be the rest of its word, a word
# starting with - or + is never a value, long options that take one).
SHELL_OPTION_GRAMMARS = (
    ("oO", False, False, {"--rcfile", "--init-file"}),  # bash, sh: -o pipefail, -O extglob
    ("o", True, False, {"--emulate"}),                  # zsh: -opipefail, --emulate sh
    ("o", True, True, set()),                           # ksh: -o -c lists options first
)


FISH_VALUE_SHORT, FISH_VALUE_LONG = "cCdof", {"--command", "--init-command", "--debug",
                                              "--debug-output", "--features", "--profile",
                                              "--profile-startup"}


def shell_command_word(args, letters, rest_value, dash_not_value, long_values):
    """The word a POSIX shell runs as its -c command under one grammar, or
    None. Options are the words before the first other word, a lone - or
    --; in each, c sets the command flag anywhere (-ec, +c, -co), and each
    of letters takes the next word as its value (-coo pipefail errexit). The
    command is the first word after the options, so -c -e cmd runs cmd."""
    k, has_c = 0, False
    while k < len(args):
        a = args[k]
        k += 1
        if a in ("-", "--"):
            break
        if a.startswith("--"):
            k += a in long_values
            continue
        if len(a) < 2 or a[0] not in "-+":
            k -= 1
            break
        c, want = option_cluster(a, letters, rest_value)
        has_c = has_c or c
        k = skip_values(args, k, want, dash_not_value)
    return args[k] if has_c and k < len(args) else None


def option_cluster(a, letters, rest_value):
    """For one option word (-ec, -coo): whether it holds c, and how many of
    the next words it takes as values. With rest_value, a value letter with
    text after it takes that text instead, and ends the word."""
    has_c, want = False, 0
    for i, ch in enumerate(a[1:], 1):
        if ch == "c":
            has_c = True
        elif ch in letters:
            if rest_value and i + 1 < len(a):
                break
            want += 1
    return has_c, want


def skip_values(args, k, want, dash_not_value):
    """The index past want option values from k. With dash_not_value, a
    word starting with - or + is never one."""
    for _ in range(want):
        if k < len(args) and not (dash_not_value and args[k][:1] in ("-", "+")):
            k += 1
    return k


def fish_command_words(args):
    """fish's -c and -C (--command, --init-command) values, read as getopt
    reads them: -cX, -c X, -ic X, --command=X, --command X."""
    out, k = [], 0
    while k < len(args) and args[k].startswith("-") and args[k] != "--":
        a, k = args[k], k + 1
        read = fish_long_option if a.startswith("--") else fish_short_options
        value, k, command = read(a, args, k)
        if command:
            out.append(value)
    return out


def fish_long_option(a, args, k):
    """One fish --option: its value, the index after it, and whether it
    gives a command (--command, --init-command)."""
    name, eq, value = a.partition("=")
    if name in FISH_VALUE_LONG and not eq and k < len(args):
        value, k = args[k], k + 1
    return value, k, name in ("--command", "--init-command")


def fish_short_options(a, args, k):
    """One fish -xyz cluster: the first value letter's value (the rest of
    the word, or the next word), the index after it, and whether that
    letter is c or C."""
    for i, ch in enumerate(a[1:], 1):
        if ch in FISH_VALUE_SHORT:
            value = a[i + 1:]
            if not value and k < len(args):
                value, k = args[k], k + 1
            return value, k, ch in "cC"
    return None, k, False


def shell_c_texts(cmd):
    """Pass 2: the command strings a shell may run with -c where pass 1's
    inline_code reads another word or none: bash -o pipefail -c 'cmd',
    bash -c -e 'cmd', zsh -opipefail -c 'cmd'. Every grammar in
    SHELL_OPTION_GRAMMARS is tried, since sh may be any of them; fish's -c
    and -C values are read as getopt reads them."""
    prog = prog_base(cmd["prog"])
    if prog not in SHELLS:
        return []
    args = list(cmd["args"])
    if prog == "fish":
        found = fish_command_words(args)
    else:
        found = [shell_command_word(args, *g) for g in SHELL_OPTION_GRAMMARS]
    seen = inline_code(cmd) if cmd["prog"] in SHELLS else None
    return [s for s in dict.fromkeys(found) if s is not None and s != seen]
