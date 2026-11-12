"""ci_standard_embed.py: `ci_standard.py embed`, which keeps the shared workflows' embedded copies verbatim.

ci-standard.yml embeds the checks and ci-overflow.yml the overflow meter and its lanes (OVERFLOW). Each workflow writes each embedded file from its own quoted heredoc (cat > "$RUNNER_TEMP/NAME" <<'MARK' ... MARK),
so a caller's run uses the copies at the caller's pin. This file stays outside the workflow: only a Git Crafter
checkout has the sources to compare. Exit 0 every copy matches (or was written), 1 one differs or a source cannot
be embedded, 3 a heredoc is missing.
"""

from __future__ import annotations

import os

from ci_standard_yaml import EXPR

HERE = os.path.dirname(os.path.abspath(__file__))
WORKFLOWS = os.path.join(HERE, "..", ".github", "workflows")
WORKFLOW = os.path.join(WORKFLOWS, "ci-standard.yml")
# (file beside this one, its heredoc marker): every file the workflow's changes and check commands import.
EMBEDS = (("ci_standard.py", "CI_STANDARD_PY"), ("ci_standard_yaml.py", "CI_STANDARD_YAML_PY"),
          ("ci_standard_rules.py", "CI_STANDARD_RULES_PY"))
# ci-overflow.yml's copies: the meter and the lanes it reads (paths beside this file).
OVERFLOW = (os.path.join(WORKFLOWS, "ci-overflow.yml"),
            (("ci_overflow.py", "CI_OVERFLOW_PY"), (os.path.join("..", ".github", "ci-overflow.json"), "CI_OVERFLOW_JSON")))


def embedded(text: str, mark: str) -> tuple:
    """(start, end, indent) of the heredoc body opened by <<'mark' in the workflow; StopIteration when absent."""
    lines = text.split("\n")
    start = next(i for i, x in enumerate(lines) if x.rstrip().endswith(f"<<'{mark}'")) + 1
    indent = len(lines[start - 1]) - len(lines[start - 1].lstrip())
    end = next(i for i in range(start, len(lines)) if lines[i].strip() == mark and len(lines[i]) - len(lines[i].lstrip()) == indent)
    return start, end, indent


def source_of(name: str, mark: str):
    """The file's text, or None after saying why it cannot sit in a heredoc."""
    with open(os.path.join(HERE, name), encoding="utf-8") as fh:
        source = fh.read()
    if EXPR in source or any(line.strip() == mark for line in source.split("\n")):
        print(f"ci-standard: embed: {name} holds an Actions expression or its heredoc end ({mark})")
        return None
    return source


def placed(text: str, source: str, mark: str) -> tuple:
    """(the workflow text with source in mark's heredoc, whether that changed it)."""
    start, end, indent = embedded(text, mark)
    lines = text.split("\n")
    body = [(" " * indent + x) if x else "" for x in source.rstrip("\n").split("\n")]
    return "\n".join(lines[:start] + body + lines[end:]), lines[start:end] != body


def embed_all(write: bool) -> int:
    """embed for ci-standard.yml, then for ci-overflow.yml; the worse exit code."""
    return max(embed(write), embed(write, *OVERFLOW))


def embed(write: bool, workflow: str = WORKFLOW, embeds: tuple = EMBEDS) -> int:
    """Writes each embedded file, verbatim, into its heredoc in the workflow; without write, exit 1 when one differs."""
    try:
        with open(workflow, encoding="utf-8") as fh:
            text = fh.read()
        differ = []
        for name, mark in embeds:
            source = source_of(name, mark)
            if source is None:
                return 1
            text, changed = placed(text, source, mark)
            differ += [name] if changed else []
    except (OSError, StopIteration) as exc:
        print(f"ci-standard: embed: could not find a heredoc in {workflow}: {exc!r}")
        return 3
    names, base = ", ".join(os.path.basename(n) for n, _ in embeds), os.path.basename(workflow)
    if not differ:
        print(f"ci-standard: embed: {base} holds {names}, verbatim")
        return 0
    if not write:
        print(f"ci-standard: embed: {base}'s copy of {', '.join(differ)} differs; run python3 -I tools/ci_standard.py embed --write")
        return 1
    with open(workflow, "w", encoding="utf-8") as fh:
        fh.write(text)
    print(f"ci-standard: embed: wrote {', '.join(differ)} into {base}")
    return 0
