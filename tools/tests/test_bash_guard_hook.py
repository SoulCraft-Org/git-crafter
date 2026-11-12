#!/usr/bin/env python3
"""test_bash_guard_hook.py: the bash guard self-test's groups that read a
real folder or run a process: relative paths, git, the hook, its log and
--status (run from test_bash_guard.py's self_test).

Every test payload goes to a hook run or --check of the guard, which parse
and never execute (rules/gates.md).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

TOOLS = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
ROOT = os.path.dirname(TOOLS)
if TOOLS not in sys.path:
    sys.path.append(TOOLS)

import bash_guard  # noqa: E402
from bash_guard_hook import WITHHELD, scrub  # noqa: E402
from bash_guard_rules import RULES_FILE  # noqa: E402
from bash_guard_slow import SHELL_TOOLS  # noqa: E402

GUARD = os.path.realpath(bash_guard.__file__)


def install(home):
    """Copy every manifest.json user-claude file bound for code-os/ into
    home/.claude, as apply would, and return the installed guard's path."""
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as fh:
        files = json.load(fh)["repos"]["user-claude"]["files"]
    for source, target in files.items():
        if target.startswith("code-os/"):
            dest = os.path.join(home, ".claude", target)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(os.path.join(ROOT, source), dest)
    return os.path.join(home, ".claude", "code-os", "bash_guard.py")


def relative_paths(t):
    """A relative path resolves against the folder the command runs in."""
    check, ids, rules = t.check, t.ids, t.rules
    if any(r.get("kind") == "path" for r in rules):
        home = os.path.expanduser("~")
        check("credential-file-read" in ids("cat .zshrc", home),
              "a relative path resolves against the folder the command runs in")
        check("credential-file-read" in ids("cat ../.zshrc", os.path.join(home, "Developer")),
              "a relative path climbs out of its folder")
        check(ids("cat .zshrc", "/tmp") == [], "the same name in another folder is allowed")
        check(ids("cat config.toml") == [], "an unknown folder fails open for home paths")
        check(ids("cd $SOMEWHERE && cat config.toml", home) == [],
              "a cd the guard cannot follow fails open")
        check("credential-file-read" in ids("cat ~/.ssh/" + "*x" * 400),
              "a long glob is matched without running out of stack")
        check(ids("cat " + "a/" * 2000 + ".zshrc") == [],
              "a token longer than any real path is not a path")


def git_scenarios(t):
    """git push from a real checkout, when git is here; returns whether it is."""
    try:
        subprocess.run(["git", "--version"], capture_output=True, check=True)
        have_git = True
    except Exception:
        have_git = False
    if have_git:
        checkout_scenarios(t)
        end_of_options(t)
    else:
        print("bash_guard self-test: git missing, skipped the checkout scenarios")
    return have_git


def end_of_options(t):
    """git refuses -- before its subcommand, so the two corpus cases that
    allow that form expose nothing (#491). The subcommand here is version,
    a harmless marker, with fixed arguments and no shell (rules/gates.md).
    A git that starts to accept the form fails this check: then
    lead_options must read past the -- and both cases flip to block."""
    for lead in (["-c", "x=y", "--"], ["-C", ".", "--"]):
        r = subprocess.run(["git"] + lead + ["version"], capture_output=True, text=True)
        t.check(r.returncode != 0 and "git version" not in r.stdout,
                f"git {' '.join(lead)} <subcommand> is refused by git itself")


def checkout_scenarios(t):
    """On main, a push is blocked; on a feature branch it is allowed; cd,
    pushd and -C are followed, and an unknown folder fails open."""
    check, ids = t.check, t.ids
    with tempfile.TemporaryDirectory() as tmp:
        remote, work = os.path.join(tmp, "remote.git"), os.path.join(tmp, "work")
        env = dict(os.environ, GIT_CONFIG_GLOBAL="/dev/null",
                   GIT_CONFIG_SYSTEM="/dev/null")

        def git(*a, cwd=None):
            subprocess.run(["git"] + list(a), cwd=cwd, env=env,
                           capture_output=True, check=True)
        git("init", "-q", "--bare", remote)
        git("init", "-q", "-b", "main", work)
        git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
            "--allow-empty", "-m", "init", cwd=work)
        git("remote", "add", "origin", remote, cwd=work)
        git("push", "-q", "-u", "origin", "main", cwd=work)
        for cmd in ("git push", "git push origin", "git push -u origin HEAD",
                    "git push origin @", "git push origin HEAD feat/x"):
            check("git-push-main" in ids(cmd, work), f"on main, {cmd!r} is blocked")
        git("checkout", "-q", "-b", "feat/x", "--track", "origin/main", cwd=work)
        check("git-push-main" in ids("git push", work),
              "bare push on a branch tracking origin/main is blocked")
        check(ids("git push -u origin HEAD", work) == [],
              "push HEAD from a feature branch is allowed")
        git("branch", "-q", "--unset-upstream", cwd=work)
        check(ids("git push -u origin feat/x", work) == [],
              "push of a named feature branch is allowed")
        check(ids("git push", work) == [], "bare push on a feature branch is allowed")
        git("checkout", "-q", "main", cwd=work)
        check("git-push-main" in ids(f"cd {work} && git push", tmp),
              "cd is followed before the branch is read")
        check("git-push-main" in ids(f"pushd {work} && git push", tmp),
              "pushd is followed before the branch is read")
        check("git-push-main" in ids(f"git -C {work} push", tmp), "-C is followed")
        check(ids("cd $SOMEWHERE && git push", work) == [],
              "an unknown directory fails open")


def hook_protocol(t):
    """The hook end to end: exit codes for blocks, allows and bad input."""
    check = t.check
    me = GUARD
    env = dict(os.environ, BASH_GUARD_LOG=os.devnull)
    for payload, want in (
        ({"tool_name": "Bash", "tool_input": {"command": "git push --force"}}, 2),
        ({"tool_name": "Bash", "tool_input": {"command": "git status"}}, 0),
        ({"tool_name": SHELL_TOOLS[2], "tool_input": {"pid": 1, "input": "git push --force"}}, 2),
        ({"tool_name": SHELL_TOOLS[2], "tool_input": {"pid": 1, "input": "ls"}}, 0),
        ({"tool_name": "Bash", "tool_input": {}}, 0),
        ({"tool_name": "Bash", "tool_input": {"command": "echo 'unbalanced"}}, 0),
        ([1, 2], 0),
    ):
        r = subprocess.run([sys.executable, "-I", me], input=json.dumps(payload),
                           capture_output=True, text=True, env=env)
        check(r.returncode == want, f"hook exits {want} for {payload!r}")
    r = subprocess.run([sys.executable, "-I", me], input="not json",
                       capture_output=True, text=True, env=env)
    check(r.returncode == 0 and "allowed" in r.stderr,
          "unreadable hook input fails open with a note")


def block_log(t):
    """Each block is logged; a key value never is."""
    check, rules = t.check, t.rules
    me = GUARD
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, "guard.log")
        logged = dict(os.environ, BASH_GUARD_LOG=log)
        for cmd in ("runpodctl config --apiKey SEEDED_VALUE_1", "git push --force",
                    "DB_PASSWORD=SEEDED_VALUE_2 git push --force origin x",
                    "RUNPOD_API_KEY=SEEDED_VALUE_3 git status"):
            subprocess.run([sys.executable, "-I", me], capture_output=True, text=True,
                           env=logged, input=json.dumps(
                               {"tool_name": "Bash", "tool_input": {"command": cmd}}))
        with open(log, encoding="utf-8") as fh:
            text = fh.read()
        quiet = {r["id"] for r in rules if r.get("log_command") is False}
        check("secret-on-argv" in quiet and "SEEDED_VALUE_1" not in text and WITHHELD in text,
              "secret-on-argv keeps its command, and the key on it, out of the log")
        check("git push --force" in text, "other blocks log their command")
        check("SEEDED_VALUE_2" not in text and "DB_PASSWORD=***" in text,
              "a logged command loses the value of a secret-looking assignment")
        check("key-var-assign" in quiet and "SEEDED_VALUE_3" not in text,
              "key-var-assign keeps its command, and the key on it, out of the log")
    check(scrub("security unlock-keychain -p hunter2 k; git log -p -3") ==
          "security unlock-keychain -p *** k; git log -p -3",
          "scrub replaces a password flag's value and leaves a bare flag alone")


class StatusHome:
    """A synthetic home with the guard installed from manifest.json, and the
    settings a --status run reads."""

    def __init__(self, home):
        self.home = home
        self.inst = os.path.join(home, ".claude", "code-os")
        os.makedirs(self.inst)
        install(home)
        self.guard = os.path.join(self.inst, "bash_guard.py")
        self.settings_path = os.path.join(home, ".claude", "settings.json")

    def hook(self, matcher="|".join(SHELL_TOOLS), guard=None):
        """User settings with one PreToolUse hook that runs guard."""
        return {"hooks": {"PreToolUse": [{"matcher": matcher, "hooks": [
            {"type": "command", "command": f"python3 -I {guard or self.guard}"}]}]}}

    def run(self, settings, extra=None, managed=None, cwd=None):
        """The installed guard's --status exit code under these settings."""
        with open(self.settings_path, "w", encoding="utf-8") as fh:
            json.dump(settings, fh)
        m = os.path.join(self.home, "managed.json")
        with open(m, "w", encoding="utf-8") as fh:
            json.dump(managed or {}, fh)
        e = dict(os.environ, HOME=self.home, BASH_GUARD_MANAGED=m)
        r = subprocess.run([sys.executable, "-I", self.guard, "--status"] + (extra or []),
                           capture_output=True, text=True, env=e, cwd=cwd or self.home)
        return r.returncode


def status_checks(t, have_git):
    """--status against a synthetic home: its wiring, then its install."""
    with tempfile.TemporaryDirectory() as home:
        s = StatusHome(home)
        status_wiring(t, s, have_git)
        status_install(t, s)


def status_wiring(t, s, have_git):
    """--status fails on every way the hook can be unwired or disabled."""
    check, run_status, hook = t.check, s.run, s.hook()
    check(run_status(hook) == 0, "status passes when wired and blocking")
    check(run_status({}) == 1, "status fails when not wired")
    # The install moved from ~/.claude/claude-os/ on 2026-11-03. A hook
    # still on the old copy runs a guard Git Crafter no longer updates.
    old = s.guard.replace(os.sep + "code-os" + os.sep, os.sep + "claude-os" + os.sep)
    check(run_status(s.hook(guard=old)) == 1,
          "status fails while the hook runs the old ~/.claude/claude-os copy")
    check(run_status(s.hook("Bash")) == 1, "status fails when a shell tool is uncovered")
    check(run_status(dict(hook, disableAllHooks=True)) == 1,
          "status fails when user settings disable hooks")
    check(run_status(hook, managed={"allowManagedHooksOnly": True}) == 1,
          "status fails when managed settings allow only managed hooks")
    proj = os.path.join(s.home, "repo")
    os.makedirs(os.path.join(proj, ".claude"))
    with open(os.path.join(proj, ".claude", "settings.local.json"), "w") as fh:
        json.dump({"disableAllHooks": True}, fh)
    check(run_status(hook, [proj]) == 1, "status fails when the project disables hooks")
    if have_git:
        subprocess.run(["git", "init", "-q", proj], capture_output=True)
        check(run_status(hook, cwd=proj) == 1,
              "status with no path reads the project it runs in")


def status_install(t, s):
    """--status fails on a corrupt or partial install, and a missing module
    prints one line naming it and the apply command."""
    check, run_status, hook, inst, guard = t.check, s.run, s.hook(), s.inst, s.guard
    with open(os.path.join(inst, "bash_guard_rules.json"), "w") as fh:
        fh.write("{broken")
    check(run_status(hook) == 1, "status fails when the installed rules are corrupt")
    shutil.copy2(RULES_FILE, inst)
    check(run_status(hook) == 0, "status passes again once the rules are back")
    os.remove(os.path.join(inst, "bash_guard_perl.py"))
    check(run_status(hook) == 1, "status fails when an installed module is missing")
    r = subprocess.run([sys.executable, "-I", guard, "--check", "ls"],
                       capture_output=True, text=True)
    check(r.returncode == 1 and r.stderr.count("\n") == 1
          and "bash_guard_perl.py is missing" in r.stderr and "apply user-claude" in r.stderr,
          f"a missing module prints one line naming it and the apply command (got {r.stderr!r})")
