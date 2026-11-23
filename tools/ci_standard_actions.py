"""ci_standard_actions.py: the CI standard's pinned rule, on a job's steps and on the local actions they call.

Part of the CI standard's checks (ci_standard.py), embedded with it in ci-standard.yml. A step's uses: ./PATH (or
$/PATH, this repo's own action at the workflow's commit) runs PATH/action.yml from the checkout, and that file's steps
run in the caller's job with its token, so the rule reads them too, and the local actions they call in turn (#200).
A link, or a path whose real path leaves the repo, is never read: it is listed as could not check. Standard library
only.
"""

from __future__ import annotations

import os
import re

from ci_standard_yaml import ParseError, parse

SHA_RE = re.compile(r"[^@\s]+@[0-9a-f]{40}")
# This repo's own actions: ./ runs the checkout's copy, $/ the copy at the workflow's commit (gh actions-lock).
OWN = ("./", "$/")
LOCK_FILE = "actions.lock"
ACTION_FILES = ("action.yml", "action.yaml")


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


def local_path(uses: str):
    """The repo-relative folder of a local action (./PATH or $/PATH), or None for any other uses:."""
    return os.path.normpath(uses[2:] or ".") if uses.startswith(OWN) else None


def action_file(repo: str, rel: str) -> tuple:
    """(path, None) for rel's action.yml or action.yaml in repo, or (None, why) when it cannot be read safely."""
    root = os.path.realpath(repo)
    for name in ACTION_FILES:
        want = os.path.normpath(os.path.join(root, rel, name))
        if os.path.commonpath([root, want]) != root:
            return None, "a path that leaves the repo; never read"
        if not os.path.lexists(want):
            continue
        if os.path.realpath(want) != want:
            return None, "a link, or a file inside one; never read"
        return want, None
    return None, f"no {' or '.join(ACTION_FILES)} in the checkout"


def read_action(repo: str, rel: str) -> tuple:
    """(the parsed action, None), or (None, why it could not be read)."""
    path, why = action_file(repo, rel)
    if why:
        return None, why
    try:
        with open(path, encoding="utf-8") as fh:
            doc = parse(fh.read())
    except (OSError, UnicodeDecodeError, ParseError) as exc:
        return None, str(exc)
    return (doc, None) if isinstance(doc, dict) else (None, "not a mapping")


def action_steps(doc: dict) -> list:
    """A composite action's steps, and a Docker action's docker:// image as one more step, to check as a job's."""
    runs = doc.get("runs") if isinstance(doc.get("runs"), dict) else {}
    steps = [s for s in runs.get("steps") or [] if isinstance(s, dict)]
    image = str(runs.get("image") or "")
    return steps + ([{"uses": image}] if image.startswith("docker://") else [])


def local_action_findings(repo: str, steps: list) -> tuple:
    """(findings, unread) for each local action the steps call, and each local action those call, read once each."""
    found, unread, seen, todo = [], [], set(), list(steps)
    while todo:
        rel = local_path(str(todo.pop(0).get("uses") or ""))
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
