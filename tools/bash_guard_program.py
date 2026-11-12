"""bash_guard_program.py: The program a simple command runs, past keywords, assignments and
wrappers, and the script a shell or python runs (step 3 of bash_guard.py).

Part of tools/bash_guard.py, which says how the guard reads a command.
"""

import os
import re

from bash_guard_words import ASSIGN_RE, SHELLS, rule_programs, skip_opts


RESERVED = {"if", "then", "else", "elif", "do", "while", "until", "{", "}",
            "!", "fi", "done", "esac", "for", "select", "case", "in", "coproc"}


# Wrappers run the command that follows them. Value options take a value.
WRAPPERS = {
    "env": {"-u", "--unset", "-C", "--chdir", "-P"},
    "nice": {"-n", "--adjustment"},
    "timeout": {"-s", "--signal", "-k", "--kill-after"},
    "caffeinate": {"-t", "-w"},
    "xargs": {"-I", "-i", "-n", "-P", "-L", "-l", "-d", "-E", "-e", "-s",
              "-a", "--delimiter", "--max-args", "--max-procs", "--replace",
              "--arg-file", "--max-lines"},
    "time": {"-f", "-o", "--format", "--output"},
    "exec": {"-a"},
    "stdbuf": {"-i", "-o", "-e", "--input", "--output", "--error"},
    "command": set(), "builtin": set(), "nohup": set(), "unbuffer": set(),
    "xcrun": {"-sdk", "--sdk", "-toolchain", "--toolchain", "--log"},
}


# Lookups print where a program is; they never run it.
LOOKUP_OPTS = {"command": {"-v", "-V"}, "xcrun": {"-f", "--find"}}


RUNNERS = {"npx", "bunx", "pnpm", "yarn", "npm", "bun"}


# Programs that run whatever follows their -- (env loaders and secret managers).
LAUNCHERS = {"dotenv", "dotenvx", "op", "doppler", "direnv", "infisical",
             "aws-vault", "with-env", "envchain", "chamber"}


RUNNER_VALUE_OPTS = {"-p", "--package", "--prefix", "--filter", "-C", "--dir",
                     "-w", "--workspace", "--cwd"}


# A shell or python given a script file runs that file. Options that take a
# value are skipped; -c, -s and -m mean there is no script file.
PYTHON_RE = re.compile(r"^python[0-9.]*$")


SHELL_SCRIPT_VALUE_OPTS = {"-o", "+o", "-O", "+O", "--rcfile", "--init-file"}


PYTHON_VALUE_OPTS = {"-W", "-X", "--check-hash-based-pycs"}


# Runners that start the program after their own options: uv run, uvx, pipx run.
PY_RUNNERS = {"uv": "run", "uvx": None, "pipx": "run"}


PY_RUNNER_VALUE_OPTS = {"--with", "--with-requirements", "--with-editable", "--python",
                        "-p", "--project", "--directory", "--from", "--spec",
                        "--pip-args", "--index", "--extra", "--group", "--package"}


def program_of(argv, rule_programs, depth=0):
    """Return a dict: env names, assignment tokens (assigns), program, args,
    via_xargs, inner strings. NAME=value and NAME+=value are assignments."""
    w = ProgramWalk(argv)
    while w.i < len(w.argv):
        tok = w.argv[w.i]
        if tok in ("for", "select", "case"):
            break  # for x in WORDS: the words are data; do starts the next command
        if w.keyword_or_assignment(tok):
            continue
        base = os.path.basename(tok)
        if w.argv[w.i + 1:w.i + 2] and w.argv[w.i + 1] in LOOKUP_OPTS.get(base, ()):
            return w.result(base, w.argv[w.i + 1:])  # a lookup, not a run
        if w.wrapper(base) or w.runner(base, rule_programs):
            continue
        return w.launch(base, rule_programs, depth)
    return w.leftover()


class ProgramWalk:
    """program_of's walk along argv: the index, what it has collected, and
    the last wrapper that may run nothing. Each method reads one kind of
    word; a runner may rewrite argv for the rest of the walk."""

    def __init__(self, argv):
        self.argv, self.i = argv, 0
        self.env, self.assigns, self.via_xargs, self.inner = [], [], False, []
        self.last_wrapper = None  # (name, index) of a wrapper that may run nothing

    def result(self, prog, args):
        """The command dict program_of returns."""
        return {"env": self.env, "assigns": self.assigns, "prog": prog, "args": args,
                "via_xargs": self.via_xargs, "inner": self.inner}

    def keyword_or_assignment(self, tok):
        """Step past a shell keyword, a function name, or NAME=value."""
        if tok == "function":
            self.i += 2  # the keyword and the function name
            return True
        if tok in RESERVED:
            self.i += 1
            return True
        m = ASSIGN_RE.match(tok)
        if m:
            self.env.append(m.group(1))
            self.assigns.append(tok)
            self.i += 1
            return True
        return False

    def wrapper(self, base):
        """Step past script, uv run, uvx, pipx run or a WRAPPERS program and
        its options. False when base is none of those."""
        if base == "script":
            self.script()
            return True
        if base in PY_RUNNERS and (PY_RUNNERS[base] is None
                                   or self.argv[self.i + 1:self.i + 2] == [PY_RUNNERS[base]]):
            j = self.i + (1 if PY_RUNNERS[base] is None else 2)
            self.i = skip_opts(self.argv, j, PY_RUNNER_VALUE_OPTS)
            self.last_wrapper = None
            return True
        if base in WRAPPERS:
            self.plain_wrapper(base)
            return True
        return False

    def script(self):
        """script [-q] [-F pipe] [-t n] [file [command ...]]: util-linux runs
        the string -c gives, and the command follows the log file."""
        argv, j = self.argv, self.i + 1
        while j < len(argv) and argv[j].startswith("-") and argv[j] != "-":
            if argv[j] in ("-c", "--command") and j + 1 < len(argv):
                self.inner.append(argv[j + 1])  # util-linux runs this string
                j += 2
                continue
            j += 2 if argv[j] in ("-F", "-t", "-T", "-I", "-O", "-B", "-E") else 1
        self.i = j + 1  # the log file; the command follows it
        self.last_wrapper = None

    def plain_wrapper(self, base):
        """env, nice, timeout, xargs and the rest: step past their options."""
        self.via_xargs = self.via_xargs or base == "xargs"
        j, split = self.i + 1, False
        if base == "env":
            j, split = self.env_options(j)
        else:
            j = skip_opts(self.argv, j, WRAPPERS[base])
        if base == "timeout":
            j += 1  # the duration
        self.last_wrapper = None if split else (base, self.i)
        self.i = j

    def env_options(self, j):
        """env's options from j: the index after them, and whether -S (a
        split string, kept as inner text) was one."""
        argv, split = self.argv, False
        while j < len(argv) and argv[j].startswith("-"):
            if argv[j] in ("-S", "--split-string") and j + 1 < len(argv):
                self.inner.append(argv[j + 1])
                split = True
                j += 2
            elif argv[j] in WRAPPERS["env"]:
                j += 2
            else:
                j += 1
        return j, split

    def runner(self, base, rule_programs):
        """npx, pnpm exec and the rest: when the program they run is one the
        rules name, walk on from it. Their -c strings are inner text."""
        if base not in RUNNERS:
            return False
        argv, j = self.argv, self.i + 1
        while j + 1 < len(argv) and argv[j] in ("-c", "--call"):
            self.inner.append(argv[j + 1])
            j += 2
        j = skip_opts(argv, j, RUNNER_VALUE_OPTS)
        if j < len(argv) and argv[j] in ("exec", "dlx", "x"):
            j = skip_opts(argv, j + 1, RUNNER_VALUE_OPTS)
        if j < len(argv):
            nxt = re.sub(r"@[^/]*$", "", os.path.basename(argv[j]))
            if nxt in rule_programs and nxt not in RUNNERS:
                self.argv = argv[:j] + [nxt] + argv[j + 1:]
                self.i = j
                return True
        return False

    def launch(self, base, rule_programs, depth):
        """The program at i; a launcher (dotenv, op run) that runs a rule's
        program after -- is read as that program."""
        args = self.argv[self.i + 1:]
        launched = base in LAUNCHERS or (base in RUNNERS and args and
                                          os.path.basename(args[0]) in LAUNCHERS)
        if launched and "--" in args and depth < 3:
            k = args.index("--")
            if k + 1 < len(args) and os.path.basename(args[k + 1]) in rule_programs:
                deeper = program_of(args[k + 1:], rule_programs, depth + 1)
                deeper["env"] = self.env + deeper["env"]
                deeper["assigns"] = self.assigns + deeper["assigns"]
                deeper["inner"] = self.inner + deeper["inner"]
                return deeper
        return self.result(base, args)

    def leftover(self):
        """argv ran out: the last wrapper runs itself (a bare env), or none."""
        if self.last_wrapper:  # nothing followed, so the wrapper itself runs: bare env
            name, k = self.last_wrapper
            return self.result(name, self.argv[k + 1:])
        return self.result("", [])


def script_view(cmd, programs):
    """The script a shell or python runs from a file, seen as the program.

    bash keys.sh run X runs keys.sh, and python3 -I tools/claude_os_sync.py
    apply runs claude_os_sync.py. Returns a command dict for the script when
    the rules name it, else None. -c, -s, -m with no script name, and stdin
    mean there is no script file.
    """
    prog, args = cmd["prog"], cmd["args"]
    if prog in ("source", "."):
        j = 0
    elif prog in SHELLS:
        j = shell_script_index(args)
    elif PYTHON_RE.match(prog):
        j, module = python_script_index(args)
        if module:
            return module_view(cmd, args, j, programs)
    else:
        return None
    if j is None or j >= len(args) or args[j] == "-":
        return None
    name = os.path.basename(args[j])
    if name not in programs:
        return None
    return dict(cmd, prog=name, args=args[j + 1:], inner=[])


def shell_script_index(args):
    """Where a shell's script file name sits in args, past its options; None
    when -c or -s means it reads no script file."""
    j = 0
    while j < len(args) and args[j][:1] in ("-", "+") and args[j] != "-":
        tok = args[j]
        if tok == "--":
            j += 1
            break
        if tok in SHELL_SCRIPT_VALUE_OPTS:
            j += 2
            continue
        if re.match(r"^-[A-Za-z]+$", tok) and set(tok[1:]) & {"c", "s"}:
            return None
        j += 1
    return j


def python_script_index(args):
    """(index, module) for python's script, past its options: module is True
    when -m names a module at index + 1, and the index is None after -c."""
    j = 0
    while j < len(args) and args[j].startswith("-") and args[j] != "-":
        tok = args[j]
        if tok == "--":
            j += 1
            break
        if re.match(r"^-[A-Za-z]*m$", tok) and j + 1 < len(args):
            return j, True
        if re.match(r"^-[A-Za-z]*c", tok):
            return None, False
        j += 2 if tok in PYTHON_VALUE_OPTS else 1
    return j, False


def module_view(cmd, args, j, programs):
    """python -m a.b.c: the command as the module the rules name, c or
    c.py, with the words after it; None when the rules name neither."""
    last = args[j + 1].split(".")[-1]
    for name in (last, last + ".py"):
        if name in programs:
            return dict(cmd, prog=name, args=args[j + 2:], inner=[])
    return None
