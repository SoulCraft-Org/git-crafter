// Shared fixtures and fakes for the GitHub collector tests (github.test.mjs and github-more.test.mjs).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collect, GhError } from "./github.mjs";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(HERE, "..", "..", "fixtures", "github");
export const TARGETS = JSON.parse(readFileSync(new URL("../../targets/github.json", import.meta.url), "utf8"));
export const TEMPLATE_PARAMS = Object.assign({}, ...TARGETS.map((t) => t.params ?? {}));
export const REST = JSON.parse(readFileSync(path.join(FIXTURES, "rest.json"), "utf8"));
export const GRAPHQL = JSON.parse(readFileSync(path.join(FIXTURES, "graphql.json"), "utf8"));
const HEADERS = JSON.parse(readFileSync(path.join(FIXTURES, "headers.json"), "utf8"));
export const PARAMS = { ...TEMPLATE_PARAMS, ...JSON.parse(readFileSync(path.join(FIXTURES, "params.json"), "utf8")) };
export const NOW = Date.parse("2026-11-02T20:00:00Z");
export const REPO = "fixture-org/fixture-repo";
export const HOUR_MS = 3_600_000;
export const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
export const FOOTER = /<!-- codesmith:footer -->[\s\S]*?<!-- \/codesmith:footer -->/g;

/** A gh client that answers from the fixture files and records each call. */
export function fakeGh({ rest = REST, graphql = GRAPHQL } = {}, calls = []) {
  const answer = (key, entry) => {
    if (entry === undefined) throw new GhError(`no fixture for ${key}`, { status: 404 });
    if (entry?.__error) throw new GhError(entry.__error.message, entry.__error);
    return structuredClone(entry);
  };
  return {
    calls,
    rest: async (route) => (calls.push(route), answer(route, rest[route])),
    restAll: async (route) => (calls.push(route), answer(route, rest[route])),
    graphql: async (query, variables) => {
      const op = /query (\w+)/.exec(query)[1];
      calls.push(op);
      const entry = graphql[op];
      return answer(op, Array.isArray(entry) ? entry[variables.cursor ? Number(variables.cursor) : 0] : entry);
    },
  };
}

// A fetch stand-in that answers every request 200 with the fixture's response headers.
export const fakeFetch = (headers = HEADERS) => async () => {
  const { _comment, ...h } = headers;
  return new Response(null, { status: 200, headers: h });
};

// Runs the collector on the fixture repo with the stand-in GitHub client and fetch; opts override any argument.
export const run = (opts = {}) =>
  collect({ root: path.join(FIXTURES, "repo"), mode: "local", params: PARAMS, gh: fakeGh(), fetch: fakeFetch(), now: NOW, repo: REPO, ...opts });
