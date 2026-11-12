// How the CI collector reads workflow runs and their jobs, finds flaky checks and prices the runs of a pull request.
import { RUNS_PER_WORKFLOW, byNewest, RATE_LIMIT, groupBy, mapLimit, ms, utc, completed, runnerRate } from "./ci-core.mjs";
import { GhError } from "../github/github.mjs";

/**
 * One workflow's runs, newest first, each named by its workflow: a Dependabot
 * run's own name is its update's title, which would make every update a
 * workflow of its own. Reads up to `pages` pages of RUNS_PER_WORKFLOW and
 * stops at a short one; with `since` (ms), GitHub lists only runs created on
 * that UTC day or later. A run that a new one pushed onto the next page while
 * it was read counts once. Unread runs never become an empty list: a 404
 * names the workflow, and so does an answer without a workflow_runs list. The
 * Tests tab (tests.mjs) reads its workflows with this.
 */
export async function workflowRuns(gh, repo, w, { pages = 1, since } = {}) {
  const created = since === undefined ? "" : `&created=>=${new Date(since).toISOString().slice(0, 10)}`;
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page++) {
    const list = await runsPage(gh, repo, w, `${page > 1 ? `&page=${page}` : ""}${created}`);
    for (const r of list) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, workflow: w.name });
    }
    if (list.length < RUNS_PER_WORKFLOW) break;
  }
  return out.sort(byNewest);
}

/** One page of a workflow's runs; a 404 or a body without a list names the workflow. */
async function runsPage(gh, repo, w, query) {
  let body;
  try {
    body = await gh.rest(`repos/${repo}/actions/workflows/${w.id}/runs?per_page=${RUNS_PER_WORKFLOW}${query}`);
  } catch (err) {
    if (err instanceof GhError && err.status === 404 && !RATE_LIMIT.test(err.message)) {
      throw new GhError(`the runs of workflow ${w.name} (id ${w.id}) answered HTTP 404`, { status: 404 });
    }
    throw err;
  }
  const list = body?.workflow_runs;
  if (!Array.isArray(list)) throw new GhError(`the runs of workflow ${w.name} (id ${w.id}) came back without a workflow_runs list`);
  return list;
}

// The GraphQL query for the check runs (and steps, when asked) of workflow run node ids.
function jobsQuery(ids, steps) {
  const list = ids.map((id) => JSON.stringify(id)).join(",");
  const stepFields = steps ? " steps(first: 50) { nodes { name conclusion } }" : "";
  const first = steps ? 20 : 50;
  return `query { nodes(ids: [${list}]) { ... on WorkflowRun { databaseId checkSuite { checkRuns(first: ${first}) { nodes { databaseId name conclusion startedAt completedAt${stepFields} } } } } } }`;
}

// A value lowercased as text, or null when empty.
const lower = (x) => (x ? String(x).toLowerCase() : null);

// Runs per GraphQL nodes() call. GitHub ends a GraphQL request that takes over
// 10 seconds (docs.github.com, Rate limits and node limits for the GraphQL
// API). With steps, a call of 100 runs answered HTTP 502 after about 10.8 s;
// calls of 25 took about 4 s each (114 runs of a busy repo, 2026-11-03).
export const JOBS_BATCH = 100;

export const JOBS_BATCH_WITH_STEPS = 25;

/**
 * Each run's latest jobs, as REST runs/{id}/jobs would list them, from one
 * GraphQL nodes() call per JOBS_BATCH runs (JOBS_BATCH_WITH_STEPS with steps): an Actions job is a check run with the
 * same id, name, times and, with `steps`, steps. GraphQL gives no job creation
 * time, so these jobs have no queue time. Throws when any run comes back
 * without its jobs. The Tests tab (tests.mjs) reads its jobs with this.
 */
export async function runJobs(gh, runs, { steps = false } = {}) {
  const out = new Map();
  const size = steps ? JOBS_BATCH_WITH_STEPS : JOBS_BATCH;
  for (let i = 0; i < runs.length; i += size) {
    const batch = runs.slice(i, i + size);
    const bad = batch.find((r) => !/^[\w=-]+$/.test(String(r.node_id ?? "")));
    if (bad) throw new Error(`run ${bad.id} has no node_id to look up its jobs`);
    const data = await gh.graphql(jobsQuery(batch.map((r) => r.node_id), steps));
    const byId = new Map((data?.nodes ?? []).filter(Boolean).map((node) => [node.databaseId, node.checkSuite?.checkRuns?.nodes]));
    for (const r of batch) {
      const checks = byId.get(r.id);
      if (!Array.isArray(checks)) throw new Error(`GitHub returned no jobs for run ${r.id}`);
      out.set(
        r.id,
        checks.map((c) => {
          const job = { id: c.databaseId, name: c.name, conclusion: lower(c.conclusion), started_at: c.startedAt, completed_at: c.completedAt };
          if (steps) job.steps = (c.steps?.nodes ?? []).map((s) => ({ name: s.name, conclusion: lower(s.conclusion) }));
          return job;
        }),
      );
    }
  }
  return out;
}

/**
 * Checks that failed, then passed on the same commit. Of the runs that passed
 * or failed, grouped by workflow and head SHA, a group is flaky when a rerun
 * that passed had a failed first attempt (one runs/{id}/attempts/1 call per
 * such rerun), or when a run passed after a failed one. A pull request's run
 * tests its head merged into main as main stood then, so a later new run on
 * the same head can test other code: there only a rerun counts.
 * Returns every group, the flaky ones, and the flaky count per workflow.
 */
const MERGE_REF_EVENTS = new Set(["pull_request", "pull_request_target"]);

/** Workflow-and-commit pairs that failed, then passed on the same commit: { pairs, flaky, byWorkflow }. */
export async function flakyChecks(gh, repo, runs) {
  const decided = runs.filter((r) => r.status === "completed" && (r.conclusion === "success" || r.conclusion === "failure"));
  const pairs = groupBy(decided, (r) => `${r.workflow}\n${r.head_sha}`);
  const reruns = decided.filter((r) => r.run_attempt > 1 && r.conclusion === "success");
  const firstFailed = new Set();
  await mapLimit(reruns, 8, async (r) => {
    const first = await gh.rest(`repos/${repo}/actions/runs/${r.id}/attempts/1`);
    if (first.conclusion === "failure") firstFailed.add(`${r.workflow}\n${r.head_sha}`);
  });
  const flaky = [...pairs].filter(([key, g]) => {
    if (firstFailed.has(key)) return true;
    g = g.filter((r) => !MERGE_REF_EVENTS.has(r.event));
    const firstFail = Math.min(...g.filter((r) => r.conclusion === "failure").map((r) => ms(r.created_at)));
    return g.some((r) => r.conclusion === "success" && ms(r.created_at) > firstFail);
  });
  const byWorkflow = [...groupBy([...pairs.keys()], (k) => k.split("\n")[0])].map(([label]) => ({
    label,
    value: flaky.filter(([k]) => k.split("\n")[0] === label).length,
    unit: "",
  }));
  return { pairs, flaky, byWorkflow };
}

/**
 * A merged pull request's runs: its branch's pull_request runs from its
 * opening to its merge, and the push runs of its merge commit.
 */
export function prRuns(pull, runs) {
  const opened = ms(pull.created_at);
  const merged = ms(pull.merged_at);
  return runs.filter(
    (r) =>
      (r.event === "pull_request" && r.head_branch === pull.head?.ref && ms(r.created_at) >= opened && ms(r.created_at) <= merged) ||
      (r.event === "push" && pull.merge_commit_sha && r.head_sha === pull.merge_commit_sha),
  );
}

/**
 * The latest of `pulls`, newest first, with its runs, or a skip naming why it
 * cannot be priced: it opened before `start`, where the run lists stop
 * covering every workflow, or one of its runs is still going. `self` is the
 * run collecting (GITHUB_RUN_ID): the pages run on a merge commit is always
 * still going while it reads, so it is left out and named, never a reason to
 * skip. The other runs its merge started are still going too on every push
 * to main, and an earlier merge's may be when two land minutes apart, so when
 * only a pull request's merge-commit runs hold it back, the one before it is
 * tried, and the note names each one passed over. When the latest opened
 * before `start`, the newest one in `pulls` that opened after it is priced
 * the same way; with none, a skip. A branch run still going is always a skip.
 */
export function latestPriced(pulls, runs, start, what, self = null) {
  const [pull, next] = pulls;
  if (ms(pull.created_at) < start) return pricedCovered(pulls, runs, start, what, self);
  const all = prRuns(pull, runs);
  const mine = runs.find((r) => self !== null && String(r.id) === String(self));
  const own = all.filter((r) => r !== mine);
  const going = own.filter((r) => !completed(r));
  if (going.length && next && going.every(isMergeRun)) return pricedPast(pull, going, latestPriced(pulls.slice(1), runs, start, what, self), what);
  if (going.length) return { skip: `#${pull.number}, the latest ${what}, has a run still going: ${runName(going[0])}` };
  const left = all.find((r) => r === mine);
  return { pull, runs: own, ...(left ? { self: `this run (${runName(left)}) left out, still going` } : {}) };
}

const runName = (r) => r.workflow ?? r.name;

// Whether `r`, one of a pull request's own runs, is one its merge started: prRuns keeps only the merge commit's push runs.
const isMergeRun = (r) => r.event === "push";

// The note for a pull request priced in place of newer ones: why each was passed over, then the one priced, named once, then the priced pull request's own note.
const pricedNote = (why, older) => {
  const priced = `#${older.pull.number} priced`;
  return older.self?.includes(priced) ? `${why}; ${older.self}` : `${why}; ${priced}${older.self ? `; ${older.self}` : ""}`;
};

// The newest of `pulls` that opened after `start`, in place of the latest,
// which opened before it; the note names both, and with none, the skip names the latest.
function pricedCovered(pulls, runs, start, what, self) {
  const [pull] = pulls;
  const early = `#${pull.number}, the latest ${what}, opened ${utc(ms(pull.created_at))}, before ${utc(start)}, where the runs read stop covering every workflow`;
  const at = pulls.findIndex((p) => ms(p.created_at) >= start);
  if (at < 0) return { skip: early };
  const older = latestPriced(pulls.slice(at), runs, start, what, self);
  return older.skip ? { skip: `${early}; ${older.skip}` } : { ...older, self: pricedNote(early, older) };
}

// An older pull request's pricing, in place of `pull`'s, which only the runs
// its merge started (`going`) hold back; the note names each one passed over.
function pricedPast(pull, going, older, what) {
  const held = `#${pull.number}, the latest ${what}, has runs its merge started still going (${going.map(runName).join(", ")})`;
  return older.skip ? { skip: `${held}; ${older.skip}` } : { ...older, self: pricedNote(held, older) };
}

/**
 * The runner minutes and list-price dollars of described runs (REST jobs),
 * in all and per workflow. Each job bills its minutes rounded up. A job on a
 * runner with no list price makes the dollars unknown, never 0: unpriced
 * names it.
 */
export function priceRuns(described) {
  const byWorkflow = new Map();
  let unpriced = null;
  for (const r of described) {
    const w = byWorkflow.get(r.workflow) ?? { minutes: 0, dollars: 0 };
    for (const j of r.jobs) {
      const rate = runnerRate(j.labels);
      if (rate === null) unpriced ??= `job ${j.name} of ${r.workflow} ran on ${(j.labels ?? []).join(", ") || "no label"}, which is no standard runner with a list price`;
      w.minutes += j.billed;
      w.dollars += j.billed * (rate ?? 0);
    }
    byWorkflow.set(r.workflow, w);
  }
  const sum = (k) => [...byWorkflow.values()].reduce((n, w) => n + w[k], 0);
  return { minutes: sum("minutes"), dollars: sum("dollars"), byWorkflow, unpriced };
}

// One Done card's merged pull requests with the runs to price, or why they cannot be priced yet.
export function pricedCard(card, known, runs, start, self, done) {
  const numbers = [...new Set(card.pulls.filter((p) => p.merged && p.number).map((p) => p.number))];
  const lost = numbers.filter((n) => !known.has(n));
  if (lost.length) return { skip: `#${lost.join(", #")}, linked from the latest ${done} card, is not among the merged pull requests read` };
  const priced = numbers.map((n) => latestPriced([known.get(n)], runs, start, "merged pull request on the latest card", self));
  const stuck = priced.find((p) => p.skip);
  return stuck ? { skip: stuck.skip } : { numbers, priced };
}
