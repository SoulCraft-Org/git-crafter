#!/usr/bin/env python3
"""write_guard.py: a PreToolUse hook that blocks a banned dash in new prose.

Canonical source: Git Crafter tools/write_guard.py. The installed copy lives at
~/.claude/code-os/write_guard.py, beside the voice_lint.py it imports. If
the two disagree, Git Crafter wins. Fix the copy with
`claude_os_sync.py apply user-claude --yes`.

Fires or waits. This hook fires only once ~/.claude/settings.json wires it as
a PreToolUse hook. Git Crafter installs the file and does not wire it, so until
someone adds the entry, nothing calls it. The entry would read:

  {"matcher": "Write|Edit|MultiEdit", "hooks": [{"type": "command",
   "command": "python3 -I ~/.claude/code-os/write_guard.py",
   "timeout": 10}]}

What it decides. Nothing. The house rule lives in voice_lint.py, the one
definition every call site shares. This file routes the new text through
voice_lint.lint_text and blocks on FAIL findings. In bypassPermissions mode,
where every Write and Edit runs without a prompt, it fixes them instead:
each flagged dash becomes a comma, the first fix voice_lint names, and the
call goes ahead with that text, so a dash no longer costs a retry turn. It fixes only when every FAIL is a dash
and the fixed text lints clean; otherwise it blocks. By default only the two
dash checks grade FAIL: em-dash and spaced-en-dash. WARN findings never
block here. The hook turns off each check that voice_lint does not grade
FAIL, since none of them can block. That keeps a long line fast.

What it reads:
  Write      tool_input.content
  Edit       tool_input.new_string
  MultiEdit  tool_input.edits[i].new_string, for each edit
It never reads old_string or the rest of the file. It checks a call only
when file_path ends in .md, .mdx or .txt, in any letter case. Every other
path and every other tool passes unread.

What it misses on purpose. Each fragment is linted on its own, so context
comes from the fragment, not the file:
  - A spaced en dash whose spaces sit outside the fragment passes.
  - A dash in an Edit to a fenced code block of the file blocks as prose.
  - A fragment that opens a fence hides the lines after it. voice_lint
    reads a line that starts with ``` or ~~~ as a fence in every file
    type, .txt included.
  - An Edit that keeps a dash already in old_string still blocks. The fix
    is to replace that dash too.
Text written through Bash or any other tool goes unchecked. Linting the
whole file with voice_lint.py sees the context this hook cannot.

Failure policy. An infrastructure problem allows the call, with a note on
stderr. That covers hook input that is not a JSON object, a tool_input of
the wrong shape, a missing or broken voice_lint.py, and any exception or
exit raised inside voice_lint. Could not check is not the same as checked
and failed.

Hook protocol. Reads the hook JSON on stdin. Exit 0 allows. Exit 2 blocks
and sends stderr to Claude. A fix exits 0 and prints hookSpecificOutput on
stdout: permissionDecision allow, the whole updatedInput, and a note in
additionalContext (code.claude.com/docs/en/hooks, PreToolUse decision
control, read 2026-11-05). The message names each line that holds a
banned dash, the character, and the fix. Exit 1 is a usage error, which
Claude Code treats as non-blocking.

Commands:
  (no args)     hook mode, reads stdin
  --self-test   runs tools/tests/test_write_guard.py: seeded hook
                payloads, each run through this script. Exits 2 where that
                folder is absent, as in ~/.claude/code-os

Requires Python 3.9, standard library only. Run it as `python3 -I`.
Isolated mode drops the script's directory from sys.path. The script adds
its own directory back before it imports voice_lint.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
PROSE_SUFFIXES = (".md", ".mdx", ".txt")
TOOLS = ("Write", "Edit", "MultiEdit")
RULE_FILE = "~/.claude/rules/writing-and-gates.md"
FIX = "use a comma, semicolon, period, or parentheses"
# In this mode Claude Code runs every Write and Edit without asking, so a
# hook that fixes the dashes and allows the call skips no prompt anyone
# would see. acceptEdits still asks for a file outside the working folders.
REWRITE_MODES = ("bypassPermissions",)
DASH_CHECKS = ("em-dash", "spaced-en-dash")


def say(text):
    """Write to stderr as UTF-8 whatever the locale. A dead stderr never raises.

    os.write skips Python's buffer, so a closed stderr leaves nothing to fail
    at exit, and the exit code stays the one the hook chose.
    """
    data = (text + "\n").encode("utf-8", "replace")
    try:
        while data:
            data = data[os.write(2, data):]
    except OSError:
        pass


class Unchecked(Exception):
    """The call could not be checked; the hook allows it, with this reason as a note."""


def allow_with_note(reason):
    """Allow the call, with a could-not-check note on stderr."""
    say("write_guard: could not check (%s); allowed." % reason)
    return 0


def load_voice_lint():
    """Import the voice_lint.py that sits beside this script, and only that one."""
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import voice_lint
    where = os.path.dirname(os.path.realpath(voice_lint.__file__))
    if where != HERE:
        raise ImportError("voice_lint came from %s, not %s" % (where, HERE))
    return voice_lint


def new_texts(tool, tool_input):
    """The text a call adds, as (label, text) pairs. ValueError on a bad shape."""
    if tool == "Write":
        pairs = [("content", tool_input.get("content"))]
    elif tool == "Edit":
        pairs = [("new_string", tool_input.get("new_string"))]
    else:
        edits = tool_input.get("edits")
        if not isinstance(edits, list):
            raise ValueError("edits is not a list")
        pairs = []
        for i, edit in enumerate(edits):
            if not isinstance(edit, dict):
                raise ValueError("edits[%d] is not an object" % i)
            pairs.append(("edits[%d].new_string" % i, edit.get("new_string")))
    for label, text in pairs:
        if not isinstance(text, str):
            raise ValueError("%s is not a string" % label)
    return pairs


def fail_only_rules(vl):
    """voice_lint's default rules, with every check it does not grade FAIL off."""
    return vl.Rules({"severity": {
        check: "off" for check in vl.BUILTIN_CHECKS
        if vl.DEFAULT_SEVERITY[check] != "FAIL"
    }})


def excerpt(line, needle, width=40):
    """The line around the first occurrence of needle, cut to about 2 * width.

    strip() can cut a space off the needle at a line end, so a miss falls
    back to the needle without its spaces.
    """
    text = line.strip()
    if len(text) <= 2 * width:
        return text
    at = text.find(needle)
    if at < 0:
        at = max(text.find(needle.strip()), 0)
    start = max(0, at - width)
    end = min(len(text), at + width)
    return ("..." if start else "") + text[start:end] + ("..." if end < len(text) else "")


def findings(vl, pairs):
    """One line of the block message per FAIL finding voice_lint returns."""
    # Display only: the name, the character, and the text to centre the
    # excerpt on. Whether a line breaks the rule is voice_lint's call.
    chars = {
        "em-dash": ("em dash", vl.EM_DASH, vl.EM_DASH),
        "spaced-en-dash": ("spaced en dash", vl.EN_DASH, " %s " % vl.EN_DASH),
    }
    rules = fail_only_rules(vl)
    out = []
    for label, text in pairs:
        lines = text.splitlines()
        for line_no, severity, check, message in vl.lint_text(text, rules):
            if severity != "FAIL":
                continue
            where = "%s line %d" % (label, line_no)
            if check in chars:
                name, char, needle = chars[check]
                out.append('%s: %s (U+%04X): "%s"' % (
                    where, name, ord(char), excerpt(lines[line_no - 1], needle)))
            else:
                out.append("%s: [%s] %s" % (where, check, message))
    return out


def comma_line(line):
    """line with each em dash and spaced en dash made a comma. An unspaced en
    dash in a range (3-4 with U+2013) stays."""
    body = line.rstrip("\r\n")
    end = line[len(body):]
    body = re.sub(r"[ \t]*\u2014[ \t]*", ", ", body)
    body = re.sub(r" \u2013 ", ", ", body)
    body = re.sub(r"^([ \t]*), ", r"\1", body)  # a dash that opened the line
    return body.rstrip(" ") + end if body.endswith(", ") else body + end


def dash_fixed(vl, text):
    """text with every flagged dash made a comma, or None when a FAIL finding
    is not a dash, or the fixed text still fails."""
    rules = fail_only_rules(vl)
    flagged = set()
    for line_no, severity, check, _message in vl.lint_text(text, rules):
        if severity != "FAIL":
            continue
        if check not in DASH_CHECKS:
            return None
        flagged.add(line_no)
    lines = text.splitlines(keepends=True)
    for line_no in flagged:
        lines[line_no - 1] = comma_line(lines[line_no - 1])
    fixed = "".join(lines)
    if any(f[1] == "FAIL" for f in vl.lint_text(fixed, rules)):
        return None
    return fixed


def rewrite(vl, tool, tool_input):
    """tool_input with every new text's dashes fixed, or None."""
    out = dict(tool_input)
    if tool == "MultiEdit":
        out["edits"] = [dict(e) for e in tool_input["edits"]]
    for (label, text), target in zip(new_texts(tool, tool_input), new_slots(tool, out)):
        fixed = dash_fixed(vl, text)
        if fixed is None:
            return None
        target[0][target[1]] = fixed
    return out


def new_slots(tool, tool_input):
    """Where each new text lives, as (dict, key), in new_texts' order."""
    if tool == "Write":
        return [(tool_input, "content")]
    if tool == "Edit":
        return [(tool_input, "new_string")]
    return [(edit, "new_string") for edit in tool_input["edits"]]


def prose_call(data):
    """(tool, tool_input, path, pairs) for a call that adds prose, else None.

    Raises Unchecked when the input has the wrong shape.
    """
    if not isinstance(data, dict):
        raise Unchecked("hook input is not a JSON object")
    tool = data.get("tool_name")
    if tool not in TOOLS:
        return None
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        raise Unchecked("tool_input is not an object")
    path = tool_input.get("file_path")
    if not isinstance(path, str):
        raise Unchecked("file_path is missing or not a string")
    if not path.lower().endswith(PROSE_SUFFIXES):
        return None
    try:
        return tool, tool_input, path, new_texts(tool, tool_input)
    except ValueError as exc:
        raise Unchecked(str(exc))


def answer(path, hits, fixed):
    """Exit 0 with no hits; print the fixed input and exit 0; or block with exit 2."""
    if not hits:
        return 0
    if fixed is not None:
        note = ("write_guard made each banned dash in the new text for %s a "
                "comma (%s). Reword it if a comma reads wrong." % (path, RULE_FILE))
        sys.stdout.write(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow",
            "permissionDecisionReason": note,
            "updatedInput": fixed,
            "additionalContext": note,
        }}) + "\n")
        return 0
    say("write_guard: blocked. The new text for %s breaks the house rule in %s: "
        "no em dash, and no spaced en dash." % (path, RULE_FILE))
    for hit in hits:
        say("  " + hit)
    say("Fix: replace each dash; %s. Then make the call again." % FIX)
    return 2


def hook_main():
    """Hook mode: read the payload on stdin and return the exit code. Fails open."""
    try:
        try:
            data = json.loads(sys.stdin.buffer.read())
        except ValueError:
            return allow_with_note("hook input is not JSON")
        call = prose_call(data)
        if call is None:
            return 0
        tool, tool_input, path, pairs = call
        try:
            vl = load_voice_lint()
        except (Exception, SystemExit) as exc:
            return allow_with_note("voice_lint.py did not load: %s" % exc.__class__.__name__)
        hits = findings(vl, pairs)
        fixed = None
        if hits and data.get("permission_mode") in REWRITE_MODES:
            fixed = rewrite(vl, tool, tool_input)
    except Unchecked as exc:
        return allow_with_note(str(exc))
    except (Exception, SystemExit) as exc:  # infrastructure problem: fail open
        return allow_with_note(exc.__class__.__name__)
    return answer(path, hits, fixed)


def run_self_test():
    """Run tools/tests/test_write_guard.py against this module. Exit 2 with a pointer when it is absent.

    The installed copy in ~/.claude/code-os has no tests folder; the self-test
    runs from a Git Crafter checkout.
    """
    tests = os.path.join(HERE, "tests")
    if not os.path.isfile(os.path.join(tests, "test_write_guard.py")):
        say("write_guard: no self-test at %s; run it from a Git Crafter checkout: "
            "python3 -I tools/write_guard.py --self-test" % tests)
        return 2
    sys.path.append(tests)
    import test_write_guard
    return test_write_guard.run(sys.modules[__name__])


def main(argv):
    """Hook mode with no arguments, --self-test, or usage on stderr."""
    if not argv:
        return hook_main()
    if argv == ["--self-test"]:
        return run_self_test()
    say(__doc__ or "usage: write_guard.py [--self-test]")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
