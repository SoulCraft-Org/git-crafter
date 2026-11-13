// The seam between collectors and the engine: every collector file reaches
// the engine only through collectors/lib/, and collect.mjs hands each
// collect() the lib helpers.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCollectors } from '../../collect.mjs';
import * as lib from './index.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TREES = ['quality/collectors/', 'config/quality/collectors/'];
const LIB = 'quality/collectors/lib/';
// A relative module path in each shape a collector can load one: import, from,
// import(), require() (createRequire's), and a resolve() (import.meta's,
// require's, createRequire's), in any quote with no ${}.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+|\brequire\s*\(\s*|\.resolve\s*\(\s*)(['"`])(\.{1,2}\/[^'"`$]+)\1/gm;
// An import() whose path is built, not written: the test cannot read where it goes.
const BUILT = /\bimport\s*\(\s*(?!(['"`])[^'"`$]*\1\s*\))/;
// The files allowed a built import(), each loading a package, never an engine file.
const BUILT_OK = ['quality/collectors/site/site-base.mjs'];

// The relative paths a source text loads.
const specsOf = (text) => [...text.matchAll(SPEC)].map((m) => m[2]);

// Every .mjs file under a folder, repo-relative.
function mjsFiles(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}${e.name}`;
    if (e.isDirectory()) return mjsFiles(`${rel}/`);
    return e.name.endsWith('.mjs') ? [rel] : [];
  });
}

// Each relative import in the collector trees as { file, target }, both repo-relative.
function imports() {
  return TREES.flatMap(mjsFiles).flatMap((file) => specsOf(readFileSync(join(ROOT, file), 'utf8')).map((spec) => ({ file, target: relative(ROOT, resolve(ROOT, dirname(file), spec)) })));
}

// True when file may import target: lib/ is the door, and a file stays in its own tree.
function allowed({ file, target }) {
  if (file.startsWith(LIB) || target.startsWith(LIB)) return true;
  return TREES.some((t) => file.startsWith(t) && target.startsWith(t));
}

test('seam: the test reads imports in both quote styles and dynamic ones', () => {
  assert.ok(imports().some((i) => i.file.endsWith('guard-speed.mjs') && i.target === `${LIB}readers.mjs`), 'a dynamic import is read');
});

test('seam: the test reads each shape a collector can load a module in', () => {
  const shapes = {
    "import { a } from '../x.mjs';": '../x.mjs',
    'import "./side.mjs";': './side.mjs',
    'await import(`../t.mjs`);': '../t.mjs',
    "const require = createRequire(import.meta.url); require('../c.cjs');": '../c.cjs',
    "createRequire(import.meta.url).resolve('../r.mjs');": '../r.mjs',
    "import.meta.resolve('../m.mjs');": '../m.mjs',
  };
  for (const [text, spec] of Object.entries(shapes)) assert.deepEqual(specsOf(text), [spec], text);
  for (const text of ['import(`../${name}.mjs`)', 'import(join(dir, "x.mjs"))', 'import(pathToFileURL(p).href)']) assert.ok(BUILT.test(text), text);
  assert.ok(!BUILT.test('import("../x.mjs")'), 'a written path is not built');
});

test('seam: no collector file outside lib/ builds an import() path, except those that load a package', () => {
  const built = TREES.flatMap(mjsFiles).filter((file) => !file.startsWith(LIB) && BUILT.test(readFileSync(join(ROOT, file), 'utf8')));
  assert.deepEqual(built, BUILT_OK);
});

test('seam: no collector file imports an engine file except through collectors/lib/', () => {
  assert.deepEqual(imports().filter((i) => !allowed(i)), []);
});

test('seam: collect() receives lib, the engine helpers, and lib/ holds no collector', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seam-'));
  const probe = 'export async function collect({ lib }) { return { "probe.lib": { value: typeof lib.redact === "function" && typeof lib.ghClient === "function" ? 1 : 0 } }; }\n';
  writeFileSync(join(dir, 'probe.mjs'), probe);
  const { metrics, ran } = await runCollectors({ root: dir, mode: 'local', dirs: [dir], defs: [] });
  assert.equal(metrics['probe.lib'].value, 1);
  assert.deepEqual(ran, ['probe']);
  const lib = await runCollectors({ root: dir, mode: 'local', dirs: [join(ROOT, LIB, '..')], defs: [], only: 'index' }).catch((e) => e.message);
  assert.match(lib, /no collector index\.mjs/);
});

// Every engine name the Claude pack's collectors (Colorado-Startups/claudius) import by path.
const PACK_NAMES = ['causes', 'expandGlobs', 'ghClient', 'greenAt', 'loadTargets', 'managedClaudeMd', 'ownRepo', 'percentile', 'PROJECTS_DIR', 'projectMatch', 'prRefs', 'PULL_FIELDS', 'redact', 'remoteRepo', 'resolvePath', 'reverts'];

test('seam: lib carries every engine name the Claude pack imports', () => {
  assert.deepEqual(PACK_NAMES.filter((n) => lib[n] === undefined), []);
});
