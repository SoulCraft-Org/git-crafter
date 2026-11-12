"""bash_guard_args.py: Arguments: options, flags and their values, as a rule condition reads them.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import re


# Leading options (before a subcommand) whose next token is a value.
LEAD_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace",
                   "--prefix", "--filter", "--dir", "-w", "--workspace",
                   "--cwd", "--config"}


# Leading options that take a value for one program only. npm reads --env as
# a switch, so -e and --env cannot join the shared set above. Each set comes
# from the program's own --help.
PROGRAM_LEAD_VALUE_OPTS = {"wrangler": {"-e", "--env", "--profile", "--env-file"},
                           "security": {"-p"},
                           "comfy": {"--workspace", "--where"},
                           "runpodctl": {"-o", "--output"}}


# Options after the subcommand whose next token is a value, not a flag.
VALUE_OPTS = {"-m", "-F", "-C", "-c", "-t", "--message", "--file", "--author",
              "--date", "--template", "-o", "--push-option", "--repo", "-R",
              "--body", "-b", "--title", "--subject", "--match-head-commit"}


FALSE_VALUES = {"false", "0", "no", "off"}


def parse_args(args, sub_len, prog=""):
    """Split args into (rest, flags, positionals, -C path).

    rest is args after leading options. Its first sub_len tokens are the
    subcommand. flags and positionals come from the leading options and from
    everything after the subcommand.
    """
    value_opts = LEAD_VALUE_OPTS | PROGRAM_LEAD_VALUE_OPTS.get(prog, set())
    lead, i, cpath = lead_options(args, value_opts)
    rest = args[i:]
    flags, positionals = after_subcommand(rest[sub_len:], lead)
    return rest, flags, positionals, cpath


def lead_options(args, value_opts):
    """The options before the subcommand, with their values, the index after
    them, and the path -C names, if any. A -- ends them."""
    lead, i, cpath = [], 0, None
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        if args[i] == "--":  # end of options: what follows is never a value
            lead.append(args[i])
            i += 1
            break
        if args[i] in value_opts and i + 1 < len(args):
            if args[i] == "-C":
                cpath = args[i + 1]
            lead += [args[i], args[i + 1]]
            i += 2
            continue
        lead.append(args[i])
        i += 1
    return lead, i, cpath


def after_subcommand(tokens, lead):
    """The flags (lead's first) and positionals in tokens. A VALUE_OPTS
    option's value is neither; after --, every token is a positional."""
    flags, positionals, skip_next = list(lead), [], False
    ended = bool(lead) and lead[-1] == "--"
    for tok in tokens:
        if skip_next:
            skip_next = False
            continue
        if ended:
            positionals.append(tok)
            continue
        if tok == "--":
            flags.append(tok)
            ended = True
            continue
        if tok.startswith("-") and tok != "-":
            flags.append(tok)
            skip_next = tok in VALUE_OPTS
        else:
            positionals.append(tok)
    return flags, positionals


def has_flag(flags, flag, prefix=False, any_value=False, exempt=False):
    """True when flags hold flag. prefix (git, in a block condition): an
    abbreviation of a long option counts too, since git takes any
    unambiguous prefix (--no-verif is --no-verify, --har is --hard).
    --flag=false (or 0, no, off) is off, and the scan goes on, since a later
    copy may be on; with any_value the value is not a boolean
    (--force-with-lease=<ref>), so any value is on. For an exemption
    (exempt) an off copy ends the scan, as on main: a later on copy never
    switches an exemption on."""
    for f in flags:
        said = flag_says(f, flag, prefix, any_value, exempt)
        if said is not None:
            return said
    return False


def flag_says(f, flag, prefix, any_value, exempt):
    """What one copy f says about flag, as has_flag reads it: True, False,
    or None to go on to the next copy."""
    if f == flag:
        return True
    name, eq, value = f.partition("=")
    long = flag.startswith("--")
    if long and eq and (name == flag or (prefix and abbreviates(name, flag))):
        return value_on(value, any_value, exempt)
    if prefix and long and abbreviates(name, flag):
        return True
    return in_cluster(f, flag)


def abbreviates(name, flag):
    """True when the long option name is an abbreviation git takes for flag."""
    return name.startswith("--") and len(name) >= 3 and flag.startswith(name)


def value_on(value, any_value, exempt):
    """--flag=value: True when on; when off, False for an exemption (the scan
    ends) and None otherwise (the scan goes on)."""
    if any_value or value.lower() not in FALSE_VALUES:
        return True
    return False if exempt else None


def in_cluster(f, flag):
    """True when the short flag (-x) sits in a cluster of letters (-axb);
    None otherwise, so has_flag goes on."""
    if len(flag) == 2 and flag[0] == "-" and flag[1] != "-" \
            and re.match(r"^-[A-Za-z]{2,}$", f) and flag[1] in f[1:]:
        return True
    return None


def flag_value(args, flag):
    """The value given to a flag, or None when the flag is absent."""
    for k, tok in enumerate(args):
        if tok == flag:
            return args[k + 1] if k + 1 < len(args) else ""
        if tok.startswith(flag + "="):
            return tok.split("=", 1)[1]
    return None


def norm_path(p):
    """p without trailing slashes, with / kept as /."""
    return p if p == "/" else (p.rstrip("/") or "/")
