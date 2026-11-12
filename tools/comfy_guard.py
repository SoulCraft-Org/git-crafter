#!/usr/bin/env python3
"""comfy_guard.py: a PreToolUse hook that holds the Comfy Cloud spend stops.

Canonical source: Git Crafter tools/comfy_guard.py. The installed copy lives at
~/.claude/code-os/comfy_guard.py. If the two disagree, Git Crafter wins. Fix the
copy with `claude_os_sync.py apply user-claude --yes`. The rule it holds is
rules/comfy.md; this file decides nothing that rule does not say.

Fires or waits. This hook fires only once ~/.claude/settings.json wires it
as a PreToolUse hook. Git Crafter installs the file and does not wire it, so
until someone adds the entry, nothing calls it. The entry reads:

  {"matcher": "mcp__plugin_comfy-cloud_comfy-cloud__(submit_workflow|run_template|run_saved_workflow|submit_batch)",
   "hooks": [{"type": "command",
              "command": "python3 -I ~/.claude/code-os/comfy_guard.py",
              "timeout": 90, "onFailure": "block"}]}

The parentheses make the matcher an unanchored regex. The 90 s timeout sits
above this hook's own 75 s wait, which sits above usage-guard's 60 s limit
on one provider call (CALL_TIMEOUT_S in its shell.py). "onFailure": "block"
needs Claude Code 2.1.295 or later. Without it, a hook that crashes or
times out lets the call through. Source: the hooks doc, "Matcher patterns"
and "Block the action when a hook fails", read 2026-11-06.

What it decides, for the four run tools only. Every other tool passes with
no output and no guard call.
  1. Run `usage-guard check comfy-cloud`. Exit 1 is go. Anything else
     denies, quoting the guard: exit 0 is paused at the stop, exit 2 is
     unknown, and a guard that is missing, hangs or crashes is unknown.
  2. On go, a call that answers the MCP's spend prompt (tool_input.confirm
     set) asks, so the owner answers in Claude Code's own permission prompt, not
     a model-typed yes. A submit_batch holding a partner_generate item asks
     too, since partner_generate is in permissions.ask on its own. In
     bypassPermissions or dontAsk mode it denies instead: the hooks doc does
     not say a hook's ask prompts in those modes (read 2026-11-06).
  3. On go with nothing to ask, it prints nothing, and the normal
     permission flow decides. It never answers allow.
The guard runs first, so a paused lane denies even a call the owner would
confirm: the stop covers every run.

Failure policy. Fails closed, unlike the other Git Crafter guards. The rule in
rules/gates.md is to fail open on infrastructure. This is a money stop, and
its rule is to go only on exit 1 (rules/comfy.md). Input that is not a
JSON object, a tool_input that is not an object, and any exception inside
the hook deny.

Hook protocol. Reads the PreToolUse JSON on stdin: tool_name, tool_input,
permission_mode. Prints at most one JSON object and exits 0:
  {"hookSpecificOutput": {"hookEventName": "PreToolUse",
   "permissionDecision": "ask" or "deny", "permissionDecisionReason": "..."}}

Which guard it trusts. Only ~/.local/bin/usage-guard, under the home
directory the password database gives this user. Never one found on PATH or
named by an environment variable, so a planted binary or a changed variable
cannot answer go. The same user can still rewrite that file or the guard it
links to; that defeats the stop, and THREAT-MODEL.md lists it.

Commands:
  (no args)               hook mode, reads stdin; the settings entry
  --guard PATH --timeout S
                          hook mode with a stand-in guard and wait, for the
                          self-test only; the settings entry never passes them
  --self-test             runs tools/tests/test_comfy_guard.py: seeded
                          payloads against fake guards in a temp folder; it
                          never runs the real guard or comfy. Exits 2 where
                          that folder is absent, as in ~/.claude/code-os

Requires Python 3.9, standard library only. Run it as `python3 -I`.
"""

import json
import os
import pwd
import signal
import subprocess
import sys

SERVER = "mcp__plugin_comfy-cloud_comfy-cloud__"
RUN_TOOLS = tuple(SERVER + t for t in
                  ("submit_workflow", "run_template", "run_saved_workflow", "submit_batch"))
NO_PROMPT_MODES = ("bypassPermissions", "dontAsk")
DEFAULT_WAIT_S = 75.0
RULE = "rules/comfy.md"
NOT_CONFIRM = ("", "false", "0", "no", "none", "null")


def decision(kind, reason):
    """The PreToolUse hook output for a permission decision of kind, with reason."""
    return {"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                   "permissionDecision": kind,
                                   "permissionDecisionReason": reason}}


def default_guard():
    """~/.local/bin/usage-guard under this user's home from the password database, never $HOME or PATH."""
    return os.path.join(pwd.getpwuid(os.getuid()).pw_dir, ".local", "bin", "usage-guard")


def last_line(*texts):
    """The last non-blank line across texts, cut to 300 characters."""
    lines = [ln.strip() for t in texts for ln in t.splitlines() if ln.strip()]
    return lines[-1][:300] if lines else ""


def ask_guard(guard, wait):
    """(go, words). Go only when `usage-guard check comfy-cloud` exits 1."""
    if not (os.path.isfile(guard) and os.access(guard, os.X_OK)):
        return False, "no usage guard to run at " + guard
    try:
        proc = subprocess.Popen([guard, "check", "comfy-cloud"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                start_new_session=True)
    except OSError as exc:
        return False, "could not run %s: %s" % (guard, exc.strerror or exc)
    try:
        out, err = proc.communicate(timeout=wait)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        proc.wait()
        return False, "usage-guard check comfy-cloud gave no answer in %g s" % wait
    words = last_line(out.decode("utf-8", "replace"), err.decode("utf-8", "replace"))
    if proc.returncode == 1:
        return True, words
    what = {0: "paused", 2: "unknown"}.get(proc.returncode,
                                           "exit %d, read as unknown" % proc.returncode)
    return False, "usage-guard check comfy-cloud: %s%s" % (what, " (%s)" % words if words else "")


def confirms(tool_input):
    """Whether the call answers the MCP's spend prompt. Any value but an empty or false one counts."""
    value = tool_input.get("confirm")
    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value.strip().lower() not in NOT_CONFIRM
    if isinstance(value, (int, float)) and value == 0:
        return False
    return True


def batch_items(tool, tool_input):
    """The dict items of a submit_batch call; none for any other tool."""
    if not tool.endswith("__submit_batch"):
        return []
    items = tool_input.get("items")
    return [it for it in items if isinstance(it, dict)] if isinstance(items, list) else []


def plural(n, word):
    """n and word, with an s unless n is 1."""
    return "%d %s%s" % (n, word, "" if n == 1 else "s")


def spend_reasons(tool, tool_input):
    """Why a call needs the owner's yes: a confirm, partner_generate items, batch items that confirm."""
    why = []
    if confirms(tool_input):
        why.append("confirm is set")
    items = batch_items(tool, tool_input)
    partners = sum(1 for it in items if it.get("tool") == "partner_generate")
    if partners:
        why.append(plural(partners, "partner_generate item"))
    item_confirms = sum(1 for it in items if confirms(it))
    if item_confirms:
        why.append(plural(item_confirms, "batch item") + " set confirm")
    return why


def decide(payload, guard, wait):
    """None for no output, else the decision to print."""
    if not isinstance(payload, dict):
        return decision("deny", "comfy_guard: the hook input is not a JSON object, "
                                "so the Comfy spend stop could not be checked (%s)" % RULE)
    tool = payload.get("tool_name")
    if tool not in RUN_TOOLS:
        return None
    short = tool[len(SERVER):]
    tool_input = payload.get("tool_input", {})
    if not isinstance(tool_input, dict):
        return decision("deny", "comfy_guard: %s input is not an object, "
                                "so the Comfy spend stop could not be checked (%s)" % (short, RULE))
    go, words = ask_guard(guard, wait)
    if not go:
        return decision("deny", "Comfy spend stop (%s): %s. Go is usage-guard exit 1 only. "
                                "Use the next lane or stop, and tell the owner." % (RULE, words))
    why = spend_reasons(tool, tool_input)
    if not why:
        return None
    mode = payload.get("permission_mode")
    if mode in NO_PROMPT_MODES:
        return decision("deny", "%s: paid API nodes need the owner's yes for this spend (%s), and %s mode "
                                "cannot prompt the owner. Ask in chat; the owner runs it in a mode that prompts (%s tier 3)."
                        % (short, "; ".join(why), mode, RULE))
    return decision("ask", "%s: paid API nodes: the owner's yes for this spend (%s; %s tier 3)"
                    % (short, "; ".join(why), RULE))


def hook_main(guard=None, wait=DEFAULT_WAIT_S):
    """Hook mode: read the payload on stdin, print a decision or nothing, exit 0. Fails closed."""
    try:
        try:
            payload = json.loads(sys.stdin.buffer.read())
        except ValueError:
            payload = None
        out = decide(payload, guard or default_guard(), wait)
    except Exception as exc:  # a money stop fails closed
        out = decision("deny", "comfy_guard failed (%s), so the Comfy spend stop could not be "
                               "checked (%s)" % (type(exc).__name__, RULE))
    if out is not None:
        sys.stdout.write(json.dumps(out) + "\n")
        sys.stdout.flush()
    return 0


def run_self_test():
    """Run tools/tests/test_comfy_guard.py against this module. Exit 2 with a pointer when it is absent.

    The installed copy in ~/.claude/code-os has no tests folder; the self-test
    runs from a Git Crafter checkout.
    """
    tests = os.path.join(os.path.dirname(os.path.realpath(__file__)), "tests")
    if not os.path.isfile(os.path.join(tests, "test_comfy_guard.py")):
        sys.stderr.write("comfy_guard: no self-test at %s; run it from a Git Crafter checkout: "
                         "python3 -I tools/comfy_guard.py --self-test\n" % tests)
        return 2
    sys.path.append(tests)
    import test_comfy_guard
    return test_comfy_guard.run(sys.modules[__name__])


def main(argv):
    """Route --self-test, or parse the hook-mode flags; a bad flag denies."""
    if argv == ["--self-test"]:
        return run_self_test()
    guard, wait, rest = None, DEFAULT_WAIT_S, list(argv)
    try:
        while rest:
            flag = rest.pop(0)
            if flag == "--guard" and rest:
                guard = rest.pop(0)
            elif flag == "--timeout" and rest:
                wait = float(rest.pop(0))
                if not wait > 0:
                    raise ValueError("--timeout %g" % wait)
            else:
                raise ValueError(flag)
    except ValueError as exc:  # fails closed, whatever onFailure says
        sys.stdout.write(json.dumps(decision("deny", "comfy_guard: bad argument (%s), so the Comfy spend "
                                                     "stop could not be checked (%s)" % (exc, RULE))) + "\n")
        return 0
    return hook_main(guard, wait)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
