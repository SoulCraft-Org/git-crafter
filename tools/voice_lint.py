#!/usr/bin/env python3
"""voice_lint.py: the generic half of a prose voice check.

Canonical source: SoulCraft-Org/git-crafter tools/voice_lint.py. Each repo
vendors a copy whose first lines name that path and the commit SHA. The
copy is the one definition behind every call site:

  1. The agent surface, either a tool-use hook that fires on each edit
     or a slash command someone runs. These are not the same thing and
     a repo should say which one it has.
  2. The pre-commit hook, on staged files.
  3. CI, on files changed in a pull request.

CI shells out to the same script rather than reimplementing the check,
so the gate cannot drift between a laptop, a web edit, and a cloud agent.

This file holds only checks that are true for any writing project. Project
doctrine (banned terms, stale figures, named people, retired addresses,
brand tokens) never goes in here. It goes in a rules file the project owns
and passes with --rules.

Built-in checks:
  em-dash              FAIL  Any em dash (U+2014).
  spaced-en-dash       FAIL  " - " styled en dash (U+2013). It reads as an
                             em dash, so it is out too.
  double-hyphen-dash   WARN  A double hyphen standing in for a dash: spaced
                             between words, or joining two words. A CLI flag
                             such as --help is never spaced on both sides,
                             and inline code is skipped, so it warns.
  sentence-length      WARN  Sentence longer than max_words (default 30).
  hedge-word           WARN  Hedging that fights plain and direct.
  ai-tell              WARN  Phrasing that reads as machine-written.
  unattributed-figure  WARN  A money amount, percentage, comma-grouped
                             number, magnitude, or counted quantity in a
                             sentence with no attribution cue and no goal
                             label. A heuristic: it flags candidates for
                             human review, so it warns. An attributed
                             figure the regex misses is a false positive
                             to wave through, not a rule change.

Defaults follow ~/.claude/rules/writing-and-gates.md: block on the certain,
warn on the likely. The two dash checks are literal character tests, so
they block. The rest are heuristics, so they warn. A project that wants a
different grade sets it in its rules file, for example
"severity": {"unattributed-figure": "FAIL"}.

Skipped: fenced code blocks, by every check. A fence closes only on the same
marker character, at least as long as the opening, with nothing after it. Inline code spans and URLs
are skipped by every check except the two dash checks, which read the raw
line, so a dash inside backticks or a link still blocks. A file that has
to show the character belongs on the project's exempt list instead.

Rules file (JSON, all keys optional):
  {
    "max_words": 30,
    "hedge_words": ["as it were"],
    "attribution_cues": ["per the 2026 filing"],
    "figure_nouns": ["megawatts"],
    "severity": {"sentence-length": "off", "ai-tell": "FAIL"},
    "patterns": [
      {"id": "banned-term", "severity": "FAIL",
       "regex": "\\\\bsynergy\\\\b", "message": "say what actually happens"}
    ]
  }

Project patterns add to the built-ins, they never replace them. Severity
accepts FAIL, WARN, or off, for a pattern as for a built-in check; anything else,
and any other malformed rules file, is exit 2. Requires Python 3.9, standard library only.

Usage:
  python3 voice_lint.py FILE [FILE ...]
  python3 voice_lint.py --rules 01_doctrine/voice_rules.json FILE
  python3 voice_lint.py --max-words 35 FILE
  python3 voice_lint.py --self-test

Output: each finding as "path:line: SEVERITY [check] message", one
"path: X FAIL, Y WARN" line per file, and a last line for the whole run,
"voice_lint: N file(s) checked, X FAIL, Y WARN", the summary the Quality
page's docs.lint_warn reads.

Exit codes: 0 = no FAIL findings (warnings allowed), 1 = at least one
FAIL, 2 = usage, read, or rules error.
"""

import argparse
import contextlib
import io
import json
import pathlib
import re
import sys
import tempfile

EM_DASH = "—"
EN_DASH = "–"

DEFAULT_MAX_WORDS = 30

HEDGE_WORDS = ["arguably", "probably", "perhaps", "maybe", "somewhat", "fairly", "rather", "quite", "relatively",
               "potentially", "seemingly", "appears to", "seems to", "could be", "might be", "may be", "sort of", "kind of",
               "more or less", "virtually", "essentially", "basically", "generally", "in some sense", "to some extent"]

# Phrasing that reads as machine-written. Ported from an earlier voice
# hook, where it is advisory. Advisory here too: WARN, not FAIL.
AI_TELLS = [(r"\bdelve\b", "write plainly: look at, dig into"), (r"\btapestry\b", "cut the spatial metaphor"),
            (r"\bplethora\b", "use many or a lot of"), (r"\bseamless(ly)?\b", "say what actually happens"),
            (r"\bgame[- ]changer\b", "name the specific change"), (r"\ba testament to\b", "state the fact directly"),
            (r"it(?:'|’)?s important to note|it is important to note", "just say the thing"),
            (r"in (today(?:'|’)?s|an?) (fast-paced|ever-evolving|rapidly evolving)", "cut the opener"),
            (r"navigat(e|ing) the complexit", "say what you do"), (r"look no further", "chatbot filler"),
            (r"^\s*(Certainly|Absolutely|Of course)[,!]", "start with the answer"),
            (r"(^|\s)(in conclusion|in summary|in essence)[,:]", "stop when you are done"),
            (r"it(?:'|’)?s not (just|only) .{1,60}, it(?:'|’)?s", "write the affirmative")]

# Nouns that make a bare number a countable claim worth attributing.
FIGURE_NOUNS = ["companies", "firms", "workers", "employees", "jobs", "students", "researchers", "startups",
                "acres", "megawatts", "gigawatts", "patents", "labs", "buildings"]

# If any of these appear in the same sentence as a figure, the figure counts
# as attributed or labeled a goal.
ATTRIBUTION_CUES = ["according to", "per ", "source", "cite", "cites", "cited", "reports", "reported", "says", "said",
                    "estimate", "estimates", "estimated", "announced", "association", "study", "survey", "census",
                    "data from", "figures from", "goal", "target", "on the order of"]

LINK_RE = re.compile(r"\[[^\]]*\]\([^)]+\)|https?://\S+")
INLINE_CODE_RE = re.compile(r"`[^`]*`")
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")

# Default grade per built-in check. A rules file may regrade any of them.
# House rule: block on the certain, warn on the likely. The dash checks are
# literal character tests; everything else is a heuristic.
DEFAULT_SEVERITY = {"em-dash": "FAIL", "spaced-en-dash": "FAIL", "double-hyphen-dash": "WARN", "sentence-length": "WARN",
                    "hedge-word": "WARN", "ai-tell": "WARN", "unattributed-figure": "WARN"}
BUILTIN_CHECKS = tuple(DEFAULT_SEVERITY)


def build_figure_re(extra_nouns=()):
    """The figure regex: money, a percentage, a comma-grouped number, a magnitude, or a counted noun."""
    nouns = "|".join(re.escape(n) for n in list(FIGURE_NOUNS) + list(extra_nouns))
    return re.compile(r"""(?:
            [$€£]\s?\d[\d,.]*                   # money
          | \d[\d,.]*\s?(?:%|\bpercent\b)                 # percentage
          | \b\d{1,3}(?:,\d{3})+\b                        # comma-grouped
          | \b\d[\d,.]*\s?(?:million|billion|trillion|thousand)\b
          | \b\d[\d,.]*\+?\s(?:[a-z-]+\s)?(?:""" + nouns + r""")\b
        )""", re.IGNORECASE | re.VERBOSE)


# A hedge word that also starts a plain phrase gets a negative lookahead here,
# so the phrase never matches. "Rather than" is contrast, not hedging, and the
# house rules use it themselves; a bare "rather" still flags.
HEDGE_NOT_FOLLOWED_BY = {"rather": r"(?!\s+than\b)"}


def compile_hedges(words):
    """(word, regex) for each hedge word; a space in a word matches any run of whitespace."""
    return [(w, re.compile(r"\b" + re.escape(w).replace(r"\ ", r"\s+") + r"\b"
                           + HEDGE_NOT_FOLLOWED_BY.get(w.lower(), ""), re.IGNORECASE))
            for w in words]


def _grade(value):
    """FAIL or WARN for a severity value, None for off. ValueError for any other value."""
    upper = str(value).upper()
    if upper not in ("FAIL", "WARN", "OFF"):
        raise ValueError("severity must be FAIL, WARN, or off, not %r" % (value,))
    return None if upper == "OFF" else upper


class Rules(object):
    """Built-in checks plus whatever a project adds."""

    def __init__(self, data=None, max_words=None):
        data = data or {}
        self.max_words = max_words or data.get("max_words", DEFAULT_MAX_WORDS)
        self.hedges = compile_hedges(HEDGE_WORDS + list(data.get("hedge_words", [])))
        self.figure_re = build_figure_re(data.get("figure_nouns", []))
        self.cues = ATTRIBUTION_CUES + [c.lower() for c in data.get("attribution_cues", [])]
        self.ai_tells = [(re.compile(p, re.IGNORECASE | re.MULTILINE), p, advice) for p, advice in AI_TELLS]
        self.severity = dict(data.get("severity", {}))
        self.graded = {check: _grade(self.severity.get(check, DEFAULT_SEVERITY[check])) for check in BUILTIN_CHECKS}
        # A double hyphen typed as a dash, spaced between words or joining them; a flag (--help) has no space after.
        # It rides the patterns list, so it reads the line without code spans or URLs.
        self.patterns = [("double-hyphen-dash", sev, re.compile(r"\w\s+--\s+\w|[A-Za-z]--[A-Za-z]"), "use a comma or colon")] if (
            sev := self.graded["double-hyphen-dash"]) else []
        for i, spec in enumerate(data.get("patterns", [])):
            sev = _grade(spec.get("severity", "WARN"))
            if sev:
                self.patterns.append((spec.get("id") or "project-rule-%d" % (i + 1), sev,
                                      re.compile(spec["regex"], re.IGNORECASE), spec.get("message", "project rule")))

    def sev(self, check):
        """Severity for a built-in check, after project override."""
        return self.graded[check]


def load_rules(path, max_words=None):
    """Rules from the JSON rules file at path, or the built-ins alone for None. ValueError on a bad file."""
    if path is None:
        return Rules(None, max_words)
    with open(path, encoding="utf-8") as fh:
        return load_rules_from_obj(json.load(fh), max_words)


def _check_shape(data):
    """ValueError unless severity is an object, patterns a list of objects with a regex string, max_words a positive int."""
    words, pats = data.get("max_words", DEFAULT_MAX_WORDS), data.get("patterns", [])
    if not isinstance(data.get("severity", {}), dict) or not isinstance(pats, list) or not all(
            isinstance(p, dict) and isinstance(p.get("regex"), str) for p in pats):
        raise ValueError("severity must be an object, and patterns a list of objects each with a regex string")
    if isinstance(words, bool) or not isinstance(words, (int, float)) or words < 1 or words % 1:
        raise ValueError("max_words must be a positive integer")


def load_rules_from_obj(data, max_words=None):
    """Rules from a parsed rules object, checked as load_rules checks a file. A repo's own lint calls it."""
    if not isinstance(data, dict):
        raise ValueError("rules file must contain a JSON object")
    _check_shape(data)
    unknown = [check for check in data.get("severity", {}) if check not in BUILTIN_CHECKS]
    if unknown:
        raise ValueError("severity names unknown check %r; known: %s" % (unknown[0], ", ".join(BUILTIN_CHECKS)))
    try:
        return Rules(data, max_words)
    except (re.error, TypeError, AttributeError) as exc:  # a bad regex, or a word list holding a non-string
        raise ValueError("malformed rules file: %s" % exc)


def strip_noise(line):
    """Remove inline code and URLs before content checks."""
    return LINK_RE.sub(" LINKED-SOURCE ", INLINE_CODE_RE.sub(" ", line))


def sentence_has_attribution(sentence, cues):
    """Whether the sentence holds a link or an attribution cue."""
    low = sentence.lower()
    return "linked-source" in low or any(cue in low for cue in cues)


# The two literal dash tests: (check, the text to find in the raw line, message).
DASH_CHECKS = (("em-dash", EM_DASH, "em dash found; use a comma, semicolon, period, or parentheses"),
               ("spaced-en-dash", " %s " % EN_DASH, "spaced en dash reads as an em dash; restructure"))


def dash_findings(line_no, raw, rules):
    """Em dashes and spaced en dashes, read from the raw line."""
    return [(line_no, rules.sev(check), check, message)
            for check, mark, message in DASH_CHECKS if mark in raw and rules.sev(check)]


def word_findings(line_no, line, rules):
    """Hedge words, AI tells and the rule file's own patterns, read from the line without its noise."""
    found = []
    sev = rules.sev("hedge-word")
    if sev:
        found += [(line_no, sev, "hedge-word", 'hedge "%s"; say it plainly or cut it' % hedge)
                  for hedge, hedge_re in rules.hedges if hedge_re.search(line)]
    sev = rules.sev("ai-tell")
    if sev:
        found += [(line_no, sev, "ai-tell", 'AI tell "%s" (%s)' % (m.group(0).strip(), advice))
                  for tell_re, _pattern, advice in rules.ai_tells if (m := tell_re.search(line))]
    return found + [(line_no, pat_sev, check_id, '"%s" (%s)' % (m.group(0).strip(), message))
                    for check_id, pat_sev, pat_re, message in rules.patterns if (m := pat_re.search(line))]


def _sentences(lines):
    """Yield (line_no, sentence) for the paragraph that lines, a list of (line_no, text), form.

    The lines are joined with a space, so a sentence wrapped across them comes whole. line_no is the line
    where the sentence starts.
    """
    joined, starts = "", []
    for line_no, text in lines:
        starts.append((len(joined), line_no))
        joined += text + " "
    pos = 0
    for sentence in SENTENCE_SPLIT_RE.split(joined):
        at = joined.index(sentence, pos)
        pos = at + len(sentence)
        yield [n for off, n in starts if off <= at][-1], sentence


def sentence_findings(lines, rules):
    """Each sentence's length, and a figure with no attribution cue or goal label.

    lines is a list of (line_no, text) that form one paragraph. A sentence wrapped
    across lines is measured whole. A finding carries the line where its sentence starts.
    """
    found = []
    len_sev, fig_sev = rules.sev("sentence-length"), rules.sev("unattributed-figure")
    for line_no, sentence in _sentences(lines):
        words = sentence.split()
        if len_sev and len(words) > rules.max_words:
            found.append((line_no, len_sev, "sentence-length", "sentence has %d words (limit %d); split it, "
                          "one idea per sentence" % (len(words), rules.max_words)))
        m = rules.figure_re.search(sentence) if fig_sev else None
        if m and not sentence_has_attribution(sentence, rules.cues):
            found.append((line_no, fig_sev, "unattributed-figure", 'figure "%s" has no attribution cue and no goal '
                          "label; attribute it or label it a goal" % m.group(0).strip()))
    return found


# A line that is a heading, table row or list item stands alone; it never joins a neighbor.
STANDALONE_RE = re.compile(r"^\s*(#|\||[-*+]\s|\d+[.)]\s)")


def _front_matter_end(lines):
    """Index of the line after a leading --- front matter block, or 0 when there is none."""
    if lines and lines[0].strip() == "---":
        for i in range(1, len(lines)):
            if lines[i].strip() in ("---", "..."):
                return i + 1
    return 0


def _fence_state(raw, fence):
    """(fence after this line, whether the line is fenced) for a line and the open fence, its opening marker such as ~~~ or None.

    A fence opens on three or more backticks or tildes. It closes only on a line of the same character, at least
    as long, with nothing after it, so a backtick fence inside a ~~~ block stays code.
    """
    text = raw.strip()
    if fence:
        return (None if text.startswith(fence) and not text.strip(fence[0]) else fence), True
    m = re.match(r"`{3,}|~{3,}", text)
    return (m.group(), True) if m else (None, False)


def _blocks(text):
    """Yield the lines that are read together, each block a list of (line_no, raw line).

    A paragraph's lines come as one block. Every other line comes alone: a blank line, a heading,
    table row, list item or front matter line. Fenced code is left out, and it ends a paragraph.
    """
    lines = text.splitlines()
    skip_to = _front_matter_end(lines)
    fence, para = None, []
    # The blank line added after the last line ends the last paragraph.
    for line_no, raw in enumerate(lines + [""], start=1):
        fence, fenced = _fence_state(raw, fence)
        if raw.strip() and not fenced and not STANDALONE_RE.match(raw) and line_no > skip_to:
            para.append((line_no, raw))
            continue
        if para:
            yield para
            para = []
        if not fenced:
            yield [(line_no, raw)]


def lint_text(text, rules=None, max_words=None):
    """Return a list of findings: (line_no, severity, check, message)."""
    rules = rules if rules is not None else Rules(None, max_words)
    findings = []
    for block in _blocks(text):
        clean = [(line_no, strip_noise(raw)) for line_no, raw in block]
        for (line_no, raw), (_, line) in zip(block, clean):
            findings += dash_findings(line_no, raw, rules) + word_findings(line_no, line, rules)
        if block[0][1].strip():  # a blank line holds no sentence
            findings += sentence_findings(clean, rules)
    return findings


def report(path, findings):
    """Print each finding, then the file's FAIL and WARN counts or that it is clean. Returns the FAIL count."""
    for line_no, severity, check, message in findings:
        print("%s:%d: %s [%s] %s" % (path, line_no, severity, check, message))
    fails = sum(1 for f in findings if f[1] == "FAIL")
    print("%s: %d FAIL, %d WARN" % (path, fails, len(findings) - fails) if findings else "%s: clean" % path)
    return fails


# ---- self-test: it stays in this file, since repos that copy the file alone
# run `voice_lint.py --self-test` in their own CI.

SELF_TEST_BAD = (
    "The corridor is booming " + EM_DASH + " photonics is the future.\n"
    "Light moves data " + EN_DASH + " and it moves it fast. Fiber is cheap -- and getting cheaper.\n"
    "Colorado has 250 photonics companies and 8,000 workers. Let us delve into the tapestry of a seamless future.\n"
    "It is arguably the best place in America to build with light, and this sentence keeps going and going, "
    "adding clause after clause, idea after idea, well past the point where a reader can hold it in one breath.\n")

# One 31-word sentence hard-wrapped across three lines; no single line is long.
SELF_TEST_WRAPPED_BAD = ("The corridor keeps growing because every new lab brings more suppliers, more students, more\n"
                         "founders, more customers, more partners and more investors than anyone planned for in the first year of work.\n")

# The same paragraph shape with short sentences; wrapping alone must not warn.
SELF_TEST_WRAPPED_GOOD = "The corridor keeps growing. Each new lab brings\nmore suppliers and students. Founders follow the customers.\n"

SELF_TEST_CLEAN = ("The corridor builds computing on light. Reaching 10,000 photonics workers is a goal, not a count.\n"
                   "The industry association has cited on the order of 250 photonics companies statewide; "
                   "confirm the current figure before publishing.\n"
                   # A bare flag and a flag in code must not read as a dash.
                   "Count signed letters rather than estimates. Pass --help, or `git push --force-with-lease`.\n"
                   # An unspaced en dash in a range must not match. spaced-en-dash blocks,
                   # so it has to stay this narrow.
                   "See sections 3" + EN_DASH + "4 for the method.\n")

# The default grade of every built-in check, written out apart from
# DEFAULT_SEVERITY, so a changed default fails here instead of passing quietly.
# Source: ~/.claude/rules/writing-and-gates.md, "Block on the certain, warn on
# the likely." The two dash checks are literal character tests, so they
# block. The rest are heuristics, so they warn.
SELF_TEST_EXPECTED = {"em-dash": "FAIL", "spaced-en-dash": "FAIL", "double-hyphen-dash": "WARN", "sentence-length": "WARN",
                      "hedge-word": "WARN", "ai-tell": "WARN", "unattributed-figure": "WARN"}

# One row of the "Built-in checks" table in the module docstring.
DOC_TABLE_RE = re.compile(r"^  ([a-z][a-z-]+)\s+(FAIL|WARN)\s", re.MULTILINE)

SELF_TEST_RULES = {"max_words": 30, "severity": {"hedge-word": "off"}, "patterns": [
    {"id": "banned-term", "severity": "FAIL", "regex": r"\bsynergy\b", "message": "say what actually happens"}]}



def _graded(findings, check_id):
    """The grades check_id raised in findings."""
    return set(f[1] for f in findings if f[2] == check_id)


def _exit(text=b"ok.\n", rules=None):
    """The exit code main gives a Markdown file holding these bytes, with a rules file of this JSON when given."""
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
        md, cfg = pathlib.Path(tmp, "a.md"), pathlib.Path(tmp, "rules.json")
        md.write_bytes(text), cfg.write_text(json.dumps(rules), encoding="utf-8")
        return main([str(md)] + ([] if rules is None else ["--rules", str(cfg)]))


def _summary():
    """(exit code, last line printed, the line expected) for a run over the bad sample twice."""
    bad = lint_text(SELF_TEST_BAD)
    out = io.StringIO()
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(out):
        sample = pathlib.Path(tmp, "bad.md")
        sample.write_text(SELF_TEST_BAD, encoding="utf-8")
        code = main([str(sample), str(sample)])
    failed = sum(1 for f in bad if f[1] == "FAIL")
    want = "voice_lint: 2 file(s) checked, %d FAIL, %d WARN" % (2 * failed, 2 * (len(bad) - failed))
    return code, out.getvalue().splitlines()[-1], want


def sample_checks():
    """(label, passed) for the seeded samples, the raw-line dash reads, fences and the docstring table.

    passed is None for the docstring table under python -OO, which strips it.
    """
    bad = lint_text(SELF_TEST_BAD)
    # The docstring's "Skipped" note, held to the code. The dash checks read
    # the raw line, so backticks and links do not hide a dash; only a fence does.
    raw = lint_text("Run `a " + EM_DASH + " b` now.\nSee [a " + EN_DASH + " b](https://example.com) now.\n")
    return [("seeded %s flagged at %s" % (c, SELF_TEST_EXPECTED.get(c)), _graded(bad, c) == {SELF_TEST_EXPECTED.get(c)})
            for c in BUILTIN_CHECKS] + [
        # Nothing at all, not merely no FAIL. A figure check that warns would
        # otherwise let a broken attribution cue through unseen.
        ("clean sample raises nothing", not lint_text(SELF_TEST_CLEAN)),
        ("a sentence wrapped across lines is measured whole, at the line it starts",
         [(f[0], f[1]) for f in lint_text(SELF_TEST_WRAPPED_BAD) if f[2] == "sentence-length"] == [(1, "WARN")]),
        ("short wrapped sentences raise nothing", not lint_text(SELF_TEST_WRAPPED_GOOD)),
        # The clean sample carries a "rather than"; a bare "rather" must still hedge.
        ('a bare "rather" still flags as a hedge', bool(_graded(lint_text("The plan is rather ambitious.\n"), "hedge-word"))),
        ("a dash in inline code or a link still flags",
         _graded(raw, "em-dash") == {"FAIL"} and _graded(raw, "spaced-en-dash") == {"FAIL"}),
        # A ~~~ block that shows a backtick fence stays open; a fence closes only on its own character, at its length or more.
        ("a fence closes only on its own character and length", all(
            _graded(lint_text(t + "Run a " + EM_DASH + " b.\n"), "em-dash") == want for t, want in (
                ("~~~\n```\n", set()), ("````\n```\n", set()), ("~~~\n```\n~~~\n", {"FAIL"}), ("```\ncode\n````\n", {"FAIL"})))),
        ("a fenced block skips every check", not lint_text("```\nRun a " + EM_DASH + " b " + EN_DASH + " c.\n```\n")),
        ("docstring table matches the default grades",
         dict(DOC_TABLE_RE.findall(__doc__)) == SELF_TEST_EXPECTED if __doc__ else None)]


def rules_checks():
    """(label, passed) for rules files: regrades, project patterns, off, unknown names, and the summary line."""
    regraded = lint_text(SELF_TEST_BAD, Rules({"severity": {"spaced-en-dash": "WARN", "unattributed-figure": "FAIL"}}))
    off = lint_text(SELF_TEST_BAD, Rules(SELF_TEST_RULES))
    code, last, want = _summary()
    return [
        ("a rules file regrades a built-in default in either direction",
         _graded(regraded, "spaced-en-dash") == {"WARN"} and _graded(regraded, "unattributed-figure") == {"FAIL"}),
        ("project pattern flagged at its declared severity",
         "FAIL" in _graded(lint_text("We unlocked real synergy this quarter.\n", Rules(SELF_TEST_RULES)), "banned-term")),
        ("severity off suppresses a built-in check", not _graded(off, "hedge-word")),
        ("project rules do not replace the built-ins", bool(_graded(off, "em-dash"))),
        # Each of these is a rules error, exit 2, not a traceback and exit 1: a pattern severity outside FAIL, WARN and off.
        ("a malformed rules file is rejected, an unknown check name too", all(_exit(rules=d) == 2 for d in (
            {"severity": {"no-such-check": "off"}}, {"patterns": [{"regex": "x", "severity": "FAILL"}]}, {"patterns": [{"regex": "("}]},
            {"severity": []}, {"max_words": "30"}, {"patterns": ["x"]}, {"hedge_words": [1]}, {"attribution_cues": [1]}, {"figure_nouns": 5}))),
        ("an integral float max_words loads as before", _exit(rules={"max_words": 30.0}) == 0),
        ("a file that is not UTF-8 is a read error, exit 2", _exit(b"caf\xe9 ok.\n") == 2),
        ("an in-memory rules object loads like a file",
         _graded(lint_text("We unlocked real synergy this quarter.\n", load_rules_from_obj(SELF_TEST_RULES)), "banned-term") == {"FAIL"}),
        # The run's last line is the summary docs.lint_warn reads: every file,
        # and the findings of all of them.
        ("summary line closes the run", code == 1 and last == want)]


def self_test():
    """Run the embedded seeded samples, one line per check, then PASS or FAIL. Returns the exit code."""
    ok = True
    for label, passed in sample_checks() + rules_checks():
        if passed is None:
            print("self-test: docstring stripped (python -OO); table not checked")
            continue
        print("self-test: %s: %s" % (label, "OK" if passed else "FAIL"))
        ok = ok and passed
    for f in lint_text(SELF_TEST_CLEAN):
        print("  clean-sample:%d: %s [%s] %s" % f)
    print("self-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main(argv=None):
    """Lint each file and print the run's summary last, or run --self-test. Returns the exit code."""
    parser = argparse.ArgumentParser(description="Generic prose voice lint")
    parser.add_argument("files", nargs="*", help="files to lint")
    parser.add_argument("--rules", help="path to a project rules JSON file")
    parser.add_argument("--max-words", type=int, default=None, help="sentence word limit (default %d)" % DEFAULT_MAX_WORDS)
    parser.add_argument("--self-test", action="store_true", help="run the embedded seeded samples and exit")
    args = parser.parse_args(argv)

    if args.self_test:
        return self_test()
    if not args.files:
        parser.print_usage()
        return 2

    try:
        rules = load_rules(args.rules, args.max_words)
    except (OSError, ValueError) as exc:  # UnicodeDecodeError and json.JSONDecodeError are ValueErrors
        print("rules error: %s" % exc, file=sys.stderr)
        return 2

    fails = total = 0
    for path in args.files:
        try:
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            print("%s: cannot read (%s)" % (path, exc), file=sys.stderr)
            return 2
        findings = lint_text(text, rules)
        fails += report(path, findings)
        total += len(findings)
    print("voice_lint: %d file(s) checked, %d FAIL, %d WARN" % (len(args.files), fails, total - fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
