#!/usr/bin/env node
// Keeps main's CI Quality run as a history file, at most one a UTC day, on
// the quality-history branch: history/<date>.json, the same file a local run
// writes into <history>/ (collect.mjs --local). The day's first run on main
// writes it; a later run that day finds the file and writes nothing. Main
// itself stays protected: no push reaches it.
//
//   node quality/history-push.mjs RUN [--branch NAME]
//
// pages.yml's deploy job runs it, in its issue-sync steps, on main with the scored run it already
// downloads; GITHUB_REPOSITORY names the repo and gh reads GH_TOKEN. The
// build job reads the branch back before it draws the pages. At most six
// REST calls a run: three on a day already written, six on a new one.
//
// Exit 0 written or already there, 2 usage error. A write GitHub refuses
// warns and exits 0: a missing day is a gap in a trend line, never a failed
// run on main.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { historyName, runText } from "./collect.mjs";
import { ghCli } from "./sync-issues.mjs";

export const BRANCH = "quality-history";

// A run collect.mjs wrote in CI, the only kind this keeps.
export const isCiRun = (run) => run?.mode === "ci" && typeof run.generated_at === "string" && Boolean(run.metrics) && typeof run.metrics === "object";

// Writes the run's day file onto the branch unless it is there already, and
// creates the branch, with no parent, the first time. gh(args, body) is a
// `gh api` client (sync-issues.mjs ghCli). Returns what it did.
export function pushHistory(gh, { repo, run, branch = BRANCH }) {
  if (!isCiRun(run)) throw new Error("not a CI run from collect.mjs");
  const path = `history/${historyName(run)}`;
  const ref = (gh([`repos/${repo}/git/matching-refs/heads/${branch}`]) ?? []).find((r) => r.ref === `refs/heads/${branch}`);
  const tip = ref?.object?.sha ?? null;
  let base = null;
  if (tip) {
    // The trees endpoint takes a commit SHA but answers with that SHA, not its tree's: read the commit first.
    base = gh([`repos/${repo}/git/commits/${tip}`]).tree.sha;
    const tree = gh([`repos/${repo}/git/trees/${base}?recursive=1`]);
    if (tree?.tree?.some((e) => e.path === path)) return { wrote: false, path };
  }
  const tree = gh(["-X", "POST", `repos/${repo}/git/trees`], { ...(base ? { base_tree: base } : {}), tree: [{ path, mode: "100644", type: "blob", content: runText(run) }] });
  const commit = gh(["-X", "POST", `repos/${repo}/git/commits`], { message: `Quality history: ${historyName(run).slice(0, 10)} from ${String(run.commit ?? "unknown").slice(0, 7)}`, tree: tree.sha, parents: tip ? [tip] : [] });
  if (tip) gh(["-X", "PATCH", `repos/${repo}/git/refs/heads/${branch}`], { sha: commit.sha });
  else gh(["-X", "POST", `repos/${repo}/git/refs`], { ref: `refs/heads/${branch}`, sha: commit.sha });
  return { wrote: true, path, created: !tip };
}

// Exits 2 with a message: a usage error, not a refused write.
function usage(text) {
  console.error(text);
  process.exit(2);
}

// The command line: RUN and the branch; exits 2 when either is missing.
function parseCli(argv, env = process.env) {
  const at = argv.indexOf("--branch");
  const branch = at > 0 ? argv[at + 1] : BRANCH;
  const file = argv[0];
  if (!file || file.startsWith("--") || !branch || !env.GITHUB_REPOSITORY) usage("usage: GITHUB_REPOSITORY=owner/name node quality/history-push.mjs RUN [--branch NAME]");
  return { file, branch, repo: env.GITHUB_REPOSITORY };
}

// The CI run in RUN; exits 2 when it cannot be read or is not one.
function readRun(file) {
  let run = null;
  try {
    run = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    usage(`history: could not read ${file}: ${err.message}`);
  }
  if (!isCiRun(run)) usage(`history: ${file} is not a CI run from collect.mjs`);
  return run;
}

function main(argv) {
  const { file, branch, repo } = parseCli(argv);
  const run = readRun(file);
  try {
    const got = pushHistory(ghCli(), { repo, run, branch });
    console.log(got.wrote ? `wrote ${got.path} to ${branch}${got.created ? " (new branch)" : ""}` : `${got.path} is on ${branch} already; one file a day`);
  } catch (err) {
    console.error(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : ""}history: no file written to ${branch}: ${err.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
