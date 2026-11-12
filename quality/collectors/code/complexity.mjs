// Per-file facts for the Code tab, read with the TypeScript compiler API: code
// lines, each function's complexity and length, exported functions and whether
// a header comment sits right above them, comment text, and string literals.
// code.mjs walks the repo and turns these facts into metrics; this file never
// touches the disk, so the tests feed it strings.
//
// A "line" here is a code line: not blank and not only comment. So a comment
// never pushes a function or a file over a limit.
//
// Complexity is McCabe's count: 1, plus one for each if, ?:, loop, catch,
// non-default case, &&, || and ?? (and &&=, ||=, ??=). A nested function is
// measured on its own and adds nothing to the function around it. The limits
// that turn these facts into counts are code.mjs's params.limits.
import ts from "typescript";
import { commentedOutCode, looksLikeCode } from "./commented-code.mjs";

export { looksLikeCode };

const SCRIPT_KIND = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
};
export const CODE_EXTENSIONS = new Set([...Object.keys(SCRIPT_KIND), ".astro", ".css", ".py", ".sh"]);

const K = ts.SyntaxKind;
const BRANCHES = new Set([
  K.IfStatement,
  K.ConditionalExpression,
  K.ForStatement,
  K.ForInStatement,
  K.ForOfStatement,
  K.WhileStatement,
  K.DoStatement,
  K.CatchClause,
  K.CaseClause,
]);
const LOGICAL = new Set([
  K.AmpersandAmpersandToken,
  K.BarBarToken,
  K.QuestionQuestionToken,
  K.AmpersandAmpersandEqualsToken,
  K.BarBarEqualsToken,
  K.QuestionQuestionEqualsToken,
]);

// Returns null for a file type this tab does not read.
export function analyzeFile(path, text) {
  const ext = path.slice(path.lastIndexOf("."));
  const facts = analyzeByType(ext, text);
  if (facts) facts.purpose = opensWithPurpose(text, facts.comments, ext);
  return facts;
}

function analyzeByType(ext, text) {
  if (ext in SCRIPT_KIND) return analyze(text, [{ start: 0, end: text.length, kind: SCRIPT_KIND[ext] }], []);
  if (ext === ".astro") return analyzeAstro(text);
  if (ext === ".css") return analyze(text, [], regexComments(text, /\/\*[\s\S]*?\*\//g), { refsFromLines: true });
  if (ext === ".py") return analyze(text, [], [...hashComments(text), ...pyDocstrings(text)], { refsFromLines: true });
  if (ext === ".sh") return analyze(text, [], hashComments(text), { refsFromLines: true });
  return null;
}

// A purpose comment opens the file: after any shebang, and an .astro file's
// opening ---, the first thing is a comment holding three or more words besides
// tool directives (// @ts-check, /* eslint-disable */). A Python module
// docstring counts too.
const DIRECTIVE = /^\s*(@ts-|eslint|prettier|biome|istanbul|c8\b|jshint|global\b|\/?\s*<reference|-\*-|shellcheck|noqa|type:|pylint|fmt:)/i;

function opensWithPurpose(text, comments, ext) {
  let rest = text.replace(/^#![^\n]*\n/, "");
  if (ext === ".astro") rest = rest.replace(/^\s*---[ \t]*\r?\n/, "");
  const start = text.length - rest.trimStart().length;
  const doc = ext === ".py" ? /^("""|''')([\s\S]*?)\1/.exec(text.slice(start)) : null;
  const lines = doc ? [doc[2]] : openingComment(text, start, comments);
  const words = lines.filter((l) => !DIRECTIVE.test(l)).join(" ").match(/[A-Za-z]{2,}/g);
  return (words?.length ?? 0) >= 3;
}

// The lines of the comment run that opens the file at `start`.
function openingComment(text, start, comments) {
  const first = text.slice(0, start).split("\n").length;
  const run = [];
  for (const c of comments.filter((c) => c.line >= first)) {
    const next = run.length === 0 ? c.line === first && c.ownLine : !c.block && !run[0].block && c.line === run.at(-1).endLine + 1;
    if (!next) break;
    run.push(c);
  }
  return run.flatMap((c) => c.text.split("\n")).map((l) => l.replace(/^\s*(\/\*+|\/\/+|#+|<!--|\{\/\*|\*)|(\*+\/\}?|-->)\s*$/g, ""));
}

// An .astro file is TypeScript in the frontmatter and in each <script>, CSS in
// each <style>, and HTML around them.
function analyzeAstro(text) {
  const scripts = [];
  const other = [];
  const front = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*$/dm.exec(text);
  if (front && front.index === 0) scripts.push({ start: front.indices[1][0], end: front.indices[1][1], kind: ts.ScriptKind.TS });
  const after = front && front.index === 0 ? front.indices[0][1] : 0;
  for (const m of text.slice(after).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/dg)) {
    const [start, end] = m.indices[2].map((i) => i + after);
    if (/\btype\s*=\s*["']?(application\/(ld\+)?json|text\/(html|plain|template))/i.test(m[1])) continue;
    scripts.push({ start, end, kind: ts.ScriptKind.TS });
  }
  for (const m of text.slice(after).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/dg)) {
    const [start, end] = m.indices[1].map((i) => i + after);
    other.push(...regexComments(text.slice(start, end), /\/\*[\s\S]*?\*\//g).map((c) => shift(c, start)));
  }
  const inScript = (pos) => scripts.some((s) => pos >= s.start && pos < s.end);
  for (const re of [/<!--[\s\S]*?-->/g, /\{\/\*[\s\S]*?\*\/\}/g]) {
    other.push(...regexComments(text, re).filter((c) => !inScript(c.pos)));
  }
  return analyze(text, scripts, other);
}

// The shared pass. `blocks` are TypeScript regions of `text`; `extra` are
// comment ranges found by other means. Comments come first because a function's
// length counts only its code lines.
function analyze(text, blocks, extra, { refsFromLines = false } = {}) {
  const lines = lineIndex(text);
  const parsed = blocks.map((b) => {
    const sf = ts.createSourceFile("block.ts", text.slice(b.start, b.end), ts.ScriptTarget.Latest, true, b.kind);
    return { ...b, sf, comments: tsComments(sf).map((c) => shift(c, b.start)) };
  });
  const comments = [...parsed.flatMap((p) => p.comments), ...extra].sort((a, b) => a.pos - b.pos);
  if (text.startsWith("#!") && comments[0]?.pos !== 0) comments.unshift({ pos: 0, end: firstLineEnd(text), block: false });
  const code = codeText(text, lines, comments);
  const isCode = new Array(lines.count).fill(false);
  for (const c of code) isCode[c.line - 1] = true;
  const at = {
    line: (pos) => lines.lineOf(pos) + 1,
    codeLines: (from, to) => {
      let n = 0;
      for (let l = lines.lineOf(from); l <= lines.lineOf(to); l++) n += isCode[l] ? 1 : 0;
      return n;
    },
  };
  const facts = {
    lines: lines.count,
    codeLines: code.length,
    code,
    functions: [],
    exports: [],
    imports: [],
    comments: comments.map((c) => ({
      line: at.line(c.pos),
      endLine: at.line(Math.max(c.pos, c.end - 1)),
      text: text.slice(c.pos, c.end),
      block: c.block,
      ownLine: text.slice(lines.startOf(lines.lineOf(c.pos)), c.pos).trim() === "",
    })),
    refs: [],
  };
  for (const p of parsed) {
    const local = { line: (pos) => at.line(pos + p.start), codeLines: (a, b) => at.codeLines(a + p.start, b + p.start) };
    facts.functions.push(...measureFunctions(p.sf, local));
    facts.exports.push(...exportedFunctions(p.sf, local));
    facts.imports.push(...relativeImports(p.sf));
    facts.refs.push(...stringLiterals(p.sf, local));
  }
  facts.refs.push(...facts.comments.map((c) => ({ line: c.line, text: c.text })));
  if (refsFromLines) facts.refs = text.split("\n").map((t, i) => ({ line: i + 1, text: t }));
  facts.commentedOut = commentedOutCode(facts.comments);
  return facts;
}

// Every comment is in the leading trivia of some token, so asking at each
// token's full start finds them all. JSDoc nodes are skipped: their children
// start inside the comment itself.
function tsComments(sf) {
  const found = new Map();
  const visit = (node) => {
    for (const r of ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? []) {
      found.set(r.pos, { pos: r.pos, end: r.end, block: r.kind === K.MultiLineCommentTrivia });
    }
    for (const child of node.getChildren(sf)) if (!ts.isJSDoc(child)) visit(child);
  };
  visit(sf);
  return [...found.values()];
}

function measureFunctions(sf, at) {
  const out = [];
  const walk = (node, current) => {
    if (ts.isFunctionLike(node) && node.body) {
      const fn = {
        name: functionName(sf, node),
        line: at.line(node.getStart(sf)),
        complexity: 1,
        lines: at.codeLines(node.getStart(sf), node.end - 1),
      };
      out.push(fn);
      ts.forEachChild(node, (child) => walk(child, fn));
      return;
    }
    if (current && (BRANCHES.has(node.kind) || (ts.isBinaryExpression(node) && LOGICAL.has(node.operatorToken.kind)))) {
      current.complexity++;
    }
    ts.forEachChild(node, (child) => walk(child, current));
  };
  walk(sf, null);
  return out;
}

function functionName(sf, node) {
  if (node.name) return node.name.getText(sf);
  if (ts.isConstructorDeclaration(node)) return "constructor";
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText(sf);
  }
  if (ts.isExportAssignment(parent)) return "default";
  if (ts.isCallExpression(parent)) return `${parent.expression.getText(sf).slice(0, 40)} callback`;
  return "anonymous";
}

// Top-level exported functions: `export function`, `export default function`
// and `export const f = () => ...`. A header comment is one that ends on the
// line right above the export, so a file header with a blank line after it
// does not count for the first function.
function exportedFunctions(sf, at) {
  const out = [];
  for (const stmt of sf.statements) {
    if (!ts.getModifiers(stmt)?.some((m) => m.kind === K.ExportKeyword)) continue;
    const last = (ts.getLeadingCommentRanges(sf.text, stmt.getFullStart()) ?? []).at(-1);
    const documented = !!last && at.line(stmt.getStart(sf)) - at.line(last.end) <= 1;
    for (const name of exportedNames(stmt, sf)) out.push({ name, line: at.line(stmt.getStart(sf)), documented });
  }
  return out;
}

// The function names one export statement declares.
function exportedNames(stmt, sf) {
  const names = [];
  if (ts.isFunctionDeclaration(stmt) && stmt.body) names.push(stmt.name?.text ?? "default");
  if (!ts.isVariableStatement(stmt)) return names;
  for (const d of stmt.declarationList.declarations) {
    if (d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) names.push(d.name.getText(sf));
  }
  return names;
}

// The relative modules a file imports or re-exports, as written.
function relativeImports(sf) {
  return sf.statements
    .filter((s) => (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier?.text?.startsWith("."))
    .map((s) => s.moduleSpecifier.text);
}

function stringLiterals(sf, at) {
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ line: at.line(node.getStart(sf)), text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function regexComments(text, re) {
  return [...text.matchAll(re)].map((m) => ({ pos: m.index, end: m.index + m[0].length, block: true }));
}

// Whole-line `#` comments only: a trailing `# note` stays part of a code line.
function hashComments(text) {
  const out = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    const indent = line.length - line.trimStart().length;
    if (line.trimStart().startsWith("#")) out.push({ pos: pos + indent, end: pos + line.length, block: false });
    pos += line.length + 1;
  }
  return out;
}

// A Python docstring is a comment, as the block above a JavaScript function
// is: the string that opens a module, class or def. Read the way Python reads,
// past # comments and quoted strings: a triple-quoted string that comes first
// in the file or right after a block's colon, outside any bracket. A string
// assigned, passed or returned stays code.
const PY_TOKEN = /#[^\n]*|[rbfu]{0,2}("""|''')[\s\S]*?\1|[rbfu]{0,2}(["'])(?:\\.|(?!\2)[^\\\n])*\2|[()[\]{}]|[^\s#"'()[\]{}]+/gi;
// A Map, not an object: a Python name such as constructor or toString must read as no bracket.
const BRACKET = new Map([["(", 1], ["[", 1], ["{", 1], [")", -1], ["]", -1], ["}", -1]]);
function pyDocstrings(text) {
  const out = [];
  let depth = 0;
  let last = "";
  for (const m of text.matchAll(PY_TOKEN)) {
    const t = m[0];
    if (t[0] === "#") continue;
    if (m[1] && depth === 0 && (last === "" || last === ":")) out.push({ pos: m.index, end: m.index + t.length, block: true });
    depth = Math.max(0, depth + (BRACKET.get(t) ?? 0));
    last = m[1] || m[2] ? '"' : t.at(-1);
  }
  return out;
}

function firstLineEnd(text) {
  const nl = text.indexOf("\n");
  return nl < 0 ? text.length : nl;
}

function shift(c, by) {
  return { ...c, pos: c.pos + by, end: c.end + by };
}

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const count = text.endsWith("\n") ? starts.length - 1 : starts.length;
  const lineOf = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  return { count, lineOf, startOf: (line) => starts[line] };
}

// Each code line with its comments blanked and its whitespace collapsed: the
// duplicate finder in shape.mjs compares these texts.
function codeText(text, lines, comments) {
  const inComment = new Uint8Array(text.length);
  for (const c of comments) inComment.fill(1, c.pos, c.end);
  const code = [];
  for (let l = 0; l < lines.count; l++) {
    const end = lines.startOf(l + 1) ?? text.length;
    let s = "";
    for (let i = lines.startOf(l); i < end; i++) s += inComment[i] ? " " : text[i];
    s = s.replace(/\s+/g, " ").trim();
    if (s) code.push({ line: l + 1, text: s });
  }
  return code;
}
