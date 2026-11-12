// The Code collector's dead code metrics, read with knip (code.mjs): the
// repo's own copy, else the one that ships with this engine.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { firstLine, measured, readJson, top, unknownAll, walkAll } from "./code-util.mjs";
import { COVERAGE_PACKAGE } from "./code-test.mjs";

// ---- Quality: dead code ----

// knip needs to know where programs start. Besides package scripts and its
// plugins (Astro, Vitest, Wrangler, Playwright), a file is an entry when it is
// run directly: a shebang or a main-module guard. Declaration files sit beside
// the .mjs they describe, and a package named in a workspace's rc file (such as
// .secretlintrc.json) is in use. A knip config at the repo root wins over this.
const KNIP_DEFAULT_ENTRY = [
  "{index,cli,main}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
  "src/{index,cli,main}.{js,cjs,mjs,jsx,ts,cts,mts,tsx}",
];
const RUN_DIRECTLY = /^#!|\bimport\.meta\.main\b|process\.argv\[1\][^\n]*import\.meta\.url|import\.meta\.url[^\n]*process\.argv\[1\]/m;
const ROOT_KNIP_CONFIGS = ["knip.json", "knip.jsonc", ".knip.json", ".knip.jsonc", "knip.ts", "knip.config.ts"];
const DEAD_EXPORT_KINDS = ["exports", "types", "enumMembers", "namespaceMembers", "classMembers"];
const DEAD_DEPENDENCY_KINDS = ["dependencies", "devDependencies", "optionalPeerDependencies"];
// The knip that ships with this engine, for a repo that installs none of its own.
const ENGINE_KNIP = fileURLToPath(new URL("../../../node_modules/.bin/knip", import.meta.url));

// The knip config this run writes: per workspace, knip's default entries plus
// every file that runs directly, and the packages only an rc file or a vitest
// flag loads, which knip cannot see.
export function knipConfig(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const workspaces = [".", ...(manifest.workspaces ?? [])];
  const entries = runDirectly(root, workspaces);
  return {
    workspaces: Object.fromEntries(
      Object.entries(entries)
        .filter(([, list]) => list.length)
        .map(([w, list]) => [w, { entry: [...KNIP_DEFAULT_ENTRY, ...list.sort()] }]),
    ),
    ignore: ["**/*.d.mts", "**/*.d.cts"],
    ignoreDependencies: [...rcDependencies(root, workspaces)].sort(),
  };
}

// Per workspace, the files that run directly (a shebang or a main-module guard).
function runDirectly(root, workspaces) {
  const entries = Object.fromEntries(workspaces.map((w) => [w, []]));
  for (const abs of walkAll(root)) {
    if (!/\.[cm]?[jt]s$/.test(abs) || !RUN_DIRECTLY.test(readFileSync(abs, "utf8").slice(0, 4000))) continue;
    const path = relative(root, abs).split(sep).join("/");
    const ws = workspaces.filter((w) => w === "." || path.startsWith(w + "/")).sort((a, b) => b.length - a.length)[0];
    entries[ws].push(ws === "." ? path : path.slice(ws.length + 1));
  }
  return entries;
}

// The packages only an rc file or a vitest flag loads, which knip cannot see.
function rcDependencies(root, workspaces) {
  const used = new Set();
  for (const w of workspaces) {
    const dir = join(root, w);
    const pkg = readJson(join(dir, "package.json"));
    const deps = Object.keys({ ...pkg?.dependencies, ...pkg?.devDependencies });
    const rc = readdirSync(dir).filter((n) => /^\.[\w-]+rc(\.(json|ya?ml|[cm]?js))?$/.test(n));
    const text = rc.map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
    for (const d of deps) if (text.includes(`"${d}"`) || text.includes(`'${d}'`)) used.add(d);
    // This collector loads the coverage provider through vitest's
    // --coverage.provider flag, which knip cannot see from JavaScript.
    if (deps.includes(COVERAGE_PACKAGE)) used.add(COVERAGE_PACKAGE);
  }
  return used;
}

// Dead files, exports and dependencies in the areas, from a knip run in a scratch folder.
export async function deadCode(root, run, areas) {
  const ids = ["code.dead_files", "code.dead_exports", "code.dead_dependencies"];
  const ownConfig = ROOT_KNIP_CONFIGS.some((n) => existsSync(join(root, n)));
  const source = `knip --reporter json (${ownConfig ? "the repo's knip config" : "entries from package scripts, plugins and files run directly"})`;
  if (!areas.length) return unknownAll(ids, "params.areas names no code folder", "params.areas");
  if (!existsSync(join(root, "package.json"))) return unknownAll(ids, "no package.json at the repo root", source);
  const scratch = mkdtempSync(join(tmpdir(), "quality-knip-"));
  try {
    const args = ["--reporter", "json", "--no-progress", "--no-exit-code"];
    if (!ownConfig) {
      writeFileSync(join(scratch, "knip.json"), JSON.stringify(knipConfig(root)));
      args.unshift("--config", join(scratch, "knip.json"));
    }
    // The repo's own knip first, at the version it pins; else the engine's.
    let r = await run(join(root, "node_modules/.bin/knip"), args, { cwd: root, timeoutMs: 300_000 });
    if (r.missing) r = await run(ENGINE_KNIP, args, { cwd: root, timeoutMs: 300_000 });
    if (r.missing) return unknownAll(ids, "knip is not installed in the repo or beside this engine (npm ci installs it)", source);
    let report;
    try {
      report = JSON.parse(r.stdout);
    } catch {
      return unknownAll(ids, `knip printed no JSON (exit ${r.code}): ${firstLine(r.stderr)}`, source);
    }
    return summarizeKnip(report, source, areas);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Unused files and exports count inside the areas only, like every other
// metric on this tab. Unused dependencies count in every package.json.
export function summarizeKnip(report, source, areas) {
  const inAreas = (file) => areas.some((a) => file.startsWith(a + "/"));
  const issues = report.issues ?? [];
  const files = issues.flatMap((i) => (i.files ?? []).map((f) => f.name ?? i.file)).filter(inAreas);
  const exports = issues
    .filter((i) => inAreas(i.file))
    .flatMap((i) => DEAD_EXPORT_KINDS.flatMap((k) => (i[k] ?? []).map((x) => ({ file: i.file, kind: k, name: x.name }))));
  const deps = issues.flatMap((i) => DEAD_DEPENDENCY_KINDS.flatMap((k) => (i[k] ?? []).map((x) => `${i.file} ${x.name}`)));
  return {
    "code.dead_files": measured(files.length, source, top(files, (f) => ({ label: f, value: 1 }))),
    // One row per export, file and name, so the warning names what to remove (issue 779).
    "code.dead_exports": measured(exports.length, source, top(exports, (e) => ({ label: `${e.file}: ${e.name}`, value: 1 }))),
    "code.dead_dependencies": measured(deps.length, source, top(deps, (d) => ({ label: d, value: 1 }))),
  };
}
