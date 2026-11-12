// Shared fixtures for the Code collector's tests (code.test.mjs, code-inputs.test.mjs): the fixture repo's params, stubbed commands and the repo builder.

import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { before } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { PARAMS } from "./code.mjs";
// This folder, the base of the fixture paths.
export const here = dirname(fileURLToPath(import.meta.url));
// The fixture repos and files the tests read.
export const FIXTURES = join(here, "../../fixtures/code");
// The collector's targets file, parsed.
export const TARGETS = JSON.parse(readFileSync(join(here, "../../targets/code.json"), "utf8"));
// The six code folders of the fixture repo.
export const AREAS = ["site/src", "site/worker", "workers/bot/src", "packages/shared", "scripts", "tools"];
// The fixture repo's override over the template's params, as the engine folds
// them: its six code folders, two Workers, its built site and two suites.
export const FIXTURE = {
  ...PARAMS,
  areas: AREAS,
  main_branch: "main",
  workers: ["site", "workers/bot"],
  client_dist: { dir: "site/dist", source: "site" },
  // cover: the source each suite's coverage counts, as --coverage.include
  // globs relative to its cwd.
  test_suites: [
    {
      label: "site unit + worker",
      cwd: "site",
      args: ["--project", "unit", "--project", "worker"],
      cover: { "site/src": "src/**/*.{ts,mjs}", "site/worker": "worker/**/*.ts" },
    },
    { label: "bot", cwd: "workers/bot", args: [], cover: { "workers/bot/src": "src/**/*.ts" } },
  ],
};
// The site Worker's stub bundle text.
export const SITE_BUNDLE = "export default { fetch() { return new Response('site'); } };\n".repeat(400);
// The bot Worker's stub bundle text.
export const BOT_BUNDLE = "export function reply(t) { return t.trim(); }\n".repeat(50);
// Where a value falls against its target's goal and near band.
export const meets = (t, v) => (t.direction === "lower" ? v <= t.goal : v >= t.goal);
// Whether a value is worse than the target's near band.
export const pastNear = (t, v) => (t.direction === "lower" ? v > t.near : v < t.near);
// The gzip size of a text in kilobytes, to one decimal.
export const kb = (text) => Math.round((gzipSync(text).length / 1024) * 10) / 10;
// The newest commit touching site/ in the stubbed history: before makeRepo
// writes site/dist, so the fixture build is fresh.
export const SITE_COMMIT = "2026-10-01T12:00:00.000Z";
// An ISO time as epoch seconds, as git prints it.
export const seconds = (iso) => String(Date.parse(iso) / 1000);
// Covered and total lines per file, relative to each suite's cwd, the way v8's
// json-summary reports them. Summed: 260 of 300 lines, 86.7%. Averaging the two
// suites' shares (86% and 90%) would give 88 instead.
// Per file: [lines covered, lines, branches covered, branches]; a file given
// lines only writes a summary with no branch data.
export const COVERAGE = {
  site: { "src/lib/math.ts": [170, 200, 30, 40], "worker/index.ts": [45, 50, 8, 10] },
  bot: { "src/app.ts": [45, 50, 12, 20] },
};

// Writes a coverage-summary.json the way vitest's json-summary reporter does.
// The bot's keys use the real path (macOS temp folders sit behind a symlink),
// so both spellings of the repo root are read.
export function writeCoverage(dir, cwd, files, real) {
  const base = real ? realpathSync(cwd) : cwd;
  const count = (covered, total) => ({ total, covered, skipped: 0, pct: (100 * covered) / total });
  const entry = ([lc, lt, bc, bt]) => ({ lines: count(lc, lt), ...(bt === undefined ? {} : { branches: count(bc, bt) }) });
  const rows = Object.entries(files).map(([path, n]) => [join(base, path), n]);
  const sum = (i) => rows.reduce((n, [, r]) => n + r[i], 0);
  const withBranches = rows.every(([, r]) => r.length === 4);
  const total = entry(withBranches ? [sum(0), sum(1), sum(2), sum(3)] : [sum(0), sum(1)]);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "coverage-summary.json"), JSON.stringify({ total, ...Object.fromEntries(rows.map(([p, r]) => [p, entry(r)])) }));
}

// main's first-parent history in the stub: a direct commit, then merged PRs
// #630 down to #601 (one squash-merged). The 20th, #611, is the base's child.
export const MAIN_LOG = [
  `${"f".repeat(40)} Fix a typo straight on main`,
  ...Array.from({ length: 30 }, (_, i) =>
    i === 3 ? `${String(i).padStart(2, "0").repeat(20)} Squash a change (#${630 - i})` : `${String(i).padStart(2, "0").repeat(20)} Merge pull request #${630 - i} from org/branch`,
  ),
].join("\n");
// The commit before the last merged PRs, a stand-in sha.
export const BASE_SHA = "19".repeat(20); // the 20th PR merge, #611
// main's tree before #611: 400 code lines in two files, plus a test file, a
// file in a skipped folder and a non-code file, which never count.
export const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
const BASE_TREE = [
  ["a".repeat(40), "site/src/lib/math.ts", lines(250)],
  ["b".repeat(40), "scripts/old.mjs", lines(150)],
  ["c".repeat(40), "site/src/lib/math.test.ts", lines(99)],
  ["d".repeat(40), "site/src/test/helper.ts", lines(99)],
  ["e".repeat(40), "site/src/README.md", "# Not code\n"],
];
function catFile(input) {
  const parts = input.trim().split("\n").map((sha) => {
    const text = Buffer.from(BASE_TREE.find((b) => b[0] === sha)[2]);
    return Buffer.concat([Buffer.from(`${sha} blob ${text.length}\n`), text, Buffer.from("\n")]);
  });
  const bytes = Buffer.concat(parts);
  return { code: 0, stdout: bytes.toString(), bytes, stderr: "", ms: 1 };
}
const DEPLOYS = {
  "fixture-site": "2026-11-02T23:51:35.035758Z",
  "fixture-bot": "2026-10-19T00:56:42.293076Z",
};

const ok = (stdout = "", extra = {}) => ({ code: 0, stdout, stderr: "", ms: 1200, ...extra });
const MISSING = { code: null, missing: true, stdout: "", stderr: "", ms: 0 };

// The canned git answers by subcommand; "log -1" and "log --first-parent" are read before plain "log".
const GIT_REPLIES = {
  "rev-parse": () => ok("false\n"),
  "log --first-parent": () => ok(MAIN_LOG + "\n"),
  "ls-tree": () => ok(BASE_TREE.map(([sha, path]) => `100644 blob ${sha}\t${path}`).join("\0") + "\0"),
  "cat-file": (opts) => catFile(opts.input),
  "ls-files": (opts) => ok(trackedFiles(opts.cwd).join("\0")),
  "log -1": () => ok(seconds(SITE_COMMIT) + "\n"),
  log: () => ok("site/src/lib/old.ts\n\nsite/src/lib/math.ts\n"),
};

// The canned answer to one git command, or null when it is not git.
function gitReply(name, args, opts) {
  if (name !== "git") return null;
  const reply = GIT_REPLIES[`${args[0]} ${args[1]}`] ?? GIT_REPLIES[args[0]];
  return reply ? reply(opts) : null;
}

// The canned answer to knip, wrangler or vitest, or null for any other command.
function toolReply(name, args, opts, call, coverage) {
  if (name === "knip") {
    call.config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1], "utf8"));
    return ok(readFileSync(join(FIXTURES, "knip.json"), "utf8"));
  }
  if (name === "wrangler") {
    const outdir = args[args.indexOf("--outdir") + 1];
    writeFileSync(join(outdir, "index.js"), opts.cwd.endsWith("site") ? SITE_BUNDLE : BOT_BUNDLE);
    writeFileSync(join(outdir, "index.js.map"), "x".repeat(100_000));
    writeFileSync(join(outdir, "README.md"), "not a module");
    return ok("--dry-run: exiting now.");
  }
  if (name === "vitest") {
    const site = opts.cwd.endsWith("site");
    const dir = args.find((a) => a.startsWith("--coverage.reportsDirectory="))?.slice("--coverage.reportsDirectory=".length);
    const files = coverage?.[site ? "site" : "bot"];
    if (dir && files) writeCoverage(dir, opts.cwd, files, !site);
    return ok("", { code: site ? 1 : 0 });
  }
  return null;
}

// Each Worker's newest requests since its deploy, newest first, as Workers
// Logs answers ORDER BY timestamp DESC LIMIT n.
const REQUEST_ROWS = {
  "fixture-site": [
    { cpuTimeMs: 1, wallTimeMs: 3, timestamp: "2026-11-03 10:00:02.000" },
    { cpuTimeMs: 46, wallTimeMs: 12, timestamp: "2026-11-03 10:00:01.000" },
    { cpuTimeMs: 2, wallTimeMs: 4, timestamp: "2026-11-03 09:58:00.000" },
  ],
  "fixture-bot": [{ cpuTimeMs: 9, wallTimeMs: 5, timestamp: "2026-11-03 08:00:00.000" }],
};

// The canned answer to one cf command, or null when it is not cf.
function cfReply(name, args) {
  if (name !== "cf") return null;
  const [a, b] = args;
  if (a === "workers" && b === "get") return ok(JSON.stringify({ id: `tag-${args[2]}`, name: args[2] }));
  if (a === "builds" && b === "list") {
    // Newest first: a failed build, then the successful one that deployed.
    const w = args[args.indexOf("--external-script-id") + 1].slice(4);
    return ok(JSON.stringify([
      { build_uuid: `${w}-new`, build_outcome: "failure", created_on: "2026-11-03T21:00:00Z" },
      { build_uuid: `${w}-ok`, build_outcome: "success", created_on: "2026-11-03T20:00:00Z" },
    ]));
  }
  if (a === "builds" && b === "logs") {
    const ms = { "fixture-site-ok": 33, "fixture-bot-ok": 12 }[args[3]];
    return ok(JSON.stringify({ lines: [[1, "Total Upload: 152.00 KiB / gzip: 49.49 KiB"], [2, `Worker Startup Time: ${ms} ms`]] }));
  }
  if (a === "workers") {
    const worker = args[args.indexOf("--worker") + 1];
    return ok(JSON.stringify({ deployments: [{ id: "x", created_on: DEPLOYS[worker] }, { id: "y", created_on: "2026-01-01T00:00:00Z" }] }));
  }
  const worker = /scriptName IN \('([\w-]+)'\)/.exec(args[2])[1];
  return ok(JSON.stringify({ data: REQUEST_ROWS[worker] }));
}

// Answers each command the collector runs with canned output, and records the
// calls so tests can check what was run. coverage: per-suite files, or null for
// a suite that writes no summary.
export function stubRun(calls, overrides = {}, coverage = COVERAGE) {
  return async (cmd, args, opts = {}) => {
    const name = basename(cmd);
    const call = { name, args, cwd: opts.cwd };
    calls.push(call);
    if (overrides[name]) return overrides[name](args, opts);
    return gitReply(name, args, opts) ?? toolReply(name, args, opts, call, coverage) ?? cfReply(name, args) ?? MISSING;
  };
}

// What git ls-files would print for the temp repo: every file but the build
// output and node_modules, which are gitignored.
function trackedFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .filter((p) => !/^(site\/dist|node_modules)\//.test(p))
    .sort();
}

// The fixture plus what is easier to write than to commit: a long file, a
// built site/dist (dist/ is gitignored) and the coverage provider's manifest
// (node_modules/ is gitignored).
export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "code-collector-"));
  cpSync(join(FIXTURES, "repo"), root, { recursive: true });
  mkdirSync(join(root, "node_modules/@vitest/coverage-v8"), { recursive: true });
  writeFileSync(join(root, "node_modules/@vitest/coverage-v8/package.json"), '{ "name": "@vitest/coverage-v8" }\n');
  const long = [
    "// Written by code.test.mjs: one long function, and enough lines to pass the file limit.",
    "export function long() {",
    "  let n = 0;",
    ...Array.from({ length: 49 }, () => "  n += 1;"),
    "  return n;",
    "}",
    ...Array.from({ length: 257 }, (_, i) => `export const v${i} = ${i};`),
  ];
  writeFileSync(join(root, "scripts/long.mjs"), long.join("\n") + "\n");
  const dist = join(root, "site/dist");
  mkdirSync(join(dist, "_astro"), { recursive: true });
  mkdirSync(join(dist, "about"), { recursive: true });
  writeFileSync(join(dist, "_astro/a.js"), 'import "./c.js";\nconsole.log("a");\n'.repeat(30));
  writeFileSync(join(dist, "_astro/b.js"), "console.log('b');\n".repeat(20));
  writeFileSync(join(dist, "_astro/c.js"), "console.log('c');\n".repeat(10));
  writeFileSync(
    join(dist, "index.html"),
    '<script type="module" src="/_astro/a.js"></script><link href="/_astro/b.js" rel="modulepreload">',
  );
  writeFileSync(join(dist, "about/index.html"), '<link rel="modulepreload" href="/_astro/b.js">');
  return root;
}

// The measured value of one metric id in a result, which must be measured.
export const value = (r, id) => {
  assert.ok("value" in r[id], `${id} was not measured: ${r[id].could_not_check}`);
  return r[id].value;
};
