// Four metrics from GitHub's Actions metrics views, read from runs the CI collector already loads: how long a job waits for a runner, how many runs fail and what a billed minute costs by runner type (Actions tab), and the billed minutes that bought nothing (Insights tab).
import { percentile } from "../github/github-core.mjs";
import { LAST, QUEUE_SAMPLE, groupBy, measured, pct, round1, skip } from "./ci-core.mjs";
import { priceRuns } from "./ci-runs.mjs";

/** Conclusions that bought nothing, whatever started the run. */
const NO_RESULT = ["cancelled", "timed_out", "startup_failure"];

// A run whose minutes bought nothing: cancelled, timed out, or failed after merge. A check that fails a pull request, or its merge queue entry, is the check working.
const wasted = (r) => NO_RESULT.includes(r.conclusion) || (r.conclusion === "failure" && !/^(pull_request|merge_group)/.test(String(r.event ?? "")));

/** The 90th percentile of job queue seconds, overall and per workflow. */
function queueP90(runs) {
  const rows = runs.flatMap((r) => r.jobs.filter((j) => j.queue !== null).map((j) => ({ workflow: r.workflow, queue: j.queue })));
  if (!rows.length) return skip(`no job with a queue time in the last ${QUEUE_SAMPLE} runs per workflow`);
  const p90 = (list) => round1(percentile(list.map((x) => x.queue), 0.9));
  return measured(p90(rows), [...groupBy(rows, (x) => x.workflow)].map(([label, g]) => ({ label, value: p90(g) })));
}

/** Conclusions that decide a run: it passed or it failed. */
const DECIDED = ["success", "failure", "timed_out", "startup_failure"];

/** Share of decided runs that failed, on any event, overall and per workflow; cancelled and skipped runs give no verdict. */
function failedRunShare(runs) {
  const decided = runs.filter((r) => r.status === "completed" && DECIDED.includes(r.conclusion));
  if (!decided.length) return skip(`no run passed or failed in the ${LAST}`);
  const share = (list) => pct(list.filter((r) => r.conclusion !== "success").length, list.length);
  return measured(share(decided), [...groupBy(decided, (r) => r.workflow)].map(([label, g]) => ({ label, value: share(g) })));
}

/** Share of billed minutes on runs that bought nothing, overall and per workflow. */
function failedMinutesShare(runs) {
  const billed = (list) => list.reduce((n, r) => n + r.billed, 0);
  if (!billed(runs)) return skip(`no billed minutes in the ${LAST}`);
  const share = (list) => pct(billed(list.filter(wasted)), billed(list));
  const detail = [...groupBy(runs, (r) => r.workflow)].filter(([, g]) => billed(g)).map(([label, g]) => ({ label, value: share(g) }));
  return measured(share(runs), detail);
}

/** The four metrics, in the shape ci.mjs's METRICS table holds. */
export const INSIGHT_METRICS = {
  // Runner choice: the list price of a billed minute, over the queue sample's REST jobs, which carry runner labels.
  "ci.runner_cents_per_minute": {
    source: `last ${QUEUE_SAMPLE} completed runs per workflow, the queue sample (gh api actions/runs/{id}/jobs): each job's billed minutes times its runs-on label's list rate, over the minutes`,
    async run(L) {
      const cost = priceRuns(await L.queued());
      if (cost.unpriced) return skip(cost.unpriced);
      if (!cost.minutes) return skip(`no billed minutes in the last ${QUEUE_SAMPLE} runs per workflow`);
      const cents = (w) => Math.round((10000 * w.dollars) / w.minutes) / 100;
      return measured(cents(cost), [...cost.byWorkflow].filter(([, w]) => w.minutes).map(([label, w]) => ({ label, value: cents(w) })));
    },
  },
  "ci.queue_seconds_p90": {
    source: `last ${QUEUE_SAMPLE} completed runs per workflow, the queue sample the CI tab already reads (gh api actions/runs/{id}/jobs): each job's started_at less created_at`,
    run: async (L) => queueP90(await L.queued()),
  },
  "ci.failed_run_share": {
    source: `gh api actions/workflows/{id}/runs (${LAST}): runs that ended ${DECIDED.slice(1).join(", ")}, over those that passed or failed, on any event`,
    run: async (L) => failedRunShare(await L.runs()),
  },
  "insights.failed_minutes_share": {
    source: `GraphQL check runs of the ${LAST}: each job's minutes rounded up as GitHub bills them, summed for runs that ended ${NO_RESULT.join(", ")}, or failed outside a pull request or merge queue, over all`,
    run: async (L) => failedMinutesShare(await L.described()),
  },
};
