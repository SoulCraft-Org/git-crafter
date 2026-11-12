// The GitHub collector's issue helpers and PR age buckets.

const LAST_CLOSED = 20;

/** The last 20 closed issues, newest close first. */
const lastClosed = (issues) =>
  issues
    .filter((i) => i.state === "CLOSED" && i.closedAt)
    .sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))
    .slice(0, LAST_CLOSED);

// A record: an issue closed by hand within `minutes` of opening, filed for work already done. It was never an open item, so it says nothing about how fixes flow.
const isRecord = (issue, minutes) => minutes > 0 && !closedByMergedPull(issue) && Date.parse(issue.closedAt) - Date.parse(issue.createdAt) <= minutes * 60_000;

/** The last 20 issues closed as done, newest close first. Left out before the 20 are taken: a not-planned or duplicate close, which fixed nothing, and a record. */
export const lastCompleted = (issues, recordMinutes = 0) =>
  lastClosed(issues.filter((i) => i.stateReason !== "NOT_PLANNED" && i.stateReason !== "DUPLICATE" && !(i.state === "CLOSED" && i.closedAt && isRecord(i, recordMinutes))));

// The label names of an issue or PR node.
export const labelsOf = (node) => node.labels.nodes.map((l) => l.name);

// True for Dependabot's login, in any of its forms.
export const isDependabot = (login = "") => /^(app\/)?dependabot(\[bot\])?$/.test(login);

/** True when the closing event was a merged PR, or a commit that came from one. */
export function closedByMergedPull(issue) {
  const closer = issue.closedBy.nodes[0]?.closer;
  if (closer?.__typename === "PullRequest") return closer.merged;
  if (closer?.__typename === "Commit") return closer.associatedPullRequests.nodes.some((p) => p.merged);
  return false;
}

/** Open PRs by age, in the buckets the age histogram shows. */
export const AGE_BUCKETS = [
  { label: "under a day", below: 1 },
  { label: "1 to 3 days", below: 3 },
  { label: "3 to 7 days", below: 7 },
  { label: "a week or more", below: Infinity },
];

// The AGE_BUCKETS label for an age in days.
export const ageBucket = (days) => AGE_BUCKETS.find((b) => days < b.below).label;
