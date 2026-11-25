// Interactions for both Git Crafter pages, inlined by build.mjs. Without it every
// step panel shows, every goal row opens natively and every value is text;
// with it one step shows at a time and the filters, sorts and tooltip work.
{
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---- Tooltip: any element with data-tip, on hover and on focus -----------
  const tip = $("#tip");
  const place = (x, y) => {
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = `${Math.min(Math.max(x - w / 2, 8), innerWidth - w - 8)}px`;
    tip.style.top = `${y - h - 12 < 8 ? y + 18 : y - h - 12}px`;
  };
  const show = (el, x, y) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    place(x, y);
  };
  const initTooltip = () => {
    document.addEventListener("pointermove", (e) => {
      const el = e.target.closest?.("[data-tip]");
      if (!el) return void (tip.hidden = true);
      show(el, e.clientX, e.clientY);
    });
    document.addEventListener("focusin", (e) => {
      const el = e.target.closest?.("[data-tip]");
      if (!el) return void (tip.hidden = true);
      const r = el.getBoundingClientRect();
      show(el, r.left + r.width / 2, r.top);
    });
    document.addEventListener("scroll", () => (tip.hidden = true), { passive: true });
  };
  initTooltip();

  // ---- Process: tabs, the repo filter and one step panel per map -----------
  // All three live in the hash (#tab=ci&repo=my-repo&step=delivery-merge),
  // so a view can be linked; the older #step-<map>-<step> still opens a step.
  const toggleCurrent = (el, on, value) => (on ? el.setAttribute("aria-current", value) : el.removeAttribute("aria-current"));

  // The tab, repo and step a hash names, kept only when the page has them.
  const readProcessHash = ({ ptabs, maps, pick, open, state }) => {
    const mapOf = (step) => maps.find((m) => $$(".panel", m).some((p) => p.dataset.step === step))?.dataset.map;
    const h = location.hash.slice(1);
    const saved = new URLSearchParams(h.startsWith("step-") ? `step=${h.slice(5)}` : h);
    if (ptabs.some((t) => t.dataset.tab === saved.get("tab"))) state.tab = saved.get("tab");
    if ([...pick.options].some((o) => o.value && o.value === saved.get("repo"))) state.repo = pick.value = saved.get("repo");
    const linked = saved.get("step");
    if (linked && mapOf(linked)) open[mapOf(linked)] = state.step = linked;
  };

  const writeProcessHash = (state) => {
    const q = new URLSearchParams();
    if (state.tab !== "build") q.set("tab", state.tab);
    if (state.repo) q.set("repo", state.repo);
    if (state.tab === "build" && state.step) q.set("step", state.step);
    const t = q.toString();
    history.replaceState(null, "", t ? `#${t}` : location.pathname);
  };

  // The step before (by -1) or after (by 1) a map's step, skipping steps the lane filter dims; null at either end.
  const stepFrom = (m, from, by) => {
    const bar = $$(".stepbar button", m);
    for (let i = bar.findIndex((b) => b.dataset.step === from) + by; i >= 0 && i < bar.length; i += by) if (!bar[i].classList.contains("off")) return bar[i].dataset.step;
    return null;
  };

  // A group of buttons the client adds to a map; each button's text is its name.
  const group = (m, cls, label, buttons) => {
    const box = document.createElement("div");
    box.className = cls;
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", `${$("h2", m).textContent}: ${label}`);
    for (const [key, value, text] of buttons) {
      const b = box.appendChild(document.createElement("button"));
      b.type = "button";
      b.dataset[key] = value;
      b.textContent = text;
    }
    return box;
  };

  // Previous and Next walk a map's steps in order, after its step buttons.
  const addStepNav = (m) => $(".stepbar", m)?.after(group(m, "stepnav", "previous or next step", [["go", "-1", "Previous step"], ["go", "1", "Next step"]]));

  // A lane map gets one toggle per lane, named as its band is: one picked dims the other lanes' steps.
  const addLaneFilter = (m) => {
    const svg = $("svg.lanes", m);
    if (!svg) return;
    const names = $$(".t-actor", svg).map((t) => t.textContent);
    const ids = [...new Set($$(".t-step", svg).map((a) => a.dataset.actor))];
    svg.closest(".hero").before(group(m, "lanefilter", "show the steps of", [["actor", "", "Everyone"], ...ids.map((id, i) => ["actor", id, names[i]])]));
    filterLanes(m, "");
  };

  // Each line gets a copy along its own path, which the stylesheet runs dots on when the reader allows motion.
  const addFlow = (m) => {
    for (const p of $$(".trail .t-main, .trail .t-off", m)) {
      const f = p.cloneNode();
      f.setAttribute("class", "t-flow");
      p.after(f);
    }
  };

  const filterLanes = (m, actor) => {
    const of = Object.fromEntries($$(".t-step", m).map((a) => [a.dataset.step, a.dataset.actor]));
    for (const a of $$(".t-step", m)) a.classList.toggle("off", Boolean(actor) && a.dataset.actor !== actor);
    for (const b of $$(".stepbar button", m)) b.classList.toggle("off", Boolean(actor) && of[b.dataset.step] !== actor);
    for (const b of $$(".lanefilter button", m)) b.setAttribute("aria-pressed", String(b.dataset.actor === actor));
  };

  // Each map shows its open step's panel, trail link and step button; Previous or Next is off at its end.
  const showSteps = (maps, open) => {
    for (const m of maps) {
      const step = open[m.dataset.map];
      for (const p of $$(".panel", m)) p.hidden = p.dataset.step !== step;
      for (const a of $$(".t-step", m)) toggleCurrent(a, a.dataset.step === step, "step");
      for (const b of $$(".stepbar button", m)) b.setAttribute("aria-pressed", String(b.dataset.step === step));
      for (const b of $$(".stepnav button", m)) b.setAttribute("aria-disabled", String(!stepFrom(m, step, Number(b.dataset.go))));
    }
  };

  // A readout shows the picked repo's value; one with no per-repo value
  // keeps the org's, dimmed. SVG has no hidden property, so set the attribute.
  const showReadouts = (repo) => {
    for (const g of $$("[data-vg]")) {
      const variants = $$("[data-r]", g);
      const has = Boolean(repo) && variants.some((v) => v.dataset.r === repo);
      for (const v of variants) v.toggleAttribute("hidden", v.dataset.r !== (has ? repo : ""));
      g.classList.toggle("dimmed", Boolean(repo) && !has);
    }
  };

  // Only the picked repo's sections and gates show, and its gate details open.
  const showRepoSections = (repo) => {
    for (const el of $$(".repo-sec, .gates [data-repo]")) {
      el.hidden = Boolean(repo) && el.dataset.repo !== repo;
      if (repo && el.dataset.repo === repo && el.matches("details")) el.open = true;
    }
  };

  const applyProcess = ({ ptabs, maps, open, state }) => {
    for (const t of ptabs) t.hidden = t.dataset.tab !== state.tab;
    for (const a of $$(".ptabs a")) toggleCurrent(a, a.dataset.tab === state.tab, "true");
    showSteps(maps, open);
    showReadouts(state.repo);
    showRepoSections(state.repo);
  };

  // Opens one step of a map, and brings its panel into view when it starts low on the screen.
  const openStep = (ctx, m, step) => {
    ctx.open[m.dataset.map] = ctx.state.step = step;
    applyProcess(ctx);
    writeProcessHash(ctx.state);
    const panel = $(`#step-${step}`);
    if (panel.getBoundingClientRect().top > innerHeight * 0.7) panel.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  // A click on a tab link switches tabs; on a lane toggle filters; on a step link, step button, Previous or Next opens that step.
  const onProcessClick = (e, ctx) => {
    const { pick, open, state } = ctx;
    const refresh = () => {
      applyProcess(ctx);
      writeProcessHash(state);
    };
    const tab = e.target.closest(".ptabs a, a[href^='#tab=']");
    if (tab) {
      e.preventDefault();
      const q = new URLSearchParams(tab.getAttribute("href").slice(1));
      state.tab = q.get("tab") ?? tab.dataset.tab;
      if (q.get("repo")) state.repo = pick.value = q.get("repo");
      refresh();
      scrollTo(0, 0);
      return;
    }
    const lane = e.target.closest(".lanefilter button");
    if (lane) {
      filterLanes(lane.closest(".map"), lane.dataset.actor);
      applyProcess(ctx);
      return;
    }
    const go = e.target.closest(".stepnav button");
    if (go) {
      const m = go.closest(".map");
      const to = stepFrom(m, open[m.dataset.map], Number(go.dataset.go));
      if (to) openStep(ctx, m, to);
      return;
    }
    const a = e.target.closest(".t-step, .stepbar button");
    if (!a) return;
    e.preventDefault();
    openStep(ctx, a.closest(".map"), a.dataset.step);
  };

  // Left and right arrow keys on a step button open the step before or after it and move focus there.
  const onStepKey = (e, ctx) => {
    const by = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    const b = by && e.target.closest(".stepbar button");
    const m = b && b.closest(".map");
    const to = m && stepFrom(m, b.dataset.step, by);
    if (!to) return;
    e.preventDefault();
    openStep(ctx, m, to);
    $(`.stepbar button[data-step="${CSS.escape(to)}"]`, m).focus();
  };

  const initProcess = () => {
    const ptabs = $$(".ptab");
    if (!ptabs.length) return;
    const maps = $$(".map");
    // Each map shows one step's panel: the step its trail opens on, until one is picked.
    const open = Object.fromEntries(maps.map((m) => [m.dataset.map, $(".t-step[aria-current]", m)?.dataset.step ?? $(".panel", m)?.dataset.step]));
    const ctx = { ptabs, maps, pick: $("#prepo"), open, state: { tab: "build", repo: "", step: null } };
    readProcessHash(ctx);
    for (const bar of $$(".stepbar")) bar.hidden = false;
    for (const m of maps) {
      addStepNav(m);
      addLaneFilter(m);
      addFlow(m);
    }
    applyProcess(ctx);
    ctx.pick.addEventListener("change", () => {
      ctx.state.repo = ctx.pick.value;
      applyProcess(ctx);
      writeProcessHash(ctx.state);
    });
    document.addEventListener("click", (e) => onProcessClick(e, ctx));
    document.addEventListener("keydown", (e) => onStepKey(e, ctx));
  };
  initProcess();

  // ---- Metrics: outcome, repo and status filters -------------------------
  // Shows the picked repo's variant of each glyph and bullet (SVG has no
  // hidden property, so set the attribute), and returns whether the row has one.
  const showRowRepo = (row, repo) => {
    const variants = $$("[data-r]", row);
    const has = Boolean(repo) && variants.some((v) => v.dataset.r === repo);
    const pick = has ? repo : "";
    for (const v of variants) v.toggleAttribute("hidden", v.dataset.r !== pick);
    row.classList.toggle("dimmed", Boolean(repo) && !has);
    const g = variants.find((v) => v.dataset.r === pick && v.dataset.s);
    row.dataset.status = g ? g.dataset.s : row.dataset.orgStatus;
  };

  // One goal row under the filters; counts tallies the rows in the picked outcome.
  const filterRow = (row, state, counts) => {
    showRowRepo(row, state.repo);
    const inOutcome = state.outcome === "all" || row.dataset.outcome === state.outcome;
    if (inOutcome) {
      counts.all += 1;
      counts[row.dataset.status] += 1;
    }
    row.hidden = !inOutcome || (state.status !== "all" && row.dataset.status !== state.status);
  };

  const syncControls = (filters, state, counts) => {
    for (const b of $$(".chips button", filters)) {
      const n = counts[b.dataset.f];
      $("b", b).textContent = n;
      b.disabled = n === 0 && b.dataset.f !== "all";
      b.setAttribute("aria-pressed", String(b.dataset.f === state.status));
    }
    for (const b of $$(".seg button[data-o]", filters)) b.setAttribute("aria-pressed", String(b.dataset.o === state.outcome));
    for (const c of $$(".oc")) c.setAttribute("aria-pressed", String(c.dataset.o === state.outcome));
    for (const r of $$(".s-row")) r.classList.toggle("dim", state.outcome !== "all" && r.dataset.outcome !== state.outcome);
    for (const tr of $$(".cmp tbody tr")) tr.classList.toggle("on", tr.dataset.repo === state.repo);
  };

  const applyFilters = (filters, state) => {
    const counts = { all: 0, meets: 0, near: 0, misses: 0, "not-measured": 0 };
    for (const row of $$("details.g-row")) filterRow(row, state, counts);
    for (const sec of $$(".og")) sec.hidden = $$("details.g-row", sec).every((r) => r.hidden);
    syncControls(filters, state, counts);
  };

  // Filters live in the hash (#repo=my-repo&outcome=speed), so a view can be linked.
  const writeFilterHash = (state) => {
    const p = new URLSearchParams();
    if (state.repo) p.set("repo", state.repo);
    if (state.outcome !== "all") p.set("outcome", state.outcome);
    const q = p.toString();
    history.replaceState(null, "", q ? `#${q}` : location.pathname);
  };

  const initFilters = () => {
    const filters = $(".filters");
    if (!filters) return;
    const state = { outcome: "all", repo: "", status: "all" };
    const refresh = () => {
      applyFilters(filters, state);
      writeFilterHash(state);
    };
    const repoPick = $("#repo");
    const saved = new URLSearchParams(location.hash.slice(1));
    if ([...repoPick.options].some((o) => o.value && o.value === saved.get("repo"))) state.repo = repoPick.value = saved.get("repo");
    if ($(`button[data-o="${CSS.escape(saved.get("outcome") ?? "")}"]`, filters)) state.outcome = saved.get("outcome");
    filters.hidden = false;
    filters.addEventListener("click", (e) => {
      const o = e.target.closest("button[data-o]");
      const f = e.target.closest("button[data-f]");
      if (o) state.outcome = o.dataset.o;
      if (f && !f.disabled) state.status = f.dataset.f;
      if (o || f) refresh();
    });
    repoPick.addEventListener("change", (e) => {
      state.repo = e.target.value;
      refresh();
    });
    $(".outcomes")?.addEventListener("click", (e) => {
      const c = e.target.closest(".oc");
      if (!c) return;
      state.outcome = state.outcome === c.dataset.o ? "all" : c.dataset.o;
      refresh();
      filters.scrollIntoView({ block: "start" });
    });
    applyFilters(filters, state);
  };
  initFilters();

  // ---- Sortable tables -------------------------------------------------------
  for (const table of $$("table.sortable")) {
    const body = table.tBodies[0];
    // The build sorts by the column marked aria-sort, so a first click there flips it.
    const head = [...table.tHead.rows[0].cells];
    const marked = head.findIndex((th) => th.hasAttribute("aria-sort"));
    let active = marked >= 0 ? marked : null;
    let dir = marked >= 0 && head[marked].getAttribute("aria-sort") === "ascending" ? 1 : -1;
    table.tHead.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-col]");
      if (!b) return;
      const col = Number(b.dataset.col);
      dir = active === col ? -dir : Number(b.dataset.dir ?? -1);
      active = col;
      const text = b.dataset.type === "text";
      const key = (tr) => tr.children[col].dataset.v ?? "";
      const sorted = [...body.rows].sort((x, y) => {
        const [a, c] = [key(x), key(y)];
        if (a === "" || c === "") return (a === "") - (c === "");
        return (text ? a.localeCompare(c) : Number(a) - Number(c)) * dir;
      });
      body.append(...sorted);
      for (const th of table.tHead.rows[0].cells) th.removeAttribute("aria-sort");
      b.parentElement.setAttribute("aria-sort", dir > 0 ? "ascending" : "descending");
    });
  }

  // ---- Deep links: #goal-<id> opens its row -------------------------------------
  const open = () => {
    let id = "";
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {}
    const target = id ? document.getElementById(id) : null;
    if (!target?.matches("details")) return;
    for (let d = target; d; d = d.parentElement?.closest("details")) d.open = true;
    target.hidden = false;
    target.scrollIntoView({ block: "start" });
  };
  addEventListener("hashchange", open);
  open();
}
