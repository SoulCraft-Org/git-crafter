import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { keyOf, readOnly, summary, writeShim } from "./gh-replay.mjs";
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
it("gh-replay setup on a pull request replays the newest push or schedule run on main, else the next under 24 h old (#61)", () => {
  const [at, old] = [0, 25].map((h) => new Date(Date.now() - h * 3_600_000).toISOString().slice(0, 19) + "Z");
  const runs = { workflow_runs: [["workflow_dispatch", 3, at], ["schedule", 2, at], ["push", 1, at], ["push", 0, old]].map(([event, id, t]) => ({ id, event, updated_at: t, head_repository: { full_name: "o/r" } })) };
  // [the run that holds a save, the run replayed, the REST requests logged]
  for (const [saved, chosen, rest] of [[2, "run 2", 3], [1, "run 1", 4], [0, "none", 3]]) {
    const tmp = mkdtempSync(path.join(tmpdir(), "gh-replay-"));
    writeFileSync(path.join(tmp, "runs.json"), JSON.stringify(runs));
    writeFileSync(path.join(tmp, "gh"), `#!/bin/sh\necho "$*" >> "${tmp}/calls"\nif [ "$1" = api ]; then jq -r "$4" "${tmp}/runs.json"; else [ "$3" = ${saved} ]; fi\n`, { mode: 0o755 });
    writeFileSync(path.join(tmp, "event.json"), JSON.stringify({ pull_request: { number: 7, head: { sha: "abc" } } }));
    const files = Object.fromEntries(["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT"].map((k) => [k, path.join(tmp, k)]));
    const env = { ...process.env, ...files, PATH: `${tmp}:${process.env.PATH}`, RUNNER_TEMP: tmp, GITHUB_EVENT_PATH: path.join(tmp, "event.json"), GITHUB_REPOSITORY: "o/r", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/pages.yml@refs/pull/7/merge" };
    const out = spawnSync(process.execPath, [fileURLToPath(new URL("gh-replay.mjs", import.meta.url)), "setup"], { env }).stdout.toString();
    assert.match(out, new RegExp(`main save under 24 h old: ${chosen}$`, "m"), `save in run ${saved}: the dispatch run and the 25 h old run are never tried`);
    const calls = readFileSync(path.join(tmp, "calls"), "utf8").trim().split("\n");
    assert.deepEqual(calls.map((l) => l.split(" ").slice(0, 3).join(" ")), ["api repos/o/r/actions/workflows/pages.yml/runs?branch=main&status=success&per_page=10 --jq", "run download 2", ...(saved === 2 ? [] : ["run download 1"])]);
    assert.equal(readFileSync(path.join(tmp, "gh-replay.log"), "utf8"), `rest ${rest}\n`);
  }
});
