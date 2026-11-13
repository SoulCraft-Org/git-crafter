import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
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
  for (const mode of ["record", "replay"]) assert.equal(gh(mode, "api", "repos/o/r/runs"), "real api repos/o/r/runs\n");
  gh("replay", "api", "repos/o/r/pulls/7/files");
  assert.equal(readFileSync(path.join(tmp, "calls"), "utf8"), "x\nx\n", "the replay and nothing else stayed off gh");
  assert.equal(summary(readFileSync(path.join(tmp, "save.log"), "utf8").trim().split("\n").map((l) => l.split(" ")), "replay"), "live 2 REST, 0 GraphQL; 1 replayed from main (replay)");
});
