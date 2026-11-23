// Tests for pull_requests.issue_before_pr_share. Run with `node --test quality/collectors/github/github-issue-first.test.mjs`.
// The fixture's merged PRs: #20 closes #5, made before it opened; #18 closes #14, made after; #19 is Dependabot's; #17 closes none.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GRAPHQL, REST, fakeGh, run } from "./github-test-lib.mjs";

const ID = "pull_requests.issue_before_pr_share";
const pr = (number, createdAt, issues, login = "someone") => ({ number, title: `PR ${number}`, createdAt, mergedAt: createdAt, author: { login }, closingIssuesReferences: { nodes: issues } });
const withPulls = (nodes) => ({ ...GRAPHQL, MergedPulls: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
const read = async (nodes) => (await run(nodes ? { gh: fakeGh({ rest: REST, graphql: withPulls(nodes) }) } : {}))[ID];

describe(ID, () => {
  it("reads the share of closing PRs whose issue came first, and leaves out Dependabot and a PR that closes none", async () => {
    const out = await read();
    assert.equal(out.value, 50);
    assert.deepEqual(out.detail.map((d) => d.value), [1, 2]);
  });

  it("counts an issue made at the very second the PR opened as not first", async () => {
    const at = "2026-11-01T10:00:00Z";
    assert.equal((await read([pr(1, at, [{ number: 1, createdAt: at }])])).value, 0);
    assert.equal((await read([pr(1, at, [{ number: 1, createdAt: "2026-11-01T09:59:59Z" }])])).value, 100);
  });

  it("needs every closed issue to come first", async () => {
    const issues = [{ number: 1, createdAt: "2026-10-01T00:00:00Z" }, { number: 2, createdAt: "2026-11-02T00:00:00Z" }];
    assert.equal((await read([pr(1, "2026-11-01T00:00:00Z", issues)])).value, 0);
  });

  it("is not measured when no merged PR closes an issue, never 0", async () => {
    const out = await read([pr(1, "2026-11-01T00:00:00Z", []), pr(2, "2026-11-01T00:00:00Z", [{ number: 3, createdAt: "2026-10-01T00:00:00Z" }], "dependabot")]);
    assert.match(out.could_not_check, /no merged PR closes an issue/);
    assert.equal(out.value, undefined);
  });
});
