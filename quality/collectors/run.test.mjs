// run.mjs loads on its own, with no package installed (issue #715): the Pages
// action's two-page collect imports collectors through it without node_modules.
// Run with: node --test quality/collectors/run.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { firstLine, isDir, measured, runCommand, unknown } from "./run.mjs";

test("run.mjs imports node built-ins only, so it loads without node_modules", () => {
  const imports = [...readFileSync(new URL("./run.mjs", import.meta.url), "utf8").matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  assert.deepEqual(imports.filter((s) => !s.startsWith("node:")), []);
});

test("its helpers work: a run that resolves, result rows and the first line", async () => {
  const r = await runCommand(process.execPath, ["-e", "process.stdout.write('hi')"]);
  assert.deepEqual([r.code, r.stdout], [0, "hi"]);
  assert.equal((await runCommand("no-such-command-715", [])).missing, true);
  assert.equal(isDir(new URL(".", import.meta.url).pathname), true);
  assert.deepEqual(unknown("why", "src"), { could_not_check: "why", source: "src" });
  assert.equal(measured(3, "src").value, 3);
  assert.equal(firstLine("\n====\nfirst\nsecond"), "first");
});
