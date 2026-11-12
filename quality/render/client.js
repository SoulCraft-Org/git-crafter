// Interactions for the Quality and Speed page, inlined by page.mjs. Without
// it every section shows, rows still open natively and every value is text;
// with it one view shows at a time and the controls below come alive.
// Plain functions, one job each, started at the bottom: no wrapper, so no
// function holds the whole file.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const REPO = document.body.dataset.repo ?? "";

// ---- Views: #overview, #<tab>, or #m-<metric id> inside its tab ------------
function hashTarget() {
  let id = "";
  try {
    id = decodeURIComponent(location.hash.slice(1));
  } catch {}
  return id ? document.getElementById(id) : null;
}

function markNav(view) {
  for (const a of $$(".tabnav a")) {
    if (a.hash === `#${view.id}`) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  const current = $(".tabnav a[aria-current]");
  // Start the strip at the link before the current one, on a link's edge, so no link is cut mid-word.
  if (current) current.parentElement.scrollTo({ left: (current.previousElementSibling ?? current).offsetLeft, behavior: "instant" });
}

function openMetric(target) {
  const tab = target.closest(".tab");
  if (tab.dataset.filter !== "all") setFilter(tab, "all");
  target.open = true;
  target.scrollIntoView({ block: "center" });
  $("summary", target).focus({ preventScroll: true });
}

function show(fromHash) {
  const target = hashTarget();
  const view = target?.closest(".view") ?? $("#overview");
  for (const v of $$(".view")) v.hidden = v !== view;
  markNav(view);
  if (target?.matches("details.metric")) openMetric(target);
  else if (fromHash) scrollTo(0, 0);
}

// ---- Filter chips ---------------------------------------------------------
function setFilter(tab, f) {
  tab.dataset.filter = f;
  for (const b of $$(".chips button", tab)) b.setAttribute("aria-pressed", String(b.dataset.f === f));
}

function initFilters() {
  for (const group of $$(".chips")) {
    group.hidden = false;
    group.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]");
      if (b && !b.disabled) setFilter(group.closest(".tab"), b.dataset.f);
    });
  }
}

// ---- Scoreboard sort: tab order, quality, speed, misses -------------------
function sortBoardRows(board, key, dir) {
  const num = (tr) => (tr.dataset[key] === "" ? null : Number(tr.dataset[key]));
  const rows = $$("tr", board.tBodies[0]).sort((a, b) => {
    const [x, y] = [num(a), num(b)];
    if (x === null || y === null) return (x === null) - (y === null);
    return (x - y) * dir || a.dataset.order - b.dataset.order;
  });
  board.tBodies[0].append(...rows);
}

function initBoard() {
  const board = $(".board");
  if (!board) return;
  const dirs = { order: 1, q: 1, s: 1, m: -1 };
  let active = "order";
  board.tHead.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sort]");
    if (!b) return;
    const key = b.dataset.sort;
    dirs[key] = key === active ? -dirs[key] : dirs[key];
    active = key;
    sortBoardRows(board, key, dirs[key]);
    for (const th of board.tHead.rows[0].cells) th.removeAttribute("aria-sort");
    b.parentElement.setAttribute("aria-sort", dirs[key] > 0 ? "ascending" : "descending");
  });
}

// ---- Review heatmaps: width mode, more rows, drill-down -------------------
const step = (v) => Math.min(Math.max(Math.ceil(v - 0.5), 1), 5);
const scoreText = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const widthMode = (w) => (w === undefined || w === null || w === "" || !Number.isFinite(Number(w)) ? null : Number(w) >= 768 ? "d" : "p");
function pageLabel(p) {
  const task = /^task:(\d+)$/.exec(p);
  return task ? `Task ${task[1]}` : p.replace(/^https?:\/\/[^/]+(?=\/|$)/, "") || "/";
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// Packed by review.mjs reviewJson(): [page, criterion, score, width, area,
// issue, finding, fix, evidence], with pages and criteria by index.
function readItems(rv) {
  try {
    const data = JSON.parse($("script.rv-data", rv).textContent);
    return data.i.map((a) => ({ p: data.p[a[0]], c: data.c[a[1]], s: a[2], w: a[3], area: a[4] === 1, t: a[5], f: a[6], x: a[7], e: a[8] }));
  } catch {
    return [];
  }
}

const relimit = (ctx) => $$("tr", ctx.tbody).forEach((tr, i) => tr.classList.toggle("extra", i >= 12));

// A cell's value in a mode: its own data-d or data-p, else data-b; an
// empty value means that width has no score there.
const valueIn = (btn, m) => btn.dataset[m] ?? btn.dataset.b;

function setCell(btn, m) {
  const v = valueIn(btn, m);
  btn.hidden = v === "";
  if (v === "") return;
  const n = Number(v);
  btn.textContent = scoreText(n);
  btn.classList.replace(/k\d/.exec(btn.className)[0], `k${step(n)}`);
  btn.setAttribute("aria-label", `${scoreText(n)}: ${btn.dataset.tip}`);
}

function rowMean(tr, m) {
  const vals = $$(".cell", tr).map((b) => valueIn(b, m)).filter((v) => v !== "").map(Number);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : Infinity;
}

function applyMode(ctx, m) {
  ctx.mode = m;
  for (const btn of $$(".cell", ctx.tbody)) setCell(btn, m);
  const rows = $$("tr", ctx.tbody).map((tr, i) => [tr, rowMean(tr, m), i]);
  rows.sort((a, b) => a[1] - b[1] || a[2] - b[2]);
  ctx.tbody.append(...rows.map(([tr]) => tr));
  relimit(ctx);
  for (const b of $$(".seg button", ctx.rv)) b.setAttribute("aria-pressed", String(b.dataset.m === m));
}

function findingWhere(ctx, it) {
  if (ctx.hasArea && !it.area) return it.p;
  return it.w ? `${widthMode(it.w) === "p" ? "Phone" : "Desktop"} ${it.w}` : "";
}

function issueNode(t) {
  const a = el(REPO ? "a" : "span", "", `Issue #${t}`);
  if (REPO) a.href = `${REPO}/issues/${t}`;
  return a;
}

function finding(ctx, it) {
  const art = el("article", "finding");
  const head = el("p", "fh");
  head.append(el("span", `sc k${step(it.s)}`, scoreText(it.s)));
  const where = findingWhere(ctx, it);
  if (where) head.append(el("span", "where", where));
  if (Number.isInteger(it.t)) head.append(issueNode(it.t));
  const dl = el("dl");
  for (const [name, text] of [["Finding", it.f], ["Fix", it.x], ["Evidence", it.e]]) {
    if (text) dl.append(el("dt", "", name), el("dd", "", String(text)));
  }
  art.append(head, dl);
  return art;
}

// The items under one cell: its own, in this mode, desktop first; under an
// area, the file findings below it, weakest first.
function cellList(ctx, page, crit) {
  const { items, hasArea, mode } = ctx;
  const own = items.filter((it) => it.p === page && it.c === crit && (!hasArea || it.area));
  const fitsMode = (it) => mode === "b" || widthMode(it.w) === null || widthMode(it.w) === mode;
  const list = own.filter(fitsMode).sort((a, b) => (widthMode(a.w) === "p") - (widthMode(b.w) === "p"));
  if (hasArea) {
    list.push(...items.filter((it) => !it.area && it.c === crit && String(it.p).startsWith(`${page}/`)).sort((a, b) => a.s - b.s));
  }
  return list;
}

function openCell(ctx, btn) {
  const page = btn.closest("tr").dataset.page;
  const head = ctx.heads[btn.parentElement.cellIndex - 1];
  for (const s of $$(".cell.sel", ctx.tbody)) {
    s.classList.remove("sel");
    s.setAttribute("aria-pressed", "false");
  }
  btn.classList.add("sel");
  btn.setAttribute("aria-pressed", "true");
  const title = el("p", "drill-h");
  title.append(el("b", "", pageLabel(page)), el("span", "", head.textContent));
  ctx.drill.replaceChildren(title, ...cellList(ctx, page, head.dataset.key).map((it) => finding(ctx, it)));
}

function onReviewClick(ctx, e) {
  const cell = e.target.closest(".cell");
  if (cell) return openCell(ctx, cell);
  const m = e.target.closest(".seg button");
  if (m) {
    applyMode(ctx, m.dataset.m);
    const sel = $(".cell.sel", ctx.tbody);
    if (sel && !sel.hidden) openCell(ctx, sel);
    return;
  }
  if (e.target === ctx.moreBtn) {
    const all = ctx.table.classList.toggle("all");
    ctx.moreBtn.textContent = all ? "Show the weakest 12" : ctx.moreLabel;
    ctx.moreBtn.setAttribute("aria-expanded", String(all));
  }
}

function initReview(rv) {
  const items = readItems(rv);
  const table = $(".heatmap", rv);
  const moreBtn = $(".more-rows", rv);
  const ctx = {
    rv,
    items,
    table,
    tbody: table.tBodies[0],
    heads: [...table.tHead.rows[0].cells].slice(1),
    hasArea: items.some((it) => it.area),
    drill: $(".drill", rv),
    moreBtn,
    moreLabel: moreBtn?.textContent,
    mode: "b",
  };
  for (const btn of $$(".cell", ctx.tbody)) {
    btn.setAttribute("aria-pressed", "false");
    // The name leads with the visible score ("3.5: /regions/, Type"); the
    // tooltip is the rest.
    btn.dataset.tip = btn.getAttribute("aria-label").replace(/^[\d.]+: /, "");
  }
  rv.addEventListener("click", (e) => onReviewClick(ctx, e));
  const seg = $(".seg", rv);
  if (seg) seg.hidden = false;
  if (moreBtn) {
    moreBtn.hidden = false;
    moreBtn.setAttribute("aria-expanded", "false");
  }
  // The server opened the drill-down on the weakest cell; mark it.
  const weakest = $$(".cell", ctx.tbody).sort((a, b) => Number(a.dataset.b) - Number(b.dataset.b))[0];
  if (weakest) {
    weakest.classList.add("sel");
    weakest.setAttribute("aria-pressed", "true");
  }
}

// ---- Hover labels -----------------------------------------------------------
function initLabels() {
  // A breakdown label split into file and directory shows its whole path on
  // hover and focus.
  // Found through .dir, not th:has(), which throws where :has() is missing.
  for (const dir of $$(".dir")) {
    const th = dir.closest("th");
    if (th) th.dataset.tip = `${dir.textContent.replace(/\u200e/g, "")}${$(".base", th)?.textContent ?? ""}`;
  }
  // A metric's label shows what it counts (its means line) on hover and focus.
  for (const d of $$("details.metric")) {
    const means = $(".means", d);
    if (means) $(".lbl", d).dataset.tip = means.textContent;
  }
}

// ---- Tooltip: one floating element for every [data-tip] -------------------
function placeTip(tip, node) {
  const r = node.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const x = Math.min(Math.max(r.left + r.width / 2 - t.width / 2, 8), innerWidth - t.width - 8);
  const y = r.top - t.height - 8 < 8 ? r.bottom + 8 : r.top - t.height - 8;
  tip.style.left = `${Math.round(x)}px`;
  tip.style.top = `${Math.round(y)}px`;
}

function initTooltip() {
  const tip = $("#tip");
  let tipFor = null;
  const hideTip = () => {
    tip.hidden = true;
    tipFor = null;
  };
  const showTip = (node) => {
    const text = node?.getAttribute("data-tip");
    if (!text) return;
    tipFor = node;
    tip.textContent = text;
    tip.hidden = false;
    placeTip(tip, node);
  };
  document.addEventListener("pointerover", (e) => {
    const node = e.target.closest?.("[data-tip]");
    if (node && node !== tipFor) showTip(node);
    else if (!node && tipFor) hideTip();
  });
  document.addEventListener("pointerleave", hideTip);
  document.addEventListener("focusin", (e) => {
    const node = e.target.closest("[data-tip]") ?? e.target.querySelector?.("[data-tip]");
    if (node) showTip(node);
    else hideTip();
  });
  document.addEventListener("focusout", hideTip);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTip();
  });
  addEventListener("scroll", hideTip, { passive: true });
}

// ---- Start ------------------------------------------------------------------
initFilters();
initBoard();
for (const rv of $$(".review[data-review]")) initReview(rv);
initLabels();
initTooltip();
addEventListener("hashchange", () => show(true));
show(false);
// The peaks rise once, on the first load of the overview (page.css skips it
// under prefers-reduced-motion).
setTimeout(() => document.documentElement.classList.remove("rise"), 1500);
