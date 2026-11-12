"""bash_guard_slow.py: The few paths that need subprocess, imported only when used: the git
facts a push rule reads, and --status.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import json
import os
import re
import sys


INSTALLED = os.path.expanduser("~/.claude/code-os/bash_guard.py")


MANAGED_SETTINGS = os.environ.get(
    "BASH_GUARD_MANAGED", "/Library/Application Support/ClaudeCode/managed-settings.json")


SHELL_TOOLS = ("Bash", "mcp__plugin_desktop-commander_desktop-commander__start_process",
               "mcp__plugin_desktop-commander_desktop-commander__interact_with_process",
               "mcp__terminal__run_in_terminal")


def load_slow_modules():
    """Import shutil, subprocess and tempfile for the few paths that use
    them: the push check, --status and the self-test. Loading them on every
    hook call cost about 45 ms of the guard's ~100 (measured 2026-11-05)."""
    global shutil, subprocess, tempfile
    import shutil  # noqa: F401
    import subprocess  # noqa: F401
    import tempfile  # noqa: F401


def git_branch_facts(path):
    """Return (branch, upstream) for a checkout, or Nones."""
    load_slow_modules()
    def run(args):
        try:
            r = subprocess.run(["git", "-C", path] + args, capture_output=True,
                               text=True, timeout=3)
            return r.stdout.strip() if r.returncode == 0 else None
        except Exception:
            return None
    return (run(["symbolic-ref", "--short", "-q", "HEAD"]),
            run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]))


def read_json(path):
    """(data, None) for a JSON file, ({}, None) when it is absent, and
    ({}, the error's class name) when it cannot be read."""
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), None
    except FileNotFoundError:
        return {}, None
    except (OSError, ValueError) as exc:
        return {}, exc.__class__.__name__


def status(repo=None):
    """Exit 0 only when the installed guard is wired, enabled and blocking."""
    load_slow_modules()
    if repo is None:  # default to the repo this command runs in
        repo = current_repo()
    user_path = os.path.expanduser("~/.claude/settings.json")
    user, err = read_json(user_path)
    problems = [f"cannot read {user_path} ({err})"] if err else []
    problems += coverage_problems(user)
    more, notes = layer_problems(user, repo)
    problems += more + install_problems()
    for p in problems:
        print("guard status: FAIL", p)
    for n in notes:
        print("guard status: note", n)
    print("guard status:", "ok" if not problems else "not protecting")
    return 0 if not problems else 1


def current_repo():
    """The top folder of the git checkout this command runs in, or None."""
    try:
        r = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                           capture_output=True, text=True, timeout=5)
        return (r.stdout.strip() or None) if r.returncode == 0 else None
    except Exception:
        return None


def coverage_problems(user):
    """One problem for each shell tool no user PreToolUse hook guards."""
    covered, problems = covered_tools(user), []
    if "Bash" not in covered:
        problems.append("no PreToolUse hook on Bash runs the installed guard")
    for t in SHELL_TOOLS[1:]:
        if t not in covered:
            problems.append(f"no PreToolUse hook on {t} runs the installed guard")
    return problems


def covered_tools(user):
    """The shell tools whose PreToolUse matcher runs the installed guard."""
    covered = set()
    for entry in (user.get("hooks") or {}).get("PreToolUse", []):
        tools = [t for t in SHELL_TOOLS if re.search(
            r"(^|\|)" + re.escape(t) + r"(\||$)", entry.get("matcher") or "")]
        for h in entry.get("hooks", []):
            if hook_runs_guard(h):
                covered.update(tools)
    return covered


def hook_runs_guard(h):
    """True when a hook's command runs the installed guard."""
    cmd = " ".join([h.get("command") or ""] + list(h.get("args") or []))
    return INSTALLED in cmd or "~/.claude/code-os/bash_guard.py" in cmd


def layer_problems(user, repo):
    """(problems, notes) from the settings layers: managed settings that
    allow only managed hooks, and any layer that disables all hooks."""
    problems, notes, layers = [], [], [("user", user)]
    managed, err = read_json(MANAGED_SETTINGS)
    if err:
        notes.append(f"cannot read managed settings ({err})")
    layers.append(("managed", managed))
    if managed.get("allowManagedHooksOnly"):
        problems.append("managed settings set allowManagedHooksOnly, so user hooks never run")
    if repo:
        for name in ("settings.json", "settings.local.json"):
            proj, _ = read_json(os.path.join(repo, ".claude", name))
            layers.append((f"project {name}", proj))
    for name, layer in layers:
        if layer.get("disableAllHooks"):
            problems.append(f"{name} settings set disableAllHooks")
    return problems, notes


def install_problems():
    """The installed guard is missing, or a canary exits wrong: one allow and
    one block per shell tool, each in the field that tool sends, so a tool
    whose input the installed guard cannot read fails here."""
    if not os.path.isfile(INSTALLED):
        return [f"{INSTALLED} is missing"]
    env = dict(os.environ, BASH_GUARD_LOG=os.devnull)
    fields = {SHELL_TOOLS[2]: "input"}
    canaries = [("Bash", "git status", 0)] + [
        (t, "git push --force origin x", 2) for t in SHELL_TOOLS]
    problems = []
    for tool, cmd, want in canaries:
        payload = json.dumps({"tool_name": tool,
                              "tool_input": {fields.get(tool, "command"): cmd}})
        got = canary_exit(payload, env)
        if got != want:
            problems.append(f"canary {cmd!r} on {tool} exited {got}, expected {want}")
    return problems


def canary_exit(payload, env):
    """The installed guard's exit code for one hook payload, or the class of
    the error that kept it from running."""
    try:
        r = subprocess.run([sys.executable, "-I", INSTALLED], input=payload,
                           capture_output=True, text=True, env=env, timeout=20)
        return r.returncode
    except Exception as exc:
        return exc.__class__.__name__
