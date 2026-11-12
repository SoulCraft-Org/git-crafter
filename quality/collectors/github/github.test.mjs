// Tests for the GitHub collector. Run with `node --test quality/collectors/github/github.test.mjs`.
//
// The known-good fixture (quality/fixtures/github/) answers every gh call the
// collector makes, so each metric has one expected value worked out by hand.
// params.json holds the params a repo sets (area labels, board columns, site
// URL, ignored body patterns); the tests pass them merged over the template's,
// as the engine does.
// The fail-open cases check that a missing tool, token, scope or file becomes
// could_not_check, never a throw and never a 0. All of it runs offline.
// The Security and quality cases are in github-security.test.mjs.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { collect, METRIC_IDS, reverts } from "./github.mjs";
import { isGreen } from "./github-reviews.mjs";
import { GH_AT_ONCE, gated } from "./github-core.mjs";
import { TARGETS, REST, GRAPHQL, REPO, HOUR_MS, ISO, fakeGh, run } from "./github-test-lib.mjs";
import { EXPECTED } from "./github-expected.mjs";

describe("targets/github.json", () => {
  // Issues (id issues) holds the issue metrics, Projects the board's, Settings
  // the repo settings this collector reads. Ids keep their prefixes.
  const TABS = ["issues", "projects", "pull-requests", "actions", "security", "settings"];
  const PREFIX = { issues: ["issues"], projects: ["projects"], "pull-requests": ["pull_requests"], actions: ["actions"], security: ["security", "actions"], settings: ["settings"] };

  it("defines exactly the metrics the collector reads", () => {
    assert.deepEqual(TARGETS.map((t) => t.id).sort(), [...METRIC_IDS].sort());
    assert.deepEqual(Object.keys(EXPECTED).sort(), [...METRIC_IDS].sort());
  });

  it("gives every metric a complete, well-formed definition", () => {
    for (const t of TARGETS) {
      assert.ok(TABS.includes(t.tab), `${t.id}: tab`);
      assert.ok(PREFIX[t.tab].includes(t.id.split(".")[0]), `${t.id}: id prefix fits tab ${t.tab}`);
      assert.ok(["quality", "speed", "consumption"].includes(t.kind), `${t.id}: kind`);
      assert.ok(t.label.split(/\s+/).length <= 6, `${t.id}: label is 6 words or fewer`);
      assert.ok(t.means && t.means.length <= 120, `${t.id}: means is 1 to 120 characters`);
      assert.ok(["higher", "lower"].includes(t.direction), `${t.id}: direction`);
      assert.ok(["none", "github-admin", "vulnerability-alerts", "project-scope"].includes(t.needs), `${t.id}: needs`);
      assert.ok(["number", "bar", "gauge", "spark", "table"].includes(t.chart), `${t.id}: chart`);
      assert.equal(typeof t.goal, "number", `${t.id}: goal`);
      assert.equal(typeof t.near, "number", `${t.id}: near`);
      assert.ok(t.direction === "higher" ? t.near <= t.goal : t.near >= t.goal, `${t.id}: near sits on the miss side of goal`);
      for (const key of ["unit", "goal_source", "source"]) assert.ok(t[key], `${t.id}: ${key}`);
      assert.ok(!/[–—]/.test(JSON.stringify(t)), `${t.id}: no em or en dashes`);
    }
  });

  it("holds its params on one target, with defaults that fit any repo", () => {
    assert.equal(TARGETS.filter((t) => t.params).length, 1);
    assert.deepEqual(TARGETS.find((t) => t.params).params, {
      repo: "",
      bug_type: "Bug",
      bug_label: "bug",
      area_labels: [],
      issue_types: ["Bug", "Task"],
      park_hours: 24,
      record_minutes: 5,
      project_title: "",
      project_columns: ["Todo", "In Progress", "Done"],
      project_workflows: ["Item added to project", "Pull request linked to issue", "Item closed", "Pull request merged", "Auto-add to project"],
      card_words: 75,
      site_url: "",
      not_reviewed: [],
      pr_body_ignore: ["<!-- codesmith:footer -->[\\s\\S]*?<!-- /codesmith:footer -->"],
      cooldown_days: 14,
      registries: ["https://registry.npmjs.org/"],
      credential_patterns: ["./.env", "./.env.*", "./secrets/**", "./**/*.pem", "./**/*.key", "~/.ssh/**", "~/.aws/**"],
      threat_model: "THREAT-MODEL.md",
      threat_model_covers: [],
      threat_model_grace_days: 0,
      max_registry_reads: 100,
      review_apps: ["claude"],
      review_authors: ["claude"],
      security_review: "",
      review_paths: [],
    });
  });

  it("names no organization, person or private repo in what it ships", () => {
    const text = JSON.stringify(TARGETS);
    assert.doesNotMatch(text, /orchestrator|lane|delegation\.md|CLAUDE\.md|decision \d|PR #\d/i);
    for (const t of TARGETS) assert.match(t.goal_source, /GitHub docs|DORA|SmartBear|OWASP|OpenSSF|Anthropic|Brysbaert|template goal/, `${t.id}: goal_source cites a public source or says template goal`);
  });

  it("gives each tab at least one quality and one speed metric", () => {
    // CI keeps only quality here; its speed metrics are in targets/ci.json.
    for (const tab of TABS.filter((t) => t !== "actions")) {
      const kinds = new Set(TARGETS.filter((t) => t.tab === tab).map((t) => t.kind));
      assert.ok(kinds.has("quality") && kinds.has("speed"), tab);
    }
  });
});

describe("collect() on the known-good fixture", async () => {
  const out = await run();

  it("returns the hand-worked value for every metric", () => {
    const got = Object.fromEntries(Object.entries(out).map(([id, m]) => [id, m.could_not_check ?? m.value]));
    assert.deepEqual(got, EXPECTED);
  });

  it("stamps every measurement with its source and read time", () => {
    for (const [id, m] of Object.entries(out)) {
      assert.ok(m.source && !m.source.includes("{repo}"), `${id}: source`);
      if (m.could_not_check) continue; // a paid feature that is off has no findings to stamp
      assert.match(m.read_at, ISO, `${id}: read_at`);
      for (const d of m.detail ?? []) {
        assert.ok(typeof d.label === "string" && typeof d.value === "number", `${id}: detail ${JSON.stringify(d)}`);
        assert.ok(d.unit === undefined || typeof d.unit === "string", `${id}: detail unit ${JSON.stringify(d)}`);
      }
    }
  });

  it("breaks open bugs down by area label", () => {
    assert.deepEqual(out["issues.open_bugs"].detail, [
      { label: "code", value: 0 },
      { label: "documentation", value: 0 },
      { label: "design", value: 0 },
      { label: "usability", value: 0 },
      { label: "security", value: 1 },
      { label: "ci", value: 0 },
      { label: "no area", value: 1 },
    ]);
  });

  it("says what each paid feature costs while it is off, on a private repo", () => {
    assert.deepEqual(out["security.code_scanning_on"].detail, [
      { label: "paid on a private repo: GitHub Code Security, $30 per active committer a month (github.com/security/plans, read 2026-11-03)", value: 30, unit: "dollars per active committer a month" },
    ]);
    assert.deepEqual(out["security.secret_scanning_on"].detail.map((d) => [d.label.split(":")[0], d.value]), [["secret scanning", 0], ["push protection", 1], ["paid on a private repo", 19]]);
    assert.deepEqual(out["security.code_quality_on"].detail, [
      { label: "paid on a private repo: GitHub Code Quality, $10 per active committer a month plus the Actions minutes its scans use (GitHub changelog, 2026-06-16, read 2026-11-10)", value: 10, unit: "dollars per active committer a month" },
    ]);
    assert.equal(out["security.policy_on"].detail, undefined, "nothing to add when it is on");
  });

  it("gives a breakdown its own unit when it counts something else", () => {
    assert.deepEqual(out["issues.reopened"].detail.at(-1), { label: "closed issues read", value: 3, unit: "" });
    assert.deepEqual(out["security.headers"].detail.at(-1), { label: "Referrer-Policy", value: 0, unit: "" });
  });

  it("borrows the headline unit only where the breakdown is in that unit", () => {
    // Breakdowns in the metric's own unit: bugs per area, days per PR, % per
    // workflow file, and so on. Every other breakdown sets one.
    const INHERITS = new Set([
      "issues.open_bugs",
      "issues.parked_open",
      "issues.oldest_open_days",
      "pull_requests.latest_merge_hours",
      "pull_requests.open_now",
      "pull_requests.oldest_open_days",
      "pull_requests.dependabot_open",
      "actions.pinned_share",
      "projects.cards_by_column",
      "projects.bug_cards",
      "projects.closed_not_done",
      "projects.oldest_doing_days",
      "security.dependabot_open",
      "security.code_scanning_open",
      "security.secret_scanning_open",
      "security.code_quality_open",
      "security.features_dollars_per_month",
    ]);
    for (const [id, m] of Object.entries(out)) {
      for (const d of m.detail ?? []) {
        if (INHERITS.has(id)) assert.equal(d.unit, undefined, `${id}: "${d.label}" is in the headline unit`);
        else assert.equal(typeof d.unit, "string", `${id}: "${d.label}" needs its own unit`);
      }
    }
  });

  it("counts a review only at the commit the PR merged at, before the merge", () => {
    // #20 clean: a person reviewed 2020… and it merged at 2020….
    // #18 bad: the person reviewed 8a8a…, a fix moved the head to 8b8b…, and only a bot reviewed 8b8b….
    // #17: a person reviewed the merged head an hour after the merge. #19: no review.
    assert.deepEqual(out["pull_requests.reviewed"].detail, [
      { label: "reviewed at the merged head", value: 1, unit: "" },
      { label: "reviewed another commit, or after merge", value: 2, unit: "" },
      { label: "not reviewed", value: 1, unit: "" },
    ]);
  });

  it("leaves lockfile and data snapshot lines out of PR size", () => {
    // #20 changes 120 lines, 15 of them in quality/data/local.json; #18 changes
    // 800, 300 of them in package-lock.json.
    assert.deepEqual(out["pull_requests.latest_lines"].detail, [
      { label: "#20", value: 105, unit: "lines" },
      { label: "lockfile and snapshot lines left out", value: 15, unit: "lines" },
      { label: "moved lines left out", value: 0, unit: "lines" },
    ]);
    assert.deepEqual(out["pull_requests.over_400_lines"].detail, [
      { label: "over 400 lines", value: 1, unit: "" },
      { label: "400 lines or fewer", value: 3, unit: "" },
    ]);
  });

  it("times each flow stage of the latest merge on the commit it merged at", () => {
    // #20's own stages, so they add up to its hour.
    assert.deepEqual(out["pull_requests.latest_merge_hours"].detail, [
      { label: "#20, open to merge", value: 1 },
      { label: "open to all green", value: 0.5 },
      { label: "all green to review", value: 0.2 },
      { label: "review to merge", value: 0.3 },
    ]);
  });

  it("counts a fix after the first review only among PRs a person reviewed before merging", () => {
    // #20 clean: first reviewed at the head it merged at. #18 bad: first reviewed
    // at 8a8a…, merged at 8b8b…. #17 was reviewed only after its merge; #19 never.
    assert.deepEqual(out["pull_requests.fixed_after_review"].detail, [
      { label: "fixed after the first review", value: 1, unit: "" },
      { label: "merged as first reviewed", value: 1, unit: "" },
      { label: "no review before merge (left out)", value: 2, unit: "" },
    ]);
  });

  it("reads a commit as green by each check's latest run, so a run that was cancelled or failed and then ran again does not count", () => {
    const run = (name, conclusion, completedAt) => ({ __typename: "CheckRun", name, conclusion, completedAt });
    const red = (...nodes) => ({ state: "FAILURE", contexts: { nodes } });
    const ok = run("ci", "SUCCESS", "2026-11-02T10:00:00Z");
    assert.equal(isGreen({ state: "SUCCESS", contexts: { nodes: [] } }), true, "the rollup's own SUCCESS stands");
    assert.equal(isGreen(red(ok, run("pr-body", "CANCELLED", "2026-11-02T10:01:00Z"), run("pr-body", "SUCCESS", "2026-11-02T10:02:00Z"))), true, "cancelled, then passed");
    assert.equal(isGreen(red(ok, run("pr-body", "SUCCESS", "2026-11-02T10:02:00Z"), run("pr-body", "FAILURE", "2026-11-02T10:01:00Z"))), true, "failed, then passed, in any order");
    assert.equal(isGreen(red(ok, run("pr-body", "SUCCESS", "2026-11-02T10:01:00Z"), run("pr-body", "FAILURE", "2026-11-02T10:02:00Z"))), false, "passed, then failed");
    assert.equal(isGreen(red(ok, run("lint", "FAILURE", "2026-11-02T10:01:00Z"))), false, "a check whose only run failed");
    assert.equal(isGreen(red(ok, run("pr-body", "SUCCESS", "2026-11-02T10:01:00Z"), run("pr-body", null, null))), false, "a later run still going");
    assert.equal(isGreen(red(ok, { __typename: "StatusContext", context: "deploy", state: "ERROR", createdAt: "2026-11-02T10:01:00Z" })), false, "a failed status");
    assert.equal(isGreen(red({ __typename: "CheckRun", completedAt: "2026-11-02T10:01:00Z" })), false, "a run with no name: the rollup stands");
    const inWorkflow = (workflow, conclusion, at) => ({ ...run("build", conclusion, at), checkSuite: { workflowRun: { workflow: { name: workflow } } } });
    assert.equal(isGreen(red(inWorkflow("pages", "FAILURE", "2026-11-02T10:01:00Z"), inWorkflow("export", "SUCCESS", "2026-11-02T10:02:00Z"))), false, "one job name in two workflows is two checks");
    assert.equal(isGreen(red(inWorkflow("pages", "FAILURE", "2026-11-02T10:01:00Z"), inWorkflow("pages", "SUCCESS", "2026-11-02T10:02:00Z"))), true, "the same workflow's job, run again");
    assert.equal(isGreen(null), false);
  });

  it("pairs a revert with the PR it undoes, by title", () => {
    assert.deepEqual(out["pull_requests.reverted"].detail, [{ label: "#19 reverts #17", value: 3.4, unit: "days" }]);
  });

  it("sorts the open queue by age and conflict", () => {
    assert.deepEqual(out["pull_requests.open_now"].detail, [
      { label: "under a day", value: 0 },
      { label: "1 to 3 days", value: 1 },
      { label: "3 to 7 days", value: 0 },
      { label: "a week or more", value: 2 },
    ]);
    assert.deepEqual(out["pull_requests.conflicting"].detail, [{ label: "#12", value: 24, unit: "days open" }]);
  });

  it("names each PR merged into a side branch, with its reviewed lines", () => {
    assert.deepEqual(out["pull_requests.merged_off_default"].detail, [{ label: "#18 into feat/fixture-b", value: 500, unit: "lines" }]);
  });

  it("skips a GitHub stack layer, which keeps its side-branch base after the stack merges onto main", async () => {
    const graphql = structuredClone(GRAPHQL);
    graphql.MergedPulls[1].repository.pullRequests.nodes[0].stack = { number: 9 };
    const got = (await run({ gh: fakeGh({ graphql }) }))["pull_requests.merged_off_default"];
    assert.deepEqual([got.value, got.detail], [0, undefined]);
  });

  it("reads side-branch merges from GraphQL alone, so a failed repo read does not blank it", async () => {
    const rest = { ...REST, [`repos/${REPO}`]: { __error: { message: "API rate limit exceeded", status: 403 } } };
    const got = (await run({ gh: fakeGh({ rest }) }))["pull_requests.merged_off_default"];
    assert.equal(got.value, 1);
  });

  it("times the wait after green on open PRs: ready, green and unblocked ones only, the longest as the value", async () => {
    assert.deepEqual(out["pull_requests.green_waiting_minutes"].detail, [
      { label: "#31, awaiting review", value: 90, unit: "minutes" },
      { label: "with a pending review request", value: 1, unit: "PRs" },
    ]);
    const head = (n) => String(n).repeat(40).slice(0, 40);
    const rollup = (state, at) => ({ nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: [{ __typename: "CheckRun", completedAt: at }] } } } }] });
    const verdict = (word, n) => ({ body: `Review: ${word} at ${head(n)}`, createdAt: "2026-11-02T19:30:00Z", lastEditedAt: null, authorAssociation: "MEMBER" });
    const open = (number, extra = {}) => ({
      number, createdAt: "2026-11-02T10:00:00Z", mergeable: "MERGEABLE", baseRefName: "main", author: { login: "fixture-user" }, labels: { nodes: [] },
      isDraft: false, headRefOid: head(number), reviewDecision: null, reviewRequests: { totalCount: 0 }, reviews: { nodes: [] }, markerComments: { nodes: [] },
      headCommit: rollup("SUCCESS", "2026-11-02T19:00:00Z"), ...extra,
    });
    const nodes = [
      open(1), // green at 19:00, nobody has read it: 60 minutes
      open(2, { markerComments: { nodes: [verdict("MERGE", 2)] }, headCommit: rollup("SUCCESS", "2026-11-02T17:00:00Z") }), // passed, not merged: 180
      open(3, { markerComments: { nodes: [verdict("BLOCK", 3)] } }), // blocked at head: waits on its author
      open(4, { reviewDecision: "CHANGES_REQUESTED" }), // GitHub's own review asks for changes
      open(5, { isDraft: true }),
      open(6, { headCommit: rollup("FAILURE", "2026-11-02T19:00:00Z") }),
      open(7, { headCommit: rollup("PENDING", null) }),
      open(8, { author: { login: "dependabot[bot]" } }),
      open(9, { markerComments: { nodes: [verdict("BLOCK", 3)] } }), // a BLOCK naming another PR's commit decides nothing here
    ];
    const queue = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes } } };
    const got = (await run({ gh: fakeGh({ graphql: { ...GRAPHQL, OpenPulls: queue } }) }))["pull_requests.green_waiting_minutes"];
    assert.equal(got.value, 180);
    assert.deepEqual(got.detail, [
      { label: "#2, reviewed, awaiting merge", value: 180, unit: "minutes" },
      { label: "#1, awaiting review", value: 60, unit: "minutes" },
      { label: "#9, awaiting review", value: 60, unit: "minutes" },
      { label: "with a pending review request", value: 0, unit: "PRs" },
    ]);
    // Verdicts that all read as from non-members cannot tell blocked from waiting.
    const outsider = { ...verdict("BLOCK", 3), authorAssociation: "CONTRIBUTOR" };
    const blind = { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: [open(3, { markerComments: { nodes: [outsider] } })] } } };
    const hidden = (await run({ gh: fakeGh({ graphql: { ...GRAPHQL, OpenPulls: blind } }) }))["pull_requests.green_waiting_minutes"];
    assert.match(hidden.could_not_check, /membership is private to this token/);
  });

  it("lists severities in order, with zeros kept", () => {
    assert.deepEqual(out["security.dependabot_open"].detail.map((d) => d.label), ["critical", "high", "medium", "low"]);
  });
});

describe("last-N bases, no calendar windows (metrics-now spec, 2026-11-03)", () => {
  const T0 = Date.parse("2026-11-02T00:00:00Z");
  const at = (ms) => new Date(ms).toISOString();

  it("names N in the source of every last-N target, and has no spark or calendar window", () => {
    for (const t of TARGETS) {
      assert.ok(/^(state|latest): /.test(t.source) || /N = \d+/.test(t.source), `${t.id}: source says state or latest, or names N`);
      if (/^latest: /.test(t.source)) assert.match(t.id, /\.latest_/, `${t.id}: a latest-event row is named latest`);
      assert.notEqual(t.chart, "spark", `${t.id}: no spark`);
      assert.ok(!/last 100|per week|this week|days before the read/i.test(t.source), `${t.id}: no window in source`);
    }
  });

  it("reads no calendar-window search and no Actions runs or jobs", async () => {
    const gh = fakeGh();
    await run({ gh });
    assert.ok(!gh.calls.some((c) => /search|actions\/(runs|jobs|workflows)/.test(c)), gh.calls.join(", "));
    assert.equal(gh.calls.length, 30, gh.calls.join(", ")); // one of them actions/permissions, a settings read; one the board's workflows; one code quality's findings
  });

  it("keeps the 20 latest merges, including one opened early but merged last", async () => {
    // 30 merged PRs, newest opened first. #1 was opened first but merged last.
    const nodes = Array.from({ length: 30 }, (_, i) => {
      const n = 30 - i;
      const created = T0 + n * HOUR_MS;
      const merged = n === 1 ? T0 + 40 * HOUR_MS : created + HOUR_MS / 2;
      return {
        number: n, title: n === 2 ? 'Revert "PR 25"' : `PR ${n}`, createdAt: at(created), mergedAt: at(merged),
        additions: n, deletions: 0, headRefOid: `h${n}`, files: { nodes: [] }, reviews: { nodes: [] },
        headCommit: { nodes: [] },
      };
    });
    const queries = [];
    const gh = fakeGh({ graphql: { ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: true, endCursor: "x" }, nodes } } } } });
    const base = gh.graphql;
    gh.graphql = (q, v) => (queries.push(q), base(q, v));
    const out = await run({ gh });
    assert.equal(gh.calls.filter((c) => c === "MergedPulls").length, 1, "one page of 30, no second call");
    assert.match(queries.find((q) => /query MergedPulls/.test(q)), /first: 30,/);
    assert.match(queries.find((q) => /query MergedPulls/.test(q)), /orderBy: \{field: UPDATED_AT, direction: DESC\}/, "a merge updates a PR, so a long-open PR merged today is read");
    assert.deepEqual(out["pull_requests.over_400_lines"].detail, [
      { label: "over 400 lines", value: 0, unit: "" },
      { label: "400 lines or fewer", value: 20, unit: "" },
    ]);
    // The 20 latest merges: #1 (merged last), then #30 down to #12.
    // Lines equal the number: 1, then 12 to 30. Median of those 20 is (20 + 21) / 2, rounded to 21.
    assert.equal(out["pull_requests.latest_lines"].value, 1, "#1, merged last though opened first, changed 1 line");
    // #2 is not among the 20, so its revert of #25 is not read.
    assert.equal(out["pull_requests.reverted"].value, 0);
  });

  it("counts every revert among the 20, even of a PR merged before them", async () => {
    const pulls = [
      { number: 50, title: 'Revert "Old change"', createdAt: "2026-11-02T10:00:00Z", mergedAt: "2026-11-02T11:00:00Z", additions: 1, deletions: 0, headRefOid: "r", files: { nodes: [] }, reviews: { nodes: [] }, headCommit: { nodes: [] } },
    ];
    const out = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: false }, nodes: pulls } } } } }) });
    assert.equal(out["pull_requests.reverted"].value, 1);
    assert.deepEqual(out["pull_requests.reverted"].detail, [{ label: "#50 reverts a PR before the last 20", value: 1, unit: "" }]);
  });

  it("reads only the 20 latest closed issues", async () => {
    // 25 closed issues; #1 to #5 closed first, by hand, after 100 hours and a reopen. #6 to #25 closed by a PR in 1 hour.
    const nodes = Array.from({ length: 25 }, (_, k) => {
      const n = k + 1;
      const old = n <= 5;
      const closed = T0 + n * HOUR_MS;
      return {
        number: n, state: "CLOSED", stateReason: "COMPLETED", createdAt: at(closed - (old ? 100 : 1) * HOUR_MS), closedAt: at(closed),
        issueType: { name: "Bug" }, labels: { nodes: [{ name: "bug" }] }, reopened: { totalCount: old ? 1 : 0 },
        closedBy: { nodes: [{ closer: old ? { __typename: "User" } : { __typename: "PullRequest", merged: true } }] },
      };
    });
    const out = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, Issues: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes } } } } }) });
    assert.equal(out["issues.closed_by_pr"].value, 100);
    assert.equal(out["issues.reopened"].value, 0);
    assert.deepEqual(out["issues.latest_close_hours"].detail, [{ label: "#25", value: 1, unit: "hours" }], "the latest close, never a median");
  });

  it("times only the card most recently moved to Done", async () => {
    // 12 Done cards, each with a PR; the latest took 2 hours, the 11 before it 100 each.
    const nodes = Array.from({ length: 12 }, (_, k) => {
      const done = T0 + (k + 1) * HOUR_MS;
      const took = k === 11 ? 2 : 100;
      return {
        createdAt: at(T0 - 200 * HOUR_MS), status: { name: "Done", updatedAt: at(done) }, linked: null,
        content: { __typename: "PullRequest", merged: true, createdAt: at(done - took * HOUR_MS) },
      };
    });
    const out = await run({ gh: fakeGh({ graphql: { ...GRAPHQL, ProjectItems: { node: { items: { pageInfo: { hasNextPage: false }, nodes } } } } }) });
    assert.equal(out["projects.latest_cycle_hours"].value, 2, "a median of the last 10 would be 100");
  });

});

describe("gated: one cap on gh calls for the whole process", () => {
  it("runs GH_AT_ONCE at a time, never more, and a failed call frees its slot", async () => {
    let live = 0;
    let peak = 0;
    const call = (i) => gated(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live -= 1;
      if (i % 3 === 0) throw new Error(`HTTP 502 on ${i}`);
      return i;
    });
    const got = await Promise.allSettled(Array.from({ length: GH_AT_ONCE * 3 }, (_, i) => call(i)));
    assert.equal(peak, GH_AT_ONCE);
    assert.deepEqual(got.filter((g) => g.status === "fulfilled").map((g) => g.value), Array.from({ length: GH_AT_ONCE * 3 }, (_, i) => i).filter((i) => i % 3));
    assert.equal(await gated(async () => "free"), "free", "every slot came back");
  });
});
