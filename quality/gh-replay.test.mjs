import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { familyOf, immutable, keyOf, readOnly, saveRuns, summary, topReads, writeShim } from "./gh-replay.mjs";
it("gh-replay replays reads only, never a write or a mutation", () => {
  for (const a of [["api", "repos/o/r/pulls"], ["api", "graphql", "-f", "query=query { viewer { login } }"], ["pr", "list"], ["api", "x", "-X", "GET"]]) assert.ok(readOnly(a), a.join(" "));
  for (const a of [["api", "x", "-f", "a=1"], ["api", "x", "--method=POST"], ["api", "x", "-X", "PATCH"], ["api", "x", "--input", "-"], ["api", "graphql", "-f", "query=mutation { a }"], ["pr", "merge"], ["run", "download"]]) assert.ok(!readOnly(a), a.join(" "));
  const [now, at] = [Date.parse("2026-11-12T10:00:00Z"), (t) => [`created=${new Date(t - 7 * 86_400_000).toISOString()}..${new Date(t).toISOString()}`, `since=${new Date(t).toISOString().slice(0, 10)}`]];
  assert.equal(keyOf(at(now), now), keyOf(at(now + 86_400_000), now + 86_400_000), "a clock-relative window keys the same a day later");
});
it("gh-replay records on main, then a pull request replays it without calling gh, and counts both", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gh-replay-"));
  writeFileSync(path.join(tmp, "real"), `#!/bin/sh\necho "real $*"; echo x >> "${tmp}/calls"\n`, { mode: 0o755 });
  mkdirSync(path.join(tmp, "save", "r"), { recursive: true });
  writeShim(tmp);
  const env = (mode) => ({ ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, GH_REPLAY_REAL: path.join(tmp, "real"), GH_REPLAY_DIR: path.join(tmp, "save"), GH_REPLAY_MODE: mode, GH_REPLAY_LIVE: "pulls/7" });
  const gh = (mode, ...args) => spawnSync(path.join(tmp, "gh"), args, { env: env(mode) }).stdout.toString();
  for (const mode of ["record", "replay"]) assert.equal(gh(mode, "api", "repos/o/r/actions/runs"), "real api repos/o/r/actions/runs\n"), ["dependabot/alerts", "actions/cache/storage-limit", "made/up"].forEach((p) => gh(mode, "api", `repos/o/r/${p}`));
  gh("replay", "api", "repos/o/r/pulls/7/files");
  assert.equal(readdirSync(path.join(tmp, "save", "r")).length, 1, "only a PUBLIC family is saved: dependabot, the cache limit and an unlisted path wrote none");
  assert.equal(readFileSync(path.join(tmp, "calls"), "utf8"), "x\n".repeat(8), "only the public read replayed; the three unsaved reads and the PR's own read ran live");
  assert.equal(summary(readFileSync(path.join(tmp, "save.log"), "utf8").trim().split("\n").map((l) => l.split(" ")), "replay"), "live 8 REST, 0 GraphQL; 1 replayed from main (replay)");
});
it("gh-replay refuses -XPOST and --method=POST, saves no climbing path or token-only field, counts each page and reads a bad save live (#42)", () => {
  for (const a of [["api", "x", "-XPOST"], ["api", "x", "-X=PUT"], ["api", "x", "-iXDELETE"], ["api", "x", "--method", "POST"], ["api", "x", "--method=post"]]) assert.ok(!readOnly(a), a.join(" "));
  for (const a of [["api", "x", "--input=body.json"], ...["-fquery=mutation { a }", "-Fquery=mutation { a }", "--field=query=mutation { a }", "--raw-field=query=mutation { a }"].map((f) => ["api", "graphql", f])]) assert.ok(!readOnly(a), a.join(" "));
  assert.ok(readOnly(["api", "x", "-XGET"]));
  const hidden = ["query=# c\nmutation { a }", "query=query A { b } mutation B { a }", "query=@q.graphql"];
  for (const a of [...hidden.flatMap((q) => [["-f", q], ["-F", q], ["--field", q], [`-F${q}`]]), ["--raw-field=query=@q.graphql"]]) assert.ok(!readOnly(["api", "graphql", ...a]), a.join(" "));
  assert.ok(readOnly(["api", "graphql", "-f", "query=query { a { clientMutationId } }"]), "a field that holds the word in camel case still reads");
  const tmp = mkdtempSync(path.join(tmpdir(), "gh-replay-"));
  const trace = `printf '* Request at t\\n* Request to https://api.github.com/a\\n* Request took 1ms\\n'; case "$*" in *--paginate*) printf '* Request to https://api.github.com/a?page=2\\n';; esac`;
  writeFileSync(path.join(tmp, "real"), `#!/bin/sh\n{ ${trace}; echo "debug $GH_DEBUG"; } >&2; echo "real $*"\n`, { mode: 0o755 });
  mkdirSync(path.join(tmp, "save", "r"), { recursive: true });
  writeShim(tmp);
  const env = (mode) => ({ ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`, GH_REPLAY_REAL: path.join(tmp, "real"), GH_REPLAY_DIR: path.join(tmp, "save"), GH_REPLAY_MODE: mode });
  const gh = (mode, ...args) => spawnSync(path.join(tmp, "gh"), args, { env: env(mode) });
  for (const p of ["commits/../actions/cache/storage-limit", "commits/%2E%2E/x", "contents/./x"]) gh("record", "api", `repos/o/r/${p}`);
  gh("record", "api", "graphql", "-f", 'query=query { repository(owner: "o", name: "r") { viewerPermission } }');
  assert.equal(readdirSync(path.join(tmp, "save", "r")).length, 0, "a dot segment, an encoded dot and a token-only GraphQL field are never saved");
  const paged = gh("count", "api", "repos/o/r/tags", "--paginate", "--jq", ".[]");
  assert.equal(paged.stderr.toString(), "debug 1\n", "the request trace is cut from stderr");
  const bodies = [["labels", "{not json"], ["releases", '{"out":"cmVhbA==","err":5,"status":0}'], ["commits", '{"out":"cmVhbA==","err":"","status":1.5}'], ["pulls", '{"out":"cmVhbA==","err":"","status":"0"}'], ["issues", "null"], ["git", "[]"]];
  for (const [p, body] of bodies) {
    writeFileSync(path.join(tmp, "save", "r", `${keyOf(["api", `repos/o/r/${p}`])}.json`), body);
    const bad = gh("replay", "api", `repos/o/r/${p}`);
    assert.deepEqual([bad.status, bad.stdout.toString()], [0, `real api repos/o/r/${p}\n`], `an unreadable save reads live: ${body}`);
  }
  const rows = readFileSync(path.join(tmp, "save.log"), "utf8").trim().split("\n");
  assert.deepEqual(rows.slice(-13), ["rest 2", ...Array(6).fill(["unreadable 1", "rest 1"]).flat()], "two pages count 2; each bad save is logged");
  const report = spawnSync(process.execPath, [fileURLToPath(new URL("gh-replay.mjs", import.meta.url)), "report"], { env: env("replay"), cwd: tmp }).stdout.toString();
  assert.match(report, /::warning title=GitHub requests::6 saved reads from main were unreadable/);
});
it("gh-replay saveRuns takes the two newest main saves under 24 h old, a failed run's included, never a branch's, an expired or a stale one (#38)", () => {
  const [now, ago] = [Date.parse("2026-11-23T12:00:00Z"), (h) => new Date(Date.parse("2026-11-23T12:00:00Z") - h * 3_600_000).toISOString()];
  const save = (id, h, extra = {}) => ({ expired: false, created_at: ago(h), workflow_run: { id, head_branch: "main" }, ...extra });
  const listing = [save(1, 30), save(2, 5), save(3, 1), save(4, 0.5, { expired: true }), { ...save(5, 0.2), workflow_run: { id: 5, head_branch: "claude/x" } }];
  assert.deepEqual(saveRuns(listing, now), ["3", "2"]);
  assert.deepEqual(saveRuns(listing, now, 1), ["3"]);
  assert.deepEqual(saveRuns([], now), []);
});
it("gh-replay setup on a pull request replays the newest main save, tops a failed run's reads up from the next, and logs each request (#38)", () => {
  const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  const art = (id, h) => ({ expired: false, created_at: ago(h), workflow_run: { id, head_branch: "main" } });
  const listing = { artifacts: [art(3, 1), art(2, 2), art(1, 25)] };
  // [the runs that hold a save, the line printed, the requests logged, the calls after the listing]
  const cases = [
    [{ 3: ["r/x.json:new", "r/y.json:y", "latest.json:3"], 2: ["r/x.json:old"] }, "run 3", 3, ["run download 3"]],
    [{ 3: ["r/x.json:new", "r/y.json:y"], 2: ["r/x.json:old", "r/z.json:z", "latest.json:2"] }, "run 3 + 2", 5, ["run download 3", "run download 2"]],
    [{ 2: ["r/z.json:z", "latest.json:2"] }, "run 2", 4, ["run download 3", "run download 2"]],
    [{}, "none", 3, ["run download 3", "run download 2"]],
  ];
  for (const [saves, chosen, rest, after] of cases) {
    const tmp = mkdtempSync(path.join(tmpdir(), "gh-replay-"));
    writeFileSync(path.join(tmp, "listing.json"), JSON.stringify(listing));
    for (const [run, files] of Object.entries(saves)) for (const f of files) {
      const [name, body] = f.split(":");
      mkdirSync(path.dirname(path.join(tmp, `save-${run}`, name)), { recursive: true });
      writeFileSync(path.join(tmp, `save-${run}`, name), body);
    }
    const fake = ["#!/bin/sh", `echo "$*" >> "${tmp}/calls"`, `if [ "$1" = api ]; then cat "${tmp}/listing.json"; exit 0; fi`, "run=$3", `[ -d "${tmp}/save-$run" ] || exit 1`, 'while [ $# -gt 0 ]; do [ "$1" = -D ] && into=$2; shift; done', `mkdir -p "$into" && cp -R "${tmp}/save-$run/." "$into"`, ""].join("\n");
    writeFileSync(path.join(tmp, "gh"), fake, { mode: 0o755 });
    writeFileSync(path.join(tmp, "event.json"), JSON.stringify({ pull_request: { number: 7, head: { sha: "abc" } } }));
    const files = Object.fromEntries(["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT"].map((k) => [k, path.join(tmp, k)]));
    const env = { ...process.env, ...files, PATH: `${tmp}:${process.env.PATH}`, RUNNER_TEMP: tmp, GITHUB_EVENT_PATH: path.join(tmp, "event.json"), GITHUB_REPOSITORY: "o/r", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/pages.yml@refs/pull/7/merge" };
    const out = spawnSync(process.execPath, [fileURLToPath(new URL("gh-replay.mjs", import.meta.url)), "setup"], { env }).stdout.toString();
    assert.ok(out.includes(`main save under 24 h old: ${chosen}\n`), out);
    const calls = readFileSync(path.join(tmp, "calls"), "utf8").trim().split("\n");
    assert.deepEqual(calls.map((l) => l.split(" ").slice(0, 3).join(" ")), ["api repos/o/r/actions/artifacts?name=main-reads&per_page=10", ...after]);
    assert.equal(readFileSync(path.join(tmp, "gh-replay.log"), "utf8"), `rest ${rest}\n`);
    const read = (f) => (existsSync(path.join(tmp, "gh-replay", f)) ? readFileSync(path.join(tmp, "gh-replay", f), "utf8") : null);
    if (chosen === "run 3 + 2") assert.deepEqual(["r/x.json", "r/y.json", "r/z.json", "latest.json"].map(read), ["new", "y", "z", "2"], "the newer save wins; the older one adds only what it lacks");
    assert.match(readFileSync(path.join(tmp, "GITHUB_OUTPUT"), "utf8"), chosen === "none" ? /latest=false/ : /latest=true/);
  }
});
it("gh-replay report saves main's scored run only from a run that passed (#38)", () => {
  for (const [status, saved] of [["success", true], ["failure", false]]) {
    const tmp = mkdtempSync(path.join(tmpdir(), "gh-replay-"));
    mkdirSync(path.join(tmp, "save"), { recursive: true });
    mkdirSync(path.join(tmp, "data", "quality"), { recursive: true });
    writeFileSync(path.join(tmp, "data", "quality", "latest.json"), "{}");
    const run = { ...process.env, GH_REPLAY_DIR: path.join(tmp, "save"), GH_REPLAY_MODE: "record", GH_REPLAY_JOB_STATUS: status };
    spawnSync(process.execPath, [fileURLToPath(new URL("gh-replay.mjs", import.meta.url)), "report"], { env: run, cwd: tmp });
    assert.equal(existsSync(path.join(tmp, "save", "latest.json")), saved, status);
  }
});
const api = (route) => ["api", `repos/o/r/${route}`];
const JOBS = "actions/runs/5/jobs?per_page=100";
it("gh-replay immutable names the reads that cannot change: a commit, annotations, and the jobs or attempt of a run that ended 30 minutes ago (#38)", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");
  const done = (min) => ({ status: "completed", completed_at: new Date(now - min * 60_000).toISOString() });
  const jobs = (...js) => JSON.stringify({ total_count: js.length, jobs: js });
  assert.ok(immutable(api(JOBS), jobs(done(40), done(90)), now));
  assert.ok(!immutable(api(JOBS), jobs(done(40), done(5)), now), "one job ended 5 minutes ago: a rerun or a late job may still change it");
  assert.ok(!immutable(api(JOBS), jobs(done(40), { status: "in_progress" }), now));
  assert.ok(!immutable(api(JOBS), jobs(), now) && !immutable(api(JOBS), JSON.stringify({ total_count: 150, jobs: [done(40)] }), now), "no jobs, or more than one page");
  const attempt = (status, min) => JSON.stringify({ status, updated_at: new Date(now - min * 60_000).toISOString() });
  assert.ok(immutable(api("actions/runs/5/attempts/1"), attempt("completed", 60), now));
  assert.ok(!immutable(api("actions/runs/5/attempts/1"), attempt("in_progress", 60), now) && !immutable(api("actions/runs/5/attempts/1"), attempt("completed", 2), now));
  assert.ok(immutable(api(`git/commits/${"a".repeat(40)}`), '{"sha":"a"}', now) && !immutable(api("git/commits/main"), '{"sha":"a"}', now));
  assert.ok(immutable(api("check-runs/9/annotations"), "[]", now));
  for (const route of ["pulls", "actions/runs/5", "actions/runs", "commits/main", "community/profile"]) assert.ok(!immutable(api(route), '{"sha":"a","status":"completed"}', now), route);
  assert.ok(!immutable([...api(JOBS), "--jq", ".jobs"], jobs(done(40)), now) && !immutable(api(JOBS), "not json", now), "a plain route with JSON only");
  assert.equal(familyOf(api(JOBS)), "actions/runs/{}/jobs");
  assert.equal(familyOf(api(`git/commits/${"b".repeat(40)}`)), "git/commits/{}");
  assert.equal(topReads([["a/{}", "3"], ["pulls", "5"], ["a/{}", "4"], ["tags", "1"]], 2), "a/{} 7, pulls 5");
});
it("gh-replay on main carries immutable reads from its last save, reads the rest live, and counts each family (#38)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gh-replay-"));
  const body = JSON.stringify({ total_count: 1, jobs: [{ status: "completed", completed_at: "2026-01-01T00:00:00Z" }] });
  writeFileSync(path.join(tmp, "real"), `#!/bin/sh\necho x >> "${tmp}/calls"\necho '${body}'\n`, { mode: 0o755 });
  const [save, prev] = ["save", "prev"].map((d) => path.join(tmp, d));
  for (const d of [save, prev]) mkdirSync(path.join(d, "r"), { recursive: true });
  const old = (h) => Date.now() - h * 3_600_000;
  const jobs = (n) => api(`actions/runs/${n}/jobs?per_page=100`);
  const carried = [[jobs(1), { immutable: true, at: old(2) }], [jobs(2), { immutable: true, at: old(25) }], [api("pulls"), {}]];
  for (const [args, extra] of carried) writeFileSync(path.join(prev, "r", `${keyOf(args)}.json`), JSON.stringify({ args, out: Buffer.from(body).toString("base64"), err: "", status: 0, ...extra }));
  const run = { ...process.env, GH_REPLAY_REAL: path.join(tmp, "real"), GH_REPLAY_DIR: save, GH_REPLAY_MODE: "record", GH_REPLAY_PREV: prev };
  const gh = (args) => spawnSync(process.execPath, [fileURLToPath(new URL("gh-replay.mjs", import.meta.url)), "shim", ...args], { env: run });
  for (const [args] of carried) gh(args);
  assert.equal(readFileSync(path.join(tmp, "calls"), "utf8"), "x\nx\n", "the fresh immutable read replayed; the day-old one and the plain list ran live");
  const read = (args) => JSON.parse(readFileSync(path.join(save, "r", `${keyOf(args)}.json`), "utf8"));
  assert.deepEqual([read(jobs(1)).immutable, read(jobs(1)).at === carried[0][1].at, read(jobs(2)).immutable, read(jobs(2)).at > old(1), read(api("pulls")).immutable], [true, true, true, true, undefined], "a carried read keeps its first time; a fresh one is stamped");
  assert.equal(readFileSync(`${save}.log`, "utf8"), "replayed 1\nrest 1\nrest 1\n");
  assert.equal(readFileSync(`${save}.reads`, "utf8"), "actions/runs/{}/jobs 1\npulls 1\n");
  const report = spawnSync(process.execPath, [fileURLToPath(new URL("gh-replay.mjs", import.meta.url)), "report"], { env: run, cwd: tmp }).stdout.toString();
  assert.match(report, /::notice title=GitHub requests::live 2 REST, 0 GraphQL; 1 replayed from main \(record\)/);
  assert.match(report, /::notice title=GitHub requests by read::actions\/runs\/\{\}\/jobs 1, pulls 1/);
});
it("gh-replay setup on main keeps the last save apart, for its immutable reads, and the page still builds from live scores (#38)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "gh-replay-"));
  mkdirSync(path.join(tmp, "save-2", "r"), { recursive: true });
  writeFileSync(path.join(tmp, "save-2", "latest.json"), "{}");
  writeFileSync(path.join(tmp, "listing.json"), JSON.stringify({ artifacts: [{ expired: false, created_at: new Date().toISOString(), workflow_run: { id: 2, head_branch: "main" } }] }));
  writeFileSync(path.join(tmp, "gh"), `#!/bin/sh\nif [ "$1" = api ]; then cat "${tmp}/listing.json"; exit 0; fi\nwhile [ $# -gt 0 ]; do [ "$1" = -D ] && into=$2; shift; done\nmkdir -p "$into" && cp -R "${tmp}/save-2/." "$into"\n`, { mode: 0o755 });
  writeFileSync(path.join(tmp, "event.json"), "{}");
  const files = Object.fromEntries(["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT"].map((k) => [k, path.join(tmp, k)]));
  const run = { ...process.env, ...files, PATH: `${tmp}:${process.env.PATH}`, RUNNER_TEMP: tmp, GITHUB_EVENT_PATH: path.join(tmp, "event.json"), GITHUB_EVENT_NAME: "push", GITHUB_REF: "refs/heads/main", GITHUB_REPOSITORY: "o/r" };
  spawnSync(process.execPath, [fileURLToPath(new URL("gh-replay.mjs", import.meta.url)), "setup"], { env: run });
  assert.match(readFileSync(files.GITHUB_ENV, "utf8"), new RegExp(`GH_REPLAY_MODE=record\\n.*GH_REPLAY_PREV=${path.join(tmp, "gh-replay-prev")}\\n`, "s"));
  assert.ok(existsSync(path.join(tmp, "gh-replay-prev", "latest.json")) && !existsSync(path.join(tmp, "gh-replay", "latest.json")), "the last save sits beside, never in the folder main uploads");
  assert.match(readFileSync(files.GITHUB_OUTPUT, "utf8"), /latest=false/);
  assert.equal(readFileSync(path.join(tmp, "gh-replay.log"), "utf8"), "rest 3\n");
});
