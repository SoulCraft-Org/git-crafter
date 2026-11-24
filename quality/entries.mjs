// How a metric's entry is read and merged across runs: whether it holds a measurement or a does-not-apply
// reason, and which of two runs' entries wins. score.mjs re-exports mergeMetrics, isMeasured and isNotApplicable.

// One metric's entry from the CI run and the local run together. A read value
// beats a could_not_check; between two read values the newer read wins; a
// collector's own reason beats a placeholder one (weak, from currentMetrics),
// and of two such reasons the newer run's wins.
export function mergeMetrics(...runs) {
  const merged = {};
  const at = {};
  for (const run of runs.filter(Boolean)) {
    for (const [id, entry] of Object.entries(run.metrics ?? {})) {
      if (replaces(merged[id], entry, at[id], run.generated_at)) [merged[id], at[id]] = [entry, run.generated_at];
    }
  }
  return merged;
}

// Whether `entry` should take the place of `prev` (undefined when none yet).
// Of two collector reasons, the newer run's says why now: a reason a
// maintainer's run wrote yesterday never hides CI's of today. `prevAt` and
// `at` are the runs' generated_at.
function replaces(prev, entry, prevAt = "", at = "") {
  if (!prev) return true;
  if (isNotApplicable(entry) || isNotApplicable(prev)) return settled(prev, entry, prevAt, at);
  if (isMeasured(entry)) return readLater(prev, entry);
  if (isMeasured(prev) || isWeak(entry)) return false;
  return isWeak(prev) || (at ?? "") > (prevAt ?? "");
}

// A does-not-apply entry states a fact as a measurement does: it beats a blank one, and of it and a measurement
// the newer run wins, so a feature turned off since the last local run does not keep its old count.
function settled(prev, entry, prevAt, at) {
  const blank = (e) => !isMeasured(e) && !isNotApplicable(e);
  if (blank(entry)) return false;
  return blank(prev) || (at ?? "") > (prevAt ?? "");
}

// A measured entry takes the place of a blank one, or of an older reading.
function readLater(prev, entry) {
  return !isMeasured(prev) || (entry.read_at ?? "") > (prev.read_at ?? "");
}

// True when the entry holds a finite number and no could_not_check.
export function isMeasured(entry) {
  return Boolean(entry) && entry.could_not_check === undefined && typeof entry.value === "number" && Number.isFinite(entry.value);
}

// True when a collector says the metric cannot apply here and gives the reason in words.
export const isNotApplicable = (entry) => typeof entry?.not_applicable === "string" && entry.not_applicable.trim() !== "" && entry.value === undefined && entry.could_not_check === undefined;

// Weak: a placeholder reason (currentMetrics; files from before it say
// `unreported`).
const isWeak = (entry) => Boolean(entry?.weak || entry?.unreported);
