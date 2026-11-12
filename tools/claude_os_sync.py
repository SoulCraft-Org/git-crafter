#!/usr/bin/env python3
"""claude_os_sync.py: publish Git Crafter files into repos, and detect drift.

Tier 2 of the Git Crafter architecture. Some gates have to run in a pre-commit
hook and in CI, and neither can reach ~/.claude or a plugin. They need a real
committed file inside the repo. That means copies, and copies go stale. This
script is the answer to that: it makes the copies, and it tells you when they
have diverged.

Read-only by default. Nothing is written unless you run apply with --yes, and
then only to paths named in manifest.json, inside the target checkout.

Where things resolve:
  sources      always the Git Crafter root, the folder above this script's
               tools/ directory, with symlinks resolved. Where --manifest
               lives does not matter.
  target       the repo's path in the manifest, which is its main checkout,
               so apply writes into whatever branch that checkout has out.
               --repo-path PATH replaces it for the one named repo, for
               status, diff, plan and apply. Use it to target a git worktree,
               such as <repo>/.claude/worktrees/<name>.
  record file  read from and written to the target checkout, so --repo-path
               moves it too.
  overlay      --overlay DIR adds one account's own files after the
               manifest's, for the one named repo. DIR is laid out like the
               target: DIR/code-os/account.json installs as
               code-os/account.json. Only files under code-os/ and rules/
               are taken, dotfiles are skipped, and a path the manifest
               already installs is a usage error, so an overlay adds files
               and never replaces a template one. Overlay files are hashed
               and recorded like the rest, and status, plan and apply report
               them only when given the same --overlay.

Target check: plan and apply print the branch of the target checkout. Before
writing, apply runs `git -C PATH status --porcelain --untracked-files=no`.
Any output means staged or unstaged changes to tracked files, which is
somebody's work in progress, so apply refuses unless --force-target. Plan
shows the same refusal. Untracked files do not count. If git is missing or
PATH is not a git checkout, apply warns and writes anyway: could not check is
not the same as dirty. The check catches a dirty checkout, not a clean one on
someone else's branch. The printed branch is how you spot that.

Source check: apply copies only reviewed, merged content, since user-claude
installs the guard and the rules every session reads, and the orchestrator
runs apply after each merge (rules/delegation.md). Before writing, apply runs `git fetch origin main` in the
Git Crafter root and refuses unless that root is on main, has no tracked change
and no untracked file, and its HEAD equals origin/main. The manifest must be
a tracked file inside the root, and so must each source it copies, so
--manifest cannot point apply at a list nobody reviewed. An --overlay DIR
takes the same check in its own checkout: on main, clean, equal to
origin/main after a fetch, every overlay file tracked. --repo-path never
aims apply at ~/.claude (or $CLAUDE_CONFIG_DIR). No flag overrides any of
this. Unlike the target check it fails closed: when git cannot answer, apply
writes nothing. Plan shows the same refusal and still previews the files.
Options take their full names only, so a shortened --repo or --man is a
usage error.

Whole or nothing: a tool can install as several files, an entry and the
modules it imports, so apply lands all of them or none. When any file is
refused, apply writes nothing, not even the record. Otherwise it copies
every file to a temporary name beside its destination first, and renames
them into place only once all are staged. A failed copy removes the staged
ones and leaves the tree as it was.

Statuses, per file:
  in-sync     the repo copy matches canonical
  absent      the repo copy does not exist yet
  drifted     the repo copy matches what was last synced, but canonical has
              moved on. Re-syncing is safe and loses nothing.
  modified    the repo copy differs from what was last synced. Someone edited
              it in place. Re-syncing would throw that away, so apply refuses
              without --force.
  unmanaged   a file is already at the destination and was never synced here.
              Adopting it would clobber it, so apply refuses without --adopt.
  unsafe      the destination is a symbolic link, or resolves outside the
              repo. A repo controls its own tree, so a committed link could
              aim apply at any file. Apply never writes there, whatever the
              flags.

Commands:
  status [REPO ...]      report every declared file. Read-only.
  diff REPO FILE         unified diff of canonical against the repo copy.
  plan REPO              what an apply would do. Read-only.
  apply REPO --yes       copy canonical into the repo and record the hashes.
  --self-test            run the scenarios in tools/tests/ against temp
                         dirs and real git checkouts. Skips the git ones if
                         git is missing. Exits 2 when that folder is absent.

Options:
  --repo-path PATH       use PATH as the checkout for the one named REPO.
                         status then needs exactly one REPO.
  --force                overwrite a copy that was edited in place.
  --adopt                take over a file that was never synced here.
  --force-target         let apply write into a checkout with uncommitted
                         changes to tracked files.
  --manifest FILE        read a different manifest. Sources still come from
                         the Git Crafter root.
  --overlay DIR          add DIR's files, laid out like the target, after
                         the manifest's, for the one named REPO.

Exit codes: 0 = every declared file in-sync, 1 = something is absent,
drifted, modified, unmanaged or unsafe, or apply refused a dirty target or
an unmerged source, 2 = usage or read error. So status works as a CI check.

Layout: this file holds the commands and the write; claude_os_sync_lib.py
beside it holds the manifest, the checks and classify. The self-test
scenarios live in tests/test_claude_os_sync.py.

Requires Python 3.9, standard library only.
"""

import argparse
import contextlib
import datetime
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.realpath(__file__))
TESTS = os.path.join(HERE, "tests")


def load_lib():
    """Import the claude_os_sync_lib.py beside this script, and only that one.
    python3 -I leaves this folder off sys.path, so it is added here."""
    if HERE not in sys.path:
        sys.path.append(HERE)
    import claude_os_sync_lib
    where = os.path.dirname(os.path.realpath(claude_os_sync_lib.__file__))
    if where != HERE:
        raise ImportError("claude_os_sync_lib came from %s, not %s"
                          % (where, HERE))
    return claude_os_sync_lib


lib = load_lib()
from claude_os_sync_lib import (  # noqa: E402
    CANONICAL_MISSING, CLEAN_STATUSES, DEFAULT_MANIFEST, IN_SYNC, MODIFIED,
    ROOT, UNMANAGED, UNSAFE, add_overlay, classify, cmd_diff, load_manifest,
    load_record, merged_only, override_repo_path, record_name, record_path,
    repo_root, select_repos, sha256, source_path, target_state, unsafe)


def cmd_status(canonical_root, manifest, names, quiet=False):
    """Print each named repo's files and statuses. Return 0 when every file
    is in sync, else 1."""
    dirty = False
    for name, spec in select_repos(manifest, names):
        root = repo_root(spec)
        exists = os.path.isdir(root)
        if not quiet:
            print("%s  (%s)%s" % (name, spec["path"],
                                  "" if exists else "  REPO NOT FOUND"))
        if not exists:
            dirty = True
            continue
        for src, dest, status, detail in classify(canonical_root, manifest, spec):
            if status not in CLEAN_STATUSES:
                dirty = True
            if not quiet:
                print("  %-10s %s%s" % (status, dest,
                                        "  (%s)" % detail if detail else ""))
    return 1 if dirty else 0


def refusal(status, detail, force, adopt):
    """Why apply must not write a file of this status, or None."""
    if status == UNSAFE:
        # No flag overrides this one: --force and --adopt never write
        # through a link, or outside the repo.
        return ("%s; apply never follows a link or leaves the Git Crafter root "
                "or the repo" % detail)
    if status == CANONICAL_MISSING:
        return "canonical file missing: %s" % detail
    if status == UNMANAGED and not adopt:
        return "exists and was never synced here; pass --adopt to take it over"
    if status == MODIFIED and not force:
        return ("edited in place since the last sync; pass --force to "
                "discard those edits")
    return None


def sort_rows(rows, force, adopt):
    """Split classify's rows into planned [(source, dest, status)] and
    refused [(dest, why)]. In-sync rows drop out."""
    planned, refused = [], []
    for src, dest, status, detail in rows:
        if status == IN_SYNC:
            continue
        why = refusal(status, detail, force, adopt)
        if why:
            refused.append((dest, why))
        else:
            planned.append((src, dest, status))
    return planned, refused


def report_target(root):
    """Print the target checkout's branch, or warn that git cannot say.
    Return (branch, dirty) from target_state."""
    branch, dirty, warning = target_state(root)
    if warning:
        sys.stdout.flush()
        print("WARNING  cannot check the target checkout, continuing: %s"
              % warning, file=sys.stderr)
    else:
        print("target  %s  (branch %s)" % (root, branch))
    return branch, dirty


def print_plan(planned, refused, preview):
    """Print each refusal, then each planned file as would or write."""
    for dest, why in refused:
        print("REFUSE  %s  (%s)" % (dest, why))
    for src, dest, status in planned:
        print("%-7s %s  (was %s)" % ("would" if preview else "write",
                                     dest, status))


def target_blocked(planned, dirty, branch, force_target):
    """True when uncommitted changes in the target stop the write. Prints
    the refusal, or the note that --force-target writes anyway."""
    if not (planned and dirty):
        return False
    if force_target:
        print("NOTE    branch %s has uncommitted changes to tracked files; "
              "writing anyway (--force-target)" % branch)
        return False
    print("REFUSE  target  (branch %s has uncommitted changes to tracked "
          "files; commit or stash them, point "
          "--repo-path at a clean worktree, or pass --force-target)"
          % branch)
    for line in dirty:
        print("          %s" % line)
    return True


def write_gate(manifest, root, yes, dry_run, planned, refused, stop):
    """The exit code when apply stops before writing, or None to write.
    stop is a dirty-target block or a source refusal."""
    if dry_run:
        return 1
    if not yes:
        sys.stdout.flush()
        print("refusing to write without --yes", file=sys.stderr)
        return 2
    record_why = unsafe(root, record_name(manifest))
    if record_why:
        print("REFUSE  record file  (%s)" % record_why)
    if planned and refused:
        print("REFUSE  apply  (%d file(s) refused, so nothing is written; a "
              "tool that installs as several files must land whole)"
              % len(refused))
    if not planned or stop or record_why or refused:
        return 1
    return None


def cmd_apply(canonical_root, manifest, repo, yes, force, adopt, dry_run,
              force_target=False, source_refusal=None):
    """Copy canonical into the repo and record the hashes, or with dry_run
    show what an apply would do. Return 0 when it wrote or had nothing to
    do, 1 on any refusal, 2 when the repo is missing or --yes is absent."""
    spec = manifest["repos"][repo]
    root = repo_root(spec)
    if not os.path.isdir(root):
        print("repo not found: %s" % root, file=sys.stderr)
        return 2
    if source_refusal:
        # No flag overrides this one: apply copies only merged content.
        print("REFUSE  source  (%s)" % source_refusal)
    branch, dirty = report_target(root)
    planned, refused = sort_rows(classify(canonical_root, manifest, spec),
                                 force, adopt)
    print_plan(planned, refused,
               dry_run or not yes or bool(source_refusal or refused))
    if not planned and not refused:
        print("nothing to do; every declared file is in sync")
        return int(bool(source_refusal))
    blocked = target_blocked(planned, dirty, branch, force_target)
    rc = write_gate(manifest, root, yes, dry_run, planned, refused,
                    blocked or source_refusal)
    if rc is not None:
        return rc
    return write_files(canonical_root, manifest, spec, root, planned)


def land_files(root, staged):
    """Rename each staged copy into place; on a failure, drop the rest."""
    landed = []
    for src, dest, tmp, digest in staged:
        try:
            os.replace(tmp, os.path.join(root, dest))
        except OSError as exc:
            left = staged[len(landed):]
            for entry in left:
                try:
                    os.unlink(entry[2])
                except OSError:
                    pass
            print("REFUSE  apply  (%s; landed: %s; left unwritten: %s; the "
                  "record is not written)"
                  % (exc, ", ".join(x[1] for x in landed) or "none",
                     ", ".join(x[1] for x in left)), file=sys.stderr)
            return None
        landed.append((src, dest, digest))
    return landed


def write_files(canonical_root, manifest, spec, root, planned):
    """Stage every planned file, rename them into place, and write the
    record. Return 0, or 1 when a destination turned unsafe."""
    staged = stage_files(canonical_root, spec, root, planned)
    if staged is None:
        return 1
    record = load_record(manifest, spec)
    stamp = datetime.datetime.now().replace(microsecond=0).isoformat()
    landed = land_files(root, staged)
    if landed is None:
        return 1
    for src, dest, digest in landed:
        record["files"][dest] = {
            "source": src,
            "sha256": digest,
            "synced_at": stamp,
        }
    record["generated_by"] = "Git Crafter claude_os_sync.py"
    record["note"] = ("These files are copies. Edit them in Git Crafter, not "
                      "here, then re-run sync.")
    with open(record_path(manifest, spec), "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2, sort_keys=True)
        fh.write("\n")
    print("\nwrote %d file(s); recorded in %s"
          % (len(planned), record_name(manifest)))
    return 0


def stage_files(canonical_root, spec, root, planned):
    """Copy every planned file to a temporary name beside its destination.

    Return [(source, dest, temp path, sha256)], ready to rename into place.
    Return None, with nothing staged, when a destination turned unsafe
    since classify read the tree. An OSError removes every staged copy
    before it propagates, so a failed copy leaves the tree as it was.
    """
    for _src, dest, _status in planned:
        # Checked again at the moment of writing, in case the tree changed
        # since classify read it.
        why = unsafe(root, dest)
        if why:
            print("REFUSE  %s  (%s); nothing is written" % (dest, why))
            return None
    staged = []
    try:
        for src, dest, _status in planned:
            folder = os.path.dirname(os.path.join(root, dest))
            os.makedirs(folder, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=folder, prefix=".claude-os-sync-")
            os.close(fd)
            staged.append((src, dest, tmp))
            shutil.copy2(source_path(canonical_root, spec, src)[1], tmp)
        return [(src, dest, tmp, sha256(tmp)) for src, dest, tmp in staged]
    except BaseException:
        for _src, _dest, tmp in staged:
            with contextlib.suppress(OSError):
                os.unlink(tmp)
        raise


def self_test():
    """Run the scenarios in tests/test_claude_os_sync.py against this module.

    The tests folder is appended to sys.path, so a standard-library name is
    never shadowed. Exit 2 with a pointer when the folder is absent.
    """
    if not os.path.isdir(TESTS):
        sys.stdout.flush()
        print("self-test: %s is missing; the scenarios live in "
              "tools/tests/test_claude_os_sync.py in a Git Crafter checkout"
              % TESTS, file=sys.stderr)
        return 2
    if TESTS not in sys.path:
        sys.path.append(TESTS)
    import test_claude_os_sync
    where = os.path.dirname(os.path.realpath(test_claude_os_sync.__file__))
    if where != TESTS:
        raise ImportError("test_claude_os_sync came from %s, not %s"
                          % (where, TESTS))
    return test_claude_os_sync.run(sys.modules[__name__])


def build_parser():
    """The command line: a command, its arguments, and the options."""
    p = argparse.ArgumentParser(description="Git Crafter sync and drift check",
                                allow_abbrev=False)
    p.add_argument("command", nargs="?", default="status",
                   choices=["status", "diff", "plan", "apply"])
    p.add_argument("args", nargs="*")
    p.add_argument("--manifest", default=DEFAULT_MANIFEST)
    p.add_argument("--repo-path", metavar="PATH",
                   help="use PATH as the checkout for the one named REPO "
                        "instead of the manifest's path, for example a git "
                        "worktree")
    p.add_argument("--yes", action="store_true",
                   help="required for apply to write anything")
    p.add_argument("--force", action="store_true",
                   help="overwrite a copy that was edited in place")
    p.add_argument("--adopt", action="store_true",
                   help="take over a file that was never synced here")
    p.add_argument("--force-target", action="store_true",
                   help="let apply write into a checkout that has uncommitted "
                        "changes to tracked files")
    p.add_argument("--overlay", metavar="DIR",
                   help="add DIR's files, laid out like the target, after "
                        "the manifest's, for the one named REPO")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--self-test", action="store_true")
    return p


def usage_error(args):
    """The usage message for a command line that cannot run, or None."""
    names = args.args
    if args.command == "diff" and len(names) != 2:
        return "usage: diff REPO FILE"
    if args.command in ("plan", "apply") and not names:
        return "usage: %s REPO" % args.command
    for flag in ("repo_path", "overlay"):
        if args.command == "status" and getattr(args, flag) is not None \
                and len(names) != 1:
            return ("--%s names one target, so status needs exactly one REPO"
                    % flag.replace("_", "-"))
    return None


def run_command(args, manifest, gate):
    """Run the parsed command against the loaded manifest."""
    names = args.args
    # Sources always resolve from the Git Crafter root this script lives in,
    # never from the folder that holds --manifest.
    canonical_root = ROOT
    if args.command != "status":
        select_repos(manifest, names[:1])
    if args.repo_path is not None:
        manifest = override_repo_path(manifest, names[0], args.repo_path)
    if args.overlay is not None:
        manifest = add_overlay(manifest, names[0], args.overlay)
    if args.command == "status":
        return cmd_status(canonical_root, manifest, names, args.quiet)
    if args.command == "diff":
        return cmd_diff(canonical_root, manifest, names[0], names[1])
    refusal_why = (gate or merged_only)(args.manifest, manifest, names[0],
                                        args.repo_path)
    return cmd_apply(canonical_root, manifest, names[0], args.yes,
                     args.force, args.adopt,
                     dry_run=(args.command == "plan"),
                     force_target=args.force_target,
                     source_refusal=refusal_why)


def main(argv=None, gate=None):
    """Parse argv and run it. gate stands in for merged_only in a self-test
    only."""
    args = build_parser().parse_args(argv)
    if args.self_test:
        return self_test()
    try:
        manifest = load_manifest(args.manifest)
    except (OSError, ValueError) as exc:
        print("manifest error: %s" % exc, file=sys.stderr)
        return 2
    why = usage_error(args)
    if why:
        print(why, file=sys.stderr)
        return 2
    try:
        return run_command(args, manifest, gate)
    except (OSError, ValueError) as exc:
        print("error: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
