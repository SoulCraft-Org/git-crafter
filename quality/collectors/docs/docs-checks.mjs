// What the Documentation collector checks outside the doc set's text: folder
// coverage, runbooks, npm scripts and the content lint (docs.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { gitIgnored } from './docs-git.mjs';
import { expandGlobs } from './docs-files.mjs';
import { FENCE, LIST, parseMarkdown } from './docs-markdown.mjs';
import { escapeRe, firstLine, hasReadme, isFile, round1, sum, TARGETS } from './docs-util.mjs';

// ---- complete: folders and runbooks --------------------------------------

// Top-level folders a newcomer can find explained: a README inside, or a row
// in the folder map section of params.folder_map.doc. Dot folders are tool
// config and git-ignored folders are build output, so neither counts.
export function folderCoverage(root, spec, tree, ok, cnc, byAsc) {
  const id = 'docs.folder_coverage';
  if (!spec || typeof spec.doc !== 'string' || typeof spec.heading !== 'string') {
    return cnc(id, `${TARGETS} needs params.folder_map with doc and heading`, TARGETS);
  }
  const source = `top-level folders (not dot or git-ignored) with a README, or a row under "${spec.heading}" in ${spec.doc}`;
  let text;
  try { text = fs.readFileSync(path.join(root, spec.doc), 'utf8'); } catch (e) {
    return cnc(id, `${spec.doc} is missing or unreadable (${e.message})`, source);
  }
  const rows = folderMapRows(text, spec.heading);
  if (!rows) return cnc(id, `${spec.doc} has no "${spec.heading}" heading`, source);
  if (!tree.ok) return cnc(id, `top-level folders need git check-ignore: ${tree.reason}`, source);
  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  const ignored = gitIgnored(root, dirs.map((d) => `${d}/`));
  if (ignored.problem) return cnc(id, ignored.problem, source);
  const folders = dirs.filter((d) => !ignored.set.has(d));
  if (!folders.length) return cnc(id, `${root} has no top-level folder to explain`, source);
  const how = (readme, row) => (readme && row ? 'README and folder map' : readme ? 'README' : row ? 'folder map' : 'neither');
  const detail = folders.map((d) => {
    const readme = hasReadme(path.join(root, d));
    return { label: `${d}/ (${how(readme, rows.has(d))})`, value: readme || rows.has(d) ? 1 : 0, unit: '' };
  });
  ok(id, round1((100 * sum(detail.map((d) => d.value))) / folders.length), detail.sort(byAsc), source);
}

// GitHub's community health files: each of params.community_files is present
// when any of its globs matches a file.
export function communityFiles(root, list, skip, ok, cnc, byAsc) {
  const id = 'docs.community_files';
  const shaped = Array.isArray(list) && list.length > 0
    && list.every((f) => f && typeof f.name === 'string' && Array.isArray(f.globs) && f.globs.length > 0 && f.globs.every((g) => typeof g === 'string'));
  if (!shaped) return cnc(id, `${TARGETS} needs params.community_files, a list of { name, globs }`, TARGETS);
  try { fs.readdirSync(root); } catch (e) {
    return cnc(id, `${root} is missing or unreadable (${e.message})`, 'params.community_files');
  }
  const detail = list.map((f) => {
    const found = expandGlobs(root, f.globs, skip)[0];
    return { label: `${f.name} (${found ?? 'missing'})`, value: found ? 1 : 0, unit: '' };
  });
  ok(id, round1((100 * sum(detail.map((d) => d.value))) / list.length), detail.sort(byAsc),
    `each of ${list.length} community health files (params.community_files) at any of its paths`);
}

// The first path segment of a line, list item or table row: `src/` -> src.
function rowName(line) {
  const first = line.replace(/^\s*\|?\s*/, '').replace(LIST, '').split(/[\s|]/)[0].replace(/[`*]/g, '');
  return /^([\w.-]+)\/(?:[\w./-]*)$/.exec(first)?.[1] ?? null;
}

function trackFence(st, f) {
  if (f && (!st.fence || f[1][0] === st.fence[0])) st.fence = st.fence ? null : f[1];
}

function addRow(st, line) {
  const name = rowName(line);
  if (name) st.rows.add(name);
}

// One line of the doc against the section being read; 'end' when the next
// heading of the same or a higher level closes it.
function mapLine(st, line, heading) {
  const f = FENCE.exec(line);
  trackFence(st, f);
  const h = st.fence || f ? null : /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (h && st.rows && h[1].length <= st.level) return 'end';
  if (isStart(st, h, heading)) {
    st.rows = new Set();
    st.level = h[1].length;
  } else if (st.rows && !f) addRow(st, line);
  return null;
}

const isStart = (st, h, heading) => Boolean(h) && !st.rows && h[2].trim().toLowerCase() === heading.toLowerCase();

// The first path segment of each row in the section under `heading`: the
// first word of a line, a list item or a table row, inside a fence or not.
export function folderMapRows(text, heading) {
  const st = { level: 0, fence: null, rows: null };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (mapLine(st, line, heading) === 'end') break;
  }
  return st.rows;
}

// docs.runbooks_verified: the percent of runbooks (params.runbooks) whose prose dates a params.verified phrase.
export function runbooksVerified(root, globs, phrase, notDocs, skip, ok, cnc, byAsc) {
  const id = 'docs.runbooks_verified';
  if (!Array.isArray(globs) || typeof phrase !== 'string') return cnc(id, `${TARGETS} needs params.runbooks and params.verified`, TARGETS);
  const source = `"${phrase} <date>" outside code in each of ${globs.join(', ')}, less params.doc_set_left_out`;
  const books = expandGlobs(root, [...globs, ...notDocs], skip);
  if (!books.length) return cnc(id, `no file under ${root} matches params.runbooks`, source);
  const re = datedPhrase(phrase);
  const detail = [];
  for (const book of books) {
    let prose;
    try { ({ prose } = parseMarkdown(fs.readFileSync(path.join(root, book), 'utf8'))); } catch (e) {
      return cnc(id, `could not read ${book} (${e.message})`, source);
    }
    const dates = prose.flatMap(({ text }) => [...text.matchAll(re)].map((m) => m[2])).sort();
    const last = dates.at(-1);
    detail.push({ label: `${book} (${last ?? 'no date'})`, value: last ? 1 : 0, unit: '' });
  }
  ok(id, round1((100 * sum(detail.map((d) => d.value))) / books.length), detail.sort(byAsc), source);
}

// ---- current and correct: what a doc names --------------------------------

// "<phrase> 2026-11-02", allowing bold, a colon or "on" between them.
// Group 1 is the phrase as written, group 2 the date.
export function datedPhrase(phrase) {
  return new RegExp(`\\b(${escapeRe(phrase)})[\\s:*_]*(?:on\\s+)?(\\d{4}-\\d{2}-\\d{2})\\b`, 'gi');
}

// Words of a code span or code line that read as repo paths.
export function pathTokens(text) {
  const refs = [];
  for (const raw of text.split(/[\s"'=(),]+/)) {
    const ref = raw.replace(/::.*$/, '').replace(/(:\d+(-\d+)?)+$/, '').replace(/#.*$/, '').replace(/[.,;:)\]]+$/, '');
    if (!ref || /[*?<>{}$~[\]|\\]|\.\.\.|:\/\//.test(ref) || /^[-/]|^\.\.?\//.test(ref)) continue;
    refs.push(ref);
  }
  return refs;
}

const NPM_RUN = new Set(['run', 'run-script', 'rum', 'urn']);
const NPM_BUILTIN = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' };
const WS_FLAGS = ['-w', '--workspace', '--prefix', '-C'];

// A flag that is not a workspace flag: -w=x, -ws, --if-present, or any other
// dash word (ignored). True when `t` was one.
function applyFlag(st, t) {
  const eq = /^(?:-w|--workspace|--prefix)=(.+)$/.exec(t);
  if (eq) st.ws = eq[1];
  else if (t === '-ws' || t === '--workspaces') st.ws = '*';
  else if (t === '--if-present') st.optional = true;
  else return t.startsWith('-');
  return true;
}

// The first word is the npm command; a run command takes the script name next.
// False when this is no run command, so the rest is not read.
function positional(st, t) {
  if (st.cmd) {
    st.name = t;
    return true;
  }
  st.cmd = t;
  if (NPM_BUILTIN[t]) st.name = NPM_BUILTIN[t];
  else if (!NPM_RUN.has(t)) return false;
  return true;
}

function parseNpmArgs(toks) {
  const st = { ws: null, cmd: null, name: null, optional: false };
  for (let i = 0; i < toks.length && !st.name; i++) {
    const t = toks[i];
    if (t === '--') break;
    if (WS_FLAGS.includes(t)) st.ws = toks[++i] ?? null;
    else if (!applyFlag(st, t) && !positional(st, t)) break;
  }
  return st;
}

// Every npm script one line of code invokes, with the workspace it names
// (-w, --workspace, --prefix; '*' for -ws). --if-present opts out of the check.
export function npmScripts(text) {
  const found = [];
  for (const m of text.matchAll(/(?:^|[^\w@/.-])npm\s+([^;&|)`#\n]*)/g)) {
    const { name, ws, optional } = parseNpmArgs(m[1].trim().split(/\s+/));
    if (name && !optional && /^[\w:.@/-]+$/.test(name)) found.push({ name, ws });
  }
  return found;
}

// The scripts npm can run from the root: the root package.json and each of
// its workspaces, keyed by workspace folder and package name.
export function npmManifests(root, skip) {
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
  let pkg;
  try { pkg = read('package.json'); } catch (e) {
    return { ok: false, reason: `package.json at the repo root is missing or unreadable (${e.message})` };
  }
  const rootScripts = new Set(Object.keys(pkg.scripts || {}));
  const all = new Set(rootScripts);
  const byWorkspace = new Map([['.', rootScripts]]);
  const files = ['package.json'];
  const patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
  for (const rel of expandGlobs(root, patterns.map((w) => `${w.replace(/\/$/, '')}/package.json`), skip)) {
    let ws;
    try { ws = read(rel); } catch (e) {
      return { ok: false, reason: `workspace ${rel} is unreadable (${e.message})` };
    }
    const scripts = new Set(Object.keys(ws.scripts || {}));
    byWorkspace.set(path.posix.dirname(rel), scripts);
    if (typeof ws.name === 'string') byWorkspace.set(ws.name, scripts);
    for (const s of scripts) all.add(s);
    files.push(rel);
  }
  return { ok: true, all, byWorkspace, files };
}

// ---- content lint ---------------------------------------------------------

// Why the lint run is no result: it did not start, or exited with a code
// other than 0 and 1. null when its output can be read.
function lintProblem(r, spec) {
  if (r.error) return `could not run ${spec.interpreter} (${r.error.code || r.error.message}); install it`;
  if (r.status !== 0 && r.status !== 1) return `the lint exited ${r.status ?? r.signal} (2 usage error, 3 could not check): ${firstLine(r.stderr) || firstLine(r.stdout)}`;
  return null;
}

function lintDetail(stdout, checked, total) {
  const per = new Map();
  for (const line of stdout.split('\n')) {
    const f = /^(.+?):\d+: WARN \[/.exec(line);
    if (f) per.set(f[1], (per.get(f[1]) || 0) + 1);
  }
  return [
    { label: 'docs checked', value: checked, unit: 'docs' },
    { label: 'docs outside lint scope', value: total - checked, unit: 'docs' },
    ...[...per].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
  ];
}

// params.lint: { interpreter, script, args, scope }. "{root}" in args is the
// repo root. The lint prints "path:line: FAIL [" or "WARN [" per finding and
// "N file(s) checked, X FAIL, Y WARN", and exits 0, 1, 2 or 3.
export function lint(root, docs, spec, ok, cnc) {
  const id = 'docs.lint_warn';
  const both = (reason, source = TARGETS) => cnc(id, reason, source);
  if (!spec || typeof spec.interpreter !== 'string' || typeof spec.script !== 'string') {
    return both(`${TARGETS} has no params.lint { interpreter, script, args, scope }; this repo names no content lint`);
  }
  const args = Array.isArray(spec.args) ? spec.args.map(String) : [];
  const source = `${[spec.interpreter, spec.script, ...args].join(' ').replaceAll('{root}', '.')} <${docs.length} docs>`;
  if (!isFile(path.join(root, spec.script))) return both(`${spec.script} is missing; restore it from git`, source);
  const r = spawnSync(spec.interpreter, [spec.script, ...args.map((a) => a.replaceAll('{root}', root)), ...docs], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 16 << 20 });
  const bad = lintProblem(r, spec);
  if (bad) return both(bad, source);
  const m = /(\d+) file\(s\) checked, (\d+) FAIL, (\d+) WARN/.exec(r.stdout);
  if (!m) return both('the lint printed no summary line "N file(s) checked, X FAIL, Y WARN"', source);
  const checked = Number(m[1]);
  if (!checked) return both(`none of the ${docs.length} docs is in the lint's scope${spec.scope ? ` (${spec.scope})` : ''}`, source);
  ok(id, Number(m[3]), lintDetail(r.stdout, checked, docs.length), source);
}
