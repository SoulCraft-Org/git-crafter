// How the CI collector describes a run: billed minutes, light runs, the push-to-green wait, cache verdicts and where the runs of every workflow overlap.
import { ms, groupBy, pct, RUNS_PER_WORKFLOW } from "./ci-core.mjs";

// GitHub's own wrapper steps, which no workflow file declares.
const WRAPPER_STEP = /^(Set up job|Complete job|Post )/;

/** A passing run that skipped something and finished within this is light. */
export const LIGHT_SPAN_SECONDS = 60;

/**
 * One run with its jobs, reduced to what the metrics need. A run is light when
 * it did no real work: it was skipped, or it passed, skipped a step or a whole
 * job, and finished within LIGHT_SPAN_SECONDS, as a workflow does when its
 * changes job finds no input that changed. This holds for one job
 * that skips its own steps and for a sharded workflow whose shard jobs are
 * skipped. A failed run is never light: the steps after the failure are
 * skipped because it failed. Each job bills its minutes rounded up, at least
 * 1, as GitHub bills Linux runners. A job without created_at (read through
 * GraphQL) has no queue time.
 */
export function describeRun(run, jobs) {
  const ran = jobs.filter((j) => j.conclusion !== "skipped" && j.started_at && j.completed_at);
  const skippedSomething =
    jobs.some((j) => j.conclusion === "skipped") ||
    ran.some((j) => (j.steps ?? []).some((s) => !WRAPPER_STEP.test(s.name ?? "") && s.conclusion === "skipped"));
  const span = ran.length ? (Math.max(...ran.map((j) => ms(j.completed_at))) - Math.min(...ran.map((j) => ms(j.started_at)))) / 1000 : 0;
  const light = run.conclusion === "skipped" || (run.conclusion === "success" && skippedSomething && span < LIGHT_SPAN_SECONDS);
  const end = ran.length ? Math.max(...ran.map((j) => ms(j.completed_at))) : null;
  return {
    id: run.id,
    workflow: run.workflow ?? run.name,
    event: run.event,
    created_at: run.created_at,
    conclusion: run.conclusion,
    light,
    wall: end === null ? null : (end - ms(run.created_at)) / 60_000,
    billed: ran.reduce((n, j) => n + Math.max(1, Math.ceil((ms(j.completed_at) - ms(j.started_at)) / 60_000)), 0),
    jobs: ran.map((j) => ({
      id: j.id,
      name: j.name,
      conclusion: j.conclusion,
      completed_at: j.completed_at,
      minutes: (ms(j.completed_at) - ms(j.started_at)) / 60_000,
      queue: j.created_at ? Math.max(0, (ms(j.started_at) - ms(j.created_at)) / 1000) : null,
      billed: Math.max(1, Math.ceil((ms(j.completed_at) - ms(j.started_at)) / 60_000)),
      labels: j.labels ?? null,
      restoresCache: (j.steps ?? []).some((s) => /setup-node/i.test(s.name ?? "") && s.conclusion === "success"),
    })),
  };
}

/**
 * Push to all-green per pull request head: from the first run GitHub created
 * for the head SHA to the last one's finish, counted only when every run for
 * that SHA ended green (success or skipped). A head with a failed, cancelled
 * or unfinished run never went green and is left out. With `last`, only the
 * newest that many green heads, by their first run.
 */
export function pushToGreen(runs, last = Infinity) {
  const out = [];
  for (const [sha, group] of groupBy(runs.filter((r) => r.event === "pull_request"), (r) => r.head_sha)) {
    if (group.some((r) => r.status !== "completed")) continue;
    if (!group.every((r) => r.conclusion === "success" || r.conclusion === "skipped")) continue;
    const start = Math.min(...group.map((r) => ms(r.created_at)));
    const end = Math.max(...group.map((r) => ms(r.updated_at)));
    out.push({ sha, start, end, minutes: (end - start) / 60_000 });
  }
  return out.sort((a, b) => b.start - a.start).slice(0, last);
}

/** The npm cache line setup-node writes: hit, miss, or null when the log has neither. */
export function cacheVerdict(log) {
  if (/Cache restored from key/i.test(log)) return "hit";
  if (/cache is not found/i.test(log)) return "miss";
  return null;
}

/**
 * The share of runs that were light, each workflow and event weighted by its
 * completed runs in `runs`: the sample gives each group's light fraction, and
 * the group's run count gives its weight, so a busy workflow counts for more
 * than a quiet one sampled just as deep.
 */
export function weightedLightShare(sample, runs) {
  const counts = groupBy(runs.filter((r) => r.status === "completed"), (r) => `${r.workflow}\n${r.event}`);
  const byWorkflow = new Map();
  for (const [key, g] of groupBy(sample, (r) => `${r.workflow}\n${r.event}`)) {
    const total = counts.get(key)?.length ?? g.length;
    const acc = byWorkflow.get(g[0].workflow) ?? { light: 0, total: 0 };
    acc.light += (g.filter((r) => r.light).length / g.length) * total;
    acc.total += total;
    byWorkflow.set(g[0].workflow, acc);
  }
  const all = [...byWorkflow.values()].reduce((a, b) => ({ light: a.light + b.light, total: a.total + b.total }), { light: 0, total: 0 });
  return {
    share: all.total ? pct(all.light, all.total) : null,
    detail: [...byWorkflow].map(([label, a]) => ({ label, value: pct(a.light, a.total) })),
  };
}

/**
 * Where the runs every list holds start: `since`, or later where a workflow's
 * list is full (it holds `cap` runs, so older ones were not read). The latest
 * such start wins, so a pull request head or a merged pull request after it
 * has all its runs read.
 */
export function commonStart(lists, since, cap = RUNS_PER_WORKFLOW) {
  let start = since;
  for (const list of lists) {
    if (list.length >= cap) start = Math.max(start, Math.min(...list.map((r) => ms(r.created_at))));
  }
  return start;
}
