#!/usr/bin/env python3
"""claude_deny_model.py: a model of how Claude Code matches a deny rule.

Canonical source: Git Crafter tools/claude_deny_model.py. claude_deny.py runs
the examples in claude_deny.json through it. It is a model of the docs, not
Claude Code itself: it shows the data says what it means, and a case where
Claude Code differs is a bug here (code.claude.com/docs/en/permissions, read
2026-11-14).

  Bash   * matches any text, spaces included. A trailing " *" that is the
         rule's only wildcard also matches the bare command, and a trailing
         ":*" is the same as " *". A command splits on && || ; | |& & and
         newlines outside quotes; $(...) and backticks add their contents as
         commands of their own. Each piece drops a leading VAR=value and the
         wrappers timeout, time, nice, nohup, stdbuf, command, builtin,
         noglob and a bare xargs.
  Read   gitignore globs anchored at ~/ or //, the two forms that apply in
         every project from user settings.

--self-test checks the model against the docs' own examples. Exit 0 = ok,
1 = a row disagrees. Requires Python 3.9, standard library only.
"""

import re
import sys

HOME = "/HOME"
WRAPPERS = {"time", "nohup", "command", "builtin", "noglob"}
RULE_RE = re.compile(r"^(Bash|Read)\((.+)\)$", re.S)
ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=(\"[^\"]*\"|'[^']*'|\S*)\s+")


def bash_regex(spec):
    """A Bash rule's specifier as a regex over one command, and its bare form."""
    if spec.endswith(":*"):
        spec = spec[:-2] + " *"
    body = ".*".join(re.escape(p) for p in spec.split("*"))
    bare = spec[:-2] if spec.endswith(" *") and spec.count("*") == 1 else None
    return re.compile("^%s$" % body, re.S), bare


def _close(text, i):
    """The index just past the ) that closes a $( opened before i."""
    depth, quote = 1, None
    while i < len(text):
        c = text[i]
        if quote:
            if c == quote:
                quote = None
            elif c == "\\" and quote == '"':
                i += 1
        elif c in "'\"":
            quote = c
        elif c in "()":
            depth += 1 if c == "(" else -1
            if depth == 0:
                return i + 1
        i += 1
    return len(text)


def split_commands(text):
    """Each command a compound command holds, substitutions included."""
    parts, nested, cur, quote, i = [], [], [], None, 0
    while i < len(text):
        c, two = text[i], text[i:i + 2]
        if quote == "'":
            cur.append(c)
            quote = None if c == "'" else quote
        elif c == "\\" and i + 1 < len(text):
            cur.append(two)
            i += 1
        elif two == "$(":
            end = _close(text, i + 2)
            nested.append(text[i + 2:end - 1])
            cur.append(text[i:end])
            i = end - 1
        elif c == "`":
            end = text.find("`", i + 1)
            end = len(text) if end < 0 else end
            nested.append(text[i + 1:end])
            cur.append(text[i:end + 1])
            i = end
        elif quote == '"' or c in "'\"":
            cur.append(c)
            quote = None if quote == c else (quote or c)
        elif two in ("&&", "||", "|&") or c in ";|&\n":
            parts.append("".join(cur))
            cur = []
            i += 1 if two in ("&&", "||", "|&") else 0
        else:
            cur.append(c)
        i += 1
    parts.append("".join(cur))
    out = [strip(p) for p in parts if p.strip()]
    for n in nested:
        out.extend(split_commands(n))
    return [p for p in out if p]


def strip(cmd):
    """One command without a subshell's parentheses, leading assignments or wrappers."""
    cmd = cmd.strip().lstrip("({ ").strip()
    while cmd.endswith(")") and cmd.count("(") < cmd.count(")"):
        cmd = cmd[:-1].strip()
    while True:
        m = ASSIGN_RE.match(cmd)
        words = cmd.split(None, 1)
        if m:
            cmd = cmd[m.end():]
        elif len(words) < 2:
            return cmd
        elif words[0] in WRAPPERS and not (words[0] == "command" and words[1].startswith("-")):
            cmd = words[1]
        elif words[0] == "timeout" and len(words[1].split(None, 1)) > 1:
            cmd = words[1].split(None, 1)[1]
        elif words[0] == "nice":
            cmd = re.sub(r"^(-n\s+\S+|-\d+)\s+", "", words[1])
        elif words[0] == "stdbuf":
            cmd = re.sub(r"^(-\S+\s+)+", "", words[1])
        elif words[0] == "xargs" and not words[1].startswith("-"):
            cmd = words[1]
        else:
            return cmd


def bash_matches(spec, command):
    """True when a Bash rule matches any command the text holds."""
    regex, bare = bash_regex(spec)
    return any(regex.match(c) or c == bare for c in split_commands(command))


def read_regex(spec):
    """A Read rule's gitignore pattern, anchored at ~/ or //, as a regex."""
    if not spec.startswith(("~/", "//")):
        raise ValueError("a user-settings Read rule starts with ~/ or //: %s" % spec)
    path, out, i = HOME + spec[1:] if spec.startswith("~/") else spec[1:], "", 0
    while i < len(path):
        if path.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif path.startswith("**", i):
            out, i = out + ".*", i + 2
        else:
            out += {"*": "[^/]*", "?": "[^/]"}.get(path[i]) or re.escape(path[i])
            i += 1
    return re.compile("^%s(?:/.*)?$" % out)


def matches(rule, text, kind):
    """True when a Bash(...) or Read(...) rule of that kind matches a command or a path."""
    m = RULE_RE.match(rule)
    if not m or m.group(1) != kind:
        return False
    if kind == "Bash":
        return bash_matches(m.group(2), text)
    return bool(read_regex(m.group(2)).match(HOME + text[1:] if text.startswith("~/") else text))


# Rows from the docs' own tables and notes (code.claude.com/docs/en/permissions, read 2026-11-14).
DOC_ROWS = [
    ("npm run build", ["npm run build"], ["npm run build --watch"]),
    ("npm run *", ["npm run build", "npm run test --watch", "npm run"], ["npm install"]),
    ("git log * main", ["git log --oneline main", "git log -5 main"], ["git log main", "git push origin main"]),
    ("git * main", ["git merge main", "git push origin main"], ["git log"]),
    ("* --version", ["node --version"], ["node -v"]),
    ("ls *", ["ls -la", "ls"], ["lsof"]),
    ("ls*", ["ls -la", "lsof"], []),
    ("* --help *", ["npm --help x"], ["npm --help"]),
    ("ls:*", ["ls -la", "ls"], ["lsof"]),
    ("git clean *", ["cd /tmp && git clean -f", "echo \"$(git clean -f)\""], []),
    ("npm test *", ["timeout 30 npm test"], []),
    ("rm *", ["FOO=bar rm -rf tmp/"], ["/bin/rm -rf build/", "bash -c 'rm -rf build/'"]),
    ("grep *", ["xargs grep pattern"], ["xargs -n1 grep pattern"]),
    ("git push *", ["git push origin main"], ["git -C . push origin main"]),
]
READ_ROWS = [
    ("//**/.env", ["/a/b/.env", "/.env"], ["/a/.env.example"]),
    ("~/Documents/*.pdf", ["~/Documents/a.pdf"], ["~/Documents/x/a.pdf"]),
    ("~/.ssh/**", ["~/.ssh/id_rsa", "~/.ssh/a/b"], ["~/.sshx"]),
]


def self_test():
    problems = []
    for kind, rows in (("Bash", DOC_ROWS), ("Read", READ_ROWS)):
        for spec, hits, misses in rows:
            rule = "%s(%s)" % (kind, spec)
            problems += ["%s should match %r" % (rule, c) for c in hits if not matches(rule, c, kind)]
            problems += ["%s should not match %r" % (rule, c) for c in misses if matches(rule, c, kind)]
    for p in problems:
        print("FAIL model: " + p)
    print("claude_deny_model self-test: %d rows, %s"
          % (len(DOC_ROWS) + len(READ_ROWS), "ok" if not problems else "%d problems" % len(problems)))
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(self_test() if sys.argv[1:] == ["--self-test"] else 2)
