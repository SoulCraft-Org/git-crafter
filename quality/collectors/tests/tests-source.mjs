// The Tests collector's static half: tracked test files, skipped tests and the
// page routes the end-to-end specs open (tests.mjs re-exports it).

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const TARGETS = JSON.parse(readFileSync(new URL("../../targets/tests.json", import.meta.url), "utf8"));
export const PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));

// ---------------------------------------------------------------- the repo

// params.suites: each suite's files, as its runner's config includes them,
// in the order of the test pyramid, bottom up: [{ label, dir, file, e2e }],
// file a pattern on the path, e2e true for the end-to-end suite whose specs
// open the page routes. params.pages_dir and params.page_file name the page
// files whose routes the specs should open.
export function settings(params = {}) {
  const suites = (Array.isArray(params.suites) ? params.suites : []).map((s) => ({ ...s, file: new RegExp(s.file) }));
  return {
    suites,
    e2e: suites.find((s) => s.e2e) ?? null,
    pagesDir: typeof params.pages_dir === "string" ? params.pages_dir : "",
    pageFile: new RegExp(params.page_file || "\\.(astro|mdx?|html)$"),
    workflows: Array.isArray(params.workflows) ? params.workflows : [],
  };
}

/** Code without its comment lines, so a commented-out test never counts. */
export function codeOnly(text) {
  return text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

// A test case's call site: it( or test(, with any modifiers, and a title
// literal first, or a .each or .for table. test.describe, test.use and a
// runtime test.skip(condition) are not cases. A loop counts once. A skipIf or
// runIf condition may hold one level of calls: skipIf(!existsSync(file)).
const CASE = /(?<![\w$.])(?:it|test)(?:\.(?:only|skip|todo|fixme|fails|concurrent|sequential|(?:skipIf|runIf)\((?:[^()]|\([^()]*\))*\)))*(?:\s*\(\s*["'`]|\.(?:each|for)\s*[(`])/g;
// A skip marker on a describe block, which covers every case inside it.
const BLOCK = /(?<![\w$.])(?:test\.)?describe(?:\.(?:only|concurrent|sequential|serial|parallel))*\.(skip|todo|fixme|skipIf|runIf)\s*\(/g;
// A skip call. One that is neither a case nor a block marker skips at run
// time, as ctx.skip() or test.skip(condition) does: it counts once, as
// conditional, since only a run can tell whether it skips.
const SKIP_CALL = /\.(?:skip|todo|fixme)\s*\(/g;
// A case's own marker: always (skip, todo, fixme) or on a condition.
const ALWAYS = /\.(?:skip|todo|fixme)(?!\w)/;
const CONDITIONAL = /\.(?:skipIf|runIf)\(/;

/** Where the string or template literal that opens at i closes. */
function stringEnd(code, i) {
  const q = code[i];
  for (let j = i + 1; j < code.length; j++) {
    if (code[j] === "\\") j++;
    else if (code[j] === q || (q !== "`" && code[j] === "\n")) return j;
  }
  return code.length;
}

/** The parenthesis that closes the one at `open`, past strings and escaped characters; the end of the code when none does. */
export function closeParen(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "\\") i++;
    else if (c === '"' || c === "'" || c === "`") i = stringEnd(code, i);
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return code.length;
}

/**
 * The code with every string and template literal's contents blanked, quotes
 * and line breaks kept, so offsets hold and a test held as text, such as a
 * sample this file's own tests feed countSkips, never counts.
 */
function blankStrings(code) {
  let out = "";
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c !== '"' && c !== "'" && c !== "`") {
      out += c;
      continue;
    }
    const end = stringEnd(code, i);
    out += c + code.slice(i + 1, end).replace(/[^\n]/g, " ") + (code[end] ?? "");
    i = end;
  }
  return out;
}

/**
 * Tests written in the code that may not run, as `always` (a skip, todo or
 * fixme marker on a case or a describe block: they never run) and
 * `conditional` (skipIf, runIf, and runtime skip calls, read from the code
 * alone). A marker on a describe block counts every case inside it, or 1
 * when it holds none. A case under both kinds counts as always, and each
 * case counts once.
 */
export function countSkips(text) {
  const code = blankStrings(codeOnly(text));
  const cases = [...code.matchAll(CASE)].map((m) => ({ at: m.index, end: m.index + m[0].length, text: m[0] }));
  const blocks = findBlocks(code);
  const inCases = skipsInCases(cases, blocks);
  const inBlocks = skipsInEmptyBlocks(cases, blocks);
  return { always: inCases.always + inBlocks.always, conditional: inCases.conditional + inBlocks.conditional + runtimeSkips(code, cases, blocks) };
}

const inside = (at, b) => at > b.open && at < b.close;

/** The describe blocks that carry a skip marker. */
function findBlocks(code) {
  const blocks = [];
  for (const m of code.matchAll(BLOCK)) {
    const conditional = m[1] === "skipIf" || m[1] === "runIf";
    let open = m.index + m[0].length - 1;
    if (conditional) {
      // describe.skipIf(condition)("title", body): the second call holds the cases.
      const close = closeParen(code, open);
      const call = /^\s*\(/.exec(code.slice(close + 1));
      open = call ? close + call[0].length : open;
    }
    blocks.push({ at: m.index, marker: m.index + m[0].length, open, close: closeParen(code, open), conditional });
  }
  return blocks;
}

function skipsInCases(cases, blocks) {
  let always = 0;
  let conditional = 0;
  for (const c of cases) {
    const around = blocks.filter((b) => inside(c.at, b));
    if (ALWAYS.test(c.text) || around.some((b) => !b.conditional)) always += 1;
    else if (CONDITIONAL.test(c.text) || around.length) conditional += 1;
  }
  return { always, conditional };
}

/** A marked block that holds no case counts once itself. */
function skipsInEmptyBlocks(cases, blocks) {
  const empty = blocks.filter((b) => !cases.some((c) => inside(c.at, b)));
  const conditional = empty.filter((b) => b.conditional).length;
  return { always: empty.length - conditional, conditional };
}

/** Skip calls that are neither a case nor a block marker: they skip at run time. */
function runtimeSkips(code, cases, blocks) {
  let n = 0;
  for (const m of code.matchAll(SKIP_CALL)) {
    if (!cases.some((c) => m.index >= c.at && m.index < c.end) && !blocks.some((b) => m.index >= b.at && m.index < b.marker)) n += 1;
  }
  return n;
}

/**
 * A page file's route: with params.pages_dir src/pages/, src/pages/join/[seat].astro serves
 * /join/[seat]/. An endpoint (.ts, .js) or a file under an
 * underscore makes no page, so it has none.
 */
export function pageRoute(file, { pagesDir, pageFile } = settings(PARAMS)) {
  if (!pagesDir || !file.startsWith(pagesDir) || !pageFile.test(file)) return null;
  const parts = file.slice(pagesDir.length).replace(pageFile, "").split("/");
  if (parts.some((p) => p.startsWith("_"))) return null;
  if (parts.at(-1) === "index") parts.pop();
  return parts.length ? `/${parts.join("/")}/` : "/";
}

// A site path in quotes, and one passed straight to goto().
const PATH_LITERAL = /(["'`])(\/(?!\/)[^"'`\s]*)\1/g;
const GOTO_LITERAL = /\.goto\(\s*(["'`])(\/(?!\/)[^"'`\s]*)\1/g;

/** A spec's path as a route reads it: no query or hash, a closing slash, and each ${…} as one segment. */
export function normalPath(raw) {
  let p = raw.replace(/\$\{[^}]*\}/g, "*").split(/[?#]/)[0];
  if (!p.endsWith("/") && !/\.\w+$/.test(p)) p += "/";
  return p;
}

/** Whether a path opens a route. [param] takes any one segment and [...rest] the rest; a * fills only a [param]. */
export function routeMatches(route, p) {
  const r = route.split("/").filter(Boolean);
  const s = p.split("/").filter(Boolean);
  for (let i = 0; i < r.length; i++) {
    if (/^\[\.\.\..+\]$/.test(r[i])) return true;
    if (i >= s.length) return false;
    const param = /^\[.+\]$/.test(r[i]);
    if (s[i] === "*" ? !param : !param && s[i] !== r[i]) return false;
  }
  return s.length === r.length;
}

/**
 * The routes the end-to-end specs open, and those a spec that runs axe opens.
 * A spec opens every route its path literals name: a light parse, so a path
 * named only in an assertion counts too. A goto() to a path no page serves
 * opens the 404 page, which the build serves for it.
 */
export function routeCoverage(routes, specs) {
  const visited = new Set();
  const axe = new Set();
  const notFound = routes.includes("/404/") ? "/404/" : null;
  for (const text of specs) {
    const code = codeOnly(text);
    const checksAxe = /\bAxeBuilder\b/.test(code);
    for (const r of namedRoutes(code, routes, notFound)) {
      visited.add(r);
      if (checksAxe) axe.add(r);
    }
  }
  return { visited, axe };
}

/** The routes a spec's path literals name; a goto() no page serves names the 404 page. */
function namedRoutes(code, routes, notFound) {
  const named = new Set();
  for (const m of code.matchAll(PATH_LITERAL)) {
    const p = normalPath(m[2]);
    for (const r of routes) if (routeMatches(r, p)) named.add(r);
  }
  for (const m of code.matchAll(GOTO_LITERAL)) {
    const p = normalPath(m[2]);
    if (notFound && !routes.some((r) => routeMatches(r, p))) named.add(notFound);
  }
  return named;
}

/** Tracked files, from git ls-files -z. */
export function gitFiles(root) {
  return new Promise((resolve, reject) => {
    execFile("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`git ls-files failed: ${(stderr || err.message).trim().split("\n")[0]}`));
      resolve(stdout.split("\0").filter(Boolean));
    });
  });
}

/** Every suite's files and skips, and the page routes the specs cover. Throws when a file cannot be read. */
export async function readRepo(root, listFiles, cfg = settings(PARAMS)) {
  const files = await listFiles(root);
  const read = (f) => readFileSync(path.join(root, f), "utf8");
  const suites = cfg.suites.map((s) => {
    const each = files
      .filter((f) => f.startsWith(s.dir) && s.file.test(f))
      .map((f) => {
        const text = read(f);
        const { always, conditional } = countSkips(text);
        return { file: f, skips: always, conditional };
      });
    return { ...s, files: each.length, skipped: each.filter((e) => e.skips || e.conditional) };
  });
  const routes = [...new Set(files.map((f) => pageRoute(f, cfg)).filter(Boolean))].sort();
  const specs = cfg.e2e ? files.filter((f) => f.startsWith(cfg.e2e.dir) && cfg.e2e.file.test(f)) : [];
  return { suites, routes, specCount: specs.length, ...routeCoverage(routes, specs.map(read)) };
}
