// One pass over a markdown doc for the Documentation collector (docs.mjs).

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$/;
const LIST = /^\s*([-*+]|\d+[.)])\s+/;
const TABLE = /^\s*\|/;
const IMAGE = /!\[[^\]]*\]\([^)]*\)|<(img|svg|picture)\b/i;
const QUOTE = /^\s*>/;
const HTML = /^\s*<\/?[a-zA-Z!]/;

export { FENCE, LIST };

// One pass over a doc. Front matter and HTML comments are not read, so they
// count nowhere. Code (fenced or indented), tables of two or more columns and
// images are visual.
// `prose` keeps every other line with inline code blanked, for later checks;
// `spans` keeps that inline code and `code` the code lines, for the checks of
// what a doc names. Interactive elements: each mermaid block's diagram keyword
// and <details> blocks. `headings` keeps each heading's level and text, and
// `images` each image's alt text, for the markup check.
export function parseMarkdown(text) {
  const src = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  if (src[0] === '---') {
    const end = src.indexOf('---', 1);
    if (end > 0) i = end + 1;
  }
  const st = {
    res: { words: 0, lines: 0, visualLines: 0, prose: [], spans: [], code: [], links: [], anchors: new Set(), mermaid: [], details: 0, headings: [], images: [] },
    slugSeen: new Map(),
    fence: null,
    mermaid: null, // { kind, front } while inside a mermaid block
    comment: false,
    prev: 'blank',
    lastBlock: 'blank',
  };
  for (; i < src.length; i++) readLine(st, src[i], i + 1);
  return st.res;
}

function readLine(st, raw, n) {
  if (st.fence) return fencedLine(st, raw, n);
  const line = stripComments(st, raw);
  if (line === null) return;
  if (!line.trim()) return blankLine(st, raw);
  st.res.lines++;
  if (openFence(st, line)) return;
  if (indentedCode(st, line, n)) return;
  proseLine(st, line, n);
}

// The line without HTML comments; null while a comment that began earlier runs on.
function stripComments(st, raw) {
  let line = raw;
  if (st.comment) {
    const end = line.indexOf('-->');
    if (end < 0) return null;
    st.comment = false;
    line = line.slice(end + 3);
  }
  line = line.replace(/<!--[\s\S]*?-->/g, '');
  const open = line.indexOf('<!--');
  if (open >= 0) {
    st.comment = true;
    line = line.slice(0, open);
  }
  return line;
}

function blankLine(st, raw) {
  if (raw.trim()) return; // only a comment was on this line
  if (st.prev !== 'blank') st.lastBlock = st.prev;
  st.prev = 'blank';
}

const closesFence = (line, fence) => {
  const close = FENCE.exec(line);
  return Boolean(close) && close[1][0] === fence[0] && close[1].length >= fence.length && !line.trim().slice(close[1].length);
};

function fencedLine(st, line, n) {
  const { res } = st;
  res.lines++;
  res.visualLines++;
  if (closesFence(line, st.fence)) {
    st.fence = null;
    st.mermaid = null;
    return;
  }
  res.words += countWords(line);
  res.code.push({ line: n, text: line });
  if (st.mermaid) noteMermaid(st.mermaid, line.trim());
}

function noteMermaid(m, t) {
  if (m.kind == null) {
    if (t === '---') m.front = !m.front; // the block's own front matter
    else if (t && !m.front && !t.startsWith('%%')) m.kind = t.split(/\s+/)[0];
  }
}

function openFence(st, line) {
  const f = FENCE.exec(line);
  if (!f) return false;
  st.fence = f[1];
  if (line.trim().slice(f[1].length).trim().split(/\s+/)[0].toLowerCase() === 'mermaid') {
    st.mermaid = { kind: null, front: false };
    st.res.mermaid.push(st.mermaid);
  }
  st.res.visualLines++;
  st.prev = 'code';
  return true;
}

function indentedCode(st, line, n) {
  if (!(/^ {4,}\S/.test(line) && ((st.prev === 'blank' && st.lastBlock !== 'list') || st.prev === 'icode'))) return false;
  st.res.visualLines++;
  st.res.words += countWords(line);
  st.res.code.push({ line: n, text: line });
  st.prev = 'icode';
  return true;
}

function collectLinks(res, plain, n) {
  for (const m of plain.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) res.links.push({ line: n, target: m[1] });
  const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(\s|$)/.exec(plain);
  if (def) res.links.push({ line: n, target: def[1] });
  for (const m of plain.matchAll(/\b(?:href|src)="([^"]+)"/g)) res.links.push({ line: n, target: m[1] });
  for (const m of plain.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) res.anchors.add(m[1].toLowerCase());
}

// An <img> tag's alt attribute, quoted either way or bare.
const ALT = /(?<![\w-])alt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

// Each image with its alt text: ![alt](src) and <img alt="...">.
function collectImages(res, plain, n) {
  for (const m of plain.matchAll(/!\[([^\]]*)\]\(/g)) res.images.push({ line: n, alt: m[1].trim() });
  for (const m of plain.matchAll(/<img\b[^>]*>/gi)) {
    const alt = ALT.exec(m[0]);
    res.images.push({ line: n, alt: (alt?.[1] ?? alt?.[2] ?? alt?.[3] ?? '').trim() });
  }
}

const listContinues = (st, line) => st.prev === 'list' || (st.prev === 'blank' && st.lastBlock === 'list' && /^\s{2,}/.test(line));

// The kind of a line that is not a heading.
function otherKind(st, line) {
  if (TABLE.test(line)) return 'table';
  if (IMAGE.test(line)) return 'image';
  if (LIST.test(line)) return 'list';
  if (QUOTE.test(line) || st.prev === 'quote') return 'quote';
  if (HTML.test(line)) return 'html';
  return listContinues(st, line) ? 'list' : 'text';
}

function addAnchor(st, heading) {
  const base = slugify(heading);
  const seen = st.slugSeen.get(base) || 0;
  st.slugSeen.set(base, seen + 1);
  st.res.anchors.add(seen ? `${base}-${seen}` : base);
}

function proseLine(st, line, n) {
  const { res } = st;
  const plain = line.replace(/`[^`]*`/g, ' ');
  res.prose.push({ line: n, text: plain });
  collectLinks(res, plain, n);
  collectImages(res, plain, n);
  const spans = [...line.matchAll(/`([^`]*)`/g)].map((m) => m[1]);
  for (const span of spans) if (span.trim()) res.spans.push({ line: n, text: span });
  res.words += countWords(`${plain.replace(/\]\([^)]*\)/g, ']').replace(/<[^>]+>/g, ' ')} ${spans.join(' ')}`);
  const h = HEADING.exec(line);
  if (h) {
    addAnchor(st, h[2]);
    res.headings.push({ line: n, level: h[1].length, text: h[2] });
  }
  const kind = h ? 'heading' : otherKind(st, line);
  tally(res, kind, plain);
  st.prev = kind;
}

// A table row's cells: its unescaped pipes, less the outer pair.
const cells = (plain) => plain.trim().replace(/^\|/, '').replace(/(?<!\\)\|\s*$/, '').split(/(?<!\\)\|/).length;

// Visual lines and <details> blocks. A one-column table is a list in a
// table's markup, so its rows are prose.
function tally(res, kind, plain) {
  if ((kind === 'table' && cells(plain) > 1) || kind === 'image') res.visualLines++;
  res.details += (plain.match(/<details\b/gi) || []).length;
}

function countWords(s) {
  return (s.match(/[\p{L}\p{N}]+(?:['’._\-/][\p{L}\p{N}]+)*/gu) || []).length;
}

// GitHub's heading anchors: links to their text, tags and punctuation out,
// lowercase, spaces to hyphens.
export function slugify(heading) {
  return heading
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}
