// The docs gate: fails a pull request that makes a doc worse on the
// Documentation tab's three certain checks, each doc against its own copy on
// the base branch (pages.yml docs-gate, on any pull request that touches a
// doc). A doc already over on the base branch passes until it gets worse.
//
//   docs.over_read_goal  a doc that crosses the reading goal, in words
//   docs.text_only       a doc that drops under the visual bar, in percent
//   docs.markup_faults   a doc with more heading and image faults than before
//
// Both sides are computed here, from git: the base's text is read with git
// show at the merge base, so no committed data can be stale. The doc set,
// the goal and the bar come from the Documentation collector's own params,
// the template's under the repo's (config "targets"), through overlay.mjs.
// No package is loaded, so the job needs no npm ci.
//
//   node quality/docs-gate.mjs --base <sha> [--config config/quality.json]
//
// Exit 0: no doc got worse, or the gate could not verify (git or params
// trouble, a ::warning:: says which). Exit 1: a doc got worse; a ::error::
// names each with its old and new value and the goal. Exit 2: usage error.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docSetSpec } from './collectors/docs/docs.mjs';
import { expandGlobs } from './collectors/docs/docs-files.mjs';
import { parseMarkdown } from './collectors/docs/docs-markdown.mjs';
import { markupFaults, visualShare } from './collectors/docs/docs-metrics.mjs';
import { overlayTargets, readTargetFiles } from './overlay.mjs';

const QUALITY = fileURLToPath(new URL('.', import.meta.url));

// The Documentation collector's params, the template's with the repo's
// targets folder (config "targets") laid over them.
function docsParams(root, configFile) {
  const config = configFile ? JSON.parse(readFileSync(resolve(root, configFile), 'utf8')) : {};
  const repoDir = config.targets ? resolve(root, config.targets) : null;
  const { params } = overlayTargets(readTargetFiles(join(QUALITY, 'targets')), readTargetFiles(repoDir));
  return params['docs.json'] ?? {};
}

// The goal, the bar and the alt text limit from params, or the problem.
function gateRules(params) {
  const wpm = Number(params.words_per_minute);
  const minutes = Number(params.minutes_goal);
  const bar = Number(params.text_only_below);
  const altMax = Number(params.alt_max_chars);
  if (!(wpm > 0 && minutes > 0 && bar > 0 && altMax > 0)) {
    return { problem: 'the docs params need words_per_minute, minutes_goal, text_only_below and alt_max_chars' };
  }
  return { words: minutes * wpm, minutes, wpm, bar, altMax };
}

// One doc's text on the three checks.
function measure(text, rules) {
  const p = parseMarkdown(text);
  return { words: p.words, visual: visualShare(p), faults: markupFaults(p, rules.altMax) };
}

const was = (before, show) => (before ? show(before) : 'new');

// A doc that crosses the reading goal; one already over stays allowed.
function readCheck(before, after, r) {
  if (after.words <= r.words || (before && before.words > r.words)) return null;
  return `${was(before, (b) => b.words)} to ${after.words} words, over the ${r.words}-word reading goal (${r.minutes} minutes at ${r.wpm} words a minute)`;
}

// A doc that drops under the visual bar; one already under stays allowed.
function visualCheck(before, after, r) {
  if (after.visual >= r.bar || (before && before.visual < r.bar)) return null;
  return `${was(before, (b) => `${b.visual}%`)} to ${after.visual}% visual lines, under the ${r.bar}% bar`;
}

// A doc with more heading and image faults than before.
function markupCheck(before, after) {
  const old = before ? before.faults.length : 0;
  if (after.faults.length <= old) return null;
  const where = after.faults.map((f) => `line ${f.line} ${f.what}`).join('; ');
  return `${old} to ${after.faults.length} heading and image faults, goal 0 (${where})`;
}

// What got worse from `before` (null for a new doc) to `after`, one line each.
function regressions(before, after, rules) {
  return [readCheck(before, after, rules), visualCheck(before, after, rules), markupCheck(before, after)].filter(Boolean);
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout;
}

// The files that changed from `from` to HEAD, as { path, old }: old is the
// path at `from` (a rename's source), or null for an added file.
function changedFiles(root, from) {
  const fields = git(root, ['diff', '--name-status', '-z', '-M', from, 'HEAD']).split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (status.startsWith('R') || status.startsWith('C')) { out.push({ old: fields[i], path: fields[i + 1] }); i += 2; continue; }
    const path = fields[i++];
    if (status !== 'D') out.push({ path, old: status === 'A' ? null : path });
  }
  return out;
}

// Each changed doc of the doc set that got worse, as { doc, what }, or the
// reason the gate could not verify.
export function gate({ root, base, params }) {
  const rules = gateRules(params);
  if (rules.problem) return { unverified: rules.problem };
  const { globs, skip } = docSetSpec((k) => params[k]);
  if (!globs) return { unverified: 'the docs params have no usable doc_set and doc_set_left_out' };
  try {
    const from = git(root, ['merge-base', base, 'HEAD']).trim();
    const docs = new Set(expandGlobs(root, globs, skip));
    const worse = [];
    for (const { path, old } of changedFiles(root, from).filter((f) => docs.has(f.path))) {
      const before = old ? measure(git(root, ['show', `${from}:${old}`]), rules) : null;
      const after = measure(readFileSync(join(root, path), 'utf8'), rules);
      for (const what of regressions(before, after, rules)) worse.push({ doc: path, what });
    }
    return { worse, rules };
  } catch (e) {
    return { unverified: e.message };
  }
}

const FIX = (r) => `To fix: cut each doc named to ${r.words} words or fewer (move detail to a linked doc), set prose out as tables, diagrams or code until ${r.bar}% of its lines are visual, and fix each heading and image named. The gate compares each doc with its copy on the base branch, so a doc already over there passes until it gets worse.`;

// The command line: prints the result and sets the exit code.
export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const base = arg('--base');
  if (!base) { console.error('usage: node quality/docs-gate.mjs --base <sha> [--config <file>]'); return 2; }
  let result;
  try { result = gate({ root, base, params: docsParams(root, arg('--config')) }); } catch (e) { result = { unverified: e.message }; }
  if (result.unverified) { console.log(`::warning::docs gate could not verify: ${result.unverified}`); return 0; }
  for (const w of result.worse) console.log(`::error file=${w.doc}::${w.doc}: ${w.what}`);
  if (!result.worse.length) { console.log('docs gate: no changed doc got worse'); return 0; }
  console.log(FIX(result.rules));
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
