// Tests for the GitHub collector's Discussions metrics. Run with `node --test quality/collectors/github/github-discussions.test.mjs`.
// The fixture's discussions: #1 and #3 await an answer (13 days and a day old), #2 is answered, #4 is an announcement.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REST, GRAPHQL, PARAMS, REPO, fakeGh, run } from "./github-test-lib.mjs";

const IDS = ["discussions.unanswered_old", "discussions.oldest_unanswered_hours"];
const repoWith = (extra) => ({ ...REST, [`repos/${REPO}`]: { ...REST[`repos/${REPO}`], ...extra } });
const withNodes = (nodes) => ({ ...GRAPHQL, OpenDiscussions: { repository: { discussions: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
const read = async (opts) => {
  const out = await run(opts);
  return Object.fromEntries(IDS.map((id) => [id, out[id]]));
};

describe("Discussions metrics", () => {
  it("count the answerable questions past the limit and the oldest one's wait", async () => {
    const out = await read();
    assert.equal(out["discussions.unanswered_old"].value, 1);
    assert.deepEqual(out["discussions.unanswered_old"].detail.map((d) => d.value), [1, 2]);
    assert.equal(out["discussions.oldest_unanswered_hours"].value, 312);
    assert.deepEqual(out["discussions.oldest_unanswered_hours"].detail, [{ label: "#1", value: 312, unit: "hours" }]);
  });

  it("read 0, not could_not_check, when only an announcement and an answered question are open", async () => {
    const nodes = [
      { number: 1, createdAt: "2026-10-01T00:00:00Z", isAnswered: null, category: { isAnswerable: false } },
      { number: 2, createdAt: "2026-10-02T00:00:00Z", isAnswered: true, category: { isAnswerable: true } },
    ];
    const out = await read({ gh: fakeGh({ rest: REST, graphql: withNodes(nodes) }) });
    for (const id of IDS) assert.equal(out[id].value, 0, id);
  });

  it("read 0 with no open discussion at all", async () => {
    const out = await read({ gh: fakeGh({ rest: REST, graphql: withNodes([]) }) });
    for (const id of IDS) assert.equal(out[id].value, 0, id);
  });

  it("are not measured while Discussions is off", async () => {
    const out = await read({ gh: fakeGh({ rest: repoWith({ has_discussions: false }), graphql: GRAPHQL }) });
    for (const id of IDS) assert.match(out[id].could_not_check, /Discussions is off/, id);
  });

  it("follow params.discussion_days", async () => {
    const out = await read({ params: { ...PARAMS, discussion_days: 0.5 } });
    assert.equal(out["discussions.unanswered_old"].value, 2, "#3 is a day old, over half a day");
  });

  it("take a failed read as could_not_check, never 0", async () => {
    const graphql = { ...GRAPHQL, OpenDiscussions: { __error: { message: "Resource not accessible by integration", status: 403 } } };
    const out = await read({ gh: fakeGh({ rest: REST, graphql }) });
    for (const id of IDS) assert.ok(out[id].could_not_check && out[id].value === undefined, id);
  });
});
