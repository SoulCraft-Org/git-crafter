// The org-page reads of every repo run side by side: drive (tools/org_fetch.mjs) advances them in lockstep.
// Run with: node --test tests/pages-drive.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { runManySettled } from "../tools/org_many.mjs";

test("runManySettled keeps the order and one failure does not stop the other reads", () => {
  const ok = (n) => ["-e", `process.stdout.write(${JSON.stringify(String(n))})`];
  const bad = ["-e", "process.stderr.write('gh: Not Found (HTTP 404)'); process.exit(1)"];
  const got = runManySettled(process.execPath, [ok(1), bad, ok(3)], { limit: 2 });
  assert.deepEqual([got[0].out, got[2].out], ["1", "3"]);
  assert.match(got[1].err.stderr, /HTTP 404/);
});
