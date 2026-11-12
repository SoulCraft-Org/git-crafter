"""claude_os_sync_lib.py: the read side of claude_os_sync.py.

The manifest and the overlay, where sources and destinations resolve, the
source and target checks, classify, and the read-only diff command.
Nothing here writes. The other commands and the write live in
claude_os_sync.py, whose docstring describes the tool.

Requires Python 3.9, standard library only.
"""

import difflib
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
DEFAULT_MANIFEST = os.path.join(ROOT, "manifest.json")
DEFAULT_RECORD = ".claude-os-managed.json"

GIT = "git"
# A git hook exports these to point git at the hook's own repository. Left in
# place, `git -C PATH` would report on that repository instead of PATH.
GIT_LOCATION_VARS = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE",
                     "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
                     "GIT_COMMON_DIR", "GIT_PREFIX")

IN_SYNC = "in-sync"
ABSENT = "absent"
DRIFTED = "drifted"
MODIFIED = "modified"
UNMANAGED = "unmanaged"
UNSAFE = "unsafe"
CANONICAL_MISSING = "canonical-missing"

CLEAN_STATUSES = (IN_SYNC,)

# apply copies only what main holds on GitHub: the root's HEAD must equal
# this ref right after a fetch of main into it.
MERGED_BRANCH = "main"
MERGED_REF = "refs/remotes/origin/main"

# A source with this prefix comes from the --overlay folder, not the Git Crafter
# root. A manifest may not use it.
OVERLAY_PREFIX = "overlay:"
# The only folders an overlay may install into: the account's config and its
# own rules, never settings, hooks or skills.
OVERLAY_DIRS = ("code-os", "rules")


def source_path(canonical_root, spec, src):
    """Return (root, absolute path) for a source: the overlay folder for an
    overlay source, else the Git Crafter root."""
    if src.startswith(OVERLAY_PREFIX):
        root = spec["overlay"]
        return root, os.path.join(root, src[len(OVERLAY_PREFIX):])
    return canonical_root, os.path.join(canonical_root, src)


def overlay_entries(top):
    """Yield each entry under top as a path relative to it, with / between
    parts, in sorted order. Dotfiles and dot-folders are skipped. A link to
    a folder is yielded as an entry, not walked into."""
    for dirpath, dirnames, filenames in os.walk(top):
        links = [d for d in dirnames
                 if os.path.islink(os.path.join(dirpath, d))]
        dirnames[:] = sorted(d for d in dirnames
                             if not d.startswith(".") and d not in links)
        for entry in sorted(filenames + links):
            if not entry.startswith("."):
                rel = os.path.relpath(os.path.join(dirpath, entry), top)
                yield rel.replace(os.sep, "/")


def check_overlay_entry(rel, taken):
    """Raise ValueError when overlay file rel may not install: it sits
    outside OVERLAY_DIRS, or the manifest already installs its path."""
    if rel.split("/")[0] not in OVERLAY_DIRS or "/" not in rel:
        raise ValueError("overlay file %s is outside %s"
                         % (rel, " and ".join(d + "/" for d in OVERLAY_DIRS)))
    if rel in taken:
        raise ValueError("overlay file %s would replace a file the "
                         "manifest installs" % rel)


def add_overlay(manifest, repo, folder):
    """Return a copy of manifest with folder's files added to repo, each
    installed at its path relative to folder. A file outside OVERLAY_DIRS,
    or one the manifest already installs, is a ValueError. A link is kept as
    an entry, so classify reports it unsafe instead of skipping it."""
    name, spec = select_repos(manifest, [repo])[0]
    top = os.path.realpath(os.path.expanduser(folder))
    if not os.path.isdir(top):
        raise ValueError("--overlay %s is not a folder" % folder)
    taken = set(spec["files"].values())
    files = dict(spec["files"])
    for rel in overlay_entries(top):
        check_overlay_entry(rel, taken)
        files[OVERLAY_PREFIX + rel] = rel
    repos = dict(manifest["repos"])
    repos[name] = dict(spec, files=files, overlay=top)
    return dict(manifest, repos=repos)


def unsafe(root, dest):
    """Why root/dest is no place to write, or None. A repo controls its own
    tree, so a committed link could aim apply at a file outside it."""
    dest_abs = os.path.join(root, dest)
    if os.path.islink(dest_abs):
        return "a symbolic link"
    real = os.path.realpath(dest_abs)
    if not real.startswith(os.path.realpath(root) + os.sep):
        return "outside the repo, at %s" % real
    return None


def unsafe_source(canonical_root, src_abs):
    """Why src_abs is no file to copy, or None. A committed link, in Git Crafter
    or an overlay, could pull a file from outside it into ~/.claude, where
    every session reads it. canonical_root is the root src_abs came from."""
    if os.path.islink(src_abs):
        return "the source is a symbolic link"
    real = os.path.realpath(src_abs)
    if not real.startswith(os.path.realpath(canonical_root) + os.sep):
        return "the source resolves outside %s, at %s" % (canonical_root,
                                                           real)
    return None


def sha256(path):
    """Return the hex SHA-256 of the file at path."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def run_git(path, args, extra_env=None):
    """Run git -C path with args, without a hook's GIT_* location variables,
    and return the CompletedProcess."""
    env = {k: v for k, v in os.environ.items() if k not in GIT_LOCATION_VARS}
    env.update(extra_env or {})
    return subprocess.run([GIT, "-C", path] + list(args), env=env,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          encoding="utf-8", errors="replace", timeout=60)


def target_state(path):
    """Return (branch, dirty, warning) for the checkout at path.

    dirty lists tracked files with staged or unstaged changes. When git cannot
    answer, branch and dirty are None and warning says why. The caller then
    fails open: could not check is not the same as dirty.
    """
    try:
        st = run_git(path, ["--no-optional-locks", "status", "--porcelain",
                             "--untracked-files=no"])
        br = run_git(path, ["symbolic-ref", "--short", "-q", "HEAD"])
    except (OSError, subprocess.SubprocessError) as exc:
        return None, None, "could not run git: %s" % exc
    if st.returncode != 0:
        return None, None, (st.stderr.strip().splitlines() or
                            ["git status exited %d" % st.returncode])[0]
    branch = br.stdout.strip() if br.returncode == 0 else ""
    return branch or "(detached HEAD)", st.stdout.splitlines(), None


def git_error(result, what):
    """Return "WHAT failed: " and the first line git printed."""
    lines = (result.stderr or result.stdout).strip().splitlines()
    return "%s failed: %s" % (what, lines[0] if lines else
                              "exit %d" % result.returncode)


def fetched_why(root):
    """Why fetching main into root failed, or None."""
    fetch = run_git(root, ["fetch", "--quiet", "origin",
                           "refs/heads/%s:%s" % (MERGED_BRANCH, MERGED_REF)])
    if fetch.returncode != 0:
        return git_error(fetch, "git fetch origin %s" % MERGED_BRANCH)
    return None


def on_main_why(root):
    """Why root is not on main, or None."""
    br = run_git(root, ["symbolic-ref", "--short", "-q", "HEAD"])
    branch = br.stdout.strip() if br.returncode == 0 else ""
    if branch != MERGED_BRANCH:
        return "the checkout %s is on %s, not %s" % (
            root, branch or "a detached HEAD", MERGED_BRANCH)
    return None


def clean_why(root):
    """Why root has a tracked change or an untracked file, or None."""
    st = run_git(root, ["--no-optional-locks", "status", "--porcelain"])
    if st.returncode != 0:
        return git_error(st, "git status")
    if st.stdout.strip():
        return ("the checkout %s has uncommitted changes or untracked "
                "files: %s" % (root, st.stdout.splitlines()[0].strip()))
    return None


def head_merged_why(root):
    """Why root's HEAD is not origin/main, or None."""
    revs = run_git(root, ["rev-parse", "HEAD", MERGED_REF])
    if revs.returncode != 0:
        return git_error(revs, "git rev-parse")
    head, merged = revs.stdout.split()
    if head != merged:
        return ("HEAD %s is not origin/%s %s; only merged content is "
                "installed" % (head[:7], MERGED_BRANCH, merged[:7]))
    return None


def tracked_why(root, paths):
    """Why some of paths (relative to root) are not tracked, or None."""
    listed = run_git(root, ["ls-files", "-z", "--"] + list(paths))
    if listed.returncode != 0:
        return git_error(listed, "git ls-files")
    untracked = sorted(set(paths) - set(listed.stdout.split("\0")))
    if untracked:
        return "not tracked in git: %s" % ", ".join(untracked)
    return None


def merged_source(root, paths):
    """Why apply must not copy from root, or None when root holds only
    reviewed, merged content: a checkout on main with no tracked change and
    no untracked file, whose HEAD equals origin/main after a fetch, with
    every path in paths (relative to root) tracked. Fails closed: when git
    cannot answer, the answer is a refusal."""
    try:
        return (fetched_why(root) or on_main_why(root) or clean_why(root)
                or head_merged_why(root) or tracked_why(root, paths))
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return "could not check the checkout %s: %s" % (root, exc)


def protected_folders():
    """Where --repo-path may never aim apply: this account's Claude config,
    whose rules and guard every session reads."""
    folders = ["~/.claude"]
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        folders.append(os.environ["CLAUDE_CONFIG_DIR"])
    return [os.path.realpath(os.path.expanduser(f)) for f in folders]


def within(path, folder):
    """True when path, resolved, is folder or inside it."""
    real = os.path.realpath(os.path.expanduser(path))
    return real == folder or real.startswith(folder + os.sep)


def protected_why(repo_path):
    """Why --repo-path aims at a protected folder, or None."""
    if repo_path is None:
        return None
    for folder in protected_folders():
        if within(repo_path, folder):
            return ("--repo-path never aims apply at %s; user-claude "
                    "installs there from the manifest" % folder)
    return None


def root_sources(spec):
    """The repo's Git Crafter sources that exist, relative to ROOT."""
    return [src for src in spec["files"]
            if not src.startswith(OVERLAY_PREFIX)
            and os.path.exists(os.path.join(ROOT, src))]


def overlay_sources(spec):
    """The repo's overlay sources, relative to the overlay folder."""
    return [src[len(OVERLAY_PREFIX):] for src in spec["files"]
            if src.startswith(OVERLAY_PREFIX)]


def merged_only(manifest_path, manifest, repo, repo_path,
                check=merged_source):
    """Why plan and apply must not copy for this command line, or None."""
    why = protected_why(repo_path)
    if why:
        return why
    if not within(manifest_path, ROOT):
        return ("the manifest %s is outside the Git Crafter checkout %s"
                % (manifest_path, ROOT))
    spec = manifest["repos"][repo]
    paths = [os.path.relpath(os.path.realpath(manifest_path), ROOT)]
    why = check(ROOT, paths + root_sources(spec))
    if why or not spec.get("overlay"):
        return why
    # The overlay is installed only once its own pull request has merged.
    return check(spec["overlay"], overlay_sources(spec))


def escapes(path):
    """True when a manifest path is absolute or climbs out with .."""
    return os.path.isabs(path) or ".." in path.split(os.sep)


def check_repo_spec(name, spec):
    """Raise ValueError when one manifest repo entry is malformed."""
    if "path" not in spec or "files" not in spec:
        raise ValueError("repo %r needs both path and files" % name)
    for src in spec["files"]:
        if escapes(src) or src.startswith(OVERLAY_PREFIX):
            raise ValueError("source %r must be relative and inside the "
                             "Git Crafter root" % src)
    for dest in spec["files"].values():
        if escapes(dest):
            raise ValueError("destination %r must be relative to the repo "
                             "root and must not escape it" % dest)


def load_manifest(path):
    """Read and check the manifest at path. ValueError when malformed."""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or "repos" not in data:
        raise ValueError("manifest must be a JSON object with a repos key")
    for name, spec in data["repos"].items():
        check_repo_spec(name, spec)
    return data


def repo_root(spec):
    """The absolute path of a repo entry's checkout."""
    return os.path.abspath(os.path.expanduser(spec["path"]))


def record_name(manifest):
    """The record file's path, relative to the target checkout."""
    return manifest.get("record_file", DEFAULT_RECORD)


def record_path(manifest, spec):
    """The record file's absolute path in the repo entry's checkout."""
    return os.path.join(repo_root(spec), record_name(manifest))


def load_record(manifest, spec):
    """The record of what was last synced; empty when absent or unreadable."""
    path = record_path(manifest, spec)
    if not os.path.exists(path):
        return {"files": {}}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {"files": {}}
    data.setdefault("files", {})
    return data


def changed_status(entry, dest_hash):
    """(status, detail) for a copy that differs from canonical, from its
    record entry: unmanaged, drifted or modified."""
    if entry is None:
        return UNMANAGED, "exists but was never synced here"
    if entry.get("sha256") == dest_hash:
        return DRIFTED, "last synced %s" % entry.get("synced_at", "unknown")
    return MODIFIED, ("edited in place since %s"
                      % entry.get("synced_at", "last sync"))


def file_status(canonical_root, spec, root, record, src, dest):
    """(status, detail) for one manifest entry."""
    src_root, src_abs = source_path(canonical_root, spec, src)
    dest_abs = os.path.join(root, dest)
    why = unsafe(root, dest) or unsafe_source(src_root, src_abs)
    if why:
        return UNSAFE, why
    if not os.path.exists(src_abs):
        return CANONICAL_MISSING, src_abs
    canon_hash = sha256(src_abs)
    if not os.path.exists(dest_abs):
        return ABSENT, ""
    dest_hash = sha256(dest_abs)
    if dest_hash == canon_hash:
        return IN_SYNC, ""
    return changed_status(record["files"].get(dest), dest_hash)


def classify(canonical_root, manifest, spec):
    """Return a list of (source, dest, status, detail)."""
    root = repo_root(spec)
    record = load_record(manifest, spec)
    # The manifest's files first, then the overlay's.
    order = sorted(spec["files"].items(),
                   key=lambda i: (i[0].startswith(OVERLAY_PREFIX), i))
    return [(src, dest) + file_status(canonical_root, spec, root, record,
                                      src, dest)
            for src, dest in order]


def select_repos(manifest, names):
    """[(name, spec)] for names, or every repo when names is empty.
    ValueError names an unknown repo."""
    if not names:
        return list(manifest["repos"].items())
    out = []
    for n in names:
        if n not in manifest["repos"]:
            raise ValueError("no repo %r in the manifest; known: %s"
                             % (n, ", ".join(sorted(manifest["repos"]))))
        out.append((n, manifest["repos"][n]))
    return out


def override_repo_path(manifest, name, path):
    """Return a copy of manifest with one repo pointed at another checkout."""
    name, spec = select_repos(manifest, [name])[0]
    repos = dict(manifest["repos"])
    repos[name] = dict(spec, path=path)
    return dict(manifest, repos=repos)


def read_lines(path):
    """The lines of the UTF-8 text file at path."""
    with open(path, encoding="utf-8") as fh:
        return fh.readlines()


def cmd_diff(canonical_root, manifest, repo, target):
    """Print a unified diff of canonical against the repo copy of target, a
    source or destination path. Return 0 when identical, 1 when different
    or absent, 2 when no entry matches."""
    spec = manifest["repos"][repo]
    root = repo_root(spec)
    matches = [(s, d) for s, d in spec["files"].items()
               if target in (s, d)]
    if not matches:
        print("no manifest entry matching %r in %s" % (target, repo),
              file=sys.stderr)
        return 2
    src, dest = matches[0]
    src_abs = source_path(canonical_root, spec, src)[1]
    dest_abs = os.path.join(root, dest)
    if not os.path.exists(dest_abs):
        print("%s: absent in %s" % (dest, repo))
        return 1
    out = list(difflib.unified_diff(
        read_lines(src_abs), read_lines(dest_abs),
        fromfile="canonical/" + src, tofile=repo + "/" + dest))
    if not out:
        print("%s: identical" % dest)
        return 0
    sys.stdout.writelines(out)
    return 1
