// The reusable CI workflows pin each remote step by full SHA (#8). A caller whose Actions policy requires SHA pins
// refuses a tag at job setup, inside a reusable workflow as in the pages action. gh actions-lock's fix mode rewrites
// these to tags; this test fails if a relock does. Named pages-* so tools/verify.sh's pages suite runs it.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  // What fails a PR is stated (#61): a fail-on-severity input, or the job comment names the action's default.
  const comment = yml.slice(yml.lastIndexOf("\n\n", yml.indexOf("\n  dependency-review:\n")), yml.indexOf("\n  dependency-review:\n"));
  assert.ok(/^ {10}fail-on-severity: (low|moderate|high|critical)$/m.test(job) || /fail-on-severity low/.test(comment), "the threshold that fails a PR is named");
});

test("scorecard.yml runs weekly, publishes its result and uploads no SARIF", () => {
  const yml = read(".github/workflows/scorecard.yml");
  const on = yml.slice(yml.indexOf("\non:\n"), yml.indexOf("\npermissions:"));
  assert.match(on, /^ {2}schedule:\n {4}- cron: "\d+ \d+ \* \* [0-6]"$/m, "once a week");
  assert.doesNotMatch(on, /pull_request|push:/, "never on a pull request or a push");
  assert.match(yml, /^ {10}publish_results: true$/m);
  assert.doesNotMatch(yml, /uses: github\/codeql-action|security-events: write|results_format: sarif/, "no code scanning upload, so no new alerts");
  assert.doesNotMatch(yml, /^\s+run:/m, "only the two actions, as Scorecard's publish check expects");
});

test("wiki.yml and the adopter's templates/ci/wiki.yml are the same from on: down; only the header comment differs", () => {
  const body = (yml) => yml.slice(yml.indexOf("\non:\n"));
  const [ours, theirs] = [read(".github/workflows/wiki.yml"), read("templates/ci/wiki.yml")];
  assert.ok(ours.includes("\non:\n") && theirs.includes("\non:\n"), "both have an on: block");
  assert.equal(body(theirs), body(ours));
  assert.match(ours, /^ {6}contents: write$/m, "write on the job");
  assert.match(ours, /^permissions:\n {2}contents: read$/m, "read at the top");
  // The one expression is the token's env line, so none reaches the shell; git only, so no API request.
  assert.deepEqual([...ours.matchAll(/^.*\$\{\{.*$/gm)].map(([line]) => line.trim()), ["WIKI_TOKEN: ${{ github.token }}"]);
  assert.doesNotMatch(body(ours), /https:\/\/[^\s"]*@|\bgh |curl |wget /, "no token in a URL, no API call");
});

// Every workflow file (#61), so a new one is checked without a change here.
const workflows = readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((n) => /\.ya?ml$/.test(n)).sort();

test("the pin check reads the workflows that call remote actions", () => {
  const withRemote = workflows.filter((n) => remote(read(`.github/workflows/${n}`)).length);
  for (const name of ["ci-standard.yml", "pages.yml", "scorecard.yml"]) assert.ok(withRemote.includes(name), name);
});

for (const name of workflows) {
  test(`${name} pins each remote step by full SHA with its version comment, and actions.lock keys it`, () => {
    const file = `.github/workflows/${name}`;
    assert.deepEqual(pinFaults(file, read(file), lock), []);
  });
}

// Docker actions pinned by commit, and the image each pinned commit's action.yml pulls (#202). The commit fixes
// action.yml, not the image its tag names, so each is a gap THREAT-MODEL.md records. A bump fails here until
// someone reads the new commit's action.yml. Scorecard's server refuses a digest-pinned step, so the tag stays.
const DOCKER_ACTIONS = { "ossf/scorecard-action": { "fa7117db83c52d787ae5a89f350999701505d78e": "ghcr.io/ossf/scorecard-action:v2.5.0" } };

// The faults of one file: a docker:// step with no digest, or a Docker action whose pulled image is unread or unrecorded.
function dockerFaults(file, yml, model) {
  const faults = [];
  for (const [, ref] of remote(yml)) {
    const [name, sha] = ref.split("@");
    if (ref.startsWith("docker://") && !/@sha256:[0-9a-f]{64}$/.test(ref)) faults.push(`${file}: ${ref} names no digest`);
    if (!DOCKER_ACTIONS[name]) continue;
    const image = DOCKER_ACTIONS[name][sha];
    if (!image) faults.push(`${file}: ${ref} is a Docker action at a commit whose image is unread`);
    else if (!model.includes(`\`${image}\``)) faults.push(`${file}: ${image} is pulled by tag and THREAT-MODEL.md does not record it`);
  }
  return faults;
}

const templates = readdirSync(new URL("../templates/ci/", import.meta.url)).filter((n) => /\.ya?ml$/.test(n)).map((n) => `templates/ci/${n}`);

test("a docker:// step names a digest, and a Docker action's tag image is a recorded gap", () => {
  const model = read("THREAT-MODEL.md");
  for (const file of [...workflows.map((n) => `.github/workflows/${n}`), ...templates]) assert.deepEqual(dockerFaults(file, read(file), model), []);
  const yml = read(".github/workflows/scorecard.yml");
  assert.ok(dockerFaults("x", "      - uses: docker://ghcr.io/o/a:v1\n", model).some((f) => f.endsWith("names no digest")));
  assert.deepEqual(dockerFaults("x", `      - uses: docker://ghcr.io/o/a@sha256:${"0".repeat(64)}\n`, model), []);
  assert.ok(dockerFaults("x", yml.replace(/scorecard-action@[0-9a-f]{40}/, `scorecard-action@${"1".repeat(40)}`), model).some((f) => f.endsWith("image is unread")));
  assert.ok(dockerFaults("x", yml, "").some((f) => f.endsWith("does not record it")));
});

test("a tag pin fails, even one actions.lock records", () => {
  const file = ".github/workflows/ci-standard.yml";
  const tagged = read(file).replace(/actions\/checkout@[0-9a-f]{40} # v7\.0\.1/, "actions/checkout@v7.0.1");
  assert.ok(pinFaults(file, tagged, lock).includes("actions/checkout@v7.0.1: not a full commit SHA"));
  const bare = read(file).replace(/(actions\/setup-node@[0-9a-f]{40}) # v7\.1\.0/, "$1");
  assert.ok(pinFaults(file, bare, lock).some((f) => f.endsWith("no # vX.Y.Z comment for Dependabot")));
  const unkeyed = read(file).replace(/actions\/setup-python@[0-9a-f]{40}/, `actions/setup-python@${"0".repeat(40)}`);
  assert.ok(pinFaults(file, unkeyed, lock).some((f) => f.endsWith("not keyed in actions.lock")));
});

test("branch-cleanup.yml sweeps on a schedule, not on every pull request close", () => {
  const yml = read(".github/workflows/branch-cleanup.yml");
  const on = yml.slice(yml.indexOf("\non:\n"), yml.indexOf("\npermissions:"));
  assert.match(on, /^ {2}schedule:\n {4}- cron: "\d+ \d+ \* \* \*"$/m, "once a day");
  assert.doesNotMatch(on, /pull_request|push:/, "a merge starts no run that skips itself (ci.light_run_share)");
  assert.doesNotMatch(yml, /^\s*-?\s*uses:/m, "no action and no checkout step");
  assert.match(yml, /merged_at == null/, "only a pull request closed without merging");
  assert.match(yml, /\[!A-Za-z0-9\._\/-\]/, "a branch name from the API passes a character check before it joins a path");
  assert.doesNotMatch(yml, /\$\{\{\s*github\.event\.pull_request/, "no event text reaches the shell");
});

test("branch-cleanup.yml never deletes main, cards, quality-history or the default branch, whatever protected says", () => {
  const yml = read(".github/workflows/branch-cleanup.yml");
  const script = yml.slice(yml.indexOf("        run: |\n") + "        run: |\n".length).replace(/^ {10}/gm, "");
  const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
  try {
    // A gh that lists these closed pull requests, calls every branch unprotected and at its head, and records each delete.
    const names = ["main", "cards", "quality-history", "trunk", "claude/ok"];
    const sha = (n) => n.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const listed = names.map((n) => `${n}\t${sha(n)}`).join("\n");
    writeFileSync(join(dir, "list"), listed + "\n");
    writeFileSync(join(dir, "gh"), `#!/bin/bash
a="$*"
case "$a" in
  "api repos/R --jq .default_branch") echo trunk;;
  *"state=closed"*) cat "${dir}/list";;
  *"/branches/"*) echo false;;
  *"/git/ref/heads/"*) b="\${a##*heads/}"; b="\${b%% *}"; echo "$b" | tr a-z A-Z | tr -cd 'A-Z0-9';;
  *"state=open"*) echo 0;;
  *"-X DELETE"*) echo "$a" >> "${dir}/deletes";;
esac
`, { mode: 0o755 });
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: "R", GITHUB_STEP_SUMMARY: "/dev/null", OWNER: "o" } });
    assert.equal(r.status, 0, r.stderr);
    const deleted = readFileSync(join(dir, "deletes"), "utf8");
    assert.match(deleted, /heads\/claude\/ok/, "an ordinary branch is still deleted");
    for (const n of ["main", "cards", "quality-history", "trunk"]) assert.doesNotMatch(deleted, new RegExp(`heads/${n}( |$)`, "m"), n);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(yml, /case "\$BRANCH" in main\|cards\|quality-history\|"\$DEFAULT_BRANCH"\) /, "the guard is one case before the protection read");
});

test("claude-review.yml is gone from this repo; the adopters' template stays", () => {
  assert.ok(!workflows.includes("claude-review.yml"));
  assert.ok(templates.includes("templates/ci/claude-review.yml"));
});
