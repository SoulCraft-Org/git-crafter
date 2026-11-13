// The reusable CI workflows pin each remote step by full SHA (#8). A caller whose Actions policy requires SHA pins
// refuses a tag at job setup, inside a reusable workflow as in the pages action. gh actions-lock's fix mode rewrites
// these to tags; this test fails if a relock does. Named pages-* so tools/verify.sh's pages suite runs it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const lock = read(".github/workflows/actions.lock");

// Each remote uses: of `yml`, with what follows it on the line.
const remote = (yml) => [...yml.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(.*)$/gm)].filter(([, ref]) => !ref.startsWith("./") && !ref.startsWith("$/"));

// The faults of one workflow: a ref not at a full SHA, no # vX.Y.Z comment, or a ref actions.lock does not key
// with that commit under this workflow.
function pinFaults(file, yml, lockText) {
  const listed = lockText.split(/^ {4}'/m).find((b) => b.startsWith(`${file}':`)) ?? "";
  const faults = [];
  for (const [, ref, rest] of remote(yml)) {
    if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) faults.push(`${ref}: not a full commit SHA`);
    if (!/^ # v\d+\.\d+\.\d+$/.test(rest)) faults.push(`${ref}: no # vX.Y.Z comment for Dependabot`);
    const sha = ref.split("@")[1];
    if (!new RegExp(`^ {4}'${ref.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}':\\n {8}ref: '[^']+'\\n {8}commit: 'sha1-${sha}'$`, "m").test(lockText)) faults.push(`${ref}: not keyed in actions.lock`);
    if (!listed.includes(`- '${ref}'`)) faults.push(`${ref}: not listed under ${file} in actions.lock`);
  }
  return faults;
}

test("verify.yml runs GitHub's dependency review on a pull request only", () => {
  const yml = read(".github/workflows/verify.yml");
  const job = yml.slice(yml.indexOf("\n  dependency-review:\n"));
  assert.ok(job.length > 1, "a dependency-review job");
  assert.match(job, /^ {4}if: github\.event_name == 'pull_request'$/m);
  assert.match(job, /^ {6}- uses: actions\/dependency-review-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m);
});

for (const name of ["ci-standard.yml", "ci-overflow.yml", "verify.yml"]) {
  test(`${name} pins each remote step by full SHA with its version comment, and actions.lock keys it`, () => {
    const file = `.github/workflows/${name}`;
    const yml = read(file);
    assert.ok(remote(yml).length >= 1, "it has remote steps to check");
    assert.deepEqual(pinFaults(file, yml, lock), []);
  });
}

test("a tag pin fails, even one actions.lock records", () => {
  const file = ".github/workflows/ci-standard.yml";
  const tagged = read(file).replace(/actions\/checkout@[0-9a-f]{40} # v7\.0\.1/, "actions/checkout@v7.0.1");
  assert.ok(pinFaults(file, tagged, lock).includes("actions/checkout@v7.0.1: not a full commit SHA"));
  const bare = read(file).replace(/(actions\/setup-node@[0-9a-f]{40}) # v7\.1\.0/, "$1");
  assert.ok(pinFaults(file, bare, lock).some((f) => f.endsWith("no # vX.Y.Z comment for Dependabot")));
  const unkeyed = read(file).replace(/actions\/setup-python@[0-9a-f]{40}/, `actions/setup-python@${"0".repeat(40)}`);
  assert.ok(pinFaults(file, unkeyed, lock).some((f) => f.endsWith("not keyed in actions.lock")));
});
