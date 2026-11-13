// Tests for Git Crafter's own guard-speed collector. GitHub is offline, so
// no run is read here.
// Run with: node --test config/quality/collectors/guard-speed.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collect, guardSpeedFromLog } from "./guard-speed.mjs";

// A GitHub client that is offline, so no test reads a real run.
const gh = { rest: async () => { throw new Error("offline"); }, graphql: async () => { throw new Error("offline"); }, text: async () => "" };
test("the metric is defined once, on the Code tab, as Speed, with a goal that names its source", () => {
  const [runner, ...rest] = JSON.parse(readFileSync(new URL("../targets/guard-speed.json", import.meta.url), "utf8"));
  assert.equal(rest.length, 0);
  assert.deepEqual([runner.id, runner.tab, runner.kind, runner.goal], ["guards.runner_call_ms", "code", "speed", 100]);
  assert.match(runner.source, /^latest: /);
  assert.ok(runner.near > runner.goal, "near sits on the worse side of the goal");
  assert.match(runner.goal_source, /\bgoal\b/);
});

test("reads the median and p95 from the last guard speed line of a job log, past GitHub's timestamps", async () => {
  const log = [
    "2026-11-11T20:01:02.0000000Z == bash guard",
    "2026-11-11T20:01:09.1234567Z == guard speed: median 290 ms, p95 400 ms, 40 calls of bash_guard.py --check",
    "2026-11-11T20:02:09.1234567Z == guard speed: median 312.5 ms, p95 401 ms, 40 calls of bash_guard.py --check",
  ].join("\n");
  assert.deepEqual(guardSpeedFromLog(log), { median: 312.5, p95: 401, calls: 40 });
  assert.equal(guardSpeedFromLog("== bash guard\nverify: ok"), null, "a log without the line reads null, never 0");
  const offline = await collect({ gh, root: "/repo", mode: "ci", allParams: { "github.json": { repo: "o/r" } } });
  assert.match(offline["guards.runner_call_ms"].could_not_check, /^could not read the run: /);
});
