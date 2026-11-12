// Commented-out code, found in the comments complexity.mjs reads.
import ts from "typescript";

const K = ts.SyntaxKind;

// Commented-out code: three or more `//` lines in a row, each alone on its
// line, or one `/* */` block of three or more lines (not JSDoc), whose text
// parses as TypeScript and holds at least one real statement. Prose fails the
// parse, so a long explanation is never counted.
export function commentedOutCode(comments) {
  const runs = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) runs.push(run);
    run = [];
  };
  for (const c of comments) {
    if (c.block) {
      flush();
      if (/^\/\*(?!\*)/.test(c.text) && c.endLine - c.line >= 2) runs.push([c]);
    } else if (c.ownLine && c.text.startsWith("//")) {
      if (run.length && c.line !== run.at(-1).line + 1) flush();
      run.push(c);
    } else {
      flush();
    }
  }
  flush();
  return runs
    .filter((r) => looksLikeCode(r.map(uncomment).join("\n")))
    .map((r) => ({ line: r[0].line, lines: r.at(-1).endLine - r[0].line + 1 }));
}

function uncomment(c) {
  if (!c.block) return c.text.replace(/^\/\/ ?/, "");
  return c.text
    .replace(/^\/\*|\*\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n");
}

const STATEMENTS = new Set([
  K.VariableStatement,
  K.FunctionDeclaration,
  K.ClassDeclaration,
  K.ImportDeclaration,
  K.ExportDeclaration,
  K.ExportAssignment,
  K.ReturnStatement,
  K.IfStatement,
  K.ForStatement,
  K.ForOfStatement,
  K.ForInStatement,
  K.WhileStatement,
  K.TryStatement,
  K.ThrowStatement,
  K.SwitchStatement,
]);

// True when comment text parses as TypeScript and holds a real statement.
export function looksLikeCode(code) {
  const sf = ts.createSourceFile("comment.ts", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  // parseDiagnostics is not in the public typings; if a TypeScript release
  // drops it, say so rather than count every comment as clean.
  if (!Array.isArray(sf.parseDiagnostics)) throw new Error("typescript no longer exposes parseDiagnostics");
  if (sf.parseDiagnostics.length) return false;
  return sf.statements.some((s) => {
    if (STATEMENTS.has(s.kind)) return true;
    if (!ts.isExpressionStatement(s)) return false;
    const e = s.expression;
    return ts.isCallExpression(e) || ts.isAwaitExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === K.EqualsToken);
  });
}
