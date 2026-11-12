// The CI collector's pipeline detail: each stage's latest minutes and pass rate.
import { pipelineStages } from "./ci-stages.mjs";
import { STAGE_ORDER, pct, groupBy, round1, newest, ms } from "./ci-core.mjs";
import { pushToGreen } from "./ci-describe.mjs";

/**
 * Fills each stage's latest minutes and pass rate; null where nothing records
 * it. A workflow is timed by its latest run that did real work, created to
 * finished, so a check that usually skips still shows how long it takes when
 * it runs; its pass rate and light_share read its last LAST_RUNS runs. The
 * review and deploy stages time the latest merge of the last LAST_PRS.
 */
export async function pipelineDetail(L, root, cfg) {
  const stages = pipelineStages(root, { ...cfg, branch: await L.branch() });
  const stats = await workflowStats(L);
  const review = await reviewStat(L);
  if (review) stats.set("review", review);
  const builds = await deployBuilds(L);
  const detail = [];
  for (const s of stages) {
    if (s.key === "deploy" && builds.length) {
      for (const b of builds) detail.push({ label: b.name, value: b.value, unit: "minutes", stage: s.stage, kind: s.kind, runs: s.runs, file: s.file, pass_rate: b.pass_rate });
      continue;
    }
    const st = stats.get(s.key) ?? { value: null, pass_rate: null };
    const item = { label: s.label, value: st.value, unit: "minutes", stage: s.stage, kind: s.kind, runs: s.runs, file: s.file, pass_rate: st.pass_rate };
    if (st.light_share > 0) item.light_share = st.light_share;
    detail.push(item);
  }
  return detail.sort((a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage));
}

// ok as a percent of all, or null when all is 0.
const rate = (ok, all) => (all ? pct(ok, all) : null);

/** Workflow stages keep null statistics when the runs cannot be read; the stages still come from the files. */
async function workflowStats(L) {
  const stats = new Map();
  try {
    for (const [key, g] of groupBy(await L.described(), (r) => `${r.workflow}\n${r.event}`)) {
      const decided = g.filter((r) => (r.conclusion === "success" || r.conclusion === "failure") && r.wall !== null);
      if (!decided.length) continue;
      const real = decided.filter((r) => r.conclusion === "success" && !r.light);
      stats.set(key, {
        value: round1(newest(real.length ? real : decided).wall),
        pass_rate: rate(decided.filter((r) => r.conclusion === "success").length, decided.length),
        light_share: pct(g.filter((r) => r.light).length, g.filter((r) => r.conclusion !== "cancelled").length),
      });
    }
  } catch {
    // Workflow stages keep null statistics.
  }
  return stats;
}

/** The review stage: the latest merge's wait from all green to merged, and the share of closed PRs merged; null when unreadable. */
async function reviewStat(L) {
  try {
    const green = new Map(pushToGreen((await L.covered()).runs).map((g) => [g.sha, g.end]));
    const { closed, merged } = await L.pulls();
    // Null when the latest merge's head never went all green in the runs read (merged is newest first).
    const end = green.get(merged[0]?.head?.sha);
    const wait = end !== undefined && ms(merged[0].merged_at) >= end ? (ms(merged[0].merged_at) - end) / 60_000 : null;
    return { value: wait === null ? null : round1(wait), pass_rate: rate(closed.filter((p) => p.merged_at).length, closed.length) };
  } catch {
    return null; // The review stage keeps null statistics.
  }
}

/** Each deploy check's minutes from the latest merge to its finish, and its pass rate; none when unreadable. */
async function deployBuilds(L) {
  const builds = [];
  try {
    const decided = (await L.deployChecks()).filter((c) => c.completed_at && c.merged_at && (c.conclusion === "success" || c.conclusion === "failure"));
    for (const [name, g] of groupBy(decided, (c) => c.name)) {
      const timed = g.filter((c) => ms(c.completed_at) >= ms(c.merged_at));
      const last = timed.length ? timed.reduce((a, b) => (ms(b.merged_at) > ms(a.merged_at) ? b : a)) : null;
      builds.push({ name, value: last ? round1((ms(last.completed_at) - ms(last.merged_at)) / 60_000) : null, pass_rate: rate(g.filter((c) => c.conclusion === "success").length, g.length) });
    }
  } catch {
    // A deploy stage stays one node with null statistics.
  }
  return builds;
}
