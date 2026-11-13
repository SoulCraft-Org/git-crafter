// The pull request gate: fails a pull request whose description would miss
// one of the Pull requests tab's description goals, each read with the
// metric's own function (collectors/github/github-text.mjs), so the gate and
// the metrics cannot drift:
//
//   pull_requests.linked_issue_share  it links no issue or card
//   pull_requests.body_table_share    it shows no table
//   pull_requests.latest_body_words   it has more prose words than the goal
//   pull_requests.latest_lines        it asks a reviewer to read more lines
//                                     than the goal (reviewedLines, which
//                                     leaves out lockfiles, generated files,
//                                     data snapshots and params.not_reviewed,
//                                     and counts no moved line and no
//                                     line of a file removed whole)
//
// The goal and the ignored text are the template's with the repo's targets
// folder (config "targets") laid over them, through overlay.mjs. pr-body.yml
// runs it on open and on push, once per head commit, with the description as
// it is now. No package is loaded, so the job needs no npm ci.
//
//   PR_BODY=... PR_AUTHOR=... node quality/pr-gate.mjs [--config config/quality.json]
//
// Exit 0: every goal met, Dependabot's, or could not verify (no PR_BODY in
// the environment or unreadable targets; a ::warning:: says which). Exit 1: a
// goal missed; a ::error:: names each with its fix.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDependabot } from './collectors/github/github-flow.mjs';
import { diffFiles, movedPairs, readLines } from './collectors/github/github-reviews.mjs';
import { hasTable, linksIssue, proseWords } from './collectors/github/github-text.mjs';
import { overlayTargets, readTargetFiles } from './overlay.mjs';

const QUALITY = fileURLToPath(new URL('.', import.meta.url));
const WORDS = 'pull_requests.latest_body_words';
const LINES = 'pull_requests.latest_lines';
export const FIX = 'add a line "Closes #N" (or Fixes, Resolves) for the issue this closes, or "Part of #N" when it only serves the issue or card; a draft card has no number yet, so write "Card: PVTI_..." (its board id), then re-run this job';

/** { ignore, words, lines, notReviewed }: the text a description is read without, its prose-word goal, the reviewed-lines goal and the repo's not-reviewed files, the template's under the repo's. */
export function rules(root = process.cwd(), configFile) {
  const config = configFile ? JSON.parse(readFileSync(resolve(root, configFile), 'utf8')) : {};
  const repoDir = config.targets ? resolve(root, config.targets) : null;
  const { entries, params } = overlayTargets(readTargetFiles(join(QUALITY, 'targets')), readTargetFiles(repoDir));
  const ignore = (params['github.json']?.pr_body_ignore ?? []).map((p) => new RegExp(p, 'g'));
  const notReviewed = (params['github.json']?.not_reviewed ?? []).map((p) => new RegExp(p));
  // A repo that drops a metric has no goal for it here either.
  const goal = (id) => entries.find((e) => e.id === id && e.drop !== true)?.goal ?? Infinity;
  return { ignore, words: goal(WORDS), lines: goal(LINES), notReviewed };
}

/** The goals a description misses, each as its fix; none for Dependabot, which writes its own. */
export function misses(body, author = '', { ignore = [], words = Infinity } = {}) {
  if (isDependabot(author)) return [];
  const count = proseWords(body ?? '', ignore);
  return [
    !linksIssue(body, ignore) && `the description links no issue: ${FIX}`,
    !hasTable(body ?? '', ignore) && 'the description shows no table: put its facts in a table, then re-run this job',
    count > words && `the description has ${count} prose words, goal ${words}: move facts into a table or diagram, which are not counted, then re-run this job`,
  ].filter(Boolean);
}

/**
 * The size miss as its fix, or null: the lines a reviewer reads in `files`,
 * as diffFiles reads them ({ filename, additions, deletions, patch, deleted }),
 * less files removed whole and moved lines (readLines), over the reviewed-lines goal. None for
 * Dependabot, whose updates are lockfiles.
 */
export function sizeMiss(files, author = '', { lines = Infinity, notReviewed = [] } = {}) {
  if (isDependabot(author)) return null;
  const sum = (k) => files.reduce((n, f) => n + f[k], 0);
  const pull = { additions: sum('additions'), deletions: sum('deletions'), files: { nodes: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, ...(f.deleted && { changeType: 'DELETED' }) })) } };
  const read = readLines(pull, notReviewed, files).lines;
  return read > lines ? `the change asks a reviewer to read ${read} lines, goal ${lines}: split it into a GitHub stack, one pull request per layer at or under the goal (skills/merging/SKILL.md, Stack), then re-run this job` : null;
}

// diffFiles and movedPairs live beside reviewedLines, which the metrics share; the gate's tests read them here.
export { diffFiles, movedPairs };

// The file --config names, undefined without the flag; the flag with no file is an error, never a silent default.
function configArg(argv) {
  const at = argv.indexOf('--config');
  if (at < 0) return undefined;
  if (!argv[at + 1]) throw new Error('--config names no file');
  return argv[at + 1];
}

// The changed files from the git patch in the file PR_DIFF names; a missing file skips the size check.
function changedFiles(path, log) {
  try {
    if (!path) throw new Error('no PR_DIFF in the environment');
    return diffFiles(readFileSync(path, 'utf8'));
  } catch (err) {
    return log(`::warning::pr-gate: could not read the changed files (${err.message}), so the size was not checked`), null;
  }
}

/** The CLI: 0 when every goal is met or nothing could be read, 1 on a miss. */
export function main(env = process.env, argv = process.argv.slice(2), log = console.log) {
  if (typeof env.PR_BODY !== 'string') return log('::warning::pr-gate: no PR_BODY in the environment, so nothing was checked'), 0;
  let held;
  try {
    held = rules(process.cwd(), configArg(argv));
  } catch (err) {
    return log(`::warning::pr-gate: could not read the targets (${err.message}), so nothing was checked`), 0;
  }
  const found = misses(env.PR_BODY, env.PR_AUTHOR, held);
  const files = changedFiles(env.PR_DIFF, log);
  const size = files && sizeMiss(files, env.PR_AUTHOR, held);
  if (size) found.push(size);
  for (const line of found) log(`::error::pr-gate: ${line}`);
  if (!found.length) log(`pr-gate: the description links an issue, shows a table and is within the word goal${files ? ', and the change within the lines goal' : ''}`);
  return found.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
