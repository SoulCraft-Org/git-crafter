"""Self-test for tools/turn_check.py, run by `python3 -I tools/turn_check.py --self-test`.

Each case writes a seeded transcript, sends a Stop payload to the hook as a
subprocess and checks the answer: a block naming the missing call, or
silence. turn_check.py passes itself in as `tool`, so the test runs the file
that called it.
"""

import json
import os
import subprocess
import sys
import tempfile
import time

PLAN = "mcp__ccd_turn__update_plan"
RECAP = "mcp__ccd_turn__wrap_up"
_ids = iter(range(1, 1 << 30))


def human(text="do the task", entry="claude-desktop"):
    """A prompt a person typed."""
    return {"type": "user", "entrypoint": entry, "origin": {"kind": "human"},
            "message": {"role": "user", "content": text}}


def other_user(text):
    """A user record no person typed: a session's message or a notice."""
    return {"type": "user", "entrypoint": "claude-desktop", "message": {"role": "user", "content": text}}


def call(name, cid=None):
    """An assistant record with one tool call, and its id."""
    cid = cid or "toolu_%d" % next(_ids)
    return {"type": "assistant", "entrypoint": "claude-desktop",
            "message": {"role": "assistant", "content": [{"type": "tool_use", "id": cid, "name": name, "input": {}}]}}


def result(cid, status=None):
    """The user record holding a tool's result."""
    rec = {"type": "user", "entrypoint": "claude-desktop",
           "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": cid, "content": "ok"}]}}
    if status:
        rec["toolUseResult"] = {"status": status}
    return rec


def notice(cid):
    """A subagent's end notice for the Agent call cid."""
    return other_user("<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>%s</tool-use-id>\n"
                      "<status>completed</status>\n</task-notification>" % cid)


def turn(*names, entry="claude-desktop"):
    """A human prompt followed by one call and its result per name."""
    out = [human(entry=entry)]
    for name in names:
        rec = call(name)
        res = result(rec["message"]["content"][0]["id"])
        rec["entrypoint"] = res["entrypoint"] = entry
        out += [rec, res]
    return out


def agent_running(finished):
    """An edit turn with plan and nothing else, whose Agent call launched in the background."""
    a = call("Agent")
    aid = a["message"]["content"][0]["id"]
    recs = [human(), call("Edit"), a, result(aid, "async_launched")]
    if finished:
        recs.append(notice(aid))
    return recs


CASES = [
    # (label, records, stop_hook_active, expected: None allow, or a substring of the reason)
    ("an edit turn with neither call blocks, naming both", turn("Edit"), False, "no task list or recap"),
    ("two Bash calls with a plan only block on wrap_up", turn(PLAN, "Bash", "Bash"), False, "missing " + RECAP),
    ("a Write with a recap only blocks on update_plan", turn("Write", RECAP), False, "missing " + PLAN),
    ("MultiEdit counts as an edit", turn("MultiEdit"), False, "no task list"),
    ("NotebookEdit counts as an edit", turn("NotebookEdit"), False, "no task list"),
    ("a turn with both calls passes", turn(PLAN, "Edit", RECAP), False, None),
    ("one Bash call is no work turn", turn("Bash", "Read"), False, None),
    ("a turn with no tool call passes", [human()], False, None),
    ("a terminal session passes", turn("Edit", entry="cli"), False, None),
    ("stop_hook_active passes: never two blocks in a row", turn("Edit"), True, None),
    ("a turn ending in ExitPlanMode passes", turn("Edit", "ExitPlanMode"), False, None),
    ("a turn ending in AskUserQuestion passes", turn("Bash", "Bash", "AskUserQuestion"), False, None),
    ("AskUserQuestion earlier in the turn does not excuse it", turn("AskUserQuestion", "Edit"), False, "no task list"),
    ("a still-running Agent passes", agent_running(False), False, None),
    ("an Agent whose notice came back blocks", agent_running(True), False, "no task list"),
    ("an earlier turn's calls do not count", turn(PLAN, RECAP) + turn("Edit"), False, "no task list"),
    ("a session message is no turn start", [human(), call(PLAN), other_user("from a session"), call("Edit"), call(RECAP)], False, None),
    ("a tool result marked human is no turn start", [human(), call(PLAN), result("toolu_x") | {"origin": {"kind": "human"}}, call("Edit")], False, "missing " + RECAP),
    ("a meta record marked human is no turn start", [human(), call(PLAN), human() | {"isMeta": True}, call("Edit"), call(RECAP)], False, None),
    ("a transcript with no human prompt passes", [call("Edit"), call("Edit")], False, None),
]


class Checks:
    """Counts passes and keeps failure messages."""

    def __init__(self):
        self.passed = 0
        self.failures = []

    def check(self, ok, label, detail=""):
        if ok:
            self.passed += 1
        else:
            self.failures.append("%s: %s" % (label, detail))


def write_transcript(path, records, junk=True):
    with open(path, "w", encoding="utf-8") as fh:
        if junk:
            fh.write("not json\n{\"type\": \"attachment\"}\n")
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


def run_hook(script, stdin):
    """Run the hook with stdin text; return (exit code, stdout, seconds)."""
    start = time.monotonic()
    proc = subprocess.run([sys.executable, "-I", script], input=stdin, capture_output=True,
                          text=True, timeout=30)
    return proc.returncode, proc.stdout.strip(), time.monotonic() - start


def expect(checks, label, code, out, want):
    if want is None:
        checks.check(code == 0 and out == "", label, "exit %s, stdout %r" % (code, out))
        return
    try:
        answer = json.loads(out)
    except ValueError:
        answer = {}
    ok = code == 0 and answer.get("decision") == "block" and want in answer.get("reason", "")
    checks.check(ok, label, "exit %s, stdout %r" % (code, out))


def check_cases(checks, script, tmp):
    for i, (label, records, active, want) in enumerate(CASES):
        path = os.path.join(tmp, "case%d.jsonl" % i)
        write_transcript(path, records)
        payload = json.dumps({"transcript_path": path, "stop_hook_active": active, "hook_event_name": "Stop"})
        code, out, _s = run_hook(script, payload)
        expect(checks, label, code, out, want)


def check_bad_input(checks, script, tmp):
    for label, stdin in (
        ("stdin that is not JSON passes", "{nope"),
        ("an empty stdin passes", ""),
        ("a JSON list passes", "[1, 2]"),
        ("a missing transcript passes", json.dumps({"transcript_path": os.path.join(tmp, "gone.jsonl")})),
        ("a transcript path that is a folder passes", json.dumps({"transcript_path": tmp})),
        ("a transcript path of the wrong type passes", json.dumps({"transcript_path": 7})),
    ):
        code, out, _s = run_hook(script, stdin)
        expect(checks, label, code, out, None)


def check_large(checks, script, tmp):
    """A 50 MB transcript: the hook reads only the tail and ends in well under a second."""
    path = os.path.join(tmp, "large.jsonl")
    filler = json.dumps(result("toolu_old") | {"pad": "x" * 4000}) + "\n"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(filler * (50 * 1000 * 1000 // len(filler)))
        for rec in turn("Edit"):
            fh.write(json.dumps(rec) + "\n")
    payload = json.dumps({"transcript_path": path, "stop_hook_active": False})
    code, out, seconds = run_hook(script, payload)
    expect(checks, "a 50 MB transcript still blocks its open turn", code, out, "no task list")
    checks.check(seconds < 1.0, "a 50 MB transcript is judged in under a second", "%.2f s" % seconds)


# About 70 MB of records after the prompt: past the hook's 64 MiB tail cap.
PAST_CAP = 70 * 1000 * 1000


def pad_line(size):
    """One tool-result line of about size bytes, which the hook skips unparsed."""
    return json.dumps(result("toolu_pad") | {"pad": "x" * size}) + "\n"


def check_tail(checks, script, tool, tmp):
    """The tail reader: a start past the cap, a turn over many blocks, a torn last line."""
    def judge(label, path, want):
        code, out, _s = run_hook(script, json.dumps({"transcript_path": path, "stop_hook_active": False}))
        expect(checks, label, code, out, want)

    checks.check(tool.MAX_TAIL < PAST_CAP, "the past-cap case is longer than MAX_TAIL", str(tool.MAX_TAIL))
    path = os.path.join(tmp, "past_cap.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for rec in turn("Edit"):
            fh.write(json.dumps(rec) + "\n")
        block = pad_line(4000) * 256
        for _ in range(PAST_CAP // len(block)):
            fh.write(block)
    judge("a turn whose start lies past the tail cap passes", path, None)

    path = os.path.join(tmp, "many_blocks.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        plan = call(PLAN)
        plan["message"]["content"][0]["input"] = {"items": "x" * (tool.BLOCK * 2 + 777)}
        fh.write(json.dumps(human()) + "\n" + json.dumps(plan) + "\n")
        fh.write(pad_line(tool.BLOCK * 2 + 777))
        fh.write(pad_line(3001) * ((tool.BLOCK * 3) // 3000))
        fh.write(json.dumps(call("Edit")) + "\n")
    judge("a plan call longer than two blocks is still read, and wrap_up is missing", path, "missing " + RECAP)

    path = os.path.join(tmp, "torn.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for rec in turn("Edit"):
            fh.write(json.dumps(rec) + "\n")
        torn = json.dumps(call(RECAP))
        fh.write(torn[:torn.index('"tool_use"') + 20])
    judge("a half-written last line is skipped and the turn still blocks", path, "no task list")


def run(tool):
    """Run every check against tool, the turn_check module. Returns the exit code."""
    checks = Checks()
    script = os.path.realpath(tool.__file__)
    with tempfile.TemporaryDirectory() as tmp:
        check_cases(checks, script, tmp)
        check_bad_input(checks, script, tmp)
        check_large(checks, script, tmp)
        check_tail(checks, script, tool, tmp)
    if checks.failures:
        print("turn_check self-test: FAIL (%d failed, %d passed)" % (len(checks.failures), checks.passed))
        for f in checks.failures:
            print("  -", f)
        return 1
    print("turn_check self-test: ok (%d checks)" % checks.passed)
    return 0
