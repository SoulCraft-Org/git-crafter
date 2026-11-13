// Simplicity and drift: what bloats or drifts in a repo and the Claude
// instructions it runs under. Restated, Broken and Drift sit on the
// Instructions tab; Undated is about docs, so it sits on Documentation.
//
//   Restated  one rule sentence in two or more always-loaded or rule files
//   Broken    a file named in a rule, a CLAUDE.md or a memory note that is gone
//   Drift     installed rules and guards that differ from their Git Crafter
//             source (the sync tool's status)
//   Undated   a figure in a living doc with no read date, or one older than
//             params.stale_days
//
// The rows this group shares with other tabs keep their own ids, one
// definition each: always-loaded tokens are claude.instruction_tokens and the
// memory index is instructions.memory_index_tokens (collectors/instructions.mjs),
// living docs' dead paths are docs.dead_paths, and guard false alarms and guard
// blocks are blockers.*; review rounds are tokens.review_fix_rounds_per_pr.
//
// Read-only and `local` mode only: rules and memory live on the machine that
// ran the sessions. Instruction and memory files are read for sentences,
// paths and flags; the output holds counts and file names, never their text.
// A part that cannot be read is could_not_check, never 0.
//
// Settings are params on quality/targets/simplicity.json, each with a
// default: projects_dir (~/.claude/projects), project_match (the repo's own project folder), managed_claude_md
// (the platform's managed policy CLAUDE.md), code_os_checkout (the Git Crafter
// checkout this collector runs from), sync_entry (the sync tool's entry for
// ~/.claude), not_living (doc paths that record the past on purpose) and
// stale_days. The doc set (doc_set, doc_set_left_out, skip_dirs) is the Docs
// tab's, from docs.json when the engine passes every file's params
// (allParams), else from this file's.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { managedClaudeMd, PROJECTS_DIR, projectMatch, resolvePath } from '../lib/paths.mjs';
import { expandGlobs } from '../docs/docs.mjs';
import { redact } from '../lib/redact.mjs';

export const area = 'simplicity';

const TARGETS = JSON.parse(fs.readFileSync(new URL('../../targets/simplicity.json', import.meta.url), 'utf8'));
export const metricIds = TARGETS.map((t) => t.id);
// The template's own params, merged as the engine merges a file's: the
// defaults for a bare call. The engine passes the repo's merged params.
const TEMPLATE = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

// The Git Crafter checkout this file runs from: quality/collectors/ is two below it.
const KIT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CI_REASON = 'rules and memory live on the machine that ran the sessions; refreshed by a --local collect there';
const DAY = 864e5;
const MIN_WORDS = 8;
// The sync tool, by its name since the rename and before it.
const SYNC_TOOLS = ['tools/code_os_sync.py', 'tools/claude_os_sync.py'];

const run = promisify(execFile);
const defaultExec = async (cmd, args, opts = {}) => (await run(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...opts })).stdout;

// Every metric of this tab, with each home path and account name taken out
// of the text (redact.mjs).
export async function collect(opts = {}) {
  return redact(await gather(opts), opts.home);
}

async function gather(opts = {}) {
  const { mode, params = TEMPLATE, root = '.' } = opts;
  const all = (reason) => Object.fromEntries(metricIds.map((id) => [id, { could_not_check: reason, source: 'quality/collectors/simplicity/simplicity.mjs' }]));
  if (mode !== 'local') return all(CI_REASON);
  const PROJECT_MATCH = String(params.project_match || projectMatch(root));
  // A match with no letter or digit (a root of /) is in every folder's name.
  if (!/[A-Za-z0-9]/.test(PROJECT_MATCH)) return all(`the project match "${PROJECT_MATCH}" would read every project folder; set params.project_match on quality/targets/simplicity.json`);
  const out = {};
  const ctx = makeContext(opts, PROJECT_MATCH, out);
  restatedRules(ctx);
  brokenRefs(ctx);
  await staleNotes(ctx);
  await copyDrift(ctx);
  undatedFigures(ctx);
  return Object.fromEntries(metricIds.map((id) => [id, out[id] ?? { could_not_check: 'collector produced no value', source: 'quality/collectors/simplicity/simplicity.mjs' }]));
}

// What every part reads: settings with their defaults, the files loaded, and
// val and cnc, which write a metric's value or reason into `out`.
function makeContext({ root = '.', home = os.homedir(), projectsDir, managedPath, codeOs, exec = defaultExec, now = new Date(), params = TEMPLATE, allParams, docParams }, PROJECT_MATCH, out) {
  const p = params;
  const MANAGED_CLAUDE_MD = String(p.managed_claude_md || managedClaudeMd());
  managedPath ??= MANAGED_CLAUDE_MD;
  codeOs ??= p.code_os_checkout ? resolvePath(p.code_os_checkout, { home, root }) : KIT_ROOT;
  const readAt = now.toISOString();
  const dir = projectsDir ?? resolvePath(p.projects_dir || PROJECTS_DIR, { home, root });
  const { loaded, notes } = readSources({ dir, PROJECT_MATCH, home, root, managedPath });
  return {
    p,
    root,
    home,
    exec,
    now,
    allParams,
    docParams,
    codeOs,
    loaded,
    notes,
    MANAGED_CLAUDE_MD,
    STALE_DAYS: Number(p.stale_days ?? 30),
    NOT_LIVING: (p.not_living ?? []).map((re) => new RegExp(re, 'i')),
    val: (id, value, source, detail) => {
      out[id] = { value, ...(detail ? { detail } : {}), source, read_at: readAt };
    },
    cnc: (id, reason, source) => {
      out[id] = { could_not_check: reason, source };
    },
  };
}

// The always-loaded files, and the notes memory keeps.
function readSources({ dir, PROJECT_MATCH, home, root, managedPath }) {
  const memoryDir = attempt(() => {
    const d = fs.readdirSync(dir).find((n) => n.endsWith(PROJECT_MATCH));
    if (!d) throw new Error(`no project folder ends with ${PROJECT_MATCH}`);
    return path.join(dir, d, 'memory');
  });
  const rulesDir = path.join(home, '.claude', 'rules');
  const loaded = attempt(() =>
    [
      ['managed CLAUDE.md', managedPath],
      ['user CLAUDE.md', path.join(home, '.claude', 'CLAUDE.md')],
      ...(fs.existsSync(rulesDir) ? fs.readdirSync(rulesDir).filter((f) => f.endsWith('.md')).sort().map((f) => [`rules/${f}`, path.join(rulesDir, f)]) : []),
      ['repo CLAUDE.md', path.join(root, 'CLAUDE.md')],
      ...(memoryDir.error ? [] : [['memory index', path.join(memoryDir, 'MEMORY.md')]]),
    ]
      .filter(([, p]) => fs.existsSync(p))
      .map(([label, p]) => ({ label, path: p, text: fs.readFileSync(p, 'utf8') })),
  );
  const notes = memoryDir.error
    ? memoryDir
    : attempt(() => fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort().map((f) => ({ label: `memory/${f}`, path: path.join(memoryDir, f), text: fs.readFileSync(path.join(memoryDir, f), 'utf8') })));
  return { loaded, notes };
}

function restatedRules(ctx) {
  const { val, cnc, loaded, MANAGED_CLAUDE_MD } = ctx;
    const restateSource = `sentences of ${MIN_WORDS} or more words, markdown and case ignored, in ${MANAGED_CLAUDE_MD}, ~/.claude/CLAUDE.md, ~/.claude/rules/*.md, the repo CLAUDE.md and the memory index`;
    if (loaded.error || !loaded.length) cnc('simplicity.restated_rules', loaded.error ?? 'no always-loaded file was found', restateSource);
    else {
      const where = new Map();
      for (const f of loaded) for (const s of sentences(f.text)) where.set(s, new Set([...(where.get(s) ?? []), f.label]));
      const restated = [...where.values()].filter((files) => files.size > 1);
      const byFiles = new Map();
      for (const files of restated) {
        const key = [...files].sort().join(' + ');
        byFiles.set(key, (byFiles.get(key) ?? 0) + 1);
      }
      val('simplicity.restated_rules', restated.length, restateSource, [...byFiles].sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, value: n, unit: 'sentences' })));
    }
}

function brokenRefs(ctx) {
  const { val, cnc, loaded, notes, root, codeOs, home } = ctx;
    const roots = [root, codeOs, path.join(home, '.claude')];
    const refSource = 'paths in code spans and markdown links of ~/.claude/rules/*.md, the repo CLAUDE.md and the memory, resolved from home, the naming file\'s folder, the repo and the Git Crafter checkout; a path in a never or do-not line, or named as another\'s (another-repo\'s `x`), is left out; so is the managed CLAUDE.md, which may name other accounts\' paths and which an administrator owns; living docs are docs.dead_paths on the Docs tab';
    if (loaded.error || notes.error || !loaded.length) cnc('simplicity.broken_refs', loaded.error ?? notes.error ?? 'no always-loaded file was found', refSource);
    else {
      const files = [...loaded.filter((f) => f.label !== 'managed CLAUDE.md'), ...notes];
      const broken = files.flatMap((f) => fileRefs(f.text).filter((ref) => !resolves(ref, f.path, roots, home)).map((ref) => ({ file: f.label, ref })));
      const seen = new Set();
      const unique = broken.filter((b) => !seen.has(`${b.file} ${b.ref}`) && seen.add(`${b.file} ${b.ref}`));
      val('simplicity.broken_refs', unique.length, refSource, unique.map((b) => ({ label: `${b.file}: ${b.ref}`, value: 1, unit: 'references' })));
    }
}

async function staleNotes(ctx) {
  const { val, cnc, notes, root, codeOs, home, exec } = ctx;
    const roots = [root, codeOs, path.join(home, '.claude')];
    const noteSource = 'memory notes (not the index): paths as in simplicity.broken_refs, and --flags of commands the repo ships, in code spans, that git grep finds in neither the repo nor the Git Crafter checkout';
    if (notes.error) cnc('simplicity.memory_stale_refs', notes.error, noteSource);
    else if (!fs.existsSync(codeOs)) cnc('simplicity.memory_stale_refs', `the Git Crafter checkout (${codeOs}) is missing, so a flag cannot be looked up there`, noteSource);
    else {
      const stale = [];
      for (const n of notes) {
        const paths = fileRefs(n.text).filter((ref) => !resolves(ref, n.path, roots, home));
        const flags = [];
        for (const flag of noteFlags(n.text)) if (!(await flagExists(flag, [root, codeOs], exec))) flags.push(flag);
        if (paths.length + flags.length) stale.push({ label: n.label, value: paths.length + flags.length, unit: 'names' });
      }
      val('simplicity.memory_stale_refs', stale.length, noteSource, stale);
    }
}

async function copyDrift(ctx) {
  const { val, cnc, codeOs, exec, p } = ctx;
    const entry = String(p.sync_entry || 'user-claude');
    const tool = SYNC_TOOLS.find((f) => fs.existsSync(path.join(codeOs, f))) ?? SYNC_TOOLS[0];
    const driftSource = `the Git Crafter checkout: ${tool} status ${entry}, every file not in-sync`;
    try {
      // Exit 1 is the tool's "something is not in-sync", with the same report.
      const status = await exec('python3', ['-I', path.join(codeOs, tool), 'status', entry]).catch((err) => (err.code === 1 && err.stdout ? err.stdout : Promise.reject(err)));
      const lines = status.split('\n').map((l) => /^\s+(\S+)\s+(\S.*)$/.exec(l)).filter(Boolean);
      if (!lines.length) throw new Error('no file lines in its output');
      const off = lines.filter((m) => m[1] !== 'in-sync');
      const byStatus = Object.entries(Object.groupBy(off, (m) => m[1])).map(([status, list]) => ({ label: status, value: list.length, unit: 'copies' }));
      val('simplicity.copy_drift', off.length, `${driftSource}; ${lines.length} files`, byStatus);
    } catch (err) {
      cnc('simplicity.copy_drift', `sync status: ${firstLine(err)}`, driftSource);
    }
}

function undatedFigures(ctx) {
  const { val, cnc, root, now, p, STALE_DAYS, NOT_LIVING, allParams } = ctx;
    let { docParams } = ctx;
    const figureSource = `the Docs tab's doc set (params.doc_set on quality/targets/docs.json, less its doc_set_left_out, skipping its skip_dirs) less params.not_living; a figure is a percent, money, a comma-grouped number or a number with a unit, outside code; its sentence or table row needs a YYYY-MM-DD within ${STALE_DAYS} days`;
    try {
      // The Docs tab's own doc set: its globs, less its left-out files, never
      // walking its skip_dirs (node_modules among them).
      // docs.json's doc set when the engine passes every file's params, else this file's.
      docParams ??= allParams?.['docs.json']?.doc_set ? allParams['docs.json'] : p;
      if (!Array.isArray(docParams?.doc_set)) throw new Error('no params.doc_set');
      const globs = [...docParams.doc_set, ...(docParams.doc_set_left_out ?? []).map((l) => `!${l.glob}`)];
      const skip = new Set(['.git', ...(docParams.skip_dirs ?? [])]);
      const docs = expandGlobs(root, globs, skip).filter((rel) => !NOT_LIVING.some((re) => re.test(rel)));
      // No doc read is no count, never 0 figures.
      if (!docs.length) throw new Error('the doc set matches no living doc');
      let undated = 0;
      let old = 0;
      const perDoc = [];
      for (const rel of docs) {
        const c = figureDates(fs.readFileSync(path.join(root, rel), 'utf8'), now.getTime() - STALE_DAYS * DAY);
        undated += c.undated;
        old += c.old;
        if (c.undated + c.old) perDoc.push({ label: rel, value: c.undated + c.old, unit: 'figures' });
      }
      val('simplicity.undated_figures', undated + old, `${figureSource}; ${docs.length} docs`, [
        { label: 'no read date', value: undated, unit: 'figures' },
        { label: `read over ${STALE_DAYS} days ago`, value: old, unit: 'figures' },
        ...perDoc.sort((a, b) => b.value - a.value),
      ]);
    } catch (err) {
      cnc('simplicity.undated_figures', `could not read the living docs (${firstLine(err)})`, figureSource);
    }
}

function attempt(read) {
  try {
    return read();
  } catch (err) {
    return { error: `could not read (${err.code ?? firstLine(err)})` };
  }
}

function firstLine(err) {
  return String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 160);
}

const withoutFences = (text) => text.replace(/^```[\s\S]*?^```/gm, '');

// Sentences of MIN_WORDS words or more, as one comparable form: markdown
// marks, case and closing punctuation dropped, spaces collapsed. A table row
// splits into its cells.
export function sentences(text) {
  const out = new Set();
  for (const line of withoutFences(text).split('\n')) {
    for (const cell of line.split('|')) {
      const plain = cell.replace(/^\s*(#+|[-*>]|\d+\.)\s+/, '').replace(/[`*_]/g, '');
      for (const s of plain.split(/(?<=[.!?])\s+/)) {
        const norm = s.toLowerCase().replace(/\s+/g, ' ').replace(/[.!?:;,]+$/, '').trim();
        if (norm.split(' ').length >= MIN_WORDS) out.add(norm);
      }
    }
  }
  return out;
}

const FORBIDS = /\bnever\b|\bdo not\b|\bdon't\b/i;
// File paths a text names: code spans and markdown link targets with a slash,
// less URLs, globs and placeholders. A bare file name is too ambiguous to
// check. A path in a line that forbids it ("never create `x`") is meant to be
// missing, and one named as another's ("another-repo's `x`") lives elsewhere.
export function fileRefs(text) {
  const refs = new Set();
  for (const r of rawRefs(withoutFences(text))) {
    const ref = r.replace(/#.*$/, '').replace(/(:\d+(-\d+)?)+$/, '').replace(/[.,;:]+$/, '');
    if (isPathRef(ref)) refs.add(ref);
  }
  return [...refs];
}

// Code spans and link targets, less those on a line that forbids the path or
// right after "another's".
function rawRefs(body) {
  const raw = [];
  for (const m of body.matchAll(/`([^`\n]+)`|\]\(([^)\s]+)\)/g)) {
    const lineStart = body.lastIndexOf('\n', m.index) + 1;
    const lineEnd = body.indexOf('\n', m.index);
    const before = body.slice(lineStart, m.index);
    if (FORBIDS.test(body.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)) || /[\w.-]+'s\s*$/.test(before)) continue;
    raw.push((m[1] ?? m[2]).trim());
  }
  return raw;
}

function isPathRef(ref) {
  if (!ref.includes('/') || /:\/\/|[*?<>{}$|\\]|\.\.\./.test(ref) || /\s/.test(ref.replace(/^(~\/|\/)[^`]*$/, '')) || /^[-@]/.test(ref)) return false;
  // owner/repo, not a path
  return !(/^\w[\w.-]*\/[\w.-]+$/.test(ref) && !/\.\w{1,5}$/.test(ref) && !ref.endsWith('/'));
}

// A reference resolves when it exists from home (~/), as an absolute path, or
// from the naming file's folder or any root, provided the root holds its
// first segment, so a path in another repo is never called broken here.
export function resolves(ref, from, roots, home) {
  if (ref.startsWith('~/')) return fs.existsSync(path.join(home, ref.slice(2)));
  // A site route such as /community/ is no file: only a path whose first
  // folder exists at the root of the disk is checked.
  if (ref.startsWith('/')) return !fs.existsSync(`/${ref.split('/')[1]}`) || fs.existsSync(ref);
  const first = ref.replace(/^\.\//, '').split('/')[0];
  // In a worktree .git is a pointer file; git's own folders are not docs' business.
  if (first === '.git') return true;
  const bases = [path.dirname(from), ...roots].filter((b) => fs.existsSync(path.join(b, first)));
  if (!bases.length) return true;
  return bases.some((b) => fs.existsSync(path.join(b, ref)));
}

// A code span whose flag this repo can vouch for: a bare flag, one passed
// through after ` -- `, or a command that names a script file.
const OWN_SPAN = /^--|\s--\s|[\w./-]+\.(?:mjs|js|ts|py|sh)\b/;

// The command-line flags (`--name`) a text names inside code spans, the first
// of each OWN_SPAN. A flag of an outside program (`gh issue create --type
// Bug`) is that program's to keep: git grep here cannot say whether it exists.
export function noteFlags(text) {
  const spans = [...withoutFences(text).matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim()).filter((s) => OWN_SPAN.test(s));
  return [...new Set(spans.flatMap((s) => s.match(/--[a-z][\w-]+/) ?? []))];
}

async function flagExists(flag, roots, exec) {
  for (const root of roots) {
    try {
      await exec('git', ['-C', root, 'grep', '-q', '-F', '-e', flag]);
      return true;
    } catch {
      // git grep exits 1 for no match; a missing checkout is no match too.
    }
  }
  return false;
}

// Figures outside code, each judged by the newest YYYY-MM-DD in its sentence
// (a table row is one sentence): none is undated, one before `since` is old.
// A sentence that labels its figures a goal needs no date: Git Crafter's writing
// rule (rules/writing-and-gates.md, "Attribute every figure") takes a source
// or a goal label.
const GOAL_LABEL = /\bgoals?\b/i;
const FIGURE = /(?<![\w.$-])(\$\d[\d,.]*|\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s?(?:%|percent|KB|MB|GB|ms|seconds|minutes|hours|days|tokens|bytes|lines|PRs|runs|calls|sessions|issues|files|blocks|USD)(?![\w-]))/g;
const DATE = /\b(20\d\d-\d\d-\d\d)\b/g;
// A table row is one unit. A list item opens a unit that its wrapped
// lines continue, as a paragraph's do, so a date on its first line covers
// a figure on its second.
function figureUnits(text) {
  const units = [];
  let para = [];
  const flush = () => {
    if (para.length) units.push(para.join(' '));
    para = [];
  };
  for (const line of withoutFences(text).split('\n')) {
    if (/^\s*\|/.test(line) || !line.trim()) {
      flush();
      if (line.trim()) units.push(line);
    } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      flush();
      para.push(line.trim());
    } else para.push(line.trim());
  }
  flush();
  return units;
}

// Counts a text's figures with no date beside them, and those dated before `since`.
export function figureDates(text, since) {
  let undated = 0;
  let old = 0;
  for (const unit of figureUnits(text)) {
    const parts = /^\s*\|/.test(unit) ? [unit] : unit.split(/(?<=[.!?])\s+/);
    for (const s of parts) {
      const prose = s.replace(/`[^`]*`/g, '');
      const figures = prose.match(FIGURE)?.length ?? 0;
      if (!figures || GOAL_LABEL.test(prose)) continue;
      const dates = [...prose.matchAll(DATE)].map((m) => Date.parse(`${m[1]}T00:00:00Z`)).filter(Number.isFinite);
      if (!dates.length) undated += figures;
      else if (Math.max(...dates) < since) old += figures;
    }
  }
  return { undated, old };
}
