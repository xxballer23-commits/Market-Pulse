/* Market Pulse front end. Plain JS, no build step. Reads JSON from ./data */
(() => {
  "use strict";

  const D = "data/";
  const cache = new Map();
  const state = { manifest: null, feed: null, olderLoaded: new Set() };
  const $app = document.getElementById("app");

  // ---------- utils ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? esc(u) : "#");
  const slug = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const todayISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00"); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const fmtDate = (iso, opts = { month: "short", day: "numeric" }) => {
    if (!iso) return "";
    const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    return isNaN(d) ? esc(iso) : d.toLocaleDateString(undefined, opts);
  };
  const fullTs = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }); };
  const ago = (iso) => {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
    return fmtDate(iso);
  };
  const md = (text) => {
    const html = window.marked ? window.marked.parse(text || "") : `<pre>${esc(text)}</pre>`;
    const clean = window.DOMPurify ? window.DOMPurify.sanitize(html) : esc(text);
    return clean.replace(/<a /g, '<a target="_blank" rel="noopener" ');
  };
  const empty = (msg) => `<div class="empty">${msg}</div>`;
  const ext = (url, text) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${text}</a>`;

  async function get(path, fallback = null, asText = false) {
    if (cache.has(path)) return cache.get(path);
    try {
      const r = await fetch(D + path + "?v=" + encodeURIComponent(state.manifest?.last_sweep || Date.now()), { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      const v = asText ? await r.text() : await r.json();
      cache.set(path, v);
      return v;
    } catch (e) {
      return fallback;
    }
  }

  // ---------- repo / desk links (GitHub issues are the team's request channel) ----------
  function repoInfo() {
    const host = location.hostname;
    if (!host.endsWith("github.io")) return null;
    const owner = host.split(".")[0];
    const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
    return { owner, repo };
  }
  function issueUrl(title, body) {
    const r = repoInfo();
    if (!r) return "#";
    return `https://github.com/${r.owner}/${r.repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }
  const vetUrl = (name, by = "", ctx = "") => issueUrl(`Vet: ${name || ""}`, `Requested by: ${by}\nContext: ${ctx}\n\n(Diligence brief is written automatically, saved to the Diligence page, and this issue closes. Research and drafting only.)`);
  const watchUrl = (name, by = "", why = "") => issueUrl(`Watch: ${name || ""}`, `Requested by: ${by}\nWhy: ${why}\nCategory: \n\n(Adds the company to the shared Watchlist as emerging.)`);
  const approveUrl = (id) => issueUrl(`Approve: ${id}`, "Curator review: I have read this edition and it is ready for the team.");

  // ---------- labels ----------
  const SECTION_LABEL = { premium_cards: "Premium Card Intel", luxury: "Luxury Trends", nyc_dining: "NYC Dining", partnerships: "Partnership Radar", lending: "Personal Loans & BNPL", spending_data: "Spending", community: "Card Community", regulatory: "Regulatory", wells: "Wells Fargo" };
  const sectionLabel = (id) => (state.manifest?.sections || []).find((s) => s.id === id)?.label || SECTION_LABEL[id] || id;
  const SUBCAT = { dining: "Dining", entertainment: "Entertainment", sporting: "Sporting", lifestyle: "Lifestyle", goods_retail: "Goods & Retail", travel: "Travel" };
  const PRODUCT_LABEL = { briefing: "Luxury Trends Briefing", radar: "Partnership Radar", review: "Week in Review", earnings: "Earnings Recap" };
  const TYPE_LABEL = { monday: "Weekly briefing", update: "Briefing update", radar: "Weekly radar", radar_update: "Radar update", friday: "Week in review", earnings: "Earnings recap", daily: "Daily brief" };
  const NYC_KIND = { opening: "Opening", closing: "Closing", chef_move: "Chef move", reservation_intel: "Reservation intel", event: "Dining event", other: "NYC dining" };

  const relBars = (n) => `<span class="rel" title="Relevance ${n} of 5: premium and partnership impact" aria-label="Relevance ${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}<span>${n}/5</span></span>`;
  const STATUS_LABEL = { signed: "has issuer deal", rumored: "in talks / rumored", in_talks: "in talks / rumored", soon: "opening soon", open: "open now" };
  const statusPill = (s) => `<span class="status ${esc(s)}" title="${s === "signed" ? "Publicly announced deal with some card issuer (not necessarily ours)" : ""}">${esc(STATUS_LABEL[s] || String(s || "").replace("_", " "))}</span>`;
  const byline = (e) => e ? `<div class="byline">
      <span>Curated by ${esc(e.curator || "Jackson Cummiskey")}</span><span>·</span><span>${fmtDate(e.generated, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span>
      ${(e.status || "draft") === "reviewed" ? `<span class="pill reviewed" title="Reviewed ${esc(fmtDate(e.reviewed_at))}">Reviewed</span>` : `<span class="pill draft" title="AI-drafted, not yet reviewed by the curator">Draft, awaiting review</span>`}
      <span class="pill internal" title="Internal team cut. Facts only before forwarding outside the team.">Internal cut</span>
    </div>` : "";

  // ---------- item card (same fields every time) ----------
  function itemHTML(i, { compact = false, hideCompanies = false } = {}) {
    const summary = i.summary_ai || (!i.take && i.why) || "";
    const take = i.take ? `<div class="item-take"><b>${i.take_kind === "read" ? "Read" : "Take"}</b>${esc(i.take)}</div>` : "";
    const chips = (i.data_points || []).slice(0, 4).map((d) => `<span class="dp">${esc(d)}</span>`).join("");
    const secs = (i.sections || []).map((s) => `<a class="chip" href="#/feed?s=${esc(s)}">${esc(sectionLabel(s))}</a>`).join("");
    const comps = hideCompanies ? "" : (i.companies || []).map((c) => `<a class="chip co" href="#/company/${slug(c)}">${esc(c)}</a>`).join("");
    const also = (i.also || []).length ? `<div class="also">Also covered by ${(i.also || []).slice(0, 4).map((a) => ext(a.url, esc(a.source))).join(", ")}</div>` : "";
    const via = i.source_type === "gnews" ? ` <span class="muted" title="Found through Google News search; link opens the story through Google News">via Google News</span>` : "";
    return `<li class="item">
      <div class="item-top">${i.breaking ? '<span class="badge breaking-b">Breaking</span>' : ""}${i.benefit_move ? `<span class="badge benefit">Benefit move${i.benefit_type ? ": " + esc(i.benefit_type) : ""}</span>` : ""}${relBars(i.relevance || 0)}<span>${esc(i.source)}${via}</span><span>·</span><span title="${esc(fullTs(i.published))}">${ago(i.published)}</span></div>
      <a class="item-title" href="${safeUrl(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
      ${summary ? `<div class="item-sum">${esc(summary)}</div>` : ""}
      ${take}
      ${i.partner ? `<div class="item-partner">Partner: <b>${esc(i.partner)}</b></div>` : ""}
      ${i.low_confidence ? `<div class="flag">Low confidence: ${esc(i.low_confidence)}</div>` : ""}
      ${chips ? `<div class="chips">${chips}</div>` : ""}
      ${compact ? "" : `<div class="tags">${secs}${comps}</div>${also}`}
    </li>`;
  }
  const itemList = (rows, opts) => rows.length ? `<ul class="items">${rows.map((i) => itemHTML(i, opts)).join("")}</ul>` : "";

  // ---------- tooltip + charts ----------
  const tip = document.getElementById("tip");
  function showTip(html, x, y) {
    tip.innerHTML = html; tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 12) + "px";
    tip.style.top = Math.max(8, y - r.height - 12) + "px";
  }
  const hideTip = () => (tip.hidden = true);
  function niceTicks(min, max, n = 4) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const fmtNum = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(0) + "K" : Math.abs(v) >= 100 ? v.toFixed(0) : (+v.toFixed(2)).toString();
  function lineChart(points, { height = 150, yLabel = "" } = {}) {
    if (points.length < 2) return "";
    const W = 340, H = height, L = 42, R = 8, T = 10, B = 22;
    const xs = points.map((p) => +p.x), ys = points.map((p) => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const sx = (v) => L + ((v - x0) / (x1 - x0 || 1)) * (W - L - R);
    const sy = (v) => T + (1 - (v - y0) / (y1 - y0 || 1)) * (H - T - B);
    const path = points.map((p, i) => `${i ? "L" : "M"}${sx(+p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join("");
    const grid = ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/>`).join("");
    const ylab = ticks.map((t) => `<text x="${L - 6}" y="${sy(t) + 3.5}" text-anchor="end">${fmtNum(t)}</text>`).join("");
    const first = new Date(x0), last = new Date(x1);
    const xlab = `<text x="${L}" y="${H - 5}">${first.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</text><text x="${W - R}" y="${H - 5}" text-anchor="end">${last.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</text>`;
    const ylabel = yLabel ? `<text x="${L - 6}" y="${T - 1}" text-anchor="end">${esc(yLabel)}</text>` : "";
    const lastP = points[points.length - 1];
    const id = "c" + Math.random().toString(36).slice(2, 8);
    requestAnimationFrame(() => {
      const el = document.getElementById(id); if (!el) return;
      const cross = el.querySelector(".cross"), hd = el.querySelector(".dot.hover"), hov = el.querySelector(".hov");
      const move = (ev) => {
        const e = ev.touches ? ev.touches[0] : ev, pt = el.createSVGPoint();
        pt.x = e.clientX; pt.y = e.clientY;
        const loc = pt.matrixTransform(el.getScreenCTM().inverse());
        let best = points[0], bd = Infinity;
        for (const p of points) { const d = Math.abs(sx(+p.x) - loc.x); if (d < bd) { bd = d; best = p; } }
        hov.style.display = "";
        cross.setAttribute("x1", sx(+best.x)); cross.setAttribute("x2", sx(+best.x));
        hd.setAttribute("cx", sx(+best.x)); hd.setAttribute("cy", sy(best.y));
        showTip(`<b>${esc(best.display ?? fmtNum(best.y))}</b><br>${esc(best.label)}`, e.clientX, e.clientY);
      };
      const leave = () => { hov.style.display = "none"; hideTip(); };
      el.addEventListener("mousemove", move); el.addEventListener("touchmove", move, { passive: true });
      el.addEventListener("mouseleave", leave); el.addEventListener("touchend", leave);
    });
    return `<svg class="chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">
      <g class="grid">${grid}</g><g class="axis">${ylab}${xlab}${ylabel}</g>
      <path class="line" d="${path}"/><circle class="dot" r="4" cx="${sx(+lastP.x)}" cy="${sy(lastP.y)}"/>
      <g class="hov" style="display:none"><line class="cross" y1="${T}" y2="${H - B}"/><circle class="dot hover" r="4.5"/></g>
      <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/></svg>`;
  }
  function direction(vals, lowerIsBetter = false) {
    if (vals.length < 2) return "";
    const [a, b] = vals.slice(-2);
    if (a === b) return `<span class="dir-flat">→ flat</span>`;
    const up = b > a, good = lowerIsBetter ? !up : up;
    return `<span class="${good ? "dir-up" : "dir-down"}">${up ? "▲" : "▼"} ${fmtNum(Math.abs(b - a))}</span>`;
  }

  // ---------- data ----------
  async function manifest() { if (!state.manifest) state.manifest = await get("manifest.json", { sections: [], months: [] }); return state.manifest; }
  async function feed() { if (!state.feed) state.feed = await get("feed.json", []); return state.feed; }
  const editions = () => get("digests/index.json", { entries: [] });
  async function loadOlder() {
    const m = await manifest(), f = await feed(), have = new Set(f.map((i) => i.id));
    for (const mo of (m.months || []).slice().reverse()) {
      if (state.olderLoaded.has(mo)) continue;
      state.olderLoaded.add(mo);
      const add = (await get(`items/${mo}.json`, [])).filter((i) => i.enriched && !have.has(i.id));
      if (add.length) { f.push(...add); return add.length; }
    }
    return 0;
  }
  // Extract a "## Part N" (or "### NYC") section from a briefing's markdown.
  function section(mdText, re, stopRe = /^##\s/m) {
    if (!mdText) return "";
    const m = mdText.match(re); if (!m) return "";
    const rest = mdText.slice(m.index + m[0].length);
    const stop = rest.search(stopRe);
    return (stop === -1 ? rest : rest.slice(0, stop)).replace(/\n---[\s\S]*$/, "").trim();
  }
  async function latestBriefing() {
    const idx = await editions();
    const e = idx.entries.find((x) => x.type === "monday");
    return e ? { e, body: await get(e.file, "", true) } : { e: null, body: "" };
  }
  function bookingStatus(e, today = todayISO()) {
    if (e.event_date && e.event_date < today && !(e.next_open && e.next_open >= today)) return "passed";
    if (e.next_open && e.next_open > today) return "soon";
    return "open";
  }
  const BOOK_LABEL = { open: "Open now", soon: "Opening soon", passed: "Passed" };

  // ---------- views ----------
  const views = {};

  views.today = async () => {
    const [m, f, idx, cal, bk, rx, brief] = await Promise.all([manifest(), feed(), editions(), get("living/calendar.json", { entries: [] }), get("living/booking.json", { entries: [] }), get("radar/index.json", { entries: [] }), latestBriefing()]);
    const now = Date.now();
    const recent72 = f.filter((i) => now - new Date(i.published) < 72 * 3600e3);
    const biggest = recent72.filter((i) => i.breaking).sort((a, b) => b.relevance - a.relevance || b.published.localeCompare(a.published))[0];
    const top = f.filter((i) => now - new Date(i.published) < 36 * 3600e3 && (i.relevance || 0) >= 4 && i !== biggest)
      .sort((a, b) => b.relevance - a.relevance || b.published.localeCompare(a.published)).slice(0, 8);
    const latest = idx.entries.find((x) => x.product === "briefing" || ["monday", "update", "daily"].includes(x.type));
    const latestBody = latest ? (latest.id === brief.e?.id ? brief.body : await get(latest.file, "", true)) : "";
    const play = section(brief.body, /^##\s*Part 3[^\n]*\n/m);
    const radarLatest = (rx.entries || [])[0];
    const today = todayISO(), week = addDays(today, 7);
    const next7 = [
      ...(cal.entries || []).filter((e) => e.date >= today && e.date <= week).map((e) => ({ date: e.date, title: e.title, url: e.url, meta: e.type + (e.confirmed === false ? ", est." : "") })),
      ...(bk.entries || []).filter((e) => e.event_date && e.event_date >= today && e.event_date <= week).map((e) => ({ date: e.event_date, title: e.name, url: e.url, meta: "event" })),
    ].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
    const opening = (bk.entries || []).filter((e) => e.next_open && e.next_open >= today && e.next_open <= addDays(today, 30)).sort((a, b) => a.next_open.localeCompare(b.next_open)).slice(0, 5);
    const last24 = f.filter((i) => now - new Date(i.fetched || i.published) < 24 * 3600e3).length;
    const high = f.filter((i) => now - new Date(i.published) < 24 * 3600e3 && (i.relevance || 0) >= 4).length;
    const st = m.last_sweep_stats || {};

    $app.innerHTML = `
      <div class="page-head"><div><div class="kicker">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div><h1>Today</h1><div class="rule"></div></div></div>
      ${biggest ? `<div class="breaking"><div class="kicker">Breaking · biggest item, last 72 hours</div>
        <a class="b-title" href="${safeUrl(biggest.url)}" target="_blank" rel="noopener">${esc(biggest.title)}</a>
        <div class="b-meta">${esc(biggest.source)} · <span title="${esc(fullTs(biggest.published))}">${ago(biggest.published)}</span> · ${relBars(biggest.relevance)}</div>
        ${biggest.summary_ai || biggest.why ? `<div class="b-sum">${esc(biggest.summary_ai || biggest.why)}</div>` : ""}
        ${biggest.take ? `<div class="item-take" style="margin-top:8px"><b>${biggest.take_kind === "read" ? "Read" : "Take"}</b>${esc(biggest.take)}</div>` : ""}</div>` : ""}
      <div class="stats">
        <div class="stat"><div class="kicker">Last 24h</div><div class="v">${last24}</div><div class="s">new items tracked</div></div>
        <div class="stat"><div class="kicker">High signal</div><div class="v">${high}</div><div class="s">relevance 4+ today</div></div>
        <div class="stat"><div class="kicker">Last sweep</div><div class="v">${m.last_sweep ? ago(m.last_sweep) : "n/a"}</div><div class="s">${st.sources ? `${st.sources_ok}/${st.sources} sources ok` : ""}</div></div>
      </div>
      <div class="grid cols-2">
        <div class="grid" style="align-content:start">
          <div class="card">
            ${latest ? `<div class="card-head"><div><div class="kicker">${esc(TYPE_LABEL[latest.type] || "Briefing")}</div><h2 style="margin-top:4px">${esc(latest.title)}</h2>${byline(latest)}</div><a href="#/digest/${esc(latest.id)}">Read full →</a></div>
              <div class="prose preview">${md(latest.type === "monday" ? latestBody.split(/^##\s/m)[0] + "\n\n## " + (latestBody.split(/^##\s/m)[1] || "") : latestBody)}</div>`
              : `<h2>Luxury Trends Briefing</h2>${empty("The first briefing appears after the Monday morning run.")}`}
          </div>
          ${play ? `<div class="play"><div class="card-head"><div class="kicker">Part 3 · One play to steal</div>${brief.e ? `<a href="#/digest/${esc(brief.e.id)}">From ${esc(fmtDate(brief.e.date))} briefing →</a>` : ""}</div><div class="prose">${md(play)}</div></div>` : ""}
          ${radarLatest ? `<div class="card"><div class="card-head"><div><div class="kicker">Partnership Sourcing Radar</div><h3 style="margin-top:4px">${(radarLatest.items || []).length} opportunit${(radarLatest.items || []).length === 1 ? "y" : "ies"} · ${esc(fmtDate(radarLatest.date))}</h3></div><a href="#/radar">Radar →</a></div>
            ${(radarLatest.items || []).slice(0, 3).map((r) => `<div class="cal-day" style="grid-template-columns:1fr"><div><b>${esc(r.company)}</b> <span class="muted">· ${esc(r.partner_type || "")}</span><div class="note">${esc(r.why_fit)}</div></div></div>`).join("") || `<p class="note">${esc(radarLatest.intro)}</p>`}</div>` : ""}
          <div class="card"><div class="card-head"><h2>Top signals</h2><a href="#/feed?rel=4&range=2">All high signal →</a></div>
            ${itemList(top) || `<p class="muted">No other relevance 4+ items in the last day and a half. <a href="#/feed">Browse the feed →</a></p>`}</div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>Next 7 days</h3><a href="#/spending">Earnings →</a></div>
            ${next7.length ? next7.map((e) => `<div class="cal-day"><div class="cal-date">${fmtDate(e.date, { weekday: "short" })}<b>${fmtDate(e.date)}</b></div><div>${e.url ? ext(e.url, esc(e.title)) : esc(e.title)} <div class="note">${esc(e.meta)}</div></div></div>`).join("") : `<p class="note">Nothing dated in the next 7 days yet. The calendar refreshes every Monday.</p>`}</div>
          <div class="card"><div class="card-head"><h3>Booking windows opening</h3><a href="#/booking">All →</a></div>
            ${opening.length ? opening.map((e) => `<div class="cal-day"><div class="cal-date">${fmtDate(e.next_open, { weekday: "short" })}<b>${fmtDate(e.next_open)}</b></div><div>${ext(e.url, esc(e.name))}<div class="note">${esc(e.window)}</div></div></div>`).join("") : `<p class="note">No dated windows in the next 30 days. See open and rolling windows on the Booking Windows page.</p>`}</div>
          <div class="card"><h3>How this works</h3><p class="note" style="margin:0">Sweeps run 3x a day across ${st.sources || "50+"} public sources. The Luxury Trends Briefing and Radar publish Mondays; Tuesday to Friday updates appear only when something genuinely new breaks. Every edition starts as a draft until the curator reviews it.</p></div>
        </div>
      </div>`;
  };

  views.luxury = async (params) => {
    const [f, brief] = await Promise.all([feed(), latestBriefing()]);
    const part2 = section(brief.body, /^##\s*Part 2[^\n]*\n/m);
    const part2NoNyc = part2.split(/^###\s*NYC/m)[0].trim();
    const sub = params.get("c") || "";
    const rows = f.filter((i) => (i.sections || []).includes("luxury") && (i.relevance || 0) >= 2 && (!sub || i.subcategory === sub))
      .sort((a, b) => b.relevance - a.relevance || b.published.localeCompare(a.published)).slice(0, 60);
    const counts = f.filter((i) => (i.sections || []).includes("luxury")).reduce((o, i) => ((o[i.subcategory || "other"] = (o[i.subcategory || "other"] || 0) + 1), o), {});
    $app.innerHTML = `<div class="editorial">
      <div class="page-head"><div><div class="kicker">Part 2 · Luxury Trends</div><h1>What affluent clients are buying, booking and talking about</h1>
        <p>Dining, entertainment, sporting, lifestyle, goods and retail, and travel, read for partnership and cardholder appeal.</p></div></div>
      ${part2NoNyc ? `<div class="card" style="margin-bottom:18px"><div class="card-head"><div class="kicker">From the ${esc(fmtDate(brief.e.date, { month: "long", day: "numeric" }))} briefing</div><a href="#/digest/${esc(brief.e.id)}">Full briefing →</a></div>${byline(brief.e)}<div class="prose" style="margin-top:10px">${md(part2NoNyc)}</div></div>` : ""}
      <div class="filter-row" id="lc" style="margin-bottom:14px"><a class="chip ${sub ? "" : "on"}" href="#/luxury">All</a>${Object.entries(SUBCAT).map(([k, v]) => `<a class="chip ${sub === k ? "on" : ""}" href="#/luxury?c=${k}">${v}${counts[k] ? ` · ${counts[k]}` : ""}</a>`).join("")}<a class="chip" href="#/nyc">NYC Dining →</a></div>
      ${rows.length ? `<div class="lux-grid">${rows.map((i) => `<div class="lux-card"><div class="kind">${esc(SUBCAT[i.subcategory] || "Luxury")}</div><ul class="items">${itemHTML(i, { compact: false })}</ul></div>`).join("")}</div>`
        : empty(sub ? `No ${esc(SUBCAT[sub])} items in the loaded window yet.` : "Luxury items appear as sweeps tag them.")}
    </div>`;
  };

  views.nyc = async () => {
    const [f, brief, bk] = await Promise.all([feed(), latestBriefing(), get("living/booking.json", { entries: [] })]);
    const nycPart = section(brief.body, /^###\s*NYC[^\n]*\n/m, /^#{2,3}\s/m);
    const rows = f.filter((i) => (i.sections || []).includes("nyc_dining")).sort((a, b) => b.published.localeCompare(a.published)).slice(0, 60);
    const nycBook = (bk.entries || []).filter((e) => e.type === "restaurant" && /new york|nyc|manhattan|brooklyn/i.test(e.location || "") && bookingStatus(e) !== "passed");
    const kinds = rows.reduce((o, i) => ((o[i.nyc?.kind || "other"] = (o[i.nyc?.kind || "other"] || 0) + 1), o), {});
    $app.innerHTML = `<div class="editorial">
      <div class="page-head"><div><div class="kicker">Part 2 · NYC Dining</div><h1>New York tables, openings and reservation intel</h1>
        <p>Openings and closings, chef moves, hard-to-book tables, release windows and walk-in strategy.</p></div></div>
      <div class="grid cols-2">
        <div class="grid" style="align-content:start">
          ${nycPart ? `<div class="card"><div class="card-head"><div class="kicker">From the ${esc(fmtDate(brief.e.date, { month: "long", day: "numeric" }))} briefing</div><a href="#/digest/${esc(brief.e.id)}">Full briefing →</a></div>${byline(brief.e)}<div class="prose" style="margin-top:10px">${md(nycPart)}</div></div>`
            : `<div class="card">${empty("The NYC subsection appears with the next Monday briefing.")}</div>`}
          <div class="card"><div class="card-head"><h2>Latest NYC dining items</h2><span class="count">${rows.length}</span></div>
            ${rows.length ? `<ul class="items">${rows.map((i) => `<li class="item"><div class="venue">
                <div class="v-meta"><span class="kind">${esc(NYC_KIND[i.nyc?.kind] || "NYC dining")}</span>${i.nyc?.neighborhood ? `<span>${esc(i.nyc.neighborhood)}</span>` : ""}${relBars(i.relevance || 0)}<span>${esc(i.source)} · <span title="${esc(fullTs(i.published))}">${ago(i.published)}</span></span></div>
                ${i.nyc?.venue ? `<div class="v-name">${esc(i.nyc.venue)}</div>` : ""}
                <a class="item-title" href="${safeUrl(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
                ${i.summary_ai ? `<div class="item-sum">${esc(i.summary_ai)}</div>` : ""}
                ${i.nyc?.booking ? `<div class="booking-line"><b>How it books:</b> ${esc(i.nyc.booking)}</div>` : ""}
                ${i.take ? `<div class="item-take"><b>${i.take_kind === "read" ? "Read" : "Take"}</b>${esc(i.take)}</div>` : ""}
                ${i.low_confidence ? `<div class="flag">Low confidence: ${esc(i.low_confidence)}</div>` : ""}
                ${(i.data_points || []).length ? `<div class="chips">${i.data_points.slice(0, 4).map((d) => `<span class="dp">${esc(d)}</span>`).join("")}</div>` : ""}
              </div></li>`).join("")}</ul>` : empty("NYC dining items appear as sweeps tag them (Eater NY and NYC queries feed this page).")}
          </div>
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>NYC booking windows</h3><a href="#/booking?t=restaurant">All →</a></div>
            ${nycBook.length ? nycBook.map((e) => `<div class="cal-day"><div class="cal-date">${e.next_open ? fmtDate(e.next_open, { weekday: "short" }) + `<b>${fmtDate(e.next_open)}</b>` : "<b>Open</b>"}</div><div>${ext(e.url, esc(e.name))}<div class="note">${esc(e.cadence || e.window)}</div></div></div>`).join("") : `<p class="note">No NYC restaurant windows tracked yet. They refresh every Monday.</p>`}</div>
          <div class="card"><h3>This week by type</h3>${Object.keys(kinds).length ? Object.entries(kinds).map(([k, v]) => `<div class="filter-row" style="justify-content:space-between;padding:4px 0"><span>${esc(NYC_KIND[k] || k)}</span><span class="mono">${v}</span></div>`).join("") : `<p class="note">Nothing yet.</p>`}</div>
        </div>
      </div></div>`;
  };

  views.booking = async (params) => {
    const bk = await get("living/booking.json", { entries: [] });
    const today = todayISO(), horizon = addDays(today, 30);
    const all = (bk.entries || []).map((e) => ({ ...e, status: bookingStatus(e, today) })).filter((e) => e.status !== "passed");
    let t = params.get("t") || "", s = params.get("s") || "", view = params.get("v") || "timeline";
    const icon = { restaurant: "Restaurant", hotel: "Hotel", event: "Event" };
    const draw = () => {
      const rows = all.filter((e) => (!t || e.type === t) && (!s || e.status === s));
      const dated = rows.map((e) => ({ e, d: e.next_open && e.next_open >= today ? e.next_open : e.event_date })).filter((x) => x.d && x.d >= today && x.d <= horizon).sort((a, b) => a.d.localeCompare(b.d));
      const byDay = dated.reduce((o, x) => ((o[x.d] = o[x.d] || []).push(x), o), {});
      const rolling = rows.filter((e) => !dated.some((x) => x.e === e));
      document.getElementById("bk-body").innerHTML = view === "timeline"
        ? `<div class="card"><div class="card-head"><h3>Next 30 days</h3><span class="count">${dated.length} dated</span></div>
            ${dated.length ? `<div class="timeline">${Object.entries(byDay).map(([d, xs]) => `<div class="tl-day"><div class="tl-date">${fmtDate(d, { weekday: "short" })}<b>${fmtDate(d)}</b></div><div class="tl-entries">${xs.map(({ e }) => `<div class="tl-e"><div><span class="n">${ext(e.url, esc(e.name))}</span> ${statusPill(e.status === "soon" ? "soon" : "open")} <span class="note">${esc(icon[e.type] || e.type)}${e.location ? " · " + esc(e.location) : ""}</span></div><div class="note">${e.next_open === d ? "Window opens. " : "Event date. "}${esc(e.window || "")}</div></div>`).join("")}</div></div>`).join("")}</div>` : `<p class="note">No dated windows in the next 30 days.</p>`}
          </div>
          <h3>Open now and rolling</h3>${rolling.length ? table(rolling) : `<p class="note">None.</p>`}`
        : table(rows);
    };
    const table = (rows) => `<div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Name</th><th data-k="1">Status</th><th>What is bookable and how</th><th data-k="3">Window opens</th><th data-k="4">Event date</th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td>${ext(e.url, `<b>${esc(e.name)}</b>`)}<div class="note">${esc(icon[e.type] || e.type)}${e.location ? " · " + esc(e.location) : ""}</div></td><td data-v="${e.status}">${statusPill(e.status)}<div class="note">${BOOK_LABEL[e.status]}</div></td>
        <td>${esc(e.window)}${e.cadence ? `<div class="note">Release cadence: ${esc(e.cadence)}</div>` : ""}${e.note ? `<div class="note">Tip: ${esc(e.note)}</div>` : ""}</td>
        <td class="num" data-v="${esc(e.next_open || "")}">${e.next_open ? fmtDate(e.next_open) : "rolling"}</td><td class="num" data-v="${esc(e.event_date || "")}">${e.event_date ? fmtDate(e.event_date) : ""}</td></tr>`).join("")}</tbody></table></div>`;
    $app.innerHTML = `<div class="page-head"><div><div class="kicker">Part 4 · Booking Windows</div><h1>Booking Windows</h1><div class="rule"></div>
        <p>What affluent clients can book now and when the next windows open: hard-to-book restaurants with release cadence, hotel openings, and events. Passed windows drop off automatically.</p>
        <div class="fed">Refreshed every Monday with web search${bk.updated ? ` · last refresh ${fmtDate(bk.updated, { month: "short", day: "numeric" })}` : ""}</div></div></div>
      ${all.length ? `<div class="filter-row" style="margin-bottom:14px">
        <div class="seg" id="bv"><button data-v="timeline" class="${view === "timeline" ? "on" : ""}">Timeline</button><button data-v="list" class="${view === "list" ? "on" : ""}">List</button></div>
        <div class="seg" id="bt"><button data-t="" class="${!t ? "on" : ""}">All</button><button data-t="restaurant" class="${t === "restaurant" ? "on" : ""}">Restaurants</button><button data-t="hotel" class="${t === "hotel" ? "on" : ""}">Hotels</button><button data-t="event" class="${t === "event" ? "on" : ""}">Events</button></div>
        <div class="seg" id="bs"><button data-s="" class="${!s ? "on" : ""}">Any status</button><button data-s="open" class="${s === "open" ? "on" : ""}">Open now</button><button data-s="soon" class="${s === "soon" ? "on" : ""}">Opening soon</button></div>
      </div><div id="bk-body"></div>` : empty("<b>No booking windows yet.</b> The Monday refresh fills this from web search. If it stays empty after a Monday run, the feed behind it failed; check Sources &amp; usage.")}`;
    if (!all.length) return;
    const wire = (id, key, set) => document.getElementById(id).addEventListener("click", (ev) => {
      const b = ev.target.closest("button"); if (!b) return;
      set(b.dataset[key]); document.querySelectorAll(`#${id} button`).forEach((x) => x.classList.toggle("on", x === b)); draw();
      const t2 = document.getElementById("t"); if (t2) sortableTable(t2);
    });
    wire("bv", "v", (v) => (view = v)); wire("bt", "t", (v) => (t = v)); wire("bs", "s", (v) => (s = v));
    draw(); const t1 = document.getElementById("t"); if (t1) sortableTable(t1);
  };

  views.spending = async () => {
    const [dash, fred, cal] = await Promise.all([get("living/dashboard.json", { indicators: [] }), get("fred.json", { series: [] }), get("living/calendar.json", { entries: [] })]);
    const groups = [
      { id: "spend", title: "US luxury card spend", note: "Citi data when fresh" },
      { id: "real_estate", title: "Manhattan $4M+ contracts", note: "Olshan weekly luxury report" },
      { id: "auction", title: "Auctions", note: "Sell-through and headline lots" },
      { id: "earnings", title: "Luxury earnings", note: "LVMH, Hermes, Kering, Richemont" },
    ];
    const inds = dash.indicators || [];
    const card = (d) => {
      const r = d.readings || [], num = r.filter((x) => typeof x.value === "number"), last = r[r.length - 1], prev = r[r.length - 2];
      if (d.unit === "text") {
        return `<div class="card chart-card"><h3>${esc(d.label)}</h3>${r.length ? `<ul class="history" style="padding-left:16px">${r.slice(-6).reverse().map((x) => `<li><b>${esc(x.display)}</b> <span class="note">${esc(x.period)}${x.date ? " · " + fmtDate(x.date) : ""}</span> ${x.url ? ext(x.url, "source") : ""}</li>`).join("")}</ul>` : `<p class="note">No headline lots recorded yet.</p>`}</div>`;
      }
      const pts = num.map((x) => ({ x: new Date((x.date || x.period) + (String(x.date || "").length === 10 ? "T12:00:00" : "")), y: x.value, label: x.period, display: x.display })).filter((p) => !isNaN(p.x));
      return `<div class="card chart-card"><h3>${esc(d.label)}</h3>
        ${last ? `<div class="latest"><b>${esc(last.display || fmtNum(last.value))}</b><span class="muted">${esc(last.period)}${last.date ? " · " + fmtDate(last.date) : ""}</span>${direction(num.map((x) => x.value))}</div>
          <div class="prior">${prev ? `Prior: ${esc(prev.display || fmtNum(prev.value))} (${esc(prev.period)})` : `<span class="first">First reading, no trend yet</span>`}</div>` : `<p class="note">No reading yet. Refreshed every Monday.</p>`}
        ${lineChart(pts, { yLabel: d.unit })}
        ${last ? `<div class="note">${esc(last.note || "")} ${last.url ? ext(last.url, "source") : ""}</div>` : ""}
      </div>`;
    };
    const lowerBetter = new Set(["DRCCLACBS", "CORCCACBS", "TERMCBCCALLNS"]);
    const fr = (fred.series || []).map((s) => {
      const pts = (s.points || []).map(([d, v]) => ({ x: new Date(d + "T12:00:00"), y: v, label: fmtDate(d, { month: "short", year: "numeric" }) }));
      const last = pts[pts.length - 1], prev = pts[pts.length - 2];
      const recent = pts.filter((p) => p.x >= new Date(Date.now() - 6 * 365 * 864e5));
      return `<div class="card chart-card"><h3>${esc(s.label)}</h3>
        ${last ? `<div class="latest"><b>${fmtNum(last.y)}</b><span class="muted">${esc(s.unit)} · ${esc(last.label)}</span>${direction(pts.map((p) => p.y), lowerBetter.has(s.id))}</div><div class="prior">${prev ? `Prior: ${fmtNum(prev.y)} (${esc(prev.label)})` : ""}</div>` : `<p class="note">No data yet.</p>`}
        ${lineChart(recent, { yLabel: s.unit })}<div class="note">FRED ${ext(`https://fred.stlouisfed.org/series/${s.id}`, esc(s.id))}${s.ok === false ? " · last refresh failed" : ""}</div></div>`;
    }).join("");
    const today = todayISO();
    const earn = (cal.entries || []).filter((e) => e.type === "earnings" && e.date >= addDays(today, -14)).sort((a, b) => a.date.localeCompare(b.date));
    $app.innerHTML = `<div class="page-head"><div><div class="kicker">Part 5 · Spending Dashboard</div><h1>Luxury Spending Dashboard</h1><div class="rule"></div>
        <p>The same indicators week to week so the trend is visible: current reading, prior reading, direction and date. A series with one reading is labeled as such; no trend is drawn from invented history.</p>
        <div class="fed">Luxury readings refreshed every Monday${dash.updated ? ` · last ${fmtDate(dash.updated)}` : ""}. FRED refreshed daily.</div></div></div>
      ${groups.map((g) => { const ds = inds.filter((d) => d.group === g.id); return `<h2>${esc(g.title)} <span class="note" style="font-family:var(--sans);font-weight:400">· ${esc(g.note)}</span></h2><div class="charts">${ds.length ? ds.map(card).join("") : empty("No indicator configured.")}</div>`; }).join("")}
      <h2>Earnings calendar</h2><div class="card">${earn.length ? earn.map((e) => `<div class="cal-day"><div class="cal-date">${fmtDate(e.date, { weekday: "short" })}<b>${fmtDate(e.date)}</b></div><div>${e.url ? ext(e.url, esc(e.title)) : esc(e.title)}<div class="note">${e.company ? `<a href="#/company/${slug(e.company)}">${esc(e.company)}</a>` : ""}${e.confirmed === false ? " · estimated" : ""}${e.date < today ? (e.recapped ? " · recap in Archive" : " · reported") : ""}</div></div></div>`).join("") : `<p class="note">No earnings dates in the next six weeks yet. The calendar refreshes every Monday.</p>`}</div>
      <h2>Consumer credit context <span class="note" style="font-family:var(--sans);font-weight:400">· FRED</span></h2><div class="charts">${fr || empty("FRED data loads on the next sweep.")}</div>`;
  };

  views.radar = async () => {
    const rx = await get("radar/index.json", { entries: [] });
    const weekly = (rx.entries || []).find((e) => e.kind === "weekly");
    const updates = (rx.entries || []).filter((e) => e.kind === "update" && (!weekly || e.generated > weekly.generated));
    const older = (rx.entries || []).filter((e) => e !== weekly && !updates.includes(e)).slice(0, 8);
    const item = (r) => `<div class="radar-item"><div class="co"><a href="#/company/${slug(r.company)}" style="color:inherit">${esc(r.company)}</a> <span class="kind" style="font-size:10px">${esc(r.partner_type || "")}</span></div>
      <div class="row">${esc(r.what)}</div>
      <div class="row"><b>Signal:</b> ${esc(r.signal)}</div>
      <div class="row"><b>Why it fits:</b> ${esc(r.why_fit)}</div>
      ${r.angle ? `<div class="row"><b>Angle:</b> ${esc(r.angle)}</div>` : ""}
      <div class="item-top">${r.relevance ? relBars(r.relevance) : ""}${ext(r.url, esc(r.source || "Source"))}${r.published ? `<span>· ${ago(r.published)}</span>` : ""}
        <a class="chip co" href="${esc(watchUrl(r.company, "", r.why_fit || ""))}" target="_blank" rel="noopener">+ Watchlist</a>
        <a class="chip co" href="${esc(vetUrl(r.company))}" target="_blank" rel="noopener">Vet</a></div></div>`;
    $app.innerHTML = `<div class="page-head"><div><div class="kicker">Partnership Sourcing Radar</div><h1>Radar</h1><div class="rule"></div>
        <p>Qualified card-benefit and loyalty partner opportunities. Capped at about eight on Monday; Tuesday to Friday breakouts only when something major breaks. Fewer is better than weak fits.</p></div></div>
      ${updates.length ? `<h2>Breakouts since Monday</h2>${updates.map((u) => `<div class="card" style="margin-bottom:12px"><div class="kicker">${esc(fmtDate(u.date, { weekday: "long", month: "short", day: "numeric" }))}</div>${u.intro ? `<p>${esc(u.intro)}</p>` : ""}<div class="radar-list">${u.items.map(item).join("")}</div></div>`).join("")}` : ""}
      ${weekly ? `<div class="card-head" style="margin-top:6px"><h2 style="margin:0">Week of ${esc(fmtDate(weekly.date, { month: "long", day: "numeric" }))}</h2><a href="#/digest/${esc(weekly.digest_id)}">Edition →</a></div>
        <p class="note">${esc(weekly.intro)}</p>
        ${weekly.items.length ? `<div class="radar-list">${weekly.items.map(item).join("")}</div>` : empty("Nothing cleared the bar this week.")}`
        : empty("<b>The first Radar publishes with the Monday briefing.</b>")}
      ${older.length ? `<h2>Earlier</h2><div class="card">${older.map((o) => `<details style="padding:6px 0"><summary>${esc(fmtDate(o.date, { month: "short", day: "numeric" }))} · ${o.kind === "weekly" ? "Weekly" : "Breakout"} · ${o.items.length} items</summary><div class="radar-list" style="margin-top:10px">${o.items.map(item).join("")}</div></details>`).join("")}</div>` : ""}`;
  };

  function sortableTable(el) {
    el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
      const tbody = el.querySelector("tbody"), k = +th.dataset.k, dir = th.dataset.dir === "asc" ? "desc" : "asc";
      el.querySelectorAll("th").forEach((x) => delete x.dataset.dir); th.dataset.dir = dir;
      [...tbody.rows].sort((a, b) => { const x = a.cells[k]?.dataset.v ?? a.cells[k]?.textContent ?? "", y = b.cells[k]?.dataset.v ?? b.cells[k]?.textContent ?? ""; return (dir === "asc" ? 1 : -1) * x.localeCompare(y, undefined, { numeric: true }); }).forEach((r) => tbody.appendChild(r));
    }));
  }
  function downloadCSV(name, rows) {
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }

  views.watchlist = async () => {
    const [wl, co] = await Promise.all([get("living/watchlist.json", { entries: [] }), get("companies.json", { companies: [] })]);
    const cIdx = Object.fromEntries((co.companies || []).map((c) => [c.name.toLowerCase(), c]));
    const order = { acquired: 0, signed: 1, rumored: 2, in_talks: 2, emerging: 3, dropped: 9 };
    const rows = (wl.entries || []).map((e) => ({ ...e, c: cIdx[e.name.toLowerCase()] || {} }));
    const counts = rows.reduce((o, e) => ((o[e.status] = (o[e.status] || 0) + 1), o), {});
    $app.innerHTML = `<div class="page-head"><div><div class="kicker">Part 6 · Shared Watchlist</div><h1>Partnership Watchlist</h1><div class="rule"></div>
        <p>Brands, venues and platforms flagged as potential card-benefit partners, carried forward with dated history. Statuses reflect public reporting only.</p></div>
        <div class="filter-row"><a class="btn" href="${esc(watchUrl(""))}" target="_blank" rel="noopener">Propose an add</a><button class="btn ghost" id="csv">Export CSV</button></div></div>
      <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr))">${["emerging", "rumored", "signed", "acquired"].map((s) => `<div class="stat"><div class="kicker">${esc(STATUS_LABEL[s] || s)}</div><div class="v">${counts[s] || 0}</div></div>`).join("")}</div>
      ${rows.length ? `<div class="filter-row" style="margin-bottom:12px"><input type="search" id="wq" placeholder="Search the watchlist"><select id="ws"><option value="">All statuses</option><option value="emerging">emerging</option><option value="rumored">in talks / rumored</option><option value="signed">has issuer deal</option><option>acquired</option><option>dropped</option></select></div>
      <div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Brand or venue</th><th data-k="1">Status</th><th>Why it matters</th><th data-k="3">Items</th><th data-k="4">Last seen</th><th data-k="5">Top rel.</th><th data-k="6">Updated</th></tr></thead><tbody>
      ${rows.sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || (b.updated || "").localeCompare(a.updated || "")).map((e) => `<tr data-name="${esc(e.name.toLowerCase())}" data-status="${esc(e.status)}">
        <td><a href="#/company/${esc(e.slug || slug(e.name))}"><b>${esc(e.name)}</b></a><div class="note">${esc(e.what || e.category || "")}</div>${e.added_by ? `<div class="note">Added by ${esc(e.added_by)}</div>` : ""}</td>
        <td data-v="${order[e.status] ?? 5}">${statusPill(e.status)}</td>
        <td>${esc(e.why_fit || "")}<details><summary>History (${(e.history || []).length})</summary><ul class="history">${(e.history || []).slice().reverse().map((h) => `<li>${fmtDate(h.date)} · ${esc(h.status)}: ${esc(h.note)} ${h.url ? ext(h.url, "source") : ""}</li>`).join("")}</ul></details></td>
        <td class="num" data-v="${e.c.count || 0}">${e.c.count || 0}</td><td class="num" data-v="${esc(e.c.last_seen || "")}">${e.c.last_seen ? ago(e.c.last_seen) : "n/a"}</td>
        <td class="num" data-v="${e.c.top_relevance || 0}">${e.c.top_relevance ? e.c.top_relevance + "/5" : ""}</td><td class="num" data-v="${esc(e.updated)}">${fmtDate(e.updated)}</td></tr>`).join("")}</tbody></table></div>
      <p class="note">Anyone on the team can propose an add (opens a short GitHub request). Status changes come from the weekly refresh and only reflect what has been publicly reported.</p>`
      : empty("The watchlist fills in after the first Monday run.")}`;
    const t = document.getElementById("t"); if (t) sortableTable(t);
    const filter = () => {
      const q = (document.getElementById("wq")?.value || "").toLowerCase(), s = document.getElementById("ws")?.value || "";
      document.querySelectorAll("#t tbody tr").forEach((r) => (r.hidden = (q && !r.dataset.name.includes(q)) || (s && r.dataset.status !== s)));
    };
    document.getElementById("wq")?.addEventListener("input", filter);
    document.getElementById("ws")?.addEventListener("change", filter);
    document.getElementById("csv").addEventListener("click", () => downloadCSV(`watchlist-${todayISO()}.csv`, [["Name", "Status", "Category", "What", "Why it fits", "Added by", "Added", "Updated", "Items", "Last seen", "Latest note", "Latest source"],
      ...rows.map((e) => { const h = (e.history || [])[e.history.length - 1] || {}; return [e.name, e.status, e.category, e.what, e.why_fit, e.added_by, e.added, e.updated, e.c.count || 0, e.c.last_seen || "", h.note, h.url]; })]));
  };

  views.diligence = async () => {
    const idx = await get("vet/index.json", { entries: [] });
    const done = idx.entries || [];
    $app.innerHTML = `<div class="page-head"><div><div class="kicker">Diligence Desk</div><h1>Diligence</h1><div class="rule"></div>
        <p>On-demand partner vetting for anyone on the team: business model, funding, leadership, recent news, red flags, then a clearly separated fit assessment. Research and drafting only: no outreach, negotiation or messaging on anyone's behalf.</p></div></div>
      <div class="grid cols-2">
        <div class="card"><h3>Request a brief</h3>
          <div class="filter-row"><label class="f">Company<input type="text" id="vn" placeholder="e.g. Dorsia"></label><label class="f">Requested by<input type="text" id="vb" placeholder="Name"></label></div>
          <label class="f" style="margin-top:10px">Optional context or questions<textarea id="vc" placeholder="What should the brief focus on? Never include confidential deal details."></textarea></label>
          <div id="dup" class="note" style="margin:8px 0"></div>
          <div class="filter-row"><a class="btn" id="vgo" href="${esc(vetUrl(""))}" target="_blank" rel="noopener">Submit request</a><span class="note">Opens a prefilled GitHub request; the brief appears here in a few minutes. Searches stay generic.</span></div>
        </div>
        <div class="card"><h3>How the cuts work</h3><p class="note" style="margin:0"><b>Facts only</b> (default): Part A, shareable with a wider work audience, no recommendations.<br><b>Internal</b>: adds Part B, the fit assessment, for the team only. Always check the exact text before anything is sent on.</p></div>
      </div>
      <h2>Completed requests</h2>
      ${done.length ? `<div class="filter-row" style="margin-bottom:10px"><input type="search" id="dq" placeholder="Search completed briefs before requesting a new one"></div>
        <div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Company</th><th data-k="1">Requested by</th><th data-k="2">Date</th><th>Context</th></tr></thead><tbody>
        ${done.map((v) => `<tr data-q="${esc((v.company + " " + (v.requested_by || "") + " " + (v.context || "")).toLowerCase())}"><td><a href="#/vet/${esc(v.id)}"><b>${esc(v.company)}</b></a></td><td>${esc(v.requested_by || "")}</td><td class="num" data-v="${esc(v.date)}">${fmtDate(v.date, { month: "short", day: "numeric", year: "numeric" })}</td><td class="note">${esc(v.context || "")}</td></tr>`).join("")}</tbody></table></div>`
        : empty("No briefs yet. Request one above.")}`;
    const vn = document.getElementById("vn"), vb = document.getElementById("vb"), vc = document.getElementById("vc"), vgo = document.getElementById("vgo"), dup = document.getElementById("dup");
    const upd = () => {
      vgo.href = vetUrl(vn.value.trim(), vb.value.trim(), vc.value.trim().replace(/\n/g, " "));
      const hit = done.find((v) => vn.value.trim() && v.company.toLowerCase() === vn.value.trim().toLowerCase());
      dup.innerHTML = hit ? `Already vetted on ${fmtDate(hit.date, { month: "short", day: "numeric" })}: <a href="#/vet/${esc(hit.id)}">open the brief</a> before requesting again.` : "";
    };
    [vn, vb, vc].forEach((el) => el.addEventListener("input", upd));
    document.getElementById("dq")?.addEventListener("input", (e) => { const q = e.target.value.toLowerCase(); document.querySelectorAll("#t tbody tr").forEach((r) => (r.hidden = q && !r.dataset.q.includes(q))); });
    const t = document.getElementById("t"); if (t) sortableTable(t);
  };

  views.vet = async (params, id) => {
    const idx = await get("vet/index.json", { entries: [] });
    const v = idx.entries.find((x) => x.id === id);
    if (!v) { $app.innerHTML = empty("Brief not found."); return; }
    const body = await get(v.file, "", true);
    const cut = body.search(/^#\s*Part B/m);
    const srcIdx = body.search(/\n---\s*\n\s*\*\*Sources\*\*/);
    const sources = srcIdx > -1 ? body.slice(srcIdx) : "";
    const partA = (cut > -1 ? body.slice(0, cut) : (srcIdx > -1 ? body.slice(0, srcIdx) : body)).trim() + (sources ? "\n" + sources : "");
    let mode = "facts";
    $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/diligence">← Diligence</a></div><h1>${esc(v.company)}</h1>
        <div class="byline"><span>Requested by ${esc(v.requested_by || "team")}</span><span>·</span><span>${fmtDate(v.date, { month: "long", day: "numeric", year: "numeric" })}</span><span>·</span><a href="#/company/${esc(v.slug)}">Coverage timeline</a></div>
        ${v.context ? `<p class="note">Context: ${esc(v.context)}</p>` : ""}</div>
      <div class="filter-row"><div class="seg" id="cut"><button data-m="facts" class="on">Facts only</button><button data-m="internal">Internal (with fit)</button></div>
        <button class="btn ghost small" id="copy">Copy shown text</button>
        <a class="btn ghost small" href="${esc(watchUrl(v.company, v.requested_by || "", "From Diligence brief " + v.date))}" target="_blank" rel="noopener">+ Watchlist</a></div></div>
      <div class="note" id="cutnote" style="margin-bottom:10px"></div>
      <article class="card prose" id="vb"></article>
      <p class="disclaimer">AI-generated from public sources. Verify before acting. Research and drafting only.</p>`;
    const draw = () => {
      document.getElementById("vb").innerHTML = md(mode === "facts" ? partA : body);
      document.getElementById("cutnote").textContent = mode === "facts" ? "Facts-only cut: safe to share with a wider work audience after you check the text." : "Internal cut: includes the fit assessment. Team only; do not forward outside the team.";
    };
    document.getElementById("cut").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (!b) return; mode = b.dataset.m; document.querySelectorAll("#cut button").forEach((x) => x.classList.toggle("on", x === b)); draw(); });
    document.getElementById("copy").addEventListener("click", async (ev) => { try { await navigator.clipboard.writeText(mode === "facts" ? partA : body); ev.target.textContent = "Copied"; } catch { ev.target.textContent = "Copy failed"; } });
    draw();
  };

  views.feed = async (params) => {
    const tab = params.get("tab") || "feed";
    const tabs = `<div class="tabs"><a href="#/feed" class="${tab === "feed" ? "on" : ""}">Feed</a><a href="#/feed?tab=archive" class="${tab === "archive" ? "on" : ""}">Archive</a><a href="#/feed?tab=benefits" class="${tab === "benefits" ? "on" : ""}">Benefit moves</a></div>`;
    const head = `<div class="page-head"><div><div class="kicker">All items and editions</div><h1>Feed / Archive</h1><div class="rule"></div></div></div>${tabs}`;
    if (tab === "archive") return archive(head);
    if (tab === "benefits") return benefits(head, params);
    const [m, f] = await Promise.all([manifest(), feed()]);
    const st = { q: params.get("q") || "", s: params.get("s") || "", rel: +(params.get("rel") || 2), src: params.get("src") || "", range: params.get("range") || "7", sort: params.get("sort") || "new", co: params.get("co") || "" };
    const sources = [...new Set(f.map((i) => i.source))].sort();
    $app.innerHTML = `${head}
      <div class="filters">
        <div class="filter-row">
          <input type="search" id="q" placeholder="Search headlines, companies, partners, takes" value="${esc(st.q)}">
          <select id="range"><option value="1">24 hours</option><option value="2">48 hours</option><option value="7">7 days</option><option value="30">30 days</option><option value="all">Everything loaded</option></select>
          <select id="sort"><option value="new">Newest</option><option value="rel">Most relevant</option></select>
          <select id="src"><option value="">All sources</option>${sources.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
        </div>
        <div class="filter-row"><span class="note">Relevance</span><div class="seg" id="rel">${[[1, "All"], [2, "2+"], [3, "3+"], [4, "4+ high signal"], [5, "5"]].map(([v, l]) => `<button data-r="${v}" class="${st.rel === v ? "on" : ""}">${l}</button>`).join("")}</div></div>
        <div class="filter-row" id="secs"><span class="chip ${st.s ? "" : "on"}" data-s="">All</span>${(m.sections || []).map((s) => `<span class="chip ${st.s === s.id ? "on" : ""}" data-s="${esc(s.id)}">${esc(s.label)}</span>`).join("")}<span class="chip ${st.s === "_low" ? "on" : ""}" data-s="_low">Low confidence</span></div>
      </div>
      <div class="filter-row" style="justify-content:space-between;margin:6px 0"><span class="count" id="count"></span><span class="note">Summaries and tags are AI-generated, verify before acting.</span></div>
      <div class="card"><ul class="items" id="list"></ul></div>
      <p style="text-align:center"><button class="btn ghost" id="more">Load older months</button></p>`;
    const $ = (id) => document.getElementById(id);
    $("range").value = st.range; $("sort").value = st.sort; $("src").value = st.src;
    const draw = () => {
      const q = st.q.toLowerCase(), cutoff = st.range === "all" ? 0 : Date.now() - +st.range * 864e5;
      let rows = f.filter((i) => (i.relevance || 0) >= st.rel && (!st.s || (st.s === "_low" ? i.low_confidence : (i.sections || []).includes(st.s))) && (!st.src || i.source === st.src) && new Date(i.published) >= cutoff && (!st.co || (i.companies || []).some((c) => slug(c) === st.co)));
      if (q) rows = rows.filter((i) => [i.title, i.summary_ai, i.take, i.why, i.partner, i.source, ...(i.companies || []), ...(i.data_points || [])].join(" ").toLowerCase().includes(q));
      rows.sort(st.sort === "rel" ? (a, b) => b.relevance - a.relevance || b.published.localeCompare(a.published) : (a, b) => b.published.localeCompare(a.published));
      $("count").textContent = `${rows.length} item${rows.length === 1 ? "" : "s"}`;
      $("list").innerHTML = rows.length ? rows.slice(0, 300).map((i) => itemHTML(i)).join("") : `<li>${empty("No items match these filters.")}</li>`;
      const p = new URLSearchParams();
      Object.entries(st).forEach(([k, v]) => { if (v && !(k === "rel" && v === 2) && !(k === "range" && v === "7") && !(k === "sort" && v === "new")) p.set(k, v); });
      history.replaceState(null, "", "#/feed" + (p.toString() ? "?" + p : ""));
    };
    let t;
    $("q").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; draw(); }, 150); });
    ["range", "sort", "src"].forEach((k) => $(k).addEventListener("change", (e) => { st[k] = e.target.value; draw(); }));
    $("rel").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; st.rel = +b.dataset.r; document.querySelectorAll("#rel button").forEach((x) => x.classList.toggle("on", x === b)); draw(); });
    $("secs").addEventListener("click", (e) => { const c = e.target.closest("[data-s]"); if (!c) return; st.s = c.dataset.s; $("secs").querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === c)); draw(); });
    $("more").addEventListener("click", async () => { const n = await loadOlder(); st.range = "all"; $("range").value = "all"; $("more").textContent = n ? `Loaded ${n} older items. Load more` : "No older items"; draw(); });
    draw();
  };

  async function archive(head) {
    const idx = await editions();
    const prod = [["", "All"], ["briefing", "Briefings"], ["radar", "Radar"], ["review", "Week in Review"], ["earnings", "Earnings"]];
    $app.innerHTML = `${head}<div class="filter-row" id="ap" style="margin-bottom:14px">${prod.map(([k, v]) => `<span class="chip ${k ? "" : "on"}" data-p="${k}">${v}</span>`).join("")}</div><div class="arch" id="al"></div>`;
    const draw = (p) => {
      const rows = idx.entries.filter((e) => !p || (e.product || "briefing") === p);
      document.getElementById("al").innerHTML = rows.length ? rows.map((e) => `<a class="card" href="#/digest/${esc(e.id)}"><div class="dtype">${esc(TYPE_LABEL[e.type] || e.type)}</div><div class="t">${esc(e.title)}</div>
        <div class="note">${fmtDate(e.generated, { weekday: "short", month: "short", day: "numeric" })} · ${e.item_count} items · ${e.high_signal ?? "?"} high signal${e.radar_count != null ? ` · ${e.radar_count} opportunities` : ""}</div>
        <div>${(e.status || "draft") === "reviewed" ? '<span class="pill reviewed">Reviewed</span>' : '<span class="pill draft">Draft</span>'}</div></a>`).join("") : empty("No editions yet.");
    };
    document.getElementById("ap").addEventListener("click", (ev) => { const c = ev.target.closest("[data-p]"); if (!c) return; document.querySelectorAll("#ap .chip").forEach((x) => x.classList.toggle("on", x === c)); draw(c.dataset.p); });
    draw("");
  }

  async function benefits(head, params) {
    const f = await feed();
    const days = +(params.get("d") || 7), cutoff = Date.now() - days * 864e5;
    const rows = f.filter((i) => i.benefit_move && new Date(i.published) >= cutoff).sort((a, b) => b.relevance - a.relevance || b.published.localeCompare(a.published));
    const by = rows.reduce((o, i) => ((o[i.issuer || "Other / unattributed"] = o[i.issuer || "Other / unattributed"] || []).push(i), o), {});
    $app.innerHTML = `${head}<p class="note" style="margin-top:0">What changed in card benefits, grouped by issuer, with the partner powering each move and the Take. Fed by Part 1 tagging on every item.</p>
      <div class="filter-row" style="margin-bottom:12px"><div class="seg" id="bd">${[[7, "This week"], [30, "30 days"], [45, "All loaded"]].map(([v, l]) => `<button data-d="${v}" class="${days === v ? "on" : ""}">${l}</button>`).join("")}</div><span class="count">${rows.length} benefit moves</span></div>
      ${rows.length ? Object.entries(by).sort((a, b) => b[1].length - a[1].length).map(([iss, xs]) => `<div class="card" style="margin-bottom:12px"><div class="card-head"><h3>${iss.startsWith("Other") ? esc(iss) : `<a href="#/company/${slug(iss)}" style="color:inherit">${esc(iss)}</a>`}</h3><span class="count">${xs.length}</span></div>${itemList(xs, { hideCompanies: true })}</div>`).join("")
        : empty("No benefit moves tagged in this window yet.")}`;
    document.getElementById("bd").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (!b) return; location.hash = `#/feed?tab=benefits&d=${b.dataset.d}`; });
  }

  views.digest = async (params, id) => {
    const [idx, f] = await Promise.all([editions(), feed()]);
    const e = idx.entries.find((x) => x.id === id);
    if (!e) { $app.innerHTML = empty("Edition not found."); return; }
    const body = await get(e.file, "", true);
    const i = idx.entries.indexOf(e), prev = idx.entries[i + 1], next = idx.entries[i - 1];
    const isCurator = (() => { try { return localStorage.getItem("mp-curator") === "1"; } catch { return false; } })() || params.get("curator") === "1";
    $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/feed?tab=archive">← Archive</a> · ${esc(TYPE_LABEL[e.type] || "")}</div><h1>${esc(e.title)}</h1>${byline(e)}
        <p class="note">${e.item_count} items considered · ${e.high_signal ?? "?"} high signal${e.sources != null ? ` · ${e.sources} sources linked` : ""}</p></div>
      <div class="filter-row"><button class="btn ghost small" id="copy">Copy text</button>${prev ? `<a class="btn ghost small" href="#/digest/${esc(prev.id)}">← Older</a>` : ""}${next ? `<a class="btn ghost small" href="#/digest/${esc(next.id)}">Newer →</a>` : ""}
        ${(e.status || "draft") === "draft" && isCurator ? `<a class="btn small" href="${esc(approveUrl(e.id))}" target="_blank" rel="noopener">Approve as curator</a>` : ""}</div></div>
      <article class="card prose">${md(body)}
        <p class="disclaimer">Headlines link to the original publisher. Summaries and tags are AI-generated, verify before acting. Every link is checked against the sources Claude actually received; anything unmatched is marked "source not verified". Internal cut: facts only before forwarding outside the team.</p></article>
      <div class="card" style="margin-top:16px"><details id="behind"><summary>All ${e.item_count} items behind this edition</summary><ul class="items" id="behind-list"><li class="muted">Loading…</li></ul></details></div>`;
    document.getElementById("behind").addEventListener("toggle", (ev) => {
      if (!ev.target.open || ev.target.dataset.loaded) return;
      ev.target.dataset.loaded = "1";
      const want = new Set(e.item_ids || []), rows = f.filter((it) => want.has(it.id));
      document.getElementById("behind-list").innerHTML = rows.length ? rows.map((it) => itemHTML(it)).join("") : `<li class="muted">These items are older than the loaded feed window.</li>`;
    });
    document.getElementById("copy").addEventListener("click", async (ev) => { try { await navigator.clipboard.writeText(body); ev.target.textContent = "Copied"; } catch { ev.target.textContent = "Copy failed"; } });
  };

  views.companies = async (params) => {
    const c = await get("companies.json", { companies: [] });
    $app.innerHTML = `<div class="page-head"><div><div class="kicker">Company index</div><h1>Companies</h1><div class="rule"></div><p>Every company the sweeps have tagged, with relevance, coverage and watchlist status. Builds up automatically.</p></div></div>
      <div class="filter-row" style="margin-bottom:12px"><input type="search" id="cq" placeholder="Find a company" value="${esc(params.get("q") || "")}"><select id="cs"><option value="30d">Most active, 30 days</option><option value="rel">Top relevance</option><option value="all">Most coverage, all time</option><option value="new">Recently seen</option></select></div>
      <div class="arch" id="cg"></div>`;
    const draw = () => {
      const q = document.getElementById("cq").value.toLowerCase(), s = document.getElementById("cs").value;
      const rows = c.companies.filter((x) => !q || x.name.toLowerCase().includes(q)).sort((a, b) =>
        s === "rel" ? (b.top_relevance || 0) - (a.top_relevance || 0) || b.count_30d - a.count_30d : s === "all" ? b.count - a.count : s === "new" ? b.last_seen.localeCompare(a.last_seen) : b.count_30d - a.count_30d || b.count - a.count).slice(0, 120);
      document.getElementById("cg").innerHTML = rows.length ? rows.map((x) => `<a class="card" href="#/company/${esc(x.slug)}"><div class="filter-row" style="justify-content:space-between"><span class="t">${esc(x.name)}</span>${x.top_relevance ? relBars(x.top_relevance) : ""}</div>
        <div class="note">${x.count} item${x.count === 1 ? "" : "s"} · ${x.count_30d} in 30 days · last seen ${ago(x.last_seen)}</div>
        ${x.latest_summary ? `<div class="note" style="color:var(--text-2)">${esc(x.latest_summary)}</div>` : ""}
        <div class="tags">${x.watch_status ? statusPill(x.watch_status) : ""}${x.has_vet ? '<span class="chip">Vetted</span>' : ""}${Object.keys(x.sections || {}).slice(0, 3).map((s2) => `<span class="chip">${esc(sectionLabel(s2))}</span>`).join("")}</div></a>`).join("") : empty("No companies match.");
    };
    document.getElementById("cq").addEventListener("input", draw);
    document.getElementById("cs").addEventListener("change", draw);
    draw();
  };

  views.company = async (params, s) => {
    const c = await get(`companies/${s}.json`, null);
    if (!c) { $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/companies">← Companies</a></div><h1>No coverage yet</h1></div></div>${empty(`Nothing tagged for this company yet. <a href="${esc(vetUrl(s.replace(/-/g, " ")))}" target="_blank" rel="noopener">Request a Diligence brief</a>.`)}`; return; }
    const w = c.watch, top = c.items.reduce((m2, i) => Math.max(m2, i.relevance || 0), 0);
    $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/companies">← Companies</a></div><h1>${esc(c.name)}</h1>
        <p class="note">${c.items.length} items tracked${c.items.length ? ` since ${fmtDate(c.items[c.items.length - 1].published, { month: "short", day: "numeric", year: "numeric" })}` : ""}${top ? ` · top relevance ${top}/5` : ""}</p></div>
      <div class="filter-row"><a class="btn" href="${esc(vetUrl(c.name))}" target="_blank" rel="noopener">Request Diligence</a>${w ? "" : `<a class="btn ghost" href="${esc(watchUrl(c.name))}" target="_blank" rel="noopener">+ Watchlist</a>`}<a class="btn ghost" href="#/feed?co=${esc(c.slug)}&range=all">In the feed</a></div></div>
      <div class="grid cols-2">
        <div class="card"><h3>Coverage</h3>${itemList(c.items.slice(0, 80), { hideCompanies: true }) || `<p class="note">None.</p>`}</div>
        <div class="grid" style="align-content:start">
          ${w ? `<div class="card"><h3>Watchlist</h3><p>${statusPill(w.status)} <span class="muted">${esc(w.category || "")}</span></p><p>${esc(w.what || "")}</p><p class="muted">${esc(w.why_fit || "")}</p><ul class="history">${(w.history || []).slice().reverse().map((h) => `<li>${fmtDate(h.date)} · ${esc(h.status)}: ${esc(h.note)}</li>`).join("")}</ul></div>` : ""}
          <div class="card"><h3>Diligence briefs</h3>${(c.vets || []).length ? c.vets.map((v) => `<p><a href="#/vet/${esc(v.id)}">${esc(v.company)}, ${fmtDate(v.date)}</a>${v.requested_by ? ` <span class="note">for ${esc(v.requested_by)}</span>` : ""}</p>`).join("") : `<p class="note">None yet.</p>`}</div>
        </div>
      </div>`;
  };

  views.sources = async () => {
    const [m, h, u] = await Promise.all([manifest(), get("source_health.json", { sources: [] }), get("usage.json", { days: {} })]);
    const rows = h.sources.slice().sort((a, b) => a.ok - b.ok || a.name.localeCompare(b.name));
    const days = Object.entries(u.days || {}).sort().reverse(), month = todayISO().slice(0, 7);
    const mtd = days.filter(([d]) => d.startsWith(month)).reduce((o, [, v]) => ({ i: o.i + v.input_tokens, o: o.o + v.output_tokens, w: o.w + v.web_searches, c: o.c + v.calls }), { i: 0, o: 0, w: 0, c: 0 });
    const err = m.llm_error ? `<div class="breaking"><div class="kicker">Claude API error · ${ago(m.llm_error.at)}</div><p style="margin:6px 0 0"><b>${esc(m.llm_error.type)}${m.llm_error.status ? " (" + esc(m.llm_error.status) + ")" : ""}</b> during ${esc(m.llm_error.task)}: ${esc(m.llm_error.message)}</p></div>` : "";
    const lerr = Object.entries(m.living_errors || {}).map(([k, v]) => `<li>${esc(k)}: ${esc(v.error)} (${ago(v.at)})</li>`).join("");
    $app.innerHTML = err + `<div class="page-head"><div><h1>Sources &amp; Usage</h1><div class="rule"></div><p>Feed health from the last sweep and Claude API usage. Sources are configured in <span class="mono">config/sources.yaml</span>.</p></div></div>
      ${lerr ? `<div class="card" style="margin-bottom:14px"><h3>Living page errors</h3><ul class="history">${lerr}</ul></div>` : ""}
      <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr))"><div class="stat"><div class="kicker">Sources ok</div><div class="v">${rows.filter((r) => r.ok).length}/${rows.length}</div><div class="s">${h.checked ? "checked " + ago(h.checked) : ""}</div></div>
        <div class="stat"><div class="kicker">API calls</div><div class="v">${mtd.c}</div><div class="s">this month</div></div>
        <div class="stat"><div class="kicker">Tokens</div><div class="v">${fmtNum(mtd.i + mtd.o)}</div><div class="s">${fmtNum(mtd.i)} in · ${fmtNum(mtd.o)} out</div></div>
        <div class="stat"><div class="kicker">Web searches</div><div class="v">${mtd.w}</div><div class="s">about $${(mtd.w * 0.01).toFixed(2)}</div></div></div>
      <div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Source</th><th data-k="1">Status</th><th data-k="2">Items</th><th data-k="3">Last ok</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.name)}<div class="note mono">${esc(r.type)}</div></td><td>${r.ok ? '<span class="status signed">ok</span>' : `<span class="status ended">failing${r.fail_streak > 1 ? " ×" + r.fail_streak : ""}</span><div class="note">${esc(r.error)}</div>`}</td><td class="num">${r.count}</td><td class="num" data-v="${esc(r.last_ok || "")}">${r.last_ok ? ago(r.last_ok) : "never"}</td></tr>`).join("")}</tbody></table></div>`;
    sortableTable(document.getElementById("t"));
  };

  // ---------- router ----------
  const ALIAS = { digests: ["feed", "tab=archive"], benefits: ["feed", "tab=benefits"], dashboard: ["spending"], calendar: ["spending"] };
  const NAV_OF = { digest: "feed", company: "companies", vet: "diligence", sources: "" };
  const TITLES = { today: "Today", luxury: "Luxury", nyc: "NYC Dining", booking: "Booking Windows", spending: "Spending Dashboard", radar: "Radar", watchlist: "Watchlist", diligence: "Diligence", feed: "Feed / Archive", companies: "Companies" };
  async function route() {
    const raw = location.hash.slice(1) || "/";
    let [path, qs] = raw.split("?");
    let parts = path.split("/").filter(Boolean), name = parts[0] || "today";
    if (ALIAS[name]) { const [n, q] = ALIAS[name]; location.replace(`#/${n}${q ? "?" + q : ""}`); return; }
    const params = new URLSearchParams(qs || ""), arg = parts.slice(1).join("/");
    if (params.get("curator") === "1") { try { localStorage.setItem("mp-curator", "1"); } catch {} }
    const navName = NAV_OF[name] ?? name;
    document.querySelectorAll(".nav a").forEach((a) => a.classList.toggle("active", (a.getAttribute("href").slice(2) || "today").split("?")[0] === navName));
    const view = views[name] || views.today;
    hideTip();
    try { await view(params, decodeURIComponent(arg)); } catch (e) { console.error(e); $app.innerHTML = empty("Something went wrong loading this page."); }
    document.title = `${TITLES[name] ? TITLES[name] + " · " : ""}Market Pulse`;
    const active = document.querySelector(".nav a.active"); if (active) active.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (!qs) window.scrollTo(0, 0);
  }

  // ---------- theme ----------
  const root = document.documentElement;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  const syncMeta = () => { if (metaTheme) metaTheme.content = getComputedStyle(root).getPropertyValue("--head-bg").trim() || "#f6f1e7"; };
  document.getElementById("theme").addEventListener("click", () => {
    const cur = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    root.dataset.theme = cur === "dark" ? "light" : "dark";
    try { localStorage.setItem("mp-theme", root.dataset.theme); } catch {}
    syncMeta();
  });
  const paintPalette = () => document.querySelectorAll(".palette-pick button").forEach((b) => b.classList.toggle("on", b.dataset.palette === (root.dataset.palette || "editorial")));
  document.querySelectorAll(".palette-pick button").forEach((b) => b.addEventListener("click", () => {
    root.dataset.palette = b.dataset.palette;
    try { localStorage.setItem("mp-palette", b.dataset.palette); } catch {}
    paintPalette(); syncMeta();
  }));
  paintPalette(); syncMeta();

  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", hideTip, { passive: true });
  (async () => {
    const m = await manifest();
    if (m.last_sweep) document.getElementById("updated").textContent = `Updated ${ago(m.last_sweep)} · ${m.feed_count || 0} items`;
    route();
    setInterval(async () => {
      const fresh = await fetch(D + "manifest.json?t=" + Date.now()).then((r) => r.json()).catch(() => null);
      if (fresh && fresh.last_sweep !== state.manifest?.last_sweep) { cache.clear(); state.manifest = fresh; state.feed = null; route(); }
    }, 10 * 60 * 1000);
  })();
})();
