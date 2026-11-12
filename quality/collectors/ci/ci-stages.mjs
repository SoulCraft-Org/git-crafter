// The CI collector's pipeline stages, from the hook and workflow files, and the triggers that skip work.
import { readText, hookRuns, hookCode, jobNames, runnerText, stepName, graphText, triggers, firesOn, jobGraph, clip } from "./ci-workflows.mjs";
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import YAML from "yaml";

/**
 * The pipeline's stages, from the files that define them: .claude/settings.json
 * hooks, the pre-commit and pre-push hooks in params.hooks_dir, every
 * .github/workflows file, then params.stages for the steps no file here
 * records (a person's review, a deploy). Each stage carries `key`, the key its
 * statistics are filed under. `cfg` is this collector's settings (settings())
 * with `branch` set to the repo's default branch.
 */
export function pipelineStages(root, cfg) {
  if (!cfg?.branch) throw new Error("pipelineStages needs cfg.branch, the repo's default branch");
  return [...claudeHookStages(root), ...gitHookStages(root, cfg), ...workflowStages(root, cfg.branch), ...cfg.stages.map((s) => ({ ...s }))];
}

/** One edit-stage hook per entry of .claude/settings.json hooks. */
function claudeHookStages(root) {
  const claudeSettings = readText(root, ".claude/settings.json");
  if (!claudeSettings) return [];
  return Object.entries(JSON.parse(claudeSettings).hooks ?? {}).flatMap(([event, entries]) =>
    (entries ?? []).flatMap((entry) => (entry.hooks ?? []).map((hook) => hookStage(event, entry, hook))),
  );
}

// One Claude Code hook as an edit-stage row: its script, event and matcher.
function hookStage(event, entry, hook) {
  const script = /([\w.-]+\.(?:sh|py|mjs|js))/.exec(hook.command ?? "")?.[1] ?? event;
  return {
    label: script,
    stage: "edit",
    kind: "hook",
    runs: `${event}${entry.matcher ? ` on ${entry.matcher}` : ""}: ${script}`,
    file: ".claude/settings.json",
  };
}

/** The pre-commit and pre-push hooks that exist in params.hooks_dir. */
function gitHookStages(root, cfg) {
  const stages = [];
  for (const [name, stage] of [["pre-commit", "commit"], ["pre-push", "push"]]) {
    const file = path.join(cfg.hooksDir, name);
    const text = readText(root, file);
    if (text === null) continue;
    const runs = hookRuns(name, hookCode(root, cfg.hooksDir, text), { branch: cfg.branch, says: cfg.hookSays, checks: cfg.hookChecks });
    stages.push({ label: name, stage, kind: "hook", runs, file });
  }
  return stages;
}

/** Each parsed workflow file under .github/workflows: { file, doc, name }. */
function workflowDocs(root) {
  const dir = path.join(root, ".github", "workflows");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort() : [];
  return files.map((file) => {
    const doc = YAML.parse(readFileSync(path.join(dir, file), "utf8")) ?? {};
    return { file, doc, name: doc.name ?? file.replace(/\.ya?ml$/, "") };
  });
}

/**
 * What a stage runs: one plain job's steps, or, for a call to a reusable
 * workflow or several jobs, the job graph.
 */
function stageText(levels) {
  const only = levels.length === 1 && levels[0].length === 1 ? levels[0][0] : null;
  if (only && !only[1]?.uses && jobNames(...only).length === 1) {
    return `${jobNames(...only)[0]} on ${runnerText(only[1]?.["runs-on"])}: ${(only[1]?.steps ?? []).map(stepName).join(", ")}`;
  }
  return graphText(levels);
}

// One node per workflow and event: workflows run side by side, while the
// jobs inside one run in the order their needs set (a changes job, then its
// test job, then its verdict). The node is timed by its runs, created to
// finished, and its text spells out the job graph.
function workflowStages(root, branch) {
  const stages = [];
  for (const { file, doc, name } of workflowDocs(root)) {
    const on = triggers(doc.on);
    const jobs = Object.entries(doc.jobs ?? {});
    const fires = firesOn(doc.on, branch);
    for (const [event, stage] of [["pull_request", "ci"], ["push", "merge"]]) {
      if (!fires[event]) continue;
      const levels = jobGraph(jobs, event);
      if (!levels.length) continue;
      const paths = on[event]?.paths;
      const trigger = event === "pull_request" ? "every pull request" : `every push to ${branch}`;
      stages.push({
        label: name,
        stage,
        kind: "workflow",
        runs: clip(`On ${trigger}${paths ? ` touching ${paths.join(", ")}` : ""}: ${stageText(levels)}`),
        file: `.github/workflows/${file}`,
        key: `${name}\n${event}`,
      });
    }
  }
  return stages;
}

/**
 * Each workflow trigger that bills a run on a pull request or a push to `branch`,
 * and how it skips work when nothing it checks changed: a `paths` or
 * `paths-ignore` filter on the trigger (no run at all), a job whose `if` reads
 * an earlier job's outputs (a changes job, so the work is skipped), a job
 * calling ci-standard.yml with paths (its changes job skips the work), or null
 * when it runs its work on every change. Read from .github/workflows alone.
 */
export function skipTriggers(root, branch) {
  if (!branch) throw new Error("skipTriggers needs the repo's default branch");
  const rows = [];
  for (const { file, doc, name } of workflowDocs(root)) {
    const on = triggers(doc.on);
    const fires = firesOn(doc.on, branch);
    const jobs = Object.entries(doc.jobs ?? {});
    for (const [event, trigger] of [["pull_request", "pull request"], ["push", `push to ${branch}`]]) {
      if (!fires[event]) continue;
      const levels = jobGraph(jobs, event);
      if (!levels.length) continue;
      rows.push({ workflow: name, trigger, file: `.github/workflows/${file}`, how: skipHow(levels, on[event]) });
    }
  }
  return rows;
}

/** How one trigger skips work: a paths filter, a changes job, a ci-standard paths input, or null. */
function skipHow(levels, onEvent) {
  const jobs = levels.flat().map(([, job]) => job);
  if (onEvent?.paths || onEvent?.["paths-ignore"]) return "paths filter";
  if (jobs.some((job) => /needs\.[\w-]+\.outputs\./.test(String(job?.if ?? "")))) return "changes job";
  // A caller of the CI standard skips its jobs through the standard's own changes job when it sets paths.
  const standard = jobs.some((job) => /(^|\/)ci-standard\.ya?ml(@|$)/.test(String(job?.uses ?? "")) &&
    String(job?.with?.paths ?? "").split("\n").some((l) => l.trim() && !l.trim().startsWith("#")));
  return standard ? "ci-standard paths" : null;
}
