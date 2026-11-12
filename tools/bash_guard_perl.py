"""bash_guard_perl.py: Perl one-liners: the substitutions and quote-like bodies whose text
pass 2 keeps.

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import bisect
import re


# Pass 2 (kept_hits) only. Interpolation that runs code in an s/// body with
# no e flag: @{[ ]}, ${\ }, $#{ }, subscripts of named and punctuation
# variables ($h{ }, $a[ ], $+{ }, $&[ ], $^H{ }, and $ h{ } with a space),
# -> derefs, (?{ }); ${1} and ${name} only name a variable, and a sigil after
# one backslash (\$x) is text, unless that backslash ends a \c\ control
# character (\c\$x interpolates).
PERL_INTERP_RE = re.compile(
    r"(?<!(?<!\\)(?<!\\c)\\)[$@]\s*\{(?!\s*\w+\s*\})|\$#\s*\{"
    r"|(?<!(?<!\\)(?<!\\c)\\)\$\s*(?:[\w:]+|\^\w|[^\w\s{])\s*(?:->\s*)?[\[{]"
    r"|(?<!(?<!\\)(?<!\\c)\\)@(?:[\w:]+|\^\w|[^\w\s{])\s*(?:->\s*)?[\[{]"
    r"|->\s*[@$]\s*[\[{]"
    r"|\(\?\??\{")


# A program pass 2 may blank holds nothing but s///, tr/// and y///
# statements (PERL_SUBST_AT_RE), each maybe after $x =~ and before an if or
# unless /re/ or line-number test ($. == 1), split by ; or newlines. In any
# other program a string or a comment can hold a decoy (print "y|"; ...;
# print "||") that PERL_SUBST_RE reads as a body over real code, so that
# program stays whole.
PERL_SUBST_AT_RE = re.compile(
    r"(?:s|tr|y)(?:\{(?:[^{}\\]|\\.)*\}\s*\{(?:[^{}\\]|\\.)*\}"
    r"|([/|#!,])(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1)([a-z]*)")


PERL_LHS_RE = re.compile(r"\$\w+\s*[=!]~\s*")


PERL_MOD_RE = re.compile(r"[ \t]+(?:if|unless)[ \t]+(?:m?/((?:[^/\\\n]|\\.)*)/[a-z]*"
                         r"|\$\.\s*(?:[=!<>]=?)\s*\d+)")


PERL_SEP_RE = re.compile(r"[\s;]*")


# Pass 2 only, read by perl_letter_e_delims: where an s/// with a word character
# for its delimiter may start (s xaxbxe, s _a_b_e, s 0a0b0e, s éaébée), and its flags.
PERL_S_START_RE = re.compile(r"(?<![\w$@%&])s")


PERL_WORD_RE = re.compile(r"\w")


PERL_FLAGS_RE = re.compile(r"[a-z]*")


# Pass 2 only. The opening of a quote-like string: perl's q, qq, qw and qx,
# any delimiter (a letter after a space); ruby's %, %q, %Q, %w, %W and %x.
QUOTE_LIKE_RE = {
    "perl": re.compile(r"(?<![\w$@%&])q[qwx]?(?:\s*([^\w\s])|\s+(\w))"),
    "ruby": re.compile(r"%[qQwWx]?([^\w\s])"),
}


QUOTE_CLOSERS = {"(": ")", "[": "]", "{": "}", "<": ">"}


def perl_simple_substs(code):
    """The s///, tr/// and y/// statements of code when it holds nothing
    else, or None: see PERL_SUBST_AT_RE. An if or unless /re/ whose regex
    interpolates code (PERL_INTERP_RE) counts as something else."""
    out, i, n = [], 0, len(code)
    while True:
        i = PERL_SEP_RE.match(code, i).end()
        if i == n:
            return out
        lhs = PERL_LHS_RE.match(code, i)
        m = PERL_SUBST_AT_RE.match(code, lhs.end() if lhs else i)
        if not m:
            return None
        out.append(m)
        i = m.end()
        mod = PERL_MOD_RE.match(code, i)
        if mod:
            if PERL_INTERP_RE.search(mod.group(1) or ""):
                return None
            i = mod.end()
        k = PERL_SEP_RE.match(code, i).end()
        if k < n and not re.search(r"[;\n]", code[i:k]):
            return None


def perl_subst_parts(text, d):
    """An s///, tr/// or y/// split at its unescaped delimiter d, with \\d read
    as d, so no part runs across the delimiter."""
    parts, cur, i = [], "", 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            cur += text[i + 1] if text[i + 1] == d else text[i:i + 2]
            i += 2
        elif ch == d:
            parts.append(cur)
            cur, i = "", i + 1
        else:
            cur, i = cur + ch, i + 1
    return parts + [cur]


def perl_text_kept(code):
    """Perl code with each s///, tr/// and y/// body blanked only when nothing
    in it can run: the program is nothing but such statements
    (perl_simple_substs), none has an e flag, and a body that interpolates
    code (PERL_INTERP_RE) is kept. Any other program stays whole."""
    substs = perl_simple_substs(code)
    if substs is None or any("e" in m.group(2) for m in substs):
        return code
    out, last = [], 0
    for m in substs:
        parts = perl_subst_parts(m.group(0), m.group(1)) if m.group(1) else [m.group(0)]
        if len(parts) > 2:  # in a pattern, $ before a space is the end anchor, even with /x
            parts[1] = re.sub(r"\$(?=\s)", "", parts[1])
        keep = any(PERL_INTERP_RE.search(p) for p in parts)  # a $ before the delimiter is no $/[
        out += [code[last:m.start()], m.group(0) if keep else " "]
        last = m.end()
    return "".join(out) + code[last:]


def perl_letter_e_delims(code):
    """The word-character delimiters d of code's s/// operators with an e
    flag: s (not after a word character or sigil), whitespace or #-comments
    ending in a newline (at least one), d, two parts that each end at the
    next d no backslash escapes, then flags holding e that end before a
    character that is neither a word character nor (. Every s is tried, so
    a decoy (print "s z"; s xax..xe) cannot hide a later operator, and a
    decoy's false flags (system() never count. Near linear in code: one
    pass finds where each run of whitespace and comments ends, one indexes
    each character's unescaped positions, and each s looks up its
    delimiter's next two copies with bisect."""
    n = len(code)
    run_end, spots = blank_run_ends(code), unescaped_spots(code)
    flags_at, out = {}, set()
    for m in PERL_S_START_RE.finditer(code):
        q = run_end[m.end()]
        if q == m.end() or q >= n or code[q] in out or not PERL_WORD_RE.match(code[q]):
            continue
        at = spots[code[q]]
        k = bisect.bisect_right(at, q)
        if k + 1 >= len(at):
            continue
        end = at[k + 1] + 1
        if end not in flags_at:
            flags_at[end] = flags_after(code, end)
        if "e" in flags_at[end]:
            out.add(code[q])
    return sorted(out)


def blank_run_ends(code):
    """For each index, where the run of whitespace and #-comments (each
    ending in a newline) that starts there ends: one pass from the end."""
    n = len(code)
    run_end, newline = list(range(n + 1)), n
    for i in range(n - 1, -1, -1):
        ch = code[i]
        if ch == "\n":
            newline = i
        if ch.isspace():
            run_end[i] = run_end[i + 1]
        elif ch == "#" and newline < n:
            run_end[i] = run_end[newline + 1]
    return run_end


def unescaped_spots(code):
    """Each character's positions in code where no backslash escapes it."""
    spots, slashes = {}, 0
    for i, ch in enumerate(code):
        if slashes % 2 == 0:
            spots.setdefault(ch, []).append(i)
        slashes = slashes + 1 if ch == "\\" else 0
    return spots


def flags_after(code, end):
    """The flags after an s/// that ends at end, or "" when the next
    character is a word character or (, so the letters are no flags."""
    flags = PERL_FLAGS_RE.match(code, end).group(0)
    after = code[end + len(flags):end + len(flags) + 1]
    return "" if after and (after == "(" or PERL_WORD_RE.match(after)) else flags


def perl_letter_blanked(code, d):
    """code with each unescaped delimiter d blanked and each escaped one (\\d)
    read as d, as perl reads the parts of s d..d..d: s tatsys\\tem(..)te runs system(."""
    return re.sub(r"\\[\s\S]|" + re.escape(d),
                  lambda m: (m.group(0)[1] if m.group(0)[1:] == d else m.group(0)) if len(m.group(0)) == 2 else " ",
                  code)


def quote_like_bodies(code, prog):
    """[(start, body)] for each perl or ruby quote-like string in code
    (QUOTE_LIKE_RE), read to its closing delimiter: a bracket pair nests,
    and a backslash before a delimiter leaves the delimiter."""
    pattern, out = QUOTE_LIKE_RE.get(prog), []
    for m in pattern.finditer(code) if pattern else ():
        d = m.group(1) or m.group(2)
        out.append((m.start(), quote_body(code, m.end(), d, QUOTE_CLOSERS.get(d, d))))
    return out


def quote_body(code, i, d, close):
    """The body of a quote-like string from i to its closing delimiter."""
    depth, body = 1, ""
    while i < len(code):
        ch = code[i]
        if ch == "\\" and i + 1 < len(code):
            body += code[i + 1] if code[i + 1] in (d, close) else code[i:i + 2]
            i += 2
            continue
        if ch == close:
            depth -= 1
            if not depth:
                break
        elif ch == d:
            depth += 1
        body, i = body + ch, i + 1
    return body
