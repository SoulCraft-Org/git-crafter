"""bash_guard_paths.py: Path patterns: home folding, brace lists, globs and whether a token
names a credential path (step 5 of bash_guard.py).

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import os
import re


HOME_PREFIX_RE = re.compile(r"^(~[A-Za-z0-9_.-]*|\$HOME|\$\{HOME\})(?=/|$)")


USERS_RE = re.compile(r"^/Users/[^/]+(?=/|$)")


BRACE_RE = re.compile(r"\{([^{}]*,[^{}]*)\}")


CLASS_RE = re.compile(r"\[[^\]]*\]")


GLOB_RE = re.compile(r"[*?\[]")


GLOB_SPLIT_RE = re.compile(r"\[[^\]]*\]|[*?]")


# A glob whose own name says what it holds: certs/key* can be key.pem.
CRED_HINT_RE = re.compile(r"(?i)key|cert|secret|token|cred|priv|passw")


MAX_PATH = 1024


def seq_overlap(a, b, star, same):
    """True when two pattern sequences can describe one value.

    star marks an element that stands for any run of the other side's
    elements; same compares two other elements. Iterative, so a long token
    cannot exhaust the stack.
    """
    la, lb = len(a), len(b)
    nxt = [False] * lb + [True]
    for j in range(lb - 1, -1, -1):
        nxt[j] = b[j] == star and nxt[j + 1]
    for i in range(la - 1, -1, -1):
        nxt = overlap_row(a[i], b, nxt, star, same)
    return nxt[0]


def overlap_row(x, b, nxt, star, same):
    """seq_overlap's row for one element x of a, from the row after it."""
    lb = len(b)
    cur = [False] * lb + [x == star and nxt[lb]]
    for j in range(lb - 1, -1, -1):
        if x == star:
            cur[j] = nxt[j] or cur[j + 1]
        elif b[j] == star:
            cur[j] = cur[j + 1] or nxt[j]
        else:
            cur[j] = same(x, b[j]) and nxt[j + 1]
    return cur


def glob_overlap(tok, pat):
    """True when one file name can match both the token and the pattern."""
    tok, pat = CLASS_RE.sub("?", tok), CLASS_RE.sub("?", pat)
    if tok[:1] in ("*", "?") and pat[:1] == ".":
        return False  # a shell glob skips dot files
    if not any(c in "*?" for c in tok + pat):
        return tok == pat
    return seq_overlap(tok, pat, "*", lambda x, y: x == y or "?" in (x, y))


def brace_expand(tok, limit=64):
    """~/.{zshrc,zprofile} as the shell expands it, up to limit words."""
    out, todo = [], [tok]
    while todo and len(out) < limit:
        t = todo.pop()
        m = BRACE_RE.search(t)
        if not m:
            out.append(t)
            continue
        todo.extend(t[:m.start()] + part + t[m.end():] for part in m.group(1).split(","))
    return out


def fold_home(path):
    """Segments of a normalized absolute path, any home folder as '~'."""
    home = os.path.expanduser("~").rstrip("/")
    if home and (path == home or path.startswith(home + "/")):
        rest = path[len(home):]
    else:
        m = USERS_RE.match(path)
        if not m:
            return path.split("/")  # ['', 'etc', 'hosts']
        rest = path[m.end():]
    return ["~"] + [s for s in rest.split("/") if s]


def token_segments(tok, cwd):
    """The path a token names, as segments, or None when it names none.

    ~, ~user, $HOME, ${HOME} and /Users/<name> all fold to '~', so another
    account's home counts too. A relative path resolves against cwd; with no
    known folder it starts with '**' and only anywhere patterns apply.
    """
    if not tok or len(tok) > MAX_PATH or "://" in tok or "\n" in tok:
        return None
    m = HOME_PREFIX_RE.match(tok)
    if m:
        path = "/Users/_" + tok[m.end():]
    elif tok.startswith("/"):
        path = tok
    elif cwd:
        path = os.path.join(cwd, tok)
    else:
        return ["**"] + [s for s in os.path.normpath(tok).split("/") if s not in ("", ".")]
    return fold_home(os.path.normpath(path))


def pattern_segments(p):
    """A credential path in PLAN.md's notation, as segments, or None.

    ~/x is under the home folder, //**/x is anywhere on disk, //x is
    absolute, and ** stands for any number of folders.
    """
    if p.startswith("//"):
        segs = [s for s in p[2:].split("/") if s]
        return segs if segs[:1] == ["**"] else [""] + segs
    if p == "~" or p.startswith("~/"):
        return ["~"] + [s for s in p[2:].split("/") if s]
    return None


def literal_stem(seg):
    """The first literal run of a pattern segment: .pem in *.pem, .env. in
    .env.*.local. A glob names an anywhere credential only when it carries
    that text itself, as *.pem, .env* and certs/*.pem do."""
    return next((s for s in GLOB_SPLIT_RE.split(seg) if s), "")


def names_credential(tok, cwd, patterns):
    """True when a token names a path that matches one of the patterns."""
    for t in brace_expand(tok):
        segs = token_segments(t, cwd)
        if not segs:
            continue
        for p in patterns:
            if pattern_skips(segs, p):
                continue
            if seq_overlap(segs, p, "**", glob_overlap):
                return True
    return False


def pattern_skips(segs, p):
    """True when pattern p cannot apply to a token's segments, before any
    match: an unknown folder meets only anywhere patterns, a bare * names no
    file in particular, and *.config.* meets *.pem only through its
    wildcard, though key* does."""
    if segs[0] == "**" and p[0] != "**":
        return True
    if p[0] != "**":
        return False
    last = CLASS_RE.sub("?", segs[-1])
    if set(last) <= {"*", "?"}:
        return True
    return bool(GLOB_RE.match(p[-1]) and segs[-1].endswith("*")
                and literal_stem(p[-1]) not in last and not CRED_HINT_RE.search(segs[-1]))


def next_cwd(prog, args, cwd):
    """The folder after cd or pushd, or None when the guard cannot follow it."""
    target = cd_target(prog, args)
    if target is None or "$" in target or not (cwd or target.startswith("/")):
        return None
    return os.path.normpath(os.path.join(cwd or "/", target))


def cd_target(prog, args):
    """Where cd or pushd goes: ~ for a bare cd, the one argument (not -),
    with $HOME read as ~, or None."""
    target = "~" if prog == "cd" and not args else (
        args[0] if len(args) == 1 and args[0] != "-" else None)
    if target is not None:
        m = HOME_PREFIX_RE.match(target)
        if m and m.group(1).startswith("$"):
            target = "~" + target[m.end():]  # cd "$HOME/x"
        target = os.path.expanduser(target)
    return target
