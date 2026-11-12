// The Code collector's client JavaScript size (code.mjs).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { firstLine, measured, round, top, unknown, walkAll } from "./code-util.mjs";

// ---- Speed: client JavaScript ----

// The built static site in params.client_dist ({ dir, source }): each page's
// first-party scripts and modulepreloads, plus their static imports, gzipped.
// Inline scripts and third-party scripts are outside it. A build older than
// the newest commit touching its source folder measures old code, so it is
// could_not_check. When git cannot say, the build is measured and the source
// says freshness was not checked: could not verify is not stale.
export async function clientJs(root, run, clientDist) {
  if (typeof clientDist?.dir !== "string") {
    return { "code.client_js_kb": unknown("params.client_dist names no built site folder", "params.client_dist") };
  }
  const dir = clientDist.dir;
  const from = clientDist.source ?? ".";
  const dist = join(root, dir);
  if (!existsSync(join(dist, "index.html"))) {
    return { "code.client_js_kb": unknown(`no site build in ${dir}; run the build first`, dir) };
  }
  const built = statSync(join(dist, "index.html")).mtime;
  const commit = await siteCommitTime(root, run, from);
  if (commit instanceof Date && built < commit) {
    return {
      "code.client_js_kb": unknown(
        `${dir} was built ${built.toISOString()}, before the newest commit touching ${from}/ (${commit.toISOString()}); run the build first`,
        dir,
      ),
    };
  }
  const fresh = commit instanceof Date
    ? `not older than the newest ${from}/ commit (${commit.toISOString()})`
    : `freshness not checked (${commit})`;
  const source = `${dir} built ${built.toISOString()}, ${fresh}; gzipped JS per page`;
  const gz = new Map();
  const gzipped = (file) => {
    if (!gz.has(file)) gz.set(file, gzipSync(readFileSync(file)).length);
    return gz.get(file);
  };
  const pages = [];
  for (const abs of walkAll(dist)) {
    if (!abs.endsWith(".html")) continue;
    const html = readFileSync(abs, "utf8");
    const srcs = [
      ...[...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)].map((m) => m[1]),
      ...[...html.matchAll(/<link\b[^>]*>/g)]
        .filter((m) => /\brel=["']modulepreload["']/.test(m[0]))
        .map((m) => /\bhref=["']([^"']+)["']/.exec(m[0])?.[1]),
    ].filter((s) => s?.startsWith("/"));
    const graph = jsGraph(srcs.map((s) => join(dist, s.split(/[?#]/)[0])));
    const bytes = [...graph].reduce((n, f) => n + gzipped(f), 0);
    pages.push({ page: "/" + relative(dist, abs).split(sep).join("/").replace(/(^|\/)index\.html$/, "$1"), kb: round(bytes / 1024, 1) });
  }
  pages.sort((a, b) => b.kb - a.kb);
  return {
    "code.client_js_kb": measured(pages[0]?.kb ?? 0, source, top(pages, (p) => ({ label: p.page, value: p.kb }), 10)),
  };
}

// The committer time of the newest commit touching `from`, through the
// injected run. Returns a reason string when git cannot answer.
async function siteCommitTime(root, run, from) {
  const r = await run("git", ["log", "-1", "--format=%ct", "--", from], { cwd: root, timeoutMs: 30_000 });
  if (r.missing) return "git is not on PATH";
  if (r.code !== 0) return `git log failed: ${firstLine(r.stderr)}`;
  const seconds = Number(r.stdout.trim());
  if (!r.stdout.trim() || !Number.isInteger(seconds)) return `git log named no commit touching ${from}/`;
  return new Date(seconds * 1000);
}

function jsGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of readFileSync(file, "utf8").matchAll(/(?:import|from)\s*\(?\s*["'](\.{1,2}\/[^"']+\.js)["']/g)) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  return seen;
}
