// The org-page reads of every repo run side by side: drive (tools/org_fetch.mjs) advances them in lockstep.
// Run with: node --test tests/pages-drive.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { drive, ghClient } from "../tools/org_fetch.mjs";
import { runManySettled } from "../tools/org_many.mjs";

// A job that asks for `n` graphql reads one after another and returns the answers joined.
function* job(name, n) {
  const got = [];
  for (let i = 0; i < n; i += 1) got.push(yield { graphql: [`${name}${i}`, {}] });
  return got.join(",");
}

test("runManySettled keeps the order and one failure does not stop the other reads", () => {
  const ok = (n) => ["-e", `process.stdout.write(${JSON.stringify(String(n))})`];
  const bad = ["-e", "process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1)"];
  const got = runManySettled(process.execPath, [ok(1), bad, ok(3)], { limit: 2 });
  assert.deepEqual([got[0].out, got[2].out], ["1", "3"]);
  assert.match(got[1].err.stderr, /HTTP 404/);
});

test("drive sends every job's next read in one batch, and reads the rest in the same rounds", () => {
  const rounds = [];
  // A round with one read in it goes through the plain gh.graphql, so every round shows in `rounds` either way.
  const gh = { many: (units) => (rounds.push(units.map((u) => u.graphql[0])), units.map((u) => ({ value: u.graphql[0] }))), graphql: (q) => (rounds.push([q]), q) };
  const out = drive(gh, [job("a", 2), job("b", 3), job("c", 1)]);
  assert.deepEqual(rounds, [["a0", "b0", "c0"], ["a1", "b1"], ["b2"]], "three rounds, the finished jobs dropping out");
  assert.deepEqual(out.map((r) => r.value), ["a0,a1", "b0,b1,b2", "c0"], "answers in the order of the jobs");
});

test("a read that fails ends its own job only, and the error reaches that job", () => {
  const gh = { many: (units) => units.map((u) => (u.graphql[0] === "b0" ? { error: Object.assign(new Error("HTTP 404"), { stderr: "Not Found" }) } : { value: u.graphql[0] })), graphql: (q) => q };
  const out = drive(gh, [job("a", 2), job("b", 2)]);
  assert.equal(out[0].value, "a0,a1");
  assert.match(out[1].error.message, /HTTP 404/);
  // A job can catch the error thrown into it, as readHistory does for GitHub's resource limits.
  function* tolerant() {
    try {
      return yield { graphql: ["b0", {}] };
    } catch {
      return yield { graphql: ["retry", {}] };
    }
  }
  assert.equal(drive(gh, [job("a", 1), tolerant()])[1].value, "retry");
});

test("a batch that fails as a whole fails each job in it, and the others still finish", () => {
  const gh = { many: () => { throw new Error("runMany: spawn failed"); }, graphql: (q) => q };
  const out = drive(gh, [job("a", 1), job("b", 1)]);
  assert.deepEqual(out.map((r) => r.error?.message), ["runMany: spawn failed", "runMany: spawn failed"]);
  assert.equal(drive(gh, [job("c", 1)])[0].value, "c0", "a lone read does not use the batch");
});

test("a rest read answers one value per path, and a number waits once for every job", () => {
  const waits = [];
  const gh = { many: (units) => units.map((u) => ({ value: u.rest })) };
  function* pages() {
    return yield { rest: ["p1", "p2"], jq: "." };
  }
  function* napper(ms) {
    yield ms;
    return `slept ${ms}`;
  }
  const out = drive(gh, [pages(), pages(), napper(30), napper(50)], (ms) => waits.push(ms));
  assert.deepEqual(out.map((r) => r.value), [["p1", "p2"], ["p1", "p2"], "slept 30", "slept 50"]);
  assert.deepEqual(waits, [50], "one wait, the longest");
});

test("without many, or with one read in a round, each read goes through the plain gh", () => {
  const seen = [];
  const gh = { graphql: (q) => (seen.push(q), q), restMany: (paths) => (seen.push(paths.join("+")), paths) };
  function* both() {
    const g = yield { graphql: ["q", {}] };
    const r = yield { rest: ["x", "y"], jq: "." };
    return [g, r];
  }
  assert.deepEqual(drive(gh, [both(), job("z", 1)])[0].value, ["q", ["x", "y"]]);
  assert.deepEqual(seen, ["q", "z0", "x+y"]);
});

test("ghClient.many with a stand-in exec reads one by one and settles each", () => {
  const seq = [];
  const gh = ghClient((cmd, args) => {
    seq.push(args[1]);
    if (args[1] === "bad") throw Object.assign(new Error("gh failed"), { stderr: "Not Found (HTTP 404)" });
    return args[1] === "graphql" ? '{"data":{"n":1}}' : '{"a":1}';
  });
  const got = gh.many([{ rest: "ok" }, { rest: "bad" }, { graphql: ["query", {}] }]);
  assert.deepEqual(got[0], { value: { a: 1 } });
  assert.match(got[1].error.message, /gh failed/);
  assert.deepEqual(got[2], { value: { n: 1 } });
  assert.deepEqual(seq, ["ok", "bad", "graphql"]);
  assert.equal(gh.calls, 3);
  assert.equal(gh.graphqlCalls, 1);
});
