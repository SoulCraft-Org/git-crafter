// node:test coverage for the Code collector (code-test.mjs). A suite run with
// node --test --experimental-test-coverage --test-reporter=lcov writes an lcov
// file; its CI step then prints the file's summary lines to the job log
// between two marker lines, so the collector reads the coverage of the run CI
// already made and runs no suite itself:
//
//   node quality/collectors/code/code-lcov.mjs <suite label> <lcov file>
//
// The block stays valid lcov: SF, LF, LH, BRF, BRH and end_of_record per
// file, with the per-line DA and BRDA rows dropped to keep the log small.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The line that opens a suite's block, followed by its label.
export const LCOV_BEGIN = "== lcov ";
// The line that closes a block.
export const LCOV_END = "== end lcov";
const KEEP = /^(SF:|LF:|LH:|BRF:|BRH:|end_of_record$)/;
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z /;
const TEST_FILE = /\.test\.[cm]?[jt]s$/;

// Per-file counts of an lcov text: { file, lines, branches }, each count
// { covered, total }. A record without LF and LH is skipped; branches is null
// when the record has no BRF and BRH.
export function parseLcov(text) {
  const out = [];
  let rec = null;
  for (const line of String(text).split(/\r?\n/).map((l) => l.trim())) {
    if (line.startsWith("SF:")) rec = { file: line.slice(3) };
    else if (line === "end_of_record") {
      if (rec) out.push(rec);
      rec = null;
    } else if (rec && /^(LF|LH|BRF|BRH):\d+$/.test(line)) {
      const [key, n] = line.split(":");
      rec[key] = Number(n);
    }
  }
  const pair = (covered, total) => (Number.isFinite(covered) && Number.isFinite(total) ? { covered, total } : null);
  return out
    .map((r) => ({ file: r.file.replace(/^\.\//, ""), lines: pair(r.LH, r.LF), branches: pair(r.BRH, r.BRF) }))
    .filter((r) => r.lines);
}

// One suite's block for the job log: its label and the lcov's summary lines.
export function lcovBlock(label, text) {
  const kept = String(text).split(/\r?\n/).filter((l) => KEEP.test(l.trim()));
  return [`${LCOV_BEGIN}${label}`, ...kept, LCOV_END, ""].join("\n");
}

// The lcov text of the block a job log holds for one suite label, without
// GitHub's timestamp prefix; null when the log has no such block.
export function lcovFromLog(log, label) {
  const lines = String(log).split(/\r?\n/).map((l) => l.replace(STAMP, "").trim());
  const start = lines.indexOf(`${LCOV_BEGIN}${label}`);
  if (start < 0) return null;
  const end = lines.indexOf(LCOV_END, start);
  return end < 0 ? null : lines.slice(start + 1, end).join("\n");
}

// One suite's coverage from its lcov, in readCoverage's shape: lines and
// branches summed over the files under the suite's cover folders (a list, or
// the keys of a vitest-style cover map), tests left out, and the same two per
// folder. Returns a reason string when no line under them was counted.
export function lcovCoverage(text, suite) {
  const roots = coverFolders(suite);
  const all = counts();
  const per = Object.fromEntries(roots.map((r) => [r, counts()]));
  let noBranches = false;
  for (const f of parseLcov(text)) {
    const root = roots.find((r) => f.file.startsWith(r + "/"));
    if (!root || TEST_FILE.test(f.file)) continue;
    tally(all, f);
    tally(per[root], f);
    noBranches ||= !f.branches;
  }
  if (!all.lines.total) return `${suite.label}: the lcov counted no line under ${roots.join(", ")}`;
  const note = noBranches ? "reported no branch data" : null;
  return { lines: all.lines, branches: note ? null : all.branches, branchNote: note, roots: per };
}

// A suite's cover folders: a list, or the keys of a vitest-style cover map.
const coverFolders = (suite) => (Array.isArray(suite.cover) ? suite.cover : Object.keys(suite.cover ?? {}));

// Empty line and branch counts.
const counts = () => ({ lines: { covered: 0, total: 0 }, branches: { covered: 0, total: 0 } });

// Adds one file's lines, and its branches when it has them, into counts.
function tally(into, f) {
  for (const key of ["lines", "branches"]) {
    if (!f[key]) continue;
    into[key].covered += f[key].covered;
    into[key].total += f[key].total;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [label, file] = process.argv.slice(2);
  if (!label || !file) {
    process.stderr.write("usage: node code-lcov.mjs <suite label> <lcov file>\n");
    process.exit(2);
  }
  process.stdout.write(lcovBlock(label, readFileSync(file, "utf8")));
}
