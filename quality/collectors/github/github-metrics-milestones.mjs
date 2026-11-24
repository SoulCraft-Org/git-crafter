// The GitHub collector's Milestones metric: open milestones that are undated, past their date, or done and left open.
import { measured, count } from "./github-core.mjs";

// Why an open milestone is off track, in the order the detail lists them; empty when it is on track.
function faults(m, now) {
  const out = [];
  if (!m.due_on) out.push("no due date");
  else if (Date.parse(m.due_on) < now) out.push("past its due date");
  if (m.open_issues === 0 && m.closed_issues > 0) out.push("every issue closed");
  return out;
}

/** Each metric reads through the loaders and returns measured(...) or skip(...). */
export const MILESTONE_METRICS = {
  // Milestones ---------------------------------------------------------------
  // State now. A milestone that has no issue yet is new, so it is on track until it is dated and filled.
  "issues.milestones_off_track": {
    source: "state: gh api repos/{repo}/milestones?state=open (due_on, open_issues, closed_issues), against the read time",
    async run(L, { now }) {
      const open = await L.milestones();
      const bad = open.map((m) => faults(m, now));
      const named = ["no due date", "past its due date", "every issue closed"];
      return measured(bad.filter((f) => f.length).length, [count("open milestones", open.length), ...named.map((w) => count(w, bad.filter((f) => f.includes(w)).length))]);
    },
  },
};
