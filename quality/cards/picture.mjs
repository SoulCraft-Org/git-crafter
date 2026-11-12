#!/usr/bin/env node
// A board card's picture: its pillar and area, its metric as a meter from now
// to goal, and its steps as a workflow strip. One SVG, light and dark, so a
// card reads at a glance (projects.cards_at_a_glance).
//
//   node quality/cards/picture.mjs spec.json > card.svg
//
// spec.json: { "pillar": "Quality" | "Speed" | "Consumption", "area": "ci",
//   "metric": { "label": "issues tab score", "now": 77, "goal": 100, "unit": "" },
//   "steps": [["Need", "what is wrong"], ["Change", "what changes"], ["Done when", "the check"]] }
// metric is optional: a card with no measured number shows its steps only.
// Exit 0 written, 2 usage error.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WIDTH = 760;
const PAD = 24;
const GAP = 28;
const LINE_CHARS = 30;
const MAX_LINES = 3;
// The dataviz reference palette: one hue per pillar, light then dark.
const PILLARS = { Quality: ["#1baf7a", "#199e70"], Speed: ["#2a78d6", "#3987e5"], Consumption: ["#eb6834", "#d95926"] };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Words wrapped to lines of at most `chars` characters, at most `max` lines; a longer word is cut to fit, and the last line ends in an ellipsis when words are left over. */
export function wrap(text, chars = LINE_CHARS, max = MAX_LINES) {
  const lines = [];
  const words = String(text).split(/\s+/).filter(Boolean).flatMap((w) => w.match(new RegExp(`.{1,${chars}}`, "g")));
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= chars) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length > max ? [...lines.slice(0, max - 1), `${lines[max - 1]}…`] : lines;
}

/** How far now is toward goal, 0 to 1: now over goal when higher is better, goal over now when lower is; 0 when either is not a number. */
export function progress({ now, goal }) {
  const [n, g] = [Number(now), Number(goal)];
  if (!Number.isFinite(n) || !Number.isFinite(g)) return 0;
  if (n === g) return 1;
  return Math.max(0, Math.min(1, g > n ? n / g : g / n));
}

// The header row: a pillar chip (a colored dot beside ink text) and the area.
function chips(spec) {
  const area = spec.area ? `<text class="s" x="${PAD + 120}" y="${PAD + 12}">${esc(spec.area)}</text>` : "";
  return `<circle class="fill" cx="${PAD + 6}" cy="${PAD + 8}" r="6"/><text class="p b" x="${PAD + 20}" y="${PAD + 12}">${esc(spec.pillar)}</text>${area}`;
}

// The metric: its label, now and goal as the headline, and a meter whose fill is the progress.
function meter(metric, y) {
  const unit = metric.unit ? ` ${esc(metric.unit)}` : "";
  const track = WIDTH - 2 * PAD;
  const fill = Math.max(8, Math.round(track * progress(metric)));
  return [
    `<text class="s" x="${PAD}" y="${y}">${esc(metric.label)}</text>`,
    `<text class="p h" x="${PAD}" y="${y + 40}">${esc(metric.now)}<tspan class="s"> → </tspan>${esc(metric.goal)}<tspan class="s u">${unit}</tspan></text>`,
    `<rect class="track" x="${PAD}" y="${y + 54}" width="${track}" height="10" rx="5"/>`,
    `<rect class="fill" x="${PAD}" y="${y + 54}" width="${fill}" height="10" rx="5"/>`,
  ].join("");
}

// The steps as boxes left to right, an arrow between each pair.
function strip(steps, y) {
  const box = (WIDTH - 2 * PAD - GAP * (steps.length - 1)) / steps.length;
  return steps
    .map(([label, text], i) => {
      const x = PAD + i * (box + GAP);
      const lines = wrap(text, Math.floor(box / 7.2)).map((line, n) => `<text class="p" x="${x + 12}" y="${y + 50 + n * 18}">${esc(line)}</text>`);
      const arrow = i ? `<path class="arrow" d="M${x - GAP + 6} ${y + 48} h${GAP - 14} m-6 -5 l6 5 l-6 5"/>` : "";
      return `${arrow}<rect class="box" x="${x}" y="${y}" width="${box}" height="96" rx="8"/><text class="s b" x="${x + 12}" y="${y + 24}">${i + 1}  ${esc(label)}</text>${lines.join("")}`;
    })
    .join("");
}

const STYLE = (light, dark) => `
  .bg{fill:#fcfcfb;stroke:#d9d8d2}.p{fill:#0b0b0b}.s{fill:#52514e}.track{fill:#e6e5df}.box{fill:none;stroke:#c9c8c1}
  .arrow{fill:none;stroke:#52514e;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.fill{fill:${light}}
  text{font:14px system-ui,-apple-system,"Segoe UI",sans-serif}.b{font-weight:600}.h{font-size:34px;font-weight:600}.u{font-size:14px;font-weight:400}
  @media (prefers-color-scheme:dark){.bg{fill:#1a1a19;stroke:#3a3a37}.p{fill:#f0efec}.s{fill:#c3c2b7}.track{fill:#33332f}.box{stroke:#55544e}.arrow{stroke:#c3c2b7}.fill{fill:${dark}}}`;

/** The card's picture as one SVG document. Throws a usage error for an unknown pillar or a spec with no steps. */
export function picture(spec) {
  const hues = PILLARS[spec.pillar];
  if (!hues) throw new Error(`pillar must be one of ${Object.keys(PILLARS).join(", ")}`);
  if (!Array.isArray(spec.steps) || !spec.steps.length || spec.steps.length > 4) throw new Error("steps must list 1 to 4 [label, text] pairs");
  const top = PAD + 44;
  const stripY = spec.metric ? top + 84 : top - 8;
  const height = stripY + 96 + PAD;
  const title = `${spec.pillar}${spec.metric ? `: ${spec.metric.label} ${spec.metric.now} to ${spec.metric.goal}` : ""}. ${spec.steps.map(([l, t]) => `${l}: ${t}`).join(". ")}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img"><title>${esc(title)}</title><style>${STYLE(...hues)}</style><rect class="bg" x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="12"/>${chips(spec)}${spec.metric ? meter(spec.metric, top) : ""}${strip(spec.steps, stripY)}</svg>\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.stdout.write(picture(JSON.parse(readFileSync(process.argv[2], "utf8"))));
  } catch (err) {
    console.error(`picture: ${err.message}\nusage: node quality/cards/picture.mjs spec.json > card.svg`);
    process.exit(2);
  }
}
