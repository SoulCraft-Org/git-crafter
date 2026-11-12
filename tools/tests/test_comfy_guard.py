"""Self-test for tools/comfy_guard.py, run by `python3 -I tools/comfy_guard.py --self-test`.

Seeded payloads go to the hook against fake guards in a temp folder. It
never runs the real guard or comfy. comfy_guard.py passes itself in as
`tool`, so the test reads the module that is running, docstring included.
"""

import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import tempfile

# Fake guards: shell scripts the self-test writes to a temp folder. The go
# fake exits 9 unless it gets exactly `check comfy-cloud`, so a wrong call
# shows up as a deny.
FAKES = {
    "go": "#!/bin/sh\n[ \"$#\" = 2 ] && [ \"$1\" = check ] && [ \"$2\" = comfy-cloud ] || exit 9\n"
          "echo 'comfy-cloud: go. comfy-cloud 120 of 4200 credits'\nexit 1\n",
    "paused": "#!/bin/sh\necho 'comfy-cloud is paused: 3800 of 4200 credits'\nexit 0\n",
    "unknown": "#!/bin/sh\necho 'usage-guard: comfy-cloud is unknown, treat it as paused: signed out' >&2\nexit 2\n",
    "odd": "#!/bin/sh\nexit 3\n",
    "hang": "#!/bin/sh\nexec sleep 30\n",
}
SERVER = "mcp__plugin_comfy-cloud_comfy-cloud__"
WF, TPL, SAVED, BATCH = (SERVER + t for t in
                         ("submit_workflow", "run_template", "run_saved_workflow", "submit_batch"))
PARTNER = SERVER + "partner_generate"
SILENT = None


def call(tool, tool_input=None, mode="default"):
    """A PreToolUse payload for tool, with tool_input when given."""
    payload = {"hook_event_name": "PreToolUse", "tool_name": tool, "permission_mode": mode}
    if tool_input is not None:
        payload["tool_input"] = tool_input
    return payload


# (label, payload, fake guard, expected: SILENT or (decision, [text the reason must hold]))
CASES = [
    ("a non-run Comfy tool passes without a guard call", call(PARTNER, {"model": "x"}), "missing", SILENT),
    ("another tool passes without a guard call", call("Bash", {"command": "ls"}), "missing", SILENT),
    ("submit_workflow on go passes silently", call(WF, {"workflow": {}}), "go", SILENT),
    ("run_template on go passes silently", call(TPL, {"name": "t"}), "go", SILENT),
    ("run_saved_workflow on go passes silently", call(SAVED, {"filename": "w"}), "go", SILENT),
    ("submit_batch of templates on go passes silently",
     call(BATCH, {"items": [{"tool": "run_template", "name": "t"}]}), "go", SILENT),
    ("a run with no tool_input on go passes silently", call(WF), "go", SILENT),
    ("confirm false on go passes silently", call(WF, {"confirm": False}), "go", SILENT),
    ("confirm true asks in default mode", call(WF, {"confirm": True}), "go",
     ("ask", ["submit_workflow", "paid API nodes: the owner's yes for this spend", "confirm is set"])),
    ("confirm true asks in auto mode", call(TPL, {"confirm": True}, "auto"), "go",
     ("ask", ["run_template", "paid API nodes: the owner's yes for this spend"])),
    ("confirm true asks in acceptEdits mode", call(SAVED, {"confirm": True}, "acceptEdits"), "go",
     ("ask", ["run_saved_workflow"])),
    ("a string confirm counts as confirm", call(WF, {"confirm": "true"}), "go", ("ask", ["confirm is set"])),
    ("confirm true denies in bypassPermissions mode", call(WF, {"confirm": True}, "bypassPermissions"),
     "go", ("deny", ["bypassPermissions mode cannot prompt the owner", "paid API nodes"])),
    ("confirm true denies in dontAsk mode", call(BATCH, {"confirm": True, "items": []}, "dontAsk"),
     "go", ("deny", ["dontAsk mode cannot prompt the owner"])),
    ("a batch whose items set confirm asks",
     call(BATCH, {"items": [{"tool": "run_template", "name": "t", "confirm": True},
                            {"tool": "run_template", "name": "u", "confirm": "yes"}]}), "go",
     ("ask", ["submit_batch", "2 batch items set confirm"])),
    ("a batch item's confirm denies in bypassPermissions mode",
     call(BATCH, {"items": [{"tool": "run_template", "name": "t", "confirm": True}]}, "bypassPermissions"),
     "go", ("deny", ["1 batch item set confirm", "cannot prompt the owner"])),
    ("a batch with a partner_generate item asks",
     call(BATCH, {"items": [{"tool": "partner_generate", "model": "m", "type": "image"},
                            {"tool": "run_template", "name": "t"}]}), "go",
     ("ask", ["submit_batch", "1 partner_generate item"])),
    ("paused denies", call(WF, {"workflow": {}}), "paused", ("deny", ["paused", "is paused"])),
    ("paused denies a confirm before asking", call(WF, {"confirm": True}), "paused", ("deny", ["paused"])),
    ("unknown denies", call(TPL, {"name": "t"}), "unknown", ("deny", ["unknown", "signed out"])),
    ("any other exit denies", call(TPL, {"name": "t"}), "odd", ("deny", ["exit 3, read as unknown"])),
    ("a guard path that does not exist denies", call(WF, {}), "missing", ("deny", ["no usage guard to run at"])),
    ("a guard that is not executable denies", call(WF, {}), "noexec", ("deny", ["no usage guard to run at"])),
    ("a guard that hangs denies", call(WF, {}), "hang", ("deny", ["gave no answer"])),
    ("input that is not JSON denies", "not json {", "go", ("deny", ["not a JSON object"])),
    ("a JSON list denies", [1, 2], "go", ("deny", ["not a JSON object"])),
    ("a tool_input that is not an object denies", call(WF, [1]), "go", ("deny", ["input is not an object"])),
]

# Hook-mode arguments the settings entry never passes. A bad one denies.
BAD_ARGS = [["--guard"], ["--timeout", "soon"], ["--timeout", "0"], ["--where", "local"]]


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


def run_hook(script, payload, args, home):
    """Run the hook on payload with args. Returns (exit, stdout, stderr)."""
    raw = payload if isinstance(payload, str) else json.dumps(payload)
    env = {"PATH": "/usr/bin:/bin", "HOME": home}
    try:
        r = subprocess.run([sys.executable, "-I", script] + list(args), input=raw.encode("utf-8"),
                           capture_output=True, env=env, timeout=20)
    except subprocess.TimeoutExpired:
        return None, "", "the hook ran past 20 s"
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


def write_fakes(tmp):
    """Write each fake guard into tmp. Returns {name: path}, with missing and noexec too."""
    paths = {"missing": os.path.join(tmp, "no-such-guard")}
    for name, text in FAKES.items():
        path = os.path.join(tmp, "usage-guard-" + name)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(path, 0o755)
        paths[name] = path
    paths["noexec"] = os.path.join(tmp, "usage-guard-noexec")
    shutil.copy(paths["go"], paths["noexec"])
    os.chmod(paths["noexec"], 0o644)
    return paths


def wrong_decision(out, want):
    """What is wrong with stdout out against want, a (decision, needles) pair."""
    try:
        spec = json.loads(out)["hookSpecificOutput"]
    except (ValueError, KeyError, TypeError):
        return ["stdout is not one decision object: %r" % out.strip()]
    wrong = []
    if spec.get("hookEventName") != "PreToolUse":
        wrong.append("hookEventName %r" % spec.get("hookEventName"))
    if spec.get("permissionDecision") != want[0]:
        wrong.append("decision %r, expected %r" % (spec.get("permissionDecision"), want[0]))
    reason = spec.get("permissionDecisionReason", "")
    return wrong + ["reason lacks %r" % n for n in want[1] if n not in reason]


def wrong_run(code, out, want):
    """What is wrong with one hook run: exit code, then silence or the decision."""
    wrong = [] if code == 0 else ["exit %s, expected 0" % code]
    if want is SILENT:
        return wrong + (["printed %r, expected nothing" % out.strip()] if out.strip() else [])
    return wrong + wrong_decision(out, want)


def check_runs(checks, script):
    """Every CASES payload and every BAD_ARGS list, each through the hook as a subprocess."""
    with tempfile.TemporaryDirectory() as tmp:
        home = os.path.join(tmp, "home")
        os.makedirs(home)
        paths = write_fakes(tmp)
        runs = [(label, payload, ["--guard", paths[fake], "--timeout", "1"], want)
                for label, payload, fake, want in CASES]
        runs += [("bad arguments %r deny" % (args,), call(WF, {}), args, ("deny", ["bad argument"]))
                 for args in BAD_ARGS]
        for label, payload, args, want in runs:
            code, out, err = run_hook(script, payload, args, home)
            wrong = wrong_run(code, out, want)
            checks.check(not wrong, label, "; ".join(wrong) + ("\n    stderr: " + err.strip() if err.strip() else ""))


def check_default_guard(checks, tool):
    """With no --guard the hook trusts only ~/.local/bin/usage-guard under the
    password database's home: a changed HOME or a usage-guard planted on PATH
    moves nothing. Checked in-process; no guard runs."""
    saved = dict(os.environ)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            planted = os.path.join(tmp, "usage-guard")
            with open(planted, "w", encoding="utf-8") as fh:
                fh.write(FAKES["go"])
            os.chmod(planted, 0o755)
            os.environ.update(HOME=tmp, PATH=tmp)
            want = os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".local", "bin", "usage-guard")
            got = tool.default_guard()
            checks.check(got == want and not got.startswith(tmp),
                         "the default guard ignores HOME and PATH", "got %r" % got)
    finally:
        os.environ.clear()
        os.environ.update(saved)


def wiring_entry(tool):
    """The settings.json entry the tool's header documents, parsed."""
    doc = tool.__doc__ or ""
    start = doc.index('{"matcher"')
    end = doc.index("]}", start) + 2
    return json.loads(doc[start:end])


def check_wiring(checks, tool):
    """The documented settings entry: valid JSON, fails closed, waits longer
    than the hook does, and its matcher (an unanchored regex, read here with
    re.search) takes the four run tools and nothing else."""
    try:
        entry = wiring_entry(tool)
        hook = entry["hooks"][0]
        checks.check(hook.get("onFailure") == "block", "the documented entry blocks on failure")
        checks.check(hook.get("timeout", 0) > tool.DEFAULT_WAIT_S, "the documented timeout exceeds the hook's wait",
                     "timeout %r" % hook.get("timeout"))
        checks.check(hook.get("command") == "python3 -I ~/.claude/code-os/comfy_guard.py",
                     "the documented command runs the installed copy", repr(hook.get("command")))
        matcher = re.compile(entry["matcher"])
        for name in tool.RUN_TOOLS:
            checks.check(bool(matcher.search(name)), "the matcher takes " + name)
        for name in (PARTNER, SERVER + "estimate_credits", SERVER + "share_workflow", "Bash"):
            checks.check(not matcher.search(name), "the matcher skips " + name)
    except (ValueError, KeyError, IndexError, TypeError, re.error) as exc:
        checks.check(False, "the documented settings entry parses", repr(exc))


def run(tool):
    """Run every check against tool, the comfy_guard module. Returns the exit code."""
    checks = Checks()
    checks.check(tuple((WF, TPL, SAVED, BATCH)) == tool.RUN_TOOLS, "the test's run tools match the hook's")
    check_runs(checks, os.path.realpath(tool.__file__))
    check_default_guard(checks, tool)
    check_wiring(checks, tool)
    if checks.failures:
        print("comfy_guard self-test: FAIL (%d failed, %d passed)" % (len(checks.failures), checks.passed))
        for f in checks.failures:
            print("  -", f)
        return 1
    print("comfy_guard self-test: ok (%d checks)" % checks.passed)
    return 0
