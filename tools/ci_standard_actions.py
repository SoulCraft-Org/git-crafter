"""ci_standard_actions.py: the pinned rule, on a job's steps and on the local actions they call (#200).

Embedded with ci_standard.py in ci-standard.yml. A step's uses: ./PATH (or $/PATH) runs PATH/action.yml from the
checkout, and its steps run in the caller's job with its token, so they are read too, and the local actions they call.
A link, or a path that leaves the repo, is never read: it is could not check. Standard library only.
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
        runs = doc.get("runs") if isinstance(doc.get("runs"), dict) else {}
        image = str(runs.get("image") or "")  # a Docker action's image is checked as one more step
        inner = [s for s in runs.get("steps") or [] if isinstance(s, dict)] + ([{"uses": image}] if image.startswith("docker://") else [])
        found += pin_findings(rel, inner)
        todo += inner
    return found, unread
