// Tests for the Code tab's collector. The fixture repo under
// quality/fixtures/code/repo has hand-counted values; every command and every
// production request is stubbed, so nothing here builds, deploys or calls the
// live site. Run with: node --test quality/collectors/code/code.test.mjs
// Missing inputs, the check job time and the code tokens are in code-inputs.test.mjs.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { gzipSync } from "node:zlib";
import { collect, latestDeploy, PARAMS, runCommand } from "./code.mjs";
import { analyzeFile, looksLikeCode } from "./complexity.mjs";
import { CASES, duplicates, namingRule } from "./shape.mjs";
import { here, FIXTURES, TARGETS, AREAS, FIXTURE, SITE_BUNDLE, BOT_BUNDLE, meets, kb, SITE_COMMIT, BASE_SHA, lines, stubRun, makeRepo, value } from "./code-fixtures.mjs";
describe("collect on the known-good fixture", () => {
  let root;
  let result;
  const calls = [];

  before(async () => {
    root = makeRepo();
    result = await collect({ root, mode: "local", run: stubRun(calls), params: FIXTURE });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("counts code lines per area, leaving out comments, blanks and generated files; no line cap", () => {
    // code.loc is gone; its count still feeds the change over the last 20 PRs.
    assert.equal(result["code.loc"], undefined);
    assert.match(result["code.loc_change_pct"].source, /, 386 now,/);
  });

  it("finds the complex function, the long function and the long file, each row in its own unit", () => {
    assert.equal(value(result, "code.complex_functions"), 1);
    assert.deepEqual(result["code.complex_functions"].detail, [
      { label: "site/src/lib/math.ts:13 grade", value: 12, unit: "" },
    ]);
    assert.equal(value(result, "code.long_functions"), 1);
    assert.deepEqual(result["code.long_functions"].detail, [{ label: "scripts/long.mjs:2 long", value: 53, unit: "lines" }]);
    assert.equal(value(result, "code.long_files"), 1);
    assert.deepEqual(result["code.long_files"].detail, [{ label: "scripts/long.mjs", value: 310, unit: "lines" }]);
  });

  it("scores header comments on exported functions", () => {
    assert.equal(value(result, "code.export_comments_pct"), 71.4);
    assert.deepEqual(result["code.export_comments_pct"].detail, [
      { label: "site/src", value: 66.7 },
      { label: "site/worker", value: 100 },
      { label: "workers/bot/src", value: 100 },
      { label: "packages/shared", value: 0 },
      { label: "scripts", value: 100 },
    ]);
    // code.component_comments_pct is cut: purpose_comments_pct reads each .astro file's opening comment.
    assert.equal(result["code.component_comments_pct"], undefined);
  });

  it("finds drift markers, commented-out code and a reference to a deleted file", () => {
    assert.equal(value(result, "code.drift_markers"), 3);
    assert.deepEqual(
      result["code.drift_markers"].detail.map((d) => d.label).sort(),
      ["scripts/tool.mjs", "site/src/lib/math.ts", "tools/check.py"],
    );
    assert.equal(value(result, "code.commented_code"), 1);
    assert.deepEqual(result["code.commented_code"].detail, [{ label: "site/src/lib/math.ts:36", value: 4, unit: "lines" }]);
    assert.equal(value(result, "code.missing_refs"), 1);
    assert.deepEqual(result["code.missing_refs"].detail, [
      { label: "site/src/lib/math.ts:11 site/src/lib/old.ts", value: 1 },
    ]);
  });

  it("compares code lines with main before its last 20 merged PRs, counted from git's tree", () => {
    assert.equal(FIXTURE.merged_prs, 20);
    // 386 now against 400 at the base: the test file, the skipped folder and
    // the README in the base tree never count.
    assert.equal(value(result, "code.loc_change_pct"), -3.5);
    assert.match(result["code.loc_change_pct"].source, /400 lines at 1919191\^ \(before PR #611\), 386 now, through PR #630/);
    const now = { "site/src": 47, "site/worker": 15, "workers/bot/src": 3, "packages/shared": 4, scripts: 312, "tools": 5 };
    const change = Object.fromEntries(result["code.loc_change_pct"].detail.map((d) => [d.label, d.value]));
    assert.equal(change["site/src"], now["site/src"] - 250);
    assert.equal(change.scripts, now.scripts - 150);
    assert.equal(change["packages/shared"], now["packages/shared"]);
    assert.ok(result["code.loc_change_pct"].detail.every((d) => d.unit === "lines"));
    const ls = calls.find((c) => c.name === "git" && c.args[0] === "ls-tree");
    assert.deepEqual(ls.args.slice(0, 4), ["ls-tree", "-r", "-z", `${BASE_SHA}^`]);
    const log = calls.find((c) => c.name === "git" && c.args[1] === "--first-parent");
    assert.ok(log.args.includes("origin/main"));
  });

  it("finds no copied code in the fixture, and says how many lines it compared", () => {
    assert.equal(value(result, "code.duplicated_pct"), 0);
    assert.deepEqual(result["code.duplicated_pct"].detail, []);
    assert.match(result["code.duplicated_pct"].source, /0 of 386 code lines/);
  });

  it("scores files that open with a purpose comment, per area", () => {
    // Misses: packages/shared opens with code, pages/index.astro with an
    // import, and base.css's "Base styles." has two words.
    assert.equal(value(result, "code.purpose_comments_pct"), 78.6);
    assert.deepEqual(result["code.purpose_comments_pct"].detail, [
      { label: "site/src", value: 60 },
      { label: "site/worker", value: 100 },
      { label: "workers/bot/src", value: 100 },
      { label: "packages/shared", value: 0 },
      { label: "scripts", value: 100 },
      { label: "tools", value: 100 },
    ]);
  });

  it("reads structure from git ls-files: names by their folder's rule", () => {
    // 15 files and the 12 folders that hold them, from each area's own folder
    // down: site/src/pages/ is a page folder, the other 11 are module folders.
    assert.equal(value(result, "code.naming_pct"), 96.3);
    assert.match(result["code.naming_pct"].source, /26 of 27$/);
    assert.deepEqual(result["code.naming_pct"].detail, [
      { label: "PascalCase components (1)", value: 100 },
      { label: "kebab-case modules (22)", value: 95.5 },
      { label: "kebab-case pages (2)", value: 100 },
      { label: "snake_case tools (2)", value: 100 },
      { label: "site/src/lib/oldHelpers.ts (wants kebab-case modules)", value: 0 },
    ]);
    assert.deepEqual(calls.find((c) => c.name === "git" && c.args[0] === "ls-files").args, ["ls-files", "-z"]);
  });

  it("finds no import cycle and no drawn area in the fixture, which has no README", () => {
    assert.equal(value(result, "code.import_cycles"), 0);
    assert.deepEqual(result["code.import_cycles"].detail, []);
    assert.equal(value(result, "code.mapped_areas_pct"), 0);
    assert.match(result["code.mapped_areas_pct"].source, /0 of 6$/);
    assert.deepEqual(result["code.mapped_areas_pct"].detail.map((d) => d.label), AREAS);
  });

  it("counts files that import each other as one cycle, in JavaScript and in Python", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "scripts/a.mjs"), '// Written by code.test.mjs: half of a cycle.\nimport { b } from "./b.mjs";\nexport const a = () => b;\n');
      writeFileSync(join(dir, "scripts/b.mjs"), '// Written by code.test.mjs: the other half.\nexport { a } from "./a.mjs";\nexport const b = 1;\n');
      writeFileSync(join(dir, "scripts/c.mjs"), '// Written by code.test.mjs: imports the cycle, is not in it.\nimport { a } from "./a.mjs";\nexport const c = a;\n');
      writeFileSync(join(dir, "tools/one.py"), '"""Written by code.test.mjs: imports two."""\nimport two\n');
      writeFileSync(join(dir, "tools/two.py"), '"""Written by code.test.mjs: imports one, and a module that is not a file here."""\nfrom one import x\nimport json\n');
      // TypeScript's usual spellings: no extension, a folder's index file, and .js for a .ts source.
      mkdirSync(join(dir, "site/src/lib/shapes"), { recursive: true });
      writeFileSync(join(dir, "site/src/lib/shapes/index.ts"), '// Written by code.test.mjs: a folder index in a cycle.\nimport { area } from "../area";\nexport const shape = area;\n');
      writeFileSync(join(dir, "site/src/lib/area.ts"), '// Written by code.test.mjs: imports the folder, then a .js name.\nimport { shape } from "./shapes";\nimport { unit } from "./unit.js";\nexport const area = [shape, unit];\n');
      writeFileSync(join(dir, "site/src/lib/unit.ts"), '// Written by code.test.mjs: closes the cycle with no extension.\nimport { area } from "./area";\nexport const unit = area;\n');
      const got = await collect({ root: dir, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.equal(value(got, "code.import_cycles"), 3);
      assert.deepEqual(got["code.import_cycles"].detail, [
        { label: "site/src/lib/area.ts and site/src/lib/shapes/index.ts and site/src/lib/unit.ts", value: 3, unit: "files" },
        { label: "scripts/a.mjs and scripts/b.mjs", value: 2, unit: "files" },
        { label: "tools/one.py and tools/two.py", value: 2, unit: "files" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a folder map the README links beside it, never a doc it does not link", async () => {
    const dir = makeRepo();
    try {
      writeFileSync(join(dir, "README.md"), "# Fixture\n\nFolders: [MAP.md](MAP.md).\n");
      writeFileSync(join(dir, "MAP.md"), "| Folder | Holds |\n| --- | --- |\n| `site/src/` | pages |\n");
      writeFileSync(join(dir, "OTHER.md"), "| Folder | Holds |\n| --- | --- |\n| `tools/` | scripts |\n");
      const got = await collect({ root: dir, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.deepEqual(got["code.mapped_areas_pct"].detail.map((d) => d.label), AREAS.filter((a) => a !== "site/src"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts an area as drawn when a README shows it as a folder in a table or diagram, never for a plain word", async () => {
    const dir = makeRepo();
    try {
      // The root README draws scripts/ in a table and tools/ in a diagram; it only mentions the word site.
      writeFileSync(join(dir, "README.md"), "# Fixture\n\nThe site and packages/shared/ are described in prose.\n\n| Folder | Holds |\n| --- | --- |\n| `scripts/` | tools |\n| site | a word, not a folder |\n\n```mermaid\nflowchart LR\n  A[tools/] --> B[out]\n```\n");
      // A README inside an area draws it when it holds a table; one with prose only does not.
      writeFileSync(join(dir, "site/worker/README.md"), "# Worker\n\n| File | Does |\n| --- | --- |\n| index.ts | routes |\n");
      // A diagram counts with Windows line endings too.
      writeFileSync(join(dir, "packages/shared/README.md"), "# Shared\r\n\r\n```mermaid\r\nflowchart LR\r\n  A --> B\r\n```\r\n");
      writeFileSync(join(dir, "workers/bot/src/README.md"), "# Bot\n\nProse only.\n");
      const got = await collect({ root: dir, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.equal(value(got, "code.mapped_areas_pct"), 66.7);
      assert.deepEqual(got["code.mapped_areas_pct"].detail.map((d) => d.label), ["site/src", "workers/bot/src"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads knip's report inside the areas, with entries, rc-file packages and the coverage provider it was told about", () => {
    assert.equal(value(result, "code.dead_files"), 1);
    assert.equal(value(result, "code.dead_exports"), 2);
    assert.deepEqual(result["code.dead_exports"].detail, [
      { label: "site/src/lib/math.ts: double", value: 1 },
      { label: "site/src/lib/math.ts: Grade", value: 1 },
    ], "each row names the file and the export (issue 779)");
    assert.equal(value(result, "code.dead_dependencies"), 1);
    assert.deepEqual(result["code.dead_dependencies"].detail, [{ label: "package.json left-pad", value: 1 }]);
    const knip = calls.find((c) => c.name === "knip");
    assert.ok(knip.config.workspaces["."].entry.includes("scripts/tool.mjs"), "a shebang file is an entry");
    assert.deepEqual(knip.config.ignoreDependencies, ["@secretlint/secretlint-rule-preset-recommend", "@vitest/coverage-v8"]);
  });

  it("runs the engine's own knip when the repo installs none, and says so only when neither exists", async () => {
    const dir = makeRepo();
    try {
      const seen = [];
      const report = readFileSync(join(FIXTURES, "knip.json"), "utf8");
      const engineOnly = { knip: async () => (seen.push(1) === 1 ? { code: null, missing: true, stdout: "", stderr: "", ms: 0 } : { code: 0, stdout: report, stderr: "", ms: 1 }) };
      const viaEngine = await collect({ root: dir, mode: "ci", run: stubRun([], engineOnly), params: FIXTURE });
      assert.equal(seen.length, 2, "the repo's knip is tried first, then the engine's");
      assert.equal(value(viaEngine, "code.dead_exports"), 2);
      const neither = await collect({ root: dir, mode: "ci", run: stubRun([], { knip: async () => ({ code: null, missing: true, stdout: "", stderr: "", ms: 0 }) }), params: FIXTURE });
      assert.match(neither["code.dead_files"].could_not_check, /knip is not installed in the repo or beside this engine/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a step whose metrics are all off, so a dropped metric costs no run", async () => {
    const dir = makeRepo();
    try {
      const calls = [];
      const targets = TARGETS.filter((t) => !t.id.startsWith("code.dead_") && !t.id.startsWith("code.worker_") && t.id !== "code.build_seconds");
      const got = await collect({ root: dir, mode: "ci", run: stubRun(calls), params: FIXTURE, targets });
      assert.ok(!calls.some((c) => c.name === "knip" || c.name === "wrangler"), "no knip or wrangler run");
      assert.equal(got["code.dead_files"], undefined);
      assert.equal(value(got, "code.long_files"), 1, "the steps that are on still run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves coverage to ci mode: no vitest run in local mode", () => {
    assert.match(result["code.test_coverage_pct"].could_not_check, /measured in ci mode only/);
    assert.ok(!calls.some((c) => c.name === "vitest"));
  });

  it("measures each Worker's dry-run bundle and never deploys", () => {
    assert.equal(value(result, "code.worker_bundle_kb"), Math.max(kb(SITE_BUNDLE), kb(BOT_BUNDLE)));
    assert.deepEqual(result["code.worker_bundle_kb"].detail, [
      { label: "site", value: kb(SITE_BUNDLE) },
      { label: "workers/bot", value: kb(BOT_BUNDLE) },
    ]);
    assert.equal(value(result, "code.build_seconds"), 2.4);
    const wrangler = calls.filter((c) => c.name === "wrangler");
    assert.equal(wrangler.length, 2);
    assert.ok(wrangler.every((c) => c.args[0] === "deploy" && c.args[1] === "--dry-run"));
    assert.deepEqual(calls.slice(0, 2).map((c) => c.name), ["wrangler", "wrangler"], "the timed step runs before the CPU-heavy ones");
    assert.ok(wrangler.every((c) => !c.args.includes("--assets")), "a built site/dist is bundled as it is");
  });

  it("counts each page's JS graph from site/dist, heaviest page first", () => {
    const [a, b, c] = ["a", "b", "c"].map((f) => gzipSync(readFileSync(join(root, `site/dist/_astro/${f}.js`))).length);
    const pageKb = (bytes) => Math.round((bytes / 1024) * 10) / 10;
    assert.equal(value(result, "code.client_js_kb"), pageKb(a + b + c));
    assert.deepEqual(result["code.client_js_kb"].detail, [
      { label: "/", value: pageKb(a + b + c) },
      { label: "/about/", value: pageKb(b) },
    ]);
  });

  it("measures a build newer than the newest site/ commit, and says it checked", () => {
    assert.match(result["code.client_js_kb"].source, new RegExp(`not older than the newest site/ commit \\(${SITE_COMMIT}\\)`));
    const git = calls.find((c) => c.name === "git" && c.args[1] === "-1");
    assert.deepEqual(git.args, ["log", "-1", "--format=%ct", "--", "site"]);
  });

  it("reads the slowest of each Worker's last requests from Workers Logs, never a percentile", () => {
    assert.equal(value(result, "code.worker_wall_max_ms"), 12);
    const sql = calls.filter((c) => c.name === "cf" && c.args[0] === "sql");
    for (const c of sql) {
      assert.match(c.args[2], /ORDER BY timestamp DESC LIMIT 100 FORMAT JSON$/);
      assert.doesNotMatch(c.args[2], /quantile|AVG|SUM/i, "no percentile, mean or sum over a window");
    }
  });

  it("reads the heaviest CPU of the last requests since each Worker's latest deploy, numbers only", () => {
    assert.equal(value(result, "code.worker_cpu_max_ms"), 46);
    const lists = calls.filter((c) => c.name === "cf" && c.args[0] === "workers" && c.args[1] === "deployments");
    assert.deepEqual(lists.map((c) => c.args), [
      ["workers", "deployments", "list", "--worker", "fixture-site", "--per-page", "1"],
      ["workers", "deployments", "list", "--worker", "fixture-bot", "--per-page", "1"],
    ]);
    const sql = calls.filter((c) => c.name === "cf" && c.args[0] === "sql");
    assert.equal(sql.length, 2);
    assert.deepEqual(sql[0].args.slice(-2), ["--scope-account", "0123456789abcdef0123456789abcdef"]);
    assert.match(sql[0].args[2], /timestamp >= '2026-11-02T23:51:36Z' AND scriptName IN \('fixture-site'\)/);
    assert.match(sql[1].args[2], /timestamp >= '2026-10-19T00:56:43Z' AND scriptName IN \('fixture-bot'\)/);
    for (const c of sql) assert.doesNotMatch(c.args[2], /\b(message|url|rayId)\b|INTERVAL/);
    assert.deepEqual(result["code.worker_cpu_max_ms"].detail, [
      { label: "fixture-site (last 3 requests, from 2026-11-03 09:58 UTC)", value: 46 },
      { label: "fixture-bot (last 1 requests, from 2026-11-03 08:00 UTC)", value: 9 },
    ]);
    assert.match(result["code.worker_cpu_max_ms"].source, /since that deploy/);
  });

  it("reads each Worker's startup time from its newest successful Workers Build, reads only", () => {
    assert.equal(value(result, "code.worker_startup_ms"), 33);
    assert.deepEqual(result["code.worker_startup_ms"].detail, [
      { label: "fixture-site (built 2026-11-03T20:00Z)", value: 33 },
      { label: "fixture-bot (built 2026-11-03T20:00Z)", value: 12 },
    ]);
    const logs = calls.filter((c) => c.name === "cf" && c.args[0] === "builds" && c.args[1] === "logs");
    assert.deepEqual(logs.map((c) => c.args), [
      ["builds", "logs", "get", "fixture-site-ok"],
      ["builds", "logs", "get", "fixture-bot-ok"],
    ], "the failed newer build is skipped");
    assert.ok(calls.filter((c) => c.name === "cf").every((c) => !["create", "update", "delete", "deploy", "upload"].some((w) => c.args.includes(w))), "nothing uploads or deploys");
  });

  it("returns exactly the metrics in quality/targets/code.json", () => {
    assert.deepEqual(Object.keys(result).sort(), TARGETS.map((t) => t.id).sort());
    for (const [id, r] of Object.entries(result)) {
      assert.equal(typeof r.source, "string", `${id} has a source`);
      if ("value" in r) assert.ok(!Number.isNaN(Date.parse(r.read_at)), `${id} has a read time`);
    }
  });
});

describe("targets/code.json", () => {
  it("gives every Code target a group, a plain means and a goal labeled as a goal", () => {
    for (const t of TARGETS) {
      assert.ok(typeof t.group === "string" && t.group.trim(), `${t.id} group`);
      assert.equal(typeof t.means, "string", `${t.id} means`);
      assert.ok(t.means.length <= 120, `${t.id} means over 120 characters`);
      assert.doesNotMatch(t.means, /\d/, `${t.id} means holds a figure`);
      assert.match(t.goal_source, /\bgoal\b/i, `${t.id} goal_source must label the goal as a goal`);
    }
  });

  it("names its basis: the code-line change is last N merged PRs with no spark, CPU time is since the latest deploy", () => {
    const by = Object.fromEntries(TARGETS.map((t) => [t.id, t]));
    assert.notEqual(by["code.loc_change_pct"].chart, "spark");
    assert.match(by["code.loc_change_pct"].source, /^last N merged PRs: .*N is params\.merged_prs, 20 by default/);
    assert.ok(by["code.loc_change_pct"].label.includes(`last ${PARAMS.merged_prs} PRs`), "the label names params.merged_prs");
    for (const id of ["code.worker_cpu_max_ms", "code.worker_wall_max_ms"]) assert.match(by[id].source, /^last N requests: .*since that deploy.*N is params\.last_requests/);
    for (const t of TARGETS) assert.match(t.source, /^(state|latest|last N merged PRs|last N requests): /, `${t.id} source names its basis`);
    assert.equal(PARAMS.last_requests, 100);
    assert.ok(TARGETS.every((t) => !/\b(7|14|28|30) days\b|last month|a week/.test(`${t.label} ${t.means}`)), "no calendar window in a label or meaning");
  });

  it("holds every repo-specific value as a param, with generic defaults", () => {
    assert.equal(TARGETS.filter((t) => t.params).length, 1, "one params block");
    assert.deepEqual(PARAMS.areas, ["src"]);
    assert.deepEqual(PARAMS.workers, []);
    assert.deepEqual(PARAMS.test_suites, []);
    assert.equal(PARAMS.main_branch, "", "the template names no branch: ci.json's default_branch, else HEAD");
    for (const k of ["complexity", "function_lines", "file_lines"]) assert.ok(PARAMS.limits[k] > 0, `limits.${k}`);
    const by = Object.fromEntries(TARGETS.map((t) => [t.id, t]));
    assert.ok(by["code.complex_functions"].label.endsWith(`complexity ${PARAMS.limits.complexity}`));
    assert.ok(by["code.long_functions"].label.includes(`${PARAMS.limits.function_lines} lines`));
    assert.ok(by["code.long_files"].label.includes(`${PARAMS.limits.file_lines} lines`));
    for (const gone of ["code.tests_in_test_folders_pct", "code.stray_root_files", "code.crowded_folders"]) {
      assert.equal(by[gone], undefined, `${gone} left the template (v3.0.0)`);
    }
    for (const r of PARAMS.naming) {
      assert.doesNotThrow(() => new RegExp(r.path), r.rule);
      assert.ok(r.cases.length && r.cases.every((c) => c in CASES), `${r.rule} cases`);
    }
  });

  it("code.mjs names no repo path, so any repo can run it unchanged", () => {
    for (const file of ["code.mjs", "complexity.mjs", "shape.mjs"]) {
      const src = readFileSync(join(here, file), "utf8");
      for (const p of ["site/", "workers/", "scripts/", "styleguide"]) {
        assert.ok(!src.includes(p), `${file} names ${p}; move it to a param in quality/targets/code.json`);
      }
    }
  });
});

describe("line and branch coverage in ci mode", () => {
  let root;
  let result;
  const calls = [];

  before(async () => {
    root = makeRepo();
    result = await collect({ root, mode: "ci", run: stubRun(calls), params: FIXTURE });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("sums covered lines and branches across suites, as SonarQube counts coverage, never averaging percentages", () => {
    // By hand: lines 170 + 45 + 45 = 260 of 300; branches 30 + 8 + 12 = 50 of
    // 70; together (260 + 50) / (300 + 70) = 310 / 370 = 83.8%. Lines alone
    // would read 86.7%.
    assert.equal(value(result, "code.test_coverage_pct"), 83.8);
    assert.deepEqual(result["code.test_coverage_pct"].detail, [
      { label: "site/src lines", value: 85 },
      { label: "site/src branches", value: 75 },
      { label: "site/worker lines", value: 90 },
      { label: "site/worker branches", value: 80 },
      { label: "workers/bot/src lines", value: 90 },
      { label: "workers/bot/src branches", value: 60 },
    ]);
    assert.match(result["code.test_coverage_pct"].source, /lines and branches together: 260 of 300 lines and 50 of 70 branches covered in site\/src, site\/worker, workers\/bot\/src$/);
    const target = TARGETS.find((t) => t.id === "code.test_coverage_pct");
    assert.ok(meets(target, value(result, "code.test_coverage_pct")), "meets the goal");
  });

  it("asks vitest for v8 line coverage over each suite's source, written outside the repo", () => {
    const [site, bot] = calls.filter((c) => c.name === "vitest").map((c) => c.args);
    for (const args of [site, bot]) {
      for (const flag of ["--coverage.enabled", "--coverage.provider=v8", "--coverage.reporter=json-summary", "--coverage.reportOnFailure"]) {
        assert.ok(args.includes(flag), `${flag} in ${args.join(" ")}`);
      }
      const dir = args.find((a) => a.startsWith("--coverage.reportsDirectory=")).split("=")[1];
      assert.ok(!dir.startsWith(root), "coverage goes to a scratch folder");
    }
    const globs = (args) => args.filter((a) => a.startsWith("--coverage.include=")).map((a) => a.split("=")[1]);
    assert.deepEqual(globs(site), ["src/**/*.{ts,mjs}", "worker/**/*.ts"]);
    assert.deepEqual(globs(bot), ["src/**/*.ts"]);
  });
});

describe("modes", () => {
  it("a Worker with no successful Workers Build, or a log without the startup line, is could_not_check", async () => {
    const root = makeRepo();
    try {
      const failed = async (args, opts) =>
        args[0] === "builds" && args[1] === "list" ? { code: 0, stdout: '[{"build_uuid":"x","build_outcome":"failure"}]', stderr: "", ms: 1 } : stubRun([])("cf", args, opts);
      let result = await collect({ root, mode: "local", run: stubRun([], { cf: failed }), params: FIXTURE });
      assert.match(result["code.worker_startup_ms"].could_not_check, /no successful Workers Build among its last 10/);
      const silent = async (args, opts) =>
        args[0] === "builds" && args[1] === "logs" ? { code: 0, stdout: '{"lines":[[1,"Success: Build command completed"]]}', stderr: "", ms: 1 } : stubRun([])("cf", args, opts);
      result = await collect({ root, mode: "local", run: stubRun([], { cf: silent }), params: FIXTURE });
      assert.match(result["code.worker_startup_ms"].could_not_check, /logged no Worker Startup Time/);
      // A failed logs call names the cf failure, not a missing line.
      const denied = async (args, opts) =>
        args[0] === "builds" && args[1] === "logs" ? { code: 1, stdout: "", stderr: "Authentication error [code: 10000]\n", ms: 1 } : stubRun([])("cf", args, opts);
      result = await collect({ root, mode: "local", run: stubRun([], { cf: denied }), params: FIXTURE });
      assert.match(result["code.worker_startup_ms"].could_not_check, /cf builds logs get failed for fixture-site \(Authentication error \[code: 10000\]\)/);
      // A [WARNING] line before cf's JSON is skipped.
      const warned = async (args, opts) => {
        const got = await stubRun([])("cf", args, opts);
        return args[0] === "workers" && args[1] === "get" ? { ...got, stdout: `[WARNING] a newer cf is available\n${got.stdout}` } : got;
      };
      result = await collect({ root, mode: "local", run: stubRun([], { cf: warned }), params: FIXTURE });
      assert.equal(value(result, "code.worker_startup_ms"), 33);
      result = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.match(result["code.worker_startup_ms"].could_not_check, /local mode only/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ci mode skips Cloudflare", async () => {
    const root = makeRepo();
    const calls = [];
    try {
      const result = await collect({ root, mode: "ci", run: stubRun(calls), params: FIXTURE });
      assert.match(result["code.worker_cpu_max_ms"].could_not_check, /local mode only/);
      assert.ok(!calls.some((c) => c.name === "cf"));
      assert.equal(value(result, "code.test_coverage_pct"), 83.8);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("helpers", () => {
  it("reads the latest deploy time from cf's deployment list, or null", () => {
    assert.equal(latestDeploy('{"deployments":[{"created_on":"2026-11-02T23:51:35.035758Z"},{"created_on":"2026-11-03T00:00:00Z"}]}'), "2026-11-02T23:51:36Z");
    assert.equal(latestDeploy('[{"created_on":"2026-11-02T23:51:35Z"}]'), "2026-11-02T23:51:35Z");
    assert.equal(latestDeploy('{"deployments":[]}'), null);
    assert.equal(latestDeploy("not json"), null);
  });

  it("measures a nested function on its own", () => {
    const f = analyzeFile("x.ts", "function outer(a, b, c) {\n  if (a) {}\n  const inner = () => {\n    if (b) {}\n    if (c) {}\n  };\n}\n");
    assert.deepEqual(
      f.functions.map((fn) => [fn.name, fn.complexity]),
      [["outer", 2], ["inner", 3]],
    );
  });

  it("reads an .astro script whose tags differ in case or carry a space", () => {
    const f = analyzeFile("A.astro", "<p/>\n<SCRIPT>\nfunction f(a) {\n  if (a) {}\n}\n</script >\n");
    assert.deepEqual(f.functions.map((fn) => [fn.name, fn.complexity]), [["f", 2]]);
  });

  it("counts a header comment only when it ends right above the export", () => {
    const f = analyzeFile("x.ts", "// File header.\n\nexport function a() {}\n// Says what b does.\nexport function b() {}\n");
    assert.deepEqual(f.exports.map((e) => [e.name, e.documented]), [["a", false], ["b", true]]);
  });

  it("does not read // inside strings, templates or regexes as a comment", () => {
    const f = analyzeFile("x.ts", "const u = `https://x.y/${p}`;\nconst re = /\\/\\//;\nconst s = '// no';\n");
    assert.equal(f.comments.length, 0);
    assert.equal(f.codeLines, 3);
  });

  it("counts every later copy of a 5-line, 50-token run, and names the original", () => {
    const block = [
      "const total = items.reduce((sum, item) => sum + item.price * item.count, 0);",
      "const tax = Math.round(total * rate * 100) / 100;",
      "const shipping = total > threshold ? 0 : flatRate;",
      "const grand = total + tax + shipping;",
      "return { total, tax, shipping, grand };",
      "}",
    ];
    const file = (path, lines) => ({ path, code: lines.map((text, i) => ({ line: i + 1, text })) });
    const short = Array.from({ length: 12 }, () => "n += 1;");
    const { copied, blocks } = duplicates([file("a.ts", ["function a() {", ...block]), file("b.ts", ["x();", ...block]), file("c.ts", short)]);
    assert.equal(copied, 5, "the window ending at the brace holds under 50 tokens, and short repeats never count");
    assert.deepEqual(blocks, [{ path: "b.ts", line: 2, lines: 5, of: { path: "a.ts", i: 1, line: 2 } }]);
  });

  it("names each kind of code file by the convention its folder uses", () => {
    assert.equal(namingRule("site/src/components/ui/SiteFooter.astro", PARAMS.naming).ok, true);
    assert.equal(namingRule("site/src/components/ui/site-footer.astro", PARAMS.naming).ok, false);
    assert.equal(namingRule("site/src/pages/seats/[seat].astro", PARAMS.naming).ok, true);
    assert.equal(namingRule("site/src/pages/rss.xml.ts", PARAMS.naming).ok, true);
    assert.equal(namingRule("tools/content_lint.py", PARAMS.naming).ok, true);
    assert.equal(namingRule("tools/content-lint.py", PARAMS.naming).ok, false);
    assert.equal(namingRule("site/src/lib/content.config.ts", PARAMS.naming).ok, true);
    assert.equal(namingRule("site/src/lib/siteConfig.ts", PARAMS.naming).rule, "kebab-case modules");
  });

  it("names a folder by its own name, under the rule its path matches", () => {
    assert.deepEqual(namingRule("site/src/pages/", PARAMS.naming), { rule: "kebab-case pages", ok: true });
    assert.deepEqual(namingRule("site/src/pages/[seat]/", PARAMS.naming), { rule: "kebab-case pages", ok: true });
    assert.deepEqual(namingRule("site/src/lib/date-utils/", PARAMS.naming), { rule: "kebab-case modules", ok: true });
    assert.equal(namingRule("site/src/lib/Date_Utils/", PARAMS.naming).ok, false);
    assert.equal(namingRule("tools/tests/", [{ rule: "snake_case tools", path: "^tools/", cases: ["snake"] }]).ok, true);
  });

  it("reads a Python docstring as a comment, and a string that is assigned, passed or keyed as code", () => {
    const py = [
      "#!/usr/bin/env python3",
      '"""Checks the content rules.',
      "",
      'Two lines of purpose."""',
      "import sys",
      'USAGE = """not a docstring"""',
      "def run(a):  # a trailing note",
      '    """Says what run does."""',
      '    table = {"key":',
      '        """a value"""}',
      "    return call(",
      '        """an argument""")',
      "class Tool:",
      "    '''Says what Tool is.'''",
      "    def go(self):",
      '        r"""Says what go does."""',
      "        return \"it's done\"",
      "",
    ].join("\n");
    const f = analyzeFile("tool.py", py);
    assert.deepEqual(f.code.map((c) => c.line), [5, 6, 7, 9, 10, 11, 12, 13, 15, 17]);
    assert.equal(f.codeLines, 10);
    assert.equal(f.purpose, true);
    assert.equal(analyzeFile("tool.sh", '#!/bin/sh\n"""not Python"""\necho hi\n').codeLines, 2, "only .py has docstrings");
    // A name JavaScript objects also carry must not disturb the bracket depth: the docstring after it still reads as a comment.
    const named = analyzeFile("names.py", 'constructor = toString = valueOf = 1\ndef hasOwnProperty():\n    """Says what it does."""\n    return constructor\n');
    assert.deepEqual(named.code.map((c) => c.line), [1, 2, 4]);
  });

  it("finds the purpose comment past a shebang, a directive or an .astro fence", () => {
    const purpose = (path, text) => analyzeFile(path, text).purpose;
    assert.equal(purpose("a.mjs", "#!/usr/bin/env node\n// Prints the site's routes.\nrun();\n"), true);
    assert.equal(purpose("a.mjs", "// @ts-check\n// Sitemap dates from each page's data.\nrun();\n"), true);
    assert.equal(purpose("a.ts", "// @ts-nocheck\nrun();\n"), false);
    assert.equal(purpose("a.ts", 'import { z } from "zod";\n// Comes too late to open the file.\n'), false);
    assert.equal(purpose("A.astro", "---\n// A card with a title.\nconst x = 1;\n---\n<p/>\n"), true);
    assert.equal(purpose("a.py", '"""Checks the site\'s content rules."""\nimport sys\n'), true);
    assert.equal(purpose("a.css", "/* Base styles. */\nbody {}\n"), false);
  });

  it("tells commented-out code from prose", () => {
    assert.equal(looksLikeCode("const a = 1;\nif (a) {\n  run(a);\n}"), true);
    assert.equal(looksLikeCode("Exact match, with or without a trailing slash.\nSee the route table."), false);
    assert.equal(looksLikeCode("TODO"), false);
  });

  it("naming skips params.skip_dirs and judges only the files a rule covers", async () => {
    const root = makeRepo();
    try {
      const tracked = ["site/src/lib/good-name.ts", "site/src/lib/badName.ts", "site/src/fixtures/repo/otherBad.ts", "site/src/lib/style.css"];
      const ls = async (args) => (args[0] === "ls-files" ? { code: 0, stdout: tracked.join("\0"), stderr: "", ms: 1 } : { code: 0, stdout: "false\n", stderr: "", ms: 1 });
      const params = { ...FIXTURE, naming: [{ rule: "kebab-case modules", path: "\\.ts$", cases: ["kebab"] }] };
      const result = await collect({ root, mode: "ci", run: stubRun([], { git: ls }), params });
      // The fixture folder is skipped; style.css has no rule, so 1 of 2 .ts files: 50%, not 1 of 3.
      assert.equal(value(result, "code.naming_pct"), 50);
      assert.match(result["code.naming_pct"].source, /1 of 2$/);
      assert.ok(!result["code.naming_pct"].detail.some((d) => d.label.includes("fixtures")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts a Python module's public functions as shared: a docstring or a comment above says what one does", async () => {
    const root = makeRepo();
    try {
      writeFileSync(join(root, "tools/api.py"), [
        '"""Written by code.test.mjs: four public functions, one private, one method."""',
        "def with_doc():",
        '    """Says what it does."""',
        "    return 1",
        "",
        "# Says what it does, right above.",
        "def with_comment():",
        "    return 2",
        "",
        "# A comment with a blank line after it does not count.",
        "",
        "def bare():",
        "    return 3",
        "",
        "# Says what the decorated one does.",
        "@staticmethod",
        "def decorated():",
        "    return 4",
        "",
        "def _private():",
        "    return 5",
        "",
        "class Tool:",
        "    def method(self):",
        "        return 6",
        "",
      ].join("\n"));
      const python = { python3: (args, opts) => runCommand("python3", args, opts) };
      const result = await collect({ root, mode: "ci", run: stubRun([], python), params: FIXTURE });
      // tools/check.py's main() has neither: 3 of 5 in tools, beside the 7 exports of the fixture.
      assert.equal(result["code.export_comments_pct"].detail.find((d) => d.label === "tools").value, 60);
      assert.match(result["code.export_comments_pct"].source, /Python's ast over 2 of 2 \.py file\(s\); 8 of 12$/);
      const without = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.ok(!without["code.export_comments_pct"].detail.some((d) => d.label === "tools"), "without python3 only JavaScript counts");
      assert.match(without["code.export_comments_pct"].source, /Python not read: python3 is not on PATH\); 5 of 7$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts a Python function nothing names as unused; a test's call, a string name and a method all spare it", async () => {
    const root = makeRepo();
    try {
      writeFileSync(join(root, "tools/lib.py"), [
        '"""Written by code.test.mjs: five functions and a method."""',
        "def used_here():",
        "    return 1",
        "def only_a_test_calls():",
        "    return 2",
        "def named_as_a_string():",
        "    return 3",
        "def nothing_names_this():",
        "    return 4",
        "def asked_for_as_a_parameter():",
        "    return 5",
        "def named_in_an_entry_point():",
        "    return 6",
        "class Tool:",
        "    def method_nobody_calls(self):",
        "        return used_here()",
        'HANDLERS = {"go": "named_as_a_string"}',
        "",
      ].join("\n"));
      mkdirSync(join(root, "tools/tests"), { recursive: true });
      // A pytest fixture is asked for by parameter name; an entry point is named as module:function.
      writeFileSync(join(root, "tools/tests/test_lib.py"), 'import lib\nassert lib.only_a_test_calls() == 2\ndef test_it(asked_for_as_a_parameter):\n    pass\nENTRY = "lib:named_in_an_entry_point"\n');
      // A folder the config skips is not read, tests or not.
      mkdirSync(join(root, "tools/vendor"), { recursive: true });
      writeFileSync(join(root, "tools/vendor/uses.py"), "nothing_names_this()\n");
      const python = { python3: (args, opts) => runCommand("python3", args, opts) };
      const got = await collect({ root, mode: "ci", run: stubRun([], python), params: FIXTURE });
      assert.equal(value(got, "code.dead_functions"), 1);
      assert.deepEqual(got["code.dead_functions"].detail, [
        { label: "tools/lib.py:8 nothing_names_this", value: 1 },
        { label: "tools", value: 1 },
      ]);
      const without = await collect({ root, mode: "ci", run: stubRun([]), params: FIXTURE });
      assert.match(without["code.dead_functions"].could_not_check, /Python not read: python3 is not on PATH/);
      assert.ok(!("value" in without["code.dead_functions"]), "an unread file is never 0 unused functions");
      // One file that does not parse could be the only caller: the count is not trusted.
      writeFileSync(join(root, "tools/broken.py"), "def (:\n");
      const broken = await collect({ root, mode: "ci", run: stubRun([], python), params: FIXTURE });
      assert.match(broken["code.dead_functions"].could_not_check, /Python not parsed: tools\/broken\.py SyntaxError/);
      assert.ok(!("value" in broken["code.dead_functions"]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts Python functions with Python's ast: long, complex, nested, and code lines only", async () => {
    const root = makeRepo();
    try {
      const branches = Array.from({ length: 10 }, (_, i) => `    if x == ${i}:\n        y = ${i}`).join("\n");
      const body = Array.from({ length: 51 }, (_, i) => `    z${i} = ${i}`).join("\n");
      writeFileSync(join(root, "tools/big.py"), [
        '"""Written by code.test.mjs: one complex function and one long one."""',
        "class Tool:",
        "    def branchy(self, x):",
        branches.replace(/^/gm, "    "),
        "        return [v for v in x if v and x]",
        "",
        "def long():",
        "    # a comment never counts",
        "",
        body,
        "    def inner():",
        "        return 1",
        "    return inner",
        "",
      ].join("\n"));
      writeFileSync(join(root, "tools/broken.py"), "# Written by code.test.mjs: does not parse.\ndef (:\n");
      const python = { python3: (args, opts) => runCommand("python3", args, opts) };
      const result = await collect({ root, mode: "ci", run: stubRun([], python), params: FIXTURE });
      const where = (id) => result[id].detail.map((d) => d.label);
      // 1 + ten ifs + the comprehension's for and if + one and = 14.
      assert.ok(where("code.complex_functions").includes("tools/big.py:3 Tool.branchy"));
      assert.equal(result["code.complex_functions"].detail.find((d) => d.label.endsWith("Tool.branchy")).value, 14);
      // def line, 51 assignments, inner's 2 lines and the return: 55; the comment and blank do not count.
      assert.equal(result["code.long_functions"].detail.find((d) => d.label === "tools/big.py:26 long").value, 55);
      assert.ok(!where("code.long_functions").some((l) => l.endsWith("long.inner")), "inner is short on its own");
      assert.match(result["code.long_functions"].source, /Python's ast over 2 of 3 \.py file\(s\); not parsed: tools\/broken\.py SyntaxError line 2/);
      const without = await collect({ root, mode: "ci", run: stubRun([], { python3: async () => ({ code: null, missing: true, stdout: "", stderr: "" }) }), params: FIXTURE });
      // A file limit reads Python too: the class and its def, 10 branch pairs and a return, then long()'s 55: 78 code lines; the docstring is not one.
      const tight = await collect({ root, mode: "ci", run: stubRun([], python), params: { ...FIXTURE, limits: { ...FIXTURE.limits, file_lines: 70 } } });
      assert.deepEqual(tight["code.long_files"].detail.find((d) => d.label === "tools/big.py"), { label: "tools/big.py", value: 78, unit: "lines" });
      assert.match(tight["code.long_files"].source, /\.css, \.py and \.sh files over 70 code lines/);
      assert.match(without["code.complex_functions"].source, /Python not read: python3 is not on PATH/);
      assert.ok(!without["code.long_functions"].detail.some((d) => d.label.startsWith("tools/big.py")), "TypeScript count stands");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
