// What a doc names, checked against the repo: relative links and anchors,
// repo paths and npm scripts (docs.mjs). Each takes the shared context `c`
// and `names`, the overlay setup from overlayNames.
import fs from 'node:fs';
import path from 'node:path';
import { npmManifests, npmScripts, pathTokens } from './docs-checks.mjs';
import { areaFor, locatePath, overlayOf, readOverlays } from './docs-files.mjs';
import { gitIgnored } from './docs-git.mjs';
import { bare, splitOnce, TARGETS } from './docs-util.mjs';
import { parseMarkdown } from './docs-markdown.mjs';

// params.overlays: a folder an export places elsewhere (a public folder
// that becomes another repo's root). A doc under dir resolves the paths it
// names from onto, overlay first, then the repository. A malformed list
// fails closed: both link metrics could not check.
export function overlayNames(root, param) {
  const overlaid = readOverlays(root, param('overlays'));
  const overlays = overlaid.overlays ?? [];
  return {
    overlaid,
    overlays,
    locate: (doc, target) => locatePath(root, overlays, doc, target),
    overlayNote: overlays.length ? `; under ${overlays.map((o) => `${o.dir}/ (as ${o.onto || 'the root'})`).join(', ')}, overlay first, then the repository (params.overlays)` : '',
  };
}

// The anchors of any doc, read once: the parsed set's, else its file's.
function anchorLookup(root, parsed) {
  const anchorsOf = new Map(parsed.map((p) => [p.doc, p.anchors]));
  return (rel) => {
    if (!anchorsOf.has(rel)) {
      let anchors = new Set();
      try { anchors = parseMarkdown(fs.readFileSync(path.join(root, rel), 'utf8')).anchors; } catch { /* no anchors */ }
      anchorsOf.set(rel, anchors);
    }
    return anchorsOf.get(rel);
  };
}

const isExternal = (target) => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');

function decodePath(raw) {
  try { return decodeURIComponent(raw); } catch { return raw; /* keep the raw path */ }
}

// Whether a relative link, or its #anchor, points at nothing.
function linkBroken(doc, target, locate, anchorsFor) {
  const [rawPath, anchor] = splitOnce(target.replace(/\?[^#]*/, ''), '#');
  let rel = doc;
  if (rawPath) {
    rel = locate(doc, decodePath(rawPath));
    if (!rel) return true;
  }
  if (!anchor || /^L\d+(-L\d+)?$/.test(anchor) || !/\.md$/i.test(rel)) return false;
  return !anchorsFor(rel).has(anchor.toLowerCase());
}

// ---- correct: broken relative links and anchors ----
export function linksMetric({ root, parsed, ok, cnc, src }, { overlaid, locate, overlayNote }) {
  if (overlaid.problem) return cnc('docs.broken_links', overlaid.problem, TARGETS);
  const anchorsFor = anchorLookup(root, parsed);
  let linksChecked = 0;
  const broken = [];
  for (const p of parsed) {
    for (const { line, target } of p.links) {
      if (isExternal(target)) continue;
      linksChecked++;
      if (linkBroken(p.doc, target, locate, anchorsFor)) broken.push({ label: `${p.doc}:${line} ${target}`, value: 1 });
    }
  }
  ok('docs.broken_links', broken.length, [{ label: 'relative links checked', value: linksChecked }, ...broken],
    `relative markdown links and #anchors, ${src}${overlayNote}`);
}

const entries = (root, dir) => {
  try { return fs.readdirSync(path.join(root, dir)).filter((n) => n !== '.git' && n !== 'node_modules'); } catch { return []; }
};

// The docs whose code names paths and scripts: records (an empty area: a log,
// an off-site record) name them as they were, so these checks skip them.
const nonRecords = (parsed, areas) => parsed.filter((d) => areaFor(d.doc, areas)?.length !== 0);

// Paths named in code that start at a top-level repo entry and resolve nowhere.
function missingPaths({ root, parsed, param }, { overlays, locate }) {
  const top = new Set(entries(root, '.'));
  // An overlaid doc's top level is its export root: the overlay's entries
  // beside onto's.
  const topOf = (doc) => {
    const o = overlayOf(overlays, doc);
    return o ? new Set([...entries(root, o.dir), ...entries(root, o.onto || '.')]) : top;
  };
  let checked = 0;
  const missing = [];
  const seen = new Set();
  for (const p of nonRecords(parsed, param('areas'))) {
    const tops = topOf(p.doc);
    for (const { line, text } of [...p.spans, ...p.code]) {
      for (const ref of pathTokens(text)) {
        if (!tops.has(ref.split('/')[0]) || seen.has(`${p.doc}:${line}:${ref}`)) continue;
        seen.add(`${p.doc}:${line}:${ref}`);
        checked++;
        if (locate(p.doc, `/${ref}`) || locate(p.doc, ref)) continue;
        // An overlaid path may be git-ignored in the overlay or in onto.
        const o = overlayOf(overlays, p.doc);
        missing.push({ doc: p.doc, line, ref, repos: o ? [path.posix.join(o.dir, ref), path.posix.join(o.onto, ref)] : [ref] });
      }
    }
  }
  return { checked, missing };
}

// ---- correct: repo paths named in code that no longer exist (a heuristic) ----
export function deadPathsMetric(c, names) {
  const { root, tree, ok, cnc, src } = c;
  if (names.overlaid.problem) return cnc('docs.dead_paths', names.overlaid.problem, TARGETS);
  const { checked, missing } = missingPaths(c, names);
  let dead = missing;
  if (missing.length) {
    const ignored = tree.ok ? gitIgnored(root, missing.flatMap((m) => m.repos)) : { problem: tree.reason };
    if (ignored.problem) return cnc('docs.dead_paths', `${missing.length} missing path(s) need git check-ignore: ${ignored.problem}`, src);
    dead = missing.filter((m) => !m.repos.some((r) => ignored.set.has(bare(r))));
  }
  ok('docs.dead_paths', dead.length,
    [{ label: 'repo paths checked', value: checked }, ...dead.map((m) => ({ label: `${m.doc}:${m.line} ${m.ref}`, value: 1 }))],
    `each word of inline code and code blocks under a top-level repo entry, git-ignored paths and records skipped (a heuristic), ${src}${names.overlayNote}`);
}

// The text after a script's name when no package.json defines it ('' for the
// root, ' in ws', plus ' (no such workspace)'), or null when it is defined.
function scriptMissing(manifests, name, ws) {
  const all = ws == null || ws === '*';
  const scripts = all ? manifests.all : manifests.byWorkspace.get(ws.replace(/^\.\/|\/$/g, '') || '.');
  const where = all ? '' : ` in ${ws}`;
  if (!scripts) return `${where} (no such workspace)`;
  return scripts.has(name) ? null : where;
}

// ---- correct: npm scripts named in code that no package.json defines ----
export function deadScriptsMetric({ root, param, parsed, ok, cnc, src, skip }) {
  const manifests = npmManifests(root, skip);
  if (!manifests.ok) return cnc('docs.dead_scripts', manifests.reason, 'package.json');
  let checked = 0;
  const gone = [];
  for (const p of nonRecords(parsed, param('areas'))) {
    for (const { line, text } of [...p.spans, ...p.code]) {
      for (const { name, ws } of npmScripts(text)) {
        checked++;
        const miss = scriptMissing(manifests, name, ws);
        if (miss !== null) gone.push({ label: `${p.doc}:${line} ${name}${miss}`, value: 1 });
      }
    }
  }
  ok('docs.dead_scripts', gone.length, [{ label: 'npm script references checked', value: checked }, ...gone],
    `npm run, test and start in inline code and code blocks, against ${manifests.files.join(', ')}; with -w, that workspace alone; records skipped, ${src}`);
}
