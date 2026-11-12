// Shared fixtures for the CI collector's tests (ci.test.mjs, ci-collect.test.mjs): the fixture runs, jobs and pulls, the fake gh, and the fixture repo.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { fileURLToPath } from "node:url";
import { collect, settings } from "./ci.mjs";
import { GhError } from "../github/github.mjs";
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The collector's targets file, parsed.
export const TARGETS = JSON.parse(readFileSync(path.join(HERE, "..", "..", "targets", "ci.json"), "utf8"));
const DEPLOY_APP = { slug: "fixture-deploy-app" };
// The template's params, merged over every target.
export const TEMPLATE_PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
// The params the fixture repo sets over the template's.
export const PARAMS = {
  hook_says: [{ match: "not-head", says: "refuses a push of any commit but HEAD" }],
  hook_checks: 'run_checker "([\\w-]+)"|run_(secret)lint\\b',
  stages: [
    { label: "Review and merge", stage: "review", kind: "manual", runs: "A person reviews the head, then merges", file: "CONTRIBUTING.md", key: "review" },
    { label: "Deploy to staging", stage: "deploy", kind: "workflow", runs: "The deploy app builds and deploys staging on every merge", file: "docs/deploy.md", key: "deploy" },
  ],
  deploy_apps: [DEPLOY_APP.slug],
};
// The fixture repo's params merged over the template's, as the engine does.
export const FULL_PARAMS = { ...TEMPLATE_PARAMS, ...PARAMS };
// The fixed clock the tests run at.
export const NOW = Date.parse("2026-11-02T20:00:00Z");
// The fixture repo's owner and name.
export const REPO = "fixture-org/fixture-repo";
// A time of day on the fixture date, as an ISO string.
export const T = (hms) => `2026-11-02T${hms}Z`;

// ---------------------------------------------------------------- fixture

// One fixture run record with its jobs' timestamps.
export const run = (id, workflow_id, name, event, head_sha, conclusion, created, updated, extra = {}) => ({
  id,
  node_id: `WFR_${id}`,
  workflow_id,
  head_branch: event === "push" ? "main" : `b-${head_sha}`,
  name,
  event,
  head_sha,
  status: conclusion === null ? "in_progress" : "completed",
  conclusion,
  run_attempt: 1,
  created_at: created,
  updated_at: updated,
  ...extra,
});

// The fixture workflow runs.
export const RUNS = [
  run(1, 1, "unit-tests", "pull_request", "s1", "success", T("10:00:00"), T("10:06:00")),
  run(2, 2, "dependency-scan", "pull_request", "s1", "success", T("10:00:00"), T("10:02:00")),
  run(3, 1, "unit-tests", "pull_request", "s2", "success", T("11:00:00"), T("11:20:00"), { run_attempt: 2 }),
  run(4, 2, "dependency-scan", "pull_request", "s2", "success", T("11:00:00"), T("11:01:00")),
  run(5, 1, "unit-tests", "pull_request", "s3", "failure", T("12:00:00"), T("12:04:00")),
  run(6, 2, "dependency-scan", "pull_request", "s3", "success", T("12:00:00"), T("12:01:00")),
  run(7, 1, "unit-tests", "pull_request", "s4", "success", T("13:00:00"), T("13:10:00")),
  run(8, 2, "dependency-scan", "pull_request", "s4", "skipped", T("13:00:00"), T("13:00:05")),
  run(9, 1, "unit-tests", "push", "m1", "success", T("14:00:00"), T("14:05:00")),
  run(10, 1, "unit-tests", "pull_request", "s5", null, T("19:50:00"), T("19:55:00")),
  run(11, 2, "dependency-scan", "pull_request", "s6", "cancelled", T("09:00:00"), T("09:01:00")),
  // From October: it counts, as one of unit-tests' last 20 runs.
  run(12, 1, "unit-tests", "pull_request", "s0", "success", "2026-10-01T00:00:00Z", "2026-10-01T00:05:00Z"),
];

const ok = (name) => ({ name, conclusion: "success" });
// A skipped step record.
export const skipped = (name) => ({ name, conclusion: "skipped" });
// Own steps exclude GitHub's "Set up job", "Complete job" and "Post " steps.
const FULL_SITE = [ok("Set up job"), ok("Run actions/checkout@abc"), ok("Detect site changes"), ok("Run actions/setup-node@def"), ok("npm ci"), ok("Type check"), ok("Post Run actions/checkout@abc"), ok("Complete job")];
// Steps skipped and done in 30 seconds: light.
export const LIGHT_SITE = [ok("Set up job"), ok("Run actions/checkout@abc"), ok("Detect site changes"), skipped("Run actions/setup-node@def"), skipped("npm ci"), skipped("Type check"), ok("Complete job")];
const FAILED_SITE = [ok("Set up job"), ok("Run actions/checkout@abc"), ok("Detect site changes"), ok("Run actions/setup-node@def"), ok("npm ci"), { name: "Type check", conclusion: "failure" }, skipped("Build the site"), ok("Complete job")];
// The steps of a gate job.
export const GATES = [ok("Set up job"), ok("Run actions/checkout@abc"), ok("Scan changed files"), ok("Complete job")];

// unit-tests runs on ubuntu-latest ($0.006 a minute), dependency-scan on ubuntu-slim ($0.002).
export const job = (id, name, created, started, completed, conclusion, steps) => ({
  id,
  name,
  labels: [name === "dependency-scan" ? "ubuntu-slim" : "ubuntu-latest"],
  created_at: T(created),
  started_at: started && T(started),
  completed_at: completed && T(completed),
  conclusion,
  steps,
});

// minutes / queue seconds / billed minutes / wall minutes from run creation
export const JOBS = {
  1: [job(101, "unit-tests", "10:00:00", "10:00:30", "10:05:30", "success", FULL_SITE)], // 5 / 30 / 5 / 5.5
  3: [job(103, "unit-tests", "11:00:00", "11:01:00", "11:13:00", "success", FULL_SITE)], // 12 / 60 / 12 / 13
  5: [job(105, "unit-tests", "12:00:00", "12:00:10", "12:03:10", "failure", FAILED_SITE)], // 3 / 10 / 3
  7: [job(107, "unit-tests", "13:00:00", "13:00:20", "13:00:50", "success", LIGHT_SITE)], // 0.5 / 20 / 1, light
  9: [job(109, "unit-tests", "14:00:00", "14:00:40", "14:04:40", "success", FULL_SITE)], // 4 / 40 / 4 / 4.67
  2: [job(102, "dependency-scan", "10:00:00", "10:00:15", "10:01:15", "success", GATES)], // 1 / 15 / 1 / 1.25
  4: [job(104, "dependency-scan", "11:00:00", "11:00:15", "11:00:45", "success", GATES)], // 0.5 / 15 / 1 / 0.75
  6: [job(106, "dependency-scan", "12:00:00", "12:00:05", "12:00:35", "success", GATES)], // 0.5 / 5 / 1 / 0.58
  8: [job(108, "dependency-scan", "13:00:00", null, null, "skipped", [])], // never ran: light, 0 billed
  11: [job(111, "dependency-scan", "09:00:00", "09:00:10", "09:00:40", "cancelled", GATES)], // 0.5 / 10 / 1
  12: [{ id: 112, name: "unit-tests", labels: ["ubuntu-latest"], created_at: "2026-10-01T00:00:00Z", started_at: "2026-10-01T00:00:20Z", completed_at: "2026-10-01T00:04:20Z", conclusion: "success", steps: FULL_SITE }], // 4 / 20 / 4 / 4.33
};

// The same jobs as GraphQL check runs: no creation time, upper-case conclusions.
const UP = (x) => (x ? x.toUpperCase() : x);
// The check-suite answers by run id.
export const CHECKS = Object.fromEntries(
  Object.entries(JOBS).map(([id, jobs]) => [
    id,
    jobs.map((j) => ({ databaseId: j.id, name: j.name, conclusion: UP(j.conclusion), startedAt: j.started_at, completedAt: j.completed_at, steps: { nodes: j.steps.map((st) => ({ name: st.name, conclusion: UP(st.conclusion) })) } })),
  ]),
);

// The job logs by job id.
export const LOGS = {
  109: "2026-11-02T14:00:50Z Cache restored from key: node-cache-Linux-x64-npm-abc",
  105: "\u001b[36mCache restored from key: node-cache-Linux-x64-npm-abc\u001b[0m",
  103: "npm cache is not found",
  101: "Cache restored from key: node-cache-Linux-x64-npm-abc",
  112: "no cache line in this log",
};

// One fixture pull request record.
export const pull = (number, sha, created, merged, merge_commit_sha) => ({
  number,
  created_at: created,
  merged_at: merged,
  closed_at: merged ?? T("12:30:00"),
  updated_at: merged ?? T("12:30:00"),
  merge_commit_sha,
  head: { sha, ref: `b-${sha}` },
});
// The fixture pull requests.
export const PULLS = [
  pull(10, "s1", T("09:30:00"), T("10:30:00"), "m1"),
  pull(11, "s2", T("10:45:00"), T("11:50:00"), "m2"),
  pull(12, "s3", T("11:45:00"), null, null),
  pull(9, "s0", "2026-09-30T23:50:00Z", "2026-10-01T00:10:00Z", "m0"),
];

// Both lists hold fewer than 100 runs, so every run read covers every workflow.
// The dynamic Dependabot workflow has no runs route: reading it would fail.
export const RUNS_OF = (id) => `repos/${REPO}/actions/workflows/${id}/runs?per_page=100`;
// The REST answers by route.
export const REST = {
  [`repos/${REPO}`]: { default_branch: "main" },
  // REST 4,000 of 5,000 left (80%), GraphQL 4,500 (90%).
  rate_limit: { resources: { core: { limit: 5000, remaining: 4000, reset: 1762880400 }, graphql: { limit: 5000, remaining: 4500, reset: 1762880400 } } },
  [`repos/${REPO}/actions/workflows?per_page=100`]: {
    workflows: [
      { id: 1, name: "unit-tests", path: ".github/workflows/unit-tests.yml", state: "active" },
      { id: 2, name: "dependency-scan", path: ".github/workflows/dependency-scan.yml", state: "active" },
      { id: 3, name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates", state: "active" },
    ],
  },
  [RUNS_OF(1)]: { workflow_runs: RUNS.filter((r) => r.workflow_id === 1) },
  [RUNS_OF(2)]: { workflow_runs: RUNS.filter((r) => r.workflow_id === 2) },
  ...Object.fromEntries(Object.entries(JOBS).map(([id, jobs]) => [`repos/${REPO}/actions/runs/${id}/jobs?per_page=100`, { jobs }])),
  [`repos/${REPO}/actions/runs/3/attempts/1`]: { conclusion: "failure" },
  [`repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=100`]: PULLS,
  [`repos/${REPO}/commits/m1/check-runs?per_page=100`]: {
    check_runs: [
      { app: DEPLOY_APP, name: "Deploy: staging", conclusion: "success", started_at: T("10:33:00"), completed_at: T("10:33:00") },
      { app: { slug: "github-actions" }, name: "unit-tests", conclusion: "success", started_at: T("14:00:40"), completed_at: T("14:04:40") },
    ],
  },
  [`repos/${REPO}/commits/m2/check-runs?per_page=100`]: {
    check_runs: [{ app: DEPLOY_APP, name: "Deploy: staging", conclusion: "failure", started_at: T("11:55:00"), completed_at: T("11:55:00") }],
  },
  [`repos/${REPO}/commits/m0/check-runs?per_page=100`]: { check_runs: [] },
};
// The issues each merged pull request closed: #10 one, #11 two, #9 none.
const CLOSES = { repository: { pullRequests: { nodes: [10, 11, 9].map((number) => ({ number, closingIssuesReferences: { totalCount: { 10: 1, 11: 2, 9: 0 }[number] } })) } } };
const TEXT = Object.fromEntries(Object.entries(LOGS).map(([id, log]) => [`repos/${REPO}/actions/jobs/${id}/logs`, log]));

/** A gh client that answers from the fixture and records each route. GraphQL answers nodes() from CHECKS by run id. */
export function fakeGh({ rest = REST, text = TEXT, checks = CHECKS, closes = CLOSES, board = null } = {}, calls = []) {
  const answer = (route, table) => {
    calls.push(route);
    if (!(route in table)) throw new GhError(`no fixture for ${route}`, { status: 404 });
    return structuredClone(table[route]);
  };
  const graphql = async (query) => {
    if (/query FixingPulls/.test(query)) {
      calls.push("graphql FixingPulls");
      return structuredClone(closes);
    }
    if (/query ProjectFind/.test(query)) return { repositoryOwner: { projectsV2: { nodes: board ? [{ id: "PVT_1", title: "fixture-repo" }] : [] } } };
    if (/query ProjectItems/.test(query)) return { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: structuredClone(board) } } };
    const ids = [...query.matchAll(/"WFR_(\d+)"/g)].map((m) => Number(m[1]));
    calls.push(`graphql nodes ${ids.join(",")}`);
    return { nodes: ids.map((id) => (id in checks ? { databaseId: id, checkSuite: { checkRuns: { nodes: structuredClone(checks[id]) } } } : null)) };
  };
  return { calls, rest: async (route) => answer(route, rest), text: async (route) => answer(route, text), graphql };
}

// The repo files the pipeline is parsed from.
// The fixture repo's hooks and workflows, by path: a pre-commit and pre-push router, a reusable
// workflow called with shards, and three plain ones.
const FILES = {
  ".claude/settings.json": JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: 'bash "$CLAUDE_PROJECT_DIR/.claude/hooks/content-guard.sh"' }] }] } }),
  ".githooks/route.sh": 'route_all() {\n  run_checker "content" x\n  run_secretlint y\n  run_checker "contract" z\n}\n',
  ".githooks/pre-commit": '. "$REPO_ROOT/.githooks/route.sh"\nroute_all pre-commit\n',
  // A pre-push that loads the router, refuses main and any commit but HEAD,
  // and mentions a check only in a comment.
  ".githooks/pre-push": [
      "#!/usr/bin/env bash",
      "# It runs no tests: run_checker \"unit\" runs in CI's unit-tests job.",
      "set -uo pipefail",
      '. "$REPO_ROOT/.githooks/route.sh"',
      'while read -r _lref _lsha rref _rsha; do',
      '  if [ "$rref" = "refs/heads/main" ]; then echo "BLOCKED [main]" >&2; exit 1; fi',
      'done <<< "$refs"',
      'if [ "$commit" != "$head" ]; then echo "BLOCKED [not-head]: push HEAD" >&2; exit 1; fi',
      'route_all "pre-push" "$files"',
      "",
    ].join("\n"),
  // A workflow that calls a reusable one with shards, as cloud-test does.
  ".github/workflows/cloud-test.yml": [
      "name: cloud-test",
      "on:",
      "  pull_request:",
      "    paths:",
      "      - .github/workflows/cloud-test.yml",
      "  workflow_dispatch:",
      "jobs:",
      "  cloud-test:",
      "    uses: fixture-org/.github/.github/workflows/cloud-test.yml@3237ce8",
      "    with:",
      "      shards: \"${{ inputs.shards || '2' }}\"",
      "",
    ].join("\n"),
  ".github/workflows/unit-tests.yml": "name: unit-tests\non:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  unit-tests:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@abc\n      - name: Type check\n        run: npm test\n",
  ".github/workflows/e2e.yml": [
      "name: e2e",
      "on:",
      "  pull_request:",
      "jobs:",
      "  changes:",
      '    name: "e2e: changes"',
      "    runs-on: ubuntu-slim",
      "    steps:",
      "      - name: Detect site changes",
      "        run: bash detect.sh",
      "  shard:",
      '    name: "e2e: shard ${{ matrix.shard }}/2"',
      "    needs: changes",
      "    if: needs.changes.outputs.run == 'true'",
      '    runs-on: "${{ needs.changes.outputs.runner }}"',
      "    strategy:",
      "      matrix:",
      "        shard: [1, 2]",
      "    steps:",
      "      - run: npx playwright test",
      "  e2e:",
      "    name: e2e",
      "    needs: [changes, shard]",
      "    if: \"${{ !cancelled() }}\"",
      "    runs-on: ubuntu-slim",
      "    steps:",
      "      - run: echo verdict",
      "",
    ].join("\n"),
  ".github/workflows/dependency-scan.yml": "name: dependency-scan\non: [pull_request]\njobs:\n  gates:\n    name: dependency-scan\n    runs-on: ubuntu-latest\n    steps:\n      - name: Scan changed files\n        run: python3 scan.py\n",
};

// The temp fixture repo root, made before the tests and removed after.
export let ROOT;
before(() => {
  ROOT = mkdtempSync(path.join(tmpdir(), "ci-collector-"));
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(path.dirname(path.join(ROOT, rel)), { recursive: true });
    writeFileSync(path.join(ROOT, rel), text);
  }
});
after(() => rmSync(ROOT, { recursive: true, force: true }));

// Runs the collector on the fixture, with any option overridden.
export const collectWith = (opts = {}) => collect({ root: ROOT, mode: "local", params: FULL_PARAMS, gh: fakeGh(), now: NOW, repo: REPO, ...opts });
