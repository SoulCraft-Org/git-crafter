// Tests for Git Crafter's own guard-speed collector. The guard is a stand-in:
// every run is stubbed, so no command is judged or run here.
// Run with: node --test config/quality/collectors/guard-speed.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { collect, guardSpeedFromLog } from "./guard-speed.mjs";

const ID = "guards.call_ms";
// A GitHub client that is offline, so no test reads a real run.
const gh = { rest: async () => { throw new Error("offline"); }, graphql: async () => { throw new Error("offline"); }, text: async () => "" };
// A run stub that answers each call with the next time in `times`.
const timed = (times, calls = []) => async (cmd, args, opts) => {
  calls.push({ cmd, args, opts });
  return { code: 0, stdout: "", stderr: "", ms: times[calls.length - 1] };
};

test("reads the median of the runs, so one cold start does not set the value", async () => {
  const calls = [];
  const got = await collect({ gh, root: "/repo", mode: "local", params: { runs: 5 }, run: timed([400, 61, 59, 64.4, 60], calls) });
  assert.equal(got[ID].value, 61);
  assert.deepEqual(got[ID].detail, [
    { label: "fastest run", value: 59, unit: "ms" },
    { label: "median", value: 61, unit: "ms" },
    { label: "slowest run", value: 400, unit: "ms" },
  ]);
  assert.match(got[ID].source, /^latest: median wall time of 5 runs of python3 -I tools\/bash_guard\.py .* on the machine that runs the sessions$/);
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0].args, ["-I", "tools/bash_guard.py"]);
  assert.equal(calls[0].opts.cwd, "/repo");
  const sent = JSON.parse(calls[0].opts.input);
  assert.deepEqual([sent.tool_name, sent.tool_input.command], ["Bash", "ls"], "one harmless hook call, parsed and never run");
});

test("an even count reads the mean of the two middle runs, ten runs by default", async () => {
  const calls = [];
  const got = await collect({ gh, root: "/repo", mode: "local", run: timed([70, 60, 62, 64, 66, 68, 61, 63, 65, 67], calls) });
  assert.equal(calls.length, 10);
  assert.equal(got[ID].value, 65, "the mean of 64 and 65, rounded");
});

test("a guard that cannot be timed is could_not_check with the reason, never 0", async () => {
  const missing = await collect({ gh, root: "/repo", mode: "local", run: async () => ({ code: null, missing: true, stdout: "", stderr: "", ms: 0 }) });
  assert.match(missing[ID].could_not_check, /python3 is not on PATH/);
  const blocked = await collect({ gh, root: "/repo", mode: "local", run: async () => ({ code: 2, stdout: "", stderr: "blocked: a rule matched\nmore", ms: 50 }) });
  assert.match(blocked[ID].could_not_check, /exited 2 on a harmless command \(blocked: a rule matched\)/);
  assert.ok(!("value" in blocked[ID]));
});

test("in CI the guard is not timed: a runner under load would time itself, so it is could_not_check and nothing runs", async () => {
  const calls = [];
  const got = await collect({ gh, root: "/repo", mode: "ci", run: timed([50], calls) });
  assert.match(got[ID].could_not_check, /runs on the machine that runs the sessions; timed by a --local collect/);
  assert.ok(!("value" in got[ID]));
  assert.equal(calls.length, 0);
});

test("the metric is defined once, on the Code tab, as Speed, with a goal that names its source", () => {
  const [def, runner, ...rest] = JSON.parse(readFileSync(new URL("../targets/guard-speed.json", import.meta.url), "utf8"));
  assert.equal(rest.length, 0);
  assert.deepEqual([runner.id, runner.tab, runner.kind, runner.goal], ["guards.runner_call_ms", "code", "speed", 100]);
  assert.match(runner.source, /^latest: /);
  assert.deepEqual([def.id, def.tab, def.kind, def.direction], [ID, "code", "speed", "lower"]);
  assert.ok(def.near > def.goal, "near sits on the worse side of the goal");
  assert.match(def.goal_source, /\bgoal\b/);
  assert.match(def.source, /^latest: /);
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
