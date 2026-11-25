// node --test tests/pages-lanes.test.mjs: a map whose steps name an actor is
// drawn as lanes, one band per actor. CI runs every tests/pages*.test.mjs
// through tools/verify.sh.

import assert from "node:assert/strict";
import { test } from "node:test";

import { checkMaps } from "../pages/build.mjs";
import { ACTORS, trail } from "../pages/draw.mjs";
import { LANES, lanes, place } from "../pages/draw-lanes.mjs";
import { mapsTab } from "../pages/maps-tab.mjs";

const step = (id, actor, at) => ({ id, name: id, actor, ...(at ? { at } : {}), tools: ["t"], rule: "Rule.", rule_ref: "README.md", metric: "ci.latest_flow" });
const LINE = { id: "m", name: "Map", why: "w", steps: [step("plan", "owner"), step("build", "worker"), step("check", "ci"), step("fix", "worker"), step("merge", "orchestrator")] };
const FORK = { id: "f", name: "Fork", why: "w", steps: [step("ask", "contributor", [0, 0]), step("issue", "orchestrator", [1, 0]), step("card", "orchestrator", [1, 1]), step("close", "ci", [2, 0])] };
const readouts = (map) => Object.fromEntries(map.steps.map((s) => [s.id, { label: s.name, value: 1, unit: "on/off", kind: "speed" }]));
const ys = (svg) => [...svg.matchAll(/class="t-node" cx="[\d.]+" cy="([\d.]+)"/g)].map((m) => Number(m[1]));

test("a step's actor must be a known one, and one step with an actor means every step has one", () => {
  const doc = (steps) => ({ repo_url: "https://example.org", maps: [{ ...LINE, steps }] });
  assert.deepEqual(checkMaps(doc(LINE.steps)), []);
  assert.match(checkMaps(doc([{ ...LINE.steps[0], actor: "robot" }, ...LINE.steps.slice(1)])).join(), /step "plan": actor must be one of owner, orchestrator, worker, reviewer, contributor, ci, dependabot, github/);
  assert.match(checkMaps(doc([LINE.steps[0], { ...LINE.steps[1], actor: undefined }])).join(), /1 of 2 steps have an actor; lanes need every step to have one/);
  assert.deepEqual(checkMaps(doc(LINE.steps.map(({ actor, ...s }) => s))), [], "no step with an actor draws the trail, as before");
});

test("a lane map has one band per actor in order of first appearance, each step in its own band", () => {
  const svg = lanes(LINE, readouts(LINE), new Set(["plan", "merge"]), "plan");
  const bands = [...svg.matchAll(/<rect class="t-lane[^"]*" x="0" y="([\d.]+)" width="[\d.]+" height="([\d.]+)"\/><text class="t-actor"[^>]*>([^<]+)</g)];
  assert.deepEqual(bands.map((b) => b[3]), ["Owner", "Worker", "CI", "Orchestrator"]);
  const actors = [...new Set([...svg.matchAll(/data-actor="([^"]+)"/g)].map((m) => m[1]))];
  assert.deepEqual(actors.map((a) => ACTORS[a]), bands.map((b) => b[3]), "the lane filter pairs each toggle with its band in this order");
  assert.deepEqual(bands.map((b) => Number(b[1])), [0, 160, 320, 480], "bands stack from the top, one row each");
  assert.deepEqual(ys(svg), [72, 232, 392, 232, 552], "a step sits in its actor's band, so Build and Fix share a line");
  assert.match(svg, new RegExp(`viewBox="0 0 ${LANES.width} 640"`), "920 wide, the phone scroll width, and as tall as its bands");
  assert.match(svg, /aria-label="Map: 5 steps in 4 lanes, one each for Owner, Worker, CI, Orchestrator;/);
  assert.equal((svg.match(/class="t-step/g) ?? []).length, 5);
  assert.equal((svg.match(/<path class="t-(main|off)"/g) ?? []).length, 4, "one line from each step to the next");
  assert.equal((svg.match(/class="t-main"/g) ?? []).length, 0, "thick only between steps that are both critical, and none are next to each other here");
  assert.match(svg, /data-tip="2 build by Worker; /, "the tip names the actor");
});

test("a fork's two steps in one lane and column take one row each, and every column still joins the next", () => {
  const p = place(FORK.steps);
  assert.deepEqual(p.lanes.map((l) => [l.actor, l.top, l.rows]), [["contributor", 0, 1], ["orchestrator", 160, 2], ["ci", 480, 1]]);
  assert.deepEqual([p.xy.issue[1], p.xy.card[1]], [232, 392], "Issue and Card stack in the Orchestrator band");
  assert.equal(p.xy.issue[0], p.xy.card[0], "in one column");
  const svg = lanes(FORK, readouts(FORK), new Set(["ask", "issue", "close"]), "ask");
  assert.equal((svg.match(/<path class="t-(main|off)"/g) ?? []).length, 4, "Ask to Issue and Card, each to Close");
  assert.equal((svg.match(/class="t-main"/g) ?? []).length, 2, "thick where both ends are critical");
});

test("a lane map keeps the trail's link markup and a long list widens the drawing, never crowds it", () => {
  const trailNode = trail({ ...LINE, steps: LINE.steps.map(({ actor, ...s }) => s) }, readouts(LINE), new Set(), "plan").match(/<a class="t-step[^>]*>/)[0];
  const laneNode = lanes(LINE, readouts(LINE), new Set(), "plan").match(/<a class="t-step[^>]*>/)[0];
  assert.equal(laneNode.replace(/ data-tip="[^"]*"/, "").replace(' data-actor="owner"', ""), trailNode.replace(/ data-tip="[^"]*"/, ""));
  assert.match(laneNode, / data-actor="owner"/, "the lane filter finds a step by its actor");
  const twelve = Array.from({ length: 12 }, (_, i) => step(`s${i}`, "worker"));
  const p = place(twelve);
  assert.deepEqual([p.gap, p.width], [LANES.minGap, 2 * LANES.x0 + 11 * LANES.minGap]);
  assert.deepEqual([Object.keys(ACTORS).length, Object.values(ACTORS).every((n) => n.length < 14)], [8, true], "a lane's name fits its band's corner");
});

test("the Maps tab draws lanes for a map whose steps all name an actor, and a chip names each step's actor", () => {
  const metrics = { "ci.latest_flow": { value: 3, unit: "min", read_at: "2026-11-23T00:00:00Z", source: "s" } };
  const doc = { repo_url: "https://example.org", maps: [LINE, { ...FORK, steps: FORK.steps.map(({ actor, ...s }) => s) }] };
  const html = mapsTab({ metrics, repos: [{ name: "one" }] }, { outcomes: [] }, doc, null, ["one"], null);
  assert.equal((html.match(/class="trail lanes"/g) ?? []).length, 1, "the map with actors, not the one without");
  assert.equal((html.match(/<span class="chip actor">/g) ?? []).length, 5, "a chip on each of its panels");
  assert.match(html, /<span class="chip actor">Orchestrator<\/span>/);
  assert.match(html, /<li>Lanes: who does each step<\/li>/);
});
