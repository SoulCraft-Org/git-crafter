// Tests for the issue sync. Run with `node --test quality/sync-issues.test.mjs`.
// A fake gh answers the open-issues read from a list and records every write,
// so nothing reaches GitHub. The run is a temp repo's latest.json scored by the
// template's own Issues targets.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig } from "./config.mjs";
import { ghCli, issueBody, marker, meter, OPEN_CAP, pageUrl, parseArgs, plan, sync } from "./sync-issues.mjs";

const REPO = "fixture-org/fixture-repo";
const root = mkdtempSync(join(tmpdir(), "sync-issues-"));
after(() => rmSync(root, { recursive: true, force: true }));

// issues.open_bugs misses (5, goal 0, near 3); issues.reopened meets; issues.oldest_open_days is near (4, goal 2, near 7);
// issues.area_labeled misses and is not quick: a board card, Waiting on data.
const RUN = {
  generated_at: "2026-11-10T00:00:00Z",
  mode: "ci",
  metrics: {
    "issues.open_bugs": { value: 5, source: "code-os quality/collectors/github/github.mjs" },
    "issues.reopened": { value: 0 },
    "issues.oldest_open_days": { value: 4 },
    "issues.area_labeled": { value: 50 },
  },
};
const QUICK = ["issues.open_bugs", "issues.reopened", "issues.oldest_open_days"];
const SYNC = { label: "quality", labels: { issues: "pages" }, project: 3, quick: QUICK, waiting: ["issues.area_labeled"] };
// A repo in its own folder under root whose latest run holds `metrics`, with issue_sync on.
function repoWith(name, metrics, sync = SYNC) {
  const dir = join(root, name);
  mkdirSync(join(dir, "quality", "data"), { recursive: true });
  writeFileSync(join(dir, "quality", "data", "latest.json"), JSON.stringify({ ...RUN, metrics }));
  writeFileSync(join(dir, "quality.json"), JSON.stringify({ repo: REPO, tabs: ["issues"], issue_sync: sync }));
  return loadConfig({ root: dir, file: "quality.json", env: {} });
}
const config = repoWith("main", RUN.metrics);
// A body the sync itself wrote for metric id.
const own = (id) => issueBody({ def: { id, unit: "", goal: 0, direction: "lower" }, entry: { value: 1, source: "x" } }, "opened");

// A gh stand-in: GET answers `open`, every write is recorded in `calls`.
function fakeGh(open = []) {
  const calls = [];
  const gh = (args, body) => {
    calls.push({ args, body });
    return args.includes("--method") ? {} : [open];
  };
  return { gh, calls };
}
const writes = (calls) => calls.filter((c) => c.args.includes("--method"));
const quiet = () => {};

// A board stand-in for gq: the read answers `cards`, every call is recorded.
const field = (name, opts) => ({ id: `F_${name}`, name, options: opts.map((o) => ({ id: `O_${o}`, name: o })) });
const FIELDS = [field("Status", ["Todo", "Waiting on data", "Done"]), field("Pillar", ["Quality", "Speed"]), field("Area", ["pages"]), {}];
const cardNode = (id, status, body = own(id)) => ({ id: `PVTI_${id}`, databaseId: 5, content: { id: `DI_${id}`, body }, fieldValueByName: { name: status } });
function fakeBoard(cards = []) {
  const calls = [];
  const gq = (query, variables) => {
    calls.push({ query, variables });
    if (query.startsWith("query")) return { data: { organization: { projectV2: { id: "PVT_1", fields: { nodes: FIELDS }, items: { pageInfo: { hasNextPage: false }, nodes: cards } } } } };
    return { data: { addProjectV2DraftIssue: { projectItem: { id: "PVTI_new", databaseId: 77 } } } };
  };
  return { gq, calls };
}
const CARD_URL = (n) => `https://github.com/orgs/fixture-org/projects/3?pane=issue&itemId=${n}`;

describe("sync", () => {
  it("opens one Task issue per missed metric, with its tab's area label and a table body", () => {
    const { gh, calls } = fakeGh();
    const steps = sync(config, { gh, log: quiet });
    assert.deepEqual(steps.map((s) => `${s.op} ${s.row.def.id}`), ["open issues.open_bugs", "log issues.area_labeled"]);
    const [post] = writes(calls);
    assert.deepEqual(post.args, ["--method", "POST", `repos/${REPO}/issues`]);
    assert.equal(post.body.type, "Task");
    assert.deepEqual(post.body.labels, ["pages"]);
    assert.ok(post.body.body.startsWith(marker("issues.open_bugs")));
    assert.match(post.body.body, /\| issues\.open_bugs \| 5 bugs \| at most 0 bugs \| code-os quality\/collectors\/github\/github\.mjs \| opened \|/);
  });

  it("never opens a second issue: an unchanged open issue is left alone", () => {
    const row = { def: { id: "issues.open_bugs", unit: "bugs", goal: 0, direction: "lower", file: "github.json" }, entry: RUN.metrics["issues.open_bugs"] };
    const { gh, calls } = fakeGh([{ number: 7, body: issueBody(row, "opened") }]);
    sync(config, { gh, log: quiet });
    assert.equal(writes(calls).length, 0);
  });

  it("updates the table in place when Now changed, naming the old value", () => {
    const old = issueBody({ def: { id: "issues.open_bugs", unit: "bugs", goal: 0, direction: "lower" }, entry: { value: 8, source: "x" } }, "opened");
    const { gh, calls } = fakeGh([{ number: 7, body: old }]);
    sync(config, { gh, log: quiet });
    const [patch] = writes(calls);
    assert.deepEqual(patch.args, ["--method", "PATCH", `repos/${REPO}/issues/7`]);
    assert.match(patch.body.body, /\| 5 bugs \|.*\| was 8 bugs \|/);
  });

  it("closes the issue of a metric that meets its goal, as completed", () => {
    const { gh, calls } = fakeGh([{ number: 9, body: own("issues.reopened") }, { number: 10, body: own("issues.oldest_open_days") }]);
    sync(config, { gh, log: quiet });
    const closes = writes(calls).filter((c) => c.body.state === "closed");
    assert.deepEqual(closes.map((c) => c.args.at(-1)), [`repos/${REPO}/issues/9`]);
    assert.equal(closes[0].body.state_reason, "completed");
  });

  it("makes a draft card for a missed metric that is not quick, with Status, Pillar and Area, and no issue", () => {
    const { gh, calls } = fakeGh();
    const board = fakeBoard();
    sync(config, { gh, gq: board.gq, log: quiet });
    assert.ok(!writes(calls).some((c) => c.body.title?.includes("area label")));
    const [, add, set] = board.calls;
    assert.equal(add.variables.t, "Issues: Issues with an area label misses its goal");
    assert.ok(add.variables.b.startsWith(marker("issues.area_labeled")));
    for (const o of ["O_Waiting on data", "O_Quality", "O_pages"]) assert.ok(set.query.includes(`"${o}"`), o);
  });

  it("moves a met metric's card to Done", () => {
    const met = repoWith("met", RUN.metrics, { ...SYNC, quick: [] });
    const board = fakeBoard([cardNode("issues.reopened", "Todo")]);
    const steps = sync(met, { gh: fakeGh().gh, gq: board.gq, log: quiet });
    assert.ok(steps.some((s) => s.op === "card" && s.row.def.id === "issues.reopened" && s.status === "Done"));
    assert.ok(board.calls.some((c) => c.query.includes('"PVTI_issues.reopened"') && c.query.includes('"O_Done"')));
  });

  it("closes a board metric's open issue as not planned, with one comment linking its card", () => {
    const { gh, calls } = fakeGh([{ number: 12, body: own("issues.area_labeled") }]);
    sync(config, { gh, gq: fakeBoard().gq, log: quiet });
    const mine = writes(calls).filter((c) => c.args.at(-1).includes("/issues/12"));
    assert.deepEqual(mine.map((c) => c.args), [
      ["--method", "POST", `repos/${REPO}/issues/12/comments`],
      ["--method", "PATCH", `repos/${REPO}/issues/12`],
    ]);
    assert.equal(mine[0].body.body, `Moved to its board card: ${CARD_URL(77)}`);
    assert.deepEqual(mine[1].body, { state: "closed", state_reason: "not_planned" });
  });

  it("with no board token, logs the card it would make, opens no issue and leaves an old one open", () => {
    const { gh, calls } = fakeGh([{ number: 12, body: own("issues.area_labeled") }]);
    const lines = [];
    sync(config, { gh, log: (l) => lines.push(l) });
    assert.deepEqual(writes(calls).filter((c) => c.args.at(-1).includes("/issues/12") || c.body.title?.includes("area label")), []);
    assert.ok(lines.includes("no board token: card for issues.area_labeled, not an issue; #12 stays open"));
  });
});

describe("sync, what it leaves alone", () => {
  it("skips pull requests that carry a marker", () => {
    const { gh, calls } = fakeGh([{ number: 3, body: own("issues.reopened"), pull_request: {} }]);
    sync(config, { gh, log: quiet });
    assert.ok(!writes(calls).some((c) => c.body.state === "closed"));
  });

  it("treats an issue with several markers, or a hand-written body, as covering its metrics and never touches it", () => {
    const both = `${marker("issues.open_bugs")}\n${marker("issues.reopened")}\n\n| Hand | table |\n|---|---|\n| a | b |\n`;
    for (const body of [both, `${marker("issues.reopened")}\n${marker("issues.open_bugs")}`, `Filed by hand\n${marker("issues.open_bugs")}`]) {
      const { gh, calls } = fakeGh([{ number: 4, body }]);
      const steps = sync(config, { gh, log: quiet });
      assert.deepEqual(writes(calls).filter((c) => c.body.title?.includes("Open bugs") || c.args.at(-1).endsWith("/4")), []);
      assert.ok(!steps.some((s) => s.row.def.id === "issues.open_bugs"));
    }
  });

  it("opens at most OPEN_CAP issues a run and logs how many it held back", () => {
    const misses = { "issues.open_bugs": { value: 9 }, "issues.parked_open": { value: 9 }, "issues.stray_labels": { value: 9 }, "issues.intake_ready": { value: 0 }, "issues.closed_by_pr": { value: 0 }, "issues.reopened": { value: 90 }, "issues.oldest_open_days": { value: 90 } };
    const { gh, calls } = fakeGh();
    const lines = [];
    sync(repoWith("flood", misses, { label: "quality" }), { gh, log: (l) => lines.push(l) });
    assert.equal(writes(calls).length, OPEN_CAP);
    assert.ok(lines.includes(`held back ${Object.keys(misses).length - OPEN_CAP} new issue(s) or card(s) past the cap of ${OPEN_CAP}; the next run opens them`));
  });

  it("writes nothing in a dry run, and logs each step", () => {
    const { gh, calls } = fakeGh();
    const lines = [];
    sync(config, { gh, dryRun: true, log: (l) => lines.push(l) });
    assert.equal(writes(calls).length, 0);
    assert.ok(lines.includes("[dry run] open issues.open_bugs"));
    assert.ok(lines.includes("[dry run] no board token: card for issues.area_labeled, not an issue"));
  });
});

describe("plan", () => {
  const def = { id: "a.b", unit: "%", goal: 100, near: 90, direction: "higher" };
  it("leaves a near or not-measured metric alone, open issue or not", () => {
    const open = new Map([["a.b", { number: 1, body: "" }]]);
    for (const status of ["near", "not-measured"]) assert.equal(plan({ def, entry: {}, status }, open), null);
  });
  it("ignores a board metric that meets its goal with no card, and a hand-written card", () => {
    const row = (status) => ({ def, entry: { value: status === "meets" ? 100 : 50 }, status });
    assert.equal(plan(row("meets"), new Map(), { project: 3 }, null, new Map()), null);
    const hand = new Map([["a.b", { item: "I", hand: true, status: "Todo" }]]);
    for (const status of ["meets", "misses"]) assert.equal(plan(row(status), new Map(), { project: 3 }, null, hand), null);
  });
});

describe("the body's first line", () => {
  const def = { id: "deploy.waiting_merges", unit: "merges", goal: 0, near: 5, direction: "lower" };
  const PAGE = "https://x.pages.github.io/quality/";
  it("shows now, a 10-cell meter, the goal and the metric's link, between the marker and the table", () => {
    const body = issueBody({ def, entry: { value: 7, source: "s" } }, "opened", PAGE);
    const [mark, , line, , header] = body.split("\n");
    assert.equal(mark, marker(def.id), "the marker stays first, so hand-written detection is unchanged");
    assert.equal(line, `🔴 7 merges · ▰▰▰▰▱▱▱▱▱▱ · 🎯 at most 0 merges · [Quality page](${PAGE}#m-deploy.waiting_merges)`);
    assert.equal(header, "| Metric id | Now | Goal | Source | Change |");
    assert.doesNotMatch(issueBody({ def, entry: { value: 7 } }, "opened"), /Quality page/, "no address, no link");
  });
  it("fills the meter by closeness: full at the goal, half at the near edge, less beyond", () => {
    assert.deepEqual([0, 5, 10, 45].map((v) => meter(def, v)), ["▰▰▰▰▰▰▰▰▰▰", "▰▰▰▰▰▱▱▱▱▱", "▰▰▰▱▱▱▱▱▱▱", "▰▱▱▱▱▱▱▱▱▱"]);
    assert.equal(meter({ goal: 100, near: 90, direction: "higher" }, 70), "▰▰▰▱▱▱▱▱▱▱");
  });
  it("an update that only changes format keeps the old Change cell, and waits while the address is unread", () => {
    const row = { def, entry: { value: 7, source: "s" }, status: "misses" };
    const old = `${marker(def.id)}\n\n| Metric id | Now | Goal | Source | Change |\n|---|---|---|---|---|\n| deploy.waiting_merges | 7 merges | at most 0 merges | s | was 4 merges |\n`;
    const open = new Map([[def.id, { number: 641, body: old }]]);
    const step = plan(row, open, {}, PAGE);
    assert.equal(step.op, "update");
    assert.equal(step.body, issueBody(row, "was 4 merges", PAGE));
    assert.equal(plan(row, open, {}, null), null, "a failed Pages read never rewrites the body");
    assert.equal(plan(row, new Map([[def.id, { number: 641, body: step.body }]]), {}, PAGE), null, "the new format is left alone");
  });
  it("reads the page's address from the repo's Pages site, else null", () => {
    assert.equal(pageUrl(() => ({ html_url: "https://x.pages.github.io/" }), "o/r"), PAGE);
    assert.equal(pageUrl(() => ({ html_url: "https://x.pages.github.io" }), "o/r"), PAGE);
    assert.equal(pageUrl(() => { throw new Error("HTTP 403"); }, "o/r"), null);
    assert.equal(pageUrl(() => [], "o/r"), null);
  });
});

describe("config and CLI", () => {
  it("is off by default and rejects a malformed issue_sync", () => {
    const bare = mkdtempSync(join(tmpdir(), "sync-off-"));
    assert.equal(loadConfig({ root: bare, env: {} }).issue_sync, null);
    writeFileSync(join(bare, "q.json"), JSON.stringify({ issue_sync: { labels: {} } }));
    assert.throws(() => loadConfig({ root: bare, file: "q.json", env: {} }), /issue_sync must be/);
    writeFileSync(join(bare, "q.json"), JSON.stringify({ issue_sync: { label: "quality", project: "3" } }));
    assert.throws(() => loadConfig({ root: bare, file: "q.json", env: {} }), /issue_sync must be/, "a project is a number");
    writeFileSync(join(bare, "q.json"), JSON.stringify({ issue_sync: { label: "quality", board: [] } }));
    assert.throws(() => loadConfig({ root: bare, file: "q.json", env: {} }), /issue_sync must be/, "the old board key is gone");
    rmSync(bare, { recursive: true, force: true });
  });
  it("parses --config and --dry-run, and rejects anything else", () => {
    assert.deepEqual(parseArgs(["--dry-run", "--config", "c.json"]), { config: "c.json", dryRun: true });
    assert.equal(parseArgs(["--local"]), null);
  });
  it("ghCli sends a body on stdin with --input -", () => {
    let seen;
    const gh = ghCli((cmd, args, opts) => ((seen = { cmd, args, opts }), '{"number":1}'));
    assert.deepEqual(gh(["--method", "POST", "repos/o/r/issues"], { title: "t" }), { number: 1 });
    assert.deepEqual(seen.args, ["api", "--method", "POST", "repos/o/r/issues", "--input", "-"]);
    assert.equal(seen.opts.input, '{"title":"t"}');
  });
});
