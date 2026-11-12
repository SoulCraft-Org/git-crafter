"""bash_guard_evaluate.py: Both passes over a command, and the hits they find.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import os
import re
import shlex

from bash_guard_code import embedded_shell, kept_texts
from bash_guard_conditions import help_skips, match_simple
from bash_guard_feeds import (
    bash_commands,
    echo_pipe_texts,
    git_alias_texts,
    heredoc_texts,
    piped_into_shell,
    shell_texts,
    stdin_texts,
    xargs_texts)
from bash_guard_gh import gh_cobra_order, gh_without_values
from bash_guard_issuer import issuer_hits
from bash_guard_literals import leading_literals, literal_prefix, resolved
from bash_guard_operands import match_path
from bash_guard_paths import next_cwd
from bash_guard_program import program_of, script_view
from bash_guard_scan import Scan, decode_ansi_c
from bash_guard_shellc import shell_c_texts
from bash_guard_words import (
    HEREDOC_MARK_RE,
    INTERPRETERS,
    SHELLS,
    SUBST_RE,
    here_string,
    inline_code,
    reads_program_from_stdin,
    resolve_subst,
    rule_programs,
    strip_redirects,
    tokenize)


REMOTE_RE = re.compile(r"^\s*(\S*/)?(curl|wget)\b")


CAT_HEREDOC_RE = re.compile(r"^\s*cat\s+__HEREDOC(\d+)__\s*$")


# Pass 2 only (issue 272): quoted and escaped text kept, a bare $ before " dropped,
# since bash reads an unquoted $"..." (a locale string) as "...".
LOCALE_RE = re.compile(r"""('[^']*'|"(?:[^"\\]|\\[\s\S])*"|\\[\s\S])|\$(?=")""")


def kept_hits(command, rules, cwd=None, depth=0):
    """Pass 2: the hits of every kept_texts, gh_cobra_order, gh_without_values and
    shell_c_texts text in command, its $( ) substitutions included, and, for each
    command that bash reads differently from the shell scan (bash_commands), its
    kept_texts and the text its shell -c or eval runs, read as bash hands
    them on. Each text is checked on its own, and one that will not parse,
    or fails in any other way, is skipped. Issuer rules judge a whole
    pipeline, which pass 2's one-command texts never show, so pass 1 alone
    runs them."""
    if depth > 4:
        return []
    try:
        scan = Scan(command)
        texts = [scan.run()] + [inner for kind, inner in scan.subs if kind == "scanned"]
    except Exception:
        return []
    if re.search(r"\b(?:cd|pushd|popd)\b", command):
        cwd = None  # main follows cd; pass 2 does not
    reader = KeptReader([r for r in rules if r.get("kind") != "issuer"], cwd, depth, scan)
    for text in texts:
        reader.prefix = literal_prefix(leading_literals(text))
        reader.stages(text)
        reader.bash_reads(text)
    return reader.hits


class KeptReader:
    """Pass 2 over one scan: the rules, the folder, the depth, the hits so
    far, and the opening literals of the text being read. Each text is read in its shell stages, then as bash reads it."""

    def __init__(self, rules, cwd, depth, scan):
        self.rules, self.cwd, self.depth, self.scan = rules, cwd, depth, scan
        self.programs, self.hits, self.prefix = rule_programs(rules), [], ""

    def read(self, cmd, *makers):
        """Evaluate every text each maker finds in cmd, after the literals its
        text opens with (bash_guard_literals.py); a maker or a text that fails
        is skipped."""
        for make in makers:
            try:
                texts_ = make(cmd)
            except Exception:
                continue
            for s in texts_:
                try:
                    self.hits.extend(evaluate(self.prefix + s, self.rules, self.cwd, self.depth + 1))
                except Exception:
                    pass

    def stages(self, text):
        """Each pipeline of the shell scan's text, when it splits."""
        try:
            stages = tokenize(text)
        except Exception:
            stages = []
        for pipeline in stages:
            self.pipeline(pipeline)

    def pipeline(self, pipeline):
        """Each command's kept texts, then the pipeline's heredoc, echo and
        xargs texts."""
        scan, cmds = self.scan, []
        for raw in pipeline:
            argv = [resolve_subst(tok, scan) for tok in raw if not HEREDOC_MARK_RE.match(tok)]
            cmd = program_of(strip_redirects(argv), self.programs)
            self.read(cmd, kept_texts, gh_cobra_order, gh_without_values, shell_c_texts, git_alias_texts)
            cmds.append((cmd, [int(m.group(1)) for m in map(HEREDOC_MARK_RE.match, raw) if m]))
        self.read(cmds, lambda c: heredoc_texts(c, scan), echo_pipe_texts, xargs_texts)

    def bash_reads(self, text):
        """The commands bash reads differently from the shell scan."""
        try:  # bash reads text differently only after a backslash before ` or $ (issue 329)
            commands = bash_commands(text) if "\\`" in text or "\\$" in text else []
        except Exception:
            commands = []
        for j, (words, dq, _) in enumerate(commands):
            if not dq:
                continue
            self.bash_command(commands, j, words)

    def bash_command(self, commands, j, words):
        """One such command's kept texts, and the text its shell -c, eval or
        stdin runs, read as bash hands them on."""
        scan, programs = self.scan, self.programs
        argv = [resolve_subst(w, scan) for w in words if not HEREDOC_MARK_RE.match(w)]
        self.read(program_of(strip_redirects(argv), programs), lambda c: kept_texts(c, exact=True), shell_texts, shell_c_texts,
                  lambda c: stdin_texts(c, argv, piped_into_shell(commands, j, scan, programs)))


def kept_hits_safe(command, rules, cwd=None, depth=0):
    """kept_hits, with any error read as no hits: pass 2 never takes away a
    pass-1 hit, nor turns main's verdict into a crash. A command with an
    unquoted $"..." is also read whole with it written "..." (issue 272)."""
    hits = []
    try:
        hits += kept_hits(command, rules, cwd, depth)
    except Exception:
        pass
    plain = LOCALE_RE.sub(lambda m: m.group(1) or "", command) if depth <= 4 else command
    if plain != command:
        try:
            hits += evaluate(plain, rules, cwd, depth + 1)
        except Exception:
            pass
    return hits


def evaluate(command, rules, cwd=None, depth=0):
    """Return [(rule id, why, fix)] for every rule the command breaks. Two
    passes, and either one blocks: evaluate_main is main's reading, kept
    unchanged, and kept_hits adds what it misses in one-liners and in
    gh -R. When main's reading fails on the command, pass 2's hits still
    block, and so do those of the first lines that parse (whole_lines_hits);
    with none, the error goes on to the caller as before. Each hit is listed
    once."""
    try:
        hits = evaluate_main(command, rules, cwd, depth)
    except Exception:
        extra = kept_hits_safe(command, rules, cwd, depth) or whole_lines_hits(command, rules, cwd, depth)
        if extra:
            return list(dict.fromkeys(extra))
        raise
    return list(dict.fromkeys(hits + kept_hits_safe(command, rules, cwd, depth)))


def whole_lines_hits(command, rules, cwd=None, depth=0):
    """Issue 108: the hits of the longest run of command's first lines that
    parses, when the whole will not. A shell runs each complete line before it
    reaches one it cannot parse, so git reset --hard on line 1 runs though
    line 2 holds an unbalanced quote. A single line is never cut: a shell
    parses it whole and runs none of it."""
    lines = command.split("\n")
    for k in range(min(len(lines) - 1, 64), 0, -1):
        try:
            return evaluate("\n".join(lines[:k]), rules, cwd, depth + 1)
        except Exception:
            continue
    return []


def evaluate_main(command, rules, cwd=None, depth=0):
    """Return [(rule id, why, fix)] for every rule the command breaks."""
    scan = Scan(command)
    text = scan.run()
    return eval_scanned(text, scan, rules, cwd, depth, top=True)


def eval_scanned(text, scan, rules, cwd, depth, top=False):
    """Evaluate scanned text. top=True also checks the scan's heredocs and
    substitutions, which every nested call shares."""
    if depth > 4:
        return []
    ev = ScannedEval(scan, rules, cwd, depth)
    if top:
        ev.literals = leading_literals(text)
        ev.heredoc_body_hits()
        ev.substitution_hits()
    for stages in tokenize(text):
        ev.pipeline(stages)
    return first_of_each(ev.hits)


def first_of_each(hits):
    """hits with each rule id kept once, at its first place."""
    seen, unique = set(), []
    for h in hits:
        if h[0] not in seen:
            seen.add(h[0])
            unique.append(h)
    return unique


class ScannedEval:
    """eval_scanned's state over one scanned text: the hits so far, the
    folder a cd moved to, the previous pipeline's raw words (for process
    substitution), each for or select variable's words, and the literals
    the text opens with (bash_guard_literals.py). One method per
    block of the old body, called in its order."""

    def __init__(self, scan, rules, cwd, depth):
        self.scan, self.rules, self.cwd, self.depth = scan, rules, cwd, depth
        self.hits, self.prev_raw, self.loop_vars, self.literals = [], None, {}, {}
        self.remote = [r for r in rules if r.get("kind") == "pipe"]
        self.upstreams = {p for r in self.remote for p in r["upstream"]}
        self.issuers = [r for r in rules if r.get("kind") == "issuer"]
        self.programs = rule_programs(rules)

    def hit(self, rule):
        """Record one rule's hit."""
        self.hits.append((rule["id"], rule["why"], rule.get("fix")))

    def runs_remote(self, s):
        """True when s runs curl or wget's output: $(curl ...) or a
        substitution that starts with one."""
        if s is None:
            return False
        if re.search(r"(\$\(|`)\s*(\S*/)?(curl|wget)\b", s):
            return True
        return any(k < len(self.scan.subs) and REMOTE_RE.match(self.scan.subs[k][1])
                   for k in map(int, SUBST_RE.findall(s)))

    def run_text(self, s):
        """Text a shell will run: the pipe rules when it runs a download, a
        $(cat <<EOF ... EOF) body as a script, then the text itself."""
        scan = self.scan
        if self.runs_remote(s):
            for rule in self.remote:
                self.hit(rule)
        for k in map(int, SUBST_RE.findall(s)):  # $(cat <<EOF ... EOF) as a script
            if k < len(scan.subs):
                m = CAT_HEREDOC_RE.match(scan.subs[k][1])
                if m and int(m.group(1)) < len(scan.docs):
                    self.hits.extend(evaluate(scan.docs[int(m.group(1))][1], self.rules, self.cwd,
                                              self.depth + 1))
        self.hits.extend(evaluate(s, self.rules, self.cwd, self.depth + 1))

    def heredoc_body_hits(self):
        """kind=heredoc rules against each unquoted heredoc body. Inside bash
        -c "...", sh -c or eval the outer double quotes drop a backslash, so
        an escaped backtick runs there: nested_body_regex (when set) applies
        below depth 0."""
        for quoted, body in self.scan.docs:
            for rule in self.rules:
                regex = rule.get("nested_body_regex", rule.get("body_regex")) \
                    if self.depth else rule.get("body_regex")
                if rule.get("kind") == "heredoc" and not quoted \
                        and re.search(regex, body):
                    self.hit(rule)

    def substitution_hits(self):
        """Every substitution: a scanned one shares this scan, a backtick one
        is read afresh."""
        for kind, inner in self.scan.subs:
            if kind == "scanned":
                self.hits.extend(eval_scanned(inner, self.scan, self.rules, self.cwd, self.depth + 1))
            else:
                self.hits.extend(evaluate(inner, self.rules, self.cwd, self.depth + 1))

    def pipeline(self, stages):
        """One pipeline: each command, then what the commands do together."""
        cmds = []
        for raw in stages:
            self.simple_command(raw, cmds)
        self.find_feeds(cmds)
        self.pipe_rules(cmds)
        for rule in issuer_hits(cmds, self.issuers):  # kind=issuer: bash_guard_issuer.py
            self.hit(rule)
        self.shell_stdin_texts(cmds)
        self.process_substitution(cmds)
        self.prev_raw = [c["raw"] for c in cmds] if cmds else None

    def simple_command(self, raw, cmds):
        """One command: its loop words, the texts it runs, a cd it makes, and
        the rules it breaks. Appends its command dict to cmds."""
        marks = [int(m.group(1)) for m in map(HEREDOC_MARK_RE.match, raw) if m]
        argv = [resolve_subst(tok, self.scan) for tok in raw if not HEREDOC_MARK_RE.match(tok)]
        hs = here_string(argv)
        cmd = program_of(strip_redirects(argv), self.programs)
        cmd["raw"], cmd["docs"] = argv, marks
        self.loop_words(argv)
        cmds.append(cmd)
        self.inner_texts(cmd, hs)
        if self.follow_dirs(cmd):
            return
        self.path_rule_hits(cmd)
        self.simple_rule_hits(cmd)

    def loop_words(self, argv):
        """for b in main: later commands see $b as each word of the list."""
        words = strip_redirects(argv)
        if words[:1] in (["for"], ["select"]) and words[2:3] == ["in"]:
            self.loop_vars[words[1]] = words[3:53]
            return
        for name, values in self.loop_vars.items():
            ref = re.compile(r"\$\{?%s\}?(?![A-Za-z0-9_])" % re.escape(name))
            if any(ref.search(t) for t in argv):
                for v in values:
                    seen = shlex.join([ref.sub(lambda _m: v, t) for t in argv])
                    self.hits.extend(evaluate(seen, self.rules, self.cwd, self.depth + 1))

    def inner_texts(self, cmd, hs):
        """The texts a command runs: a wrapper's strings, a shell's -c and
        here-string, eval's words, and shell text inside other programs."""
        prog, args = cmd["prog"], cmd["args"]
        texts = list(cmd["inner"])
        if prog in SHELLS:
            texts.append(inline_code(cmd))
            texts.append(hs)
        if prog in INTERPRETERS and self.runs_remote(inline_code(cmd)):
            for rule in self.remote:
                self.hit(rule)
        if prog == "eval":
            texts.append(" ".join(args))
        texts.extend(embedded_shell(cmd))
        for s in texts:
            if s is not None:
                self.run_text(s)

    def follow_dirs(self, cmd):
        """cd, pushd and popd move the folder later commands run in; True
        when cmd was one, since none of them breaks a rule."""
        if cmd["prog"] in ("cd", "pushd"):
            self.cwd = next_cwd(cmd["prog"], cmd["args"], self.cwd)
            return True
        if cmd["prog"] == "popd":
            self.cwd = None
            return True
        return False

    def path_rule_hits(self, cmd):
        """kind=path rules against what the command reads."""
        for rule in self.rules:
            if rule.get("kind") == "path" and match_path(rule, cmd, self.cwd):
                self.hit(rule)

    def simple_rule_hits(self, cmd):
        """Simple rules against the command, and against the script a shell
        or python runs, unless --help skips the rule (help_skips)."""
        views = [cmd]
        script = script_view(cmd, self.programs)
        if script:
            views.append(script)
        for rule in self.rules:
            if rule.get("kind") or help_skips(rule, cmd):
                continue
            regex = rule.get("resolve_vars_regex")
            seen = [resolved(v, self.literals, regex) for v in views] if regex else views
            if any(match_simple(rule, v, self.cwd) for v in seen):
                self.hit(rule)

    def find_feeds(self, cmds):
        """find ... | xargs cat: find feeds a program, so path rules read
        what it finds."""
        for k, c in enumerate(cmds):
            if c["prog"] == "find" and any(d["via_xargs"] for d in cmds[k + 1:]):
                for rule in self.rules:
                    if rule.get("kind") == "path" and match_path(rule, c, self.cwd, feeds=True):
                        self.hit(rule)

    def pipe_rules(self, cmds):
        """kind=pipe rules: an upstream program feeds a downstream one that
        runs its stdin."""
        for rule in self.remote:
            ups = [k for k, c in enumerate(cmds) if c["prog"] in rule["upstream"]]
            downs = [k for k, c in enumerate(cmds)
                     if c["prog"] in rule["downstream"] and reads_program_from_stdin(c)]
            if ups and downs and min(ups) < max(downs):
                self.hit(rule)

    def shell_stdin_texts(self, cmds):
        """Heredoc bodies, echo and printf text that a shell later in the
        pipeline (or the command itself) runs from stdin."""
        for k, c in enumerate(cmds):
            later_shell = any(d["prog"] in SHELLS and reads_program_from_stdin(d)
                              for d in cmds[k + 1:])
            self.stdin_texts_of(c, later_shell)

    def stdin_texts_of(self, c, later_shell):
        """One command's heredoc bodies a shell will run, and its echo or
        printf text piped into a shell."""
        for doc in c["docs"]:
            own = c["prog"] in SHELLS and reads_program_from_stdin(c)
            if (own or later_shell) and doc < len(self.scan.docs):
                self.run_text(self.scan.docs[doc][1])
        if c["prog"] in ("echo", "printf") and later_shell:
            said = " ".join(c["args"])
            self.run_text(decode_ansi_c(said) if c["prog"] == "printf" else said)

    def process_substitution(self, cmds):
        """bash <(curl ...), source <(curl ...): a download read as a script."""
        if self.prev_raw and cmds and cmds[0]["prog"] in self.upstreams:
            head = self.prev_raw[-1]
            if head and head[-1] == "<" and os.path.basename(head[0]) in (
                    SHELLS | {"source", "."}):
                for rule in self.remote:
                    self.hit(rule)
