// Tests for the GitHub collector's Milestones metric. Run with `node --test quality/collectors/github/github-milestones.test.mjs`.
// The fixture's open milestones: #1 is dated and open, #2 is past its date, #3 has no date, #4 has every issue closed.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REST, GRAPHQL, REPO, fakeGh, run } from "./github-test-lib.mjs";

const ID = "issues.milestones_off_track";
const ROUTE = `repos/${REPO}/milestones?state=open&per_page=100`;
const read = async (milestones) => (await run(milestones ? { gh: fakeGh({ rest: { ...REST, [ROUTE]: milestones }, graphql: GRAPHQL }) } : {}))[ID];
const rows = (entry) => Object.fromEntries(entry.detail.map((d) => [d.label, d.value]));

describe("issues.milestones_off_track", () => {
  it("counts a milestone with no date, a past date or every issue closed, once each", async () => {
    const out = await read();
    assert.equal(out.value, 3);
    assert.deepEqual(rows(out), { "open milestones": 4, "no due date": 1, "past its due date": 1, "every issue closed": 1 });
  });

  it("counts a milestone that is both undated and finished once", async () => {
    const out = await read([{ number: 1, due_on: null, open_issues: 0, closed_issues: 2 }]);
    assert.equal(out.value, 1);
    assert.equal(rows(out)["no due date"], 1);
    assert.equal(rows(out)["every issue closed"], 1);
  });

  it("leaves a new dated milestone with no issue yet on track", async () => {
    const out = await read([{ number: 1, due_on: "2026-12-31T08:00:00Z", open_issues: 0, closed_issues: 0 }]);
    assert.equal(out.value, 0);
  });

  it("reads 0, not could_not_check, with no open milestone", async () => {
    const out = await read([]);
    assert.equal(out.value, 0);
    assert.equal(out.could_not_check, undefined);
  });

  it("takes a failed read as could_not_check, never 0", async () => {
    const out = await read({ __error: { message: "Resource not accessible by integration", status: 403 } });
    assert.ok(out.could_not_check && out.value === undefined);
  });
});
