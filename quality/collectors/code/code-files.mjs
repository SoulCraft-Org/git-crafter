// The Code collector's file metrics: size, complexity, duplication, comments
// and change since main (code.mjs).

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { analyzeFile } from "./complexity.mjs";
import { pythonFunctions } from "./code-python.mjs";
import { DUPLICATE, duplicates } from "./shape.mjs";
import { areaOf, countBy, countsAsCode, firstLine, isDir, measured, nestedIn, round, share, sum, top, unknown, unknownAll, walk } from "./code-util.mjs";
import { missingRefs } from "./code-structure.mjs";
import { importCycles } from "./code-cycles.mjs";

const GENERATED = /\bgenerated\b[^\n]*\bdo not edit\b/i;
const DRIFT_MARKER = /\b(TODO|FIXME|XXX)\b/g;
// The skip folders that hold tests: their Python counts as a user of the code.
const TEST_DIRS = new Set(["test", "tests", "__tests__", "fixtures"]);
// The files the file-length limit reads: every code file, stylesheets included.
const SIZED = /\.(astro|css|[cm]?[jt]sx?|py|sh)$/;

// ---- Quality: the files themselves ----

// code.loc is gone: a line cap could only be met by deleting working
// features; dead and copied code have their own goals.
export const STATIC_IDS = [
  "code.loc_change_pct",
  "code.duplicated_pct",
  "code.purpose_comments_pct",
  "code.complex_functions",
  "code.long_functions",
  "code.long_files",
  "code.export_comments_pct",
  "code.drift_markers",
  "code.commented_code",
  "code.missing_refs",
  "code.import_cycles",
  "code.dead_functions",
];

// The Code metrics read from the files in the areas: size, complexity, comments, duplication and change.
export async function staticMetrics(root, run, p) {
  const { areas, skip, limits, mainRefs, mergedPrs } = p;
  const source = "files under " + areas.join(", ");
  if (!areas.length) return unknownAll(STATIC_IDS, "params.areas names no code folder", "params.areas");
  const missing = areas.filter((a) => !isDir(join(root, a)));
  if (missing.length) {
    return unknownAll(STATIC_IDS, `area not found: ${missing.join(", ")}; update params.areas in quality/targets/code.json`, source);
  }
  const files = readCodeFiles(root, areas, skip);
  const typed = files.filter((f) => /\.(astro|[cm]?[jt]sx?)$/.test(f.path));
  const py = await pythonFunctions(files.filter((f) => f.path.endsWith(".py")), run, pythonTests(root, areas, files, skip));
  const facts = {
    files,
    typed,
    py,
    fns: [...typed, ...py.files].flatMap((f) => f.functions.map((fn) => ({ ...fn, where: `${f.path}:${fn.line} ${fn.name}` }))),
    loc: sum(files, "codeLines"),
  };
  return {
    "code.loc_change_pct": await locChange(root, files, facts.loc, run, { areas, skip, mainRefs, mergedPrs }),
    "code.duplicated_pct": duplicationMetric(facts, source),
    ...commentMetrics(facts, areas),
    ...sizeMetrics(facts, limits),
    ...driftMetrics(facts),
    "code.missing_refs": await missingRefs(root, files, run),
    "code.import_cycles": importCycles(files),
    "code.dead_functions": deadFunctionsMetric(py, areas),
  };
}

// Every code file in the areas that is not a test or generated, with its facts.
function readCodeFiles(root, areas, skip) {
  const files = [];
  for (const a of areas) {
    for (const abs of walk(join(root, a), skip, nestedIn(root, a, areas))) {
      const path = relative(root, abs).split(sep).join("/");
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)) continue;
      const text = readFileSync(abs, "utf8");
      if (GENERATED.test(text.slice(0, 400))) continue;
      const facts = analyzeFile(path, text);
      if (facts) files.push({ path, area: a, ...facts, ...(path.endsWith(".py") ? { text } : {}) });
    }
  }
  return files;
}

// The .py files in the areas that are not measured as code: tests and
// fixtures. Their names count as uses, so a function only a test calls is used.
function pythonTests(root, areas, files, skip) {
  const known = new Set(files.map((f) => f.path));
  // The configured skip folders still hold: only the test folders are let back in.
  const skipped = new Set([...skip].filter((dir) => !TEST_DIRS.has(dir)));
  const tests = [];
  for (const a of areas) {
    for (const abs of walk(join(root, a), skipped, nestedIn(root, a, areas))) {
      const path = relative(root, abs).split(sep).join("/");
      if (path.endsWith(".py") && !known.has(path)) tests.push({ path, text: readFileSync(abs, "utf8") });
    }
  }
  return tests;
}

// Unused Python functions per area, or could_not_check when python3 did not read them.
function deadFunctionsMetric(py, areas) {
  const source = "top-level functions of .py files that no .py file in the areas, tests included, reads, imports or names" + py.how;
  if (!py.dead) return unknown(`Python ${py.why.startsWith("not parsed") ? py.why : `not read: ${py.why}`}`, source);
  const detail = [...top(py.dead, (d) => ({ label: d.where, value: 1 }), 10), ...areas.map((a) => ({ label: a, value: py.dead.filter((d) => d.area === a).length })).filter((d) => d.value)];
  return measured(py.dead.length, source, detail);
}

function duplicationMetric({ files, loc }, source) {
  if (!loc) return unknown("no code lines in the areas to compare", source);
  const copies = duplicates([...files].sort((a, b) => (a.path < b.path ? -1 : 1)));
  return measured(
    round((100 * copies.copied) / loc, 1),
    `runs of ${DUPLICATE.minLines}+ code lines and ${DUPLICATE.minTokens}+ tokens seen earlier in the areas (jscpd's defaults); ` +
      `${copies.copied} of ${loc} code lines`,
    top(copies.blocks, (b) => ({ label: `${b.path}:${b.line} repeats ${b.of.path}:${b.of.line}`, value: b.lines, unit: "lines" })),
  );
}

function commentMetrics({ files, typed, py }, areas) {
  const exports = [...typed, ...py.files].flatMap((f) => f.exports.map((e) => ({ ...e, area: f.area })));
  return {
    "code.purpose_comments_pct": share(
      files.map((f) => ({ ...f, documented: f.purpose })),
      "code files that open with a comment of 3+ words, after any shebang or .astro fence (a Python docstring counts)",
      areas,
      (f, a) => f.area === a,
    ),
    "code.export_comments_pct": share(
      exports,
      `exported functions with a comment on the line above, and public Python functions with a docstring or one: TypeScript compiler API${py.how}`,
      areas,
      (e, a) => e.area === a,
    ),
  };
}

const over = (list, key, limit) => list.filter((x) => x[key] > limit).sort((a, b) => b[key] - a[key]);
const counted = (limit, value) =>
  limit > 0 ? value() : unknown("params.limits needs complexity, function_lines and file_lines, each above 0", "params.limits");

function sizeMetrics({ files, fns, py }, limits) {
  return {
    "code.complex_functions": counted(limits.complexity, () => {
      const complex = over(fns, "complexity", limits.complexity);
      return measured(
        complex.length,
        `TypeScript compiler API${py.how}, McCabe complexity over ${limits.complexity}`,
        top(complex, (f) => ({ label: f.where, value: f.complexity, unit: "" })),
      );
    }),
    "code.long_functions": counted(limits.function_lines, () => {
      const long = over(fns, "lines", limits.function_lines);
      return measured(
        long.length,
        `TypeScript compiler API${py.how}, functions over ${limits.function_lines} code lines`,
        top(long, (f) => ({ label: f.where, value: f.lines, unit: "lines" })),
      );
    }),
    "code.long_files": counted(limits.file_lines, () => {
      const bigFiles = over(files.filter((f) => SIZED.test(f.path)), "codeLines", limits.file_lines);
      return measured(
        bigFiles.length,
        `.ts, .mjs, .astro, .css, .py and .sh files over ${limits.file_lines} code lines`,
        top(bigFiles, (f) => ({ label: f.path, value: f.codeLines, unit: "lines" })),
      );
    }),
  };
}

function driftMetrics({ files, typed }) {
  const markers = files.flatMap((f) =>
    f.comments.flatMap((c) => [...c.text.matchAll(DRIFT_MARKER)].map((m) => ({ path: f.path, line: c.line, marker: m[1] }))),
  );
  const commented = typed.flatMap((f) => f.commentedOut.map((b) => ({ where: `${f.path}:${b.line}`, lines: b.lines })));
  return {
    "code.drift_markers": measured(
      markers.length,
      "TODO, FIXME and XXX in comments",
      top(countBy(markers, (m) => m.path), ([label, value]) => ({ label, value })),
    ),
    "code.commented_code": measured(
      commented.length,
      "3+ comment lines in a row that parse as TypeScript statements",
      top(commented, (c) => ({ label: c.where, value: c.lines, unit: "lines" })),
    ),
  };
}

// The change over the last params.merged_prs pull requests merged into main,
// a last-N basis: the repo sets N so that many turn over within hours. The
// base is main just before the oldest of them (its first parent); its code
// lines are counted from git's tree with the same rules as this run, so the
// change is like for like.
const PR_MERGE = /^Merge pull request #(\d+)|\(#(\d+)\)$/;

// Code lines now against main before its last params.merged_prs merged PRs.
async function locChange(root, files, loc, run, { areas, skip, mainRefs, mergedPrs }) {
  const n = mergedPrs;
  const source = `code lines now against main before its last ${n} merged PRs (git log --first-parent, ls-tree, cat-file)`;
  if (!(n > 0)) return unknown("params.merged_prs must be a count above 0", "params.merged_prs");
  const log = await mergeCommits(root, mainRefs, n, run);
  if (log.error) return unknown(log.error, source);
  const { merges } = log;
  const base = `${merges.at(-1).sha}^`;
  const before = await codeLinesAt(root, base, { areas, skip }, run);
  if (before.error) return unknown(before.error, source);
  const baseLoc = [...before.byArea.values()].reduce((a, x) => a + x, 0);
  if (!baseLoc) return unknown(`no code lines in the areas at ${base}`, source);
  const detail = areas.map((a) => ({ label: a, value: sum(files.filter((f) => f.area === a), "codeLines") - before.byArea.get(a), unit: "lines" }));
  return measured(
    round((100 * (loc - baseLoc)) / baseLoc, 1),
    `${source}: ${baseLoc} lines at ${base.slice(0, 7)}^ (before PR #${merges.at(-1).pr}), ${loc} now, through PR #${merges[0].pr}; detail is lines added less removed per area`,
    detail,
  );
}

// The last n PR merges on the first main ref git can log, newest first, or
// { error } when git cannot log it or too few merged.
async function mergeCommits(root, mainRefs, n, run) {
  let log;
  let ref;
  for (ref of mainRefs) {
    log = await run("git", ["log", "--first-parent", "-n", "500", "--format=%H %s", ref, "--"], { cwd: root, timeoutMs: 60_000 });
    if (log.code === 0) break;
  }
  if (log.code !== 0) return { error: `git log failed on ${mainRefs.join(", ")} (${firstLine(log.stderr)})` };
  const merges = log.stdout
    .split("\n")
    .map((line) => ({ sha: line.slice(0, 40), m: PR_MERGE.exec(line.slice(41).trim()) }))
    .filter((c) => /^[0-9a-f]{40}$/.test(c.sha) && c.m)
    .slice(0, n)
    .map((c) => ({ sha: c.sha, pr: Number(c.m[1] ?? c.m[2]) }));
  if (merges.length >= n) return { merges };
  const shallow = await run("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, timeoutMs: 30_000 });
  const why = shallow.stdout.trim() === "true" ? "; shallow clone, check out with fetch-depth: 0" : "";
  return { error: `only ${merges.length} merged PRs on ${ref}'s first-parent history, need ${n}${why}` };
}

// The code lines of each area as git's tree held them at `base`, counted by
// this run's rules, or { error }.
async function codeLinesAt(root, base, { areas, skip }, run) {
  const ls = await run("git", ["ls-tree", "-r", "-z", base, "--", ...areas], { cwd: root, timeoutMs: 60_000 });
  if (ls.code !== 0) return { error: `git ls-tree ${base} failed (${firstLine(ls.stderr)})` };
  const blobs = ls.stdout
    .split("\0")
    .map((entry) => /^\d+ blob ([0-9a-f]+)\t(.+)$/s.exec(entry))
    .filter(Boolean)
    .map(([, sha, path]) => ({ sha, path, area: areaOf(path, areas) }))
    .filter((b) => b.area && countsAsCode(b.path, skip));
  const texts = await blobTexts(root, blobs.map((b) => b.sha), run);
  if (typeof texts === "string") return { error: texts };
  const byArea = new Map(areas.map((a) => [a, 0]));
  for (const b of blobs) {
    const text = texts.get(b.sha) ?? "";
    if (GENERATED.test(text.slice(0, 400))) continue;
    const facts = analyzeFile(b.path, text);
    if (facts) byArea.set(b.area, byArea.get(b.area) + facts.codeLines);
  }
  return { byArea };
}

// Each blob's text from one git cat-file --batch call; sizes are in bytes, so
// the output is parsed as a Buffer. Returns a reason string on failure.
async function blobTexts(root, shas, run) {
  const texts = new Map();
  if (!shas.length) return texts;
  const r = await run("git", ["cat-file", "--batch"], { cwd: root, timeoutMs: 60_000, input: `${[...new Set(shas)].join("\n")}\n` });
  if (r.code !== 0) return `git cat-file failed (${firstLine(r.stderr)})`;
  const buf = r.bytes ?? Buffer.from(r.stdout);
  for (let i = 0; i < buf.length; ) {
    const nl = buf.indexOf(10, i);
    const [sha, type, size] = buf.subarray(i, nl < 0 ? buf.length : nl).toString().split(" ");
    if (type !== "blob") return `git cat-file: ${sha} is ${type || "unreadable"}`;
    texts.set(sha, buf.subarray(nl + 1, nl + 1 + Number(size)).toString("utf8"));
    i = nl + 1 + Number(size) + 1;
  }
  return texts;
}
