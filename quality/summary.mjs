// The Quality page's scores as plain text for a CI run: a Markdown job summary and
// a workflow notice. A job summary cannot be read through the REST API, but the
// notice becomes a check-run annotation, which `gh api
// repos/<repo>/check-runs/<id>/annotations` reads from any session, public
// repo or private. Pure functions over score.mjs output; build.mjs writes them.

import { appendFileSync } from "node:fs";

import { finite } from "./render/charts.mjs";
import { overall, workQueue } from "./render/model.mjs";
import { newestReviews, scoreTab } from "./score.mjs";

const cell = (part) => (part && finite(part.score) ? String(part.score) : "–");

// The scored tabs, master and categories, and the top of the work queue, for
// one built page. `reviewHistory` is the same input the page reads.
export function pageScores({ defs, metrics, reviewHistory = {}, tabs }) {
  const reviews = newestReviews(reviewHistory);
  const results = tabs.map(([id]) => scoreTab(id, defs, metrics, reviews));
  const total = overall(results);
  return {
    master: total.master.score,
    categories: { quality: total.quality.score, speed: total.speed.score, consumption: total.consumption.score },
    tabs: results.map((r, i) => ({
      id: r.tab,
      name: tabs[i][1] ?? r.tab,
      quality: r.quality.score,
      speed: r.speed.score,
      consumption: r.consumption?.score ?? null,
      misses: r.rows.filter((row) => row.status === "misses").length,
    })),
    queue: workQueue(results).slice(0, 5).map((row) => ({ tab: row.tab, id: row.def.id, label: row.def.label ?? row.def.id, gain: row.gain })),
  };
}

// The job summary: the master and categories, one row per tab, the work queue's top five.
export function summaryMarkdown(scores, { name = "", commit = "" } = {}) {
  const lines = [`### Quality, Speed and Consumption${name ? `: ${name}` : ""}`, ""];
  lines.push(`Master score **${cell({ score: scores.master })} / 100**${commit ? ` at \`${String(commit).slice(0, 7)}\`` : ""}.`, "");
  lines.push("| Category | Score |", "| --- | --- |");
  for (const [k, v] of Object.entries(scores.categories)) lines.push(`| ${k[0].toUpperCase()}${k.slice(1)} | ${cell({ score: v })} |`);
  lines.push("", "| Tab | Quality | Speed | Consumption | Misses |", "| --- | --- | --- | --- | --- |");
  for (const t of scores.tabs) lines.push(`| ${t.name} | ${cell({ score: t.quality })} | ${cell({ score: t.speed })} | ${cell({ score: t.consumption })} | ${t.misses} |`);
  if (scores.queue.length) {
    lines.push("", "| Work queue | Tab | Points it adds |", "| --- | --- | --- |");
    for (const q of scores.queue) lines.push(`| ${q.label} | ${q.tab} | +${q.gain} |`);
  }
  return `${lines.join("\n")}\n`;
}

// GitHub's workflow-command escapes: data takes %, CR and LF; a property also : and ,.
const escData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

// One `::notice`: the master score in the title, every score in the message.
export function noticeLine(scores) {
  const cat = scores.categories;
  const body = [
    `Quality ${cell({ score: cat.quality })}, Speed ${cell({ score: cat.speed })}, Consumption ${cell({ score: cat.consumption })}`,
    ...scores.tabs.map((t) => `${t.name}: quality ${cell({ score: t.quality })}, speed ${cell({ score: t.speed })}, consumption ${cell({ score: t.consumption })}, ${t.misses} misses`),
  ].join("\n");
  return `::notice title=${escProp(`Quality page master score ${cell({ score: scores.master })} of 100`)}::${escData(body)}`;
}

// Writes the summary to the file GITHUB_STEP_SUMMARY names and prints the
// notice, only inside Actions; anywhere else it does nothing. Returns what it did.
export function publishScores(scores, { env = process.env, log = console.log, name, commit } = {}) {
  const done = { summary: false, notice: false };
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(scores, { name, commit }));
    done.summary = true;
  }
  if (env.GITHUB_ACTIONS === "true") {
    log(noticeLine(scores));
    done.notice = true;
  }
  return done;
}
