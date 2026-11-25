// A repo whose one area is the root ("."): naming_pct and loc_change_pct measure it instead of dropping out.
// Run with: node --test quality/collectors/code/code-root-area.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { collect, PARAMS } from "./code.mjs";
import { areaOf, inArea, nestedIn } from "./code-util.mjs";

describe("inArea", () => {
  it("takes . as the whole repo and a folder as its own subtree", () => {
    assert.equal(inArea("a.mjs", "."), true);
    assert.equal(inArea("src/a.mjs", "."), true);
    assert.equal(inArea("src/a.mjs", "src"), true);
    assert.equal(inArea("srcs/a.mjs", "src"), false);
    assert.equal(areaOf("src/a.mjs", [".", "src"]), "src");
    assert.equal(areaOf("a.mjs", [".", "src"]), ".");
    assert.deepEqual([...nestedIn("/r", ".", [".", "src"])], ["/r/src"]);
    assert.deepEqual([...nestedIn("/r", "src", [".", "src"])], []);
  });
});

describe("collect with params.areas of [\".\"]", () => {
  let root;
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  before(() => {
    root = mkdtempSync(join(tmpdir(), "code-root-area-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    mkdirSync(join(root, "lib"));
    writeFileSync(join(root, "main.mjs"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(join(root, "lib/helper-tool.mjs"), "export const h = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Start");
    writeFileSync(join(root, "lib/more.mjs"), "export const m = 1;\nexport const n = 2;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "Merge pull request #1 from t/more");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("measures the naming share and the change in code lines", async () => {
    const result = await collect({ root, mode: "local", params: { ...PARAMS, areas: ["."], merged_prs: 1 } });
    assert.equal(result["code.loc_change_pct"].could_not_check, undefined, result["code.loc_change_pct"].could_not_check);
    // Five code lines now against three at the commit before the merge.
    assert.equal(result["code.loc_change_pct"].value, 66.7);
    assert.equal(result["code.naming_pct"].could_not_check, undefined, result["code.naming_pct"].could_not_check);
    assert.equal(typeof result["code.naming_pct"].value, "number");
  });
});
