"""Self-test scenarios for tools/claude_os_sync.py.

Run them with `python3 -I tools/claude_os_sync.py --self-test`, which
appends this folder to sys.path and calls run() with the tool's module.
Each scenario works in temp folders and throwaway git checkouts; the git
ones skip when git is missing.
"""

import contextlib
import io
import json
import os
import shutil
import tempfile

sync = None
lib = None


def run(module):
    """Run every scenario against module, the loaded claude_os_sync.py.
    Return 0 when all pass, else 1."""
    global sync, lib
    sync, lib = module, module.lib
    return self_test()


def self_test():
    ok = True

    def check(cond, label):
        print("self-test: %s: %s" % (label, "OK" if cond else "FAIL"))
        return cond

    work = tempfile.mkdtemp(prefix="claude-os-sync-")
    try:
        canon = os.path.join(work, "canonical")
        repo = os.path.join(work, "repo")
        os.makedirs(os.path.join(canon, "tools"))
        os.makedirs(os.path.join(repo, "04_tools"))
        src = os.path.join(canon, "tools", "thing.py")
        dest = os.path.join(repo, "04_tools", "thing.py")
        with open(src, "w", encoding="utf-8") as fh:
            fh.write("version one\n")

        manifest = {
            "version": 1,
            "record_file": ".claude-os-managed.json",
            "repos": {"r": {"path": repo,
                            "files": {"tools/thing.py": "04_tools/thing.py"}}},
        }
        spec = manifest["repos"]["r"]

        st = lib.classify(canon, manifest, spec)[0][2]
        ok = check(st == lib.ABSENT, "missing destination reads as absent") and ok

        rc = sync.cmd_apply(canon, manifest, "r", yes=True, force=False,
                       adopt=False, dry_run=False)
        ok = check(rc == 0 and os.path.exists(dest), "apply writes the file") and ok
        ok = check(os.path.exists(os.path.join(repo, ".claude-os-managed.json")),
                   "apply records what it wrote") and ok

        st = lib.classify(canon, manifest, spec)[0][2]
        ok = check(st == lib.IN_SYNC, "after apply the copy reads in-sync") and ok

        with open(src, "w", encoding="utf-8") as fh:
            fh.write("version two\n")
        st = lib.classify(canon, manifest, spec)[0][2]
        ok = check(st == lib.DRIFTED, "canonical moving ahead reads as drifted") and ok

        with open(dest, "w", encoding="utf-8") as fh:
            fh.write("someone edited this by hand\n")
        st = lib.classify(canon, manifest, spec)[0][2]
        ok = check(st == lib.MODIFIED, "editing the copy reads as modified") and ok

        rc = sync.cmd_apply(canon, manifest, "r", yes=True, force=False,
                       adopt=False, dry_run=False)
        with open(dest, encoding="utf-8") as fh:
            body = fh.read()
        ok = check("edited this by hand" in body,
                   "apply refuses to clobber an in-place edit") and ok

        rc = sync.cmd_apply(canon, manifest, "r", yes=True, force=True,
                       adopt=False, dry_run=False)
        with open(dest, encoding="utf-8") as fh:
            body = fh.read()
        ok = check(body == "version two\n", "--force overwrites on request") and ok

        os.unlink(os.path.join(repo, ".claude-os-managed.json"))
        with open(dest, "w", encoding="utf-8") as fh:
            fh.write("pre-existing unmanaged file\n")
        st = lib.classify(canon, manifest, spec)[0][2]
        ok = check(st == lib.UNMANAGED, "a never-synced file reads as unmanaged") and ok
        sync.cmd_apply(canon, manifest, "r", yes=True, force=False,
                  adopt=False, dry_run=False)
        with open(dest, encoding="utf-8") as fh:
            body = fh.read()
        ok = check("pre-existing" in body,
                   "apply refuses to adopt without --adopt") and ok

        before = open(dest, encoding="utf-8").read()
        rc = sync.cmd_apply(canon, manifest, "r", yes=True, force=False,
                       adopt=True, dry_run=True)
        after = open(dest, encoding="utf-8").read()
        ok = check(before == after, "dry run writes nothing") and ok

        rc = sync.cmd_apply(canon, manifest, "r", yes=False, force=False,
                       adopt=True, dry_run=False)
        after = open(dest, encoding="utf-8").read()
        ok = check(rc == 2 and before == after,
                   "apply without --yes writes nothing") and ok

        try:
            load_manifest_from_obj(
                {"repos": {"r": {"path": "/tmp", "files": {"a": "../escape"}}}})
            ok = check(False, "destination escaping the repo is rejected")
        except ValueError:
            ok = check(True, "destination escaping the repo is rejected") and ok

        # The scenario above runs in a plain folder, not a git checkout, so
        # every apply in it also proves the target check fails open.
        ok = self_test_targets(os.path.join(work, "targets"), check) and ok
        ok = self_test_links(os.path.join(work, "links"), canon, check) and ok
        ok = self_test_whole(os.path.join(work, "whole"), check) and ok
        ok = self_test_overlay(os.path.join(work, "overlay"), check) and ok
        ok = self_test_merged(os.path.join(work, "merged"), check) and ok
    finally:
        shutil.rmtree(work, ignore_errors=True)

    print("self-test:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


# A gate that lets every source through, for self-test scenarios whose
# subject is the target, not the source.
OPEN = lambda *_args: None  # noqa: E731


def run_main(argv, gate=None):
    """Run main() as the command line would. Return (exit code, all output).
    gate replaces the source check, for scenarios about something else."""
    out = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        try:
            rc = sync.main(argv, gate)
        except SystemExit as exc:
            rc = exc.code
    return rc, out.getvalue()


def self_test_targets(work, check):
    """--repo-path, and the dirty-target refusal, against real git checkouts.

    The manifest sits alone in its own folder, and its one source is this
    script. So a correct write also proves sources resolve from the Git Crafter
    root and not from wherever the manifest lives.
    """
    if shutil.which(lib.GIT) is None:
        print("self-test: --repo-path and dirty-target checks: SKIP "
              "(git not found)")
        return True

    git_env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

    def git(path, *args):
        r = lib.run_git(path, ["-c", "user.name=self-test",
                           "-c", "user.email=self-test@invalid",
                           "-c", "commit.gpgsign=false"] + list(args),
                    extra_env=git_env)
        if r.returncode != 0:
            raise RuntimeError("git %s: %s" % (" ".join(args), r.stderr))

    ok = True
    self_path = os.path.realpath(sync.__file__)
    main_co = os.path.join(work, "main")
    worktree = os.path.join(work, "worktree")
    manifest_path = os.path.join(work, "elsewhere", "manifest.json")
    dest = os.path.join("04_tools", "synced.py")
    record = ".claude-os-managed.json"

    os.makedirs(main_co)
    os.makedirs(os.path.dirname(manifest_path))
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "record_file": record,
                   "repos": {"r": {"path": main_co, "files": {
                       os.path.relpath(self_path, lib.ROOT): dest}}}}, fh)
    with open(os.path.join(main_co, "README.md"), "w", encoding="utf-8") as fh:
        fh.write("tracked\n")
    git(main_co, "init", "-q")
    git(main_co, "checkout", "-q", "-b", "someone-elses-branch")
    git(main_co, "add", "README.md")
    git(main_co, "commit", "-q", "-m", "seed")
    git(main_co, "worktree", "add", "-q", "-b", "my-branch", worktree)
    with open(os.path.join(worktree, "scratch.txt"), "w",
              encoding="utf-8") as fh:
        fh.write("untracked\n")

    m = ["--manifest", manifest_path]
    in_main = lambda p: os.path.exists(os.path.join(main_co, p))
    in_wt = lambda p: os.path.exists(os.path.join(worktree, p))

    rc, out = run_main(["apply", "r", "--yes", "--repo-path", worktree] + m,
                       OPEN)
    ok = check(rc == 0 and in_wt(dest), "--repo-path redirects the write") and ok
    ok = check(in_wt(record), "--repo-path redirects the record file") and ok
    ok = check(not in_main(dest) and not in_main(record),
               "--repo-path leaves the manifest's checkout alone") and ok
    ok = check(in_wt(dest) and lib.sha256(os.path.join(worktree, dest))
               == lib.sha256(self_path),
               "sources resolve from the Git Crafter root, not the manifest's "
               "folder") and ok
    ok = check("my-branch" in out, "apply names the branch it writes into") and ok
    ok = check(rc == 0, "untracked files do not make a target dirty") and ok

    rc_wt = run_main(["status", "r", "--repo-path", worktree] + m)[0]
    rc_main = run_main(["status", "r"] + m)[0]
    ok = check(rc_wt == 0 and rc_main == 1, "status honours --repo-path") and ok
    rc_wt = run_main(["diff", "r", dest, "--repo-path", worktree] + m)[0]
    rc_main = run_main(["diff", "r", dest] + m)[0]
    ok = check(rc_wt == 0 and rc_main == 1, "diff honours --repo-path") and ok
    rc_wt = run_main(["plan", "r", "--repo-path", worktree] + m, OPEN)[0]
    rc_main = run_main(["plan", "r"] + m, OPEN)[0]
    ok = check(rc_wt == 0 and rc_main == 1, "plan honours --repo-path") and ok
    rc = run_main(["status", "--repo-path", worktree] + m)[0]
    ok = check(rc == 2, "--repo-path without exactly one REPO is a usage "
                        "error") and ok

    with open(os.path.join(main_co, "README.md"), "a", encoding="utf-8") as fh:
        fh.write("someone's work in progress\n")
    rc, out = run_main(["apply", "r", "--yes"] + m, OPEN)
    ok = check(rc == 1 and not in_main(dest),
               "apply refuses a target with unstaged changes") and ok
    ok = check("someone-elses-branch" in out,
               "the refusal names the branch it would write into") and ok
    git(main_co, "add", "README.md")
    rc = run_main(["apply", "r", "--yes"] + m, OPEN)[0]
    ok = check(rc == 1 and not in_main(dest),
               "apply refuses a target with staged changes") and ok
    rc, out = run_main(["plan", "r"] + m, OPEN)
    ok = check(rc == 1 and "REFUSE" in out and not in_main(dest),
               "plan previews the dirty-target refusal") and ok

    rc = run_main(["apply", "r", "--yes", "--force-target"] + m, OPEN)[0]
    ok = check(rc == 0 and in_main(dest),
               "--force-target writes into a dirty target on request") and ok

    for p in (dest, record):
        if in_main(p):
            os.unlink(os.path.join(main_co, p))
    saved, lib.GIT = lib.GIT, os.path.join(work, "no-such-git")
    try:
        rc, out = run_main(["apply", "r", "--yes"] + m, OPEN)
    finally:
        lib.GIT = saved
    ok = check(rc == 0 and in_main(dest) and "WARNING" in out,
               "apply fails open with a warning when git is missing") and ok
    return ok


def self_test_links(work, canon, check):
    """A committed link must never aim apply at a file outside the repo,
    whatever the flags."""
    ok = True
    outside = os.path.join(work, "outside")
    os.makedirs(outside)
    target = os.path.join(outside, "target.py")
    with open(target, "w", encoding="utf-8") as fh:
        fh.write("somebody else's file\n")

    def apply_into(repo, dest):
        manifest = {"version": 1, "record_file": ".claude-os-managed.json",
                    "repos": {"r": {"path": repo,
                                    "files": {"tools/thing.py": dest}}}}
        return sync.cmd_apply(canon, manifest, "r", yes=True, force=True,
                         adopt=True, dry_run=False)

    def body():
        with open(target, encoding="utf-8") as fh:
            return fh.read()

    linked_file = os.path.join(work, "linked-file")
    os.makedirs(os.path.join(linked_file, "04_tools"))
    os.symlink(target, os.path.join(linked_file, "04_tools", "thing.py"))
    rc = apply_into(linked_file, "04_tools/thing.py")
    ok = check(rc == 1 and body() == "somebody else's file\n",
               "a destination that is a link is never written through, "
               "even with --force and --adopt") and ok

    linked_dir = os.path.join(work, "linked-dir")
    os.makedirs(linked_dir)
    os.symlink(outside, os.path.join(linked_dir, "04_tools"))
    rc = apply_into(linked_dir, "04_tools/target.py")
    ok = check(rc == 1 and body() == "somebody else's file\n",
               "a destination under a linked folder is never written") and ok
    return ok


def self_test_whole(work, check):
    """apply lands every file or none: one refused file stops the rest, and
    every copy is staged before any destination changes."""
    ok = True
    canon = os.path.join(work, "canonical")
    repo = os.path.join(work, "repo")
    os.makedirs(os.path.join(canon, "tools"))
    os.makedirs(os.path.join(repo, "tools"))
    for name in ("entry.py", "module.py"):
        with open(os.path.join(canon, "tools", name), "w",
                  encoding="utf-8") as fh:
            fh.write("canonical %s\n" % name)
    manifest = {"version": 1, "record_file": ".claude-os-managed.json",
                "repos": {"r": {"path": repo, "files": {
                    "tools/entry.py": "tools/entry.py",
                    "tools/module.py": "tools/module.py"}}}}
    entry = os.path.join(repo, "tools", "entry.py")
    module = os.path.join(repo, "tools", "module.py")
    record = os.path.join(repo, ".claude-os-managed.json")

    with open(module, "w", encoding="utf-8") as fh:
        fh.write("never synced here\n")
    rc = sync.cmd_apply(canon, manifest, "r", yes=True, force=False, adopt=False,
                   dry_run=False)
    ok = check(rc == 1 and not os.path.exists(entry)
               and not os.path.exists(record),
               "one refused file stops every write, the record too") and ok
    os.unlink(module)

    saved, seen, fail_at = shutil.copy2, [], [2]

    def copy(src, dst):
        seen.append(os.path.exists(entry) or os.path.exists(module))
        if len(seen) in fail_at:
            raise OSError("disk full")
        return saved(src, dst)

    shutil.copy2 = copy
    try:
        sync.cmd_apply(canon, manifest, "r", yes=True, force=False, adopt=False,
                  dry_run=False)
        ok = check(False, "a failed copy is reported") and ok
    except OSError:
        ok = check(True, "a failed copy is reported") and ok
    finally:
        shutil.copy2 = saved
    ok = check(sorted(os.listdir(os.path.join(repo, "tools"))) == [],
               "a failed copy leaves no file and no staged copy") and ok

    seen[:], fail_at[:] = [], []
    shutil.copy2 = copy
    try:
        rc = sync.cmd_apply(canon, manifest, "r", yes=True, force=False,
                       adopt=False, dry_run=False)
    finally:
        shutil.copy2 = saved
    ok = check(rc == 0 and seen == [False, False],
               "every copy is staged before any destination lands") and ok
    ok = check(sorted(os.listdir(os.path.join(repo, "tools")))
               == ["entry.py", "module.py"]
               and all(r[2] == lib.IN_SYNC
                       for r in lib.classify(canon, manifest,
                                         manifest["repos"]["r"])),
               "the staged copies land in sync, with no temp file left") and ok

    for name in ("entry.py", "module.py"):
        os.unlink(os.path.join(repo, "tools", name))
    os.unlink(record)
    real, calls, err = os.replace, [], io.StringIO()

    def replace(src, dst):
        calls.append(dst)
        if len(calls) == 2:
            raise OSError("rename failed")
        return real(src, dst)

    os.replace = replace
    try:
        with contextlib.redirect_stderr(err):
            rc = sync.cmd_apply(canon, manifest, "r", yes=True, force=False,
                                adopt=False, dry_run=False)
    finally:
        os.replace = real
    left = os.listdir(os.path.join(repo, "tools"))
    ok = check(rc != 0 and not any(".claude-os-sync-" in n for n in left)
               and "landed: tools/entry.py" in err.getvalue()
               and "left unwritten: tools/module.py" in err.getvalue()
               and "\nREFUSE" in "\n" + err.getvalue()
               and not os.path.exists(record),
               "a failed rename drops the staged rest and names both sets") and ok
    return ok


def self_test_overlay(work, check):
    """--overlay installs an account's own files after the manifest's, only
    under code-os/ and rules/, never over a template file or through a
    link, and the source check covers the overlay's own checkout."""
    ok = True
    canon = os.path.join(work, "canonical")
    repo = os.path.join(work, "repo")
    over = os.path.join(work, "overlay")
    for d in (os.path.join(canon, "rules"), repo,
              os.path.join(over, "code-os"), os.path.join(over, "rules")):
        os.makedirs(d)

    def write(path, text):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)

    write(os.path.join(canon, "rules", "a.md"), "template\n")
    write(os.path.join(over, "code-os", "account.json"), '{"keys": {}}\n')
    write(os.path.join(over, "rules", "mine.md"), "account rule\n")
    write(os.path.join(over, "rules", ".DS_Store"), "junk\n")
    manifest = {"version": 1, "record_file": ".claude-os-managed.json",
                "repos": {"r": {"path": repo,
                                "files": {"rules/a.md": "rules/a.md"}}}}

    added = lib.add_overlay(manifest, "r", over)
    spec = added["repos"]["r"]
    rows = lib.classify(canon, added, spec)
    ok = check([r[1] for r in rows] == ["rules/a.md", "code-os/account.json",
                                        "rules/mine.md"],
               "overlay files follow the manifest's, dotfiles skipped") and ok
    ok = check("overlay" not in manifest["repos"]["r"],
               "add_overlay leaves the manifest it was given alone") and ok
    rc = sync.cmd_apply(canon, added, "r", yes=True, force=False, adopt=False,
                   dry_run=False)
    dest = os.path.join(repo, "code-os", "account.json")
    ok = check(rc == 0 and os.path.exists(dest)
               and os.path.exists(os.path.join(repo, "rules", "mine.md")),
               "apply installs the overlay into the target") and ok
    record = lib.load_record(added, spec)["files"]
    ok = check(record.get("code-os/account.json", {}).get("source")
               == lib.OVERLAY_PREFIX + "code-os/account.json",
               "the record names an overlay file's source") and ok
    ok = check(all(r[2] == lib.IN_SYNC for r in lib.classify(canon, added, spec)),
               "after apply every overlay file reads in-sync") and ok
    write(os.path.join(over, "code-os", "account.json"), '{"keys": 1}\n')
    st = dict((r[1], r[2]) for r in lib.classify(canon, added, spec))
    ok = check(st["code-os/account.json"] == lib.DRIFTED,
               "an overlay edit reads as drifted") and ok

    for bad, why in ((os.path.join("settings.json"), "outside"),
                     (os.path.join("skills", "x.md"), "outside"),
                     (os.path.join("rules", "a.md"), "replace")):
        extra = os.path.join(work, "bad-" + why + str(len(bad)))
        os.makedirs(os.path.dirname(os.path.join(extra, bad)), exist_ok=True)
        write(os.path.join(extra, bad), "x\n")
        try:
            lib.add_overlay(manifest, "r", extra)
            ok = check(False, "overlay %s is refused" % bad) and ok
        except ValueError as exc:
            ok = check(why in str(exc), "overlay %s is refused" % bad) and ok
    try:
        lib.add_overlay(manifest, "r", os.path.join(work, "missing"))
        ok = check(False, "a missing overlay folder is refused") and ok
    except ValueError:
        ok = check(True, "a missing overlay folder is refused") and ok
    try:
        load_manifest_from_obj({"repos": {"r": {"path": repo, "files": {
            lib.OVERLAY_PREFIX + "rules/x.md": "rules/x.md"}}}})
        ok = check(False, "a manifest cannot name an overlay source") and ok
    except ValueError:
        ok = check(True, "a manifest cannot name an overlay source") and ok

    outside = os.path.join(work, "outside.md")
    write(outside, "somebody else's file\n")
    os.symlink(outside, os.path.join(over, "rules", "linked.md"))
    linked = lib.add_overlay(manifest, "r", over)
    rc = sync.cmd_apply(canon, linked, "r", yes=True, force=True, adopt=True,
                   dry_run=False)
    ok = check(rc == 1 and not os.path.exists(
                   os.path.join(repo, "rules", "linked.md")),
               "an overlay link is never copied, even with --force and "
               "--adopt") and ok
    os.unlink(os.path.join(over, "rules", "linked.md"))

    seen = []
    lib.merged_only(lib.DEFAULT_MANIFEST, added, "r", None,
                lambda root, paths: seen.append((root, sorted(paths))))
    ok = check(seen[-1:] == [(spec["overlay"], ["code-os/account.json",
                                                "rules/mine.md"])],
               "the source check covers the overlay's own checkout") and ok

    path = os.path.join(work, "manifest.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(manifest, fh)
    rc, out = run_main(["status", "r", "--manifest", path, "--overlay", over])
    ok = check("code-os/account.json" in out and "rules/mine.md" in out,
               "status reports the overlay's files") and ok
    rc = run_main(["status", "--manifest", path, "--overlay", over])[0]
    ok = check(rc == 2, "status --overlay needs exactly one REPO") and ok
    rc = run_main(["plan", "r", "--manifest", path, "--overlay",
                   os.path.join(work, "missing")])[0]
    ok = check(rc == 2, "a missing overlay folder is a usage error") and ok
    return ok


def self_test_merged(work, check):
    """apply copies only merged content: merged_source against a throwaway
    origin and clone, and merged_only's refusals that come before git."""
    ok = True
    outside = os.path.join(work, "manifest.json")
    os.makedirs(os.path.join(work, "target"))
    with open(outside, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "repos": {"r": {
            "path": os.path.join(work, "target"),
            "files": {"tools/claude_os_sync.py": "x.py"}}}}, fh)
    manifest = lib.load_manifest(outside)
    never = lambda *_args: "reached git"  # noqa: E731

    why = lib.merged_only(outside, manifest, "r", None, never) or ""
    ok = check("outside the Git Crafter checkout" in why,
               "a manifest outside the Git Crafter root is refused") and ok
    for aimed in ("~/.claude", "~/.claude/code-os", "~/./.claude/"):
        why = lib.merged_only(lib.DEFAULT_MANIFEST, manifest, "r", aimed, never) or ""
        ok = check("never aims apply" in why,
                   "--repo-path %s is refused" % aimed) and ok
    why = lib.merged_only(lib.DEFAULT_MANIFEST, manifest, "r", work, never)
    ok = check(why == "reached git", "another --repo-path goes on to the "
                                     "git check") and ok
    seen = []
    lib.merged_only(lib.DEFAULT_MANIFEST, manifest, "r", None,
                lambda root, paths: seen.extend(paths))
    ok = check(seen == ["manifest.json", "tools/claude_os_sync.py"],
               "the manifest and each source are checked as tracked") and ok

    rc, out = run_main(["apply", "r", "--yes", "--manifest", outside])
    ok = check(rc == 1 and "REFUSE  source" in out
               and not os.path.exists(os.path.join(work, "target", "x.py")),
               "the command line refuses a manifest nobody reviewed") and ok
    rc = run_main(["status", "r", "--man", outside])[0]
    ok = check(rc == 2, "a shortened option is a usage error") and ok

    if shutil.which(lib.GIT) is None:
        print("self-test: merged-source checks: SKIP (git not found)")
        return ok
    git_env = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}

    def git(path, *args):
        r = lib.run_git(path, ["-c", "user.name=self-test",
                           "-c", "user.email=self-test@invalid",
                           "-c", "commit.gpgsign=false"] + list(args),
                    extra_env=git_env)
        if r.returncode != 0:
            raise RuntimeError("git %s: %s" % (" ".join(args), r.stderr))

    def write(path, text):
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)

    origin = os.path.join(work, "origin.git")
    code = os.path.join(work, "code")
    other = os.path.join(work, "other")
    os.makedirs(os.path.join(code, "tools"))
    git(work, "init", "-q", "--bare", "-b", lib.MERGED_BRANCH, origin)
    write(os.path.join(code, "manifest.json"), "{}\n")
    write(os.path.join(code, "tools", "x.py"), "one\n")
    write(os.path.join(code, "notes.txt"), "kept out of git\n")
    git(code, "init", "-q", "-b", lib.MERGED_BRANCH)
    with open(os.path.join(code, ".git", "info", "exclude"), "a",
              encoding="utf-8") as fh:
        fh.write("notes.txt\n")
    git(code, "add", "manifest.json", "tools/x.py")
    git(code, "commit", "-q", "-m", "seed")
    git(code, "remote", "add", "origin", origin)
    git(code, "push", "-q", "origin", lib.MERGED_BRANCH)
    paths = ["manifest.json", "tools/x.py"]
    state = lambda extra=(): lib.merged_source(code, paths + list(extra))  # noqa

    ok = check(state() is None, "a clean main equal to origin/main "
                                "passes") and ok
    why = state(["notes.txt"]) or ""
    ok = check("not tracked" in why, "an ignored file is not merged "
                                     "content") and ok

    write(os.path.join(code, "tools", "x.py"), "edited\n")
    ok = check("uncommitted" in (state() or ""),
               "a tracked change is refused") and ok
    write(os.path.join(code, "tools", "x.py"), "one\n")
    write(os.path.join(code, "tools", "new.py"), "new\n")
    ok = check("untracked" in (state() or ""),
               "an untracked file is refused") and ok
    os.unlink(os.path.join(code, "tools", "new.py"))

    git(code, "checkout", "-q", "-b", "feature")
    ok = check("not main" in (state() or ""),
               "a branch other than main is refused") and ok
    git(code, "checkout", "-q", lib.MERGED_BRANCH)

    write(os.path.join(code, "tools", "x.py"), "two\n")
    git(code, "commit", "-q", "-am", "local only")
    ok = check("is not origin/main" in (state() or ""),
               "a commit not on origin is refused") and ok
    git(code, "push", "-q", "origin", lib.MERGED_BRANCH)
    ok = check(state() is None, "once pushed it passes again") and ok

    git(work, "clone", "-q", origin, other)
    write(os.path.join(other, "tools", "x.py"), "three\n")
    git(other, "commit", "-q", "-am", "merged elsewhere")
    git(other, "push", "-q", "origin", lib.MERGED_BRANCH)
    ok = check("is not origin/main" in (state() or ""),
               "a checkout behind origin/main is refused after the "
               "fetch") and ok

    git(code, "remote", "set-url", "origin", os.path.join(work, "gone.git"))
    ok = check("git fetch" in (state() or ""),
               "a failed fetch is a refusal, not a pass") and ok
    return ok


def load_manifest_from_obj(data):
    fd, path = tempfile.mkstemp(suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh)
        return lib.load_manifest(path)
    finally:
        os.unlink(path)
