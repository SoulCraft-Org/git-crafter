"""ci_standard_actions.py: the pinned rule, on a job's steps and the local actions they call (#200), and the pool input check. Embedded with
ci_standard.py. A step's uses: ./PATH or $/PATH runs PATH/action.yml in the caller's job, so its steps are read too; a
link or a path out of the repo is never read (could not check). Standard library only."""

from __future__ import annotations

import os
import re

from ci_standard_yaml import ParseError, parse

SHA_RE = re.compile(r"[^@\s]+@[0-9a-f]{40}")
# This repo's own actions: ./ runs the checkout's copy, $/ the copy at the workflow's commit (gh actions-lock).
OWN = ("./", "$/")
LOCK_FILE = "actions.lock"
ACTION_FILES = ("action.yml", "action.yaml")
POOL_LABEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
HOSTED_PREFIXES = ("ubuntu", "windows", "macos")


def pin_findings(where: str, steps: list, locked=frozenset()) -> list:
    """Each step's uses: pinned to a full SHA or locked in actions.lock, a docker:// image to a digest."""
    found = []
    for s in steps:
        uses = str(s.get("uses") or "")
        if uses and not uses.startswith(OWN + ("docker://",)) and not SHA_RE.fullmatch(uses) and uses not in locked:
            found.append(("pinned", where, f"{uses} is not pinned to a full commit SHA, and {LOCK_FILE} does not lock it"))
        if uses.startswith("docker://") and "@sha256:" not in uses:
            found.append(("pinned", where, f"{uses} is not pinned to a digest"))
    return found


def read_action(repo: str, rel: str) -> tuple:
    """(the parsed action, None), or (None, why it could not be read): a link and a path out of the repo never are."""
    root = os.path.realpath(repo)
    for name in ACTION_FILES:
        path = os.path.normpath(os.path.join(root, rel, name))
        if os.path.commonpath([root, path]) != root:
            return None, "a path that leaves the repo; never read"
        if not os.path.lexists(path):
            continue
        if os.path.realpath(path) != path:
            return None, "a link, or a file inside one; never read"
        try:
            with open(path, encoding="utf-8") as fh:
                doc = parse(fh.read())
        except (OSError, UnicodeDecodeError, ParseError) as exc:
            return None, str(exc)
        return (doc, None) if isinstance(doc, dict) else (None, "not a mapping")
    return None, f"no {' or '.join(ACTION_FILES)} in the checkout"


def action_steps(doc: dict) -> list:
    """A composite action's steps, and a Docker action's docker:// image as one more step."""
    runs = doc.get("runs") if isinstance(doc.get("runs"), dict) else {}
    image = str(runs.get("image") or "")
    return [s for s in runs.get("steps") or [] if isinstance(s, dict)] + ([{"uses": image}] if image.startswith("docker://") else [])


def local_action_findings(repo: str, steps: list) -> tuple:
    """(findings, unread) for each local action the steps call, and each local action those call, read once each."""
    found, unread, seen, todo = [], [], set(), list(steps)
    while todo:
        uses = str(todo.pop(0).get("uses") or "")
        rel = os.path.normpath(uses[2:] or ".") if uses.startswith(OWN) else None
        if rel is None or rel in seen:
            continue
        seen.add(rel)
        doc, why = read_action(repo, rel)
        if why:
            unread.append((rel, f"local action: {why}"))
            continue
        inner = action_steps(doc)
        found += pin_findings(rel, inner)
        todo += inner
    return found, unread


def pool_findings(where: str, uses: str, with_) -> list:
    """The pool input of a call to the standard: a self-hosted label needs an exception, and the label itself is never excepted."""
    path = uses.split("@", 1)[0].lower().replace("\\", "/")
    text = str((with_ or {}).get("pool") or "") if isinstance(with_, dict) else ""
    if not text or not path.endswith(("/ci-standard.yml", "/ci-standard.yaml")):
        return []
    found = [("runner", where, f"pool: {text} sends the standard's jobs to a self-hosted runner; add an exception with a reason")]
    if not POOL_LABEL_RE.fullmatch(text) or "blacksmith" in text.lower() or text.lower().startswith(HOSTED_PREFIXES):
        found.append(("pool", where, "pool is one literal self-hosted label of letters, digits, dot, dash and underscore: no expression, space, comma, Blacksmith or GitHub-hosted name, and no exception"))
    return found
