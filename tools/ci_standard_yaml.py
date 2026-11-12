"""ci_standard_yaml.py: the block-YAML subset GitHub workflows use, read with the standard library only.

Part of the CI standard's checks (ci_standard.py), embedded with it in ci-standard.yml. It reads mappings, sequences,
flow lists and mappings on one line, block scalars, and an anchor on a value with an alias to it. It refuses merge
keys and tags, which GitHub does not read either: a workflow it cannot read raises ParseError, exit 3.
"""

from __future__ import annotations

import json
import re

# An Actions expression opens with these two characters. Actions evaluates them anywhere in a workflow, a run block
# included, and this file is embedded in one, so the source never spells them together.
EXPR = "$" + "{{"
BLOCK_RE = re.compile(r"[|>][+-]?[0-9]?")
KEY_END_RE = re.compile(r":(?= |\Z)")
ANCHOR_RE = re.compile(r"&([A-Za-z0-9_-]+)(?: (.*))?")
ALIAS_RE = re.compile(r"\*([A-Za-z0-9_-]+)")


class ParseError(Exception):
    """A workflow this parser cannot read: could not check, exit 3."""


def strip_comment(line: str) -> str:
    """The line without a # comment that starts outside quotes, and without trailing space."""
    quote = None
    for i, c in enumerate(line):
        if quote:
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c == "#" and (i == 0 or line[i - 1] in " \t"):
            return line[:i].rstrip()
    return line.rstrip()


def quoted(text: str) -> bool:
    """Whether text is wrapped in one pair of matching quotes."""
    return len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'"


def key_end(text: str):
    """Index of the colon that ends a key, or None. A quote opening the text hides its colons; { or [ opening it
    makes it a flow collection, never a key."""
    if text[:1] in ("{", "["):
        return None
    start = 0
    if text[:1] in ("\"", "'"):
        close = text.find(text[0], 1)
        if close < 0:
            return None
        start = close + 1
    m = KEY_END_RE.search(text, start)
    return m.start() if m else None


def split_key(text: str):
    """(key, rest) for "key: rest" or "key:", or None for a plain scalar."""
    i = key_end(text)
    if i is None:
        return None
    key = text[:i].strip()
    if quoted(key):
        key = key[1:-1]
    if not key or key.startswith(("{", "[")) or EXPR in key:
        return None
    return key, text[i + 1:].strip()


def flow_list(inner: str) -> list:
    """The items of a one-line flow list, its brackets already removed."""
    return [scalar(x) for x in inner.split(",")] if inner else []


def flow_mapping(text: str) -> dict:
    """A one-line flow mapping, {a: 1, b: 2}."""
    inner = text[1:-1].strip()
    out = {}
    for part in inner.split(",") if inner else []:
        kv = split_key(part.strip())
        if not kv:
            raise ParseError(f"flow mapping this parser cannot read: {text[:60]!r}")
        out[kv[0]] = scalar(kv[1]) if kv[1] else None
    return out


def scalar(text: str):
    """A value on one line: a quoted or plain string, a flow list or a flow mapping."""
    text = text.strip()
    if text[:1] in "&*!" and text[:3] != EXPR:
        raise ParseError(f"anchors, aliases and tags are not read: {text[:40]!r}")
    if quoted(text):
        return text[1:-1]
    if text.startswith("[") and text.endswith("]"):
        return flow_list(text[1:-1].strip())
    if text.startswith("{") and text.endswith("}"):
        return flow_mapping(text)
    if text.startswith(("[", "{")):
        raise ParseError(f"multi-line flow collection: {text[:60]!r}")
    return text


def dashes(line: str, out: list) -> tuple:
    """(indent, body) after the sequence dashes opening line, appending one dash token to out for each."""
    indent = len(line) - len(line.lstrip())
    body = line.strip()
    while body == "-" or body.startswith("- "):
        out.append((indent, "dash", ""))
        rest = body[1:]
        indent += 1 + len(rest) - len(rest.lstrip())
        body = rest.strip()
    return indent, body


def block(raw: list, i: int, indent: int, out: list) -> int:
    """Appends the block scalar starting at raw[i], deeper than indent, as one token; returns the line after it."""
    lines = []
    while i < len(raw) and (not raw[i].strip() or len(raw[i]) - len(raw[i].lstrip()) > indent):
        lines.append(raw[i].rstrip())
        i += 1
    # Dedent by the first line's indent, as YAML does, so code in a block keeps its own indentation.
    cut = min((len(x) - len(x.lstrip()) for x in lines if x.strip()), default=0)
    out.append((indent + 1, "block", "\n".join(x[cut:] for x in lines).strip("\n")))
    return i


def tokens(text: str) -> list:
    """(indent, kind, text) with kind dash, line or block (a block scalar's text, already joined)."""
    raw = text.replace("\t", "    ").splitlines()
    out, i = [], 0
    while i < len(raw):
        line = strip_comment(raw[i])
        i += 1
        if not line.strip() or line.strip() in ("---", "..."):
            continue
        indent, body = dashes(line, out)
        if not body:
            continue
        out.append((indent, "line", body))
        kv = split_key(body)
        if BLOCK_RE.fullmatch(kv[1] if kv else body):
            i = block(raw, i, indent, out)
    return out


class Reader:
    """A cursor over tokens(), and the anchors read so far."""

    def __init__(self, toks: list):
        self.toks, self.pos, self.anchors = toks, 0, {}

    def peek(self):
        """The next token, or None at the end."""
        return self.toks[self.pos] if self.pos < len(self.toks) else None

    def at(self, indent: int, kind: str) -> bool:
        """Whether the next token is of kind at exactly indent."""
        t = self.peek()
        return bool(t) and t[0] == indent and t[1] == kind

    def node(self, indent: int):
        """The value at indent or deeper: a sequence, a block scalar, a plain scalar or a mapping."""
        t = self.peek()
        if t is None or t[0] < indent:
            return None
        if t[1] == "dash":
            return self.seq(t[0])
        if t[1] == "block":
            self.pos += 1
            return t[2]
        if split_key(t[2]) is None:
            self.pos += 1
            return self.plain(scalar(t[2]), t[0] - 1)
        return self.mapping(t[0])

    def plain(self, value, indent: int):
        """A plain scalar folded over deeper lines with no key."""
        while isinstance(value, str) and self.peek() and self.peek()[0] > indent and self.peek()[1] == "line" and split_key(self.peek()[2]) is None:
            value += " " + self.peek()[2]
            self.pos += 1
        return value

    def seq(self, indent: int) -> list:
        """The sequence whose dashes sit at indent."""
        items = []
        while self.at(indent, "dash"):
            self.pos += 1
            nxt = self.peek()
            items.append(self.node(indent + 1) if nxt and nxt[0] > indent else None)
        if self.peek() and self.peek()[0] > indent:
            raise ParseError(f"unexpected indent near {self.peek()[2]!r}")
        return items

    def key(self) -> tuple:
        """(key, rest) of the next line, which must hold a key."""
        kv = split_key(self.peek()[2])
        if kv is None:
            raise ParseError(f"expected a key near {self.peek()[2]!r}")
        self.pos += 1
        return kv

    def mapping(self, indent: int) -> dict:
        """The mapping whose keys sit at indent; an anchor on a value is kept for later aliases."""
        out = {}
        while self.at(indent, "line"):
            key, rest = self.key()
            if key in out or key == "<<":
                raise ParseError(f"duplicate or merge key {key!r}")
            anchor = ANCHOR_RE.fullmatch(rest)
            if anchor:
                rest = anchor[2] or ""
            out[key] = self.value(rest, indent)
            if anchor:
                self.anchors[anchor[1]] = out[key]
        return out

    def value(self, rest: str, indent: int):
        """A key's value: an alias, a scalar on the key's line, or what the following lines hold."""
        alias = ALIAS_RE.fullmatch(rest)
        if alias:
            if alias[1] not in self.anchors:
                raise ParseError(f"alias to an unknown anchor {alias[1]!r}")
            return json.loads(json.dumps(self.anchors[alias[1]]))
        if rest and not BLOCK_RE.fullmatch(rest):
            return self.plain(scalar(rest), indent)
        return self.nested(indent)

    def nested(self, indent: int):
        """The value on the lines below a key at indent: a block scalar, a sequence, a deeper node, or None."""
        nxt = self.peek()
        if not nxt:
            return None
        if nxt[1] == "block" and nxt[0] > indent:
            self.pos += 1
            return nxt[2]
        if nxt[1] == "dash" and nxt[0] >= indent:
            return self.seq(nxt[0])
        return self.node(nxt[0]) if nxt[0] > indent else None


def parse(text: str) -> dict:
    """A workflow's text as a mapping; ParseError when it is not one, or holds what this subset does not read."""
    r = Reader(tokens(text))
    doc = r.node(0)
    if r.pos != len(r.toks):
        raise ParseError(f"could not read past {r.toks[r.pos][2]!r}")
    if not isinstance(doc, dict):
        raise ParseError("a workflow is a mapping at the top")
    return doc
