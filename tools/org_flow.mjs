// The PR flow and CI metrics, from merged and open PRs and workflow runs.

import { DAY, flat, HOUR, lastN, mapRead, metric, newest, ORG, perRepo, PR_WEEKS, share, tagRepo } from "./org_base.mjs";
import { LAST_N, TEST_PATTERN } from "./workflows.mjs";

// ---- PR flow -------------------------------------------------------------

// merged: { repo: [{ number, createdAt, mergedAt, rollup }] | null }
// open:   { repo: [{ number, title, createdAt, baseRefName, mergeable, stack }] | null }
// failures: { merged: { repo: reason }, open: { repo: reason } }
export function prMetrics({ repos, merged, open, defaults, now, readAt, failures = {} }) {
  const ctx = { repos, n: repos.length, t: now.getTime(), readAt, failures };
  const src = "gh api graphql: repository.pullRequests (states MERGED, createdAt, mergedAt, head commit statusCheckRollup; states OPEN, mergeable, baseRefName, stack)";
  return { ...mergedMetrics(ctx, merged, src), ...openMetrics(ctx, open, defaults, src) };
}

// How fast and how green work merges: the latest merge, the pace of the last 10, and the share merged green.
function mergedMetrics({ repos, n, t, readAt, failures }, merged, src) {
  const hours = (p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / HOUR;
  const mergedAt = (p) => Date.parse(p.mergedAt);
  const out = {};
  const tagged = tagRepo(repos, merged);

  // The latest merge, in each repo and across the org.
  const ttm = perRepo(repos, merged, (rows) => {
    const p = newest(rows, mergedAt);
    return p ? hours(p) : null;
  });
  const last = newest(tagged, mergedAt);
  out["pr.latest_merge_hours"] = metric(ttm, n, failures.merged, false, ttm.org, "h", src, readAt, {
    detail: last ? [{ label: `${last.repo}#${last.number}`, value: hours(last), unit: "h" }] : [],
  });

  // How often work merges, read now: the hours from the 10th-latest merge to the read, so a stall
  // shows at once. 10 a day reads under 24. With fewer than 10 merges in the weeks read, the value
  // is at least those weeks, so it reads that bound, never could_not_check.
  const TENTH = 10;
  const bound = PR_WEEKS * 7 * 24;
  const tenthOf = (rows) => {
    const tenth = lastN(rows, mergedAt)[TENTH - 1];
    return tenth ? (t - mergedAt(tenth)) / HOUR : bound;
  };
  const ten = perRepo(repos, merged, tenthOf);
  const tenth = lastN(tagged, mergedAt)[TENTH - 1];
  const boundRepos = repos.filter((r) => merged[r] && !lastN(merged[r], mergedAt)[TENTH - 1]);
  out["pr.latest_10_merges_hours"] = metric(ten, n, failures.merged, false, ten.org, "h", `${src}; the hours from the 10th-latest merge, across repos by mergedAt, to the read`, readAt, {
    detail: [tenth ? { label: `${tenth.repo}#${tenth.number}, the 10th-latest merge`, value: (t - mergedAt(tenth)) / HOUR, unit: "h" } : { label: `fewer than ${TENTH} merges in the ${PR_WEEKS} weeks read: at least`, value: bound, unit: "h" }],
    bound: !tenth,
    bound_repos: boundRepos,
  });

  // A share of each repo's last LAST_N merges.
  const lastMerged = mapRead(repos, merged, (rows) => lastN(rows, mergedAt));
  const all = flat(repos, lastMerged);
  const greenShare = (rows) => {
    const checked = rows.filter((p) => p.rollup);
    return share(checked.filter((p) => p.rollup === "SUCCESS").length, checked.length);
  };
  const green = perRepo(repos, lastMerged, greenShare);
  out["pr.green_at_merge"] = metric(green, n, failures.merged, false, green.org, "%", `${src}; each repo's last ${LAST_N} merges`, readAt, {
    detail: [
      { label: "green", value: all.filter((p) => p.rollup === "SUCCESS").length, unit: "PRs" },
      { label: "not green", value: all.filter((p) => p.rollup && p.rollup !== "SUCCESS").length, unit: "PRs" },
      { label: "no checks", value: all.filter((p) => !p.rollup).length, unit: "PRs" },
    ],
  });
  return out;
}

// What waits to merge: open PRs, those in conflict, those stacked on another branch by hand, and the conflict-free share.
// A layer of a GitHub stack targets the layer below it by design and merges through the stack, so it is no hand-made stack.
function openMetrics({ repos, n, t, readAt, failures }, open, defaults, src) {
  const out = {};
  const openR = mapRead(repos, open, (rows, r) => rows.map((p) => ({ ...p, repo: r })));
  const openAll = flat(repos, openR);
  const age = (p) => (t - Date.parse(p.createdAt)) / DAY;
  const listOf = (rows, label) => rows.sort((a, b) => age(b) - age(a)).map((p) => ({ label: label(p), value: age(p), unit: "days open" }));
  const count = (pred) => perRepo(repos, openR, (rows) => rows.filter(pred).length);
  const conflict = (p) => p.mergeable === "CONFLICTING";
  const stacked = (p) => p.baseRefName !== defaults[p.repo] && !p.stack;
  const c = count(conflict);
  out["pr.conflicts_open"] = metric(c, n, failures.open, true, c.org, "PRs", src, readAt, { detail: listOf(openAll.filter(conflict), (p) => `${p.repo}#${p.number} ${p.title}`) });
  const s = count(stacked);
  out["pr.stacked_open"] = metric(s, n, failures.open, true, s.org, "PRs", src, readAt, { detail: listOf(openAll.filter(stacked), (p) => `${p.repo}#${p.number} onto ${p.baseRefName}`) });
  const o = count(() => true);
  out["pr.open"] = metric(o, n, failures.open, true, o.org, "PRs", src, readAt, {
    detail: [{ label: "unknown mergeable state", value: openAll.filter((p) => p.mergeable === "UNKNOWN").length, unit: "PRs" }],
  });
  const freeShare = (rows) => (rows.length ? share(rows.filter((p) => !conflict(p)).length, rows.length) : 100);
  const free = perRepo(repos, openR, freeShare);
  out["pr.conflict_free_share"] = metric(free, n, failures.open, true, free.org, "%", src, readAt);
  return out;
}

// ---- CI and tests --------------------------------------------------------

const PASS = new Set(["success"]);
const FAIL = new Set(["failure", "timed_out", "startup_failure"]);
const PUSH_EVENTS = new Set(["push", "pull_request", "pull_request_target", "merge_group"]);
// One test pattern, shared with the Testing tab's suite finder.
export const TEST_WORKFLOW = TEST_PATTERN;

const runs_ = (n) => `${n} run${n === 1 ? "" : "s"}`;
// Dependabot names each update run after its packages ("... - Update #123"),
// and those names can contain "vitest", so they are never test runs.
const isDependabot = (x) => x.event === "dynamic" || / - Update #\d+$/.test(x.name);
const runMinutes = (r) => Math.max(0, (Date.parse(r.updated_at) - Date.parse(r.run_started_at ?? r.created_at)) / 60_000);
const passRate = (rows) => {
  const p = rows.filter((r) => PASS.has(r.conclusion)).length;
  return share(p, p + rows.filter((r) => FAIL.has(r.conclusion)).length);
};

// For each commit CI ran on: minutes from the first run's creation to the last
// run's end, counted only when every run on that commit passed or skipped.
export function pushToGreen(runs) {
  const bySha = new Map();
  for (const r of runs.filter((x) => PUSH_EVENTS.has(x.event))) {
    if (!bySha.has(r.head_sha)) bySha.set(r.head_sha, []);
    bySha.get(r.head_sha).push(r);
  }
  const out = [];
  for (const [sha, list] of bySha) {
    if (list.some((r) => r.status !== "completed")) continue;
    if (!list.some((r) => r.conclusion === "success")) continue;
    if (list.some((r) => !["success", "skipped", "neutral"].includes(r.conclusion))) continue;
    const start = Math.min(...list.map((r) => Date.parse(r.created_at)));
    const end = Math.max(...list.map((r) => Date.parse(r.updated_at)));
    out.push({ sha, at: start, minutes: (end - start) / 60_000 });
  }
  return out;
}

// runs: { repo: [run] | null }, each run slimmed by fetchRuns; failures: { repo: reason }.
export function ciMetrics({ repos, runs, now, readAt, failures = {} }) {
  const n = repos.length;
  const created = (x) => Date.parse(x.created_at);
  const done = mapRead(repos, runs, (rows) => rows.filter((x) => x.status === "completed"));
  // Pass rates read each repo's last LAST_N decided runs (passed or failed), the
  // cancelled share its last LAST_N completed runs; times, the latest green commit.
  const decided = (x) => PASS.has(x.conclusion) || FAIL.has(x.conclusion);
  const last = mapRead(repos, done, (rows) => lastN(rows, created));
  const lastDecided = mapRead(repos, done, (rows) => lastN(rows.filter(decided), created));
  const tests = mapRead(repos, done, (rows) => lastN(rows.filter((x) => decided(x) && !isDependabot(x) && TEST_WORKFLOW.test(`${x.name} ${x.path}`)), created));
  const src = `gh api repos/${ORG}/{repo}/actions/runs (created, completed runs; conclusion, created_at, run_started_at, updated_at, head_sha, event)`;
  const workflowName = (x) => (isDependabot(x) ? "Dependabot updates" : x.name);
  const byWorkflow = (rows) => {
    const groups = new Map();
    for (const x of rows) groups.set(workflowName(x), [...(groups.get(workflowName(x)) ?? []), x]);
    return [...groups].map(([name, list]) => ({ name, list, rate: passRate(list) })).filter((g) => g.rate !== null);
  };
  const out = {};

  const pr = perRepo(repos, lastDecided, passRate);
  out["ci.pass_rate"] = metric(pr, n, failures, false, pr.org, "%", `${src}; each repo's last ${LAST_N} decided runs, passed or failed`, readAt, {
    detail: byWorkflow(flat(repos, lastDecided)).sort((a, b) => a.rate - b.rate || b.list.length - a.list.length).map((g) => ({ label: `${g.name} (${runs_(g.list.length)})`, value: g.rate, unit: "%" })),
  });

  const tr = perRepo(repos, tests, passRate);
  out["tests.pass_rate"] = metric(tr, n, failures, false, tr.org, "%", `${src}; each repo's last ${LAST_N} decided runs of workflows whose name or file matches ${TEST_WORKFLOW}, Dependabot runs left out`, readAt, {
    detail: byWorkflow(repos.flatMap((r) => (tests[r] ?? []).map((x) => ({ ...x, name: `${r}: ${workflowName(x)}` }))))
      .sort((a, b) => a.rate - b.rate)
      .map((g) => ({ label: `${g.name} (${runs_(g.list.length)})`, value: g.rate, unit: "%" })),
    reason: "no workflow named for tests ran in the runs read",
  });

  const cancelled = (rows) => share(rows.filter((x) => x.conclusion === "cancelled").length, rows.length);
  const cs = perRepo(repos, last, cancelled);
  out["ci.cancelled_share"] = metric(cs, n, failures, false, cs.org, "%", `${src}; each repo's last ${LAST_N} completed runs`, readAt);

  // The latest commit whose runs all passed: its push to green, and the run minutes it took.
  // Every run, unfinished ones too: a commit with a run still going is not green yet.
  const greens = mapRead(repos, runs, (rows) =>
    pushToGreen(rows).map((g) => ({ ...g, spent: rows.filter((x) => x.head_sha === g.sha && PUSH_EVENTS.has(x.event)).reduce((a, x) => a + runMinutes(x), 0) })),
  );
  const at = (g) => g.at;
  const latest = newest(tagRepo(repos, greens), at);
  const where = latest ? `${latest.repo} ${latest.sha.slice(0, 7)}` : "";
  const ptg = perRepo(repos, greens, (rows) => newest(rows, at)?.minutes ?? null);
  out["ci.latest_push_to_green_minutes"] = metric(ptg, n, failures, false, ptg.org, "min", `${src}; the latest commit whose runs all passed, first run created to last run done`, readAt, {
    detail: latest ? [{ label: where, value: latest.minutes, unit: "min" }] : [],
  });
  const spent = perRepo(repos, greens, (rows) => newest(rows, at)?.spent ?? null);
  out["ci.latest_commit_minutes"] = metric(spent, n, failures, false, spent.org, "min", `${src}; the latest commit whose runs all passed, its runs' wall time (run_started_at to updated_at) summed, not billed job minutes`, readAt, {
    detail: latest ? [{ label: where, value: latest.spent, unit: "min" }] : [],
  });
  return out;
}
