// The CI collector's Consumption metrics that price one event's own runs from their REST jobs: the latest merge (Pull requests tab), fix (Issues), Done card (Projects), security scans (Security) and push to the default branch (Actions).
import { projectSettings } from "../github/github.mjs";
import { LAST, LAST_PRS, QUEUE_SAMPLE, TARGETS_FILE, completed, groupBy, mapLimit, measured, ms, newest, round1, round3, skip } from "./ci-core.mjs";
import { latestPriced, pricedCard, priceRuns } from "./ci-runs.mjs";

// How many of the newest Done cards the card metric tries before it gives up.
const CARDS_TRIED = 5;

// How many of the newest pushes to the default branch the push metric tries before it gives up.
export const PUSHES_TRIED = 5;

/**
 * The latest push to `branch` whose runs can all be priced: its push runs,
 * grouped by head commit, newest first. A push whose runs include `self`
 * (GITHUB_RUN_ID, the run collecting, always still going) or a run still
 * going is passed over for the one before it, and the note names each one.
 */
export function latestPush(runs, branch, self = null) {
  const heads = [...groupBy(runs.filter((r) => r.event === "push" && r.head_branch === branch), (r) => r.head_sha)]
    .sort(([, a], [, b]) => ms(newest(b).created_at) - ms(newest(a).created_at))
    .slice(0, PUSHES_TRIED);
  if (!heads.length) return { skip: `no push to ${branch} among the runs read` };
  const passed = [];
  for (const [sha, list] of heads) {
    const short = String(sha).slice(0, 7);
    const going = list.find((r) => !completed(r));
    if (self !== null && list.some((r) => String(r.id) === String(self))) passed.push(`${short}, this run's push, still going`);
    else if (going) passed.push(`${short} has a run still going: ${going.workflow ?? going.name}`);
    else return { sha, runs: list, note: [...passed.map((p) => `${p}, passed over`), `${short} priced`].join("; ") };
  }
  return { skip: `none of the latest ${heads.length} pushes to ${branch} can be priced yet: ${passed.join("; ")}` };
}

/** The metrics, in the shape ci.mjs's METRICS table holds. */
export const SPEND_METRICS = {
  "ci.latest_main_push_minutes": {
    source: "latest: gh api actions/workflows/{id}/runs, the push runs of the latest commit on the default branch whose runs all ended; their REST jobs' billed runner minutes (gh api actions/runs/{id}/jobs, one call per run at most, each read once), summed",
    async run(L, { selfRun }) {
      const branch = await L.branch();
      const push = latestPush((await L.covered()).runs, branch, selfRun);
      if (push.skip) return skip(push.skip);
      const cost = priceRuns(await mapLimit(push.runs, 8, (r) => L.jobsOf(r)));
      return { ...measured(cost.minutes, [...cost.byWorkflow].map(([label, w]) => ({ label, value: w.minutes }))), note: push.note };
    },
  },
  "ci.latest_pr_dollars": {
    source: `latest: gh api pulls (the latest of the last ${LAST_PRS} merged) and actions/workflows/{id}/runs (its branch runs and merge commit runs); their REST jobs, one call per run at most, each read once and most already read for the queue sample: each job's billed minutes times its runs-on label's rate from GitHub docs, Actions runner pricing`,
    async run(L, ctx) {
      const { start, runs } = await L.covered();
      const { merged } = await L.pulls();
      if (!merged.length) return skip("no merged pull request among the closed ones read");
      const latest = latestPriced(merged, runs, start, "merged pull request", ctx.selfRun);
      if (latest.skip) return skip(latest.skip);
      const cost = priceRuns(await mapLimit(latest.runs, 8, (r) => L.jobsOf(r)));
      if (cost.unpriced) return skip(cost.unpriced);
      return { ...measured(round3(cost.dollars), [...cost.byWorkflow].map(([label, w]) => ({ label, value: round3(w.dollars) }))), note: [`#${latest.pull.number}`, latest.self].filter(Boolean).join("; ") };
    },
  },
  "issues.latest_fix_ci_minutes": {
    source: "latest: GraphQL pullRequests closingIssuesReferences: the latest merged pull request that closed an issue; its runs (gh api actions/workflows/{id}/runs) and their REST jobs' billed runner minutes (one call per run at most, each read once), over the issues it closed",
    async run(L, ctx) {
      const { start, runs } = await L.covered();
      const closes = await L.closes();
      const fixing = (await L.pulls()).allMerged.filter((p) => (closes.get(p.number) ?? 0) > 0);
      if (!fixing.length) return skip("no merged pull request among the closed ones read closed an issue");
      const latest = latestPriced(fixing, runs, start, "merged pull request that closed an issue", ctx.selfRun);
      if (latest.skip) return skip(latest.skip);
      const issues = closes.get(latest.pull.number);
      const cost = priceRuns(await mapLimit(latest.runs, 8, (r) => L.jobsOf(r)));
      const per = (m) => round1(m / issues);
      return { ...measured(per(cost.minutes), [...cost.byWorkflow].map(([label, w]) => ({ label, value: per(w.minutes) }))), note: [`#${latest.pull.number} closed ${issues} issue${issues === 1 ? "" : "s"}`, latest.self].filter(Boolean).join("; ") };
    },
  },
  "projects.latest_card_ci_minutes": {
    source: "latest: the board named by github.json's params.project_title (gh api graphql, projectsV2): of the five cards most recently moved to the done column that link merged pull requests, the newest whose runs can be priced; their runs (gh api actions/workflows/{id}/runs) and REST jobs' billed runner minutes (one call per run at most, each read once), summed and divided by those pull requests",
    async run(L, ctx) {
      const { mode, cfg } = ctx;
      if (mode === "ci") return skip("needs the project scope: gh auth refresh -s project; refreshed by a --local collect run");
      const { start, runs } = await L.covered();
      const board = projectSettings(cfg.boardParams, ctx.repo);
      if (board.columns.length < 2) return skip("params.project_columns in targets/github.json needs at least two columns: the last is done");
      const items = await L.board();
      if (!items) return skip(`no project named ${board.projectTitle} yet; set params.project_title in targets/github.json`);
      const done = board.columns.at(-1);
      const cards = items.filter((i) => i.status === done && i.statusAt && i.pulls.some((p) => p.merged && p.number)).sort((a, b) => ms(b.statusAt) - ms(a.statusAt)).slice(0, CARDS_TRIED);
      if (!cards.length) return skip(`no ${done} card links a merged pull request yet`);
      const known = new Map((await L.pulls()).allMerged.map((p) => [p.number, p]));
      // The newest card is often unpriceable for minutes after its merge, while that merge's runs go: price the newest that can be.
      const tried = cards.map((card) => ({ card, ...pricedCard(card, known, runs, start, ctx.selfRun, done) }));
      const got = tried.find((t) => !t.skip);
      if (!got) return skip(tried[0].skip);
      const passed = tried.indexOf(got);
      const cost = priceRuns(await mapLimit(got.priced.flatMap((p) => p.runs), 8, (r) => L.jobsOf(r)));
      const per = (m) => round1(m / got.numbers.length);
      const notes = [`${got.numbers.map((n) => `#${n}`).join(", ")} of the card done ${got.card.statusAt.slice(0, 10)}`, passed ? `${passed} newer card${passed === 1 ? "" : "s"} passed over, not yet priceable` : null, got.priced.find((p) => p.self)?.self];
      return { ...measured(per(cost.minutes), [...cost.byWorkflow].map(([label, w]) => ({ label, value: per(w.minutes) }))), note: notes.filter(Boolean).join("; ") };
    },
  },
  "security.latest_scan_minutes": {
    source: `latest: gh api actions/runs/{id}/jobs: each workflow named like params.security_workflows, the repo's own (its latest run that did real work, of its newest ${QUEUE_SAMPLE} of the ${LAST}) and GitHub's dynamic ones such as CodeQL default setup (its latest passed run); billed runner minutes, summed`,
    async run(L, { cfg }) {
      const real = (r) => r.conclusion === "success" && !r.light;
      const pick = (g) => newest(g.some(real) ? g.filter(real) : g);
      const own = [...groupBy((await L.queued()).filter((r) => cfg.securityWorkflows.test(r.workflow)), (r) => r.workflow)].map(([w, g]) => [w, pick(g)]);
      const scans = [...own, ...(await L.dynamicScans())];
      if (!scans.length) return skip(`no workflow's name matches params.security_workflows (${cfg.securityWorkflows.source}) in ${TARGETS_FILE}`);
      const detail = scans.map(([label, r]) => ({ label, value: round1(r.billed) }));
      return measured(round1(detail.reduce((n, d) => n + d.value, 0)), detail);
    },
  },
};
