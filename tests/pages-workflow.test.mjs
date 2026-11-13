// .github/workflows/pages.yml's build job: the Process page builds again after the Quality step, and the daily
// schedule runs as a push to main does (admin reads, the main-reads save, the deploy) with no screenshots.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const wf = parse(readFileSync(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"));
const steps = wf.jobs.build.steps;
const at = (pred, what) => {
  const i = steps.findIndex(pred);
  assert.ok(i >= 0, what);
  return i;
};
const named = (name) => at((s) => s.name === name, `a step named ${name}`);

// An `if:` read for one event on main, through GitHub's own operators only: ==, !=, && and ||.
function holds(cond, event, ref = "refs/heads/main") {
  if (cond === undefined) return true;
  const expr = String(cond).replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  let s = expr.replace(/github\.event_name/g, `'${event}'`).replace(/github\.ref/g, `'${ref}'`);
  // Reduced in place, && before ||, until one literal is left; anything else is not an event or ref test.
  const rules = [
    [/'([^']*)'\s*(==|!=)\s*'([^']*)'/, (_, a, op, b) => String((a === b) === (op === "=="))],
    [/\(\s*(true|false)\s*\)/, (_, v) => v],
    [/(true|false)\s*&&\s*(true|false)/, (_, a, b) => String(a === "true" && b === "true")],
    [/(^|\()\s*(true|false)\s*\|\|\s*(true|false)\s*(?=\)|$|\|\|)/, (_, open, a, b) => `${open}${a === "true" || b === "true"}`],
  ];
  for (let changed = true; changed; ) {
    changed = false;
    for (const [re, fn] of rules) if (re.test(s)) [s, changed] = [s.replace(re, fn), true];
  }
  assert.match(s.trim(), /^(true|false)$/, `only event and ref tests in: ${expr}`);
  return s.trim() === "true";
}

test("the Process page builds first, then again after the Quality step", () => {
  const first = named("Build both pages");
  assert.match(steps[first].run, /node pages\/build\.mjs/, "the first build stays");
  const quality = named("Git Crafter's own Quality, Speed and Consumption page");
  const replayed = named("Quality page from main's scored run, no collector changed");
  const again = named("Build the Process page again from this run");
  assert.ok(first < replayed && replayed < quality && quality < again, "the second build follows both Quality steps");
  assert.equal(steps[again].run.trim(), "node pages/build.mjs", "it builds only: no collect, so data/org.json keeps its site metrics");
  assert.equal(steps[again].if, undefined, "it runs on every build");
});

test("one daily schedule, and the scheduled run acts as a push to main", () => {
  assert.equal(wf.on.schedule.length, 1);
  assert.match(wf.on.schedule[0].cron, /^\d+ \d+ \* \* \*$/, "once a day");
  const replay = steps[at((s) => s.id === "replay", "the replay setup")];
  assert.match(replay.run, /if \[ "\$GITHUB_EVENT_NAME" = schedule \]; then export GITHUB_EVENT_NAME=push; fi\n\s*node quality\/gh-replay\.mjs setup/, "it records the main-reads save");
  const save = steps[at((s) => s.with?.name === "main-reads", "the main-reads upload")];
  const admin = steps[at((s) => s.id === "admin-app", "the App token")];
  for (const [what, cond] of [["main-reads", save.if], ["admin reads", admin.if.replace(/ && env\.\w+ == 'true'/, "")], ["deploy", wf.jobs.deploy.if.replace(/!cancelled\(\) && needs\.build\.result == 'success' && /, "")], ["build", wf.jobs.build.if.replace(/!cancelled\(\) && \(|\|\| needs\.changes\.outputs\.full == 'true'\)/g, "")]]) {
    assert.equal(holds(cond, "schedule"), holds(cond, "push"), `${what}: the schedule as a push`);
    assert.equal(holds(cond, "schedule"), true, `${what} runs on the schedule`);
  }
  for (const s of steps.filter((s) => s.name === "visual-check" || s.with?.name === "page-screenshots")) {
    assert.equal(holds(s.if, "schedule"), false, "no screenshots on the schedule");
    assert.equal(holds(s.if, "pull_request"), true, "a pull request still takes them");
  }
  const runner = wf.jobs.runner.steps.find((s) => s.id === "choose");
  assert.equal(holds(runner.env.CI_OVERFLOW_SAVE, "schedule"), true, "the overflow meter saves its state");
  assert.equal(holds(runner.env.CI_OVERFLOW_SAVE, "pull_request"), false);
});
