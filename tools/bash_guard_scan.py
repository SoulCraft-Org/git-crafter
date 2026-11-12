"""bash_guard_scan.py: The shell scan: quotes, comments, $'...', heredoc markers and
substitutions read the way bash reads them (step 1 of bash_guard.py).

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import codecs
import re
import shlex


HEREDOC_RE = re.compile(
    r"<<(-?)[ \t]*(?:'([^'\n]+)'|\"([^\"\n]+)\"|(\\)?([^\s'\"<>;&|()]+))")


def decode_ansi_c(s):
    """s with its backslash escapes decoded, as bash reads $'...' and printf;
    s itself when it does not decode."""
    try:
        return codecs.decode(s.encode("latin-1", "backslashreplace"), "unicode_escape")
    except Exception:
        return s


# Runs that hold nothing the scan must look at: outside quotes, any text but
# a backslash, #, $, a quote, a backtick, <, a newline or a parenthesis; in
# double quotes, any text but a backslash, ", $ or a backtick. Each run is
# taken whole, so the scan never pays a step per ordinary character.
PLAIN_RE = re.compile(r"[^\\#$'\"`<\n()]+")
DQ_PLAIN_RE = re.compile(r'[^\\"$`]+')
COMMENT_AFTER = " \t\n;&|()"


class _Frame:
    """One context's state while Scan.ctx reads it: the text so far, the
    open quote, the last character read outside double quotes, the ( depth
    and the heredocs whose bodies start at the next newline."""

    __slots__ = ("out", "q", "prev", "depth", "pending")

    def __init__(self):
        self.out, self.q, self.prev, self.depth, self.pending = [], None, "\n", 0, []


class Scan:
    """One recursive pass over a command, the way bash reads it.

    After run(), text holds the command with comments removed, $'...'
    decoded and re-quoted, each heredoc operator replaced by __HEREDOCn__ and
    each substitution replaced by __SUBSTn__. docs[n] is (quoted, body).
    subs[n] is the scanned text of a substitution; all share this Scan's
    docs and subs.
    """

    def __init__(self, text):
        self.t = text
        self.docs = []
        self.subs = []

    def run(self):
        """The scanned text of the whole command."""
        out, _ = self.ctx(0, None)
        return out

    def ctx(self, i, closer):
        """Read from i to the end, or to the ) that closes this context when
        closer is ")". Returns the scanned text and the index after it."""
        f, n_len = _Frame(), len(self.t)
        while i < n_len:
            if f.q:
                i = self.single_quoted(f, i) if f.q == "'" else self.double_quoted(f, i)
                continue
            j = self.unquoted(f, i)
            if j is None:
                j = self.opener(f, i)
            if j is not None:
                i = j
                continue
            ch = self.t[i]
            if closer == ")" and ch in "()":
                if ch == "(":
                    f.depth += 1
                elif f.depth == 0:
                    return "".join(f.out), i + 1
                else:
                    f.depth -= 1
            f.out.append(ch)
            f.prev = ch
            i += 1
        return "".join(f.out), i

    def single_quoted(self, f, i):
        """Inside '...': everything up to and with the closing quote."""
        j = self.t.find("'", i)
        end = len(self.t) if j < 0 else j + 1
        f.out.append(self.t[i:end])
        f.prev = self.t[end - 1]
        if j >= 0:
            f.q = None
        return end

    def double_quoted(self, f, i):
        """Inside "...": a run of text, an escape, the closing quote, or a
        substitution, which bash runs in double quotes too."""
        t = self.t
        m = DQ_PLAIN_RE.match(t, i)
        if m:
            f.out.append(m.group())
            return m.end()
        ch = t[i]
        if ch == "\\" and i + 1 < len(t):
            f.out.append(t[i:i + 2])
            return i + 2
        if ch == '"':
            f.q = None
            f.out.append(ch)
            f.prev = ch
            return i + 1
        if t.startswith("$(", i) and not t.startswith("$((", i):
            return self.subst(i, f.out)
        if ch == "`":
            return self.backtick(i, f.out)
        f.out.append(ch)
        return i + 1

    def unquoted(self, f, i):
        """Outside quotes: a plain run, an escape, a comment or an opening
        quote. None when the text at i is none of those."""
        t = self.t
        m = PLAIN_RE.match(t, i)
        if m:
            f.out.append(m.group())
            f.prev = m.group()[-1]
            return m.end()
        ch = t[i]
        if ch == "\\" and i + 1 < len(t):
            f.out.append(t[i:i + 2])
            f.prev = t[i + 1]
            return i + 2
        if ch == "#" and f.prev in COMMENT_AFTER:
            j = t.find("\n", i)
            return len(t) if j < 0 else j
        if ch in "'\"":
            f.q = ch
            f.out.append(ch)
            f.prev = ch
            return i + 1
        return None

    def opener(self, f, i):
        """Outside quotes: $'...', a substitution, a heredoc operator, or the
        newline after which pending heredoc bodies start. None otherwise."""
        t = self.t
        if t.startswith("$'", i):
            return self.ansi_c(f, i)
        if (t.startswith("$(", i) and not t.startswith("$((", i)) or t[i] == "`":
            j = self.subst(i, f.out) if t[i] == "$" else self.backtick(i, f.out)
            f.prev = "_"
            return j
        if t.startswith("<<", i):
            j = self.heredoc_op(f, i)
            if j is not None:
                return j
        if t[i] == "\n" and f.pending:
            return self.heredoc_bodies(f, i)
        return None

    def ansi_c(self, f, i):
        """$'...' decoded and quoted again; returns the index after its quote."""
        t, j, buf = self.t, i + 2, []
        while j < len(t) and t[j] != "'":
            if t[j] == "\\" and j + 1 < len(t):
                buf.append(t[j:j + 2])
                j += 2
            else:
                buf.append(t[j])
                j += 1
        f.out.append(shlex.quote(decode_ansi_c("".join(buf))))
        f.prev = "'"
        return j + 1

    def heredoc_op(self, f, i):
        """A << operator becomes a __HEREDOCn__ marker, its body read at the
        next newline. None for <<<, a <<< tail, or no delimiter."""
        t = self.t
        if t.startswith("<<<", i) or (i > 0 and t[i - 1] == "<"):
            return None
        m = HEREDOC_RE.match(t, i)
        if not m:
            return None
        k = len(self.docs)
        self.docs.append([bool(m.group(2) or m.group(3) or m.group(4)), ""])
        f.pending.append((k, m.group(1) == "-", m.group(2) or m.group(3) or m.group(5)))
        f.out.append(f" __HEREDOC{k}__ ")
        f.prev = " "
        return m.end()

    def heredoc_bodies(self, f, i):
        """At the newline after heredoc operators: read each body in turn."""
        f.out.append("\n")
        i += 1
        for k, dash, delim in f.pending:
            body, i = self.heredoc_body(i, dash, delim)
            self.docs[k][1] = "\n".join(body)
        f.pending = []
        f.prev = "\n"
        return i

    def heredoc_body(self, i, dash, delim):
        """The lines from i up to the delimiter line, and the index after it."""
        t, n_len, body = self.t, len(self.t), []
        while i < n_len:
            j = t.find("\n", i)
            end = n_len if j < 0 else j
            line = t[i:end]
            i = n_len if j < 0 else j + 1
            if (line.lstrip("\t") if dash else line) == delim:
                break
            body.append(line)
        return body, i

    def subst(self, i, out):
        """$( ... ) scanned as its own context; returns the index after it."""
        inner, j = self.ctx(i + 2, ")")
        self.subs.append(("scanned", inner))
        out.append(f"__SUBST{len(self.subs) - 1}__")
        return j

    def backtick(self, i, out):
        """`...` kept raw; returns the index after its closing backtick."""
        j = i + 1
        while j < len(self.t) and self.t[j] != "`":
            j += 2 if self.t[j] == "\\" else 1
        self.subs.append(("raw", self.t[i + 1:j]))
        out.append(f"__SUBST{len(self.subs) - 1}__")
        return j + 1
