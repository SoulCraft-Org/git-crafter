// The Claude tab: how Claude plans and spends its usage. Labels only; every
// explanation, source and read time is a tooltip.

import { esc, finite, fmtCompact, stack } from "../quality/render/charts.mjs";
import { cicon, delegateMap, routes } from "./draw.mjs";
import { goalText, isMeasured, ruleList } from "./model.mjs";
import { entryOf, idLabel, mtile, rateOf, srcTip, valueOf, when } from "./ui.mjs";

const DECIDE_ICON = [
  [/spend|money|purchase/i, "tokens"],
  [/sign-in|key|token|secret|oauth/i, "key"],
  [/sudo|administrator|guard/i, "shield"],
  [/sending|email|slack/i, "mail"],
  [/delet/i, "trash"],
  [/deploy script|piped/i, "deploy"],
  [/scheduled|cron/i, "clock"],
  [/plan|research|code|test/i, "plan"],
  [/commit|push|pull request/i, "merge"],
  [/judgment|design/i, "review"],
  [/wrangler|repo/i, "deploy"],
];
const iconFor = (text) => DECIDE_ICON.find(([re]) => re.test(text))?.[1] ?? "plan";

// The Which model table from process.json's claude.models: the work, the
// model and effort, the source; the doc's words in the row's tooltip.
function modelPick(spec) {
  if (!spec?.rows?.length) return "";
  const rows = spec.rows
    .map((r) => `<tr data-tip="${esc(r.tip)}" tabindex="0"><th scope="row">${esc(r.work)}</th><td><a href="${esc(r.source)}">${esc(r.model)}</a></td><td>${esc(r.effort)}</td><td class="small">${esc(r.limit ?? "")}</td></tr>`)
    .join("");
  return `<section aria-label="Which model"><h3 class="ch">${cicon("build")}Which model</h3><div class="scroll"><table class="mlane mpick"><thead><tr><th scope="col">Work</th><th scope="col">Model</th><th scope="col">Effort</th><th scope="col"></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

// A delegate node's first metric against its own goal: the status, the text it
// shows and the tooltip's sentence.
function nodeRead(e, id, absent) {
  const def = e?.target && finite(e.target.goal) ? e.target : null;
  if (!isMeasured(e)) return { status: "not-measured", text: "not measured", what: `${e?.label ?? idLabel(id)}: not measured: ${e?.could_not_check ?? absent}` };
  const goal = def ? `, goal ${goalText(def, fmtCompact)}` : "";
  return { status: def ? rateOf(def, e.value) : null, text: valueOf(e), what: `${e.label ?? idLabel(id)}: ${valueOf(e)}${goal}; ${srcTip(e)}` };
}

function delegateNode(n, m, absent) {
  const at = { label: n.label, icon: n.icon };
  if (!n.metrics) return { ...at, text: "", status: null, tip: n.tip ?? "" };
  const id = n.metrics[0];
  if (!id) return { ...at, text: "no metric yet", status: null, tip: [n.tip, "no metric yet", n.ref].filter(Boolean).join("; ") };
  const { status, text, what } = nodeRead(m[id], id, absent);
  return { ...at, text, status, tip: [n.tip, what, n.ref].filter(Boolean).join("; ") };
}

// The When to delegate map from process.json's claude.delegate: each node
// shows its first metric against that metric's own goal.
function delegateSection(spec, m, repoUrl, readAt) {
  if (!spec) return "";
  const absent = `not in data/org.json${readAt ? ` from the collector run at ${when(readAt)}` : ""}`;
  const node = (n) => delegateNode(n, m, absent);
  const map = delegateMap({
    start: node(spec.start),
    def: node(spec.default),
    branches: spec.branches.map(node),
    how: spec.how.map(node),
    light: spec.light ? { ...node(spec.light), word: spec.light.word } : null,
    when: spec.when_word,
    then: spec.how_label,
  });
  const ids = [...new Set([spec.default, ...spec.branches, ...spec.how, spec.light].filter(Boolean).flatMap((n) => n.metrics ?? []))];
  const refs = [...new Set([...spec.branches, spec.light].filter((n) => n?.ref).map((n) => n.ref.split(",")[0].trim()))];
  return `<section aria-label="When to delegate"><h3 class="ch">${cicon("review")}When to delegate</h3><div class="trail-box dm-box">${map}</div><div class="mts">${ids.map((id) => mtile(m[id] ?? { could_not_check: absent }, id)).join("")}</div><p class="src"><a href="${esc(spec.source)}">${esc(spec.source_label)}</a>${refs.map((r) => ` <a href="${esc(`${repoUrl}/${r}`)}">${esc(r)}</a>`).join("")}</p></section>`;
}

// The Claude tab: usage, model routes, when to delegate and who decides.
export function claudeTab(data, processDoc, rulesMd) {
  const c = processDoc.claude;
  const m = new Proxy({}, { get: (_, id) => entryOf(data, id) });
  const usage = `<div class="mts">${c.usage.map((id) => mtile(m[id], id)).join("")}${mtile({ could_not_check: "no collector reads the plan's usage meter" }, "plan", "Weekly plan use")}</div>`;
  const tok = m["claude.tokens_per_merged_pr"];
  const parts = isMeasured(tok) ? (tok.detail ?? []).filter((d) => (d.unit ?? "tokens") === "tokens" && !/merged/i.test(d.label)).map((d) => ({ label: String(d.label).replace(/ per PR$/, ""), value: d.value })) : [];
  const where = parts.length ? `<figure class="where" data-tip="${esc(srcTip(tok))}" tabindex="0"><figcaption>Tokens per merged PR</figcaption>${stack(parts, "tokens")}</figure>` : "";
  const third = m[c.routes.find((r) => r.share)?.share];
  const routeIcons = { opus: "build", light: "review", open: "sessions" };
  const rt = routes(
    c.routes.map((r) => ({
      ...r,
      icon: routeIcons[r.id] ?? "build",
      share: r.share && isMeasured(m[r.share]) ? m[r.share].value : undefined,
      shareText: r.share && isMeasured(m[r.share]) ? valueOf(m[r.share]) : "",
      tip: `${r.tip}${r.ref ? ` (${r.ref})` : ""}${r.share && isMeasured(m[r.share]) ? `; ${m[r.share].label}: ${valueOf(m[r.share])}; ${srcTip(m[r.share])}` : ""}`,
    })),
  );
  // Under 640 px the routes read as a list; the drawing's labels would be too small.
  const rtList = `<ul class="rt-list">${c.routes
    .map((r) => {
      const v = r.share && isMeasured(m[r.share]) ? valueOf(m[r.share]) : "";
      return `<li data-tip="${esc(`${r.tip}${r.ref ? ` (${r.ref})` : ""}`)}" tabindex="0">${cicon(routeIcons[r.id] ?? "build")}${esc(r.label)}${v ? `<b>${esc(v)}</b>` : ""}</li>`;
    })
    .join("")}</ul>`;
  const list = (items) => `<ul>${items.map((i) => `<li data-tip="${esc(i.text)}" tabindex="0">${cicon(iconFor(i.text))}${esc(i.label)}</li>`).join("")}</ul>`;
  const alone = ruleList(rulesMd, "Decide without asking");
  // The rules name the queue after whoever owns the repo ("## Owner's queue").
  const owner = ruleList(rulesMd, /^.+'s queue$/);
  const decide = alone.length || owner.length ? `<div class="decide"><section><h3>${cicon("plan")}Claude decides</h3>${list(alone)}</section><section><h3>${cicon("shield")}Waits for the owner</h3>${list(owner)}</section></div><p class="src"><a href="${esc(`${processDoc.repo_url}/${c.decisions_ref}`)}">${esc(c.decisions_ref)}</a></p>` : "";
  return `<div data-vg="">
<section aria-label="Usage"><h3 class="ch">${cicon("tokens")}Usage</h3>${usage}${where}</section>
<section aria-label="Model routes"><h3 class="ch">${cicon("sessions")}Routes</h3><div class="trail-box rt-box">${rt}</div>${rtList}<p class="src"><a href="${esc(`${processDoc.repo_url}/${c.routes_ref}`)}">${esc(c.routes_ref)}</a>${third ? ` ${esc(srcTip(third))}` : ""}</p></section>
${modelPick(c.models)}
${delegateSection(c.delegate, m, processDoc.repo_url, data.generated_at)}
<section aria-label="Who decides">${decide}</section>
</div>`;
}
