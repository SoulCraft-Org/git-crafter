// More tests for the Code tab's collector, split out of code.test.mjs to keep each file under the Read limit:
// missing inputs, the check job time and the code tokens. Shared fixtures are in code-fixtures.mjs.
// Run with: node --test quality/collectors/code/code-inputs.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { collect, PARAMS } from "./code.mjs";
import { CODE_EXTENSIONS } from "./complexity.mjs";
import { TARGETS, FIXTURE, SITE_BUNDLE, BOT_BUNDLE, pastNear, kb, seconds, COVERAGE, writeCoverage, MAIN_LOG, lines, stubRun, makeRepo, value } from "./code-fixtures.mjs";
describe("missing inputs", () => {
  it("make every metric could_not_check, never 0, and nothing throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-collector-empty-"));
    try {
      const run = async () => ({ code: null, missing: true, stdout: "", stderr: "", ms: 0 });
      for (const params of [FIXTURE, PARAMS, {}]) {
        const result = await collect({ root, mode: "local", run, params });
        assert.deepEqual(Object.keys(result).sort(), TARGETS.map((t) => t.id).sort());
        for (const [id, r] of Object.entries(result)) {
          assert.ok(!("value" in r), `${id} has no value`);
          assert.match(r.could_not_check, /\S/, `${id} says why`);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the template's defaults on a repo with no src/, Worker or suite say which param to set", async () => {
    const root = makeRepo();
    try {
      const result = await collect({ root, mode: "ci", run: stubRun([]) });
      assert.match(result["code.long_files"].could_not_check, /area not found: src; update params\.areas/);
      assert.match(result["code.worker_cpu_max_ms"].could_not_check, /params\.workers names no Worker folder/);
      assert.match(result["code.worker_bundle_kb"].could_not_check, /params\.workers names no Worker folder/);
      assert.match(result["code.test_coverage_pct"].could_not_check, /params\.test_suites names no test suite/);
      assert.match(result["code.client_js_kb"].could_not_check, /no site build in dist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("params change what counts: limits, naming rules and the merged-PR window", async () => {
    const root = makeRepo();
    try {
      const params = {
        ...FIXTURE,
        limits: { ...FIXTURE.limits, file_lines: 1000, complexity: 0 },
        naming: [{ rule: "camelCase modules", path: "\\.ts$", cases: ["camel"] }],
        merged_prs: 25,
      };
      const result = await collect({ root, mode: "ci", run: stubRun([]), params });
      assert.equal(value(result, "code.long_files"), 0);
      assert.match(result["code.complex_functions"].could_not_check, /params\.limits needs complexity/);
      // Only .ts files have a rule now; oldHelpers.ts passes as camelCase, math.ts too.
      assert.match(result["code.naming_pct"].source, /params\.naming/);
      assert.ok(result["code.naming_pct"].detail.every((d) => !d.label.includes(".astro")), "no rule covers .astro");
      assert.match(result["code.loc_change_pct"].source, /before PR #606\)/);
      const none = await collect({ root, mode: "ci", run: stubRun([]), params: { ...FIXTURE, naming: [], limits: {} } });
      assert.match(none["code.naming_pct"].could_not_check, /params\.naming has no rule/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fewer than 20 merged PRs on main leaves the code-line change could_not_check, and says if the clone is shallow", async () => {
    const root = makeRepo();
    try {
      const short = MAIN_LOG.split("\n").slice(0, 6).join("\n");
      const git = async (args, opts) => {
        if (args[1] === "--first-parent") return { code: 0, stdout: short, stderr: "", ms: 1 };
        if (args[0] === "rev-parse") return { code: 0, stdout: "true\n", stderr: "", ms: 1 };
        return stubRun([])("git", args, opts);
      };
      const result = await collect({ root, mode: "ci", run: stubRun([], { git }), params: FIXTURE });
      assert.match(result["code.loc_change_pct"].could_not_check, /only 5 merged PRs .* need 20; shallow clone/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the default branch from ci.json's params: a master repo counts master's merged PRs", async () => {
    const root = makeRepo();
    try {
      const calls = [];
      // Only master exists: any other ref fails as git does.
      const git = async (args, opts) =>
        args[1] === "--first-parent" && !args.includes("origin/master") ? { code: 128, stdout: "", stderr: "fatal: bad revision", ms: 1 } : stubRun([])("git", args, opts);
      const allParams = { "ci.json": { default_branch: "master" } };
      const result = await collect({ root, mode: "ci", run: stubRun(calls, { git }), params: FIXTURE, allParams });
      assert.equal(value(result, "code.loc_change_pct"), -3.5, "ci.json's branch wins over main_branch");
      const tried = calls.filter((c) => c.name === "git" && c.args[1] === "--first-parent").map((c) => c.args[5]);
      assert.deepEqual(tried, ["origin/master"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("with no branch named anywhere, main's history is HEAD's, and nothing assumes main", async () => {
    const root = makeRepo();
    try {
      const calls = [];
      const result = await collect({ root, mode: "ci", run: stubRun(calls), params: { ...FIXTURE, main_branch: "" } });
      assert.equal(value(result, "code.loc_change_pct"), -3.5);
      const tried = calls.filter((c) => c.name === "git" && c.args[1] === "--first-parent").map((c) => c.args[5]);
      assert.deepEqual(tried, ["HEAD"]);
      const failing = async (args, opts) =>
        args[1] === "--first-parent" ? { code: 128, stdout: "", stderr: "fatal: bad revision", ms: 1 } : stubRun([])("git", args, opts);
      const none = await collect({ root, mode: "ci", run: stubRun([], { git: failing }), params: { ...FIXTURE, main_branch: "" } });
      assert.match(none["code.loc_change_pct"].could_not_check, /git log failed on HEAD \(fatal: bad revision\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no origin/main falls back to main, and git failing everywhere is could_not_check", async () => {
    const root = makeRepo();
    try {
      const calls = [];
      const git = async (args, opts) => {
        if (args[1] === "--first-parent" && args.includes("origin/main")) return { code: 128, stdout: "", stderr: "fatal: bad revision", ms: 1 };
        return stubRun([])("git", args, opts);
      };
      let result = await collect({ root, mode: "ci", run: stubRun(calls, { git }), params: FIXTURE });
      assert.equal(value(result, "code.loc_change_pct"), -3.5);
      const failing = async (args, opts) =>
        args[1] === "--first-parent" ? { code: 128, stdout: "", stderr: "fatal: bad revision", ms: 1 } : stubRun([])("git", args, opts);
      result = await collect({ root, mode: "ci", run: stubRun([], { git: failing }), params: FIXTURE });
      assert.match(result["code.loc_change_pct"].could_not_check, /git log failed on origin\/main, main, HEAD \(fatal: bad revision\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a Worker with no request since its deploy is named, and none at all is could_not_check", async () => {
    const root = makeRepo();
    try {
      const empty = (worker) => async (args, opts) => {
        if (args[0] === "sql" && (!worker || args[2].includes(`'${worker}'`))) return { code: 0, stdout: '{"data":[]}', stderr: "", ms: 1 };
        return stubRun([])("cf", args, opts);
      };
      let result = await collect({ root, mode: "local", run: stubRun([], { cf: empty("fixture-bot"), ps: async () => ({ code: 0, stdout: "", stderr: "", ms: 1 }) }), params: FIXTURE });
      assert.equal(value(result, "code.worker_cpu_max_ms"), 46);
      assert.match(result["code.worker_cpu_max_ms"].source, /no fetch since the deploy: fixture-bot \(deployed 2026-10-19T00:56:43Z\)/);
      result = await collect({ root, mode: "local", run: stubRun([], { cf: empty(null), ps: async () => ({ code: 0, stdout: "", stderr: "", ms: 1 }) }), params: FIXTURE });
      assert.match(result["code.worker_cpu_max_ms"].could_not_check, /no fetch invocations in Workers Logs since the latest deploy/);
      // N comes from the params, and a bad N is could_not_check, never a guess.
      const calls = [];
      await collect({ root, mode: "local", run: stubRun(calls), params: { ...FIXTURE, last_requests: 50 } });
      assert.ok(calls.filter((c) => c.name === "cf" && c.args[0] === "sql").every((c) => / LIMIT 50 FORMAT JSON$/.test(c.args[2])));
      for (const bad of [0, 2.5]) {
        result = await collect({ root, mode: "local", run: stubRun([]), params: { ...FIXTURE, last_requests: bad } });
        assert.match(result["code.worker_wall_max_ms"].could_not_check, /params\.last_requests must be a whole count above 0/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a request missing a number is skipped, and a column with none is could_not_check, never NaN", async () => {
    const root = makeRepo();
    try {
      const rows = (data) => async (args, opts) =>
        args[0] === "sql" ? { code: 0, stdout: JSON.stringify({ data }), stderr: "", ms: 1 } : stubRun([])("cf", args, opts);
      const at = "2026-11-03 10:00:00.000";
      let result = await collect({ root, mode: "local", run: stubRun([], { cf: rows([{ cpuTimeMs: 7, wallTimeMs: 9, timestamp: at }, { wallTimeMs: 30, timestamp: at }]) }), params: FIXTURE });
      assert.equal(value(result, "code.worker_cpu_max_ms"), 7);
      assert.equal(value(result, "code.worker_wall_max_ms"), 30);
      result = await collect({ root, mode: "local", run: stubRun([], { cf: rows([{ wallTimeMs: 30, timestamp: at }]) }), params: FIXTURE });
      assert.match(result["code.worker_cpu_max_ms"].could_not_check, /Workers Logs gave no cpuTimeMs number/);
      assert.equal(value(result, "code.worker_wall_max_ms"), 30);
      // null and "" are missing too, never 0 ms.
      result = await collect({ root, mode: "local", run: stubRun([], { cf: rows([{ cpuTimeMs: null, wallTimeMs: 30, timestamp: at }, { cpuTimeMs: "", wallTimeMs: 20, timestamp: at }]) }), params: FIXTURE });
      assert.match(result["code.worker_cpu_max_ms"].could_not_check, /Workers Logs gave no cpuTimeMs number/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("areas with no code leave copied code and purpose comments could_not_check, not 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "code-collector-hollow-"));
    try {
      for (const a of ["site/src", "site/worker", "workers/bot/src", "packages/shared", "scripts", "tools"]) {
        mkdirSync(join(root, a), { recursive: true });
      }
      const result = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.match(result["code.duplicated_pct"].could_not_check, /no code lines/);
      assert.match(result["code.purpose_comments_pct"].could_not_check, /nothing to count/);
      assert.match(result["code.naming_pct"].could_not_check, /git ls-files listed no files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("git ls-files failing leaves structure could_not_check", async () => {
    const root = makeRepo();
    try {
      const fails = async (args) => ({ code: args[0] === "ls-files" ? 128 : 0, stdout: "false\n", stderr: "fatal: bad index", ms: 1 });
      let result = await collect({ root, mode: "ci", run: stubRun([], { git: fails }), params: FIXTURE });
      for (const id of ["code.naming_pct"]) {
        assert.match(result[id].could_not_check, /git ls-files failed \(fatal: bad index\)/, id);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("git ls-files with no file in the areas leaves naming could_not_check, not 0", async () => {
    const root = makeRepo();
    try {
      const outside = async (args) =>
        args[0] === "ls-files"
          ? { code: 0, stdout: ["CLAUDE.md", "README.md", "docs/guide.md"].join("\0"), stderr: "", ms: 1 }
          : { code: 0, stdout: "false\n", stderr: "", ms: 1 };
      const result = await collect({ root, mode: "ci", run: stubRun([], { git: outside }), params: FIXTURE });
      assert.match(result["code.naming_pct"].could_not_check, /git ls-files listed no code file in the areas/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a shallow clone cannot vouch for deleted files", async () => {
    const root = makeRepo();
    try {
      const run = stubRun([], { git: async () => ({ code: 0, stdout: "true\n", stderr: "", ms: 1 }) });
      const result = await collect({ root, mode: "ci", run, params: FIXTURE });
      assert.match(result["code.missing_refs"].could_not_check, /shallow clone/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a report with no branch data reads lines only, naming the suite, never a mixed share", async () => {
    const root = makeRepo();
    try {
      const linesOnly = { site: { "src/lib/math.ts": [170, 200], "worker/index.ts": [45, 50] }, bot: { "src/app.ts": [45, 50] } };
      let result = await collect({ root, mode: "ci", run: stubRun([], {}, linesOnly), params: FIXTURE });
      assert.equal(value(result, "code.test_coverage_pct"), 86.7);
      assert.match(result["code.test_coverage_pct"].source, /lines only, since site unit \+ worker, bot reported no branch data: 260 of 300 lines covered/);
      assert.deepEqual(result["code.test_coverage_pct"].detail.map((d) => d.label), ["site/src lines", "site/worker lines", "workers/bot/src lines"]);
      // One suite without branches: the whole share is lines only.
      result = await collect({ root, mode: "ci", run: stubRun([], {}, { site: COVERAGE.site, bot: linesOnly.bot }), params: FIXTURE });
      assert.equal(value(result, "code.test_coverage_pct"), 86.7);
      assert.match(result["code.test_coverage_pct"].source, /lines only, since bot reported no branch data/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a suite with 0 branches still counts branches, and malformed branch data is named as such", async () => {
    const root = makeRepo();
    try {
      // The bot has no branches to cover: (260 + 38) / (300 + 50) = 85.1%, not lines only.
      const noneToCover = { site: COVERAGE.site, bot: { "src/app.ts": [45, 50, 0, 0] } };
      let result = await collect({ root, mode: "ci", run: stubRun([], {}, noneToCover), params: FIXTURE });
      assert.equal(value(result, "code.test_coverage_pct"), 85.1);
      assert.match(result["code.test_coverage_pct"].source, /lines and branches together: 260 of 300 lines and 38 of 50 branches covered/);
      assert.ok(!result["code.test_coverage_pct"].detail.some((d) => d.label === "workers/bot/src branches"), "no branch row where there is nothing to cover");
      // The bot's total.branches is malformed: lines only, and said so.
      const malformed = async (args, opts) => {
        const dir = args.find((a) => a.startsWith("--coverage.reportsDirectory=")).slice("--coverage.reportsDirectory=".length);
        const site = opts.cwd.endsWith("site");
        writeCoverage(dir, opts.cwd, COVERAGE[site ? "site" : "bot"], !site);
        if (!site) {
          const file = join(dir, "coverage-summary.json");
          const summary = JSON.parse(readFileSync(file, "utf8"));
          summary.total.branches = { covered: "12", total: null };
          writeFileSync(file, JSON.stringify(summary));
        }
        return { code: 0, stdout: "", stderr: "", ms: 1 };
      };
      result = await collect({ root, mode: "ci", run: stubRun([], { vitest: malformed }), params: FIXTURE });
      assert.equal(value(result, "code.test_coverage_pct"), 86.7);
      assert.match(result["code.test_coverage_pct"].source, /lines only, since bot wrote malformed branch data: 260 of 300 lines covered/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("coverage below the goal is measured and scores as a miss", async () => {
    const root = makeRepo();
    try {
      const low = { site: { "src/lib/math.ts": [20, 200], "worker/index.ts": [5, 50] }, bot: { "src/app.ts": [5, 50] } };
      const result = await collect({ root, mode: "ci", run: stubRun([], {}, low), params: FIXTURE });
      assert.equal(value(result, "code.test_coverage_pct"), 10);
      const target = TARGETS.find((t) => t.id === "code.test_coverage_pct");
      assert.ok(pastNear(target, value(result, "code.test_coverage_pct")), "past the near band: a miss");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a missing coverage summary leaves coverage could_not_check, never 0 or a partial share", async () => {
    const root = makeRepo();
    try {
      for (const coverage of [null, { site: COVERAGE.site, bot: null }]) {
        const result = await collect({ root, mode: "ci", run: stubRun([], {}, coverage), params: FIXTURE });
        const r = result["code.test_coverage_pct"];
        assert.ok(!("value" in r), "no coverage value");
        assert.match(r.could_not_check, /bot: vitest wrote no coverage summary/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("without the coverage provider the suite does not run and coverage is could_not_check", async () => {
    const root = makeRepo();
    const calls = [];
    try {
      rmSync(join(root, "node_modules"), { recursive: true });
      const result = await collect({ root, mode: "ci", run: stubRun(calls), params: FIXTURE });
      assert.match(result["code.test_coverage_pct"].could_not_check, /@vitest\/coverage-v8 is not installed/);
      assert.ok(!calls.some((c) => c.name === "vitest"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an unbuilt site still measures its Worker bundle, against an empty stand-in for site/dist", async () => {
    const root = makeRepo();
    const calls = [];
    try {
      rmSync(join(root, "site/dist"), { recursive: true });
      const seen = [];
      const run = stubRun(calls, {
        wrangler: (args, opts) => {
          const at = args.indexOf("--assets");
          if (at >= 0) seen.push(readdirSync(args[at + 1]));
          return stubRun([])(join("bin", "wrangler"), args, opts);
        },
      });
      const result = await collect({ root, mode: "ci", run, params: FIXTURE });
      assert.equal(value(result, "code.worker_bundle_kb"), Math.max(kb(SITE_BUNDLE), kb(BOT_BUNDLE)));
      assert.deepEqual(seen, [[]], "only the site, which has assets, gets the stand-in, and it is empty");
      assert.ok(!calls.find((c) => c.name === "wrangler" && c.cwd.endsWith("bot")).args.includes("--assets"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a failed dry run names Wrangler's error, not the warning printed before it", async () => {
    const root = makeRepo();
    try {
      const stderr =
        "\x1b[33m▲ \x1b[43;33m[\x1b[43;30mWARNING\x1b[43;33m]\x1b[0m Multiple environments are defined\n" +
        "\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1mCould not resolve \"zod\"\x1b[0m\n";
      const run = stubRun([], { wrangler: () => ({ code: 1, stdout: "", stderr, ms: 900 }) });
      const result = await collect({ root, mode: "ci", run, params: FIXTURE });
      assert.equal(result["code.worker_bundle_kb"].could_not_check, 'site: wrangler dry run failed (Could not resolve "zod")');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Runs collect with one wrangler answer and returns the bundle reason.
  const failedDryRun = async (stderr, stdout) => {
    const root = makeRepo();
    try {
      const run = stubRun([], { wrangler: () => ({ code: 1, stdout, stderr, ms: 900 }) });
      return (await collect({ root, mode: "ci", run, params: FIXTURE }))["code.worker_bundle_kb"].could_not_check;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it("an [ERROR] marker alone on its line takes the message from the next non-empty line", async () => {
    const stderr = "\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \n\n  Could not resolve \"zod\"\n";
    assert.equal(await failedDryRun(stderr, ""), 'site: wrangler dry run failed (Could not resolve "zod")');
  });

  it("an [ERROR] in stdout wins over warnings in stderr", async () => {
    const stderr = "▲ [WARNING] Multiple environments are defined\n";
    assert.equal(await failedDryRun(stderr, "✘ [ERROR] Build failed\n"), "site: wrangler dry run failed (Build failed)");
    assert.equal(await failedDryRun(stderr, ""), "site: wrangler dry run failed (▲ [WARNING] Multiple environments are defined)");
  });

  it("an absolute assets.directory that exists is bundled as it is, never swapped for the stand-in", async () => {
    const root = makeRepo();
    const calls = [];
    try {
      const dist = join(root, "site/dist");
      writeFileSync(join(root, "site/wrangler.jsonc"), JSON.stringify({ name: "fixture-site", main: "worker/index.ts", assets: { directory: dist } }));
      await collect({ root, mode: "ci", run: stubRun(calls), params: FIXTURE });
      const site = calls.find((c) => c.name === "wrangler" && c.cwd.endsWith("site"));
      assert.ok(!site.args.includes("--assets"), `site/dist exists at ${dist}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a Worker config that cannot be read leaves no scratch folder behind", async () => {
    const root = makeRepo();
    const tmp = mkdtempSync(join(tmpdir(), "code-collector-tmp-"));
    const saved = process.env.TMPDIR;
    // Assigning undefined would store the string "undefined": an unset
    // TMPDIR (as on CI runners) is deleted again instead.
    const restore = () => (saved === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = saved));
    try {
      // A folder where the file should be: readFileSync throws EISDIR.
      rmSync(join(root, "site/wrangler.jsonc"));
      mkdirSync(join(root, "site/wrangler.jsonc"));
      process.env.TMPDIR = tmp;
      const result = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      restore();
      assert.match(result["code.worker_bundle_kb"].could_not_check, /collector error/);
      assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("quality-wrangler-")), []);
    } finally {
      restore();
      rmSync(tmp, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an unbuilt site leaves client JS could_not_check", async () => {
    const root = makeRepo();
    try {
      rmSync(join(root, "site/dist"), { recursive: true });
      mkdirSync(join(root, "site/dist"));
      const result = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.match(result["code.client_js_kb"].could_not_check, /no site build/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a build older than the newest site/ commit is could_not_check, naming both times", async () => {
    const root = makeRepo();
    try {
      const built = new Date("2026-10-22T21:09:46.000Z");
      utimesSync(join(root, "site/dist/index.html"), built, built);
      const commit = "2026-11-02T12:00:00.000Z";
      const git = async (args) => ({ code: 0, stdout: args[1] === "-1" ? seconds(commit) + "\n" : "false\n", stderr: "", ms: 1 });
      const result = await collect({ root, mode: "ci", run: stubRun([], { git }), params: FIXTURE });
      const r = result["code.client_js_kb"];
      assert.ok(!("value" in r), "a stale build is not measured");
      assert.match(r.could_not_check, new RegExp(`built ${built.toISOString()}.*\\(${commit}\\); run the build first`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("when git cannot answer, the build is measured and the source says freshness was not checked", async () => {
    const root = makeRepo();
    try {
      const git = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository", ms: 1 });
      const result = await collect({ root, mode: "ci", run: stubRun([], { git }), params: FIXTURE });
      assert.equal(typeof value(result, "code.client_js_kb"), "number");
      assert.match(result["code.client_js_kb"].source, /freshness not checked \(git log failed: fatal: not a git repository\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Speed and consumption with no Worker or website (issue #81): the check a
// change waits on, and the code a session reads, both from any repo.
describe("check job time and code tokens", () => {
  const RUN = (id, extra = {}) => ({ id, node_id: `R_${id}`, head_branch: "main", status: "completed", conclusion: "success", created_at: "2026-11-03T12:00:00Z", ...extra });
  const job = (name, started, completed, conclusion = "success") => ({ databaseId: 1, name, conclusion: conclusion.toUpperCase(), startedAt: started, completedAt: completed });
  const fakeGh = (runs, jobsByRun) => ({
    rest: async (path) => {
      if (path === "repos/o/r/actions/workflows/verify.yml") return { id: 7, name: "verify" };
      if (path.startsWith("repos/o/r/actions/workflows/7/runs")) return { workflow_runs: runs };
      throw new Error(`unexpected ${path}`);
    },
    graphql: async () => ({ nodes: runs.map((r) => ({ databaseId: r.id, checkSuite: { checkRuns: { nodes: jobsByRun[r.id] ?? [] } } })) }),
  });
  const params = { ...FIXTURE, main_branch: "main", check: { workflow: "verify.yml", job: "short" } };
  const github = { "github.json": { repo: "o/r" } };

  it("times the named job in the newest successful run on the default branch, a reusable workflow's job included", async () => {
    const root = makeRepo();
    try {
      const runs = [RUN(3, { head_branch: "feature" }), RUN(2, { conclusion: "failure" }), RUN(1)];
      const gh = fakeGh(runs, { 1: [job("ci / changes", "2026-11-03T12:00:00Z", "2026-11-03T12:00:20Z"), job("ci / short", "2026-11-03T12:00:30Z", "2026-11-03T12:02:05Z")] });
      const r = await collect({ root, mode: "ci", run: stubRun([]), params, allParams: github, gh });
      assert.equal(value(r, "code.check_seconds"), 95);
      assert.match(r["code.check_seconds"].source, /^latest: .*verify\.yml job ci \/ short, run 1/);
      assert.deepEqual(r["code.check_seconds"].detail, [{ label: "2026-11-03 run 1", value: 95, unit: "s" }], "one bar per successful run on the branch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("says why it could not time the job, and never reads 0", async () => {
    const root = makeRepo();
    try {
      const none = await collect({ root, mode: "ci", run: stubRun([]), params: { ...params, check: { workflow: "", job: "" } }, allParams: github, gh: fakeGh([], {}) });
      assert.match(none["code.check_seconds"].could_not_check, /params\.check names no/);
      const noRepo = await collect({ root, mode: "ci", run: stubRun([]), params, allParams: {}, gh: fakeGh([], {}) });
      if (!process.env.GITHUB_REPOSITORY) assert.match(noRepo["code.check_seconds"].could_not_check, /no repo/);
      const failed = await collect({ root, mode: "ci", run: stubRun([]), params, allParams: github, gh: fakeGh([RUN(1)], { 1: [job("ci / short", "2026-11-03T12:00:00Z", "2026-11-03T12:01:00Z", "failure")] }) });
      assert.match(failed["code.check_seconds"].could_not_check, /no job named short passed/);
      assert.ok(!("value" in failed["code.check_seconds"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the largest area's code files, tests included, at params.bytes_per_token a token", async () => {
    const root = makeRepo();
    try {
      const r = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      const skip = new Set([".git", ...FIXTURE.skip_dirs]);
      const codeFile = (n) => CODE_EXTENSIONS.has(n.slice(n.lastIndexOf(".")));
      const walkBytes = (dir) => readdirSync(dir, { withFileTypes: true }).reduce((sum, e) => (e.isDirectory() ? (skip.has(e.name) ? sum : sum + walkBytes(join(dir, e.name))) : codeFile(e.name) ? sum + readFileSync(join(dir, e.name)).length : sum), 0);
      const each = FIXTURE.areas.map((a) => Math.round(walkBytes(join(root, a)) / FIXTURE.bytes_per_token));
      assert.equal(value(r, "code.code_tokens"), Math.max(...each));
      assert.equal(r["code.code_tokens"].detail.length, FIXTURE.areas.length);
      assert.equal(r["code.code_tokens"].detail[0].value, Math.max(...each), "largest area first");
      assert.match(r["code.code_tokens"].source, new RegExp(`: ${r["code.code_tokens"].detail[0].label}$`));
      // The largest single file: the long file makeRepo writes, at params.bytes_per_token a token.
      const long = Math.round(readFileSync(join(root, "scripts/long.mjs")).length / FIXTURE.bytes_per_token);
      assert.equal(value(r, "code.largest_file_tokens"), long);
      assert.deepEqual(r["code.largest_file_tokens"].detail[0], { label: "scripts/long.mjs", value: long, unit: "tokens" });
      assert.match(r["code.largest_file_tokens"].source, /: scripts\/long\.mjs$/);
      assert.ok(r["code.largest_file_tokens"].detail.length <= 10);
      // params.size_extra counts for the largest file only, never for an area's tokens (#738).
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "tests/huge.test.mjs"), "x\n".repeat(40000));
      const extra = await collect({ root, mode: "ci", run: stubRun([]), params: { ...FIXTURE, size_extra: ["tests"] } });
      assert.equal(extra["code.largest_file_tokens"].detail[0].label, "tests/huge.test.mjs");
      assert.equal(value(extra, "code.largest_file_tokens"), Math.round(80000 / FIXTURE.bytes_per_token));
      assert.equal(value(extra, "code.code_tokens"), value(r, "code.code_tokens"));
      const noExtra = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.equal(value(noExtra, "code.largest_file_tokens"), long);
      const badExtra = await collect({ root, mode: "ci", run: stubRun([]), params: { ...FIXTURE, size_extra: ["no-such-dir"] } });
      assert.match(badExtra["code.largest_file_tokens"].could_not_check, /size_extra folder not found: no-such-dir/);
      assert.equal(value(badExtra, "code.code_tokens"), value(r, "code.code_tokens"), "a bad size_extra leaves the area tokens measured");
      // A folder that is an area of its own leaves its parent: no file counts twice.
      const split = await collect({ root, mode: "ci", run: stubRun([]), params: { ...FIXTURE, areas: ["site", "site/src"] } });
      const site = Math.round(walkBytes(join(root, "site")) / FIXTURE.bytes_per_token);
      const src = Math.round(walkBytes(join(root, "site/src")) / FIXTURE.bytes_per_token);
      const byLabel = Object.fromEntries(split["code.code_tokens"].detail.map((d) => [d.label, d.value]));
      assert.equal(byLabel["site/src"], src);
      assert.ok(Math.abs(byLabel.site - (site - src)) <= 1, "site less site/src");
      const whole = await collect({ root, mode: "ci", run: stubRun([]), params: { ...FIXTURE, areas: ["site"] } });
      const counted = (res) => /; \d+ of (\d+)$/.exec(res["code.purpose_comments_pct"].source)[1];
      assert.equal(counted(split), counted(whole), "each file counts in one area");
      const missing = await collect({ root, mode: "ci", run: stubRun([]), params: { ...FIXTURE, areas: ["no-such-area"] } });
      assert.match(missing["code.code_tokens"].could_not_check, /area not found: no-such-area/);
      assert.match(missing["code.largest_file_tokens"].could_not_check, /area not found: no-such-area/);
      const noRatio = await collect({ root, mode: "ci", run: stubRun([]), params: { ...FIXTURE, bytes_per_token: 0 } });
      assert.match(noRatio["code.code_tokens"].could_not_check, /params\.bytes_per_token/);
      assert.match(noRatio["code.largest_file_tokens"].could_not_check, /params\.bytes_per_token/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
