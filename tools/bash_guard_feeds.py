"""bash_guard_feeds.py: Text fed to a shell: stdin, heredocs, xargs, echo or printf in a pipe,
git aliases, and the commands bash reads differently (step 4).

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import re
import shlex

from bash_guard_program import program_of
from bash_guard_scan import decode_ansi_c
from bash_guard_words import (
    HEREDOC_MARK_RE,
    SHELLS,
    here_string,
    inline_code,
    prog_base,
    reads_program_from_stdin,
    resolve_subst,
    strip_redirects)


def bash_commands(text):
    """Scan's text (comments gone, $'..' decoded, heredoc bodies and $( ) set
    aside) split into commands of words with bash's own quote removal: in
    "..." a backslash goes only before ` $ " \\ or a newline; in '...'
    nothing changes; outside quotes a backslash goes and keeps the next
    character. Returns [(words, dq, sep)]; dq is true when a backslash before
    ` or $ inside "..." went, the one place the shell scan reads differently,
    and sep is the separator text after the command (|, ||, |&, ;, &, a
    newline...)."""
    r = BashWords(text)
    while r.i < r.n:
        ch = text[r.i]
        if r.q == "'":
            r.single(ch)
        elif r.q == '"':
            r.double(ch)
        else:
            r.bare(ch)
        r.i += 1
    r.end_command()
    return r.out


class BashWords:
    """bash_commands' reader: the commands so far, the current command's
    words and word, the open quote, and whether a backslash before ` or $
    went inside double quotes."""

    def __init__(self, text):
        self.text, self.i, self.n = text, 0, len(text)
        self.out, self.words, self.cur, self.inword = [], [], "", False
        self.q, self.dq = None, False

    def end_word(self):
        """Close the word being read, if one started."""
        if self.inword:
            self.words.append(self.cur)
        self.cur, self.inword = "", False

    def end_command(self, sep=""):
        """Close the command; a separator with no command before it joins the
        last one's, since || and |& are one separator."""
        self.end_word()
        if self.words:
            self.out.append((self.words, self.dq, sep))
        elif self.out:
            self.out[-1] = (*self.out[-1][:2], self.out[-1][2] + sep)  # || and |& are one separator
        self.words, self.dq = [], False

    def single(self, ch):
        """Inside '...': nothing changes until the closing quote."""
        if ch == "'":
            self.q = None
        else:
            self.cur += ch

    def double(self, ch):
        """Inside "...": a backslash goes only before ` $ " \\ or a newline."""
        text, i = self.text, self.i
        if ch == "\\" and i + 1 < self.n and text[i + 1] in '`$"\\\n':
            self.dq = self.dq or text[i + 1] in "`$"
            self.cur += "" if text[i + 1] == "\n" else text[i + 1]
            self.i += 1
        elif ch == '"':
            self.q = None
        else:
            self.cur += ch

    def bare(self, ch):
        """Outside quotes: a backslash goes and keeps the next character;
        blanks end a word and separators a command."""
        text, i = self.text, self.i
        if ch == "\\" and i + 1 < self.n:
            if text[i + 1] != "\n":
                self.cur, self.inword = self.cur + text[i + 1], True
            self.i += 1
        elif ch == "$" and i + 1 < self.n and text[i + 1] == '"':
            self.inword = True  # $"..." is bash's locale string: the same text as "..." untranslated
        elif ch in "'\"":
            self.q, self.inword = ch, True
        elif ch in " \t":
            self.end_word()
        elif ch in ";&|()\n":
            self.end_command(ch)
        else:
            self.cur, self.inword = self.cur + ch, True


def shell_texts(cmd):
    """The text a shell runs with -c, or eval runs, as one text."""
    if cmd["prog"] in SHELLS:
        code = inline_code(cmd)
        return [code] if code else []
    if cmd["prog"] == "eval" and cmd["args"]:
        return [" ".join(cmd["args"])]
    return []


# In an unquoted heredoc body bash drops a backslash before \, `, $ and a
# newline (the newline goes too), as it does inside "...".
HEREDOC_ESC_RE = re.compile(r"\\([\\`$\n])")


def is_pipe(sep):
    """True when sep pipes one command into the next: | or |&, not ||."""
    return sep.startswith("|") and not sep.startswith("||")


def stdin_shell(words, scan, programs):
    """True when the command of words is a shell that runs its stdin."""
    argv = [resolve_subst(w, scan) for w in words if not HEREDOC_MARK_RE.match(w)]
    cmd = program_of(strip_redirects(argv), programs)
    return cmd["prog"] in SHELLS and reads_program_from_stdin(cmd)


def piped_into_shell(commands, j, scan, programs):
    """True when a later stage of command j's pipeline (bash_commands) is a
    shell that runs its stdin. 2>&1 splits at its &, so a & after a word
    ending in > or < joins the next piece to this stage."""
    k = j
    while k + 1 < len(commands):
        words, _, sep = commands[k]
        glue = sep == "&" and words[-1].endswith((">", "<"))
        if not (glue or is_pipe(sep)):
            return False
        k += 1
        if not glue and stdin_shell(commands[k][0], scan, programs):
            return True
    return False


def stdin_texts(cmd, argv, piped):
    """The text a shell reads on stdin from a command bash_commands read
    exactly: a here-string fed to a shell that runs its stdin, and the words
    echo or printf pipe into one (piped), joined as pass 1 joins them."""
    if cmd["prog"] in SHELLS and reads_program_from_stdin(cmd):
        hs = here_string(argv)
        return [hs] if hs else []
    if cmd["prog"] in ("echo", "printf") and piped:
        said = " ".join(cmd["args"])
        return [decode_ansi_c(said) if cmd["prog"] == "printf" else said]
    return []


def heredoc_texts(cmds, scan):
    """The unquoted heredoc bodies a shell runs, as bash hands them on, where
    that differs from the body: cmds is one pipeline's [(cmd, heredoc
    numbers)], and a body counts when its command or a later stage is a
    shell that runs its stdin."""
    out = []
    for k, (cmd, docs) in enumerate(cmds):
        if not any(c["prog"] in SHELLS and reads_program_from_stdin(c) for c, _ in cmds[k:]):
            continue
        for doc in docs:
            quoted, body = scan.docs[doc] if doc < len(scan.docs) else (True, "")
            text = HEREDOC_ESC_RE.sub(lambda m: "" if m.group(1) == "\n" else m.group(1), body)
            if not quoted and text != body:
                out.append(text)
    return out


def xargs_texts(cmds):
    """The command an xargs stage runs when an earlier echo, printf or print
    stage hands it its words: echo . | xargs git restore -S -W runs
    git restore -S -W . (xargs appends the words), and with -I {} the words
    go where {} stands. cmds is one pipeline's [(cmd, docs)]."""
    out = []
    for k, (cmd, _) in enumerate(cmds):
        if cmd["prog"] not in ("echo", "printf", "print"):
            continue
        words = echoed_words(cmd)
        for c, _ in cmds[k + 1:]:
            if c["via_xargs"] and c["prog"]:
                out += xargs_commands(c, words)
    return out


def echoed_words(cmd):
    """The words an echo, printf or print stage writes, as xargs splits them."""
    said = " ".join(a for a in cmd["args"] if a != "--" and not re.match(r"^-[neEr]+$", a))
    said = decode_ansi_c(said) if cmd["prog"] == "printf" else said
    try:
        return shlex.split(said)
    except ValueError:
        return said.split()


def xargs_commands(c, words):
    """What xargs stage c runs with words: appended, and with -I {} in place."""
    out = [shlex.join([c["prog"], *c["args"], *words])]
    if "{}" in c["args"]:
        out.append(shlex.join([c["prog"], *[" ".join(words) if a == "{}" else a for a in c["args"]]]))
    return out


GIT_VALUE_OPTS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
                  "--config-env", "--super-prefix", "--attr-source"}


def git_alias_texts(cmd):
    """git with each -c alias.NAME=VALUE resolved before its command word,
    as git resolves it: git -c alias.r=restore r . runs git restore ., and a
    value starting with ! is shell text run with the words after it."""
    if prog_base(cmd["prog"]) != "git":
        return []
    args, aliases, out = list(cmd["args"]), {}, []
    for _ in range(5):  # an alias may name another alias
        k = collect_aliases(args, aliases)
        if k >= len(args) or args[k].lower() not in aliases:
            return out
        value = aliases.pop(args[k].lower())
        if value.startswith("!"):
            out.append(value[1:] + " " + shlex.join(args[k + 1:]))
            return out
        try:
            args = args[:k] + shlex.split(value) + args[k + 1:]
        except ValueError:
            return out
        out.append(shlex.join(["git", *args]))
    return out


def collect_aliases(args, aliases):
    """Add each -c alias.NAME=VALUE in git's leading options to aliases, and
    return the index of the command word after them."""
    k = 0
    while k < len(args) and args[k].startswith("-") and args[k] != "--":
        if args[k] == "-c" and k + 1 < len(args):
            name, eq, value = args[k + 1].partition("=")
            if eq and name.lower().startswith("alias."):
                aliases[name[6:].lower()] = value
        k += 2 if args[k] in GIT_VALUE_OPTS else 1
    return k


# Pass 2 only. echo's escapes as bash's echo -e and zsh's echo read them:
# \c ends the output, \0nnn is octal, \xHH hex, \uHHHH and \UHHHHHHHH code points.
ECHO_ESC_RE = re.compile(r"\\(c[\s\S]*|0[0-7]{0,3}|x[0-9A-Fa-f]{1,2}|u[0-9A-Fa-f]{1,4}|U[0-9A-Fa-f]{1,8}|[\s\S])")


ECHO_LETTERS = {"a": "\a", "b": "\b", "e": "\x1b", "E": "\x1b", "f": "\f", "n": "\n",
                "r": "\r", "t": "\t", "v": "\v", "\\": "\\"}


def decode_echo(text):
    """text with echo's escapes decoded; one echo -e does not know stays."""
    def one(m):
        e = m.group(1)
        if e[0] == "c":
            raise StopIteration
        if e[0] == "0":
            return chr(int(e[1:] or "0", 8) & 0xFF)
        if e[0] in "xuU" and len(e) > 1:
            return chr(min(int(e[1:], 16), 0x10FFFF))
        return ECHO_LETTERS.get(e, "\\" + e)
    out, pos = [], 0
    for m in ECHO_ESC_RE.finditer(text):
        out.append(text[pos:m.start()])
        try:
            out.append(one(m))
        except StopIteration:
            return "".join(out)
        pos = m.end()
    return "".join(out) + text[pos:]


def echo_pipe_texts(cmds):
    """The text an echo or printf stage pipes into a later shell that runs its
    stdin, where pass 1's reading (every word joined) differs: echo's leading
    option words (-n, -e, -E and clusters of them, as bash's and zsh's echo
    read them), zsh's print options and printf's -- dropped, and echo's escapes decoded too, since
    zsh's echo decodes them with no -e. cmds is one pipeline's [(cmd, docs)]."""
    out = []
    for k, (cmd, _) in enumerate(cmds):
        if cmd["prog"] not in ("echo", "printf", "print") or not shell_reads_later(cmds, k):
            continue
        if cmd["prog"] == "printf":
            out += printf_text(cmd["args"])
            continue
        said = " ".join(echo_words(cmd))
        seen = " ".join(cmd["args"]) if cmd["prog"] == "echo" else None  # pass 1 reads echo, not print
        out += [t for t in dict.fromkeys([said, decode_echo(said)]) if t != seen]
    return out


def shell_reads_later(cmds, k):
    """True when a stage after k is a shell that runs its stdin."""
    return any(c["prog"] in SHELLS and reads_program_from_stdin(c) for c, _ in cmds[k + 1:])


def printf_text(args):
    """printf -- TEXT: the text decoded; pass 1 reads any other printf."""
    return [decode_ansi_c(" ".join(args[1:]))] if args[:1] == ["--"] else []


def echo_words(cmd):
    """echo's words past its -n, -e and -E words; zsh's print past its
    options, where -f, -u, -C, -v, -x and -X take a value."""
    args = list(cmd["args"])
    while cmd["prog"] == "echo" and args and re.match(r"^-[neE]+$", args[0]):
        args.pop(0)
    while cmd["prog"] == "print" and args and args[0].startswith("-"):
        word = args.pop(0)  # zsh's print: -f, -u, -C, -v, -x and -X take a value
        if word in ("-", "--"):
            break
        if word[-1] in "fuCvxX":
            args = args[1:]
    return args
