// The reader each built-in level pack's collector shares (quality/levels/README.md).
// It counts every gh api request and times the read, so a tab's speed and
// consumption metrics come from the same run as its quality metrics.
// It imports no engine file: the gh client comes from lib, or a test's fake.

// A gh api reader. In CI it reads with ADMIN_READ_TOKEN when the workflow passes one.
export function levelReader({ gh, lib, mode, env = process.env }) {
  const token = mode === "ci" ? String(env.ADMIN_READ_TOKEN ?? "").trim() : "";
  const client = gh ?? lib.ghClient(token || undefined);
  const started = Date.now();
  let requests = 0;
  return {
    rest(route) {
      requests += 1;
      return client.rest(route);
    },
    // Every page of a list; each page of 100 is one request.
    async restAll(route) {
      try {
        const list = await client.restAll(route);
        requests += Math.max(1, Math.ceil(list.length / 100));
        return list;
      } catch (err) {
        requests += 1;
        throw err;
      }
    },
    requests: () => requests,
    seconds: () => Math.round((Date.now() - started) / 100) / 10,
  };
}

// An error's first line, short enough for a reason.
export const why = (err) => String(err?.message || err).trim().split("\n")[0].slice(0, 160);

// One collector's entries: val and cnc set one id; done fills any id left unset.
export function results(ids, source) {
  const out = {};
  const readAt = new Date().toISOString();
  return {
    val: (id, value, src, detail) => (out[id] = { value, ...(detail?.length ? { detail } : {}), source: src, read_at: readAt }),
    cnc: (id, reason, src) => (out[id] = { could_not_check: reason, source: src }),
    all: (reason) => Object.fromEntries(ids.map((id) => [id, { could_not_check: reason, source }])),
    done: () => Object.fromEntries(ids.map((id) => [id, out[id] ?? { could_not_check: "collector produced no value", source }])),
  };
}

// The speed and consumption pair every level tab carries: seconds and requests of this read.
export function timing(r, read, ids, what) {
  r.val(ids.seconds, read.seconds(), `wall time of this collector, ${what}`);
  r.val(ids.requests, read.requests(), `gh api requests this collector made, one per page, ${what}`);
}
