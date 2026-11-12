// The Documentation collector's metrics over the parsed doc set: reading
// time, visual share, lag, area map, markers and dated claims (docs.mjs).
// Each takes the shared context `c` { root, param, tree, history, ok, cnc,
// byDesc, byAsc, parsed, src }.
import { datedPhrase } from './docs-checks.mjs';
import { areaEntry, areaFor, globToRegExp } from './docs-files.mjs';
import { lastCommit, lastCommitDay, trackedFiles } from './docs-git.mjs';
import { byFolder, daysBetween, escapeRe, round1, sum, TARGETS } from './docs-util.mjs';

// ---- speed: reading time, and consumption: the tokens Claude loads past it ----
export function readingMetrics({ param, parsed, ok, cnc, byDesc, src }) {
  const wpm = Number(param('words_per_minute'));
  const goalMin = Number(param('minutes_goal'));
  if (!(wpm > 0) || !(goalMin > 0)) {
    for (const id of ['docs.over_read_goal', 'docs.tokens_past_read_goal']) cnc(id, `${TARGETS} needs params.words_per_minute and params.minutes_goal`, TARGETS);
    return;
  }
  const goalWords = goalMin * wpm;
  const over = byFolder(parsed.filter((p) => p.words > goalWords).map((p) => p.doc));
  ok('docs.over_read_goal', sum(over.map((d) => d.value)), over.sort(byDesc),
    `docs over ${goalMin} minutes at ${wpm} words a minute, counted by top-level folder, ${src}`);
  // Tokens are bytes / 4, the estimate the Instructions tab uses. A doc's
  // share past the goal is its words past goalWords over all its words, so
  // each doc is costed at its own tokens per word: code and tables cost more.
  const past = parsed
    .filter((p) => p.words > goalWords)
    .map((p) => ({ label: p.doc, value: Math.round((p.bytes / 4) * ((p.words - goalWords) / p.words)), unit: 'tokens' }))
    .sort(byDesc);
  ok('docs.tokens_past_read_goal', sum(past.map((d) => d.value)), past.slice(0, 15),
    `bytes / 4 of each doc, the share of its words past ${goalWords} (${goalMin} minutes at ${wpm} words a minute), summed; detail is the heaviest docs, ${src}`);
}

// A parsed doc's table, code, diagram and image lines, as a percent of its
// non-blank lines; docs.text_only and the docs gate read it.
export const visualShare = (p) => (p.lines ? round1((100 * p.visualLines) / p.lines) : 0);

// ---- visual: text-only docs ----
export function visualMetrics({ param, parsed, ok, cnc, byDesc, src }) {
  const shares = parsed.map((p) => ({ label: p.doc, value: visualShare(p) }));
  const below = Number(param('text_only_below'));
  if (!(below > 0)) return cnc('docs.text_only', `${TARGETS} needs params.text_only_below, a percent`, TARGETS);
  const textOnly = shares.filter((d) => d.value < below).map((d) => d.label);
  ok('docs.text_only', textOnly.length, byFolder(textOnly).sort(byDesc), `docs under ${below}% visual lines, by top-level folder, ${src}`);
}

const leftOutList = (list) => Array.isArray(list) && list.every((l) => l && typeof l.glob === 'string' && typeof l.why === 'string');

// ---- visual: reader docs with something to open, pan or zoom ----
// GitHub renders a mermaid block with pan and zoom controls and a <details>
// block as a drill-down. A doc params.agent_docs names is written for an
// agent to load, where a diagram costs tokens on every load, so it is left out.
export function interactiveMetric({ param, parsed, ok, cnc, src }) {
  const id = 'docs.interactive_share';
  const charts = param('mermaid_charts');
  if (!Array.isArray(charts)) return cnc(id, `${TARGETS} has no params.mermaid_charts`, TARGETS);
  const agentDocs = param('agent_docs') ?? [];
  if (!leftOutList(agentDocs)) return cnc(id, `${TARGETS} params.agent_docs must be a list of { glob, why }`, TARGETS);
  const agent = agentDocs.map((a) => globToRegExp(a.glob));
  const readers = parsed.filter((p) => !agent.some((re) => re.test(p.doc)));
  if (!readers.length) return cnc(id, 'params.agent_docs names every doc of the doc set, so no reader doc is left to count', TARGETS);
  const isChart = (m) => charts.includes(m.kind);
  const types = [
    ['mermaid diagram', (p) => p.mermaid.filter((m) => m.kind && !isChart(m)).length],
    [`mermaid chart (${charts.join(', ')})`, (p) => p.mermaid.filter(isChart).length],
    ['<details> block', (p) => p.details],
  ];
  const withAny = readers.filter((p) => types.some(([, count]) => count(p) > 0)).length;
  ok(id, round1((100 * withAny) / readers.length),
    types.map(([label, count]) => ({ label, value: sum(readers.map(count)), unit: '' })),
    `${readers.length} reader docs (the doc set less params.agent_docs) with a mermaid diagram, a mermaid chart or a <details> block outside code; detail counts elements, ${src}`);
}

// A doc's heading faults: a level skipped on the way down, a second H1, and a
// heading repeated at its level anywhere in the doc. The repeat is page-wide,
// as GitHub's style guide has it: GitHub numbers a repeated heading's anchor
// (#usage-1), so a link to it breaks when a section moves.
function headingFaults(p) {
  const out = [];
  const seen = new Set();
  let prev = 0;
  let h1 = 0;
  for (const { line, level, text } of p.headings) {
    const key = `${level} ${text.toLowerCase()}`;
    if (prev && level > prev + 1) out.push({ line, what: `heading level ${prev} to ${level}` });
    if (level === 1 && ++h1 > 1) out.push({ line, what: 'second H1' });
    else if (seen.has(key)) out.push({ line, what: `repeated heading "${text}"` });
    seen.add(key);
    prev = level;
  }
  return out;
}

// A doc's images with no alt text, or alt text past the limit.
const altFaults = (p, max) => p.images
  .filter((i) => !i.alt || i.alt.length > max)
  .map((i) => ({ line: i.line, what: i.alt ? `alt text of ${i.alt.length} characters` : 'image with no alt text' }));

// A parsed doc's heading and image faults, each { line, what }, with alt
// text allowed up to `max` characters; docs.markup_faults and the docs gate
// read it.
export const markupFaults = (p, max) => [...headingFaults(p), ...altFaults(p, max)];

// ---- correct: headings a reader can outline, images a screen reader can say ----
export function markupMetric({ param, parsed, ok, cnc, src }) {
  const max = Number(param('alt_max_chars'));
  if (!(max > 0)) return cnc('docs.markup_faults', `${TARGETS} needs params.alt_max_chars, a number of characters`, TARGETS);
  const faults = parsed.flatMap((p) => markupFaults(p, max).map((f) => ({ label: `${p.doc}:${f.line} ${f.what}`, value: 1 })));
  const headings = sum(parsed.map((p) => p.headings.length));
  const images = sum(parsed.map((p) => p.images.length));
  ok('docs.markup_faults', faults.length, [{ label: 'headings and images checked', value: headings + images }, ...faults],
    `${headings} headings (a skipped level, a second H1, a heading repeated at its level) and ${images} images (no alt text, or over ${max} characters) outside code, ${src}`);
}

// A doc's area's last change, as a time and as the committer's own day, each
// read once. A doc's dates are written in its author's calendar, so the day is
// never UTC. null for a record or an area with no history.
export function areaLookups(root, areas) {
  const cached = (read) => {
    const cache = new Map();
    return (doc) => {
      if (!cache.has(doc)) {
        const spec = areaFor(doc, areas);
        cache.set(doc, spec && spec.length ? read(root, [...spec, `:(exclude)${doc}`]) : null);
      }
      return cache.get(doc);
    };
  };
  return { areaTsFor: cached(lastCommit), areaDayFor: cached(lastCommitDay) };
}

// The one doc that trails its area the most, now: a state, never a mean
// over docs, so it names the doc to fix.
export function lagMetric({ root, param, history, parsed, ok, cnc, byDesc, areaTsFor }) {
  const areas = param('areas');
  if (!history.ok) return cnc('docs.oldest_lag_days', history.reason, 'git log -1 --format=%ct');
  if (!Array.isArray(areas)) return cnc('docs.oldest_lag_days', `${TARGETS} has no params.areas`, TARGETS);
  const detail = [];
  for (const p of parsed) {
    const areaTs = areaTsFor(p.doc);
    const docTs = areaTs == null ? null : lastCommit(root, [p.doc]);
    if (docTs == null) continue;
    detail.push({ label: p.doc, value: round1(Math.max(0, areaTs - docTs) / 86400) });
  }
  if (!detail.length) return cnc('docs.oldest_lag_days', 'no doc maps to an area with git history; check params.areas', TARGETS);
  detail.sort(byDesc);
  ok('docs.oldest_lag_days', detail[0].value, detail,
    `git log -1 --format=%ct -- <doc>, and -- <area> (params.areas); the doc that trails its area most, ${detail[0].label}`);
}

const excluded = (p) => /^:(\(exclude\)|!|\^)/.test(p);

// The area paths each doc names, and the docs with no usable entry.
function areaNames(parsed, areas) {
  const detail = []; // unmapped docs in doc-set order, then dead paths
  const named = new Map(); // area path -> the docs whose area names it
  for (const { doc } of parsed) {
    const spec = areaFor(doc, areas);
    if (spec) for (const p of spec) named.set(p, [...(named.get(p) ?? []), doc]);
    else {
      const hit = areaEntry(doc, areas);
      detail.push({ label: hit ? `${doc} (its params.areas entry "${hit.doc}" needs area: a list of paths)` : `${doc} (no params.areas entry)`, value: 1 });
    }
  }
  return { detail, named };
}

// The map itself: the lag and dated-claim checks skip, silently, a doc with
// no usable params.areas entry, an area path that matches no tracked file,
// and a doc whose area paths together match only the doc (the lag check
// reads the whole area, less the doc). Each one is named here, and
// collect.mjs fails a pull request on any (the target's gate). An area of
// [] is a record, mapped to nothing on purpose, so it passes.
export function unmappedMetric({ root, param, tree, parsed, ok, cnc, src }) {
  const areas = param('areas');
  if (!Array.isArray(areas)) return cnc('docs.unmapped', `${TARGETS} has no params.areas`, TARGETS);
  if (!tree.ok) return cnc('docs.unmapped', tree.reason, 'git ls-files');
  const { detail, named } = areaNames(parsed, areas);
  const filesOf = new Map(); // area path -> the tracked files it matches
  for (const [p, docs] of named) {
    if (excluded(p)) continue;
    filesOf.set(p, trackedFiles(root, p));
    const more = docs.length > 1 ? ` and ${docs.length - 1} more` : '';
    if (!filesOf.get(p).length) detail.push({ label: `${p} (area of ${docs[0]}${more}) matches no tracked file`, value: 1 });
  }
  for (const { doc } of parsed) {
    const row = onlyDocRow(root, doc, areas, filesOf);
    if (row) detail.push(row);
  }
  ok('docs.unmapped', detail.length, detail,
    `each doc against params.areas, and each area path through git ls-files, ${src}`);
}

// A row when the doc's area matches only the doc itself.
function onlyDocRow(root, doc, areas, filesOf) {
  const area = areaFor(doc, areas) ?? [];
  const all = area.filter((p) => !excluded(p)).flatMap((p) => filesOf.get(p) ?? []);
  if (!all.length) return null; // a record, or dead paths named above
  // An exclude can narrow the area, so git applies it, as the lag check does.
  const onlyDoc = area.some(excluded) ? !trackedFiles(root, ...area, `:(exclude)${doc}`).length : all.every((f) => f === doc);
  return onlyDoc ? { label: `${doc} (its area ${area.join(', ')} matches only the doc)`, value: 1 } : null;
}

// docs.stale_markers: how often each doc holds a params.markers term.
export function markersMetric({ param, parsed, ok, cnc, byDesc, src }) {
  const markers = param('markers');
  if (!Array.isArray(markers)) return cnc('docs.stale_markers', `${TARGETS} has no params.markers`, TARGETS);
  const res = markers.map((m) => new RegExp(`\\b${escapeRe(m.term)}\\b`, m.match_case ? 'g' : 'gi'));
  const detail = [];
  for (const p of parsed) {
    let n = 0;
    for (const { text } of p.prose) for (const re of res) n += (text.match(re) || []).length;
    if (n) detail.push({ label: p.doc, value: n });
  }
  ok('docs.stale_markers', sum(detail.map((d) => d.value)), detail.sort(byDesc),
    `${markers.map((m) => m.term).join(', ')} outside code and comments, ${src}`);
}

// Each dated claim in a doc's prose, judged against its area's last change.
function judgeDates({ parsed, canDate, areaDayFor }, res) {
  const stale = [];
  let judged = 0;
  let undated = 0;
  for (const p of parsed) {
    for (const { line, text } of p.prose) {
      for (const m of res.flatMap((re) => [...text.matchAll(re)])) {
        if (!canDate) { undated++; continue; }
        const changed = areaDayFor(p.doc);
        if (changed == null) continue; // a record, or an area with no history: nothing to be current with
        judged++;
        if (m[2] < changed) stale.push({ label: `${p.doc}:${line} ${m[1]} ${m[2]}, area changed ${changed}`, value: daysBetween(m[2], changed), unit: 'days' });
      }
    }
  }
  return { stale, judged, undated };
}

// docs.stale_dates: the params.as_of dates older than the last commit to their doc's area.
export function staleDatesMetric(c) {
  const { param, history, ok, cnc, byDesc, src } = c;
  const asOf = param('as_of');
  if (!Array.isArray(asOf) || !asOf.length || asOf.some((s) => typeof s !== 'string')) {
    return cnc('docs.stale_dates', `${TARGETS} needs params.as_of, a list of phrases`, TARGETS);
  }
  const canDate = history.ok && Array.isArray(param('areas'));
  const { stale, judged, undated } = judgeDates({ ...c, canDate }, asOf.map(datedPhrase));
  if (undated) {
    const why = history.ok ? `${TARGETS} has no params.areas` : history.reason;
    return cnc('docs.stale_dates', `${undated} dated claim(s) need git history and params.areas to compare: ${why}`, src);
  }
  ok('docs.stale_dates', stale.length, stale.sort(byDesc),
    `${judged} "${asOf.join('", "')}" dates outside code, each against the last commit to its doc's area (params.areas), ${src}`);
}
