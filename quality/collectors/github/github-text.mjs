// How the GitHub collector reads a PR, issue or card body: its words, tables and visuals.

// A PR body without the patterns params.pr_body_ignore names (a bot's footer
// that no author can change), HTML comments, fenced blocks (code, mermaid and
// other diagrams), then single-line HTML tags, so a < or > in prose or a fence
// survives. The ignore patterns go first: a footer wrapped in HTML comments
// would otherwise lose only its markers.
export const unfenced = (body, ignore = []) =>
  ignore
    .reduce((text, re) => text.replace(re, ""), String(body))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1[^\n]*$/gm, "")
    .replace(/<\/?[A-Za-z][^<>\n]*>/g, " ");

/** Words of prose in a PR body: outside tables, fenced blocks, inline code and comments; a link counts its text. `ignore`: global patterns cut first. */
export function proseWords(body, ignore = []) {
  const prose = unfenced(body, ignore)
    .split("\n")
    .filter((line) => !/^\s*\|/.test(line))
    .join("\n")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ");
  return (prose.match(/[A-Za-z0-9][\w'’.-]*/g) ?? []).length;
}

/** Whether a PR body has a markdown table (a row and its separator) outside fenced blocks. */
export const hasTable = (body, ignore = []) => TABLE.test(unfenced(body, ignore));

// GitHub draws these fenced blocks as pictures: Mermaid diagrams and charts,
// GeoJSON and TopoJSON maps, and STL models (GitHub docs, Creating diagrams).
const DIAGRAM_INFO = new Set(["mermaid", "geojson", "topojson", "stl"]);

const IMAGE = /!\[[^\]]*\]\([^)\s]+[^)]*\)|!\[[^\]]*\]\[[^\]]*\]|<img\b[^>]*\bsrc=/i;

const TABLE = /^\s*\|.*\|\s*$\n^\s*\|?\s*:?-{3,}/m;

/**
 * Markdown's top-level fenced blocks and the text outside them. A fence opens
 * with three or more backticks or tildes and closes on a line of the same
 * character at least as long (CommonMark), so a fence shown as an example
 * inside a longer one stays inside it.
 */
function fences(text) {
  const infos = [];
  const outside = [];
  let open = null;
  for (const line of String(text).split("\n")) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === open.char && close[1].length >= open.len) open = null;
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (start) {
      open = { char: start[1][0], len: start[1].length };
      infos.push(start[2].toLowerCase());
    } else outside.push(line);
  }
  return { infos, outside: outside.join("\n") };
}

/**
 * Whether a body shows something visual: a table, a diagram GitHub draws, or
 * an image, outside code. Comments and the `ignore` patterns are cut first, so
 * a bot's footer never counts.
 */
export function hasVisual(body, ignore = []) {
  const text = ignore.reduce((t, re) => t.replace(re, ""), String(body)).replace(/<!--[\s\S]*?-->/g, "");
  const { infos, outside } = fences(text);
  if (infos.some((info) => DIAGRAM_INFO.has(info))) return true;
  return IMAGE.test(outside.replace(/`[^`\n]*`/g, " ")) || TABLE.test(outside);
}

/**
 * Whether a card's body shows a picture: an image, or a diagram GitHub draws.
 * `diagrams: false` is for a draft card, which shows a diagram block as code.
 * A table is not a picture. `ignore`: patterns cut first, as in hasVisual.
 */
export function hasPicture(body, { diagrams = true, ignore = [] } = {}) {
  const text = ignore.reduce((t, re) => t.replace(re, ""), String(body ?? "")).replace(/<!--[\s\S]*?-->/g, "");
  const { infos, outside } = fences(text);
  if (diagrams && infos.some((info) => DIAGRAM_INFO.has(info))) return true;
  return IMAGE.test(outside.replace(/`[^`\n]*`/g, " "));
}

// An issue a PR body links as GitHub reads it: a closing keyword (close, fix
// or resolve, in any tense) before #N, owner/repo#N or the issue's URL, or
// "Part of" the same. A draft card, which has no issue number until a GraphQL
// call converts it, is linked by its board id: "Part of PVTI_..." or "Card:
// PVTI_..." (the id survives the conversion). Fenced code, comments and
// params.pr_body_ignore do not count.
const ISSUE_REF = String.raw`(?:[\w.-]+\/[\w.-]+#|#|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/)\d+\b`;
const CARD_REF = String.raw`PVTI_[\w-]{8,}`;
const ISSUE_LINK = new RegExp(String.raw`(?<![\w])(?:(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?|part of)[ \t]+(?:${ISSUE_REF}|(?:card[ \t]+)?${CARD_REF})|card:[ \t]*${CARD_REF})`, "i");
// True when a PR body links an issue as ISSUE_LINK reads it, outside fences and the ignored text.
export const linksIssue = (body, ignore = []) => ISSUE_LINK.test(unfenced(body ?? "", ignore));
