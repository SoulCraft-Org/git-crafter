// More tests for the GitHub collector, split out of github.test.mjs to keep each file under the size limit.
// Run with `node --test quality/collectors/github/github-more.test.mjs`. Shared fixtures live in github-test-lib.mjs.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { cardOf } from "./github-reads.mjs";
import { collect, GhError, ghClient, hasPicture, hasTable, hasVisual, isNotReviewed, linksIssue, METRIC_IDS, percentile, proseWords, repoOf, reverts } from "./github.mjs";
import { HERE, FIXTURES, TARGETS, TEMPLATE_PARAMS, REST, GRAPHQL, PARAMS, NOW, REPO, HOUR_MS, FOOTER, fakeGh, run } from "./github-test-lib.mjs";

describe("collect() fails open", () => {
  const assertAllSkipped = (out) => {
    for (const [id, m] of Object.entries(out)) {
      assert.equal(m.value, undefined, `${id} must not report a value`);
      assert.ok(typeof m.could_not_check === "string" && m.could_not_check.length > 0, `${id}: could_not_check reason`);
      assert.ok(m.source, `${id}: source`);
    }
  };

  it("turns a missing gh, network and checkout into could_not_check for every metric", async () => {
    const broken = {
      rest: async () => {
        throw new GhError("gh is not installed; install the GitHub CLI and run gh auth login");
      },
      restAll: async () => {
        throw new GhError("gh is not installed; install the GitHub CLI and run gh auth login");
      },
      graphql: async () => {
        throw new GhError("gh is not installed; install the GitHub CLI and run gh auth login");
      },
    };
    const out = await run({
      root: path.join(FIXTURES, "does-not-exist"),
      gh: broken,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.deepEqual(Object.keys(out).sort(), [...METRIC_IDS].sort());
    assertAllSkipped(out);
    assert.match(out["issues.open_bugs"].could_not_check, /gh is not installed/);
    assert.match(out["security.headers"].could_not_check, /fetch failed/);
  });

  it("skips admin reads in ci mode without calling gh for them", async () => {
    const gh = fakeGh();
    const out = await run({ mode: "ci", gh });
    for (const t of TARGETS.filter((x) => x.needs === "github-admin")) {
      assert.equal(out[t.id].could_not_check, "needs an admin token; refreshed by a --local collect run", t.id);
    }
    for (const t of TARGETS.filter((x) => x.needs === "project-scope")) {
      assert.match(out[t.id].could_not_check, /^needs the project scope: gh auth refresh -s project/, t.id);
    }
    assert.ok(!gh.calls.some((c) => /\/protection|rules\/branches|ProjectFind/.test(c)), gh.calls.join(", "));
    // The open-alert counts are the exception: a workflow can grant vulnerability-alerts: read itself, so CI tries, in one shared read.
    assert.equal(gh.calls.filter((c) => /dependabot\/alerts/.test(c)).length, 1, gh.calls.join(", "));
    assert.equal(out["issues.open_bugs"].value, 2, "non-admin metrics still measure in ci mode");
  });

  it("names the project scope when GraphQL refuses the Projects query", async () => {
    const graphql = { ...GRAPHQL, ProjectFind: { __error: { message: "Your token has not been granted the required scopes", type: "INSUFFICIENT_SCOPES" } } };
    const out = await run({ gh: fakeGh({ graphql }) });
    for (const id of METRIC_IDS.filter((x) => x.startsWith("projects."))) {
      assert.equal(out[id].could_not_check, "needs the project scope: gh auth refresh -s project", id);
    }
  });

  it("names the admin token when a 403 hides admin data", async () => {
    const rest = { ...REST, [`repos/${REPO}/dependabot/alerts?per_page=100`]: { __error: { status: 403, message: "Resource not accessible by integration" } } };
    const out = await run({ gh: fakeGh({ rest }) });
    assert.equal(out["security.oldest_open_alert_days"].could_not_check, "needs an admin token; refreshed by a --local collect run");
    assert.equal(out["security.dependabot_open"].could_not_check, "needs vulnerability-alerts: read on the workflow's token; refreshed by a --local collect run", "the open counts name the permission a workflow can grant");
  });

  it("reports no completed close yet, rather than 0, on a repo with no issues", async () => {
    const none = { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    const graphql = { ...GRAPHQL, Issues: none, OpenIssueTypes: none };
    const out = await run({ gh: fakeGh({ graphql }) });
    for (const id of ["issues.closed_by_pr", "issues.reopened", "issues.latest_close_hours"]) {
      assert.equal(out[id].could_not_check, id === "issues.closed_by_pr" ? "no bug closed as completed yet" : "no issue closed as completed yet", id);
    }
    assert.equal(out["issues.area_labeled"].could_not_check, "no issues yet");
    assert.equal(out["issues.open_bugs"].value, 0, "zero open bugs is a real reading");
    assert.equal(out["issues.oldest_open_days"].value, 0, "no open issue waits");
  });

  it("takes the last 20 completed closes after leaving out not-planned ones, so moving work to the board shrinks no base", async () => {
    const T0 = Date.parse("2026-10-01T00:00:00Z");
    const at = (h) => new Date(T0 + h * HOUR_MS).toISOString();
    const issue = (n, opened, closed, stateReason, closer) => ({
      number: n, state: "CLOSED", stateReason, createdAt: at(opened), closedAt: at(closed), issueType: { name: "Bug" }, labels: { nodes: [{ name: "bug" }] },
      closedBy: { nodes: [{ closer }] }, reopened: { totalCount: 0 },
    });
    // 20 fixed by a merged PR an hour after filing, then 15 older ones closed as not planned, all closed later.
    const fixed = Array.from({ length: 20 }, (_, i) => issue(i + 1, 100 + i, 101 + i, "COMPLETED", { __typename: "PullRequest", merged: true }));
    const moved = Array.from({ length: 15 }, (_, i) => issue(i + 21, i, 200 + i, "NOT_PLANNED", null));
    const graphql = { ...GRAPHQL, Issues: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [...fixed, ...moved] } } } };
    const out = await run({ gh: fakeGh({ graphql }) });
    assert.equal(out["issues.closed_by_pr"].value, 100);
    assert.deepEqual(out["issues.closed_by_pr"].detail[0], { label: "closed by a merged PR", value: 20, unit: "" });
    assert.equal(out["issues.reopened"].detail.at(-1).value, 20);
    assert.equal(out["issues.latest_close_hours"].value, 1, "the latest fix, not the latest not-planned close");
  });

  it("leaves a record and a chore out of the bug metric: only a bug that was open counts", async () => {
    const T0 = Date.parse("2026-10-01T00:00:00Z");
    const at = (min) => new Date(T0 + min * 60_000).toISOString();
    const issue = (n, opened, closed, labels, closer, type = labels.includes("bug") ? "Bug" : "Task") => ({
      number: n, state: "CLOSED", stateReason: "COMPLETED", createdAt: at(opened), closedAt: at(closed), issueType: type ? { name: type } : null,
      labels: { nodes: labels.map((name) => ({ name })) }, closedBy: { nodes: [{ closer }] }, reopened: { totalCount: 0 },
    });
    const pull = { __typename: "PullRequest", merged: true };
    const nodes = [
      issue(1, 0, 90, ["bug"], pull), // a bug fixed by its pull request
      issue(2, 100, 400, ["bug"], null), // known bad: a bug open five hours, closed by hand
      issue(3, 500, 502, ["bug"], null), // a record: filed and closed by hand two minutes apart
      issue(4, 600, 601, ["bug"], pull), // closed by a pull request within a minute: a fix, never a record
      issue(5, 700, 900, ["quality"], null), // a Task with no code: not a Bug, so no miss
      issue(6, 1000, 1100, ["bug"], null, null), // the bug label with no type: not a bug on an organization's repo
    ];
    const graphql = { ...GRAPHQL, Issues: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes } } } };
    const out = await run({ gh: fakeGh({ graphql }) });
    assert.equal(out["issues.closed_by_pr"].value, 66.7, "#1 and #4 of #1, #2, #4");
    assert.equal(out["issues.reopened"].detail.at(-1).value, 5, "every completed close but the record");
    assert.equal(out["issues.latest_close_hours"].value, 1.7, "#6, the latest close that was no record");
    const every = await run({ gh: fakeGh({ graphql }), params: { ...PARAMS, record_minutes: 0 } });
    assert.equal(every["issues.closed_by_pr"].value, 50, "record_minutes 0 counts the record too: 2 of 4");
    // A user's repo has no types, so the bug label marks a bug there: #6 joins, closed by hand.
    const route = `repos/${REPO}`;
    const user = await run({ gh: fakeGh({ graphql, rest: { ...REST, [route]: { ...REST[route], owner: { type: "User" } } } }) });
    assert.equal(user["issues.closed_by_pr"].value, 50, "#1 and #4 of #1, #2, #4, #6");
  });

  it("counts an open issue as parked only when it is over params.park_hours old and of no allowed type", async () => {
    const types = (nodes) => ({ ...GRAPHQL, OpenIssueTypes: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes } } } });
    const ago = (h) => new Date(NOW - h * HOUR_MS).toISOString();
    const nodes = [
      { number: 1, createdAt: ago(25), issueType: { name: "Feature" } },
      { number: 2, createdAt: ago(25), issueType: null },
      { number: 3, createdAt: ago(23), issueType: null },
      { number: 4, createdAt: ago(900), issueType: { name: "Task" } },
    ];
    const out = await run({ gh: fakeGh({ graphql: types(nodes) }) });
    assert.equal(out["issues.parked_open"].value, 2);
    assert.deepEqual(out["issues.parked_open"].detail, [{ label: "no type", value: 1 }, { label: "Feature", value: 1 }]);
    const none = await run({ gh: fakeGh({ graphql: types([]) }) });
    assert.equal(none["issues.parked_open"].value, 0);
    assert.deepEqual(none["issues.parked_open"].detail, [{ label: "no type", value: 0 }], "a row stays, so the bar has something to draw");
  });

  it("does not measure parked issues where issue types cannot apply, and drops the type check from intake", async () => {
    const off = await run({ params: { ...PARAMS, issue_types: [] } });
    assert.match(off["issues.parked_open"].could_not_check, /params\.issue_types .* is empty/);
    assert.equal(off["issues.intake_ready"].value, 100, "both forms parse and blank issues are off; no type to check");
    assert.equal(off["issues.intake_ready"].detail.length, 2);
    const route = `repos/${REPO}`;
    const user = await run({ gh: fakeGh({ rest: { ...REST, [route]: { ...REST[route], owner: { type: "User" } } } }) });
    assert.match(user["issues.parked_open"].could_not_check, /a user's repo has none/);
    // No types on a user's repo, so the bug label marks a bug there: open #5 (security) and #6.
    assert.equal(user["issues.open_bugs"].value, 2);
    assert.equal(user["issues.open_bugs"].detail.find((d) => d.label === "security").value, 1);
  });

  it("counts an open bug by its Bug type, never by the bug label alone", async () => {
    const nodes = [
      { number: 1, createdAt: "2026-11-01T00:00:00Z", issueType: { name: "Bug" }, labels: { nodes: [{ name: "ci" }] } },
      { number: 2, createdAt: "2026-11-01T00:00:00Z", issueType: null, labels: { nodes: [{ name: "bug" }, { name: "ci" }] } },
      { number: 3, createdAt: "2026-11-01T00:00:00Z", issueType: { name: "Task" }, labels: { nodes: [{ name: "bug" }] } },
    ];
    const out = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, OpenIssueTypes: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes } } } } }) });
    assert.equal(out["issues.open_bugs"].value, 1, "#1 only: #2 and #3 carry the label, not the type");
    assert.equal(out["issues.open_bugs"].detail.find((d) => d.label === "ci").value, 1);
  });

  it("scores an issue form by what a parser reads, never by the file being there", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "intake-"));
    after(() => rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, ".github", "ISSUE_TEMPLATE");
    mkdirSync(dir, { recursive: true });
    // Known bad: an unquoted colon inside a plain value. GitHub shows a YAML syntax error and ignores the form.
    writeFileSync(path.join(dir, "bug.yml"), "name: Bug\ndescription: Something breaks\ntype: Bug\nbody:\n  - type: textarea\n    attributes:\n      label: Finding\n      description: A table with these rows: Where, Expected\n");
    writeFileSync(path.join(dir, "config.yml"), "blank_issues_enabled: false\n");
    const bad = (await run({ root }))["issues.intake_ready"];
    assert.equal(bad.value, 33.3, "only config.yml holds");
    assert.deepEqual(bad.detail.at(-1), { label: "bug.yml does not parse as a form", value: 0, unit: "" });
    // Known good: the same form with the value quoted.
    writeFileSync(path.join(dir, "bug.yml"), 'name: Bug\ndescription: Something breaks\ntype: Bug\nbody:\n  - type: textarea\n    attributes:\n      label: Finding\n      description: "A table with these rows: Where, Expected"\n');
    assert.equal((await run({ root }))["issues.intake_ready"].value, 100);
    rmSync(dir, { recursive: true });
    const none = (await run({ root }))["issues.intake_ready"];
    assert.equal(none.value, 0, "no form, no config");
    assert.deepEqual(none.detail.map((d) => d.value), [0, 0, 0]);
  });

  it("counts no archived, used or named label as unused", async () => {
    const out = await run();
    assert.deepEqual(out["issues.stray_labels"].detail.map((d) => d.label), ["good first issue", "wontfix"]);
    const rest = { ...REST, [`repos/${REPO}/labels?per_page=100`]: [{ name: "bug", archived_at: null }, { name: "wontfix", archived_at: "2026-11-01T00:00:00Z" }] };
    const clean = await run({ gh: fakeGh({ rest }) });
    assert.equal(clean["issues.stray_labels"].value, 0);
    assert.equal(clean["issues.stray_labels"].detail, undefined);
  });

  it("counts a member's Review: MERGE|BLOCK at <sha> comment as a review, and a review by the PR's own author", async () => {
    const T0 = Date.parse("2026-11-01T00:00:00Z");
    const at = (n, h) => new Date(T0 + (n + h) * HOUR_MS).toISOString();
    const sha = (c) => c.repeat(40);
    const note = (n, h, body, authorAssociation = "MEMBER") => ({ body, createdAt: at(n, h), authorAssociation });
    // Each PR merges at its head, sha("a"), an hour after it opens; sha("b") is an earlier head of each.
    const pr = (n, { notes = [], reviews = [] } = {}) => ({
      number: n, title: `PR ${n}`, author: { login: "fixture-user" }, createdAt: at(n, 0), mergedAt: at(n, 1),
      additions: 1, deletions: 0, headRefOid: sha("a"), files: { nodes: [] }, headCommit: { nodes: [] },
      reviews: { nodes: reviews },
      markerComments: { nodes: notes },
      markerCommits: { nodes: [{ commit: { oid: sha("b") } }, { commit: { oid: sha("a") } }] },
    });
    const pulls = [
      pr(1, { notes: [note(1, 0.2, `Review: BLOCK at ${sha("b")}\nTwo findings.`), note(1, 0.8, `Review: MERGE at ${sha("a")}`, "OWNER")] }),
      pr(2, { notes: [note(2, 0.5, `Review: MERGE at ${sha("a")}\r\nClean.`, "COLLABORATOR")] }),
      pr(3, { notes: [note(3, 0.5, `Review: MERGE at ${sha("a")}`, "NONE")] }), // forged: not a member
      pr(4, { notes: [note(4, 0.5, `Review: MERGE at ${sha("f")}`)] }), // a SHA not in the PR
      pr(5, { notes: [note(5, 0.5, "Review: MERGE at aaaaaaa"), note(5, 0.6, `Review: MERGE at ${sha("a")} looks good`)] }), // short, and not the whole line
      // One login opens and reviews: its COMMENTED review of the earlier head counts.
      pr(6, { reviews: [{ submittedAt: at(6, 0.5), commit: { oid: sha("b") }, author: { __typename: "User", login: "fixture-user" } }] }),
    ];
    const gh = fakeGh({ graphql: { ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: pulls } } } } });
    const out = await run({ gh });
    assert.deepEqual(out["pull_requests.reviewed"].detail, [
      { label: "reviewed at the merged head", value: 2, unit: "" }, // #1's MERGE after its BLOCK, #2's
      { label: "reviewed another commit, or after merge", value: 1, unit: "" }, // #6
      { label: "not reviewed", value: 3, unit: "" }, // #3, #4, #5: no marker counts
    ]);
    assert.deepEqual(out["pull_requests.fixed_after_review"].detail, [
      { label: "fixed after the first review", value: 2, unit: "" }, // #1 blocked at an earlier head, #6
      { label: "merged as first reviewed", value: 1, unit: "" }, // #2
      { label: "no review before merge (left out)", value: 3, unit: "" },
    ]);
    const blockOnly = pr(7, { notes: [note(7, 0.5, `Review: BLOCK at ${sha("a")}`)] });
    const late = pr(8, { notes: [note(8, 2, `Review: MERGE at ${sha("a")}`)] });
    // A BLOCK posted before the merge, edited into a MERGE after it: timed by the edit.
    const edited = pr(10, { notes: [{ ...note(10, 0.5, `Review: MERGE at ${sha("a")}`), lastEditedAt: at(10, 2) }] });
    // MERGE, then BLOCK, at the same head before the merge: the last verdict decides.
    const takenBack = pr(11, { notes: [note(11, 0.3, `Review: MERGE at ${sha("a")}`), note(11, 0.6, `Review: BLOCK at ${sha("a")}`)] });
    const none = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [blockOnly, late, pr(9), edited, takenBack] } } } } }) });
    assert.deepEqual(none["pull_requests.reviewed"].detail.map((d) => d.value), [0, 4, 1], "#7, #8, #10 and #11 pass no review at the head; #9 has none");
    assert.deepEqual(none["pull_requests.fixed_after_review"].detail.map((d) => d.value), [1, 1, 3], "#7, blocked at the head it merged at anyway, did not pass; #11's first verdict, a MERGE, did; #8, #9 and #10 had none before the merge");
    // A private org member reads as CONTRIBUTOR to a token outside the org: every verdict looks forged, so nothing is scored, never 0 (#376).
    const privateOnly = [pr(12, { notes: [note(12, 0.5, `Review: MERGE at ${sha("a")}`, "CONTRIBUTOR")] }), pr(13, { notes: [note(13, 0.5, `Review: MERGE at ${sha("a")}`, "CONTRIBUTOR")] })];
    const hidden = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: privateOnly } } } } }) });
    assert.match(hidden["pull_requests.reviewed"].could_not_check, /membership is private/);
    assert.equal(hidden["pull_requests.reviewed"].value, undefined);
    // An outsider's verdict naming a SHA the PR never had proves nothing about membership: the 0 stands.
    const forged = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [pr(15, { notes: [note(15, 0.5, `Review: MERGE at ${sha("f")}`, "NONE")] })] } } } } }) });
    assert.equal(forged["pull_requests.reviewed"].value, 0);
    // One member verdict among them shows membership reads, so a forged one still scores as not reviewed.
    const mixed = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [...privateOnly, pr(14, { notes: [note(14, 0.5, `Review: MERGE at ${sha("a")}`, "MEMBER")] })] } } } } }) });
    assert.equal(mixed["pull_requests.reviewed"].value, 33.3);
  });

  it("times green to merge on the merged head: the median of the last 10, each PR a row, and no check times as could_not_check", async () => {
    const rollup = (state, done) => ({ nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: done.map((t) => ({ __typename: "CheckRun", completedAt: t })) } } } }] });
    const pr = (n, mergedAt, headCommit) => ({ number: n, title: `PR ${n}`, createdAt: "2026-11-01T00:00:00Z", mergedAt, additions: 1, deletions: 0, headRefOid: "h", files: { nodes: [] }, reviews: { nodes: [] }, headCommit });
    const page = (nodes) => ({ repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } });
    const pulls = [
      pr(3, "2026-11-03T01:00:00Z", rollup("SUCCESS", ["2026-11-03T00:50:00Z", "2026-11-03T00:40:00Z"])), // 10 after the last check
      pr(2, "2026-11-02T01:00:00Z", rollup("SUCCESS", ["2026-11-02T00:00:00Z"])), // 60
      pr(1, "2026-11-01T01:00:00Z", rollup("FAILURE", ["2026-11-01T00:00:00Z"])), // red at head: no green time
    ];
    const out = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: page(pulls) } }) });
    assert.equal(out["pull_requests.green_to_merge_minutes"].value, 35);
    assert.deepEqual(out["pull_requests.green_to_merge_minutes"].detail, [
      { label: "#3", value: 10, unit: "minutes" },
      { label: "#2", value: 60, unit: "minutes" },
      { label: "merged without an all-green head", value: 1, unit: "PRs" },
    ]);
    // Three timed PRs: the median is the middle one, 20, never a mean.
    const odd = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: page([
      pr(7, "2026-11-07T01:00:00Z", rollup("SUCCESS", ["2026-11-07T00:55:00Z"])), // 5
      pr(6, "2026-11-06T01:00:00Z", rollup("SUCCESS", ["2026-11-06T00:40:00Z"])), // 20
      pr(5, "2026-11-05T03:00:00Z", rollup("SUCCESS", ["2026-11-05T00:00:00Z"])), // 180
    ]) } }) });
    assert.equal(odd["pull_requests.green_to_merge_minutes"].value, 20);
    assert.deepEqual(odd["pull_requests.green_to_merge_minutes"].detail.map((d) => [d.label, d.value]), [["#7", 5], ["#6", 20], ["#5", 180]]);
    const blind = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: page([pr(4, "2026-11-04T01:00:00Z", { nodes: [] })]) } }) });
    assert.match(blind["pull_requests.green_to_merge_minutes"].could_not_check, /^no check times read/);
  });

  it("reports no reviewed or merged PRs yet as could_not_check, and an empty queue as 0", async () => {
    const none = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [] } } };
    const out = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: none, OpenPulls: none } }) });
    assert.equal(out["pull_requests.fixed_after_review"].could_not_check, "no merged PRs yet");
    assert.equal(out["pull_requests.latest_merge_hours"].could_not_check, "no merged PRs yet");
    assert.equal(out["pull_requests.green_to_merge_minutes"].could_not_check, "no merged PRs yet");
    assert.equal(out["pull_requests.latest_lines"].could_not_check, "no merged PRs yet");
    assert.equal(out["pull_requests.merged_off_default"].could_not_check, "no merged PRs yet");
    assert.equal(out["pull_requests.green_waiting_minutes"].value, 0);
    for (const id of ["pull_requests.reverted", "pull_requests.open_now", "pull_requests.conflicting"]) {
      assert.equal(out[id].value, 0, `${id}: zero is a real reading`);
    }
  });

  it("reads mergeability again when GitHub has not computed it, and never counts a guess", async () => {
    // GitHub resets mergeability after each merge to main, so a first read can
    // answer UNKNOWN for a PR that conflicts.
    const openWith = (state) => ({
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ number: 40, createdAt: "2026-11-01T20:00:00Z", mergeable: state, baseRefName: "main", author: { login: "fixture-user" }, labels: { nodes: [] } }],
        },
      },
    });
    const answering = (states) => {
      const gh = fakeGh();
      const base = gh.graphql;
      let reads = 0;
      gh.graphql = async (query, variables) => {
        if (!/query OpenPulls/.test(query)) return base(query, variables);
        gh.calls.push("OpenPulls");
        return structuredClone(openWith(states[Math.min(reads++, states.length - 1)]));
      };
      return gh;
    };
    const waits = [];
    const sleep = async (ms) => void waits.push(ms);

    // Known clean: UNKNOWN on the first read, CONFLICTING on the second.
    const settled = await run({ gh: answering(["UNKNOWN", "CONFLICTING"]), sleep });
    assert.equal(settled["pull_requests.conflicting"].value, 1);
    assert.deepEqual(settled["pull_requests.conflicting"].detail, [{ label: "#40", value: 1, unit: "days open" }]);
    assert.deepEqual(waits, [5000], "one wait, then one more read");

    // Known bad: still UNKNOWN after the second read, so no number at all.
    const stuck = await run({ gh: answering(["UNKNOWN", "UNKNOWN"]), sleep });
    assert.equal(stuck["pull_requests.conflicting"].value, undefined);
    assert.equal(stuck["pull_requests.conflicting"].could_not_check, "GitHub had not computed mergeability for 1 open PR after a second read");

    // Nothing UNKNOWN: no wait and no second read.
    waits.length = 0;
    const gh = answering(["MERGEABLE"]);
    await run({ gh, sleep });
    assert.deepEqual(waits, []);
    assert.equal(gh.calls.filter((c) => c === "OpenPulls").length, 1);
  });

  it("does not hold a repo to private Pages when its plan cannot have them", async () => {
    const repoWith = (fields) => ({ ...REST, [`repos/${REPO}`]: { ...REST[`repos/${REPO}`], ...fields } });
    const pub = await run({ gh: fakeGh({ rest: repoWith({ private: false }) }) });
    assert.match(pub["settings.pages_private"].could_not_check, /a public repo publishes a public Pages site/);
    const user = await run({ gh: fakeGh({ rest: repoWith({ owner: { type: "User" } }) }) });
    assert.match(user["settings.pages_private"].could_not_check, /a user's repo/);
    const team = await run({ gh: fakeGh({ rest: { ...REST, "orgs/fixture-org": { plan: { name: "team" } } } }) });
    assert.equal(team["settings.pages_private"].could_not_check, "the organization's plan is team: private Pages needs GitHub Enterprise Cloud");
    // A plan this token cannot see is no reason to skip: the Pages answer decides.
    const { "orgs/fixture-org": _plan, ...hidden } = REST;
    assert.equal((await run({ gh: fakeGh({ rest: hidden }) }))["settings.pages_private"].value, 1);
  });

  it("reports a missing project board and a disabled Pages site as could_not_check", async () => {
    const graphql = { ...GRAPHQL, ProjectFind: { repositoryOwner: { projectsV2: { nodes: [] } } } };
    const rest = { ...REST, [`repos/${REPO}/pages`]: { __error: { status: 404, message: "Not Found" } } };
    const out = await run({ gh: fakeGh({ rest, graphql }) });
    assert.equal(out["projects.cards_by_column"].could_not_check, "no project named fixture-repo yet; set params.project_title in targets/github.json");
    assert.match(out["settings.pages_private"].could_not_check, /Pages is not enabled/);
  });
});

describe("params and targets from the engine", () => {
  it("reads only the metrics the engine passes, with their needs", async () => {
    const targets = TARGETS.filter((t) => t.id === "issues.open_bugs" || t.id === "actions.permissions_share").map((t) => ({ ...t }));
    targets[0].needs = "github-admin";
    const gh = fakeGh();
    const out = await run({ mode: "ci", targets, gh });
    assert.deepEqual(Object.keys(out).sort(), ["actions.permissions_share", "issues.open_bugs"]);
    assert.match(out["issues.open_bugs"].could_not_check, /needs an admin token/, "the passed needs, not the template's");
    assert.equal(gh.calls.length, 0, "no read for a metric that is not active");
    assert.equal(out["actions.permissions_share"].value, 50);
  });

  it("takes the repo from the caller, then params.repo, then GITHUB_REPOSITORY", () => {
    assert.equal(repoOf("a/b", { repo: "c/d" }, { GITHUB_REPOSITORY: "e/f" }), "a/b");
    assert.equal(repoOf(undefined, { repo: "c/d" }, { GITHUB_REPOSITORY: "e/f" }), "c/d");
    assert.equal(repoOf(undefined, { repo: "" }, { GITHUB_REPOSITORY: "e/f" }), "e/f");
    assert.equal(repoOf(undefined, { repo: "not a repo" }, {}), null);
    assert.equal(repoOf(undefined, {}, {}), null);
  });

  it("with no repo to read, names the fix on every GitHub metric and still reads the files", async () => {
    const saved = process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_REPOSITORY;
    try {
      const gh = fakeGh();
      const out = await run({ gh, repo: undefined });
      assert.equal(gh.calls.length, 0, "no gh call without a repo");
      assert.match(out["issues.open_bugs"].could_not_check, /params\.repo .* is not owner\/name, and GITHUB_REPOSITORY is unset/);
      assert.equal(out["actions.pinned_share"].value, 75, "a workflow file needs no repo");
      assert.equal(out["actions.permissions_share"].value, 50, "nor do its permissions");
      assert.ok(!out["issues.open_bugs"].source.includes("{repo}"));
    } finally {
      if (saved !== undefined) process.env.GITHUB_REPOSITORY = saved;
    }
  });

  it("measures with the template's own params when the engine passes none", async () => {
    const out = await run({ params: undefined });
    assert.match(out["issues.area_labeled"].could_not_check, /params\.area_labels .* is empty/);
    assert.match(out["security.headers"].could_not_check, /params\.site_url .* is empty/);
    assert.deepEqual(out["issues.open_bugs"].detail, [{ label: "no area", value: 2 }]);
    // GitHub's default board: Todo, In Progress, Done. The fixture's cards sit
    // in other columns, which follow in the order first seen.
    assert.equal(out["projects.cards_by_column"].value, 0, "no card is In Progress");
    assert.deepEqual(out["projects.cards_by_column"].detail.slice(0, 3), [
      { label: "Todo", value: 0 },
      { label: "In Progress", value: 0 },
      { label: "Done", value: 3 },
    ]);
    assert.equal(out["projects.done_with_pr"].value, 66.7);
  });

  it("names the param when a repo sets one the collector cannot use", async () => {
    for (const [params, reason] of [
      [{ area_labels: "code" }, /params\.area_labels in targets\/github\.json must be a list of strings/],
      [{ pr_body_ignore: ["(unclosed"] }, /params\.pr_body_ignore in targets\/github\.json: Invalid regular expression/],
      [{ threat_model: 5 }, /params\.threat_model in targets\/github\.json must be a path or a list of paths, as text/],
      [{ threat_model: [] }, /params\.threat_model in targets\/github\.json must be a path or a list of paths, as text/],
      [{ registries: ["http://registry.npmjs.org/"] }, /params\.registries in targets\/github\.json: "http:\/\/registry\.npmjs\.org\/" is not a plain https URL/],
      [{ registries: ["registry.npmjs.org"] }, /params\.registries in targets\/github\.json: "registry\.npmjs\.org" is not a plain https URL/],
    ]) {
      const out = await run({ params: { ...PARAMS, ...params } });
      for (const id of METRIC_IDS) assert.match(out[id].could_not_check, reason, id);
    }
  });

  it("reads the default branch from the repo, never assumes main", async () => {
    const rest = {
      ...REST,
      [`repos/${REPO}`]: { ...REST[`repos/${REPO}`], default_branch: "trunk" },
      [`repos/${REPO}/branches/trunk/protection`]: { required_status_checks: { contexts: ["build"] } },
      [`repos/${REPO}/rules/branches/trunk`]: [],
    };
    const gh = fakeGh({ rest });
    const out = await run({ gh });
    assert.ok(!gh.calls.some((c) => /branches\/main/.test(c)), gh.calls.join(", "));
    assert.equal(out["settings.required_checks"].value, 1);
  });
});

describe("ghClient() against a stand-in gh binary", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "github-collector-"));
  const savedPath = process.env.PATH;
  after(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });
  // The stand-in prints what gh prints on a 404 and on a GraphQL scope error, and exits 1.
  writeFileSync(
    path.join(dir, "gh"),
    `#!/bin/sh
if [ "$2" = "graphql" ]; then
  echo '{"errors":[{"type":"INSUFFICIENT_SCOPES","message":"needs read:project"}]}'
  echo "gh: needs read:project" >&2
else
  echo '{"message":"Branch not protected","status":"404"}'
  echo "gh: Branch not protected (HTTP 404)" >&2
fi
exit 1
`,
  );
  chmodSync(path.join(dir, "gh"), 0o755);

  it("parses the HTTP status and message from a failed REST call", async () => {
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
    const err = await ghClient().rest("repos/x/y/branches/main/protection").catch((e) => e);
    assert.ok(err instanceof GhError);
    assert.equal(err.status, 404);
    assert.equal(err.message, "Branch not protected");
  });

  it("parses the GraphQL error type", async () => {
    process.env.PATH = `${dir}${path.delimiter}${savedPath}`;
    const err = await ghClient().graphql("query X { viewer { login } }").catch((e) => e);
    assert.ok(err instanceof GhError);
    assert.equal(err.type, "INSUFFICIENT_SCOPES");
  });

  it("reports a missing gh binary as a GhError, not a crash", async () => {
    process.env.PATH = path.join(dir, "empty");
    const err = await ghClient().rest("repos/x/y").catch((e) => e);
    assert.ok(err instanceof GhError);
    assert.match(err.message, /gh is not installed/);
  });
});

describe("helpers", () => {
  it("counts a PR that mentions an issue, not only one that closes it, as that card's pull request", () => {
    const issue = (closing, mentions) => ({ status: { name: "Done" }, content: { __typename: "Issue", closedByPullRequestsReferences: { nodes: closing }, timelineItems: { nodes: mentions } } });
    const pr = (number, merged = true) => ({ number, merged });
    const card = cardOf(issue([pr(1)], [{ source: pr(1) }, { source: pr(2) }, { source: {} }]), /x/, new Map());
    assert.deepEqual(card.pulls.map((p) => p.number), [1, 2], "closing and mentioning PR listed once each; a non-PR source left out");
    assert.equal(cardOf(issue([], []), /x/, new Map()).pulls.length, 0, "no PR, no link");
    assert.equal(cardOf(issue([], [{ source: pr(3, false) }]), /x/, new Map()).pulls[0].merged, false);
  });

  it("marks lockfiles, generated code and data snapshots as not reviewed, and code as reviewed", () => {
    for (const file of ["package-lock.json", "app/package-lock.json", "uv.lock", "quality/data/local.json", "quality/history/2026-11-02.json", "data/quality/local.json", "data/quality/history/2026-11-05.json", "worker/src/generated/library.json"]) {
      assert.equal(isNotReviewed(file), true, file);
    }
    for (const file of ["app/src/pages/index.astro", "quality/collectors/github/github.mjs", "data/events/upcoming.json", "package.json", "lockfile.md"]) {
      assert.equal(isNotReviewed(file), false, file);
    }
    // A repo adds its own snapshots in params.not_reviewed.
    assert.equal(isNotReviewed("data/events/upcoming.json", [/^data\/events\//]), true);
  });

  it("pairs a revert with the latest PR of its title merged before it, in any input order", () => {
    const old = { number: 10, title: "Same", mergedAt: "2026-10-01T00:00:00Z" };
    const latest = { number: 12, title: "Same", mergedAt: "2026-10-05T00:00:00Z" };
    const after = { number: 15, title: "Same", mergedAt: "2026-10-09T00:00:00Z" };
    const revert = { number: 14, title: 'Revert "Same"', mergedAt: "2026-10-06T00:00:00Z" };
    for (const order of [[old, latest, after, revert], [revert, after, latest, old]]) {
      const [found] = reverts(order);
      assert.equal(found.original.number, 12);
      assert.equal(found.days, 1);
    }
  });

  it("interpolates percentiles the numpy way", () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentile([5], 0.9), 5);
    assert.equal(Math.round(percentile([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 0.9)), 90);
  });

});

describe("PR descriptions", () => {
  it("proseWords counts words outside tables, fenced blocks, inline code, link targets and comments", () => {
    const body = "Intro words here.\n\n| a | b |\n| --- | --- |\n| x y z | q |\n\n```mermaid\ngraph LR; A-->B\n```\nRun `node x.mjs` then [the docs](https://x.y/z).\n<!-- hidden words -->";
    assert.equal(proseWords(body), 7);
    assert.equal(proseWords(""), 0);
  });

  it("proseWords leaves out the patterns a repo ignores, and HTML tags", () => {
    const footer = "<!-- codesmith:footer -->\n<sub>Reviewed by <a href=\"https://x.dev\">codesmith</a>: forty three words of boilerplate no author wrote</sub>\n<!-- /codesmith:footer -->";
    assert.equal(proseWords(`Two words.\n\n${footer}`, [FOOTER]), 2);
    // Without the pattern only the comment markers go, and the footer's words count.
    assert.ok(proseWords(`Two words.\n\n${footer}`) > 2);
    assert.equal(proseWords("<details><summary>Open</summary>three more words</details>"), 4);
  });

  it("a body holding only an ignored footer is passed over for the latest description", async () => {
    // #20, the latest merge, gets #18's footer-only body: #20, then the empty #19 and #18, are passed over for #17.
    const graphql = structuredClone(GRAPHQL);
    const nodes = graphql.MergedPulls.flatMap((page) => page.repository.pullRequests.nodes);
    nodes.find((p) => p.number === 20).body = nodes.find((p) => p.number === 18).body;
    const got = await run({ gh: fakeGh({ graphql }) });
    assert.deepEqual(got["pull_requests.latest_body_words"].detail.map((d) => [d.label, d.value]), [["#17", 5], ["newer merges with an empty description, passed over", 3]]);
    // Without the footer pattern, the footer's own words make #20's description.
    const bare = await run({ gh: fakeGh({ graphql }), params: { ...PARAMS, pr_body_ignore: [] } });
    assert.equal(bare["pull_requests.latest_body_words"].detail[0].label, "#20");
  });

  it("links an issue by a closing keyword or Part of, not by a fence, a comment or a mention", () => {
    for (const body of ["Closes #7", "fixes: #7.", "Resolved owner/repo#7", "This FIXES https://github.com/o/r/issues/7", "Part of #5", "part of org/repo#5", "Card: PVTI_lADOE8y6T84BqPGMzhHt8f0", "Part of card PVTI_lADOE8y6T84BqPGMzhHt8f0"]) assert.equal(linksIssue(body), true, body);
    for (const body of ["See #7", "```\nCloses #9\n```", "<!-- Fixes #7 -->", "prefix #7", "Closes the loop", "PVTI_lADOE8y6T84BqPGMzhHt8f0", "Card: PVTI_x", "```\nCard: PVTI_lADOE8y6T84BqPGMzhHt8f0\n```", "", null]) assert.equal(linksIssue(body), false, String(body));
    assert.equal(linksIssue("Fixes #7 <!-- codesmith:footer -->", [/Fixes #7/g]), false, "an ignored pattern is cut first");
  });

  it("probes: a pipe in inline code, < and > in prose, < in a fence", () => {
    assert.equal(proseWords("Run `git log | tail` before you push"), 4);
    assert.equal(proseWords("n < 5 and x > 3"), 5);
    assert.equal(proseWords("```\na < b\n```\nTwo words"), 2);
  });

  it("hasPicture finds an image, and a diagram only where GitHub draws it", () => {
    assert.equal(hasPicture("![card](https://example.org/c.svg)"), true);
    assert.equal(hasPicture('<img width="400" src="https://example.org/c.png">'), true);
    assert.equal(hasPicture("```mermaid\nflowchart LR\n  A --> B\n```"), true, "an issue draws the diagram");
    assert.equal(hasPicture("```mermaid\nflowchart LR\n  A --> B\n```", { diagrams: false }), false, "a draft card shows the diagram as code");
    assert.equal(hasPicture("| a | b |\n| --- | --- |\n| 1 | 2 |"), false, "a table is not a picture");
    assert.equal(hasPicture("`![card](https://example.org/c.svg)`"), false, "an image inside code is not drawn");
  });

  it("hasVisual finds a table, a diagram GitHub draws, or an image outside code", () => {
    assert.equal(hasVisual("| a | b |\n| --- | --- |\n| 1 | 2 |"), true);
    assert.equal(hasVisual("```mermaid\npie title Bugs\n\"open\" : 2\n```"), true);
    assert.equal(hasVisual("~~~geojson\n{}\n~~~"), true);
    assert.equal(hasVisual("![chart](https://example.org/c.png)"), true);
    assert.equal(hasVisual('<img width="400" src="https://example.org/c.png">'), true);
    assert.equal(hasVisual("Words only, and a [link](https://example.org)."), false);
    assert.equal(hasVisual("```md\n![not drawn](x.png)\n```"), false, "an image inside a code block is not shown");
    assert.equal(hasVisual("```js\nconst a = 1;\n```"), false, "code is not a visual");
    assert.equal(hasVisual("<!-- ![hidden](x.png) -->"), false);
  });

  it("hasVisual is not flattered by an image in inline code, a diagram shown as an example, or misses a reference image", () => {
    assert.equal(hasVisual("Write `![chart](c.png)` to add one."), false, "inline code shows the syntax, not an image");
    const example = ["````md", "```mermaid", "graph LR; A-->B", "```", "````"].join("\n");
    assert.equal(hasVisual(example), false, "a mermaid block inside a four-backtick fence is an example, not a diagram");
    assert.equal(hasVisual(`${example}\n\n\`\`\`mermaid\ngraph LR; C-->D\n\`\`\``), true, "a real one after the example still counts");
    assert.equal(hasVisual("![chart][1]\n\n[1]: https://example.org/c.png"), true, "a reference-style image");
  });

  it("counts a Later card as open and not started, with Later, Todo, In Progress and Done", async () => {
    const at = (d) => `2026-11-0${d}T00:00:00Z`;
    const pull = (n, merged) => ({ number: n, merged, state: merged ? "MERGED" : "OPEN", createdAt: at(1) });
    const item = (status, content, linked = []) => ({ createdAt: at(1), status: { name: status, updatedAt: at(status === "Done" ? 2 : 1) }, linked: { pullRequests: { nodes: linked } }, content });
    const issue = (body, type) => ({ __typename: "Issue", body, labels: { nodes: [] }, issueType: type ? { name: type } : null, closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } });
    const nodes = [
      item("Later", { __typename: "DraftIssue", body: "Parked." }),
      item("Later", issue("Parked bug.", "Bug")),
      item("Todo", { __typename: "DraftIssue", body: "Next up." }),
      item("In Progress", { __typename: "DraftIssue", body: "Building." }, [pull(41, false)]),
      item("Done", { __typename: "DraftIssue", body: "Shipped." }, [pull(40, true)]),
    ];
    const graphql = { ...GRAPHQL, ProjectItems: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
    const out = await run({ params: { ...PARAMS, project_columns: ["Later", "Todo", "In Progress", "Done"] }, gh: fakeGh({ graphql }) });
    assert.equal(out["projects.cards_by_column"].value, 0, "the In Progress card has an open pull request; a Later card is not in progress");
    assert.deepEqual(out["projects.cards_by_column"].detail, [
      { label: "Later", value: 2 },
      { label: "Todo", value: 1 },
      { label: "In Progress", value: 1 },
      { label: "Done", value: 1 },
      { label: "In Progress, no open pull request", value: 0 },
    ]);
    assert.equal(out["projects.done_with_pr"].value, 100, "Done alone is done");
    assert.equal(out["projects.oldest_doing_days"].value, 1.8, "only the In Progress card: 44 hours, from 2026-11-01 to the read at 2026-11-02T20:00Z");
    assert.equal(out["projects.latest_cycle_hours"].value, 24);
    assert.equal(out["projects.bug_cards"].value, 1, "a Later card is open, so a Bug parked there still counts");
    assert.equal(out["projects.cards_at_a_glance"].detail.at(-1).value, 4, "Later, Todo and In Progress cards are open");
  });

  it("reads the card metrics from issues only, in every mode, never the board's drafts", async () => {
    const local = await run();
    assert.deepEqual(local["issues.latest_card_words"].detail, [
      { label: "the latest issue #6, opened 2026-11-02", value: 0, unit: "words" },
      { label: "newer issues with an empty body, passed over", value: 0, unit: "" },
    ]);
    // Blank issues are passed over: with #6 empty, #4 is the latest written; the board's
    // empty draft of 01:00 is not read. #4's prose: "Broken:" and the screenshot's alt text.
    const blank = structuredClone(GRAPHQL);
    blank.RecentIssues.repository.issues.nodes.find((i) => i.number === 6).body = "";
    assert.deepEqual((await run({ gh: fakeGh({ graphql: blank }) }))["issues.latest_card_words"].detail.map((d) => [d.label, d.value]), [
      ["the latest issue #4, opened 2026-11-02", 2],
      ["newer issues with an empty body, passed over", 1],
    ]);
    assert.equal(local["issues.card_visual_share"].value, 50, "3 of the 6 issues; the 5 draft cards are not read");
    for (const id of ["issues.latest_card_words", "issues.card_visual_share"]) assert.doesNotMatch(local[id].source, /draft/, id);
    // Neither metric needs the board: no project scope still measures both.
    const graphql = { ...GRAPHQL, ProjectFind: { __error: { message: "Your token has not been granted the required scopes", type: "INSUFFICIENT_SCOPES" } } };
    const noScope = await run({ gh: fakeGh({ graphql }) });
    assert.equal(noScope["issues.card_visual_share"].value, 50);
    assert.equal(noScope["issues.latest_card_words"].value, 0);
    const gh = fakeGh();
    const ci = await run({ mode: "ci", gh });
    assert.equal(ci["issues.card_visual_share"].value, 50);
  });

  it("hasTable needs a row and its separator outside fenced blocks", () => {
    assert.equal(hasTable("| a | b |\n| --- | --- |\n| 1 | 2 |"), true);
    assert.equal(hasTable("no table here"), false);
    assert.equal(hasTable("```\n| a |\n| --- |\n```"), false);
  });
});

// Blacksmith's codesmith app appends a footer to every PR body (code-os#204): the template default cuts it.
describe("the template's pr_body_ignore", () => {
  it("cuts the codesmith footer, its prose and its image, from every body", () => {
    const ignore = TEMPLATE_PARAMS.pr_body_ignore.map((src) => new RegExp(src, "g"));
    const footer = [
      "<!-- codesmith:footer -->",
      "---",
      '<a href="https://backend.blacksmith.sh/track"><picture><img alt="Autofix with [code]smith" src="https://pr-comments-assets.blacksmith.sh/x.png"></picture></a>',
      '<sup><a href="https://app.blacksmith.sh/x">Open in [code]smith</a> · Need help on this PR? Tag <code>@codesmith</code> with what you need.</sup>',
      "",
      "<!-- codesmith:autofix:disabled -->",
      "<!-- /codesmith:footer -->",
    ].join("\n");
    const body = `Two words.\n\n${footer}`;
    assert.equal(proseWords(body, ignore), 2, "only the author's words count");
    assert.equal(hasVisual(footer, ignore), false, "the footer's image is not the card's visual");
    assert.ok(proseWords(body, []) > 2, "without the default the footer's prose would count");
  });
});

// Git Crafter's Claude security review (#191): pinned, on a subscription token, and a clean skip without it.
describe("Git Crafter's optional claude-review.yml template", () => {
  it("pins claude-code-action, takes only the OAuth token, and skips without the secret", async () => {
    const { default: YAML } = await import("yaml");
    const file = path.join(HERE, "..", "..", "..", "templates", "ci", "claude-review.yml");
    let text = null;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = null;
    }
    assert.ok(text, "Git Crafter has templates/ci/claude-review.yml");
    const doc = YAML.parse(text);
    const steps = Object.values(doc.jobs).flatMap((j) => j.steps ?? []);
    const claude = steps.filter((s) => String(s.uses ?? "").startsWith("anthropics/claude-code-action@"));
    assert.equal(claude.length, 1, "one claude-code-action step");
    assert.match(claude[0].uses, /@[0-9a-f]{40}$/, "pinned to a full commit SHA");
    assert.equal(claude[0].with.claude_code_oauth_token, "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}");
    assert.ok(!("anthropic_api_key" in claude[0].with), "never an API key, which bills per use");
    assert.equal(claude[0].if, "env.HAS_TOKEN == 'true'", "runs only when the secret is set");
    assert.ok(steps.some((s) => s.if === "env.HAS_TOKEN != 'true'"), "a step names the skip");
    assert.match(claude[0].with.prompt, /^Security review:/m, "the comment's first line the metric counts");
    assert.deepEqual(Object.keys(doc.on), ["pull_request"], "never pull_request_target, which runs with secrets for code from outside");
  });

  it("scores claude_review_share on the same paths the workflow reviews", async () => {
    const { default: YAML } = await import("yaml");
    const root = path.join(HERE, "..", "..", "..");
    const doc = YAML.parse(readFileSync(path.join(root, "templates", "ci", "claude-review.yml"), "utf8"));
    const config = JSON.parse(readFileSync(path.join(root, "config", "quality", "targets", "github.json"), "utf8"));
    const paths = config.find((e) => e.params?.review_paths)?.params.review_paths;
    assert.deepEqual(paths, doc.on.pull_request.paths, "params.review_paths matches claude-review.yml's paths");
  });
});

describe("projects.closed_not_done", () => {
  const at = "2026-11-01T00:00:00Z";
  const card = (status, state) => ({ createdAt: at, status: { name: status, updatedAt: at }, linked: null, content: { __typename: "Issue", number: 742, state, body: "", labels: { nodes: [] }, issueType: null, closedByPullRequestsReferences: { nodes: [] }, timelineItems: { nodes: [] } } });
  const read = (nodes) => run({ gh: fakeGh({ graphql: { ...GRAPHQL, ProjectItems: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } }) });

  it("counts a closed issue whose card is In Progress", async () => {
    const out = await read([card("In Progress", "CLOSED"), card("In Progress", "OPEN")]);
    assert.equal(out["projects.closed_not_done"].value, 1, "only the closed issue counts; an open one in progress is work");
    assert.deepEqual(out["projects.closed_not_done"].detail, [{ label: "#742 in In Progress", value: 1 }]);
  });

  it("is 0 when every closed issue's card is Done", async () => {
    const out = await read([card("Done", "CLOSED"), card("Done", "CLOSED")]);
    assert.equal(out["projects.closed_not_done"].value, 0);
  });
});
