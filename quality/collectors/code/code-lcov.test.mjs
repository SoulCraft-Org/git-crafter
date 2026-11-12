// node:test coverage read from an lcov block in a CI job log (code-lcov.mjs, code-test.mjs).
// Run with: node --test quality/collectors/code/code-lcov.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { LCOV_BEGIN, LCOV_END, lcovBlock, lcovCoverage, lcovFromLog, parseLcov } from "./code-lcov.mjs";
import { testCoverage } from "./code-test.mjs";

// A small lcov as node --test --test-reporter=lcov writes it. Under quality/ and
// config/quality/collectors: 95 of 110 lines and 15 of 20 branches, 84.6%
// together. The test file and pages/ fall outside the Quality suite.
const LCOV = `TN:
SF:quality/a.mjs
FN:1,f
FNDA:1,f
FNF:1
FNH:1
BRDA:1,0,0,1
BRF:20
BRH:15
DA:1,1
LH:90
LF:100
end_of_record
TN:
SF:quality/a.test.mjs
LH:50
LF:50
end_of_record
TN:
SF:pages/p.mjs
BRF:10
BRH:5
LH:20
LF:40
end_of_record
TN:
SF:./config/quality/collectors/c.mjs
BRF:0
BRH:0
LH:5
LF:10
end_of_record
`;
const QUALITY = { label: "Quality", runner: "node", workflow: "verify.yml", job: "short", cover: ["quality", "config/quality/collectors"] };
const REPO = "acme/app";

// A job log as GitHub serves it: each line behind a timestamp.
const stamp = (text) => text.split("\n").map((l) => `2026-11-10T12:00:00.0000000Z ${l}`).join("\n");

// A gh stub: one verify.yml run on main whose short job printed `log`.
function stubGh(log, { conclusion = "success" } = {}) {
  const calls = [];
  const run = { id: 7, node_id: "WFR_7", head_branch: "main", status: "completed", conclusion, created_at: "2026-11-10T12:00:00Z" };
  return {
    calls,
    rest: async (route) => {
      calls.push(route);
      if (route === `repos/${REPO}/actions/workflows/verify.yml`) return { id: 11, name: "verify" };
      if (route.startsWith(`repos/${REPO}/actions/workflows/11/runs`)) return { workflow_runs: [run] };
      throw new Error(`unexpected route ${route}`);
    },
    graphql: async () => ({ nodes: [{ databaseId: 7, checkSuite: { checkRuns: { nodes: [{ databaseId: 70, name: "ci / short", conclusion: "SUCCESS" }] } } }] }),
    text: async (route) => {
      calls.push(route);
      return log;
    },
  };
}

describe("the lcov reader", () => {
  it("parses each record's line and branch counts, branches null where the record has none", () => {
    const files = parseLcov(LCOV);
    assert.deepEqual(files.map((f) => f.file), ["quality/a.mjs", "quality/a.test.mjs", "pages/p.mjs", "config/quality/collectors/c.mjs"]);
    assert.deepEqual(files[0], { file: "quality/a.mjs", lines: { covered: 90, total: 100 }, branches: { covered: 15, total: 20 } });
    assert.equal(files[1].branches, null);
  });

  it("a block printed to a timestamped log reads back, without the per-line rows", () => {
    const block = lcovBlock("Quality", LCOV);
    assert.ok(block.startsWith(`${LCOV_BEGIN}Quality\n`) && block.trimEnd().endsWith(LCOV_END));
    assert.doesNotMatch(block, /^(DA|BRDA|FN|FNDA|TN):/m, "only summary lines");
    const log = stamp(`== quality\nok 1 - x\n${lcovBlock("Pages", "SF:pages/p.mjs\nLH:1\nLF:2\nend_of_record\n")}${block}== verify`);
    assert.deepEqual(parseLcov(lcovFromLog(log, "Quality")), parseLcov(LCOV));
    assert.equal(parseLcov(lcovFromLog(log, "Pages"))[0].lines.total, 2);
    assert.equal(lcovFromLog(log, "Other"), null);
  });

  it("sums the files under the cover folders, tests left out, per folder too", () => {
    const c = lcovCoverage(LCOV, QUALITY);
    assert.deepEqual(c.lines, { covered: 95, total: 110 });
    assert.deepEqual(c.branches, { covered: 15, total: 20 });
    assert.deepEqual(c.roots["config/quality/collectors"].lines, { covered: 5, total: 10 });
    assert.match(lcovCoverage(LCOV, { label: "None", cover: ["tools"] }), /None: the lcov counted no line under tools/);
  });

  it("the CLI prints the block for a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lcov-cli-"));
    try {
      writeFileSync(join(dir, "q.lcov"), LCOV);
      const cli = fileURLToPath(new URL("./code-lcov.mjs", import.meta.url));
      const r = spawnSync(process.execPath, [cli, "Quality", join(dir, "q.lcov")], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, lcovBlock("Quality", LCOV));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("code.test_coverage_pct from a node suite", () => {
  it("reads the block in the newest successful run's job log and scores lines and branches together", async () => {
    const gh = stubGh(stamp(lcovBlock("Quality", LCOV)));
    const result = await testCoverage("/nowhere", false, null, [QUALITY], { client: () => gh, repo: REPO, branch: "main" });
    const r = result["code.test_coverage_pct"];
    assert.equal(r.value, 84.6);
    assert.match(r.source, /^node --test --experimental-test-coverage lcov printed by verify\.yml job short, run 7 \(2026-11-10\), lines and branches together: 95 of 110 lines and 15 of 20 branches covered/);
    assert.ok(gh.calls.includes(`repos/${REPO}/actions/jobs/70/logs`));
  });

  it("is could_not_check, naming why, without a block, a successful run or a repo", async () => {
    const read = async (gh, repo = REPO) => (await testCoverage("/nowhere", false, null, [QUALITY], { client: () => gh, repo, branch: "main" }))["code.test_coverage_pct"];
    assert.match((await read(stubGh(stamp("no block")))).could_not_check, /Quality: the log of verify\.yml run 7 has no lcov block for Quality/);
    assert.match((await read(stubGh("", { conclusion: "failure" }))).could_not_check, /no successful run of verify\.yml on main/);
    assert.match((await read(stubGh(""), "")).could_not_check, /no repo/);
  });
});
