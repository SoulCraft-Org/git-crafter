"""bash_guard_words.py: Words: shlex splitting on separators, redirections and the small
helpers every later step shares (step 2 of bash_guard.py).

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import functools
import re
import shlex


SHELLS = {"bash", "sh", "zsh", "dash", "fish", "ksh"}


INTERPRETERS = {"python", "python3", "node", "perl", "ruby"}


# A substitution a shell resolves to one word: $(which security), $(echo ~/x).
RESOLVE_RE = re.compile(
    r"^\s*(?:which|command\s+-v|type\s+-p|whence\s+-p|xcrun\s+(?:-f|--find)|echo|"
    r"printf\s+%s)\s+(['\"]?)([^\s'\";|&()`$]+)\1\s*$")


# An assignment word: NAME=, NAME+=, NAME[0]= and NAME[$k]+= all assign.
ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\+?=")


# The same word with nothing after the =, which is how shlex leaves an array
# assignment: NAME=(a b) arrives as NAME= and then ( as a separator.
ARRAY_HEAD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=$")


# Redirection operators, longest first. &>, 2>&1 and <&- are gone by now.
REDIR_RE = re.compile(r">>|>\||<<<|<<|<>|>|<")


# The file descriptor a word ends with, which belongs to the operator: 2>out.
FD_TAIL_RE = re.compile(r"(?:^|(?<=[\s;&|()\n]))(\d+)$")


SEPARATORS = set(";&|()\n")


SUBST_RE = re.compile(r"__SUBST(\d+)__")


HEREDOC_MARK_RE = re.compile(r"^__HEREDOC(\d+)__$")


def space_redirects(text):
    """text with a space around every unquoted redirection operator.

    bash ends a word at a redirection, so cmd>out runs cmd, and
    `git credential fill<req` is git credential fill. shlex's
    punctuation_chars holds no < or >, so without this the operator stays
    glued to the word and the command reads as a program nothing matches.
    An operator keeps the file descriptor the word ends with (2>out), so
    strip_redirects drops the pair. Quoted and backslash-escaped text is
    left alone, since bash keeps 'a>b' and a\\>b as one word too.
    """
    out, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if ch in "'\"":
            j = quoted_end(text, i)
            out.append(text[i:j])
            i = j
            continue
        if ch == "\\" and i + 1 < n:
            out.append(text[i:i + 2])
            i += 2
            continue
        m = REDIR_RE.match(text, i)
        if m:
            out = spaced_operator(out, m.group(0))
            i = m.end()
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def quoted_end(text, i):
    """The index after the quote that closes the one at i, or len(text).
    Only double quotes take a backslash escape."""
    q, j, n = text[i], i + 1, len(text)
    while j < n:
        if q == '"' and text[j] == "\\" and j + 1 < n:
            j += 2
            continue
        if text[j] == q:
            return j + 1
        j += 1
    return n


def spaced_operator(out, op):
    """out, the text so far, as two pieces: the text without the file
    descriptor it ends with, then the operator with that descriptor, spaced."""
    said = "".join(out)
    fd = FD_TAIL_RE.search(said)
    return [said[:fd.start(1)] if fd else said, " " + (fd.group(1) if fd else "") + op + " "]


# Issue 329: a long single-quoted span is held out of shlex, which reads it a
# character at a time, and put back in its token: in posix shlex its text is
# literal, so the tokens are the same. QUOTE_SPAN_RE walks the text as shlex
# quotes it; an unterminated quote stops the walk, so shlex reads the rest.
QUOTE_SPAN_RE = re.compile(r"""\\[\s\S]|"(?:[^"\\]|\\[\s\S])*"|'[^']*'|[^\\"']+|[\s\S]""")


HELD_RE = re.compile("\x00(\\d+)\x00")


def hold_long_single_quotes(text, longer_than=256):
    """text with each single-quoted span over longer_than characters written
    \\x00n\\x00, and the spans' text, n in order."""
    if "\x00" in text or len(text) <= longer_than:
        return text, []
    out, held = [], []
    for m in QUOTE_SPAN_RE.finditer(text):
        t = m.group(0)
        if t in ("'", '"'):
            out.append(text[m.start():])
            break
        if t[0] == "'" and len(t) > longer_than + 2:
            out.append(f"\x00{len(held)}\x00")
            held.append(t[1:-1])
        else:
            out.append(t)
    return "".join(out), held


def tokenize(text):
    """Split text into pipelines. Each pipeline is a list of raw argv lists.
    Both passes split the same scanned text, so the split is kept per text
    (issue 329) and each caller gets its own lists."""
    return [[list(raw) for raw in pipeline] for pipeline in tokenize_cached(text)]


@functools.lru_cache(maxsize=64)
def tokenize_cached(text):
    """tokenize_uncached's pipelines as tuples, kept for the last 64 texts."""
    return tuple(tuple(tuple(raw) for raw in pipeline) for pipeline in tokenize_uncached(text))


def tokenize_uncached(text):
    """Split scanned text into pipelines of raw argv lists, as tokenize says."""
    lex, held = word_lexer(text)
    split = PipelineSplit()
    for tok in lex:
        if held:
            tok = HELD_RE.sub(lambda m: held[int(m.group(1))], tok)
        split.take(tok)
    return split.finish()


def word_lexer(text):
    """A shlex lexer over text, after the rewrites shlex cannot make, and the
    long single-quoted spans held out of it."""
    text = text.replace("\\\n", " ")
    text = re.sub(r"(?<![\d<>&])1?>&(\d+|-)", r" > /dev/fd/\1 ", text)  # >&2: stdout leaves the pipe
    text = re.sub(r"\d*[<>]&\d*-?", " ", text)   # 2>&1, <&-
    text = re.sub(r"&>>?", " >", text)            # &> file
    text = re.sub(r"\\[()]", "__GROUP__", text)   # find's \( \), not a subshell
    text = space_redirects(text)
    text, held = hold_long_single_quotes(text)
    lex = shlex.shlex(text, posix=True, punctuation_chars=";&|()\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    return lex, held


class PipelineSplit:
    """Words in, pipelines out: a separator ends a command, | and |& join
    commands into one pipeline, and NAME=(a b)'s words go back into NAME=."""

    def __init__(self):
        self.pipelines, self.stages, self.cur = [], [], []
        self.array, self.words = 0, []

    def take(self, tok):
        """One word from the lexer."""
        if self.array:
            self.array_word(tok)
        elif tok and set(tok) <= SEPARATORS:
            self.separator(tok)
        else:
            self.cur.append(tok)

    def array_word(self, tok):
        """A word inside NAME=( ... ): shlex ended the word at the (, which is
        a separator here, so the words come back into the assignment."""
        if tok == "(":
            self.array += 1
        elif tok == ")":
            self.array -= 1
            if not self.array:
                self.cur[-1] += "(" + " ".join(self.words) + ")"
                self.words = []
                return
        self.words.append(tok)

    def separator(self, tok):
        """; & | ( ) or a newline: end the command, and the pipeline unless
        it is a pipe."""
        if tok == "(" and self.cur and ARRAY_HEAD_RE.match(self.cur[-1]):
            self.array, self.words = 1, []
            return
        if self.cur:
            self.stages.append(self.cur)
            self.cur = []
        if tok in ("|", "|&"):
            return
        if self.stages:
            self.pipelines.append(self.stages)
            self.stages = []

    def finish(self):
        """The pipelines, with the last command and an unterminated array."""
        if self.array and self.cur:  # unterminated: keep what the array held
            self.cur[-1] += "(" + " ".join(self.words) + ")"
        if self.cur:
            self.stages.append(self.cur)
        if self.stages:
            self.pipelines.append(self.stages)
        return self.pipelines


def strip_redirects(argv):
    """Drop redirections, which bash never passes to the program."""
    out, skip = [], False
    for tok in argv:
        if skip:
            skip = False
            continue
        if re.match(r"^\d*(>>?|<<?<?|<>|>\|)$", tok):
            skip = True
            continue
        if re.match(r"^\d*(>>?|<<?<?|<>)\S", tok):
            continue
        out.append(tok)
    return out


def here_string(argv):
    """The text of a here-string (<<< word), or None."""
    for k, tok in enumerate(argv):
        if tok == "<<<" and k + 1 < len(argv):
            return argv[k + 1]
        if tok.startswith("<<<") and len(tok) > 3:
            return tok[3:]
    return None


def skip_opts(argv, j, value_opts):
    """The index of the first operand at or after j, past options, the
    values of value_opts, and a -- that ends them."""
    while j < len(argv) and argv[j].startswith("-") and argv[j] != "-":
        tok = argv[j]
        j += 1
        if tok == "--":
            break
        if tok in value_opts:
            j += 1
    return j


def rule_programs(rules):
    """Every program a rule names: match.program, upstream and downstream."""
    names = set()
    for r in rules:
        p = r.get("match", {}).get("program")
        names.update([p] if isinstance(p, str) else (p or []))
        names.update(r.get("upstream", []))
        names.update(r.get("downstream", []))
    return names


def reads_program_from_stdin(cmd):
    """True when an interpreter will run whatever arrives on stdin."""
    args = cmd["args"]
    if cmd["via_xargs"] and cmd["prog"] in SHELLS:
        return True  # xargs hands stdin to the shell as its script
    if names_inline_script(cmd["prog"], args):
        return False
    if any(re.match(r"^-[A-Za-z]*s[A-Za-z]*$", a) for a in args):
        return True
    positionals = [a for a in args if not a.startswith("-") or a == "-"]
    return not positionals or positionals[0] == "-"


def names_inline_script(prog, args):
    """True when args give the script on the command line: a shell's -c in
    any cluster of letters, or -c, -e, --eval or -m."""
    if prog in SHELLS and any(re.match(r"^-[A-Za-z]*c[A-Za-z]*$", a) for a in args):
        return True
    return any(a in ("-c", "-e", "--eval", "-m") for a in args)


def inline_code(cmd):
    """The script string an interpreter gets with -c or -e, or None."""
    args = cmd["args"]
    pattern = r"^-[A-Za-z]*c[A-Za-z]*$" if cmd["prog"] in SHELLS else r"^-(c|e|-eval)$"
    for k, a in enumerate(args):
        if re.match(pattern, a) and k + 1 < len(args):
            return args[k + 1]
        if not a.startswith("-"):
            return None
    return None


def prog_base(prog):
    """A program name without a version suffix: python3.12 is python."""
    return re.sub(r"(?<=[A-Za-z])[0-9.]+$", "", prog)


def prog_matches(prog, names):
    """True when prog, or prog without its version suffix, is in names."""
    return prog in names or prog_base(prog) in names


def resolve_subst(tok, scan):
    """$(which X), $(command -v X) and $(echo X) as the one word they print."""
    def one(m):
        k = int(m.group(1))
        if k < len(scan.subs):
            r = RESOLVE_RE.match(scan.subs[k][1])
            if r:
                return r.group(2)
        return m.group(0)
    return SUBST_RE.sub(one, tok)
