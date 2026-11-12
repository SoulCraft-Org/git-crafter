"""bash_guard_hook.py: The hook: read the call, evaluate it, log and explain a block.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import json
import os
import re
import sys
import time

from bash_guard_evaluate import evaluate
from bash_guard_rules import HERE, load_rules


QUEUE_NOTE = (
    "Send this step to the orchestrator, as ~/.claude/rules/delegation.md "
    "says, and keep working on everything else. Do not route around it."
)


FIX_NOTE = "Apply the fix and run the command again."


WITHHELD = "(withheld: this rule can carry a key value)"


# The block log never keeps a value: NAME=value where NAME looks secret, and
# the value after a password or token flag.
SCRUB_ASSIGN_RE = re.compile(
    r"(?i)\b([A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password)[A-Za-z0-9_]*)="
    r"(\"[^\"]*\"|'[^']*'|\S+)")


SCRUB_FLAG_RE = re.compile(
    r"(?i)((?:^|\s)(?:-p|-w|--password|--token|--token-secret|--apiKey|--key)(?:\s+|=))"
    r"(\"[^\"]*\"|'[^']*'|[^\s-]\S*)")


def block_message(hits):
    """The text a block sends to Claude: each rule, its reason and fix, then
    what to do next."""
    lines = [f"Blocked by the Git Crafter bash guard ({', '.join(h[0] for h in hits)})."]
    for rid, why, fix in hits:
        lines.append(f"- {rid}: {why}" + (f" Fix: {fix}" if fix else ""))
    lines.append(FIX_NOTE if all(h[2] for h in hits) else QUEUE_NOTE)
    return "\n".join(lines)


def scrub(command):
    """The command with secret-looking values replaced by ***."""
    command = SCRUB_ASSIGN_RE.sub(r"\1=***", command)
    return SCRUB_FLAG_RE.sub(r"\1***", command)


def log_block(data, hits, command, withheld=()):
    """Append one line per block. A rule with log_command false can carry a
    key value on its command line, so its command text stays out of the log."""
    path = os.environ.get("BASH_GUARD_LOG") or os.path.join(HERE, "bash_guard.log")
    command = WITHHELD if any(h[0] in withheld for h in hits) else scrub(command)
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "session": data.get("session_id"),
                "cwd": data.get("cwd"),
                "rules": [h[0] for h in hits],
                "command": command[:200],
            }) + "\n")
    except OSError:
        pass


def hook_main():
    """Hook mode: read the call on stdin; exit 2 with the reasons when a rule
    blocks, else 0. Any fault in reading or checking allows, with a note."""
    data = {}
    try:
        data = json.load(sys.stdin)
        command = hook_command(data)
        if command is None:
            return 0
        rules = load_rules()
        hits = evaluate(command, rules, data.get("cwd") or os.getcwd())
    except json.JSONDecodeError:
        print("bash_guard: could not read the hook input or the rules; allowed.",
              file=sys.stderr)
        return 0
    except ValueError:
        print("bash_guard: could not parse the command; allowed.", file=sys.stderr)
        return 0
    except Exception as exc:  # infrastructure problem: fail open
        print(f"bash_guard: could not check ({exc.__class__.__name__}); allowed.",
              file=sys.stderr)
        return 0
    if not hits:
        return 0
    log_block(data, hits, command, quiet_rule_ids(rules))
    print(block_message(hits), file=sys.stderr)
    return 2


def hook_command(data):
    """The shell text a hook call carries, or None when it carries none."""
    if not isinstance(data, dict):
        return None
    tool_input = data.get("tool_input") or {}
    # Most shell tools send "command". interact_with_process sends text to
    # a running shell as "input". "cmd" stays for older tool schemas.
    command = (tool_input.get("command") or tool_input.get("cmd")
               or tool_input.get("input") or "")
    if not isinstance(command, str) or not command.strip():
        return None
    return command


def quiet_rule_ids(rules):
    """The ids of rules whose command text stays out of the log."""
    return {r["id"] for r in rules if r.get("log_command") is False}
