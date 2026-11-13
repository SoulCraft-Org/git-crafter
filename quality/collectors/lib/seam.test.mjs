// The seam between collectors and the engine: every collector file reaches
// the engine only through collectors/lib/, the GitHub tabs never import a
// Claude tab's folder, and collect.mjs hands each collect() the lib helpers.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCollectors } from '../../collect.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TREES = ['quality/collectors/', 'config/quality/collectors/'];
const LIB = 'quality/collectors/lib/';
// The Claude tabs' folders, bound for their own repo (plan PR 2).
const CLAUDE = ['claude', 'desktop-app', 'blockers', 'tokens', 'instructions'].map((d) => `quality/collectors/${d}/`);
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm;

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
  return TREES.flatMap(mjsFiles).flatMap((file) => [...readFileSync(join(ROOT, file), 'utf8').matchAll(SPEC)].map((m) => ({ file, target: relative(ROOT, resolve(ROOT, dirname(file), m[1])) })));
}

// True when file may import target: lib/ is the door, and a file stays in its own tree.
function allowed({ file, target }) {
  if (file.startsWith(LIB) || target.startsWith(LIB)) return true;
  return TREES.some((t) => file.startsWith(t) && target.startsWith(t));
}

test('seam: the test reads imports in both quote styles and dynamic ones', () => {
  const found = imports();
  assert.ok(found.some((i) => i.file.endsWith('guard-speed.mjs') && i.target === `${LIB}readers.mjs`), 'a dynamic import is read');
  assert.ok(found.length > 300, `read ${found.length} imports`);
});

test('seam: no collector file imports an engine file except through collectors/lib/', () => {
  assert.deepEqual(imports().filter((i) => !allowed(i)), []);
});

test('seam: no GitHub tab collector imports a Claude tab folder', () => {
  const claude = (p) => CLAUDE.some((d) => p.startsWith(d));
  assert.deepEqual(imports().filter((i) => !claude(i.file) && claude(i.target)), []);
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
