// Unit tests for how page.mjs ships its styles and client script: without
// comments and ignorable whitespace, and with every string intact. Run with
// `node --test quality/render/page.test.mjs`; quality/selftest.mjs runs it too.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { levelLinks } from "../build.mjs";
import { CSS_STRING_OR_COMMENT, idealBlock, levelSwitch, render, sampleBadge, tightCss, tightJs } from "./page.mjs";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
// The real files with comments dropped and strings kept, for the invariant
// checks on them. The behavior itself is pinned by expected values written by
// hand, never by this step.
const noComments = (css) => css.replace(CSS_STRING_OR_COMMENT, (_, s) => s ?? "");

describe("tightCss", () => {
  it("drops comments and the whitespace around braces, semicolons, commas and a declaration's colon", () => {
    const css = "/* the site's tokens */\n.a, .b {\n  color: red;\n  margin: 0 auto;\n}\n";
    assert.equal(tightCss(css), ".a,.b{color:red;margin:0 auto}");
  });

  it("never touches a string or a selector's colon", () => {
    // Known bad for a plain regex: braces, commas, colons and semicolons inside a string.
    assert.equal(tightCss('.x::after { content: "a { b; c, d: e }"; }'), '.x::after{content:"a { b; c, d: e }"}');
    assert.equal(tightCss(".t::after { content: ' \\25B4'; }"), ".t::after{content:' \\25B4'}");
    // td :focus (a focused child) is not td:focus; only declarations lose the space.
    assert.equal(tightCss("@media (min-width: 900px) {\n  td :focus { color: red; }\n}"), "@media (min-width: 900px){td :focus{color:red}\n}");
  });

  it("keeps a comment mark inside a string, and the rule after the next comment", () => {
    // Known bad for stripping comments before strings: that would read from
    // the string's /* to the comment's */ and delete .b.
    const css = '.a::before { content: " /* "; }\n/* note */\n.b { color: red; }\n';
    assert.equal(tightCss(css), '.a::before{content:" /* "}\n.b{color:red}');
    assert.equal(tightCss("/* don't */ .c { content: 'x'; }"), ".c{content:'x'}", "an apostrophe in a comment opens no string");
  });

  it("keeps every string and brace of page.css and the template's tokens", () => {
    for (const rel of ["./page.css", "./page-figures.css", "./tokens.css"]) {
      const src = noComments(read(rel));
      const out = tightCss(src);
      assert.deepEqual(out.match(STRING) ?? [], src.match(STRING) ?? [], `${rel} strings`);
      for (const ch of ["{", "}"]) assert.equal(out.split(ch).length, src.split(ch).length, `${rel} ${ch}`);
      assert.ok(!out.includes("/*"), `${rel} comments`);
      assert.ok(out.length < src.length, `${rel} is smaller`);
    }
  });

  it("keeps every color in the template's tokens: page.css names no raw hex, and each color it reads is defined", () => {
    const page = noComments(read("./page.css") + read("./page-figures.css"));
    assert.deepEqual(page.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], "a raw hex in page.css (design.raw_hex)");
    const defined = new Set([...`${noComments(read("./tokens.css"))}${page}`.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    // Color custom properties only: --a, --b and the like are set inline by the markup.
    const used = new Set([...page.matchAll(/var\((--(?:c-[\w-]+|[kp]\d))\)/g)].map((m) => m[1]));
    assert.ok(used.has("--k1") && used.has("--c-snow"), "the review ramp and the snow are read");
    assert.deepEqual([...used].filter((v) => !defined.has(v)), [], "a color page.css reads that nothing defines");
  });
});

describe("tightJs", () => {
  const js = read("./client.js");

  it("relies on client.js having no string that spans lines", () => {
    // Every code line closes each template literal it opens.
    for (const [i, line] of js.split("\n").entries()) {
      if (/^\s*\/\//.test(line)) continue;
      assert.equal((line.match(/`/g) ?? []).length % 2, 0, `client.js line ${i + 1} opens a template literal it does not close`);
    }
  });

  it("drops comment lines and indents, and the script still parses", () => {
    const out = tightJs(js);
    assert.ok(!/^\s*\/\//m.test(out), "a comment line is left");
    assert.ok(!/^[ \t]/m.test(out), "an indent is left");
    // The Function constructor parses the body without running it.
    assert.doesNotThrow(() => new Function(out));
    assert.ok(out.length < js.length);
  });
});

describe("idealBlock", () => {
  const sources = [{ title: "A guide", url: "https://example.org/x", date: "2026-11-10" }];

  it("draws an ideal's parts as a table between the summary and the sources, each cell escaped", () => {
    const parts = [{ part: "Labels", ideal: "Area labels only", setup: "Archive what's unused" }];
    const html = idealBlock("issues", { ideal: "One sentence.", sources, parts });
    assert.ok(html.includes('<tr><th scope="row">Labels</th><td>Area labels only</td><td>Archive what&#39;s unused</td></tr>'));
    assert.ok(html.indexOf("One sentence.") < html.indexOf('class="ideal-parts"') && html.indexOf('class="ideal-parts"') < html.indexOf('class="refs"'));
    assert.ok(html.includes('<div class="scroll" tabindex="0" role="group" aria-label="Ideal state, part by part"><table class="ideal-parts"'), "the table scrolls in its own box on a phone");
  });

  it("draws no table for an ideal without parts", () => {
    assert.ok(!idealBlock("code", { ideal: "One sentence.", sources }).includes("<table"));
  });

  it("folds the sources into one closed details line: the count and the newest date, every link inside", () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ title: `Doc ${i + 1}`, url: `https://example.org/${i + 1}`, date: `2026-10-${String(i + 10).padStart(2, "0")}` }));
    many[3].date = "2026-11-10";
    const html = idealBlock("actions", { ideal: "One sentence.", sources: many });
    assert.equal(html.match(/<summary/g)?.length, 1, "one summary line");
    assert.ok(html.includes("<summary>14 sources, newest 2026-11-10</summary>"));
    assert.ok(!/<details[^>]* open/.test(html), "closed by default");
    const inside = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    assert.equal(inside.match(/<li><a href="https:\/\/example\.org\/\d+">Doc \d+<\/a> <span class="small">2026-1\d-\d\d<\/span><\/li>/g)?.length, 14, "all 14 links, each with its date");
    assert.ok(html.indexOf("One sentence.") < html.indexOf("<details"), "the ideal sentence stays above, outside the fold");
  });

  it("still folds a single source, in the singular", () => {
    const html = idealBlock("code", { ideal: "One sentence.", sources });
    assert.ok(html.includes('<details class="refs-fold"><summary>1 source, newest 2026-11-10</summary><ol class="refs"><li><a href="https://example.org/x">A guide</a> <span class="small">2026-11-10</span></li></ol></details>'));
  });
});

describe("page nav styles", () => {
  it("apply to the page's own nav class, so a second nav element takes none of them", () => {
    const css = noComments(read("./page.css"));
    assert.doesNotMatch(css, /(^|[}\s,])nav[\s{.:[,]/m, "no rule styles the bare nav element");
    assert.match(css, /\.tabnav \{/);
  });
});

describe("level switcher", () => {
  it("names all four levels in order and marks the page's own level current, once", () => {
    const html = levelSwitch("org", { repo: "../", org: "./" });
    assert.deepEqual([...html.matchAll(/<li>(?:<a[^>]*>|<span>)(\w+)/g)].map((m) => m[1]), ["User", "Repository", "Organization", "Enterprise"]);
    assert.equal(html.match(/aria-current/g)?.length, 1);
    assert.ok(html.includes('<a href="./" aria-current="page">Organization</a>'));
    assert.ok(html.includes('<a href="../">Repository</a>'));
  });

  it("links no level whose page is not built, and says so to a screen reader", () => {
    const html = levelSwitch("repo", { repo: "./" });
    assert.equal(html.match(/<a /g)?.length, 1, "only the current level links");
    assert.ok(html.includes('<li><span>User<span class="vh"> (not set up)</span></span></li>'));
  });

  it("is a nav named apart from the views nav, so each landmark is unique (axe landmark-unique)", () => {
    const html = render({ defs: [], metrics: {}, tabs: [], meta: { level: "user", levels: { user: "./", repo: "../" } } });
    const navs = [...html.matchAll(/<nav class="[^"]+" aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(navs, ["Levels", "Views"]);
    assert.ok(html.indexOf('class="levels"') < html.indexOf("</header>"), "the switcher sits in the header");
  });

  it("gives every entry a target at least 24 px tall at any width (WCAG 2.5.8)", () => {
    const css = noComments(read("./page.css"));
    assert.match(css, /\.levels a, \.levels li > span \{[^}]*min-height: var\(--size-tap\)/);
    assert.ok(Number(read("./tokens.css").match(/--size-tap: (\d+)px/)[1]) >= 24);
  });
});

describe("levelLinks", () => {
  it("links the repo page always and a level once its config sits in levels/ beside the repo config", () => {
    const dir = mkdtempSync(join(tmpdir(), "levels-"));
    try {
      mkdirSync(join(dir, "levels"));
      writeFileSync(join(dir, "levels", "org.json"), "{}");
      assert.deepEqual(levelLinks({ level: "repo", file: join(dir, "quality.json") }), { repo: "./", org: "org/" });
      assert.deepEqual(levelLinks({ level: "org", file: join(dir, "levels", "org.json") }), { repo: "../", org: "./" });
      assert.deepEqual(levelLinks({ level: "repo", file: null }), { repo: "./" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sample badge", () => {
  it("shows only on a page built from sample data, in the header and the title", () => {
    assert.equal(sampleBadge(false), "");
    assert.ok(sampleBadge(true).startsWith('<p class="sample"><strong>Sample data</strong>'));
    const html = render({ defs: [], metrics: {}, tabs: [], meta: { name: "acme", sample: true } });
    assert.ok(html.includes("<title>Quality, Speed and Consumption: acme (sample data)</title>"));
    assert.ok(html.indexOf('class="sample"') < html.indexOf("</header>"));
    assert.ok(!render({ defs: [], metrics: {}, tabs: [], meta: {} }).includes('class="sample"'));
  });
});
