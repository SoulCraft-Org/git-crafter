"""ci_standard_rules.py: the CI standard's rules, and check_repo, which applies them to one checkout.

Part of the CI standard's checks (ci_standard.py), embedded with it in ci-standard.yml. Each rule's id, and what
passes it, is in ci_standard.py's docstring and templates/ci/README.md. Standard library only.
"""

from __future__ import annotations

import json
import os
import re
import subprocess

from ci_standard_yaml import EXPR, ParseError, parse

RULES = ("caller", "pin", "dependabot", "permissions", "concurrency", "timeout", "runner", "pinned", "cache", "no-share")
STANDARD_LABELS = {"ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"}
SLIM = "ubuntu-slim"
# Any owner's Git Crafter: the public repo, or an org's own copy of it. code-os is its name before 2026-11-11.
REPO_NAMES = r"(?:git-crafter|code-os)"
STANDARD = "<owner>/git-crafter/.github/workflows/ci-standard.yml"
STANDARD_RE = re.compile(r"([A-Za-z0-9][\w.-]*)/(" + REPO_NAMES + r")/\.github/workflows/ci-standard\.yml@")
LOCAL_STANDARD = "./.github/workflows/ci-standard.yml"
SHA_RE = re.compile(r"[^@\s]+@[0-9a-f]{40}")
FULL_SHA = re.compile(r"[0-9a-f]{40}")
# This repo's own actions: ./ runs the checkout's copy, $/ the copy at the workflow's commit (gh actions-lock).
OWN = ("./", "$/")
LOCK_FILE = "actions.lock"
PIN_LINE_RE = re.compile(r"uses:\s*[\"']?[A-Za-z0-9][\w.-]*/" + REPO_NAMES + r"/\.github/workflows/ci-standard\.yml@([^\s\"'#]+)[\"']?\s*(#\s*(\S+))?")
NPM_RE = re.compile(r"\b(npm (ci|install)|pnpm install|yarn install)\b")
PIP_RE = re.compile(r"\bpip3? install\b")
SHARE_FILES = ("build_minutes_guard.py",)
CONFIG = os.path.join(".github", "ci-standard.json")
PUSH_TRIGGERS = {"pull_request", "push", "pull_request_target", "merge_group"}


class UsageError(Exception):
    """A bad argument or config: exit 2 for arguments, 3 for a config that cannot be trusted."""


# ---- one workflow ------------------------------------------------------------------------------------------------


def triggers(doc: dict) -> dict:
    """The workflow's on: as a mapping of event to its settings, whichever form it was written in."""
    on = doc.get("on", doc.get("true"))
    if isinstance(on, str):
        return {on: None}
    if isinstance(on, list):
        return {str(x): None for x in on}
    return on if isinstance(on, dict) else {}


def steps_of(job: dict) -> list:
    """The job's steps that are mappings."""
    return [s for s in job.get("steps") or [] if isinstance(s, dict)]


def deploy_step(step: dict) -> bool:
    """Whether a step deploys: a Pages or Wrangler action, or a wrangler deploy command."""
    uses, run = str(step.get("uses") or ""), str(step.get("run") or "")
    return uses.startswith(("actions/deploy-pages@", "cloudflare/wrangler-action@")) or bool(re.search(r"wrangler\s+(pages\s+)?deploy", run))


def deploys(doc: dict) -> bool:
    """Whether a workflow deploys: a job with an environment or deploy in its id, or a deploy step."""
    for name, job in (doc.get("jobs") or {}).items():
        if isinstance(job, dict) and (job.get("environment") or "deploy" in str(name).lower() or any(map(deploy_step, steps_of(job)))):
            return True
    return False


def shell_of(run: str) -> str:
    """A run block without the bodies of its quoted heredocs (<<'END' ... END): those lines are data, not commands."""
    out, end = [], None
    for line in run.split("\n"):
        if end is not None:
            if line.strip() == end:
                end = None
            continue
        out.append(line)
        m = re.search(r"<<-?\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*$", line)
        if m:
            end = m[1]
    return "\n".join(out)


def standard_jobs(doc: dict) -> dict:
    """{job id: the uses: string} for each job that calls the standard."""
    jobs = doc.get("jobs") if isinstance(doc.get("jobs"), dict) else {}
    return {jid: str(j["uses"]) for jid, j in jobs.items() if isinstance(j, dict) and
            (STANDARD_RE.match(str(j.get("uses") or "")) or str(j.get("uses") or "") == LOCAL_STANDARD)}


def permission_findings(name: str, doc: dict) -> list:
    """The top-level permissions mapping: present, and only read or none."""
    perms = doc.get("permissions")
    if "permissions" not in doc:
        return [("permissions", name, "no top-level permissions block; add `permissions: contents: read`")]
    if not isinstance(perms, dict) or any(str(v) not in ("read", "none") for v in perms.values()):
        return [("permissions", name, f"top-level permissions {perms!r}; grant only read or none here, and any write on the one job that needs it")]
    return []


def cancel_of(conc) -> str:
    """The concurrency group's cancel-in-progress, as text; empty when unset."""
    return str(conc.get("cancel-in-progress", "")).strip() if isinstance(conc, dict) else ""


def concurrency_findings(name: str, doc: dict) -> list:
    """For a push or pull request workflow: a concurrency group that cancels superseded runs, and never a deploy."""
    if not set(triggers(doc)) & PUSH_TRIGGERS:
        return []
    conc = doc.get("concurrency")
    cancel = cancel_of(conc)
    if not conc:
        return [("concurrency", name, "no concurrency group; a newer push should cancel the older run")]
    if deploys(doc):
        if cancel not in ("", "false") and not ("pull_request" in cancel and EXPR in cancel):
            return [("concurrency", name, f"deploys, but cancel-in-progress is {cancel!r}; a deploy is never cancelled")]
        return []
    if isinstance(conc, dict) and not cancel:
        return [("concurrency", name, "cancel-in-progress is not set; superseded runs keep spending minutes")]
    return []


def runner_finding(runs_on) -> str | None:
    """Why a job's runs-on breaks the runner rule, or None when it is a standard label."""
    text = runs_on if isinstance(runs_on, str) else json.dumps(runs_on)
    if text == SLIM or text in STANDARD_LABELS:
        return None
    if "blacksmith-" in text:
        return "a Blacksmith label; the standard runs on GitHub's pool only (templates/ci/README.md)"
    if "vars.CI_RUNNER" in text:
        return "reads vars.CI_RUNNER; the standard runs on fixed GitHub-hosted labels"
    return f"runs-on {text}: computed, macOS, Windows, larger or self-hosted; use ubuntu-slim or ubuntu-latest, or add an exception"


def pin_findings(where: str, steps: list, locked=frozenset()) -> list:
    """Each step's uses: pinned to a full SHA or locked in actions.lock, a docker:// image to a digest."""
    found = []
    for s in steps:
        uses = str(s.get("uses") or "")
        if uses and not uses.startswith(OWN + ("docker://",)) and not SHA_RE.fullmatch(uses) and uses not in locked:
            found.append(("pinned", where, f"{uses} is not pinned to a full commit SHA, and {LOCK_FILE} does not lock it"))
        if uses.startswith("docker://") and "@sha256:" not in uses:
            found.append(("pinned", where, f"{uses} is not pinned to a digest"))
    return found


def cached(steps: list, prefix: str) -> bool:
    """Whether a step uses the setup action named by prefix with a cache."""
    return any(str(s.get("uses") or "").startswith(prefix) and isinstance(s.get("with"), dict) and s["with"].get("cache") for s in steps)


def cache_findings(where: str, steps: list) -> list:
    """npm and pip installs, outside heredoc data, each with its setup action's download cache."""
    runs = " ".join(shell_of(str(s.get("run") or "")) for s in steps)
    found = []
    if NPM_RE.search(runs) and not cached(steps, "actions/setup-node@"):
        found.append(("cache", where, "installs npm packages with no download cache; use setup-node with cache: npm, or move the job into the standard"))
    if PIP_RE.search(runs) and not cached(steps, "actions/setup-python@"):
        found.append(("cache", where, "pip installs with no download cache; use setup-python with cache: pip, or move the job into the standard"))
    return found


def job_findings(where: str, job: dict, locked=frozenset()) -> list:
    """One job's permissions, pin, timeout, runner and steps; a reusable-workflow call is checked where it is defined. A lockfile covers steps only."""
    found = []
    if str(job.get("permissions", "")).strip() == "write-all":
        found.append(("permissions", where, "permissions: write-all; name the one scope this job writes"))
    if job.get("uses"):
        uses = str(job["uses"])
        if not uses.startswith("./") and not SHA_RE.fullmatch(uses):
            found.append(("pinned", where, f"{uses} is not pinned to a full commit SHA"))
        return found
    if not job.get("timeout-minutes"):
        found.append(("timeout", where, "no timeout-minutes; a hung job bills to GitHub's 6-hour limit"))
    why = runner_finding(job.get("runs-on"))
    if why:
        found.append(("runner", where, why))
    steps = steps_of(job)
    return found + pin_findings(where, steps, locked) + cache_findings(where, steps)


def check_workflow(name: str, doc: dict, locked=frozenset()) -> list:
    """[(rule, where, why)] for the house rules every workflow keeps; locked is the uses: lines actions.lock records for it."""
    jobs = doc.get("jobs")
    if not isinstance(jobs, dict):
        raise ParseError("jobs is not a mapping")
    for jid, job in jobs.items():
        if not isinstance(job, dict):
            raise ParseError(f"job {jid!r} is not a mapping")
    found = permission_findings(name, doc) + concurrency_findings(name, doc)
    for jid, job in jobs.items():
        found += job_findings(f"{name}/{jid}", job, locked)
    return found


# ---- the repo ------------------------------------------------------------------------------------------------------


def dependabot_ecosystems(repo: str) -> list:
    """The package-ecosystem of each entry in .github/dependabot.yml (or .yaml, which wins); [] when unreadable."""
    text = ""
    for fname in ("dependabot.yml", "dependabot.yaml"):
        path = os.path.join(repo, ".github", fname)
        if os.path.isfile(path) and not os.path.islink(path):
            with open(path, encoding="utf-8") as fh:
                text = fh.read()
    try:
        return [str(u.get("package-ecosystem")) for u in (parse(text).get("updates") or []) if isinstance(u, dict)] if text else []
    except ParseError:
        return []


def remote_caller(repo: str, caller: dict, uses: str, text: str) -> list:
    """Fills in the pin, owner and version of a caller at <owner>/git-crafter (or code-os), and finds the pin and dependabot rules."""
    pin = uses.split("@", 1)[1]
    caller["pin"] = pin
    caller["owner"], caller["repo"] = STANDARD_RE.match(uses).groups()
    line = next((m for m in PIN_LINE_RE.finditer(text) if m[1] == pin), None)
    caller["version"] = line[3] if line and line[3] else None
    where, found = f"{caller['file']}/{caller['job']}", []
    if not FULL_SHA.fullmatch(pin):
        found.append(("pin", where, f"pinned to {pin!r}; pin a full commit SHA of Git Crafter main, with a # v1 comment"))
    elif not caller["version"] or not re.fullmatch(r"v\d+(\.\d+)*", caller["version"]):
        found.append(("pin", where, "no version comment; add # v1 after the SHA so a reader and Dependabot see the version"))
    if "github-actions" not in dependabot_ecosystems(repo):
        found.append(("dependabot", ".github/dependabot.yml", "no github-actions entry; Dependabot must bump the standard's pin"))
    return found


def check_caller(repo: str, docs: dict, texts: dict) -> tuple:
    """([(rule, where, why)], caller) where caller is {"file", "job", "pin", "version", "local"} or None."""
    callers = [(name, jid, uses) for name, doc in docs.items() if "pull_request" in triggers(doc) for jid, uses in standard_jobs(doc).items()]
    if not callers:
        return [("caller", ".github/workflows", f"no pull_request workflow calls {STANDARD}; copy Git Crafter templates/ci/ci.yml")], None
    name, jid, uses = callers[0]
    caller = {"file": name, "job": jid, "pin": None, "version": None, "local": uses == LOCAL_STANDARD}
    if caller["local"]:
        return [], caller
    return remote_caller(repo, caller, uses, texts[name]), caller


def behind(pin: str, owner: str, repo: str = "git-crafter") -> dict:
    """How many commits owner's Git Crafter main is ahead of the pin, read with gh. could_not_check when gh cannot say."""
    if not pin or not FULL_SHA.fullmatch(pin):
        return {"could_not_check": "no full SHA pin"}
    try:
        r = subprocess.run(["gh", "api", f"repos/{owner}/{repo}/compare/{pin}...main", "--jq", "[.status, .ahead_by] | @json"],
                           capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"could_not_check": f"gh did not run: {type(exc).__name__}"}
    if r.returncode != 0:
        return {"could_not_check": f"gh api compare failed: {r.stderr.strip()[:120]}"}
    try:
        status, ahead = json.loads(r.stdout)
    except ValueError:
        return {"could_not_check": "gh gave no comparison"}
    if status not in ("ahead", "identical"):
        return {"could_not_check": f"the pin is {status} of Git Crafter main, not on it"}
    return {"commits": int(ahead)}


def read_config(path: str) -> dict:
    """The parsed .github/ci-standard.json, with only its known top-level keys; UsageError otherwise."""
    try:
        with open(path, encoding="utf-8") as fh:
            doc = json.load(fh)
    except (OSError, ValueError) as exc:
        raise UsageError(f"{CONFIG}: {exc}") from None
    if not isinstance(doc, dict) or doc.get("version") != 1 or set(doc) - {"version", "exceptions", "skip", "$comment"}:
        raise UsageError(f"{CONFIG}: want version 1 with only exceptions and skip")
    return doc


def check_exception(key: str, e) -> None:
    """UsageError unless the exception names known rules, none of caller, pin or dependabot, and gives a why."""
    if not isinstance(e, dict) or not str(e.get("why") or "").strip() or not isinstance(e.get("rules"), list) or not set(e["rules"]) <= set(RULES):
        raise UsageError(f"{CONFIG}: exception {key!r} needs known rules and a why")
    if set(e["rules"]) & {"caller", "pin", "dependabot"}:
        raise UsageError(f"{CONFIG}: exception {key!r}: caller, pin and dependabot take no exception")


def check_skip(skip: dict) -> None:
    """UsageError unless every skipped file gives a why."""
    for key, why in skip.items():
        if not str(why or "").strip():
            raise UsageError(f"{CONFIG}: skip {key!r} needs a why")


def load_config(repo: str) -> dict:
    """{"exceptions", "skip"} from the repo's .github/ci-standard.json; both empty when it has none."""
    path = os.path.join(repo, CONFIG)
    if not os.path.exists(path):
        return {"exceptions": {}, "skip": {}}
    doc = read_config(path)
    exc, skip = doc.get("exceptions") or {}, doc.get("skip") or {}
    if not isinstance(exc, dict) or not isinstance(skip, dict):
        raise UsageError(f"{CONFIG}: exceptions and skip are objects")
    for key, e in exc.items():
        check_exception(key, e)
    check_skip(skip)
    return {"exceptions": exc, "skip": skip}


def read_workflows(folder: str, names: list) -> tuple:
    """(docs, texts, unread) for the named workflow files; a link is never read."""
    docs, texts, unread = {}, {}, []
    for name in names:
        path = os.path.join(folder, name)
        if os.path.islink(path):
            unread.append((name, "a link; never read"))
            continue
        try:
            with open(path, encoding="utf-8") as fh:
                texts[name] = fh.read()
            docs[name] = parse(texts[name])
        except (OSError, UnicodeDecodeError, ParseError) as exc:
            unread.append((name, str(exc)))
    return docs, texts, unread


def read_lock(folder: str) -> dict:
    """{workflow file: its locked uses: lines} from gh actions-lock's actions.lock; {} when absent, a link or unreadable."""
    path = os.path.join(folder, LOCK_FILE)
    if os.path.islink(path) or not os.path.isfile(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            flows = parse(fh.read()).get("workflows")
    except (OSError, UnicodeDecodeError, ParseError, AttributeError):
        return {}
    if not isinstance(flows, dict):
        return {}
    return {os.path.basename(str(name)): frozenset(str(u) for u in uses) for name, uses in flows.items() if isinstance(uses, list)}


def house_findings(docs: dict, exceptions: dict, unread: list, lock=None) -> tuple:
    """(findings, excepted) for the house rules; a workflow check_workflow cannot read moves from docs to unread."""
    house, excepted = [], []
    for name, doc in list(docs.items()):
        try:
            results = check_workflow(name, doc, (lock or {}).get(name, frozenset()))
        except ParseError as exc:
            unread.append((name, str(exc)))
            del docs[name]
            continue
        for rule, where, why in results:
            e = exceptions.get(where) or exceptions.get(where.split("/", 1)[0])
            if e and rule in e["rules"]:
                excepted.append((rule, where, e["why"]))
            else:
                house.append((rule, where, why))
    return house, excepted


def share_findings(repo: str) -> list:
    """A per-repo minute guard anywhere under .github."""
    return [("no-share", os.path.relpath(os.path.join(root, n), repo), "a per-repo minute guard; the org pool replaces per-repo shares")
            for root, _dirs, names in os.walk(os.path.join(repo, ".github")) for n in names if n in SHARE_FILES]


def lag_of(caller, ask_behind: bool):
    """How far the caller's pin is behind Git Crafter main: 0 for Git Crafter's local caller, gh's answer when asked."""
    if caller and caller["local"]:
        return {"commits": 0, "note": "Git Crafter calls the standard by local path"}
    if ask_behind and caller:
        return behind(caller["pin"], caller["owner"], caller.get("repo") or "git-crafter")
    return None


def check_repo(repo: str, ask_behind: bool = False) -> dict:
    """{"follows", "workflows", "caller", "behind", "findings", "excepted", "could_not_check"} for one checkout."""
    config = load_config(repo)
    folder = os.path.join(repo, ".github", "workflows")
    files = sorted(f for f in os.listdir(folder) if f.endswith((".yml", ".yaml"))) if os.path.isdir(folder) else []
    docs, texts, unread = read_workflows(folder, [f for f in files if f not in config["skip"]])
    house, excepted = house_findings(docs, config["exceptions"], unread, read_lock(folder))
    caller_found, caller = check_caller(repo, docs, texts)
    findings = caller_found + house + share_findings(repo)
    return {"follows": not findings and not unread, "workflows": len(files), "caller": caller, "behind": lag_of(caller, ask_behind),
            "findings": findings, "excepted": excepted, "could_not_check": unread}
