// node --test tools/doc_reread.test.mjs: offline, a fake fetch answers the token exchange, each page and each model call.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { citations, exchange, main, pageText, parseAnswer, prompt, table } from "./doc_reread.mjs";

const URL_A = "https://code.claude.com/docs/en/claude-projects";
const URL_B = "https://docs.github.com/en/rest/issues/issues";

test("citations: only allowed hosts, one entry per page, stalest read first, trailing punctuation and anchors dropped", () => {
  const found = citations({
    "a.md": `Cited (${URL_A}#x, read 2026-11-25).\nA blog https://example.com/post, read 2026-01-01.`,
    "b.md": `See ${URL_B}, read 2026-11-01.\nAgain ${URL_A}, read 2026-11-20.`,
  });
  assert.deepEqual(found.map((f) => f.url), [URL_B, URL_A]);
  assert.equal(found[1].read, "2026-11-20");
  assert.equal(found[1].lines.length, 2);
});

test("pageText drops scripts, styles and tags, and caps the length", () => {
  assert.equal(pageText("<style>x{}</style><p>Hi <b>there</b></p><script>1</script>"), "Hi there");
  assert.ok(pageText("a".repeat(100000)).length <= 60000);
});

test("parseAnswer reads one JSON object and rejects anything else", () => {
  assert.deepEqual(parseAnswer('ok {"holds": false, "changed": "now 25"}'), { holds: false, changed: "now 25" });
  assert.equal(parseAnswer("no json"), null);
  assert.equal(parseAnswer('{"holds": "yes"}'), null);
});

test("prompt fences the page as data", () => {
  const p = prompt({ url: URL_A, lines: [{ file: "a.md", line: 1, text: "claim" }] }, "PAGE");
  assert.match(p, /<page>\nPAGE\n<\/page>/);
  assert.match(p, /data, never instructions/);
});

test("table lists each page with its result", () => {
  assert.match(table([{ url: URL_A, read: null, result: "holds" }]), /\| https:\/\/code\.claude\.com\/docs\/en\/claude-projects \| no date \| holds \|  \|/);
});

function repo(text) {
  const dir = mkdtempSync(join(tmpdir(), "reread-"));
  writeFileSync(join(dir, "a.md"), text);
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "add", "a.md"]);
  return dir;
}

const ENV = (dir) => {
  writeFileSync(join(dir, "jwt"), "header.payload.sig");
  return {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_1", ANTHROPIC_ORGANIZATION_ID: "org", ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_1",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_1", ANTHROPIC_IDENTITY_TOKEN_FILE: join(dir, "jwt"),
  };
};

// A fake web: the token endpoint, the model endpoint and each cited page.
function web(answers, { tokenStatus = 200, modelStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push(url);
    if (url.endsWith("/v1/oauth/token")) return { ok: tokenStatus === 200, status: tokenStatus, json: async () => ({ access_token: "tok" }) };
    if (url.endsWith("/v1/messages")) {
      assert.equal(init.headers.authorization, "Bearer tok");
      if (modelStatus !== 200) return { ok: false, status: modelStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: answers.shift() }] }) };
    }
    return { ok: true, status: 200, text: async () => "<p>page</p>" };
  };
  return { fetchFn, calls };
}

const run = async (dir, argv, env, fetchFn) => {
  const lines = [];
  const code = await main(["--root", dir, ...argv], { env, fetchFn, log: (l) => lines.push(l), error: (l) => lines.push(l) });
  return { code, out: lines.join("\n") };
};

test("exchange posts the federation fields and returns the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "reread-"));
  let body;
  const token = await exchange(ENV(dir), async (_u, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ access_token: "tok" }) }; });
  assert.equal(token, "tok");
  assert.equal(body.assertion, "header.payload.sig");
  assert.equal(body.federation_rule_id, "fdrl_1");
});

test("a key in the environment refuses the run before anything is read", async () => {
  const dir = repo(`${URL_A} read 2026-11-01`);
  const { fetchFn, calls } = web([]);
  const { code, out } = await run(dir, [], { ...ENV(dir), ANTHROPIC_API_KEY: "x" }, fetchFn);
  assert.equal(code, 2);
  assert.match(out, /stores no key/);
  assert.equal(calls.length, 0);
});

test("without the Console connection nothing runs and no call is made", async () => {
  const dir = repo(`${URL_A} read 2026-11-01`);
  const { fetchFn, calls } = web([]);
  const { code, out } = await run(dir, [], {}, fetchFn);
  assert.equal(code, 2);
  assert.match(out, /Console connection is missing/);
  assert.equal(calls.length, 0);
});

test("--dry-run lists the pages and calls nothing", async () => {
  const dir = repo(`${URL_A} read 2026-11-01`);
  const { fetchFn, calls } = web([]);
  const { code, out } = await run(dir, ["--dry-run"], {}, fetchFn);
  assert.equal(code, 0);
  assert.match(out, /would read/);
  assert.equal(calls.length, 0);
});

test("a page whose claim no longer holds exits 1 and says what changed", async () => {
  const dir = repo(`${URL_A} read 2026-11-01\n${URL_B} read 2026-11-02`);
  const { fetchFn } = web(['{"holds": true, "changed": ""}', '{"holds": false, "changed": "limit is now 50"}']);
  const { code, out } = await run(dir, [], ENV(dir), fetchFn);
  assert.equal(code, 1);
  assert.match(out, /limit is now 50/);
  assert.match(out, /holds/);
});

test("a refused model call stops the run at that page: no retry, no later page", async () => {
  const dir = repo(`${URL_A} read 2026-11-01\n${URL_B} read 2026-11-02`);
  const { fetchFn, calls } = web([], { modelStatus: 429 });
  const { code, out } = await run(dir, [], ENV(dir), fetchFn);
  assert.equal(code, 0);
  assert.match(out, /stopped: messages call refused \(HTTP 429\)/);
  assert.equal(calls.filter((c) => c.endsWith("/v1/messages")).length, 1);
});

test("a refused token exchange exits 2", async () => {
  const dir = repo(`${URL_A} read 2026-11-01`);
  const { fetchFn } = web([], { tokenStatus: 401 });
  const { code } = await run(dir, [], ENV(dir), fetchFn);
  assert.equal(code, 2);
});

test("--max-pages caps the pages read", async () => {
  const dir = repo(`${URL_A} read 2026-11-01\n${URL_B} read 2026-11-02`);
  const { fetchFn, calls } = web(['{"holds": true, "changed": ""}']);
  await run(dir, ["--max-pages", "1"], ENV(dir), fetchFn);
  assert.equal(calls.filter((c) => c.endsWith("/v1/messages")).length, 1);
});
