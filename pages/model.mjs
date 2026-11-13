// The numbers both Git Crafter pages derive from goals.json, the repo's maps and
// data/org.json: each goal rated against its target, per repo too, each
// outcome's score, and each map step's readout.
// Pure functions; render.mjs draws them.

import { finite, scoreStatus } from "../quality/render/charts.mjs";

// True when the entry holds a finite number and no could_not_check.
export const isMeasured = (e) => Boolean(e) && e.could_not_check === undefined && finite(e.value);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// The banded rule of quality/score.mjs scoreMetric:
// meeting the goal is worth 100, the near band 50, past it 0.
export function rate(def, value) {
  if (!finite(value)) return { status: "not-measured", points: null };
  const atLeast = (edge) => (def.direction === "higher" ? value >= edge : value <= edge);
  if (atLeast(def.goal)) return { status: "meets", points: 100 };
  if (atLeast(def.near)) return { status: "near", points: 50 };
  return { status: "misses", points: 0 };
}

// Where a value sits between the near edge (0) and the goal (1), so goals in
// hours, percents and tokens share one axis. Below 0 misses, 1 and up meets.
export function position(def, value) {
  if (!finite(value)) return null;
  if (def.goal === def.near) return rate(def, value).status === "meets" ? 1.5 : -0.5;
  // + 0 turns a -0 (value at near, direction lower) into 0.
  return Math.min(Math.max((value - def.near) / (def.goal - def.near), -1), 2) + 0;
}

// Compact, as the site writes it: "≤ 2M tokens".
export const goalText = (def, fmtCompact) => `${def.direction === "higher" ? "≥" : "≤"} ${fmtCompact(def.goal, def.unit)}`;

// Every goal rated, org-wide and per repo, grouped by outcome.
export function rateGoals(goalsDoc, data) {
  const repos = (data.repos ?? []).map((r) => r.name);
  return goalsDoc.outcomes.map((o) => {
    const goals = o.goals.map((g) => {
      const entry = data.metrics?.[g.metrics[0]];
      const value = isMeasured(entry) ? entry.value : null;
      // per_repo: false marks an org-wide total; no repo is rated against it.
      const perRepo = g.per_repo !== false && Boolean(entry?.by_repo);
      const byRepo = {};
      if (perRepo) {
        for (const r of repos) {
          const v = entry.by_repo[r];
          byRepo[r] = { value: finite(v) ? v : null, ...rate(g, finite(v) ? v : null) };
        }
      }
      return { ...g, outcome: o.id, entry, value, ...rate(g, value), pos: position(g, value), byRepo, hasRepos: perRepo };
    });
    const pts = goals.map((g) => g.points).filter(finite);
    const score = pts.length ? Math.round(mean(pts)) : null;
    return { ...o, goals, score, status: scoreStatus(score), measured: pts.length };
  });
}

// Each repo's share of goal points over the goals measured for it.
export function repoScores(outcomes, repos) {
  const goals = outcomes.flatMap((o) => o.goals).filter((g) => g.hasRepos);
  return Object.fromEntries(
    repos.map((r) => {
      const pts = goals.map((g) => g.byRepo[r]?.points).filter(finite);
      return [r, { score: pts.length ? Math.round(mean(pts)) : null, measured: pts.length, total: goals.length }];
    }),
  );
}

// A metric's value in each history snapshot, oldest first.
export const historySeries = (history, id) =>
  history.map((h) => ({ label: h.generated_at.slice(0, 10), value: h.values?.[id] ?? null })).filter((p) => finite(p.value));

// Each outcome's score in each snapshot, rated with today's goals.
export function outcomeHistory(goalsDoc, history) {
  return Object.fromEntries(
    goalsDoc.outcomes.map((o) => [
      o.id,
      history
        .map((h) => {
          const pts = o.goals.map((g) => rate(g, h.values?.[g.metrics[0]] ?? null).points).filter(finite);
          return { label: h.generated_at.slice(0, 10), value: pts.length ? Math.round(mean(pts)) : null };
        })
        .filter((p) => finite(p.value)),
    ]),
  );
}

// Two metrics only the build can know: how old the data is, and how much of
// what the goals ask for was measured.
export function withComputed(data, goalsDoc, builtAt) {
  const metrics = { ...data.metrics };
  const age = (builtAt.getTime() - Date.parse(data.generated_at)) / 3_600_000;
  metrics["data.age_hours"] = { label: "Data age at build", value: Math.round(age * 10) / 10, unit: "h", source: `build time less data/org.json generated_at (${data.generated_at})`, read_at: builtAt.toISOString() };
  const ids = goalsDoc.outcomes.flatMap((o) => o.goals.map((g) => g.metrics[0]));
  const n = ids.filter((id) => isMeasured(metrics[id])).length;
  metrics["data.measured_share"] = {
    label: "Goals measured",
    value: Math.round((n / ids.length) * 1000) / 10,
    unit: "%",
    source: "rated goals in goals.json whose metric data/org.json measured",
    read_at: builtAt.toISOString(),
    detail: [
      { label: "measured", value: n, unit: "goals" },
      { label: "not measured", value: ids.length - n, unit: "goals" },
    ],
  };
  return { ...data, metrics };
}

// The goal that rates a metric, by its first metric id.
export const goalIndex = (goalsDoc) => Object.fromEntries(goalsDoc.outcomes.flatMap((o) => o.goals.map((g) => [g.metrics[0], g])));

// One map step's readout: its one metric, rated by that metric's definition
// on the repo's Quality page (def), else by a Git Crafter goal or a copied target
// when the page could not read the definitions. A number copied from another
// repo is that repo's, so the step reads not measured rather than show it.
export function stepReadout(step, metrics, { def = null, goals = {}, ownRepo = null } = {}) {
  const id = step.metric;
  const e = readEntry(metrics[id], ownRepo);
  const g = def ?? goals[id] ?? targetGoal(e);
  const ok = isMeasured(e);
  return {
    id,
    kind: def?.kind ?? null,
    goalId: goals[id]?.id ?? null,
    entry: e,
    value: ok ? e.value : null,
    byRepo: perRepo(e),
    unit: e?.unit ?? g?.unit ?? "",
    label: def?.label ?? e?.label ?? id,
    def: g,
    status: stepStatus(g, ok, e),
  };
}

// The metric's entry, or a could-not-check stand-in when its number was copied from another repo.
function readEntry(got, ownRepo) {
  const foreign = Boolean(ownRepo && got?.copied_from && got.copied_from !== ownRepo);
  return foreign ? { label: got.label, could_not_check: `${got.copied_from}'s number, not ${ownRepo}'s`, source: got.source } : got;
}

// The copied target as a goal, when it has a finite goal.
const targetGoal = (e) => (e?.target && finite(e.target.goal) ? e.target : null);

// Per-repo values where the metric has them; a repo it could not read is null.
const perRepo = (e) => (e?.by_repo ? Object.fromEntries(Object.entries(e.by_repo).map(([r, v]) => [r, finite(v) ? v : null])) : null);

// The rating of a step's value against its goal; not-measured when it has no goal and no number.
function stepStatus(g, ok, e) {
  if (g) return rate(g, ok ? e.value : null).status;
  return ok ? null : "not-measured";
}

// The step a map opens on: the first that misses its goal, else the first
// near it, else the first step.
export function openingStep(steps, readouts) {
  for (const status of ["misses", "near"]) {
    const hit = steps.find((s) => readouts[s.id]?.status === status);
    if (hit) return hit.id;
  }
  return steps[0]?.id ?? null;
}
