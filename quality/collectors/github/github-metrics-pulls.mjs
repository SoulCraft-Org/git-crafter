// The GitHub collector's pull-request metrics: each reads through the loaders and returns measured(...) or skip(...).
import { skip, measured, pct, count, round1, hours, tally, percentile, DAY } from "./github-core.mjs";
import { reviewedAt, privateMarkerAuthors, fixedAfterReview, reverts, reviewedLines, readLines, greenAt, isGreen, headReview, FLOW_STAGES } from "./github-reviews.mjs";
import { unfenced, proseWords, hasTable, linksIssue } from "./github-text.mjs";
import { ageBucket, AGE_BUCKETS, isDependabot, labelsOf } from "./github-flow.mjs";

// GitHub computes a PR's mergeability lazily and resets it after each merge to
// the default branch, which is when the page builds. A read that finds UNKNOWN
// waits this long and reads once more.
const MERGEABLE_RETRY_MS = 5000;
// How many of the latest merges pull_requests.green_to_merge_minutes takes the median of.
const GREEN_TO_MERGE_N = 10;
const MINUTE = 60_000;
// Verdict comments whose every author reads as a non-member: a private org member seen by a token outside the org.
const PRIVATE_AUTHORS = "every Review: MERGE|BLOCK comment reads as from a non-member, so the reviewer's org membership is private to this token; make it public (GitHub org People) or collect with a token in the org";

// The note when a merge commit is not in the checkout: its moved lines count in full, as GitHub's totals do.
const MOVES_UNREAD = "moved lines counted in full: the merge commit is not in this checkout (check out with fetch-depth: 0)";

export const PULL_METRICS = {
  // Pull requests ------------------------------------------------------------
  // Holds up: green, reviewed at head, right first time, not reverted.
  "pull_requests.green_at_head": {
    source: "gh api graphql: last 20 merged pullRequests (head statusCheckRollup: SUCCESS, or each check's latest run passed)",
    async run(L) {
      const pulls = await L.merged();
      const checked = pulls.filter((p) => p.headCommit.nodes[0]?.commit.statusCheckRollup);
      if (!checked.length) return skip("no merged PR with checks yet");
      const green = checked.filter((p) => isGreen(p.headCommit.nodes[0].commit.statusCheckRollup)).length;
      return measured(pct(green, checked.length), [
        count("green", green),
        count("red or pending", checked.length - green),
        count("no checks (left out)", pulls.length - checked.length),
      ]);
    },
  },
  "pull_requests.reviewed": {
    source: "gh api graphql: last 20 merged pullRequests (headRefOid, mergedAt; reviews' commit.oid, submittedAt, author type; members' Review: MERGE|BLOCK at <sha> comments)",
    async run(L) {
      const pulls = await L.merged();
      if (!pulls.length) return skip("no merged PRs yet");
      if (privateMarkerAuthors(pulls)) return { could_not_check: PRIVATE_AUTHORS };
      const where = pulls.map(reviewedAt);
      const atHead = where.filter((w) => w === "head").length;
      const other = where.filter((w) => w === "other").length;
      return measured(pct(atHead, pulls.length), [
        count("reviewed at the merged head", atHead),
        count("reviewed another commit, or after merge", other),
        count("not reviewed", pulls.length - atHead - other),
      ]);
    },
  },
  "pull_requests.fixed_after_review": {
    source: "gh api graphql: last 20 merged pullRequests (headRefOid; reviews' commit.oid, submittedAt, author type; members' Review: MERGE|BLOCK at <sha> comments)",
    async run(L) {
      const pulls = await L.merged();
      if (!pulls.length) return skip("no merged PRs yet");
      // A PR counts when it had a review or a verdict before the merge (fixedAfterReview),
      // by its own author too: a review's author is checked only for being a Bot.
      const reviewed = pulls.filter((p) => fixedAfterReview(p) !== null);
      if (!reviewed.length) return skip(`none of the last ${pulls.length} merged PRs had a review or a verdict before its merge; pull_requests.reviewed scores them as not reviewed`);
      const fixed = reviewed.filter(fixedAfterReview).length;
      return measured(pct(fixed, reviewed.length), [
        count("fixed after the first review", fixed),
        count("merged as first reviewed", reviewed.length - fixed),
        count("no review before merge (left out)", pulls.length - reviewed.length),
      ]);
    },
  },
  "pull_requests.reverted": {
    source: 'gh api graphql: last 20 merged pullRequests (title, mergedAt); a revert is titled Revert "<title>"',
    async run(L) {
      // Every revert among the last 20 merges counts, however old the PR it undoes.
      const found = reverts(await L.merged());
      const detail = found.map((r) =>
        r.original
          ? { label: `#${r.pull.number} reverts #${r.original.number}`, value: round1(r.days), unit: "days" }
          : count(`#${r.pull.number} reverts a PR before the last 20`, 1),
      );
      return measured(found.length, detail.length ? detail : undefined);
    },
  },
  "pull_requests.commits_via_pr": {
    source: "gh api graphql: last 20 commits on the default branch (associatedPullRequests)",
    async run(L) {
      const commits = await L.branchCommits();
      if (!commits.length) return skip("no commits on the default branch");
      const viaPull = commits.filter((c) => c.associatedPullRequests.nodes.some((p) => p.merged)).length;
      return measured(pct(viaPull, commits.length), [count("through a merged PR", viaPull), count("pushed directly", commits.length - viaPull)]);
    },
  },
  // A PR merged into a side branch is a hand-made stack: the default branch's rules and checks may not have applied to it.
  // A GitHub stack layer keeps its side-branch base after merging (#808 into claude/pr-size-gate, read 2026-11-11), but
  // the stack merges every layer onto the default branch under its rules, so it is skipped.
  "pull_requests.merged_off_default": {
    source: "gh api graphql: last 20 merged pullRequests (baseRefName, baseRepository.defaultBranchRef.name, stack)",
    async run(L, { cfg }) {
      const pulls = await L.merged();
      if (!pulls.length) return skip("no merged PRs yet");
      // Both names come with the PRs, in the one GraphQL read: a spent REST limit cannot blank this.
      const off = pulls.filter((p) => p.baseRefName && p.baseRepository?.defaultBranchRef?.name && p.baseRefName !== p.baseRepository.defaultBranchRef.name && !p.stack);
      const detail = off.map((p) => ({ label: `#${p.number} into ${p.baseRefName}`, value: reviewedLines(p, cfg.notReviewed).lines, unit: "lines" }));
      return measured(off.length, detail.length ? detail : undefined);
    },
  },

  // Size: lines a person reads, lockfiles and data snapshots left out. PR
  // descriptions: prose is what is left outside tables, code and diagrams.
  "pull_requests.latest_body_words": {
    source: "gh api graphql: of the last 20 merged pullRequests (body), the latest with a description; words outside tables, fenced code and diagrams, inline code and HTML comments (proseWords in github.mjs)",
    async run(L, { cfg }) {
      const pulls = await L.merged();
      if (!pulls.length) return skip("no merged PRs yet");
      // An empty description has no prose to score; it is passed over here and
      // counts against pull_requests.body_table_share, so it never scores best.
      const i = pulls.findIndex((p) => unfenced(p.body ?? "", cfg.bodyIgnore).trim());
      if (i < 0) return skip("no merged PR among the last 20 has a description");
      const words = proseWords(pulls[i].body, cfg.bodyIgnore);
      return measured(words, [{ label: `#${pulls[i].number}`, value: words, unit: "words" }, count("newer merges with an empty description, passed over", i)]);
    },
  },
  "pull_requests.body_table_share": {
    source: "gh api graphql: last 20 merged pullRequests (body), the share with a markdown table outside fenced code (hasTable in github.mjs)",
    async run(L, { cfg }) {
      const pulls = await L.merged();
      if (!pulls.length) return skip("no merged PRs yet");
      const withTable = pulls.filter((p) => hasTable(p.body ?? "", cfg.bodyIgnore)).length;
      return measured(pct(withTable, pulls.length), [count("with a table", withTable), count("merged PRs read", pulls.length)]);
    },
  },
  "pull_requests.linked_issue_share": {
    source: "gh api graphql: the body of each of the last 20 merged pullRequests (N = 20, a template choice: enough for a median, few enough that new merges replace them); a closing keyword (close, fix or resolve) or Part of before an issue reference, outside fenced blocks (linksIssue in github.mjs)",
    async run(L, { cfg }) {
      const pulls = await L.merged();
      if (!pulls.length) return skip("no merged PRs yet");
      const linked = pulls.filter((p) => linksIssue(p.body, cfg.bodyIgnore)).length;
      return measured(pct(linked, pulls.length), [count("linking an issue", linked), count("merged PRs read", pulls.length)]);
    },
  },
  "pull_requests.latest_lines": {
    source: "gh api graphql: the latest merged pullRequest (additions, deletions, files, mergeCommit); git diff of its merge commit for moved lines",
    async run(L, { cfg }) {
      const [latest] = await L.merged();
      if (!latest) return skip("no merged PRs yet");
      const patch = L.patch(latest);
      const { lines, skipped, moved } = readLines(latest, cfg.notReviewed, patch ?? []);
      const result = measured(lines, [
        { label: `#${latest.number}`, value: lines, unit: "lines" },
        { label: "lockfile and snapshot lines left out", value: skipped, unit: "lines" },
        { label: "moved lines left out", value: moved, unit: "lines" },
      ]);
      return patch ? result : { ...result, note: MOVES_UNREAD };
    },
  },
  "pull_requests.over_400_lines": {
    source: "gh api graphql: last 20 merged pullRequests (additions, deletions, files, mergeCommit); git diff of each merge commit for moved lines",
    async run(L, { cfg }) {
      const pulls = await L.merged();
      if (!pulls.length) return skip("no merged PRs yet");
      const patches = pulls.map((p) => L.patch(p));
      const over = pulls.filter((p, i) => readLines(p, cfg.notReviewed, patches[i] ?? []).lines > 400).length;
      const unread = patches.filter((x) => !x).length;
      const result = measured(pct(over, pulls.length), [count("over 400 lines", over), count("400 lines or fewer", pulls.length - over)]);
      return unread ? { ...result, note: `${MOVES_UNREAD} (${unread} of ${pulls.length})` } : result;
    },
  },

  // Flow: open, then every check green, then a review at head, then merged.
  "pull_requests.latest_merge_hours": {
    source: "gh api graphql: the latest merged pullRequest (createdAt, mergedAt; head check times; reviews)",
    async run(L) {
      const [latest] = await L.merged();
      if (!latest) return skip("no merged PRs yet");
      // The stages of that one PR; a stage it skipped, such as a review, has no row.
      const stages = FLOW_STAGES.map((stage) => ({ label: stage.label, value: stage.span(latest) })).filter((d) => d.value !== null);
      const total = round1(hours(latest.createdAt, latest.mergedAt));
      return measured(total, [{ label: `#${latest.number}, open to merge`, value: total }, ...stages.map((d) => ({ label: d.label, value: round1(d.value) }))]);
    },
  },
  // The wait after CI: from every check green on the merged head to the merge.
  "pull_requests.green_to_merge_minutes": {
    source: `gh api graphql: the last ${GREEN_TO_MERGE_N} merged pullRequests (N = ${GREEN_TO_MERGE_N}, a template choice), median of mergedAt minus the last check's completion on the merged head, for each PR whose head rollup is SUCCESS`,
    async run(L) {
      const pulls = (await L.merged()).slice(0, GREEN_TO_MERGE_N);
      if (!pulls.length) return skip("no merged PRs yet");
      const timed = pulls.map((p) => ({ p, green: greenAt(p) })).filter((x) => x.green !== null);
      if (!timed.length) return skip(`no check times read: none of the last ${pulls.length} merged PRs has an all-green head with completed checks`);
      const rows = timed.map(({ p, green }) => ({ label: `#${p.number}`, value: round1(Math.max(0, Date.parse(p.mergedAt) - green) / MINUTE), unit: "minutes" }));
      const untimed = pulls.length - timed.length;
      return measured(round1(percentile(rows.map((r) => r.value), 0.5)), [...rows, ...(untimed ? [{ label: "merged without an all-green head", value: untimed, unit: "PRs" }] : [])]);
    },
  },
  // Queue: what waits now.
  "pull_requests.open_now": {
    source: "gh api graphql: open pullRequests (createdAt)",
    async run(L, { now }) {
      const open = await L.open();
      const buckets = tally(
        open.map((p) => ageBucket((now - Date.parse(p.createdAt)) / DAY)),
        AGE_BUCKETS.map((b) => b.label),
      );
      return measured(open.length, buckets);
    },
  },
  // The live twin of green_to_merge_minutes: what is green and waits now, for a review or for the merge.
  "pull_requests.green_waiting_minutes": {
    source: "gh api graphql: open pullRequests (isDraft, author; head statusCheckRollup and check times; reviews, reviewDecision, reviewRequests; members' Review: MERGE|BLOCK at <sha> comments)",
    async run(L, { now }) {
      // Drafts are not ready and Dependabot's PRs are rated by pull_requests.dependabot_open.
      const ready = (await L.open()).filter((p) => !p.isDraft && !isDependabot(p.author?.login));
      if (privateMarkerAuthors(ready)) return { could_not_check: PRIVATE_AUTHORS };
      // A PR blocked at its head waits on its author, and a red or pending one on its checks.
      const waiting = ready.map((p) => ({ p, green: greenAt(p), review: headReview(p) })).filter((w) => w.green !== null && w.review !== "blocked");
      const rows = waiting
        .map(({ p, green, review }) => ({ label: `#${p.number}, ${review === "passed" ? "reviewed, awaiting merge" : "awaiting review"}`, value: round1(Math.max(0, now - green) / MINUTE), unit: "minutes" }))
        .sort((a, b) => b.value - a.value);
      const requested = waiting.filter(({ p }) => p.reviewRequests?.totalCount > 0).length;
      return measured(rows[0]?.value ?? 0, [...rows.slice(0, 5), { label: "with a pending review request", value: requested, unit: "PRs" }]);
    },
  },
  "pull_requests.conflicting": {
    source: "gh api graphql: open pullRequests (mergeable), read again after 5 s while GitHub is still computing it",
    async run(L, { now, sleep }) {
      const isUnknown = (p) => p.mergeable === "UNKNOWN";
      let open = await L.open();
      if (open.some(isUnknown)) {
        await sleep(MERGEABLE_RETRY_MS);
        open = await L.openAgain();
      }
      // Counting CONFLICTING while some are still UNKNOWN would undercount.
      const unknown = open.filter(isUnknown).length;
      if (unknown) return skip(`GitHub had not computed mergeability for ${unknown} open PR${unknown === 1 ? "" : "s"} after a second read`);
      const conflicting = open.filter((p) => p.mergeable === "CONFLICTING");
      const detail = conflicting.map((p) => ({ label: `#${p.number}`, value: round1((now - Date.parse(p.createdAt)) / DAY), unit: "days open" }));
      return measured(conflicting.length, detail.length ? detail : undefined);
    },
  },
  "pull_requests.oldest_open_days": {
    source: "gh api graphql: open pullRequests (createdAt)",
    async run(L, { now }) {
      const open = await L.open();
      if (!open.length) return measured(0, [count("open PRs", 0)]);
      const ages = open
        .map((p) => ({ label: `#${p.number}`, value: round1((now - Date.parse(p.createdAt)) / DAY) }))
        .sort((a, b) => b.value - a.value);
      return measured(ages[0].value, ages.slice(0, 5));
    },
  },
  "pull_requests.dependabot_open": {
    source: "gh api graphql: open pullRequests (author dependabot, labels)",
    async run(L) {
      const bots = (await L.open()).filter((p) => isDependabot(p.author?.login));
      const ecosystem = (p) => labelsOf(p).find((l) => l !== "dependencies") ?? "other";
      return measured(bots.length, tally(bots.map(ecosystem)));
    },
  },
};
