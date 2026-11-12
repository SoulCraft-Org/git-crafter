#!/usr/bin/env python3
"""bash_guard.py: a PreToolUse hook that blocks one-way-door shell commands.

Canonical source: Git Crafter tools/bash_guard.py. The installed copy lives at
~/.claude/code-os/bash_guard.py. If the two disagree, Git Crafter wins; fix
the copy with `claude_os_sync.py apply user-claude --yes`.

Why it exists. Sessions often run in bypassPermissions mode, where no
permission prompt appears. A PreToolUse hook that exits 2 still blocks the
call in that mode. It fires only once ~/.claude/settings.json wires it.
`--status` checks the wiring and then runs the installed guard on a canary
command, so a broken install cannot pass.

What it decides. Nothing in this file names a command to block. The rules,
each with seeded block and allow examples, live in bash_guard_rules.json. A
regression corpus lives in bash_guard_cases.json. This file parses commands
and routes them through the rules.

How it reads a command:
  1. One recursive scan, the way bash reads: quotes span lines; a # that
     starts an unquoted word begins a comment; $'...' strings are decoded;
     a heredoc operator becomes a marker and its body comes out; $(...) and
     backticks are scanned as their own command context, so quotes and
     heredocs inside them work.
  2. shlex splits the scanned text on ; & | ( ) and newlines. An unquoted
     redirection operator ends a word, as it does in bash, so cmd>out runs
     cmd; the file descriptor stays with the operator (2>out). An array
     assignment's words come back into its word: NAME=(a b).
  3. Each simple command loses its redirections, shell keywords, env
     assignments and wrappers (env, nice, timeout, xargs, stdbuf, unbuffer,
     script, xcrun, npx, pnpm exec, uv run, uvx, pipx run, anything followed
     by -- and a known program). What is left is the
     program and its arguments, matched against the rules. A wrapper with
     nothing after it is the program itself, so a bare env is env. A shell
     or python running a script file the rules name (bash keys.sh run,
     python3 tools/claude_os_sync.py apply) is matched as that script too.
  4. Text a shell will run is parsed again: bash -c and -lc strings, eval,
     npx -c, here-strings, heredoc bodies fed to a shell, echo or printf
     piped into a shell, and every substitution.
  5. A path rule (kind=path) treats every operand as a read, unless the
     program only looks at names (the rule's metadata list). It also checks
     the text after = or a leading @, input redirections, the tokens a
     wrapper or assignment took, what find hands to -exec or xargs, and path
     literals in one-liners. ~, $HOME and /Users/<name> fold to one home; a
     relative path resolves against the folder the command runs in; brace
     lists and globs are compared with the rule's patterns. A glob ending in
     * meets an anywhere pattern that starts with one (*.pem) only when it
     carries .pem or a credential word (key, cert, secret, token):
     certs/key* does, site/vitest.config.* does not. Search patterns and sed
     and awk scripts (BSD sed's -i suffix included) are not files; a for or
     select list's words are, since the loop body may read them.
  6. One-word substitutions resolve first: $(which security) is security.
     Shell text inside osascript (do shell script), expect (spawn) and a
     one-liner that starts a process is parsed as a command too. An admin
     do shell script's leading sudo -u USER is dropped first: as root, it
     only lowers rights.
  7. A key variable is one keys.toml lists as secret, read on each run (or
     the rules file's copy of its names when it cannot be read), or one
     named like a key (the rules' key_vars patterns). A format = "public"
     row is an id, not a key, so it is left out. An assignment's whole word
     (NAME=value, NAME+=value, NAME[0]=value, NAME=(array)) is kept, so a
     rule can see a key's value on the line or one key copied into another
     variable.

What it misses on purpose. Commands built at run time from variables (a
for or select variable is the exception: later commands are checked with
each word of its list), and commands inside scripts or other languages.
A key variable reached through another variable (${!n}, zsh's ${(P)n}),
read by an interpreter (os.environ, process.env), handed to a program
other than echo, printf or print, or expanded in a here-string or heredoc
body. Words lose their quotes, so '$HF_TOKEN' blocks as if it expanded.
File names that arrive on stdin (xargs cat), a recursive read of a folder
that holds a credential (grep -r X ~/.ssh), relative paths after a cd the
guard cannot follow, and a glob ending in * with no credential word that
happens to match a .pem. Treat it as a seatbelt, not a sandbox.

Layout. This file is the hook entry and keeps main. The engine sits beside
it in bash_guard_<part>.py, each imported by name: scan, words, program,
args, paths, perl, conditions, operands, code, feeds, gh, shellc, evaluate,
rules, hook and slow. manifest.json installs every one; a missing one prints
the reinstall command, fails open in hook mode and fails --status.

Failure policy. An infrastructure problem fails open with a note on stderr:
a missing or invalid rules file, unreadable hook input, or a command bash
itself could not parse. Could not check is not the same as checked and
failed.

Hook protocol. Reads the hook JSON on stdin. Exit 0 allows. Exit 2 blocks and
sends stderr to Claude: each broken rule, its reason, and its fix when the
rule has one. Each block is appended to bash_guard.log beside the script
(override with BASH_GUARD_LOG). A rule with log_command false can carry a
key value, so its command text is withheld from the log.

Commands:
  (no args)          hook mode, reads stdin
  --check CMD        print the verdict for one command
  --list             print every rule id and why
  --status [REPO]    wiring, canary and disable switches; REPO adds its
                     project settings
  --self-test        seeded examples, the corpus, and engine scenarios, from
                     tools/tests/test_bash_guard.py (a checkout only; the
                     install has no tests)

Requires Python 3.9, standard library only.
"""

import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
if HERE not in sys.path:  # python3 -I leaves the script's own folder off sys.path
    sys.path.append(HERE)

try:
    from bash_guard_evaluate import evaluate  # noqa: F401 (blockers-outcome.mjs imports it)
    from bash_guard_hook import hook_main
    from bash_guard_rules import load_rules
    from bash_guard_slow import status
except ModuleNotFoundError as exc:
    if not (exc.name or "").startswith("bash_guard_"):
        raise
    print(f"bash_guard: {exc.name}.py is missing beside {HERE}; reinstall it with "
          "python3 -I ~/Developer/SoulCraft-Org/Git-Crafter/tools/claude_os_sync.py apply user-claude --yes",
          file=sys.stderr)
    if __name__ != "__main__":
        raise
    sys.exit(0 if len(sys.argv) == 1 else 1)  # hook mode fails open; --status and the rest fail


def run_self_test():
    """Run tools/tests/test_bash_guard.py. The tests stay in the Git Crafter
    checkout, so an installed copy has none and says where they are."""
    tests = os.path.join(HERE, "tests")
    if not os.path.isfile(os.path.join(tests, "test_bash_guard.py")):
        print(f"bash_guard: no self-test beside {HERE}; run it from a Git Crafter checkout: "
              "python3 -I tools/bash_guard.py --self-test")
        return 2
    sys.path.append(tests)
    import test_bash_guard
    return test_bash_guard.self_test()


def main(argv):
    """Route the command line: hook mode with no arguments, else one of the
    commands the docstring lists."""
    if not argv:
        return hook_main()
    if argv[0] == "--self-test":
        return run_self_test()
    if argv[0] == "--status":
        return status(argv[1] if len(argv) > 1 else None)
    if argv[0] == "--list":
        return list_rules()
    if argv[0] == "--check" and len(argv) == 2:
        return check_command(argv[1])
    print(__doc__)
    return 2


def list_rules():
    """--list: every rule id and why."""
    for r in load_rules():
        print(f"{r['id']}: {r['why']}")
    return 0


def check_command(command):
    """--check: print the verdict for one command; 2 when it blocks."""
    try:
        hits = evaluate(command, load_rules(), os.getcwd())
    except ValueError:
        print("could not parse; the hook allows it (fail open)")
        return 0
    for rid, why, fix in hits:
        print(f"blocked {rid}: {why}" + (f" Fix: {fix}" if fix else ""))
    if not hits:
        print("allowed")
    return 2 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
