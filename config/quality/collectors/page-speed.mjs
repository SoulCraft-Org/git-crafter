// Git Crafter's own Speed metric on the Code tab that reads in CI: how long the
// engine takes to collect and build this repo's Quality page on a push to
// main. That step is the template's code at work, the same run every
// adopting repo waits on, so it times the engine where it runs.
//
// It reads the step's own start and end from GitHub (gh api
// actions/runs/{id}/jobs) for the last params.runs successful pushes to the
// default branch; the run that is collecting now is still in progress, so it
// is never one of them. The median leaves out one slow runner. Nothing here
// throws: a read that fails is could_not_check with the reason, never 0.
import { GhError, ghClient, repoOf } from "../../../quality/collectors/lib/index.mjs";

export const area = "page-speed";
const ID = "engine.page_seconds";

// A could_not_check entry with its reason and source.
const unknown = (reason, source) => ({ [ID]: { could_not_check: reason, source } });

// Seconds between two ISO times, or null when either is missing.
const seconds = (from, to) => (from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : null);

// The median of a sorted list of numbers.
const median = (xs) => (xs[Math.floor((xs.length - 1) / 2)] + xs[Math.ceil((xs.length - 1) / 2)]) / 2;

/** The settings, each defaulted: the workflow, job and step to time, the branch, and how many runs. */
export function settingsOf(params = {}) {
  return {
    workflow: params.workflow || "pages.yml",
    job: params.job || "build",
    step: params.step || "Git Crafter's own Quality, Speed and Consumption page",
    branch: params.branch || "main",
    runs: Number(params.runs) > 0 ? Number(params.runs) : 5,
  };
}

// One run's detail row: the step's seconds, or null when the run has no such step or it never finished.
async function stepRow(gh, slug, run, { job, step }) {
  const jobs = (await gh.rest(`repos/${slug}/actions/runs/${run.id}/jobs?per_page=100`))?.jobs ?? [];
  const found = jobs.find((j) => j.name === job)?.steps?.find((s) => s.name === step);
  const took = seconds(found?.started_at, found?.completed_at);
  return took === null ? null : { label: `${String(run.created_at).slice(0, 16)}Z ${String(run.head_sha).slice(0, 7)}`, value: took, unit: "s" };
}

// A failed read as its could_not_check reason.
function reasonOf(err) {
  if (!(err instanceof GhError)) return `${err?.name ?? "Error"}: ${err?.message ?? err}`;
  return `gh api failed${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`;
}

/** The engine's page step, in seconds: the median over the last params.runs successful pushes to the default branch. */
export async function collect({ params = {}, gh = ghClient(), repo } = {}) {
  const cfg = settingsOf(params);
  const source = `last ${cfg.runs} successful pushes to ${cfg.branch}: median seconds of the ${cfg.workflow} ${cfg.job} job's step "${cfg.step}" (gh api actions/runs/{id}/jobs)`;
  const slug = repoOf(repo, params);
  if (!slug) return unknown("no repo to read: params.repo is not owner/name, and GITHUB_REPOSITORY is unset", source);
  try {
    const list = await gh.rest(`repos/${slug}/actions/workflows/${cfg.workflow}/runs?branch=${cfg.branch}&event=push&status=success&per_page=${cfg.runs}`);
    const rows = [];
    for (const run of list?.workflow_runs ?? []) rows.push(await stepRow(gh, slug, run, cfg));
    const read = rows.filter(Boolean);
    if (!read.length) return unknown(`no successful push to ${cfg.branch} in ${cfg.workflow} has the ${cfg.job} job's step "${cfg.step}"`, source);
    const value = Math.round(median(read.map((r) => r.value).sort((a, b) => a - b)));
    return { [ID]: { value, detail: read, source, read_at: new Date().toISOString() } };
  } catch (err) {
    return unknown(reasonOf(err), source);
  }
}
