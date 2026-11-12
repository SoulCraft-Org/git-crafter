// Which steps a fix may sit beside, and each rule's fix signals (blockers.mjs).

import { outputTargets } from './blockers-shell.mjs';

// A step that may sit beside a fix because it only reads stdin, the repo or
// literal text, or prints. It fails closed: its program (and git verb) must
// be on NEUTRAL and every flag on that program's list. An unknown flag, a file
// operand, a write, an input redirection, a command or process substitution
// or exec makes it a step of its own.
const LITERAL = String.raw`[^\s$\x60()<>|&;*?\[\]{}'"\\]+`;
const FOR_HEADER = new RegExp(String.raw`^for [A-Za-z_]\w* in( ${LITERAL})*$`);
const WHILE_READ = /^while (IFS=('[^']*'|"[^"$`\\]*"|[^\s$`'"]*) )?read( -r)?( [A-Za-z_]\w*)+$/;
// A short name only: PATH, HOME and the like are already exported and change what runs.
const LITERAL_ASSIGNMENT = new RegExp(String.raw`^(?!(IFS|ENV|PS\d)=)[A-Za-z][A-Za-z0-9]{0,2}=(${LITERAL}|'[^']*'|"[^"$\x60\\]*")$`);
export const DISCARDED = /(?:\d*|&)>>?\s*(?:\/dev\/null|&\d+|&-)(?=\s|$)/g;
const GREP = { short: 'EFivncqwxhs', valued: ['-A', '-B', '-C', '-m', '-e'], operands: (pattern) => (pattern ? 0 : 1) };
const NEUTRAL = {
  grep: GREP,
  egrep: GREP,
  head: { short: 'q', valued: ['-n', '-c'], numeric: true, operands: 0 },
  tail: { short: 'q', valued: ['-n', '-c'], numeric: true, operands: 0 },
  wc: { short: 'lwcm', operands: 0 },
  cut: { valued: ['-d', '-f', '-c', '-b'], operands: 0 },
  tr: { short: 'dsc', operands: 2 },
  sort: { short: 'nrufhVbM', valued: ['-k', '-t'], operands: 0 },
  uniq: { short: 'cdui', operands: 0 },
  // jq writes nothing and runs nothing, but it can read the environment.
  jq: { short: 'rceSMj', operands: 1, check: (ops) => !ops.some((o) => /\benv\b|\$ENV|input_filename|\$__loc__/.test(o)) },
  // ls lists names, never contents: the guard's own fix for a credential read.
  ls: { short: 'aAl1dhtrSFGR', operands: Infinity },
  echo: { short: 'neE', operands: Infinity },
  printf: { operands: Infinity },
};
const GIT_READS = {
  status: { short: 'sbz', long: ['--short', '--branch', '--porcelain', '--porcelain=', '--ignored', '--untracked-files='], operands: Infinity },
  log: { numeric: true, valued: ['-n', '--max-count'], long: ['--oneline', '--format=', '--pretty=', '--stat', '--name-only', '--name-status', '--graph', '--decorate', '--no-decorate', '--all', '--reverse', '--since=', '--until=', '--author=', '--grep=', '--no-merges', '--first-parent', '--abbrev-commit', '--date='], operands: Infinity },
  diff: { short: 'w', valued: ['-U'], long: ['--stat', '--name-only', '--name-status', '--cached', '--staged', '--shortstat', '--numstat', '--quiet', '--exit-code', '--no-color', '--color=never', '--check', '--unified='], operands: Infinity },
  show: { short: 's', long: ['--stat', '--name-only', '--name-status', '--format=', '--pretty=', '--oneline', '--no-patch', '--abbrev-commit'], operands: Infinity },
  'rev-parse': { short: 'q', long: ['--abbrev-ref', '--short', '--short=', '--verify', '--quiet', '--show-toplevel', '--git-dir', '--git-common-dir', '--symbolic-full-name', '--is-inside-work-tree', '--show-prefix'], operands: Infinity },
  'ls-files': { short: 'zmd', long: ['--others', '--exclude-standard', '--cached', '--modified', '--deleted', '--error-unmatch', '--full-name'], operands: Infinity },
};
// A loop keyword, a for or while-read header, or a literal assignment.
const isShellGlue = (s) => s === 'do' || s === 'done' || FOR_HEADER.test(s) || WHILE_READ.test(s) || LITERAL_ASSIGNMENT.test(s);

// True when a shell step only reads or prints: no write, no substitution, no redirect and a read-only program.
export function neutralStep(step) {
  const s = String(step);
  if (isShellGlue(s)) return true;
  if (writesFile(s) || substitutes(s)) return false;
  const bare = s.replace(DISCARDED, ' ');
  if (unquoted(bare).some((ch) => '<>|;&'.includes(ch))) return false;
  const [prog, ...args] = shellWords(bare);
  if (prog === 'git') return neutralGit(args);
  return Object.hasOwn(NEUTRAL, prog ?? '') && argsFit(NEUTRAL[prog], args);
}

// git with at most -C dir and --no-pager before a read verb; never -c.
function neutralGit(args) {
  let i = 0;
  while (args[i] === '-C' || args[i] === '--no-pager') i += args[i] === '-C' ? 2 : 1;
  const [verb, ...rest] = args.slice(i);
  if (verb === 'branch') return rest.length === 1 && rest[0] === '--show-current';
  if (verb === 'worktree') return rest[0] === 'list' && rest.slice(1).every((a) => a === '--porcelain');
  return Object.hasOwn(GIT_READS, verb ?? '') && argsFit(GIT_READS[verb], rest);
}

// Every flag on the program's lists, and no more operands than it allows.
function argsFit(spec, args) {
  const st = { operands: 0, pattern: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      st.operands += args.length - i - 1;
      break;
    }
    const step = a.startsWith('--') ? longFlag(spec, a) : a.startsWith('-') && a.length > 1 ? shortFlag(spec, a, st) : 'operand';
    if (step === false) return false;
    if (step === 'operand') st.operands += 1;
    else i += step;
  }
  return withinLimits(spec, args, st);
}

function withinLimits(spec, args, st) {
  const max = typeof spec.operands === 'function' ? spec.operands(st.pattern) : spec.operands;
  return st.operands <= max && (!spec.check || spec.check(args.filter((x) => !x.startsWith('-'))));
}

// A --flag: the extra arguments it takes (0 or 1), or false when not allowed.
function longFlag(spec, a) {
  const name = a.split('=')[0];
  if ((spec.valued ?? []).includes(name)) return a.includes('=') ? 0 : 1;
  return (spec.long ?? []).some((l) => (l.endsWith('=') ? a.startsWith(l) : a === l)) ? 0 : false;
}

// A -x flag or run of them: the extra arguments it takes, or false when not allowed.
function shortFlag(spec, a, st) {
  const flag = a.slice(0, 2);
  if (spec.numeric && /^-\d+$/.test(a)) return 0;
  if ((spec.valued ?? []).includes(flag)) {
    if (flag === '-e') st.pattern = true;
    return a.length === 2 ? 1 : 0;
  }
  return [...a.slice(1)].every((ch) => (spec.short ?? '').includes(ch)) ? 0 : false;
}

// A command substitution ($( or a backtick outside single quotes), a process
// substitution (<( or >() or an arithmetic expansion.
function substitutes(step) {
  const s = String(step);
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (isSubstitution(s, i, quote)) return true;
    quote = nextQuote(ch, quote);
  }
  return false;
}

function nextQuote(ch, quote) {
  if (ch === '"') return quote ? null : '"';
  return ch === "'" && !quote ? "'" : quote;
}

function isSubstitution(s, i, quote) {
  const ch = s[i];
  return ch === '`' || (ch === '$' && s[i + 1] === '(') || (!quote && (ch === '<' || ch === '>') && s[i + 1] === '(');
}

// The characters of a step outside quotes.
function unquoted(step) {
  const out = [];
  let quote = null;
  for (const ch of String(step)) {
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else out.push(ch);
  }
  return out;
}

// A step's words, quotes removed: what argsFit reads.
function shellWords(step) {
  const st = { out: [], cur: null, quote: null };
  for (const ch of String(step)) wordChar(st, ch);
  if (st.cur !== null) st.out.push(st.cur);
  return st.out;
}

function wordChar(st, ch) {
  if (st.quote) {
    if (ch === st.quote) st.quote = null;
    else st.cur += ch;
  } else if (ch === "'" || ch === '"') {
    st.quote = ch;
    st.cur ??= '';
  } else if (/\s/.test(ch)) {
    if (st.cur !== null) st.out.push(st.cur);
    st.cur = null;
  } else st.cur = (st.cur ?? '') + ch;
}

// A step that writes a file: an output redirection to anything but /dev/null
// or a descriptor copy, a tee, or an -o or --output option (sort -uo,
// git diff --output=). Read wide on purpose: a false write only costs a held.
export function writesFile(step) {
  return outputTargets(step).length > 0 || /(^|\s)tee(\s|$)/.test(step) || /(^|\s)(--output(=|\s|$)|-[A-Za-z]*o[A-Za-z]*(\s|$))/.test(step);
}

// Each rule's fix signals, compiled: params.fix_signals maps a rule id to
// regexes, each tried on the retry's whole command and on each segment. One
// that starts with ! is a veto: a known way around the rule, so any command
// that succeeds in the window and matches it makes the block a false alarm.
export function fixSignals(map = {}) {
  return new Map(Object.entries(map).map(([rule, list]) => [rule, (list ?? []).map((s) => (s.startsWith('!') ? { veto: true, re: new RegExp(s.slice(1)) } : { veto: false, re: new RegExp(s) }))]));
}
