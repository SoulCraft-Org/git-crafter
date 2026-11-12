// The Python side of complexity.mjs: a script python3 runs on stdin.

// Python functions, read with Python's own ast module in one python3 -I call
// (isolated: no site packages, no current-folder imports). It reads
// [{ path, text }] as JSON on stdin and prints [{ path, functions }] or
// [{ path, error }]. Complexity follows the same rules as for TypeScript: 1,
// plus one for each if and elif, conditional expression, loop, comprehension
// for and if, except, non-wildcard match case, and each and or or past the
// first. A nested def or class method is measured on its own; a lambda adds
// nothing to the def around it. code.mjs turns each span into code lines.
// Each function also says whether it has a docstring (doc) and where it
// starts, decorators included (first), for the header-comment share.
// Each file also lists the names it uses (uses): every name read, attribute,
// imported name, parameter name (a pytest fixture is asked for that way) and
// identifier held in a string such as module:function, for the unused-function count.
export const PY_FUNCTIONS = `
import ast, json, sys
BRANCH = (ast.If, ast.IfExp, ast.For, ast.AsyncFor, ast.While, ast.ExceptHandler)
DEFS = (ast.FunctionDef, ast.AsyncFunctionDef)
def measure(fn, name, out):
    first = min([fn.lineno] + [d.lineno for d in fn.decorator_list])
    rec = {"name": name, "line": fn.lineno, "end": fn.end_lineno, "complexity": 1, "first": first, "doc": ast.get_docstring(fn) is not None}
    out.append(rec)
    stack = list(ast.iter_child_nodes(fn))
    while stack:
        node = stack.pop()
        if isinstance(node, DEFS):
            measure(node, name + "." + node.name, out)
            continue
        if isinstance(node, ast.ClassDef):
            walk(node, name + "." + node.name, out)
            continue
        if isinstance(node, ast.Lambda):
            continue
        if isinstance(node, BRANCH):
            rec["complexity"] += 1
        elif isinstance(node, ast.comprehension):
            rec["complexity"] += 1 + len(node.ifs)
        elif isinstance(node, ast.BoolOp):
            rec["complexity"] += len(node.values) - 1
        elif isinstance(node, ast.match_case) and not (isinstance(node.pattern, ast.MatchAs) and node.pattern.pattern is None):
            rec["complexity"] += 1
        stack.extend(ast.iter_child_nodes(node))
def walk(parent, prefix, out):
    for node in ast.iter_child_nodes(parent):
        name = prefix + "." + getattr(node, "name", "") if prefix else getattr(node, "name", "")
        if isinstance(node, DEFS):
            measure(node, name, out)
        elif isinstance(node, ast.ClassDef):
            walk(node, name, out)
        else:
            walk(node, prefix, out)
def uses(tree):
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, ast.alias):
            names.add(node.name.split(".")[-1])
        elif isinstance(node, ast.arg):
            names.add(node.arg)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str):
            names.update(part for part in node.value.replace(":", ".").split(".") if part.isidentifier())
    return names
result = []
for f in json.load(sys.stdin):
    try:
        out = []
        tree = ast.parse(f["text"], f["path"])
        walk(tree, "", out)
        result.append({"path": f["path"], "functions": out, "uses": sorted(uses(tree))})
    except (SyntaxError, ValueError) as err:
        result.append({"path": f["path"], "error": type(err).__name__ + " line " + str(getattr(err, "lineno", "?"))})
json.dump(result, sys.stdout)
`;
