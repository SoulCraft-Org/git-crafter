// The GitHub collector's issue, Actions and project-board metrics: each reads through the loaders and returns measured(...) or skip(...).
import { labelsOf, lastCompleted, closedByMergedPull } from "./github-flow.mjs";
import { measured, tally, skip, TARGETS_FILE, pct, count, round1, hours, HOUR, DAY, flag } from "./github-core.mjs";
import { LAST_CARDS } from "./github-queries.mjs";
import { cardsOr, workflowsOr, usesTargets, stepTargets, projectOr } from "./github-helpers.mjs";
import { proseWords, hasVisual, hasPicture } from "./github-text.mjs";
import { readForms } from "./github-loaders.mjs";
import { existsSync } from "node:fs";

/** Each metric reads through the loaders and returns measured(...) or skip(...). */
export const ISSUE_METRICS = {
  // Issues -----------------------------------------------------------------
  // A bug is an issue of the Bug type; a user's repo has no types, so there the bug label marks one.
  "issues.open_bugs": {
    source: "gh api graphql: repository.issues (open: issueType, labels); on a user's repo, labels",
    async run(L, { cfg }) {
      const areaOf = (issue) => cfg.areas.find((a) => labelsOf(issue).includes(a)) ?? "no area";
      const byLabel = (await L.repo()).owner?.type === "User";
      const bugs = byLabel
        ? (await L.issues()).filter((i) => i.state === "OPEN" && labelsOf(i).includes(cfg.bugLabel))
        : (await L.openTypes()).filter((i) => i.issueType?.name === cfg.bugType);
      return measured(bugs.length, tally(bugs.map(areaOf), cfg.areas));
    },
  },
  "issues.area_labeled": {
    source: "gh api graphql: repository.issues (labels)",
    async run(L, { cfg }) {
      if (!cfg.areas.length) return skip(`params.area_labels in ${TARGETS_FILE} is empty: list the labels that name an area`);
      const issues = await L.issues();
      if (!issues.length) return skip("no issues yet");
      const labeled = issues.filter((i) => cfg.areas.some((a) => labelsOf(i).includes(a))).length;
      return measured(pct(labeled, issues.length), [count("with an area label", labeled), count("without", issues.length - labeled)]);
    },
  },
  "issues.closed_by_pr": {
    source: "gh api graphql: repository.issues, last 20 bugs closed as completed (issueType; on a user's repo, labels; ClosedEvent closer)",
    async run(L, { cfg }) {
      // Bugs only: a Task that needs no code, such as a label or a setting, closes with no pull request and is no miss.
      // A bug is an issue of the Bug type; a user's repo has no types, so there the bug label marks one.
      const byLabel = (await L.repo()).owner?.type === "User";
      const bugs = (await L.issues()).filter((i) => (byLabel ? labelsOf(i).includes(cfg.bugLabel) : i.issueType?.name === cfg.bugType));
      const done = lastCompleted(bugs, cfg.recordMinutes);
      if (!done.length) return skip("no bug closed as completed yet");
      const byPull = done.filter(closedByMergedPull).length;
      return measured(pct(byPull, done.length), [count("closed by a merged PR", byPull), count("closed another way", done.length - byPull)]);
    },
  },
  "issues.reopened": {
    source: "gh api graphql: repository.issues, last 20 closed as completed (REOPENED_EVENT)",
    async run(L, ctx) {
      // Among the last 20 completed: an issue reopened and closed again still counts.
      const closed = lastCompleted(await L.issues(), ctx.cfg.recordMinutes);
      if (!closed.length) return skip("no issue closed as completed yet");
      const reopened = closed.filter((i) => i.reopened.totalCount > 0).length;
      return measured(pct(reopened, closed.length), [count("reopened at least once", reopened), count("closed issues read", closed.length)]);
    },
  },
  // Point in time: the latest closed issue, never a median over a window.
  "issues.latest_close_hours": {
    source: "gh api graphql: repository.issues, the latest closed as completed (createdAt, closedAt)",
    async run(L, ctx) {
      const [latest] = lastCompleted(await L.issues(), ctx.cfg.recordMinutes);
      if (!latest) return skip("no issue closed as completed yet");
      const h = round1(hours(latest.createdAt, latest.closedAt));
      return measured(h, [{ label: `#${latest.number}`, value: h, unit: "hours" }]);
    },
  },
  "issues.oldest_open_days": {
    source: "gh api graphql: repository.issues (open)",
    async run(L, { now }) {
      const open = (await L.issues()).filter((i) => i.state === "OPEN");
      if (!open.length) return measured(0, [count("open issues", 0)]);
      const oldest = open.reduce((a, b) => (Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a : b));
      const days = round1((now - Date.parse(oldest.createdAt)) / DAY);
      return measured(days, [{ label: `#${oldest.number}`, value: days }]);
    },
  },

  // Work that is not a bug or a quick fix waits on the board, so one parked here is a miss.
  "issues.parked_open": {
    source: "state: gh api graphql: repository.issues (open: createdAt, issueType), against params.issue_types and params.park_hours",
    async run(L, { now, cfg }) {
      if (!cfg.issueTypes.length) return skip(`params.issue_types in ${TARGETS_FILE} is empty: list the types an issue may have`);
      if ((await L.repo()).owner?.type === "User") return skip("issue types belong to an organization: a user's repo has none");
      const parked = (await L.openTypes()).filter((i) => !cfg.issueTypes.includes(i.issueType?.name) && now - Date.parse(i.createdAt) > cfg.parkHours * HOUR);
      // The no-type row stays at 0, so the bar always has a row to draw.
      return measured(parked.length, tally(parked.map((i) => i.issueType?.name ?? "no type"), ["no type"]));
    },
  },
  // A label nothing carries only lengthens the picker; archiving one keeps its history.
  "issues.stray_labels": {
    source: "state: gh api repos/{repo}/labels (archived_at) and gh api graphql: repository.labels (issues and pullRequests totalCount), against params.bug_label and params.area_labels",
    async run(L, { cfg }) {
      const named = new Set([cfg.bugLabel, ...cfg.areas]);
      const stray = (await L.labels()).filter((l) => !l.archived && !l.uses && !named.has(l.name));
      return measured(stray.length, stray.length ? stray.map((l) => count(l.name, 1)) : undefined);
    },
  },

  // Cards: as visual as possible, with as few words as carry the information.
  // Point in time: the latest card, the latest description, the latest merge's size.
  "issues.latest_card_words": {
    source: `gh api graphql: of the ${LAST_CARDS} newest issues (body), the latest with a body; words outside tables, fenced code and diagrams, inline code and HTML comments (proseWords in github.mjs)`,
    async run(L, ctx) {
      const cards = await cardsOr(L);
      const i = cards.findIndex((c) => ctx.cfg.bodyIgnore.reduce((t, re) => t.replace(re, ""), c.body).trim());
      if (i < 0) return skip("no issue with a body yet");
      const words = proseWords(cards[i].body, ctx.cfg.bodyIgnore);
      const detail = [
        { label: `the latest issue #${cards[i].number}, opened ${cards[i].createdAt.slice(0, 10)}`, value: words, unit: "words" },
        count("newer issues with an empty body, passed over", i),
      ];
      return measured(words, detail);
    },
  },
  // What a parser reads, never whether a file exists: GitHub rejects a form it cannot parse and then offers blank issues.
  "issues.intake_ready": {
    source: "state: .github/ISSUE_TEMPLATE, each YAML issue form parsed (name, description, body, type) and config.yml (blank_issues_enabled); the type check is against params.issue_types",
    async run(_L, { root, cfg }) {
      if (!existsSync(root)) return skip(`root ${root} does not exist`);
      const { forms, config } = readForms(root) ?? { forms: [], config: {} };
      const reads = (f) => Boolean(f.doc?.name && f.doc?.description && Array.isArray(f.doc?.body));
      const checks = [flag("every issue form parses, with a name, a description and a body", forms.length && forms.every(reads))];
      if (cfg.issueTypes.length) checks.push(flag(`every form sets a type: ${cfg.issueTypes.join(", ")}`, forms.length && forms.every((f) => cfg.issueTypes.includes(f.doc?.type))));
      checks.push(flag("config.yml turns blank issues off", config.blank_issues_enabled === false));
      const broken = forms.filter((f) => !reads(f)).map((f) => count(`${f.file} does not parse as a form`, 0));
      return measured(pct(checks.filter((d) => d.value).length, checks.length), [...checks, ...broken]);
    },
  },
  "issues.card_visual_share": {
    source: `gh api graphql: the ${LAST_CARDS} newest issues (body); the share with a table, a diagram GitHub draws (Mermaid, GeoJSON, TopoJSON, STL) or an image (hasVisual in github.mjs)`,
    async run(L, ctx) {
      const cards = await cardsOr(L);
      if (!cards.length) return skip("no issues yet");
      // An empty body counts as not visual, on purpose: a card with nothing on
      // it shows nothing. latest_card_words passes empty bodies over instead.
      const visual = cards.filter((c) => hasVisual(c.body, ctx.cfg.bodyIgnore)).length;
      return measured(pct(visual, cards.length), [count("with a visual", visual), count("issues read", cards.length)]);
    },
  },
};

export const ACTION_METRICS = {
  // CI -----------------------------------------------------------------------
  "actions.pinned_share": {
    source: ".github/workflows/*.yml (jobs.*.uses and jobs.*.steps[].uses, parsed as YAML) and the uses: lines .github/workflows/actions.lock records for each",
    async run(L) {
      const files = await workflowsOr(L);
      if (files.could_not_check) return files;
      const lock = await L.lockedWorkflows();
      // GitHub runs the recorded commit of a locked reference, so it is as fixed as a SHA.
      const fixed = (file, target) => /@[0-9a-f]{40}$/.test(target) || (!lock.could_not_check && lock.get(file)?.has(target) === true);
      const detail = [];
      let pinned = 0;
      let total = 0;
      for (const f of files) {
        const targets = usesTargets(f.doc);
        if (!targets.length) continue;
        const ok = targets.filter((t) => fixed(f.file, t)).length;
        pinned += ok;
        total += targets.length;
        detail.push({ label: f.file, value: pct(ok, targets.length) });
      }
      if (!total) return skip("no uses: lines in .github/workflows");
      return measured(pct(pinned, total), detail);
    },
  },
  "actions.locked_share": {
    source: ".github/workflows/actions.lock (workflows) against each .github/workflows/*.yml that calls an outside action in a step",
    async run(L) {
      const files = await workflowsOr(L);
      if (files.could_not_check) return files;
      const lockable = files.filter((f) => stepTargets(f.doc).length);
      if (!lockable.length) return skip("no workflow in .github/workflows calls an outside action in a step");
      const locked = await L.lockedWorkflows();
      if (locked.could_not_check) return locked;
      const detail = lockable.map((f) => flag(f.file, locked.has(f.file)));
      return measured(pct(detail.filter((d) => d.value).length, lockable.length), detail);
    },
  },
  "actions.permissions_share": {
    source: ".github/workflows/*.yml (permissions: blocks)",
    async run(L) {
      const files = await workflowsOr(L);
      if (files.could_not_check) return files;
      if (!files.length) return skip("no workflow files in .github/workflows");
      const explicit = (doc) => doc.permissions !== undefined || (doc.jobs && Object.values(doc.jobs).every((j) => j?.permissions !== undefined));
      const detail = files.map((f) => flag(f.file, explicit(f.doc)));
      return measured(pct(detail.filter((d) => d.value).length, files.length), detail);
    },
  },
};

// The hidden line quality/sync-issues.mjs puts first in each card it makes for a metric.
const SYNC_MARK = /^<!-- quality-metric: [\w.-]+ -->/;

export const PROJECT_METRICS = {
  // Projects -----------------------------------------------------------------
  // A session takes one card, so a count of cards in progress limits nothing. What
  // costs is a card in progress that nothing is building: no open pull request.
  "projects.cards_by_column": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" items (Status, linked pull requests and their state)',
    async run(L, { cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      const idle = board.items.filter((i) => i.status === board.doing && !i.pulls.some((p) => p.state === "OPEN"));
      return measured(idle.length, [...tally(board.items.map((i) => i.status), cfg.columns), { label: `${board.doing}, no open pull request`, value: idle.length }]);
    },
  },
  // A card quality/sync-issues.mjs made for a missed metric closes when the metric
  // recovers, often with no pull request (#53): it is left out.
  "projects.done_with_pr": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" done items (linked pull requests), less those whose body starts with the sync marker <!-- quality-metric: id -->',
    async run(L, { cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      const finished = board.items.filter((i) => i.status === board.done);
      const done = finished.filter((i) => !SYNC_MARK.test(i.body));
      const synced = finished.length - done.length;
      if (!done.length) return skip(synced ? `the Quality sync made each of the ${synced} ${board.done} cards` : `no ${board.done} cards yet`);
      const withPull = done.filter((i) => i.pulls.some((p) => p.merged)).length;
      return measured(pct(withPull, done.length), [count("with a merged PR", withPull), count("without", done.length - withPull), count("made by the Quality sync, left out", synced)]);
    },
  },
  "projects.workflows_on": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" workflows (enabled), against params.project_workflows',
    async run(L, { cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      if (!cfg.workflows.length) return skip(`params.project_workflows in ${TARGETS_FILE} lists no workflow`);
      if (board.items.workflows.error) throw board.items.workflows.error;
      const on = new Set(board.items.workflows.filter((w) => w.enabled).map((w) => w.name));
      const detail = cfg.workflows.map((name) => flag(name, on.has(name)));
      return measured(pct(detail.filter((d) => d.value).length, detail.length), detail);
    },
  },
  // A card reads at a glance when a picture carries it and the prose is short.
  // A draft card shows a diagram block as code, so only an issue card's counts.
  "projects.cards_at_a_glance": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" open draft and issue cards (body): a picture (hasPicture) and at most params.card_words words of prose (proseWords)',
    async run(L, { cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      const cards = board.items.filter((i) => i.status !== board.done && i.kind !== "pull");
      if (!cards.length) return skip("no open draft or issue card yet");
      const pictured = cards.filter((c) => hasPicture(c.body, { diagrams: c.kind === "issue", ignore: cfg.bodyIgnore }));
      const brief = cards.filter((c) => proseWords(c.body, cfg.bodyIgnore) <= cfg.cardWords);
      const both = pictured.filter((c) => brief.includes(c)).length;
      return measured(pct(both, cards.length), [count("with a picture", pictured.length), count(`within ${cfg.cardWords} words`, brief.length), count("open cards", cards.length)]);
    },
  },
  // A bug or a quick fix is an issue, not a card: one on the board is a miss.
  "projects.bug_cards": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" open issue cards (labels, issueType), against params.bug_label and params.issue_types',
    async run(L, { cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      const strays = board.items.filter((i) => i.status !== board.done && i.kind === "issue" && (i.labels.includes(cfg.bugLabel) || cfg.issueTypes.includes(i.type)));
      return measured(strays.length, strays.length ? tally(strays.map((i) => (cfg.issueTypes.includes(i.type) ? i.type : `${cfg.bugLabel} label`))) : undefined);
    },
  },
  // A merged PR closes its issue and the board's Item closed workflow moves the card to the last column; one left behind is a miss (#791).
  "projects.closed_not_done": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" issue cards (issue state, Status)',
    async run(L, { cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      const stuck = board.items.filter((i) => i.kind === "issue" && i.closed && i.status !== board.done);
      return measured(stuck.length, stuck.length ? tally(stuck.map((i) => `#${i.number} in ${i.status}`)) : undefined);
    },
  },
  "projects.oldest_doing_days": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" items in the in-progress column (Status updatedAt)',
    async run(L, { now, cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      const doing = board.items.filter((i) => i.status === board.doing && i.statusAt);
      if (!doing.length) return measured(0, [count("cards in progress", 0)]);
      const since = doing.map((i) => i.statusAt).sort()[0];
      const days = round1((now - Date.parse(since)) / DAY);
      return measured(days, [{ label: `in progress since ${since.slice(0, 10)}`, value: days }]);
    },
  },
  "projects.latest_cycle_hours": {
    source: 'gh api graphql: repositoryOwner.projectsV2 "{project}" the latest done item with a linked PR (Status updatedAt, linked PR createdAt)',
    async run(L, { cfg }) {
      const board = await projectOr(L, cfg);
      if (board.could_not_check) return board;
      const [latest] = board.items
        .filter((i) => i.status === board.done && i.statusAt && i.pulls.length)
        .sort((a, b) => Date.parse(b.statusAt) - Date.parse(a.statusAt));
      if (!latest) return skip(`no ${board.done} card with a linked PR yet`);
      const h = round1(hours(latest.pulls.map((p) => p.createdAt).sort()[0], latest.statusAt));
      return measured(h, [{ label: `done ${latest.statusAt.slice(0, 10)}`, value: h, unit: "hours" }]);
    },
  },
};
