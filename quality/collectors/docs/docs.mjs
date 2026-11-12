// Documentation tab collector. Quality: every fact is there, current and
// correct, in docs that are visual first. Speed: docs short enough to read in
// the reading goal. Consumption: the tokens Claude loads past that goal.
//
//   Correct   named paths and npm scripts exist, links resolve, few lint WARNs,
//             headings in order and images with alt text
//   Current   no stale markers, no dated claim older than its area, little lag
//   Complete  every top-level folder explained; every runbook dated by its
//             last verification; the community health files present
//   Visual    few text-only docs; most reader docs with something to open,
//             pan or zoom
//
// Any repo can run this file unchanged. What is repo-specific is data in the
// params of quality/targets/docs.json, never in here: the doc set and what it
// leaves out, the folders never walked, the lint, the doc-to-area map, the
// markers, the phrases, the folder map and the reading rate. The engine
// passes them after the repo's override; without them, the template's own
// defaults apply. Anything this collector cannot read becomes
// `could_not_check`, never 0. `mode` changes nothing: every input is a repo
// file, git history or the lint. `now` is for tests.
import fs from 'node:fs';
import path from 'node:path';
import { communityFiles, folderCoverage, lint, runbooksVerified } from './docs-checks.mjs';
import { expandGlobs } from './docs-files.mjs';
import { gitHistory, gitTree } from './docs-git.mjs';
import { parseMarkdown } from './docs-markdown.mjs';
import { areaLookups, interactiveMetric, lagMetric, markersMetric, markupMetric, readingMetrics, staleDatesMetric, unmappedMetric, visualMetrics } from './docs-metrics.mjs';
import { deadPathsMetric, deadScriptsMetric, linksMetric, overlayNames } from './docs-names.mjs';
import { GIT_DIR, TARGETS as TARGETS_FILE } from './docs-util.mjs';

export { folderMapRows, npmScripts, pathTokens } from './docs-checks.mjs';
export { areaEntry, areaFor, expandGlobs, locatePath, readOverlays } from './docs-files.mjs';
export { slugify } from './docs-markdown.mjs';

export const area = 'docs';
export const PARAMS = Object.assign({}, ...JSON.parse(fs.readFileSync(new URL('../../targets/docs.json', import.meta.url), 'utf8')).map((t) => t.params ?? {}));

const IDS = [
  'docs.dead_paths',
  'docs.dead_scripts',
  'docs.broken_links',
  'docs.lint_warn',
  'docs.markup_faults',
  'docs.stale_markers',
  'docs.stale_dates',
  'docs.oldest_lag_days',
  'docs.unmapped',
  'docs.folder_coverage',
  'docs.runbooks_verified',
  'docs.community_files',
  'docs.over_read_goal',
  'docs.interactive_share',
  'docs.text_only',
  'docs.tokens_past_read_goal',
];


const byDesc = (a, b) => b.value - a.value || a.label.localeCompare(b.label);
const byAsc = (a, b) => a.value - b.value || a.label.localeCompare(b.label);

// Every Docs metric, read from the repo's files and git history.
export async function collect({ root, mode, now = new Date(), params = PARAMS }) {
  const read_at = now.toISOString();
  const out = {};
  const ok = (id, value, detail, source) => { out[id] = { value, detail, source, read_at }; };
  const cnc = (id, reason, source) => { out[id] = { could_not_check: reason, source }; };

  const param = (key) => params?.[key];
  const tree = gitTree(root);
  const history = gitHistory(root, tree);
  const c = { root, param, tree, history, ok, cnc, byDesc, byAsc };

  // ---- complete: the checks that need no doc set run first ----
  const { skip, leftOk, notDocs, globs } = docSetSpec(param);
  c.skip = skip;
  folderCoverage(root, param('folder_map'), tree, ok, cnc, byAsc);
  runbooksVerified(root, param('runbooks'), param('verified'), notDocs, c.skip, ok, cnc, byAsc);
  communityFiles(root, param('community_files'), c.skip, ok, cnc, byAsc);

  const set = loadDocSet(c, leftOk, globs);
  if (set.problem) {
    for (const id of IDS) if (!out[id]) cnc(id, set.problem, 'params.doc_set');
    return out;
  }
  c.parsed = set.parsed;
  c.src = `quality/collectors/docs/docs.mjs over ${set.docs.length} docs (params.doc_set)`;
  Object.assign(c, areaLookups(root, param('areas')));

  readingMetrics(c);
  visualMetrics(c);
  interactiveMetric(c);
  markupMetric(c);
  lagMetric(c);
  unmappedMetric(c);
  markersMetric(c);
  staleDatesMetric(c);
  const names = overlayNames(root, param);
  linksMetric(c, names);
  deadPathsMetric(c, names);
  deadScriptsMetric(c);
  lint(root, set.docs, param('lint'), ok, cnc);
  return out;
}

// The doc set's globs and the folders never walked, from params. Each
// params.doc_set_left_out entry, a file the doc set leaves out and why,
// becomes a "!" glob; a left-out file is no runbook either. globs is null
// when params.doc_set is missing or a left-out entry is malformed. The docs
// gate (quality/docs-gate.mjs) reads the doc set through this too.
export function docSetSpec(param) {
  const skipDirs = param('skip_dirs');
  const skip = new Set([...GIT_DIR, ...(Array.isArray(skipDirs) ? skipDirs : [])]);
  const leftOut = param('doc_set_left_out') ?? [];
  const leftOk = Array.isArray(leftOut) && leftOut.every((l) => l && typeof l.glob === 'string' && typeof l.why === 'string');
  const notDocs = leftOk ? leftOut.map((l) => `!${l.glob}`) : [];
  const globs = Array.isArray(param('doc_set')) && leftOk ? [...param('doc_set'), ...notDocs] : null;
  return { skip, leftOk, notDocs, globs };
}

// The doc set's files, read and parsed, or the first problem with it.
function loadDocSet({ root, skip }, leftOk, globs) {
  const docs = globs ? expandGlobs(root, globs, skip) : [];
  let problem = null;
  if (!leftOk) problem = `params.doc_set_left_out must be a list of { glob, why } (${TARGETS_FILE})`;
  else if (!globs) problem = `params.doc_set is missing; add the doc globs to ${TARGETS_FILE}`;
  else if (!docs.length) problem = `no file under ${root} matches params.doc_set`;
  const parsed = [];
  for (const doc of problem ? [] : docs) {
    try {
      const text = fs.readFileSync(path.join(root, doc), 'utf8');
      parsed.push({ doc, bytes: Buffer.byteLength(text), ...parseMarkdown(text) });
    } catch (e) {
      problem = `could not read ${doc} (${e.message})`;
      break;
    }
  }
  return { docs, parsed, problem };
}
