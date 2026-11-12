// The Code collector's Python reading (code-files.mjs): each function's size
// and complexity, the public functions that say what they do, and the
// functions nothing names, all from one python3 call over Python's own ast.

import { firstLine } from "./code-util.mjs";
import { PY_FUNCTIONS } from "./py-functions.mjs";

// Python functions from one python3 -I call running PY_FUNCTIONS over every .py
// file, each span turned into code lines with the file's own facts, so a
// comment never counts. Without python3, or on bad output, the TypeScript count
// stands and the source says why Python was not read.
export async function pythonFunctions(files, run, tests = []) {
  if (!files.length) return { files: [], how: "", dead: [] };
  const input = JSON.stringify([...files, ...tests].map((f) => ({ path: f.path, text: f.text })));
  const r = await run("python3", ["-I", "-c", PY_FUNCTIONS], { timeoutMs: 120_000, input });
  const skipped = (why) => ({ files: [], how: ` (Python not read: ${why})`, dead: null, why });
  if (r.missing) return skipped("python3 is not on PATH");
  if (r.code !== 0) return skipped(`python3 failed, ${firstLine(r.stderr)}`);
  let rows;
  try {
    rows = JSON.parse(r.stdout);
  } catch {
    return skipped("python3 printed no JSON");
  }
  if (!Array.isArray(rows)) return skipped("python3 printed no list");
  const byPath = new Map(files.map((f) => [f.path, f]));
  const bad = rows.filter((row) => row.error).map((row) => `${row.path} ${row.error}`);
  const out = rows
    .filter((row) => byPath.has(row.path) && Array.isArray(row.functions))
    .map((row) => {
      const file = byPath.get(row.path);
      const lines = new Set(file.code.map((c) => c.line));
      const count = (fn) => Array.from({ length: fn.end - fn.line + 1 }, (_, i) => fn.line + i).filter((l) => lines.has(l)).length;
      const functions = row.functions.map((fn) => ({ name: fn.name, line: fn.line, complexity: fn.complexity, lines: count(fn) }));
      return { path: row.path, area: file.area, functions, exports: publicFunctions(row.functions, file.comments) };
    });
  const how = ` and Python's ast over ${out.length} of ${files.length} .py file(s)` + (bad.length ? `; not parsed: ${bad.slice(0, 3).join(", ")}` : "");
  // A file that did not parse lists no uses, so a function only it names would read as unused.
  if (bad.length) return { files: out, how, dead: null, why: `not parsed: ${bad.slice(0, 3).join(", ")}` };
  return { files: out, how, dead: deadFunctions(rows, byPath) };
}

// Python's shared functions, as an export is JavaScript's: a module's own defs
// whose name has no leading underscore (PEP 8). One says what it does with a
// docstring (PEP 257), or with a comment ending on the line above it.
function publicFunctions(functions, comments) {
  return functions
    .filter((fn) => !fn.name.includes(".") && !fn.name.startsWith("_"))
    .map((fn) => ({ name: fn.name, line: fn.line, documented: fn.doc === true || comments.some((c) => c.ownLine && c.endLine === fn.first - 1) }));
}

// A module's own functions that no .py file, tests included, names: neither
// read, imported, reached as an attribute nor held as a string. A method is
// left out, since a call through its object cannot be traced by name.
function deadFunctions(rows, byPath) {
  const used = new Set(rows.flatMap((row) => row.uses ?? []));
  return rows
    .filter((row) => byPath.has(row.path) && Array.isArray(row.functions))
    .flatMap((row) => row.functions.filter((fn) => !fn.name.includes(".") && !used.has(fn.name)).map((fn) => ({ where: `${row.path}:${fn.line} ${fn.name}`, area: byPath.get(row.path).area })));
}
