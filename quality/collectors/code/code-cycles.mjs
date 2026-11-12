// The Code collector's import-structure metric (code-files.mjs): groups of
// files that import each other. A cycle is a strongly connected group of two
// or more files in the import graph of the areas, so none of its files can be
// read, tested or changed alone.
import { dirname, join, normalize } from "node:path/posix";
import { measured, top } from "./code-util.mjs";

// `import name`, `from name import`, `from .name import` and `from . import name`: a sibling module.
const PY_IMPORT = /^\s*(?:from\s+\.?(\w+)[\w.]*\s+import|from\s+\.\s+import\s+(\w+)|import\s+(\w+))/gm;
// What a relative specifier may leave out: the extension, or /index and the extension.
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".js", ".jsx", ".cjs", ".astro"];

// The code file a relative specifier names, the way TypeScript and bundlers
// resolve it: as written, with an extension added, as a folder's index file,
// or a .js specifier that stands for a .ts source.
function resolveImport(dir, spec, known) {
  const base = normalize(join(dir, spec));
  const stem = base.replace(/\.[cm]?js$/, "");
  const tries = [base, ...EXTENSIONS.map((e) => base + e), ...EXTENSIONS.map((e) => stem + e), ...EXTENSIONS.map((e) => `${base}/index${e}`)];
  return tries.find((t) => known.has(t));
}

// Each file's imports that are other code files in the areas: relative
// specifiers for JavaScript and TypeScript, a sibling module for Python.
function importGraph(files) {
  const known = new Set(files.map((f) => f.path));
  const graph = new Map();
  for (const f of files) {
    const dir = dirname(f.path);
    const targets = f.path.endsWith(".py")
      ? [...(f.text ?? "").matchAll(PY_IMPORT)].map((m) => join(dir, `${m[1] ?? m[2] ?? m[3]}.py`))
      : (f.imports ?? []).map((spec) => resolveImport(dir, spec, known));
    graph.set(f.path, [...new Set(targets)].filter((t) => t && t !== f.path && known.has(t)));
  }
  return graph;
}

// Tarjan's strongly connected components of a Map from a file to the files
// it imports; only the groups of two or more.
function cycles(graph) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const found = [];
  const visit = (v) => {
    index.set(v, index.size);
    low.set(v, index.get(v));
    stack.push(v);
    for (const w of graph.get(v)) {
      if (!index.has(w)) visit(w);
      if (stack.includes(w)) low.set(v, Math.min(low.get(v), low.get(w)));
    }
    if (low.get(v) !== index.get(v)) return;
    const group = stack.splice(stack.indexOf(v));
    if (group.length > 1) found.push(group.sort());
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

// The import cycles among the code files of the areas, each named by its files.
export function importCycles(files) {
  const found = cycles(importGraph(files));
  return measured(
    found.length,
    "relative imports and re-exports (TypeScript compiler API) and sibling-module imports of .py files; groups of two or more files that import each other",
    top(found, (group) => ({ label: group.join(" and "), value: group.length, unit: "files" })),
  );
}
