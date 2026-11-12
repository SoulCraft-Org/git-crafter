// Several reads side by side from synchronous code. The collect is synchronous, and one actions/runs page takes
// GitHub about 2.4 s to answer, so 70 pages read one by one held a Process collect for 177 s (code-os,
// 2026-11-11). runMany hands the list to a child node process that runs up to `limit` at once and answers in the
// order asked. Each read is a separate command, so the call count and the API budget stay what they were.
// GitHub allows 100 concurrent requests before its secondary rate limit (docs.github.com, Rate limits for the REST
// API, read 2026-11-11); LIMIT stays far under that.

import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LIMIT = 4;
const SELF = fileURLToPath(import.meta.url);
const OPTS = { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, timeout: 120_000 };

// A 5xx is a passing GitHub error, so a read retries it once. A 4xx or a rate limit is GitHub's answer and is
// never retried. org_fetch.mjs ghClient uses the same rule for its one-by-one reads.
const SERVER_ERROR = /\bHTTP 5\d\d\b|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out/i;
// True for a GitHub 5xx answer, never for a 4xx or a rate limit.
export const isServerError = (err) => {
  const msg = String(err?.stderr || err?.message || err);
  return SERVER_ERROR.test(msg) && !/rate limit|\bHTTP 4\d\d\b/i.test(msg);
};

// The stdout of `cmd args` for each args in argsList, in order. Throws the first failure, with its stderr.
export function runMany(cmd, argsList, { limit = LIMIT, retryMs = 5000 } = {}) {
  if (!argsList.length) return [];
  const input = JSON.stringify({ cmd, argsList, limit, retryMs });
  try {
    return JSON.parse(execFileSync(process.execPath, [SELF], { ...OPTS, input, timeout: 30 * 60_000, stdio: ["pipe", "pipe", "pipe"] }));
  } catch (err) {
    throw Object.assign(new Error(`runMany: ${String(err.stderr || err.message).trim().slice(0, 500)}`), { stderr: err.stderr });
  }
}

const once = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, OPTS, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout))));

async function worker() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  const { cmd, argsList, limit, retryMs } = JSON.parse(text);
  const out = new Array(argsList.length);
  let next = 0;
  const lane = async () => {
    while (next < argsList.length) {
      const i = next++;
      try {
        out[i] = await once(cmd, argsList[i]);
      } catch (err) {
        if (!isServerError(err)) throw err;
        await new Promise((r) => setTimeout(r, retryMs));
        out[i] = await once(cmd, argsList[i]);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, argsList.length) }, lane));
  } catch (err) {
    process.stderr.write(String(err.stderr || err.message));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(out));
}

if (process.argv[1] === SELF) await worker();
