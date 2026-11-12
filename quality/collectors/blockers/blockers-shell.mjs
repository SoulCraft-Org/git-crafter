// Reading shell commands for the Blockers collector: words, segments and steps (blockers.mjs).

import { SIMILAR, STOP, WRAPPERS } from './blockers-core.mjs';

// ------------------------------------------------------------- arguments

// The arguments of a shell command, as a set: each segment between &&, ||, ;,
// | or a newline loses its program name, its flags, a cd target (where, not
// what), short words, bare numbers and the STOP words.
export function words(command) {
  const out = new Set();
  for (const segment of String(command).split(/&&|\|\||[;|\n]/)) {
    const parts = segment.replace(/[()<>]/g, ' ').trim().split(/\s+/).map((w) => w.replace(/^['"]+|['"]+$/g, '')).filter(Boolean);
    let i = 0;
    while (i < parts.length && /^[A-Za-z_]\w*=/.test(parts[i])) i += 1;
    if (parts[i] === 'cd') continue;
    for (const w of parts.slice(i + 1)) {
      if (w.length >= 3 && !w.startsWith('-') && !/^\d+$/.test(w) && !STOP.has(w)) out.add(w);
    }
  }
  return out;
}

// Two commands do the same thing when they share at least SIMILAR of the
// smaller one's arguments, so a retry that splits or trims a blocked command
// still matches it.
export function similar(a, b) {
  const smaller = Math.min(a.size, b.size);
  if (!smaller) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / smaller >= SIMILAR;
}

// Split a shell command on &&, ||, ;, | and newlines outside quotes.
// A heredoc's body belongs to the segment that opened it, never a step of
// its own (#215): `python3 - <<'EOF'` then `import sys` is one step.
const HEREDOC = /^<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/;
// A command split into its steps at unquoted ;, &&, || and | (heredoc bodies stay with their step).
function splitShell(command) {
  const st = { out: [], cur: '', quote: null, pending: [] };
  const s = String(command);
  for (let i = 0; i < s.length; i++) i = shellChar(st, s, i);
  st.out.push(st.cur);
  return st.out.map((x) => x.trim()).filter(Boolean);
}

// Reads s[i] into the split; returns the index of the last character it used.
function shellChar(st, s, i) {
  const ch = s[i];
  if (st.quote) {
    if (ch === st.quote) st.quote = null;
    st.cur += ch;
    return i;
  }
  const doc = ch === '<' && s[i + 2] !== '<' ? HEREDOC.exec(s.slice(i)) : null;
  if (doc) {
    st.pending.push({ dash: doc[1] === '-', delim: doc[3] });
    st.cur += doc[0];
    return i + doc[0].length - 1;
  }
  if (ch === '\n' && st.pending.length) return readHeredocBodies(st, s, i);
  return unquotedChar(st, s, i);
}

// Each pending body runs to its delimiter line; the segment ends there.
function readHeredocBodies(st, s, i) {
  let at = i + 1;
  for (const { dash, delim } of st.pending.splice(0)) {
    while (at <= s.length) {
      const end = s.indexOf('\n', at) === -1 ? s.length : s.indexOf('\n', at);
      const line = s.slice(at, end);
      st.cur += `\n${line}`;
      at = end + 1;
      if ((dash ? line.replace(/^\t+/, '') : line) === delim) break;
    }
  }
  return at - 2;
}

function unquotedChar(st, s, i) {
  const ch = s[i];
  if (ch === "'" || ch === '"') {
    st.quote = ch;
    st.cur += ch;
  } else if ((ch === '&' || ch === '|') && s[i + 1] === ch) {
    st.out.push(st.cur);
    st.cur = '';
    return i + 1;
  } else splitAt(st, ch);
  return i;
}

// A lone | after > stays in the segment; ; | and a newline end it.
function splitAt(st, ch) {
  if (ch === '|' && st.cur.endsWith('>')) st.cur += ch;
  else if (ch === ';' || ch === '|' || ch === '\n') {
    st.out.push(st.cur);
    st.cur = '';
  } else st.cur += ch;
}

// A command as the comparison of two calls sees it: its segments, each with
// env assignments, wrapper programs, redirections and quotes dropped and its
// flags kept; a bash -c or sh -c string is read as the command it runs, and a
// cd segment says where, not what.
export function segments(command) {
  const out = [];
  for (const seg of splitShell(command)) {
    const inner = BASH_C.exec(seg);
    if (inner) {
      out.push(...segments(inner[2]));
      continue;
    }
    const parts = seg
      .replace(/(?:\d*|&)>[>|&]?\s*\S+|<\s*\S+/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/^['"]+|['"]+$/g, ''))
      .filter(Boolean);
    let i = 0;
    while (i < parts.length && (/^[A-Za-z_]\w*=/.test(parts[i]) || WRAPPERS.has(parts[i]))) i += 1;
    if (i < parts.length && parts[i] !== 'cd') out.push(parts.slice(i).join(' '));
  }
  return out;
}
const BASH_C = /^(?:[A-Za-z_]\w*=\S*\s+)*(?:ba|z)?sh\s+-c\s+(['"])([\s\S]*)\1$/;

// Each segment of a command as typed, whitespace collapsed, a bash -c string
// read as its own segments. The held check compares these, so an env prefix,
// a wrapper, a cd and a redirection are part of what a step does.
export function steps(command) {
  const out = [];
  for (const seg of splitShell(command)) {
    const inner = BASH_C.exec(seg);
    if (inner) out.push(...steps(inner[2]));
    else out.push(seg.replace(/\s+/g, ' '));
  }
  return out;
}

// The files a raw segment writes through an output redirection outside
// quotes: >, >>, >|, &>, N> and <>. /dev/null and a descriptor copy (>&N,
// >&-) write none.
export function outputTargets(seg) {
  const out = [];
  const s = String(seg);
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch !== '>') continue;
    const r = redirectAt(s, i);
    if (r.target && r.target !== '/dev/null') out.push(r.target);
    i = r.next;
  }
  return out;
}

// The redirection whose > is at s[i]: its target ('' for a descriptor copy)
// and the index to resume from.
function redirectAt(s, i) {
  let j = i + 1;
  if (s[j] === '>' || s[j] === '|') j += 1;
  if (s[j] === '&' && /^&(\d+|-)(?![^\s;&|<>()])/.test(s.slice(j))) return { target: '', next: j };
  if (s[j] === '&') j += 1;
  while (s[j] === ' ' || s[j] === '\t') j += 1;
  const { target, end } = readTarget(s, j);
  return { target, next: end - 1 };
}

function readTarget(s, from) {
  let target = '';
  let q = null;
  let j = from;
  for (; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === q) q = null;
      else target += c;
    } else if (c === "'" || c === '"') q = c;
    else if (/[\s;&|<>()]/.test(c)) break;
    else target += c;
  }
  return { target, end: j };
}

// A later call is essentially the blocked one when, for Bash, it runs every
// segment the blocked command ran, and for any other tool when its input is
// the same. Null when the blocked call cannot be read.
export function sameCall(blocked, later) {
  if (blocked.family === 'Bash') {
    if (!blocked.segments.length) return null;
    const have = new Set(later.segments);
    return blocked.segments.every((s) => have.has(s));
  }
  return blocked.inputKey === null ? null : blocked.inputKey === later.inputKey;
}

// git <verb> at the start of a segment, after any VAR=value assignments or
// `time`, with any -C or -c options before the verb.
const gitRuns = (cmd, verb) =>
  new RegExp(`(^|[;&|(\\n]\\s*)(\\w+=("[^"]*"|\\S*)\\s+)*(time\\s+)?git(\\s+-[Cc]\\s+("[^"]*"|\\S+))*\\s+${verb}\\b`).test(cmd);
// Whether a command runs git commit, git push, both, or neither (null).
export function gitKind(cmd) {
  const commit = gitRuns(cmd, 'commit');
  const push = gitRuns(cmd, 'push');
  return commit && push ? 'both' : commit ? 'commit' : push ? 'push' : null;
}
