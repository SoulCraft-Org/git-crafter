#!/usr/bin/env python3
"""turn_check.py: a Stop hook that asks a desktop work turn for its task list and recap.

Canonical source: Git Crafter tools/turn_check.py. The installed copy lives at
~/.claude/code-os/turn_check.py. If the two disagree, Git Crafter wins. Fix the
copy with `claude_os_sync.py apply user-claude --yes`.

Fires or waits. This hook fires only once ~/.claude/settings.json wires it as
a Stop hook. Git Crafter installs the file and does not wire it, so until
someone adds the entry, nothing calls it. The entry would read:

  "Stop": [{"hooks": [{"type": "command",
   "command": "python3 -I ~/.claude/code-os/turn_check.py",
   "timeout": 5}]}]

What it decides. The desktop app shows a task list under the latest message
and a next-step box at the end of a turn, from two tools:
mcp__ccd_turn__update_plan and mcp__ccd_turn__wrap_up. The Quality page's
desktop_app.turns_closed reads the share of work turns that call both. This
hook blocks the end of a turn once, naming the missing call, when ALL hold:
  1. the transcript's records carry entrypoint claude-desktop;
  2. stop_hook_active is false, so it never blocks twice in a row;
  3. the turn, every record since the last user record whose origin.kind is
     human, has an Edit, Write, MultiEdit or NotebookEdit call, or two or
     more Bash calls;
  4. the turn's last tool call is not ExitPlanMode or AskUserQuestion, which
     hand the turn to the person;
  5. no Agent call of the turn is still running: an Agent result whose
     toolUseResult.status is async_launched, with no later user record that
     starts <task-notification> and names its tool-use-id;
  6. the turn lacks an update_plan call or a wrap_up call.

What it reads. Only the transcript's tail, back to the turn's first record,
in 1 MiB blocks from the end, at most 64 MiB. A line is parsed only when a
cheap substring test says it can matter: a tool call, a human prompt, an
async launch or a notice. A turn longer than the cap, or one whose start
is not found, is allowed.

Failure policy. Fail open: input that is not a JSON object, a missing or
unreadable transcript, a parse error and any exception all allow, silently.
Could not check is never a block.

Hook protocol (code.claude.com/docs/en/hooks, Stop decision control, read
2026-11-10). Reads the hook JSON on stdin. Exit 0 with nothing on stdout
allows. A block prints {"decision": "block", "reason": "..."} on stdout and
exits 0; Claude Code then continues the turn with the reason.

Commands:
  (no args)     hook mode, reads stdin
  --self-test   runs tools/tests/test_turn_check.py. Exits 2 where that
                folder is absent, as in ~/.claude/code-os

Requires Python 3.9, standard library only. Run it as `python3 -I`.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
ENTRYPOINT = "claude-desktop"
PLAN_TOOL = "mcp__ccd_turn__update_plan"
RECAP_TOOL = "mcp__ccd_turn__wrap_up"
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
COMMAND_TOOL = "Bash"
HANDOFF_TOOLS = ("ExitPlanMode", "AskUserQuestion")
AGENT_TOOL = "Agent"
ASYNC_STATUS = "async_launched"
NOTICE = "<task-notification>"
BLOCK = 1 << 20
MAX_TAIL = 64 << 20

ENTRY_RE = re.compile(r'"entrypoint"\s*:\s*"([^"]*)"')
NOTICE_ID_RE = re.compile(r"<tool-use-id>([^<]+)</tool-use-id>")


def tail_lines(path):
    """Yield the file's lines from the last to the first, at most MAX_TAIL bytes back."""
    with open(path, "rb") as fh:
        fh.seek(0, os.SEEK_END)
        pos = fh.tell()
        start = pos
        rest = b""
        while pos > 0 and start - pos < MAX_TAIL:
            step = min(BLOCK, pos)
            pos -= step
            fh.seek(pos)
            chunk = fh.read(step) + rest
            lines = chunk.split(b"\n")
            rest = lines[0]
            for line in reversed(lines[1:]):
                yield line
        if pos == 0:
            yield rest


def content_of(record):
    """The message content of a record as a list of parts, or a string."""
    message = record.get("message")
    return message.get("content") if isinstance(message, dict) else None


def text_of(content):
    """A user content's plain text, joined across text parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if isinstance(p, dict) and isinstance(p.get("text"), str))
    return ""


def is_human_start(record):
    """A prompt a person typed: a user record, origin.kind human, no tool result."""
    if record.get("type") != "user" or record.get("isMeta"):
        return False
    origin = record.get("origin")
    if not isinstance(origin, dict) or origin.get("kind") != "human":
        return False
    content = content_of(record)
    return not (isinstance(content, list) and any(isinstance(p, dict) and p.get("type") == "tool_result" for p in content))


# What a raw line must hold, besides a person's prompt, to be worth parsing.
MARKS = (b'"tool_use"', ASYNC_STATUS.encode(), NOTICE.encode())


def _entry(raw):
    """The entrypoint one raw transcript line names, or None."""
    m = ENTRY_RE.search(raw.decode("utf-8", "replace")) if b'"entrypoint"' in raw else None
    return m.group(1) if m else None


def _record(raw):
    """The JSON object on one raw line, or None when the line is not one."""
    try:
        record = json.loads(raw)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def read_turn(path):
    """The turn's records, oldest first, and the entrypoint seen; None when its start is not found."""
    records = []
    entrypoint = None
    for raw in tail_lines(path):
        if entrypoint is None:
            entrypoint = _entry(raw)
        human = b'"origin"' in raw and b'"human"' in raw
        record = _record(raw) if human or any(mark in raw for mark in MARKS) else None
        if record is None:
            continue
        if human and is_human_start(record):
            records.reverse()
            return records, entrypoint
        records.append(record)
    return None, entrypoint


def _parts(content, kind):
    """The parts of one content list that have the given type; none when the content is not a list."""
    return [p for p in content if isinstance(p, dict) and p.get("type") == kind] if isinstance(content, list) else []


def _calls(records):
    """Each tool call of the turn as (id, name), in order."""
    return [(p.get("id"), p.get("name")) for r in records if r.get("type") == "assistant" for p in _parts(content_of(r), "tool_use")]


def _waiting(records):
    """The ids of background launches whose completion notice has not arrived."""
    launched = set()
    for record in records:
        if record.get("type") != "user":
            continue
        content = content_of(record)
        result = record.get("toolUseResult")
        if isinstance(result, dict) and result.get("status") == ASYNC_STATUS:
            launched |= {p.get("tool_use_id") for p in _parts(content, "tool_result")}
        text = text_of(content)
        if text.startswith(NOTICE):
            launched -= set(NOTICE_ID_RE.findall(text))
    return launched


def _missing(plan, recap):
    """The block reason for a work turn with or without a plan and a recap; None when it has both."""
    if plan and recap:
        return None
    if not plan and not recap:
        return ("This work turn has no task list or recap: call %s with the whole plan, "
                "then %s before your closing message." % (PLAN_TOOL, RECAP_TOOL))
    return "This work turn is missing %s: call it before your closing message." % (RECAP_TOOL if plan else PLAN_TOOL)


def judge(records):
    """The block reason for a turn's records, or None to allow."""
    calls = _calls(records)
    names = [name for _id, name in calls]
    agents = {cid for cid, name in calls if name == AGENT_TOOL}
    work = any(n in EDIT_TOOLS for n in names) or names.count(COMMAND_TOOL) >= 2
    # No work means no names worth judging, so names[-1] is read only when a call exists.
    if not work or names[-1] in HANDOFF_TOOLS or _waiting(records) & agents:
        return None
    return _missing(PLAN_TOOL in names, RECAP_TOOL in names)


def decide(payload):
    """The block reason for one hook payload, or None to allow."""
    if not isinstance(payload, dict) or payload.get("stop_hook_active"):
        return None
    path = payload.get("transcript_path")
    if not isinstance(path, str) or not os.path.isfile(path):
        return None
    records, entrypoint = read_turn(path)
    if records is None or entrypoint != ENTRYPOINT:
        return None
    return judge(records)


def hook_main():
    """Read the Stop payload on stdin; print a block or nothing. Always exit 0."""
    try:
        reason = decide(json.loads(sys.stdin.read() or "null"))
    except Exception:  # fail open: could not check is never a block
        reason = None
    if reason:
        sys.stdout.write(json.dumps({"decision": "block", "reason": reason}) + "\n")
    return 0


def run_self_test():
    """Run tools/tests/test_turn_check.py against this module. Exit 2 with a pointer when it is absent."""
    tests = os.path.join(HERE, "tests")
    if not os.path.isfile(os.path.join(tests, "test_turn_check.py")):
        sys.stderr.write("turn_check: no self-test at %s; run it from a Git Crafter checkout: "
                         "python3 -I tools/turn_check.py --self-test\n" % tests)
        return 2
    sys.path.append(tests)
    import test_turn_check
    return test_turn_check.run(sys.modules[__name__])


def main(argv):
    """Hook mode with no arguments, --self-test, or usage on stderr."""
    if not argv:
        return hook_main()
    if argv == ["--self-test"]:
        return run_self_test()
    sys.stderr.write(__doc__ or "usage: turn_check.py [--self-test]")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
