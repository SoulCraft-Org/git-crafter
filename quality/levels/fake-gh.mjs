// A fake gh client for the level packs' tests: each route answers from a
// fixture file, and any other route is an HTTP error with that status.
import { readFileSync } from "node:fs";

export const routes = (url) => JSON.parse(readFileSync(url, "utf8"));

export function fakeGh(table, { status = 404 } = {}) {
  const rest = async (route) => {
    if (route in table) return structuredClone(table[route]);
    throw Object.assign(new Error(`HTTP ${status}: ${route}`), { status });
  };
  return { rest, restAll: rest };
}
