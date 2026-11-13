// Reads a repo's workflow files and git hooks, as text from one GraphQL
// query, into the pipeline detail quality/render/ci-flow.mjs
// draws: { label, value, unit, stage, kind, runs, file, pass_rate }.
//
// The site repo builds its own pipeline (quality/collectors/ci/ci.mjs)
// and commits it as ci.latest_flow; collect_org.mjs copies that one. This file does
// the same job for repos without one. It reads only the few keys a pipeline
// needs (name, on, jobs with runs-on, needs, uses, if and step names), line by
// line, because the site's builder parses with the yaml package, which
// Git Crafter does not install.

const indentOf = (line) => line.length - line.trimStart().length;
const unquote = (s) => String(s ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");

// A line without its comment: a # that starts the line or follows a space,
// outside quotes.
function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd();
  }
  return line.trimEnd();
}

// The lines under the key at `at`, up to the next line indented as far or less.
function block(lines, at) {
  const base = indentOf(lines[at]);
  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    if (indentOf(lines[i]) <= base) break;
    out.push(lines[i]);
  }
  return out;
}

// A block's own keys (its shallowest level), each with its inline value and
// its sub-block.
function keysOf(lines) {
  if (!lines.length) return [];
  const level = Math.min(...lines.map(indentOf));
  const out = [];
  lines.forEach((line, i) => {
    const m = indentOf(line) === level ? /^\s*["']?([\w.-]+)["']?:\s*(.*)$/.exec(line) : null;
    if (m) out.push({ key: m[1], value: m[2], body: block(lines, i) });
  });
  return out;
}

// A scalar that may be a block (|, >, >- and the like): its lines, joined.
function scalarOf(f) {
  if (!f) return "";
  const v = String(f.value ?? "").trim();
  return /^[|>][-+]?\d*$/.test(v) ? f.body.map((l) => l.trim()).join(" ") : unquote(v);
}

// A value that is a scalar, a [flow, list] or a block of "- item" lines.
function listOf(value, body) {
  const v = String(value ?? "").trim();
  if (v.startsWith("[")) return v.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
  if (v && v !== "|" && v !== ">") return [unquote(v)];
  return body.map((l) => /^\s*-\s*(.+)$/.exec(l)?.[1]).filter(Boolean).map(unquote);
}

// The names of a job's steps: those at the indent of its first step.
function stepNamesOf(steps) {
  const level = steps.length ? Math.min(...steps.filter((l) => /^\s*-/.test(l)).map(indentOf)) : 0;
  return steps.filter((l) => indentOf(l) === level && /^\s*-\s*name:/.test(l)).map((l) => unquote(l.replace(/^\s*-\s*name:/, "")));
}

// A job's strategy matrix axes, without include and exclude.
function matrixOf(val) {
  const matrix = keysOf(val("strategy")?.body ?? []).find((x) => x.key === "matrix");
  return keysOf(matrix?.body ?? [])
    .filter((a) => a.key !== "include" && a.key !== "exclude")
    .map((a) => ({ key: a.key, values: listOf(a.value, a.body) }));
}

// One job of a workflow file: its name, matrix, runner, needs, reusable workflow, shards, condition and step names.
function readJob(j) {
  const f = keysOf(j.body);
  const val = (k) => f.find((x) => x.key === k);
  const listAt = (k) => (val(k) ? listOf(val(k).value, val(k).body) : null);
  const shards = keysOf(val("with")?.body ?? []).find((x) => x.key === "shards");
  const runsOn = listAt("runs-on");
  return {
    id: j.key,
    name: val("name") ? scalarOf(val("name")) : j.key,
    matrix: matrixOf(val),
    runsOn: runsOn ? runsOn.join(", ") : null,
    needs: listAt("needs") ?? [],
    uses: val("uses") ? unquote(val("uses").value) : null,
    shards: shards ? Number(/\d+/.exec(shards.value)?.[0]) || null : null,
    if: scalarOf(val("if")),
    steps: stepNamesOf(val("steps")?.body ?? []),
  };
}

/** The keys a pipeline needs from one workflow file. */
export function readWorkflow(text) {
  const lines = String(text ?? "").split("\n").map(stripComment);
  const top = keysOf(lines.filter((l) => l.trim()));
  const get = (k) => top.find((t) => t.key === k);
  const events = {};
  const on = get("on");
  if (on) {
    const inline = on.value.trim();
    if (inline) for (const e of listOf(inline, [])) events[e] = {};
    for (const e of keysOf(on.body)) {
      const sub = keysOf(e.body);
      const branches = sub.find((s) => s.key === "branches");
      events[e.key] = { paths: sub.some((s) => s.key === "paths"), branches: branches ? listOf(branches.value, branches.body) : null };
    }
  }
  const jobs = keysOf(get("jobs")?.body ?? []).map(readJob);
  return { name: unquote(get("name")?.value ?? ""), events, jobs };
}

// Jobs in the order they run: each level needs only earlier ones.
function jobLevels(jobs) {
  const ids = new Set(jobs.map((j) => j.id));
  const depth = new Map();
  const levelOf = (j, seen = new Set()) => {
    if (depth.has(j.id)) return depth.get(j.id);
    if (seen.has(j.id)) return 0;
    seen.add(j.id);
    const needs = j.needs.filter((n) => ids.has(n)).map((n) => jobs.find((x) => x.id === n));
    const d = needs.length ? 1 + Math.max(...needs.map((n) => levelOf(n, seen))) : 0;
    depth.set(j.id, d);
    return d;
  };
  const levels = [];
  for (const j of jobs) (levels[levelOf(j)] ??= []).push(j);
  return levels.filter(Boolean);
}

/** A runner in words. An expression picks it at run time; in a file that names Blacksmith, the Blacksmith guard does. */
function runnerText(runsOn, text) {
  if (!runsOn) return "";
  if (!runsOn.includes("${{")) return runsOn;
  return /blacksmith/i.test(text) ? "a runner the Blacksmith guard picks" : "a runner chosen at run time";
}

const EXPR = /\$\{\{[^}]*\}\}/g;
// A job's names as GitHub shows them: a matrix of one key expands into one
// name per value, strategy.job-total reads as their count, and any other
// expression reads "…" instead of its raw ${{ }}.
export function jobNames(job) {
  const ax = job.matrix?.length === 1 && job.matrix[0].values.length ? job.matrix[0] : null;
  const slot = ax ? new RegExp(`\\$\\{\\{\\s*matrix\\.${ax.key.replace(/[^\w-]/g, "")}\\s*\\}\\}`, "g") : null;
  const total = (name, n) => name.replace(/\$\{\{\s*strategy\.job-total\s*\}\}/g, String(n));
  if (ax && slot.test(job.name)) return ax.values.map((v) => total(job.name.replace(slot, v), ax.values.length).replace(EXPR, "…"));
  const n = (job.matrix ?? []).reduce((p, a) => p * Math.max(a.values.length, 1), 1);
  const base = total(job.name, n).replace(EXPR, "…");
  return [n > 1 ? `${base} (${n} in parallel)` : base];
}

// Whether a job runs on an event, by its if: "github.event_name != 'x'" keeps
// it off x; "github.event_name == 'x'" (one or more) keeps it to those; a
// condition on github.ref == 'refs/heads/main' keeps it off pull requests.
// Anything else is decided at run time, so the job counts.
export function runsFor(job, event) {
  const cond = String(job.if ?? "");
  if (!cond) return true;
  const not = [...cond.matchAll(/event_name\s*!=\s*['"]([\w-]+)['"]/g)].map((m) => m[1]);
  if (not.includes(event)) return false;
  const only = [...cond.matchAll(/event_name\s*==\s*['"]([\w-]+)['"]/g)].map((m) => m[1]);
  if (only.length && !only.includes(event)) return false;
  if (/github\.ref\s*==\s*['"]refs\/heads\/main['"]/.test(cond) && /^pull_request/.test(event)) return false;
  return true;
}

const short = (uses) => String(uses).split("@")[0].replace(/^[\w.-]+\/\.github\/\.github\/workflows\//, "shared ");
function jobText(j, text) {
  const names = jobNames(j);
  const who = names.length > 1 ? `${names.join(" and ")} in parallel` : names[0];
  if (j.uses) return `${who} calls ${short(j.uses)}${j.shards ? ` in ${j.shards} shard${j.shards === 1 ? "" : "s"}` : ""}`;
  return `${who} on ${runnerText(j.runsOn, text)}`;
}
/** A workflow's jobs for one event, in the order they run, leaving out a job its if keeps off that event. */
export const jobsText = (jobs, text, event) =>
  jobLevels(event ? jobs.filter((j) => runsFor(j, event)) : jobs)
    .map((level) => level.map((j) => jobText(j, text)).join(" and "))
    .join(", then ");

// Which column a trigger lands in. Pull request and main-push columns are the
// ones ci-flow.mjs names; the rest are columns of their own, after Deploy.
const STAGE_OF = { pull_request: "ci", pull_request_target: "ci", merge_group: "ci", push: "merge" };
const OTHER = { workflow_dispatch: "On demand", schedule: "Scheduled", workflow_call: "Called by other repos", issue_comment: "On a comment" };
const WORD = { pull_request: "every pull request", pull_request_target: "every pull request", merge_group: "every merge queue entry", push: "every push to main", workflow_dispatch: "dispatch", schedule: "a schedule", workflow_call: "a call from another workflow", issue_comment: "a comment" };
const RUN_EVENT = { pull_request_target: "pull_request", merge_group: "merge_group", issue_comment: "issue_comment" };

/** When a workflow runs, as the Testing tab says it. */
function whenText(wf) {
  const parts = [];
  for (const [e, v] of Object.entries(wf.events)) {
    if (!WORD[e]) continue;
    if (e === "push" && v.branches && !v.branches.includes("main")) continue;
    parts.push(`${WORD[e]}${v.paths ? " that changes its inputs" : ""}`);
  }
  const gated = wf.jobs.some((j) => /outputs\./.test(j.if));
  return `${parts.join("; ") || "no trigger read"}${gated ? "; skips its work when nothing it checks changed" : ""}`;
}

const codeLines = (text) => String(text ?? "").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const TEST_CMD = /\b(npm (run )?test|vitest|pytest|playwright|check:push|node --test|unittest|go test|cargo test)\b/;
const SOURCED = /(?:^|[\s;])(?:\.|source)\s+["']?[^"'\s]*?([\w.-]+\.sh)\b/m;

/**
 * What a git hook does, read from its code lines only. A hook that sources a
 * router (". .githooks/x-route.sh") is read with that router: the checkers
 * it names and the scripts it runs.
 */
export function hookText(name, text, hooks = []) {
  const own = codeLines(text);
  const routed = SOURCED.exec(own)?.[1];
  const router = routed ? hooks.find((h) => h.name === routed) : null;
  const code = router ? `${own}\n${codeLines(router.text)}` : own;
  const parts = [];
  if (/refs\/heads\/main/.test(own)) parts.push("refuses a push to main");
  const runs = hookRuns(code, routed);
  if (runs.length) parts.push(runsText(runs, router));
  if (name === "pre-push" && !TEST_CMD.test(code)) parts.push("runs no tests");
  return parts.join("; ") || (router ? `routes through ${router.name}` : name);
}

// The checkers, commands and scripts a hook's code runs, but not its own router.
function hookRuns(code, routed) {
  return [
    ...new Set([
      ...[...code.matchAll(/run_checker\s+["']?([\w-]+)/g)].map((m) => m[1]),
      ...[...code.matchAll(/\b(?:npm run|python3?(?: -I)?|bash|node)[ \t]+["']?([\w./:$-]+)/g)].map((m) => m[1].split("/").pop()),
      ...[...code.matchAll(/[\w$}"'/-]\/([\w-]+\.(?:py|mjs))\b/g)].map((m) => m[1]),
    ]),
  ].filter((x) => x && !/^\$/.test(x) && x !== routed);
}

const runsText = (runs, router) => `runs ${runs.slice(0, 4).join(", ")}${runs.length > 4 ? ` and ${runs.length - 4} more` : ""}${router ? ` through ${router.name}` : ""}`;

const PASS = new Set(["success"]);
const FAIL = new Set(["failure", "timed_out", "startup_failure"]);
const round1 = (x) => Math.round(x * 10) / 10;
// Events a share reads per repo or workflow, newest first: new ones replace
// old within hours, as the Quality page template's last 20 runs and merges.
export const LAST_N = 20;

/**
 * Per workflow file and event, from completed runs: the minutes of its latest
 * passing run (its latest decided run when none passed), and its pass rate
 * over its last LAST_N decided runs. No median, no calendar window.
 */
export function workflowStats(runs) {
  const groups = new Map();
  for (const r of runs ?? []) {
    if (r.status !== "completed" || r.event === "dynamic") continue;
    const key = `${r.path}\n${r.event}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out = new Map();
  for (const [key, list] of groups) {
    const decided = list.filter((r) => PASS.has(r.conclusion) || FAIL.has(r.conclusion)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    if (!decided.length) continue;
    const last = decided.slice(0, LAST_N);
    const ok = last.filter((r) => PASS.has(r.conclusion));
    const wall = (r) => (Date.parse(r.updated_at) - Date.parse(r.run_started_at ?? r.created_at)) / 60_000;
    out.set(key, { value: round1(wall((ok.length ? ok : last)[0])), pass_rate: round1((100 * ok.length) / last.length), runs: last.length });
  }
  return out;
}

/**
 * A repo's pipeline: its hooks, one node per workflow and trigger, and the
 * pinned review and merge every Git Crafter repo shares; and apart, the
 * workflows that run only on demand, on a schedule or on a comment, which are
 * not on the path to deploy. files: { workflows: [{ name, text }], hooks:
 * [{ name, text }] }; stats: workflowStats().
 */
export function repoFlow(files, stats) {
  const detail = [];
  const apart = [];
  for (const [name, stage] of [["pre-commit", "commit"], ["pre-push", "push"]]) {
    const h = files.hooks.find((x) => x.name === name);
    if (h) detail.push({ label: name, value: null, unit: "minutes", stage, kind: "hook", runs: hookText(name, h.text, files.hooks), file: `.githooks/${name}`, pass_rate: null });
  }
  for (const f of files.workflows) {
    const wf = readWorkflow(f.text);
    for (const e of flowEvents(wf)) (STAGE_OF[e] ? detail : apart).push(flowNode(f, wf, e, stats));
  }
  detail.push({ label: "Pinned review and merge", value: null, unit: "minutes", stage: "review", kind: "manual", runs: "The orchestrator reviews the head SHA, pins a review to it, and merges with gh pr merge --match-head-commit and that literal SHA", file: "code-os rules/delegation.md", pass_rate: null });
  return { detail, apart };
}

// The events of a workflow that put it on the path to deploy (a push to a
// branch other than main does not), else the ones that run it apart from it.
function flowEvents(wf) {
  const main = Object.keys(wf.events).filter((e) => STAGE_OF[e] && !(e === "push" && wf.events.push.branches && !wf.events.push.branches.includes("main")));
  return main.length ? main : Object.keys(wf.events).filter((e) => OTHER[e]);
}

// One workflow on one event as a pipeline node, timed by its runs.
function flowNode(f, wf, e, stats) {
  const path = `.github/workflows/${f.name}`;
  const st = stats.get(`${path}\n${RUN_EVENT[e] ?? e}`) ?? { value: null, pass_rate: null };
  const what = jobsText(wf.jobs, f.text, e);
  return {
    label: wf.name || f.name.replace(/\.ya?ml$/, ""),
    value: st.value,
    unit: "minutes",
    stage: STAGE_OF[e] ?? OTHER[e],
    kind: "workflow",
    runs: `On ${WORD[e]}${wf.events[e]?.paths ? " that changes its inputs" : ""}: ${what || "no jobs read"}`.slice(0, 320),
    file: path,
    pass_rate: st.pass_rate,
  };
}

// One test pattern for the whole repo: collect_org.mjs counts test runs by it
// (TEST_WORKFLOW), and the Testing tab finds suites by it in a workflow's
// name or file, its jobs' ids and names, and their step names, so a suite in
// a workflow named "CI" is found too.
export const TEST_PATTERN = /test|e2e|verify|lint/i;
// A job that calls Git Crafter's CI standard runs the repo's tests there (templates/ci/ci.yml: short and standard).
const CI_STANDARD = /\/\.github\/workflows\/ci-standard\.ya?ml@/;
const SETUP_STEP = /^(set up|setup|install|checkout|cache|upload|download|restore|save)\b/i;
const stepsText = (steps) => (steps.length ? `${steps.slice(0, 4).join("; ")}${steps.length > 4 ? `; ${steps.length - 4} more` : ""}` : "");

/**
 * A repo's test suites as its workflows state them, and what cloud-test may
 * run for it. A row is a workflow, timed by its runs; jobs lists its test jobs
 * when there are several, or when only its jobs name tests. Jobs are not
 * timed apart.
 */
export function repoTests(files, stats) {
  const rows = files.workflows.filter((f) => !/cloud-test/.test(f.name)).map((f) => testRow(f, stats)).filter(Boolean);
  return { rows, dispatch: cloudDispatch(files) };
}

// The scripts cloud-test may run, from its package.json; none when it is missing or will not parse.
function cloudDispatch(files) {
  try {
    return files.cloudTest ? Object.keys(JSON.parse(files.cloudTest).scripts ?? {}) : [];
  } catch {
    return [];
  }
}

// The non-setup steps of these jobs, once each.
const checkSteps = (jobs) => [...new Set(jobs.flatMap((j) => j.steps).filter((x) => !SETUP_STEP.test(x)))];

// A workflow as a suite row, or null when neither it nor a job of it names tests.
function testRow(f, stats) {
  const wf = readWorkflow(f.text);
  const name = wf.name || f.name.replace(/\.ya?ml$/, "");
  const byName = TEST_PATTERN.test(`${name} ${f.name}`);
  const testJobs = wf.jobs.filter((j) => TEST_PATTERN.test(`${j.id} ${j.name}`) || CI_STANDARD.test(j.uses ?? "") || j.steps.some((x) => TEST_PATTERN.test(x)));
  if (!byName && !testJobs.length) return null;
  const path = `.github/workflows/${f.name}`;
  const st = ["pull_request", "push", "workflow_dispatch", "schedule"].map((e) => stats.get(`${path}\n${e}`)).find(Boolean) ?? { value: null, pass_rate: null };
  const events = Object.keys(wf.events).filter((e) => WORD[e]);
  const jobRow = (j) => ({ name: jobNames(j).join(", "), checks: stepsText(checkSteps([j])), when: events.filter((e) => runsFor(j, e)).map((e) => WORD[e]).join("; ") });
  return {
    suite: name,
    file: path,
    when: whenText(wf),
    checks: stepsText(checkSteps(testJobs.length ? testJobs : wf.jobs)) || jobsText(wf.jobs, f.text),
    value: st.value,
    pass_rate: st.pass_rate,
    jobs: testJobs.length > 1 || (!byName && testJobs.length) ? testJobs.map(jobRow) : [],
  };
}
