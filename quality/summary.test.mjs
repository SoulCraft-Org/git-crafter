import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { noticeLine, pageScores, publishScores, summaryMarkdown } from "./summary.mjs";

const def = (id, tab, kind, goal, near, label = id) => ({ id, tab, kind, direction: "lower", goal, near, label });
const defs = [def("a.one", "code", "quality", 0, 5), def("a.two", "code", "speed", 10, 20), def("b.one", "docs", "quality", 0, 5), def("b.two", "docs", "speed", 10, 20)];
const entry = (value) => ({ value, state: "measured" });
const metrics = { "a.one": entry(0), "a.two": entry(15), "b.one": entry(9), "b.two": entry(5) };
const tabs = [["code", "Code"], ["docs", "Docs, here: 50%"]];

it("pageScores scores each tab and the master as the page does, and ranks the work queue", () => {
  const s = pageScores({ defs, metrics, tabs });
  assert.deepEqual(s.tabs.map((t) => [t.id, t.quality, t.speed, t.misses]), [["code", 100, 50, 0], ["docs", 0, 100, 1]]);
  assert.equal(s.categories.quality, 50);
  assert.equal(s.categories.speed, 75);
  assert.equal(s.master, 63);
  assert.deepEqual(s.queue.map((q) => q.id), ["b.one", "a.two"]);
});

it("summaryMarkdown names the master, each category, each tab and the queue", () => {
  const md = summaryMarkdown(pageScores({ defs, metrics, tabs }), { name: "demo", commit: "0123456789abcdef" });
  assert.match(md, /^### Quality, Speed and Consumption: demo\n/);
  assert.match(md, /Master score \*\*63 \/ 100\*\* at `0123456`/);
  assert.match(md, /\| Quality \| 50 \|/);
  assert.match(md, /\| Code \| 100 \| 50 \| – \| 0 \|/);
  assert.match(md, /\| b\.one \| docs \| \+/);
});

it("noticeLine escapes the workflow-command characters and keeps every tab on its own line", () => {
  const line = noticeLine(pageScores({ defs, metrics, tabs }));
  assert.ok(line.startsWith("::notice title=Quality page master score 63 of 100::"));
  assert.ok(!line.includes("\n"), "one physical line");
  assert.match(line, /Quality 50, Speed 75, Consumption –%0ACode: quality 100/);
  assert.match(line, /Docs, here: 50%25: quality 0/);
});

it("publishScores writes the summary file and the notice inside Actions, and nothing outside", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "summary-")), "step.md");
  writeFileSync(file, "earlier\n");
  const logged = [];
  const scores = pageScores({ defs, metrics, tabs });
  assert.deepEqual(publishScores(scores, { env: {}, log: (l) => logged.push(l) }), { summary: false, notice: false });
  assert.deepEqual(logged, []);
  assert.deepEqual(publishScores(scores, { env: { GITHUB_STEP_SUMMARY: file, GITHUB_ACTIONS: "true" }, log: (l) => logged.push(l), name: "demo" }), { summary: true, notice: true });
  assert.match(readFileSync(file, "utf8"), /^earlier\n### Quality, Speed and Consumption: demo/);
  assert.equal(logged.length, 1);
});
