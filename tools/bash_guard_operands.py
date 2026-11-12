"""bash_guard_operands.py: The operands a command reads as files, past search patterns and
scripts, for a kind=path rule (step 5 of bash_guard.py).

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import re

from bash_guard_args import parse_args
from bash_guard_paths import names_credential, pattern_segments
from bash_guard_words import prog_base, strip_redirects


# How search tools take a pattern. A value-taking option is listed only when
# it always takes one: guessing wrong there would turn a file into a pattern.
# BSD grep's -C takes an optional value, so it is not listed.
GREP_GRAMMAR = {
    "pattern": {"-e", "--regexp"},
    "file": {"-f", "--file", "--exclude-from"},
    "value": {"-A", "-B", "-m", "-d", "-D", "--after-context", "--before-context",
              "--max-count", "--directories", "--devices", "--label", "--include",
              "--exclude", "--exclude-dir", "--binary-files"},
}


RG_GRAMMAR = {
    "pattern": {"-e", "--regexp"},
    "file": {"-f", "--file", "--ignore-file"},
    "value": {"-A", "-B", "-C", "-m", "-g", "-t", "-T", "-j", "-M", "-E", "-r", "-d",
              "--after-context", "--before-context", "--context", "--max-count",
              "--glob", "--iglob", "--type", "--type-not", "--type-add", "--threads",
              "--max-columns", "--encoding", "--replace", "--max-depth", "--sort",
              "--sortr", "--color", "--colors", "--pre-glob", "--max-filesize",
              "--engine", "--context-separator", "--path-separator"},
}


# sed and awk take their script the way grep takes its pattern: the first
# operand, unless -e or -f gave one. A -f script file is still a read.
SED_GRAMMAR = {
    "pattern": {"-e", "--expression"},
    "file": {"-f", "--file"},
    "value": {"--line-length"},
}


GSED_GRAMMAR = dict(SED_GRAMMAR, value={"-l", "--line-length"})


AWK_GRAMMAR = {"pattern": {"-e", "--source"},
               "file": {"-f", "--file", "-i", "--include", "-E", "--exec"},
               "value": {"-F", "-v", "--field-separator", "--assign"}}


SEARCHERS = {"grep": GREP_GRAMMAR, "egrep": GREP_GRAMMAR, "fgrep": GREP_GRAMMAR,
             "rg": RG_GRAMMAR, "sed": SED_GRAMMAR, "gsed": GSED_GRAMMAR,
             "awk": AWK_GRAMMAR, "gawk": AWK_GRAMMAR, "nawk": AWK_GRAMMAR}


# find: these options take a name pattern, not a file. With an -exec-style
# action, or with xargs later in the pipeline, find feeds what it finds to a
# program, so every start folder counts as read down to its leaves.
FIND_PATTERN_OPTS = {"-name", "-iname", "-path", "-ipath", "-wholename",
                     "-iwholename", "-regex", "-iregex", "-lname", "-ilname"}


# gh: these options take a jq filter or a Go template, not a file (gh api --jq .pem).
GH_FILTER_OPTS = ("--jq", "-q", "--template", "-t")


FIND_RUN_ACTIONS = {"-exec", "-execdir", "-ok", "-okdir"}


INPUT_REDIRECT_RE = re.compile(r"^\d*<>?(.*)$")


# Options with which a metadata program reads a file of names and prints
# each line back in its output or errors.
METADATA_READ_OPTS = {"file": {"-f", "--files-from"}}


# sed commands that name a file for the rest of their line: r, R, w and W,
# and the w flag of s///.
SED_FILE_RE = re.compile(r"(?<![A-Za-z])[rRwW][ \t]+(\S[^\n]*?)\s*$|/[gpeIimM0-9]*w[ \t]+(\S[^\n]*?)\s*$", re.M)


# Path-like literals in one-line code: a quoted string, or a bare ~ or $HOME path.
CODE_PATH_RE = re.compile(
    r"'([^'\n]{1,512})'|\"([^\"\n]{1,512})\"|((?:~|\$HOME|\$\{HOME\})/[^\s'\"`;)]+)")


def search_patterns(args, grammar):
    """Indexes of a search tool's args that are patterns or option values.

    The first operand is the pattern unless -e or -f gave one. What is left
    is a file the tool reads.
    """
    s = PatternScan(args, grammar)
    while s.k < len(args):
        a = args[s.k]
        if a == "--":
            s.end_of_options()
            break
        if a.startswith("--"):
            s.long_option(a)
        elif a.startswith("-") and a != "-":
            s.short_options(a)
        elif s.first is None:
            s.first = s.k
        s.k += 1
    if not s.given and s.first is not None:
        s.skip.add(s.first)
    return s.skip


class PatternScan:
    """search_patterns' walk: the index, the indexes to skip, whether -e or
    -f gave a pattern, and the first operand."""

    def __init__(self, args, grammar):
        self.args, self.grammar = args, grammar
        self.skip, self.given, self.first, self.k = set(), False, None, 0

    def kind_of(self, opt):
        """pattern, file or value for an option the grammar names, or None."""
        return next((t for t in ("pattern", "file", "value") if opt in self.grammar[t]), None)

    def end_of_options(self):
        """At --: the word after it is the first operand, if none came yet."""
        if self.first is None and self.k + 1 < len(self.args):
            self.first = self.k + 1

    def long_option(self, a):
        """--name or --name=value: a value that is not a file is skipped, so
        --include='*.pem' is a filter, not a file."""
        name, eq, _value = a.partition("=")
        kind = self.kind_of(name)
        self.given = self.given or kind in ("pattern", "file")
        if kind and not eq:
            if kind != "file":
                self.skip.add(self.k + 1)
            self.k += 1
        elif kind and kind != "file":
            self.skip.add(self.k)  # --include='*.pem' is a filter, not a file

    def short_options(self, a):
        """-xyz: the first letter the grammar names takes the rest of the
        word, or the next word when it ends the word."""
        for c in range(1, len(a)):
            kind = self.kind_of("-" + a[c])
            if kind:
                self.given = self.given or kind in ("pattern", "file")
                if c + 1 == len(a):  # the value is the next token
                    if kind != "file":
                        self.skip.add(self.k + 1)
                    self.k += 1
                break


def one_liner_code(args):
    """Code strings given with -c, -e, -E, --eval, -p or --print, and what
    follows the last one (operands the code reads)."""
    codes, after = [], len(args)
    for k, a in enumerate(args[:-1]):
        if a in ("-c", "-e", "-E", "--eval", "-p", "--print") \
                or re.match(r"^-[A-Za-z]+[ce]$", a):
            codes.append(args[k + 1])
            after = k + 2
    return codes, (args[after:] if codes else [])


def pattern_args(prog, args):
    """Indexes of args that are patterns, not files: a search tool's pattern
    and filters (git grep included), find's name tests and gh's --jq or --template."""
    if prog == "sed":  # BSD sed -i takes its backup suffix as its own word: -i '' or -i .bak
        return sed_pattern_args(args)
    if prog in SEARCHERS:
        return search_patterns(args, SEARCHERS[prog])
    if prog == "find":
        return {k + 1 for k, a in enumerate(args) if a in FIND_PATTERN_OPTS}
    if prog == "git":
        return git_grep_pattern_args(args)
    if prog == "gh":
        return gh_filter_args(args)
    return set()


def gh_filter_args(args):
    """gh's --jq and --template filters, as their own word or after =."""
    joined = tuple(o + "=" for o in GH_FILTER_OPTS)
    return {k + 1 for k, a in enumerate(args) if a in GH_FILTER_OPTS} | \
        {k for k, a in enumerate(args) if a.startswith(joined)}


def sed_pattern_args(args):
    """sed's scripts and option values, and BSD sed's -i backup suffix,
    which is its own word: -i '' or -i .bak."""
    suffix = {k for k in range(1, len(args))
              if args[k - 1] == "-i" and (args[k] == "" or args[k].startswith("."))}
    keep = [k for k in range(len(args)) if k not in suffix]
    return suffix | {keep[k] for k in search_patterns([args[k] for k in keep], SED_GRAMMAR)}


def git_grep_pattern_args(args):
    """git grep's patterns, past git's own leading options."""
    rest = parse_args(args, 0, "git")[0]
    lead = len(args) - len(rest)
    if rest[:1] == ["grep"]:
        return {lead + 1 + k for k in search_patterns(rest[1:], GREP_GRAMMAR)}
    return set()


def find_reads(args):
    """What find hands to a program: each start folder down to its leaves,
    narrowed by -name or -iname when given."""
    starts = []
    for a in args:
        if a.startswith(("-", "(", "!")):
            break
        starts.append(a)
    names = [args[k + 1] for k, a in enumerate(args[:-1]) if a in ("-name", "-iname")]
    return [s.rstrip("/") + "/**/" + n for s in (starts or ["."]) for n in (names or ["**"])]


def read_operands(rule, cmd, feeds=False):
    """Tokens a command may read as files.

    Every operand counts, and so does the text after = in one (if=PATH,
    --file=PATH) and after a leading @ (curl -F f=@PATH). A program on the
    rule's metadata list only looks at names, so its operands do not count.
    Input redirections and the tokens a wrapper or assignment took count for
    any program. Search patterns and find's name tests are not files. find
    with -exec, or feeding xargs, reads what it finds. A one-liner's path
    literals count too.
    """
    raw = cmd["raw"]
    out = input_redirect_reads(raw)
    prog, args = cmd["prog"], cmd["args"]
    if not prog:
        out.extend(loop_list(strip_redirects(raw)))
        return out  # no program runs: a for list or a bare assignment
    stripped = strip_redirects(raw)
    tokens = stripped[:max(0, len(stripped) - len(args) - 1)]  # before the program
    if prog not in rule.get("metadata", []):
        operands, named = operand_tokens(prog, args, feeds)
        tokens = tokens + operands
        out.extend(named)
    else:
        out.extend(metadata_reads(prog, args))
    out.extend(token_reads(tokens))
    out.extend(t[1:] for t in list(out) if t.startswith("@"))
    if prog_base(prog) in rule.get("code_readers", []):
        out.extend(code_paths(args))
    return out


def input_redirect_reads(raw):
    """The files input redirections read; a heredoc or here-string is data."""
    out = []
    for k, tok in enumerate(raw):
        if tok.startswith("<<"):
            continue  # heredoc or here-string: data, not a file
        m = INPUT_REDIRECT_RE.match(tok)
        if m:
            out.append(m.group(1) or (raw[k + 1] if k + 1 < len(raw) else ""))
    return out


def loop_list(words):
    """A for or select list's words, which the loop body may read."""
    for k, w in enumerate(words):
        if w in ("for", "select") and "in" in words[k + 1:]:
            return words[words.index("in", k + 1) + 1:]
    return []


def operand_tokens(prog, args, feeds):
    """For a program that reads its operands: the args that are not patterns,
    and the files a sed script names (1r FILE, $R FILE, w FILE, s///w FILE)
    or find hands to -exec or xargs."""
    skip = pattern_args(prog, args)
    tokens, named = [a for k, a in enumerate(args) if k not in skip], []
    if prog in ("sed", "gsed"):
        named.extend(sed_named_files(args, skip))
    if prog == "find" and (feeds or any(a in FIND_RUN_ACTIONS for a in args)):
        named.extend(find_reads(args))
    return tokens, named


def sed_named_files(args, skip):
    """The files sed's scripts (the args at skip) name: 1r FILE, $R FILE,
    w FILE and s///w FILE."""
    return [m.group(1) or m.group(2) for k in skip for m in SED_FILE_RE.finditer(args[k])]


def metadata_reads(prog, args):
    """What a metadata program reads anyway: file -f LIST prints LIST's lines."""
    out = []
    for k, a in enumerate(args):  # file -f LIST prints LIST's lines back
        name, eq, value = a.partition("=")
        if name in METADATA_READ_OPTS.get(prog, ()):
            out.append(value if eq else (args[k + 1] if k + 1 < len(args) else ""))
    return out


def token_reads(tokens):
    """Each token that is not an option, and the text after = in any."""
    out = []
    for tok in tokens:
        if tok == "--":
            continue
        if not tok.startswith("-") or tok == "-":
            out.append(tok)
        if "=" in tok:
            out.append(tok.split("=", 1)[1])
    return out


def code_paths(args):
    """The path literals in a one-liner's code."""
    out = []
    for code in one_liner_code(args)[0]:
        for m in CODE_PATH_RE.finditer(code):
            out.append(m.group(1) or m.group(2) or m.group(3))
    return out


def match_path(rule, cmd, cwd, feeds=False):
    """True when a command reads a path the kind=path rule lists."""
    patterns = [p for p in map(pattern_segments, rule["paths"]) if p]
    return any(names_credential(tok, cwd, patterns)
               for tok in read_operands(rule, cmd, feeds))
