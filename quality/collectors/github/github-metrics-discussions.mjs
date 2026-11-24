// The GitHub collector's Discussions metrics: answerable discussions that no one has answered.
import { measured, notApplicable, count, round1, hours, DAY } from "./github-core.mjs";

// The open discussions in a category that takes an answer and have none, oldest first; null while Discussions is off.
async function unanswered(L) {
  if ((await L.repo()).has_discussions !== true) return null;
  return (await L.discussions()).filter((d) => d.category?.isAnswerable === true && d.isAnswered !== true);
}

const OFF = "Discussions is off on this repo";

/** Each metric reads through the loaders and returns measured(...) or skip(...). */
export const DISCUSSION_METRICS = {
  // Discussions --------------------------------------------------------------
  // State now: a category that takes no answer (Announcements, Polls) has nothing to answer, so it is left out.
  "discussions.unanswered_old": {
    source: "state: gh api graphql: repository.discussions (open: createdAt, isAnswered, category.isAnswerable), against params.discussion_days",
    async run(L, { now, cfg }) {
      const waiting = await unanswered(L);
      if (!waiting) return notApplicable(OFF);
      const old = waiting.filter((d) => now - Date.parse(d.createdAt) > cfg.discussionDays * DAY);
      return measured(old.length, [count("unanswered, over the limit", old.length), count("unanswered, all ages", waiting.length)]);
    },
  },
  // Point in time: the oldest question still waiting, 0 when none waits.
  "discussions.oldest_unanswered_hours": {
    source: "state: gh api graphql: repository.discussions (open: createdAt, isAnswered, category.isAnswerable), the oldest unanswered in an answerable category, age at read time; 0 when none",
    async run(L, { now }) {
      const waiting = await unanswered(L);
      if (!waiting) return notApplicable(OFF);
      if (!waiting.length) return measured(0, [count("unanswered discussions", 0)]);
      const oldest = waiting.reduce((a, b) => (Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b));
      const h = round1(hours(oldest.createdAt, new Date(now).toISOString()));
      return measured(h, [{ label: `#${oldest.number}`, value: h, unit: "hours" }]);
    },
  },
};
