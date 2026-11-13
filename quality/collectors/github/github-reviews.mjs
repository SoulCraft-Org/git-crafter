// How the GitHub collector reads a PR's review: the markers a reviewer leaves, when it was green and reviewed, fixes after review, reverts and the stages a change flows through.
import { DAY, HOUR, hours } from "./github-core.mjs";

// A review verdict posted as a PR comment, for a repo where one account
// authors, reviews and merges, so GitHub records no review: the first line is
// exactly "Review: MERGE at <sha>" or "Review: BLOCK at <sha>", the full 40-hex SHA.
const MARKER = /^Review: (MERGE|BLOCK) at ([0-9a-f]{40})$/;

// Only these can post one: no outside account can forge a verdict.
const MARKER_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The commits a verdict may name: the PR's head and its own commits. */
const commitsOf = (pull) => new Set([pull.headRefOid, ...(pull.markerCommits?.nodes ?? []).map((n) => n.commit?.oid)].filter(Boolean));

/**
 * A merged PR's marker verdicts, { at, oid, verdict }: each from a member,
 * naming one of the PR's own commits or its head. A comment is read as it is
 * now, so it is timed by its last edit: one edited into a MERGE after the
 * merge is a verdict after the merge.
 */
export function reviewMarkers(pull) {
  const oids = commitsOf(pull);
  return (pull.markerComments?.nodes ?? []).flatMap((c) => {
    const m = MARKER.exec(String(c.body ?? "").split("\n", 1)[0].replace(/\r$/, ""));
    const at = c.lastEditedAt ?? c.createdAt;
    return m && at && MARKER_AUTHORS.has(c.authorAssociation) && oids.has(m[2]) ? [{ at, oid: m[2], verdict: m[1] }] : [];
  });
}

/**
 * Whether the PRs hold verdict comments and every author reads as a non-member.
 * GitHub shows a private org member as CONTRIBUTOR to a token that is not in
 * the org, so the verdicts exist but cannot be told from an outsider's. That
 * is a read the token cannot make, not a PR that went unreviewed.
 */
export function privateMarkerAuthors(pulls) {
  // Only a verdict naming one of the PR's own commits counts, as in reviewMarkers: anyone can post the words.
  const found = pulls.flatMap((p) => {
    const oids = commitsOf(p);
    return (p.markerComments?.nodes ?? []).filter((c) => oids.has(MARKER.exec(String(c.body ?? "").split("\n", 1)[0].replace(/\r$/, ""))?.[2]));
  });
  return found.length > 0 && !found.some((c) => MARKER_AUTHORS.has(c.authorAssociation));
}

/**
 * Every review of a PR, oldest first, { at, oid, verdict }: a person's GitHub
 * reviews (bots left out; verdict null) and its marker verdicts. Reads each
 * review's commit.oid, submittedAt and author type, never its body.
 */
function reviewEvents(pull) {
  const reviews = (pull.reviews?.nodes ?? []).filter((r) => r.submittedAt && r.author?.__typename !== "Bot").map((r) => ({ at: r.submittedAt, oid: r.commit?.oid ?? null, verdict: null }));
  return [...reviews, ...reviewMarkers(pull)].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Where a merged PR's reviews landed. "head" when a review passed the commit
 * the PR merged at, no later than the merge (reviewAtHead): a fix makes a new
 * head that needs a new review. "other" when every review read another
 * commit, came after the merge or carries no commit, or the last verdict at
 * the head was BLOCK; "none" when nobody reviewed.
 */
export function reviewedAt(pull) {
  if (!reviewEvents(pull).length) return "none";
  return reviewAtHead(pull) ? "head" : "other";
}

/**
 * Files whose lines say nothing about review effort: lockfiles, which a tool
 * writes, generated code, and this page's own data snapshots. A repo adds its
 * own in params.not_reviewed. Size metrics leave their lines out, because the
 * SmartBear and Cisco study's limit is on code a person reads.
 */
export const NOT_REVIEWED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/,
  /^quality\/(data|history)\//,
  /^data\/quality\//,
  /(^|\/)generated\//,
];

/** Whether a changed file is one a reviewer does not read: a built-in pattern or one of `extra`. */
export const isNotReviewed = (file, extra = []) => [...NOT_REVIEWED, ...extra].some((re) => re.test(file));

/**
 * Lines a person reads in a PR: additions plus deletions, minus not-reviewed
 * files and files removed whole (changeType DELETED). A reviewer of a removed
 * file checks what still names it, not its lines.
 */
export function reviewedLines(pull, extra = []) {
  const nodes = pull.files?.nodes ?? [];
  const sum = (files) => files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const skipped = sum(nodes.filter((f) => isNotReviewed(f.path, extra)));
  const removed = sum(nodes.filter((f) => f.changeType === "DELETED" && !isNotReviewed(f.path, extra)));
  return { lines: Math.max(0, pull.additions + pull.deletions - skipped - removed), skipped };
}

/**
 * The removed lines that come back as added lines, matched once each across
 * `files` after trimming: a move a reviewer need not read twice. A file with
 * no `patch` matches nothing, so it counts in full.
 */
export function movedPairs(files) {
  const sides = { "-": [], "+": [] };
  for (const f of files) for (const l of (f.patch ?? "").split("\n")) sides[l[0]]?.push(l.slice(1).trim());
  const removed = new Map();
  for (const l of sides["-"]) removed.set(l, (removed.get(l) ?? 0) + 1);
  let pairs = 0;
  for (const l of sides["+"]) if (removed.get(l) > 0) removed.set(l, removed.get(l) - 1), pairs++;
  return pairs;
}

/**
 * The changed files in `git diff --unified=0` output, each as
 * { filename, additions, deletions, patch }, the shape sizeMiss and readLines read,
 * with deleted: true for a file removed whole. A file's header runs to its first
 * hunk, so a removed line that reads "--- x" is a line, not a header. A rename
 * with no edit has no lines.
 */
export function diffFiles(text) {
  const files = [];
  let f;
  for (const l of text.split("\n")) {
    if (l.startsWith("diff --git ")) {
      f = { filename: l.replace(/^diff --git a\/.* b\//, ""), additions: 0, deletions: 0, lines: [], head: true };
      files.push(f);
    } else if (!f) continue;
    else if (f.head) {
      if (l.startsWith("@@")) f.head = false;
      else if (l.startsWith("deleted file mode")) f.deleted = true;
      else if (/^(\+\+\+ b\/|rename to )/.test(l)) f.filename = l.replace(/^(\+\+\+ b\/|rename to )/, "");
    } else if (l[0] === "+" || l[0] === "-") {
      f[l[0] === "+" ? "additions" : "deletions"]++;
      f.lines.push(l);
    }
  }
  return files.map(({ filename, additions, deletions, lines, deleted }) => ({ filename, additions, deletions, patch: lines.join("\n"), ...(deleted && { deleted }) }));
}

/**
 * reviewedLines less two for each moved pair among `patch`'s reviewed files
 * (diffFiles' shape): a line moved from one place to another is read once,
 * as the pull request gate reads it. A file removed whole counted no lines,
 * so a pair from it takes off only its added line. No patch moves nothing.
 */
export function readLines(pull, extra = [], patch = []) {
  const { lines, skipped } = reviewedLines(pull, extra);
  const read = patch.filter((f) => !isNotReviewed(f.filename, extra));
  const moved = Math.min(lines, movedPairs(read.filter((f) => !f.deleted)) + movedPairs(read));
  return { lines: lines - moved, skipped, moved };
}

// What a finished check may conclude without failing its commit.
const PASSED = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Whether a commit's checks all passed at the end: its rollup is SUCCESS, or
 * each check's latest run passed. GitHub's rollup counts every run of a check
 * on a commit, so a run that was cancelled or failed and then ran again, on an
 * edit or a re-run from another event, keeps the commit red though the check
 * passed, where the merge box shows the latest. A check still running, or one
 * this query cannot name, is not green.
 */
export function isGreen(rollup) {
  if (!rollup) return false;
  if (rollup.state === "SUCCESS") return true;
  const latest = latestRuns(rollup.contexts?.nodes ?? []);
  return Boolean(latest?.size) && [...latest.values()].every((run) => run.ok);
}

// One check run or status as { at, ok }: when it finished and whether it passed. One still going sorts last and fails.
const runOf = (c) => {
  const at = Date.parse(c.completedAt ?? c.createdAt);
  return Number.isFinite(at) ? { at, ok: PASSED.has(c.conclusion ?? c.state) } : { at: Infinity, ok: false };
};

// What groups a check's runs: its workflow and its name, so one job name in two workflows stays two checks.
const checkKey = (c) => {
  const name = c.name ?? c.context;
  return name && `${c.checkSuite?.workflowRun?.workflow?.name ?? ""}/${name}`;
};

// The latest run of each named check, or null when one has no name to group it by.
function latestRuns(nodes) {
  const latest = new Map();
  for (const c of nodes) {
    const key = checkKey(c);
    if (!key) return null;
    const run = runOf(c);
    if (!(latest.get(key)?.at > run.at)) latest.set(key, run);
  }
  return latest;
}

/** When every check on the merged head had finished, or null unless they all passed. */
export function greenAt(pull) {
  const rollup = pull.headCommit?.nodes[0]?.commit.statusCheckRollup;
  if (!isGreen(rollup)) return null;
  const times = (rollup.contexts?.nodes ?? []).map((c) => Date.parse(c.completedAt ?? c.createdAt)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

/** The reviews and verdicts before the merge, oldest first. */
function reviewsBeforeMerge(pull) {
  const merged = Date.parse(pull.mergedAt);
  return reviewEvents(pull).filter((r) => Date.parse(r.at) <= merged);
}

/**
 * The review that passed the commit the PR merged at, before the merge, or
 * null. Where verdicts name that commit, the last one decides: a MERGE passes
 * it, a later BLOCK takes that back. With none, a person's first review of it.
 */
function reviewAtHead(pull) {
  const review = decidingAtHead(pull, reviewsBeforeMerge(pull));
  return review?.verdict === "BLOCK" ? null : review;
}

/** Among `events`, the one that decides a PR's head: the last verdict naming it, else a person's first review of it, else null. */
function decidingAtHead(pull, events) {
  const atHead = events.filter((r) => pull.headRefOid && r.oid === pull.headRefOid);
  return atHead.filter((r) => r.verdict).at(-1) ?? atHead[0] ?? null;
}

/**
 * How an open PR's head stands, with no merge time to bound its reviews:
 * "blocked" when the last verdict naming it is BLOCK or GitHub's review
 * decision asks for changes, so it waits on its author; "passed" when a
 * verdict or a person's review passed it; "none" when nobody has read it.
 */
export function headReview(pull) {
  const review = decidingAtHead(pull, reviewEvents(pull));
  if (review?.verdict === "BLOCK" || pull.reviewDecision === "CHANGES_REQUESTED") return "blocked";
  return review ? "passed" : "none";
}

/**
 * Whether a merged PR failed its first review: null when nobody reviewed it
 * before the merge, true when that first review read a commit other than the
 * one the PR merged at, as a BLOCK at an earlier head does, or was a BLOCK of
 * the head it merged at anyway.
 */
export function fixedAfterReview(pull) {
  const first = reviewsBeforeMerge(pull)[0];
  return first ? first.oid !== pull.headRefOid || first.verdict === "BLOCK" : null;
}

/**
 * Reverts among the merged PRs: a PR titled 'Revert "X"', as GitHub's Revert
 * button names it, paired with the latest PR titled X that merged before it.
 * Latest, then highest number, so the pairing never depends on input order.
 */
export function reverts(pulls) {
  const out = [];
  for (const p of pulls) {
    const m = /^Revert "(.+)"$/.exec(p.title ?? "");
    if (!m) continue;
    const original = pulls
      .filter((o) => o.title === m[1] && Date.parse(o.mergedAt) <= Date.parse(p.mergedAt))
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt) || b.number - a.number)[0];
    out.push({ pull: p, original, days: original ? (Date.parse(p.mergedAt) - Date.parse(original.mergedAt)) / DAY : null });
  }
  return out;
}

/**
 * A merged PR's way to the default branch, in three stages timed on the commit
 * it merged at: opened, every check green, a person's review of that commit,
 * merged. A stage's span is null when the PR never reached it (red at head, or
 * no review at head). Only pull_requests.latest_merge_hours reads them, as the
 * latest merge's breakdown.
 */
export const FLOW_STAGES = [
  {
    label: "open to all green",
    span: (p) => {
      const green = greenAt(p);
      return green === null ? null : Math.max(0, (green - Date.parse(p.createdAt)) / HOUR);
    },
  },
  {
    label: "all green to review",
    span: (p) => {
      const green = greenAt(p);
      const review = reviewAtHead(p);
      return green === null || !review ? null : Math.max(0, (Date.parse(review.at) - green) / HOUR);
    },
  },
  {
    label: "review to merge",
    span: (p) => {
      const review = reviewAtHead(p);
      return review ? hours(review.at, p.mergedAt) : null;
    },
  },
];
