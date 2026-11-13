// Text stripping that leaves no match behind (code scanning, #13). One pass of
// replace can rejoin a match from the pieces around one it removed:
// "<!<!-- a -->-- b -->" loses "<!-- a -->" and leaves "<!-- b -->".

/** The text with every match of the global pattern `re` replaced by `by`, pass after pass until none is left. */
export function stripAll(text, re, by = "") {
  let out = String(text);
  let before;
  do {
    before = out;
    out = out.replace(re, by);
  } while (out !== before);
  return out;
}

const UNSAFE_IN_CODE = { "<": "\\u003C", ">": "\\u003E", "\u2028": "\\u2028", "\u2029": "\\u2029" };

/** A value as a JavaScript literal to write into generated code: JSON, with <, > and the line separators escaped. */
export const codeLiteral = (value) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (c) => UNSAFE_IN_CODE[c]);
