"""bash_guard_issuer.py: kind=issuer rules, which judge a whole pipeline.

Part of tools/bash_guard.py, which says how the guard reads a command. A key
passes only from its issuer, piped straight into its store, and the store
reads only that pipe or a fresh value: never a file, a heredoc, a typed word
or any other program's output. The one exception is a secret the rule names
as no key (store.not_keys), which may read one file on stdin.
"""

import re

from bash_guard_gh import gh_command_words

STDOUT_REDIRECT_RE = re.compile(r"^(1|&)?>")  # >, >>, 1>, &>, >&2: stdout leaves the pipe
STDIN_REDIRECT_RE = re.compile(r"^0?<")  # < file, <<< word: stdin from the command line or disk
FILE_STDIN_RE = re.compile(r"^0?<(?!<)")  # < file alone: never <<< word or <<EOF
VALUE_FLAGS = {"-R", "--repo", "-o", "--org", "-e", "--env", "-a", "--app", "-v", "--visibility", "-r", "--repos"}
TEXT_FLAGS = {"-b", "--body", "-f", "--env-file"}  # the value, or a file of many, in the command


def is_source(c, src):
    """The command is src's program with args that match src's regex."""
    return c["prog"] == src["program"] and re.search(src["regex"], " ".join(c["args"])) is not None


def is_store(c, rule):
    """The command is the rule's store, its command words read as gh reads
    them (gh -R o/r secret set X is a store too)."""
    sub = rule["store"]["sub"]
    if c is None or c["prog"] != rule["store"]["program"]:
        return False
    words = gh_command_words(c["args"])[0] if c["prog"] == "gh" else c["args"][:len(sub)]
    return words == sub


def issuer_ok(cmds, k, rule):
    """The issuer pipes, stdout unredirected, into the last stage: its store."""
    store = cmds[k + 1] if k + 1 == len(cmds) - 1 else None
    return is_store(store, rule) and not any(STDOUT_REDIRECT_RE.match(t) for t in cmds[k]["raw"])


def store_name(args):
    """The name gh secret set sets: its first word that is no flag or a
    flag's value."""
    rest, k = gh_command_words(args)[1], 0
    while k < len(rest):
        if rest[k] in VALUE_FLAGS:
            k += 2
        elif rest[k].startswith("-"):
            k += 1
        else:
            return rest[k]
    return None


def not_key_from_file(cmds, k, rule):
    """A secret the rule's store.not_keys names (data, never a credential)
    may read one file on stdin, alone in its pipeline: < path. Never a pipe,
    a here-string, a heredoc or a flag's text, which put the value in the
    command; never the file flag, which can read many."""
    c = cmds[k]
    if k or len(cmds) != 1 or c["docs"] or store_name(c["args"]) not in rule["store"].get("not_keys", []):
        return False
    stdin = [t for t in c["raw"] if STDIN_REDIRECT_RE.match(t)]
    return len(stdin) == 1 and FILE_STDIN_RE.match(stdin[0]) is not None \
        and not any(a in TEXT_FLAGS or a.split("=")[0] in TEXT_FLAGS for a in c["args"])


def store_ok(cmds, k, rule):
    """The store reads only a pipe from its issuer or a fresh value, whose
    stdout goes nowhere else."""
    c = cmds[k]
    if not_key_from_file(cmds, k, rule):
        return True
    if not k or c["docs"] or any(STDIN_REDIRECT_RE.match(t) for t in c["raw"]):
        return False
    if any(STDOUT_REDIRECT_RE.match(t) for t in cmds[k - 1]["raw"]):
        return False
    sources = [rule["issuer"], *rule["store"]["fresh"]]
    return any(is_source(cmds[k - 1], src) for src in sources)


def issuer_breaks(cmds, rule):
    """True when a pipeline's issuer or store breaks the rule."""
    for k, c in enumerate(cmds):
        if is_source(c, rule["issuer"]) and not issuer_ok(cmds, k, rule):
            return True
        if is_store(c, rule) and not store_ok(cmds, k, rule):
            return True
    return False


def issuer_hits(cmds, rules):
    """The issuer rules a pipeline breaks."""
    return [rule for rule in rules if issuer_breaks(cmds, rule)]
