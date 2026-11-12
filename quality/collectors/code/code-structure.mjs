// The Code collector's structure metrics: naming and references to files that
// are gone (code.mjs).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { namingRule } from "./shape.mjs";
import { countsAsCode, firstLine, isDir, measured, round, top, unknown, unknownAll } from "./code-util.mjs";

const PATH_TOKEN = /(?<![\w./:@~-])((?:\.\.?\/)*[\w@][\w@.-]*(?:\/[\w@.-]+)+)/g;

// ---- Quality: structure ----

export const STRUCTURE_IDS = ["code.naming_pct", "code.mapped_areas_pct"];
export const STRUCTURE_SOURCE = "git ls-files";

// Structure reads the files git tracks, so build output and local scratch never
// count. Naming looks inside the areas, less params.skip_dirs.
export async function structure(root, run, { areas, naming, skip }) {
  const r = await run("git", ["ls-files", "-z"], { cwd: root, timeoutMs: 30_000 });
  if (r.missing) return unknownAll(STRUCTURE_IDS, "git is not on PATH", STRUCTURE_SOURCE);
  if (r.code !== 0) return unknownAll(STRUCTURE_IDS, `git ls-files failed (${firstLine(r.stderr)})`, STRUCTURE_SOURCE);
  const paths = r.stdout.split("\0").filter(Boolean);
  if (!paths.length) return unknownAll(STRUCTURE_IDS, "git ls-files listed no files", STRUCTURE_SOURCE);
  const inAreas = paths.filter((p) => areas.some((a) => p.startsWith(a + "/")));
  const code = inAreas.filter((p) => countsAsCode(p, skip));
  const named = [...code, ...codeFolders(code, areas)].map((p) => ({ path: p, ...namingRule(p, naming) })).filter((n) => n.rule);
  const rules = [...new Set(named.map((n) => n.rule))].sort();
  return {
    "code.mapped_areas_pct": mappedAreas(root, paths, areas),
    "code.naming_pct": !naming.length
      ? unknown("params.naming has no rule", "params.naming")
      : named.length
      ? measured(
          round((100 * named.filter((n) => n.ok).length) / named.length, 1),
          `code files in the areas, and the folders that hold them, named by their folder's convention (params.naming); ${named.filter((n) => n.ok).length} of ${named.length}`,
          [
            ...rules.map((rule) => {
              const of = named.filter((n) => n.rule === rule);
              return { label: `${rule} (${of.length})`, value: round((100 * of.filter((n) => n.ok).length) / of.length, 1) };
            }),
            ...top(named.filter((n) => !n.ok), (n) => ({ label: `${n.path} (wants ${n.rule})`, value: 0 }), 10),
          ],
        )
      : unknown("git ls-files listed no code file in the areas that a naming rule covers", STRUCTURE_SOURCE),
  };
}

// The part of a README a reader sees as a picture: its table rows and its
// mermaid diagrams.
function visualText(markdown) {
  const diagrams = [...markdown.matchAll(/^```mermaid\r?\n([\s\S]*?)^```/gm)].map((m) => m[1]);
  return [...markdown.split("\n").filter((line) => line.trimStart().startsWith("|")), ...diagrams].join("\n");
}

// A README's picture, with the docs it links beside it, so a long folder map
// can sit next to a README that stays under the reading goal.
function readmePicture(root, paths, p) {
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  const text = readFileSync(join(root, p), "utf8");
  const linked = [...text.matchAll(/\]\(([\w.-]+\.md)\)/g)]
    .map((m) => (dir ? `${dir}/${m[1]}` : m[1]))
    .filter((q) => q !== p && paths.includes(q) && existsSync(join(root, q)));
  const visual = [text, ...linked.map((q) => readFileSync(join(root, q), "utf8"))].map(visualText).filter(Boolean).join("\n");
  return { dir, visual };
}

// An area is drawn when a README at its folder or above shows it: a README in
// the area's own folder that holds a table or a diagram, or one above it whose
// table or diagram names the area as a folder: its path from that README's
// folder, ending in a slash, so a plain word never counts.
function mappedAreas(root, paths, areas) {
  const source = "areas named in a table row or a mermaid block of a README.md at their folder or above, or of a doc it links beside it";
  if (!areas.length) return unknown("params.areas names no code folder", "params.areas");
  const readmes = paths
    .filter((p) => /(^|\/)README\.md$/i.test(p) && existsSync(join(root, p)))
    .map((p) => readmePicture(root, paths, p))
    .filter((r) => r.visual);
  const drawnBy = (area, { dir, visual }) => {
    if (dir === area) return true;
    if (dir && !area.startsWith(dir + "/")) return false;
    const rel = (dir ? area.slice(dir.length + 1) : area).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\w/.-])${rel}/`, "m").test(visual);
  };
  const missing = areas.filter((a) => !readmes.some((r) => drawnBy(a, r)));
  const drawn = areas.length - missing.length;
  return measured(round((100 * drawn) / areas.length, 1), `${source}; ${drawn} of ${areas.length}`, missing.map((a) => ({ label: a, value: 0 })));
}

// The folders that hold code, from each area's own folder down, each as a path
// ending in a slash.
function codeFolders(code, areas) {
  const folders = new Set();
  for (const p of code) {
    const parts = p.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (areas.some((a) => dir === a || dir.startsWith(a + "/"))) folders.add(dir + "/");
    }
  }
  return [...folders].sort();
}

// A reference is drift when a comment or string names a repo file that is gone
// and that git history shows was once committed: it was deleted or moved and
// the reference stayed. A path that was never committed is build output, a
// self-test's scratch file or another folder's file, so it is left out. A bare
// path counts only when its first folder exists from the repo root, the file's
// package or the file's own folder, so prose and URLs never match.
export async function missingRefs(root, files, run) {
  const source = "comments and strings naming files that git log shows were committed and are now gone";
  const found = files.flatMap((f) => refsOf(root, f));
  if (!found.length) return measured(0, source, []);
  const history = await committedPaths(root, run);
  if (typeof history === "string") return unknown(history, source);
  const drift = found.filter((r) => history.has(r.path));
  return measured(drift.length, source, top(drift, (r) => ({ label: `${r.where} ${r.token}`, value: 1 }), 50));
}

// The repo paths one file's comments and strings name that do not exist.
function refsOf(root, f) {
  const fileDir = dirname(join(root, f.path));
  const bases = [...new Set([root, packageDir(root, fileDir), fileDir])];
  const found = [];
  for (const ref of f.refs) {
    for (const m of ref.text.matchAll(PATH_TOKEN)) {
      const missing = missingPath(root, m[1].replace(/\.+$/, ""), fileDir, bases);
      if (missing) found.push({ where: `${f.path}:${ref.line}`, token: missing.token, path: missing.path });
    }
  }
  return found;
}

// A path-like token that names a file nowhere to be found, resolved the way
// its form says; null when it exists, is not a file name, or leaves the repo.
function missingPath(root, token, fileDir, bases) {
  if (!/\.[A-Za-z0-9]{1,8}$/.test(token.split("/").at(-1))) return null;
  const dotted = token.startsWith("./") || token.startsWith("../");
  const live = dotted ? [fileDir] : bases.filter((b) => isDir(join(b, token.split("/")[0])));
  if (!live.length || live.some((b) => fileExists(resolve(b, token)))) return null;
  const path = relative(root, resolve(live[0], token)).split(sep).join("/");
  // A path outside the repo is not a repo file.
  return path.startsWith("../") ? null : { token, path };
}

function fileExists(path) {
  // TypeScript's ESM imports name the emitted .js file.
  return existsSync(path) || (/\.m?js$/.test(path) && existsSync(path.replace(/(\.m?)js$/, "$1ts")));
}

// Every path HEAD's history ever touched. --no-renames lists both sides of a
// move. Returns a reason string when history cannot be read.
async function committedPaths(root, run) {
  const shallow = await run("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, timeoutMs: 30_000 });
  if (shallow.code !== 0) return `git could not read the repo (${firstLine(shallow.stderr)})`;
  if (shallow.stdout.trim() === "true") return "shallow clone; check out with fetch-depth: 0 to read history";
  const log = await run("git", ["log", "--no-renames", "--format=", "--name-only"], { cwd: root, timeoutMs: 120_000 });
  if (log.code !== 0) return `git log failed (${firstLine(log.stderr)})`;
  return new Set(log.stdout.split("\n").filter(Boolean));
}

function packageDir(root, dir) {
  for (let d = dir; d.startsWith(root) && d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, "package.json"))) return d;
  }
  return root;
}
