// Plain-text, word-count, date and link rules shared by the ideal and source checks in score.mjs.

// Words as counted above: each run of letters is one word per 20 letters.
export const wordCount = (text) => (text.match(/\p{L}+/gu) ?? []).reduce((n, run) => n + Math.ceil(run.length / 20), 0);

// A real calendar day, YYYY-MM-DD: the document's published or last-updated
// date, or the day it was read when it shows none.
// An impossible month parses to NaN, which toISOString would throw on.
export const isDay = (s) => {
  const t = typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
};

// Plain words: letters in any script, digits, spaces and ,.;:'()%/+?!- with
// at least one letter and no space at either end. No markup, entities,
// double quotes or dashes other than the hyphen, so no em dash either. Widened
// from ASCII to any letter so a title such as Diátaxis keeps its spelling. An accent
// (a spacing or non-spacing mark) may follow a letter only, and the letters
// and marks that render as nothing are refused: the Hangul fillers, the
// combining grapheme joiner and the variation selectors.
const PLAIN = /^(?:\p{L}[\p{Mn}\p{Mc}]*|[0-9 ,.;:'()%/+?!-])+$/u;
const INVISIBLE = /[\u115F\u1160\u3164\uFFA0\u034F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/u;
// True for a string of plain words, as defined above.
export const isPlain = (v) => typeof v === "string" && PLAIN.test(v) && !INVISIBLE.test(v) && /\p{L}/u.test(v) && v.trim() === v;

// A public document's link: https to a plain host name, written in lower or
// upper ASCII labels, with no punycode (xn--), port or credentials, and only
// URL-safe characters after the host. A query or fragment may stay, since
// documentation anchors sections with them.
export function isPublicUrl(v) {
  const match = typeof v === "string" && v.length <= 300 ? /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(\/[A-Za-z0-9._~\/%-]*)?(\?[A-Za-z0-9._~=&%-]*)?(#[A-Za-z0-9._~:-]*)?$/i.exec(v) : null;
  if (!match) return false;
  const host = match[1].toLowerCase();
  if (host.split(".").some((label) => label.startsWith("xn--") || label.startsWith("-") || label.endsWith("-"))) return false;
  try {
    const url = new URL(v);
    return url.hostname === host && url.port === "" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export const PLAIN_WORDS = "letters, digits, spaces and ,.;:'()%/+?!- only, with at least one letter and no space at either end";

// Each line is also at most 25 words, so it scans on a phone. Words are
// counted as the upstream publish guard this rule came from counts them: a run of letters is one
// word per 20 letters, so a run with no spaces still counts, and numbers are
// free. A template line that passes here passes there.
export const IDEAL_MAX_WORDS = 25;

// Throws unless every listed field of doc that holds text is plain words.
export function checkPlainFields(doc, where, fields) {
  for (const field of fields) {
    const v = doc[field];
    if (typeof v === "string" && v.trim() && !isPlain(v)) throw new Error(`${where}: ${field} must be plain words: ${PLAIN_WORDS}`);
  }
}

// Throws unless every listed field of doc that is set stays within the word limit.
export function checkWordCounts(doc, where, fields) {
  for (const field of fields) {
    const v = doc[field];
    if (v !== undefined && wordCount(v) > IDEAL_MAX_WORDS) throw new Error(`${where}: ${field} must be at most ${IDEAL_MAX_WORDS} words, and has ${wordCount(v)}`);
  }
}
