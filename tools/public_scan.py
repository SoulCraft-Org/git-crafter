#!/usr/bin/env python3
"""public_scan.py: what must never ship in a public tree, found by file and line.

    public_scan.py generic TREE
        emails other than noreply and example addresses, /Users/<name> paths other than placeholders, and
        key-shaped strings (GitHub, Anthropic, OpenAI, AWS, Google, Slack tokens and private key blocks)
    public_scan.py terms TREE TERMS
        each term in the TERMS file, case-insensitive, whole words, a space matching a space, hyphen, underscore
        or nothing. Prints path:line and the term's index in TERMS (#1 is its first term), never the term or the
        line, so a log of the scan leaks nothing.
    public_scan.py --self-test

TERMS holds one term a line; # starts a comment. "term :: PATH PATH" lets the term appear only in those
tree-relative paths (the publisher's name in README.md and LICENSE). "!LITERAL" allows that exact, case-sensitive
text anywhere, such as the public repo's own slug, and counts as no term. The TERMS file is skipped when it sits
inside TREE. Every scan skips .git and node_modules, and any file with a NUL byte.

Exit 0 nothing found, 1 a finding, 2 usage error, 3 could not read TREE or TERMS. Standard library only.
"""

from __future__ import annotations

import os
import re
import sys
import tempfile

SKIP_DIRS = {".git", "node_modules"}
HOME_PLACEHOLDERS = {"someone", "Shared", "runner"}
EMAIL_RE = re.compile(r"(?<![\w.+:/-])([\w.+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b")
EMAIL_OK_LOCAL = {"noreply", "no-reply", "git"}
# Reserved for examples and tests (RFC 2606), and GitHub's noreply addresses.
EMAIL_OK_DOMAIN = re.compile(r"(^|\.)(example\.(com|org|net)|users\.noreply\.github\.com)$|\.(example|invalid|test|localhost)$", re.I)
HOME_RE = re.compile(r"/Users/([A-Za-z][\w-]*)")
KEY_RES = {
    "github token": re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})"),
    "anthropic key": re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}"),
    "openai key": re.compile(r"\bsk-(proj-)?[A-Za-z0-9]{32,}"),
    "aws key id": re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    "google key": re.compile(r"\bAIza[0-9A-Za-z_-]{35}"),
    "slack token": re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"),
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
}


def walk(tree: str, skip: set):
    """(relative path, text) for each text file under tree, sorted; a file with a NUL byte is binary and left out."""
    for root, dirs, names in os.walk(tree):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for name in sorted(names):
            path = os.path.join(root, name)
            rel = os.path.relpath(path, tree).replace(os.sep, "/")
            if rel in skip or name in SKIP_DIRS or os.path.islink(path):
                continue
            with open(path, "rb") as fh:
                raw = fh.read()
            if b"\0" not in raw:
                yield rel, raw.decode("utf-8", "replace")


def generic_hits(line: str) -> list:
    """The kinds of generic finding in one line."""
    kinds = []
    for local, domain in EMAIL_RE.findall(line):
        if local.lower() not in EMAIL_OK_LOCAL and not EMAIL_OK_DOMAIN.search(domain):
            kinds.append("email")
    kinds += ["home path" for name in HOME_RE.findall(line) if name not in HOME_PLACEHOLDERS]
    kinds += [kind for kind, rx in KEY_RES.items() if rx.search(line)]
    return kinds


def generic(tree: str) -> list:
    """[(path, line number, kind)] over the tree."""
    return [(rel, n, kind) for rel, text in walk(tree, set())
            for n, line in enumerate(text.split("\n"), 1) for kind in generic_hits(line)]


def read_terms(text: str) -> tuple:
    """([(index, pattern, allowed paths)], [allowed literal]) from a TERMS file's text; index counts terms from 1."""
    terms, literals = [], []
    for raw in text.split("\n"):
        line = raw.split("#", 1)[0].strip()
        if line.startswith("!"):
            literals.append(line[1:])
            continue
        if not line:
            continue
        term, _, allowed = line.partition("::")
        words = [re.escape(w) for w in term.split()]
        rx = re.compile(r"(?<![A-Za-z0-9])" + r"[\s_-]?".join(words) + r"(?![A-Za-z0-9])", re.I)
        terms.append((len(terms) + 1, rx, set(allowed.split())))
    return terms, literals


def term_scan(tree: str, terms_path: str) -> list:
    """[(path, line number, term index)] over the tree; each allowed literal is blanked before the terms match."""
    with open(terms_path, encoding="utf-8") as fh:
        terms, literals = read_terms(fh.read())
    inside = os.path.relpath(os.path.abspath(terms_path), os.path.abspath(tree)).replace(os.sep, "/")
    hits = []
    for rel, text in walk(tree, {inside}):
        for n, line in enumerate(text.split("\n"), 1):
            for lit in literals:
                line = line.replace(lit, " ")
            hits += [(rel, n, i) for i, rx, allowed in terms if rel not in allowed and rx.search(line)]
    return hits


def report(hits: list, label: str) -> int:
    """Print each finding and a per-folder total; 1 when there is any finding."""
    for rel, n, what in hits:
        print(f"{rel}:{n}: {what if isinstance(what, str) else f'term #{what}'}")
    folders = {}
    for rel, _n, _w in hits:
        top = rel.split("/", 1)[0] if "/" in rel else "."
        folders[top] = folders.get(top, 0) + 1
    by = ", ".join(f"{k} {v}" for k, v in sorted(folders.items(), key=lambda kv: (-kv[1], kv[0])))
    print(f"public-scan {label}: {len(hits)} findings" + (f" ({by})" if by else ""))
    return 1 if hits else 0


def self_test() -> int:
    """Scan a seeded tree of known-bad and clean files; 0 when every scan matches."""
    wrong = []
    key = "gh" + "p_" + "a" * 36
    home = "/Users" + "/alice/x"
    files = {
        "README.md": "Published by Acme Corp.\nmail ops" + "@acme.io\n",
        "rules/bad.md": f"Ask Alice Smith.\nacme-corp owns it. {home}\ntoken {key}\nuses: Acme-Corp/tool@v1, acme-corp/tool\n",
        "rules/clean.md": "uses: Acme-Corp/tool/.github/workflows/x.yml@v1, repo_url Acme-Corp/tool\n"
                          "a@b, actions/checkout@v4.1.0, noreply@anthropic.com, 1+me@users.noreply.github.com,\n"
                          "x@example.com, f@x.invalid, 41898282+github-actions[bot]@users.noreply.github.com, https://u:pw@registry.npmjs.org/, /Users/someone/x, /Users/Shared, /Users/runner, acmecorporate, malice smithy\n",
        "terms.txt": "# private\nAlice Smith\n!Acme-Corp/tool\nAcme Corp :: README.md\n",
        "bin.dat": "Alice Smith\0",
    }
    with tempfile.TemporaryDirectory() as tree:
        for rel, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(tree, rel)), exist_ok=True)
            with open(os.path.join(tree, rel), "w", encoding="utf-8") as fh:
                fh.write(text)
        got = generic(tree)
        want = [("README.md", 2, "email"), ("rules/bad.md", 2, "home path"), ("rules/bad.md", 3, "github token")]
        if got != want:
            wrong.append(f"generic: {got}, want {want}")
        got = term_scan(tree, os.path.join(tree, "terms.txt"))
        want = [("rules/bad.md", 1, 1), ("rules/bad.md", 2, 2), ("rules/bad.md", 4, 2)]
        if got != want:
            wrong.append(f"terms: {got}, want {want}")
    for w in wrong:
        print(f"public-scan self-test: {w}")
    print(f"public-scan self-test: {'FAIL' if wrong else 'PASS'}")
    return 1 if wrong else 0


def main(argv: list) -> int:
    """Run the generic or terms scan on a folder; exit 0 clean, 1 findings, 2 usage, 3 unreadable."""
    if argv == ["--self-test"]:
        return self_test()
    if len(argv) not in (2, 3) or argv[0] not in ("generic", "terms") or len(argv) != (2 if argv[0] == "generic" else 3):
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    if not os.path.isdir(argv[1]):
        print(f"public-scan: could not read {argv[1]}: not a folder", file=sys.stderr)
        return 3
    try:
        hits = generic(argv[1]) if argv[0] == "generic" else term_scan(argv[1], argv[2])
    except OSError as exc:
        print(f"public-scan: could not read: {exc.strerror}", file=sys.stderr)
        return 3
    return report(hits, argv[0])


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
