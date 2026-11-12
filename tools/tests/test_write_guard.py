"""Self-test for tools/write_guard.py, run by `python3 -I tools/write_guard.py --self-test`.

Seeded hook payloads, each run through the hook as a subprocess.
write_guard.py passes itself in as `tool`, so the test runs the file that
called it and imports the voice_lint.py beside it.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

# Escapes, so this file never holds the characters it hunts for.
EM = "\u2014"
EN = "\u2013"
FIX_SEEN = "comma, semicolon, period, or parentheses"

# Every finding voice_lint raises on this text grades WARN by default: a
# hedge, an AI tell, an unattributed figure, a long sentence. An unspaced en
# dash in a range is not a spaced en dash. The hook must allow all of it.
WARN_ONLY = (
    "It is arguably the right call.\n"
    "The region has 250 photonics companies.\n"
    "Let us delve into the method.\n"
    "See sections 3" + EN + "4 for the method.\n"
    "This sentence keeps going and going, adding clause after clause and idea "
    "after idea, well past the point where a reader can hold all of it in a "
    "single breath without losing the thread.\n"
)


def write(path, content):
    """A Write payload."""
    return {"tool_name": "Write", "tool_input": {"file_path": path, "content": content}}


def edit(path, old, new):
    """An Edit payload."""
    return {"tool_name": "Edit",
            "tool_input": {"file_path": path, "old_string": old, "new_string": new}}


def bypass(payload):
    """payload in bypassPermissions mode."""
    return dict(payload, permission_mode="bypassPermissions")


BAD_WRITE = write("/tmp/a.md", "Line one.\nThe corridor is booming " + EM + " light is next.\n")
CLEAN_WRITE = write("/tmp/a.md", "Plain text, with a comma.\n")

# (label, stdin payload, expected exit, text stderr must hold, stderr must be empty)
CASES = [
    ("known-bad Write blocks", BAD_WRITE,
     2, ["content line 2", "em dash (U+2014)", FIX_SEEN, "booming " + EM], False),
    ("known-bad Edit blocks",
     edit("/tmp/a.mdx", "old", "Light moves data " + EN + " and it moves fast."),
     2, ["new_string line 1", "spaced en dash (U+2013)", FIX_SEEN], False),
    ("known-bad MultiEdit blocks on the second edit",
     {"tool_name": "MultiEdit", "tool_input": {"file_path": "/tmp/notes.txt", "edits": [
         {"old_string": "a", "new_string": "Clean text."},
         {"old_string": "b", "new_string": "Fine.\nNot fine " + EM + " here."}]}},
     2, ["edits[1].new_string line 2", "em dash (U+2014)"], False),
    ("an upper-case .MD path still counts",
     write("/tmp/README.MD", "One " + EM + " two.\n"), 2, ["em dash"], False),
    ("the excerpt centres on the spaced en dash, not an earlier range",
     write("/tmp/a.md", "Pages 3" + EN + "4 " + "x" * 120 + " then " + EN + " here.\n"),
     2, ["then " + EN + " here."], False),
    ("the excerpt keeps a spaced en dash at the end of a long line",
     write("/tmp/a.md", "x" * 100 + " tail " + EN + " \n"), 2, ["tail " + EN], False),
    ("a long line of digits still blocks",
     write("/tmp/a.txt", "1," * 25000 + " a " + EM + " b\n"), 2, ["em dash"], False),
    ("clean Write with WARN-level findings allows",
     write("/tmp/clean.md", WARN_ONLY), 0, [], True),
    ("clean Edit allows, though old_string has a dash",
     edit("/tmp/a.md", "Old " + EM + " text.", "New text, with a comma."), 0, [], True),
    ("clean MultiEdit allows, though an old_string has a dash",
     {"tool_name": "MultiEdit", "tool_input": {"file_path": "/tmp/a.md", "edits": [
         {"old_string": "Old " + EM + " text.", "new_string": "New text."}]}},
     0, [], True),
    ("a dash in a fenced block of the new text allows",
     write("/tmp/a.md", "Prose.\n```\nkey " + EM + " value\n```\n"), 0, [], True),
    (".py file with an em dash is ignored",
     write("/tmp/a.py", "x = 1  # one " + EM + " two\n"), 0, [], True),
    ("another tool is ignored",
     {"tool_name": "NotebookEdit",
      "tool_input": {"notebook_path": "/tmp/a.ipynb", "new_source": EM}}, 0, [], True),
    ("malformed input fails open",
     "not json {", 0, ["allowed"], False),
    ("non-object input fails open",
     [1, 2], 0, ["allowed"], False),
    ("a tool_input that is not an object fails open",
     {"tool_name": "Write", "tool_input": [1]}, 0, ["allowed"], False),
    ("MultiEdit edits of the wrong shape fail open",
     {"tool_name": "MultiEdit", "tool_input": {"file_path": "/tmp/a.md", "edits": "x"}},
     0, ["allowed"], False),
    ("Write with no content fails open",
     {"tool_name": "Write", "tool_input": {"file_path": "/tmp/a.md"}}, 0, ["allowed"], False),
    ("Edit with no file_path fails open",
     {"tool_name": "Edit", "tool_input": {"new_string": EM}}, 0, ["allowed"], False),
]

# A sibling voice_lint.py that breaks, and the payload that would block if it
# worked. Each must fail open with a note. None means no sibling at all.
OVERRIDE = "\n\ndef lint_text(*args, **kwargs):\n    %s\n"
# (label, sibling text, append it to the real voice_lint.py)
BROKEN_SIBLINGS = [
    ("missing voice_lint fails open", None, False),
    ("voice_lint that raises on import fails open", "raise RuntimeError('seeded')\n", False),
    ("voice_lint that exits on import fails open", "import sys\nsys.exit(2)\n", False),
    ("voice_lint whose lint_text raises fails open",
     OVERRIDE % "raise RuntimeError('seeded')", True),
    ("voice_lint whose lint_text exits fails open", OVERRIDE % "raise SystemExit(2)", True),
]

# (label, stdin payload, field path to the fixed text, text it must equal)
REWRITES = [
    ("bypass mode: a Write's em dash becomes a comma",
     bypass(BAD_WRITE), ("content",),
     "Line one.\nThe corridor is booming, light is next.\n"),
    ("bypass mode: an Edit's spaced en dash becomes a comma, a range stays",
     bypass(edit("/tmp/a.md", "old", "Pages 3" + EN + "4 " + EN + " then more.")),
     ("new_string",), "Pages 3" + EN + "4, then more."),
    ("bypass mode: a MultiEdit fixes the edit with the dash",
     bypass({"tool_name": "MultiEdit", "tool_input": {"file_path": "/tmp/n.txt", "edits": [
         {"old_string": "a", "new_string": "Clean."},
         {"old_string": "b", "new_string": EM + " Lead dash.\nEnd dash " + EM + "\n"}]}}),
     ("edits", 1, "new_string"), "Lead dash.\nEnd dash,\n"),
    ("bypass mode: a dash in a fence stays, the prose dash goes",
     bypass(write("/tmp/a.md", "Prose " + EM + " here.\n```\nkey " + EM + " value\n```\n")),
     ("content",), "Prose, here.\n```\nkey " + EM + " value\n```\n"),
]
TEXT_FIELDS = ("content", "new_string", "edits")


class Checks:
    """Counts passed checks and keeps the label of each failed one."""

    def __init__(self):
        self.failures = []
        self.passed = 0

    def check(self, ok, label, detail=""):
        """Record one check."""
        if ok:
            self.passed += 1
        else:
            self.failures.append(label + (": " + detail if detail else ""))


def run_hook(script, payload, flags=("-I",), env=None, pre=""):
    """Run the hook on payload. pre runs first, inside the hook's process.

    Returns (exit, stdout, stderr); exit is None on a timeout.
    """
    raw = payload if isinstance(payload, str) else json.dumps(payload)
    argv = [sys.executable] + list(flags) + [script]
    if pre:
        argv = [sys.executable, "-I", "-c",
                pre + "; import runpy, sys; sys.argv = [%r]; "
                "runpy.run_path(%r, run_name='__main__')" % (script, script)]
    try:
        r = subprocess.run(argv, input=raw.encode("utf-8"), capture_output=True,
                           env=env, timeout=10)
    except subprocess.TimeoutExpired:
        return None, "", "timed out after 10 s"
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def check_cases(checks, script):
    """Each CASES payload: its exit code, and what stderr holds."""
    for label, payload, want, needles, quiet in CASES:
        code, _out, err = run_hook(script, payload)
        wrong = []
        if code != want:
            wrong.append("exit %s, expected %d" % (code, want))
        wrong += ["stderr lacks %r" % n for n in needles if n not in err]
        if quiet and err:
            wrong.append("stderr not empty")
        checks.check(not wrong, label, "; ".join(wrong) + "\n    stderr: " + err.strip())


def without_texts(fields):
    """fields without the new-text keys, to compare what a rewrite must keep."""
    return {k: v for k, v in fields.items() if k not in TEXT_FIELDS}


def rewrite_result(script, payload, where, want):
    """(ok, detail) for one REWRITES row: an allow whose fixed text equals want."""
    code, stdout, _err = run_hook(script, payload)
    try:
        out = json.loads(stdout)["hookSpecificOutput"]
        got = out["updatedInput"]
        for key in where:
            got = got[key]
        ok = (code == 0 and out["permissionDecision"] == "allow" and got == want
              and without_texts(out["updatedInput"]) == without_texts(payload["tool_input"]))
        return ok, "exit %s, got %r" % (code, got)
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        return False, "exit %s, stdout %r (%r)" % (code, stdout, exc)


def check_rewrites(checks, script):
    """Bypass mode fixes each dash; every other mode still blocks."""
    for label, payload, where, want in REWRITES:
        ok, detail = rewrite_result(script, payload, where, want)
        checks.check(ok, label, detail)
    for mode in ("default", "acceptEdits", "auto", "plan"):
        code, out, _err = run_hook(script, dict(BAD_WRITE, permission_mode=mode))
        checks.check(code == 2 and not out, "%s mode still blocks" % mode,
                     "exit %s, stdout %r" % (code, out))


def check_in_process(checks, tool, script):
    """The WARN-only sample must really raise WARNs under voice_lint's default
    grades, or the clean case proves nothing about ignoring them. And a block
    still exits 2 when stderr is closed, with nothing to print to."""
    try:
        grades = set(f[1] for f in tool.load_voice_lint().lint_text(WARN_ONLY))
        checks.check(grades == {"WARN"}, "WARN-only sample raises only WARNs",
                     "graded %s" % sorted(grades))
    except Exception as exc:
        checks.check(False, "voice_lint loads in-process", repr(exc))
    code, _out, _err = run_hook(script, BAD_WRITE, pre="import os; os.close(2)")
    checks.check(code == 2, "a block with stderr closed still exits 2", "exit %s" % code)


def check_broken_siblings(checks, script, real):
    """A copy of the hook beside each broken voice_lint.py fails open."""
    for label, sibling, on_real in BROKEN_SIBLINGS:
        with tempfile.TemporaryDirectory() as tmp:
            copy = os.path.join(tmp, "write_guard.py")
            shutil.copy2(script, copy)
            if sibling is not None:
                with open(os.path.join(tmp, "voice_lint.py"), "w", encoding="utf-8") as fh:
                    fh.write(real + sibling if on_real else sibling)
            code, _out, err = run_hook(copy, BAD_WRITE)
        checks.check(code == 0 and "allowed" in err, label, "exit %s, stderr %r" % (code, err.strip()))


def check_decoy(checks, script, real):
    """Only the sibling counts. With none beside the hook, a voice_lint found
    elsewhere on sys.path must not run. Here it would block a clean call."""
    with tempfile.TemporaryDirectory() as tmp:
        hook_dir = os.path.join(tmp, "hook")
        decoy_dir = os.path.join(tmp, "decoy")
        os.makedirs(hook_dir)
        os.makedirs(decoy_dir)
        copy = os.path.join(hook_dir, "write_guard.py")
        shutil.copy2(script, copy)
        with open(os.path.join(decoy_dir, "voice_lint.py"), "w", encoding="utf-8") as fh:
            fh.write(real + OVERRIDE % "return [(1, 'FAIL', 'em-dash', 'decoy')]")
        code, _out, err = run_hook(copy, CLEAN_WRITE, flags=(),
                                   env=dict(os.environ, PYTHONPATH=decoy_dir))
    checks.check(code == 0 and "allowed" in err,
                 "a voice_lint from elsewhere on sys.path is refused",
                 "exit %s, stderr %r" % (code, err.strip()))


def run(tool):
    """Run every check against tool, the write_guard module. Returns the exit code."""
    checks = Checks()
    script = os.path.realpath(tool.__file__)
    check_cases(checks, script)
    check_rewrites(checks, script)
    check_in_process(checks, tool, script)
    with open(os.path.join(tool.HERE, "voice_lint.py"), encoding="utf-8") as fh:
        real = fh.read()
    check_broken_siblings(checks, script, real)
    check_decoy(checks, script, real)
    if checks.failures:
        print("write_guard self-test: FAIL (%d failed, %d passed)" % (len(checks.failures), checks.passed))
        for f in checks.failures:
            print("  -", f)
        return 1
    print("write_guard self-test: ok (%d checks)" % checks.passed)
    return 0
