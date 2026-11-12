#!/usr/bin/env python3
"""clause_check.py: fail when a protected clause is missing from its rule.

tools/protected_clauses.json lists each clause and the file that must hold
it. Matching ignores case, line wraps and repeated spaces, so rewrapping a
paragraph passes and dropping the words fails. Exit 0 when every clause is
present, 1 when one is missing, 3 when a listed file cannot be read.

  python3 -I tools/clause_check.py            check this checkout
  python3 -I tools/clause_check.py --self-test
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LIST = os.path.join(ROOT, "tools", "protected_clauses.json")


def norm(text):
    """Lowercase text with every run of whitespace as one space."""
    return re.sub(r"\s+", " ", text).strip().lower()


def missing(clauses, read):
    """Return (missing clause ids, unreadable files). read(path) -> text."""
    gone, unread, cache = [], [], {}
    for c in clauses:
        f = c["file"]
        if f not in cache:
            try:
                cache[f] = norm(read(f))
            except OSError:
                cache[f] = None
                unread.append(f)
        if cache[f] is not None and norm(c["text"]) not in cache[f]:
            gone.append("%s: %s" % (f, c["id"]))
    return gone, unread


def read_repo(path):
    """The text of a file in this checkout, by its repo-relative path."""
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return fh.read()


def load():
    """The clause list from tools/protected_clauses.json."""
    with open(LIST, encoding="utf-8") as fh:
        return json.load(fh)["clauses"]


def self_test():
    """Check this checkout, then known-bad samples; 0 when all behave, 1 when one does not."""
    clauses = load()
    ok = True
    gone, unread = missing(clauses, read_repo)
    if gone or unread:
        print("self-test: this checkout fails: %s" % (gone + unread))
        ok = False
    # Known-bad samples: each rule with one clause cut must fail, naming it.
    for c in clauses:
        def cut(path, c=c):
            text = read_repo(path)
            if path != c["file"]:
                return text
            return re.sub(r"\s+".join(map(re.escape, c["text"].split())), "",
                          text, flags=re.I)
        gone, _ = missing(clauses, cut)
        if gone != ["%s: %s" % (c["file"], c["id"])]:
            print("self-test: cutting %s gave %s" % (c["id"], gone))
            ok = False
    # Rewrapping keeps a clause.
    wrapped = missing([{"file": "x", "id": "w", "text": "a b c"}],
                      lambda p: "A\n  b\tc")[0]
    if wrapped:
        print("self-test: a rewrapped clause read as missing")
        ok = False
    # An unreadable file is could-not-check, never a pass.
    def boom(path):
        raise OSError("no file")
    if missing(clauses[:1], boom)[1] != [clauses[0]["file"]]:
        print("self-test: an unreadable file was not reported")
        ok = False
    print("clause_check self-test: %s (%d clauses)" % ("ok" if ok else "FAIL", len(clauses)))
    return 0 if ok else 1


def main(argv):
    """Run the check or the self-test; exit 0 ok, 1 missing, 3 unreadable."""
    if argv[1:] == ["--self-test"]:
        return self_test()
    gone, unread = missing(load(), read_repo)
    for g in gone:
        print("clause_check: missing %s" % g)
    for u in unread:
        print("clause_check: could not read %s" % u)
    if unread:
        return 3
    if gone:
        print("Restore each clause, or change it here and in the rule in one PR.")
        return 1
    print("clause_check: ok (%d clauses)" % len(load()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
