// What the CI collector keeps of the job logs it reads. A finished job's log never changes, so its parsed verdict (setup-node's
// cache line: hit, miss or none) is recorded in the metric's own entry, which the run files carry (latest.json, and the history
// files main keeps on the quality-history branch), and a later run reads each job's log only once.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { cacheVerdict } from "./ci-describe.mjs";
import { mapLimit } from "./ci-core.mjs";

const VERDICTS = new Set(["hit", "miss", "none"]);
// Where main's earlier runs are (config/quality.json "history"); the newest few are read.
const HISTORY = path.join("data", "quality", "history");
export const HISTORY_READ = 3;
// The verdicts a run file carries on, newest job first: a sample reads 12 jobs, so this is a few runs' worth.
export const VERDICTS_KEPT = 60;

/** The verdicts earlier runs recorded for `metric`, by job id as text; a file that does not read adds none. */
export function savedVerdicts(root, metric) {
  const dir = path.join(root, HISTORY);
  const saved = new Map();
  if (!existsSync(dir)) return saved;
  const files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, HISTORY_READ);
  for (const file of files) {
    try {
      const got = JSON.parse(readFileSync(path.join(dir, file), "utf8"))?.metrics?.[metric]?.verdicts;
      for (const [id, v] of Object.entries(got ?? {})) if (VERDICTS.has(v) && !saved.has(id)) saved.set(id, v);
    } catch {
      // A history file that is not JSON is a gap, never a reason to read nothing.
    }
  }
  return saved;
}

/**
 * Each job's verdict, newest first as given: a saved one is reused, the rest are read from the job's log.
 * Returns { verdicts: Map of job id (text) to hit, miss or none, live: logs read now }.
 */
export async function logVerdicts(gh, repo, jobs, saved) {
  const fresh = jobs.filter((j) => !saved.has(String(j.id)));
  const read = await mapLimit(fresh, 4, async (j) => cacheVerdict(await gh.text(`repos/${repo}/actions/jobs/${j.id}/logs`)) ?? "none");
  const now = new Map(fresh.map((j, i) => [String(j.id), read[i]]));
  return { verdicts: new Map(jobs.map((j) => [String(j.id), now.get(String(j.id)) ?? saved.get(String(j.id))])), live: fresh.length };
}

/** The verdicts to record: the sample's, then earlier ones still known, VERDICTS_KEPT in all, as an object by job id. */
export function keptVerdicts(verdicts, saved) {
  return Object.fromEntries([...verdicts, ...[...saved].filter(([id]) => !verdicts.has(id))].slice(0, VERDICTS_KEPT));
}
