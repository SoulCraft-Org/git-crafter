// Accessibility and display checks on the Pages site's markup: what axe and
// the issues #688 and #690 hold the built pages to. Run by tools/verify.sh with
// the other tests/pages*.test.mjs files.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { trail, TRAIL } from "../pages/draw.mjs";
import { ideal } from "../pages/ui.mjs";

const MAP = { id: "m", name: "Map", steps: [{ id: "plan", name: "Plan the work", short: "Plan" }, { id: "ship", name: "Ship" }] };
const READOUTS = { plan: { label: "Session start to PR open", value: 0.59, unit: "h", kind: "speed", status: "meets" }, ship: { label: "Latest deploy", value: null, unit: "h" } };

test("no step link carries a label that replaces the words it shows (axe label-content-name-mismatch)", () => {
  const svg = trail(MAP, READOUTS, new Set(["plan"]), "plan");
  const links = svg.match(/<a class="t-step[^>]*>/g);
  assert.equal(links.length, 2);
  for (const a of links) assert.doesNotMatch(a, /aria-label/);
  assert.equal((svg.match(/<desc>/g) ?? []).length, 2, "each tip is its link's description");
});

test("a step's status mark sits outside its ring, covering none of its share (#688)", () => {
  const svg = trail(MAP, READOUTS, new Set(["plan"]), "plan");
  const node = svg.match(/<circle class="t-node" cx="([\d.]+)" cy="([\d.]+)"/);
  const mark = svg.match(/<circle class="t-stbg" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/);
  assert.ok(node && mark, "the step that meets its goal draws a mark");
  const dist = Math.hypot(mark[1] - node[1], mark[2] - node[2]);
  const stroke = Number(/\.t-track \{[^}]*stroke-width: ([\d.]+)/.exec(readFileSync(new URL("../pages/site.css", import.meta.url), "utf8"))[1]);
  assert.ok(dist - Number(mark[3]) >= TRAIL.r + 7 + stroke / 2, `mark edge ${dist - mark[3]} clears the ring's outer edge`);
});

test("each ideal region is named after its section, so no two share a name (axe landmark-unique)", () => {
  const doc = { ideal: "Every step scored.", sources: [{ title: "T", url: "https://example.com", date: "2026-11-11" }] };
  const names = ["Build", "Delivery"].map((n) => ideal(`tab-${n}`, doc, n).match(/<section class="ideal" aria-label="([^"]+)">/)[1]);
  assert.deepEqual(names, ["Ideal state: Build", "Ideal state: Delivery"]);
  assert.match(ideal("x", doc), /aria-labelledby="x-ideal"/, "with no name, the heading still names it");
  assert.match(ideal("x", doc, "A & B"), /aria-label="Ideal state: A &amp; B"/, "the name is escaped");
});

test("the page header shows when each half of the data was read (#690)", async () => {
  const { renderMetrics } = await import("../pages/render.mjs");
  const data = { repos: [{ name: "one" }], metrics: {}, org: "o", generated_at: "2026-11-10T08:00:00Z", site_read_at: "2026-11-11T09:00:00Z", built_at: "2026-11-11T09:05:00Z" };
  const meta = renderMetrics({ data, goalsDoc: { outcomes: [] }, history: [], css: "", script: "" }).match(/<p class="meta">.*?<\/p>/)[0];
  assert.match(meta, /<span>API data [^<]+<\/span><span>site data [^<]+<\/span>/);
  const one = renderMetrics({ data: { ...data, site_read_at: undefined }, goalsDoc: { outcomes: [] }, history: [], css: "", script: "" }).match(/<p class="meta">.*?<\/p>/)[0];
  assert.match(one, /<span>data [^<]+<\/span>/, "a run with one read time shows one date");
});

test("a tab's ideal heads at h2 under the page's h1; a map's or outcome's stays h3 (axe heading-order)", () => {
  const doc = { ideal: "Every step scored.", sources: [{ title: "T", url: "https://example.org", date: "2026-11-01" }] };
  assert.match(ideal("tab-build", doc, "Maps", 2), /<h2 id="tab-build-ideal">Ideal state<\/h2>/);
  assert.match(ideal("map-m", doc, "Map"), /<h3 id="map-m-ideal">Ideal state<\/h3>/);
});
