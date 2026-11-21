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
  const fmtDate = (iso, opts = { month: "short", day: "numeric" }) => {
    if (!iso) return "";
    const d = new Date(iso.length === 10 ? iso + "T12:00:00" : iso);
    return isNaN(d) ? esc(iso) : d.toLocaleDateString(undefined, opts);
  };
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

  async function get(path, fallback = null, asText = false) {
    if (cache.has(path)) return cache.get(path);
    try {
      const r = await fetch(D + path + "?v=" + (state.manifest?.last_sweep || Date.now()), { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      const v = asText ? await r.text() : await r.json();
      cache.set(path, v);
      return v;
    } catch (e) {
      return fallback;
    }
  }

  const sectionLabel = (id) => (state.manifest?.sections || []).find((s) => s.id === id)?.label || id;
  const relBars = (n) => `<span class="rel" title="Relevance ${n}/5" aria-label="Relevance ${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
  const statusPill = (s) => `<span class="status ${esc(s)}">${esc(String(s || "").replace("_", " "))}</span>`;

  function itemHTML(i, { showWhy = true } = {}) {
    const comps = (i.companies || []).map((c) => `<a href="#/company/${slug(c)}">${esc(c)}</a>`).join(", ");
    const secs = (i.sections || []).map((s) => `<a class="chip" href="#/feed?s=${esc(s)}">${esc(sectionLabel(s))}</a>`).join("");
    const also = (i.also || []).length ? `<div class="also">Also: ${(i.also || []).slice(0, 4).map((a) => `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener">${esc(a.source)}</a>`).join(", ")}</div>` : "";
    const dps = (i.data_points || []).length ? `<div class="item-data">${i.data_points.map((d) => `<span class="dp">${esc(d)}</span>`).join("")}</div>` : "";
    return `<li class="item">
      <div class="item-meta">${i.breaking ? '<span class="badge-breaking">Breaking</span>' : ""}${relBars(i.relevance || 0)}<span>${esc(i.source)}</span><span>·</span><span title="${esc(i.published)}">${ago(i.published)}</span>${comps ? `<span>·</span><span class="companies">${comps}</span>` : ""}</div>
      <a class="item-title" href="${safeUrl(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>
      ${showWhy && i.why ? `<div class="item-why">${esc(i.why)}</div>` : ""}
      ${dps}
      <div class="item-meta">${secs}</div>
      ${also}
    </li>`;
  }

  const empty = (msg) => `<div class="empty">${msg}</div>`;

  // ---------- tooltip + charts ----------
  const tip = document.getElementById("tip");
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, x + 12) + "px";
    tip.style.top = Math.max(8, y - r.height - 12) + "px";
  }
  const hideTip = () => (tip.hidden = true);

  function niceTicks(min, max, n = 4) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, step0 = span / n;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }
  const fmtNum = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(1) + "M" : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(0) + "K" : Math.abs(v) >= 100 ? v.toFixed(0) : (+v.toFixed(2)).toString();

  // points: [{x: Date, y: number, label: string, display?: string}]
  function lineChart(points, { height = 150 } = {}) {
    if (points.length < 2) return "";
    const W = 340, H = height, L = 40, R = 8, T = 8, B = 22;
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
    const xlab = `<text x="${L}" y="${H - 5}">${first.getFullYear()}</text><text x="${W - R}" y="${H - 5}" text-anchor="end">${last.toLocaleDateString(undefined, { month: "short", year: "numeric" })}</text>`;
    const lastP = points[points.length - 1];
    const id = "c" + Math.random().toString(36).slice(2, 8);
    const svg = `<svg class="chart" id="${id}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Line chart">
      <g class="grid">${grid}</g><g class="axis">${ylab}${xlab}</g>
      <path class="line" d="${path}"/>
      <circle class="dot" r="4" cx="${sx(+lastP.x)}" cy="${sy(lastP.y)}"/>
      <g class="hov" style="display:none"><line class="cross" y1="${T}" y2="${H - B}"/><circle class="dot hover" r="4.5"/></g>
      <rect x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
    </svg>`;
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      const cross = el.querySelector(".cross"), hd = el.querySelector(".dot.hover"), hov = el.querySelector(".hov");
      const move = (ev) => {
        const pt = el.createSVGPoint();
        const e = ev.touches ? ev.touches[0] : ev;
        pt.x = e.clientX; pt.y = e.clientY;
        const loc = pt.matrixTransform(el.getScreenCTM().inverse());
        let best = points[0], bd = Infinity;
        for (const p of points) { const d = Math.abs(sx(+p.x) - loc.x); if (d < bd) { bd = d; best = p; } }
        const cx = sx(+best.x), cy = sy(best.y);
        hov.style.display = ""; cross.setAttribute("x1", cx); cross.setAttribute("x2", cx);
        hd.setAttribute("cx", cx); hd.setAttribute("cy", cy);
        showTip(`<b>${esc(best.display ?? fmtNum(best.y))}</b><br>${esc(best.label)}`, e.clientX, e.clientY);
      };
      const leave = () => { hov.style.display = "none"; hideTip(); };
      el.addEventListener("mousemove", move); el.addEventListener("touchmove", move, { passive: true });
      el.addEventListener("mouseleave", leave); el.addEventListener("touchend", leave);
    });
    return svg;
  }

  function direction(vals, lowerIsBetter = false) {
    if (vals.length < 2) return "";
    const [a, b] = vals.slice(-2);
    if (a === b) return `<span class="dir-flat">→ flat</span>`;
    const up = b > a, good = lowerIsBetter ? !up : up;
    return `<span class="${good ? "dir-up" : "dir-down"}">${up ? "▲" : "▼"} ${fmtNum(Math.abs(b - a))}</span>`;
  }

  // ---------- data ----------
  async function manifest() {
    if (!state.manifest) state.manifest = await get("manifest.json", { sections: [], months: [] });
    return state.manifest;
  }
  async function feed() {
    if (!state.feed) state.feed = await get("feed.json", []);
    return state.feed;
  }
  async function loadOlder() {
    const m = await manifest();
    const f = await feed();
    const have = new Set(f.map((i) => i.id));
    const months = (m.months || []).slice().reverse();
    for (const mo of months) {
      if (state.olderLoaded.has(mo)) continue;
      state.olderLoaded.add(mo);
      const rows = await get(`items/${mo}.json`, []);
      const add = rows.filter((i) => i.enriched && !have.has(i.id));
      if (add.length) { f.push(...add); return add.length; }
    }
    return 0;
  }

  // ---------- views ----------
  const views = {};

  views.today = async () => {
    const [m, f, idx, cal, bk] = await Promise.all([manifest(), feed(), get("digests/index.json", { entries: [] }), get("living/calendar.json", { entries: [] }), get("living/booking.json", { entries: [] })]);
    const now = Date.now();
    const breaking = f.filter((i) => i.breaking && now - new Date(i.published) < 72 * 3600e3);
    const top = f.filter((i) => now - new Date(i.published) < 30 * 3600e3 && (i.relevance || 0) >= 4)
      .sort((a, b) => b.relevance - a.relevance || b.published.localeCompare(a.published)).slice(0, 10);
    const latest = idx.entries.find((e) => e.type !== "earnings");
    const latestBody = latest ? await get(latest.file, "", true) : "";
    const today = new Date().toISOString().slice(0, 10);
    const week = new Date(now + 7 * 864e5).toISOString().slice(0, 10);
    const upcoming = (cal.entries || []).filter((e) => e.date >= today && e.date <= week).slice(0, 8);
    const opening = (bk.entries || []).filter((e) => e.next_open && e.next_open >= today).sort((a, b) => a.next_open.localeCompare(b.next_open)).slice(0, 5);
    const last24 = f.filter((i) => now - new Date(i.published) < 24 * 3600e3).length;

    $app.innerHTML = `
      <div class="page-head"><div><div class="kicker">${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div><h1>Today</h1></div></div>
      ${breaking.length ? `<div class="breaking"><div class="kicker">Breaking · last 72 hours</div><ul>${breaking.slice(0, 5).map((i) => `<li><a href="${safeUrl(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a> <span class="muted">· ${esc(i.source)} · ${ago(i.published)}</span>${i.why ? `<div class="item-why">${esc(i.why)}</div>` : ""}</li>`).join("")}</ul></div>` : ""}
      <div class="stats">
        <div class="stat"><div class="kicker">Last 24h</div><div class="v">${last24}</div><div class="s">new items tracked</div></div>
        <div class="stat"><div class="kicker">High signal</div><div class="v">${top.length}</div><div class="s">relevance 4+ today</div></div>
        <div class="stat"><div class="kicker">Last sweep</div><div class="v">${m.last_sweep ? ago(m.last_sweep) : "n/a"}</div><div class="s">${m.last_sweep_stats ? `${m.last_sweep_stats.sources_ok}/${m.last_sweep_stats.sources} sources ok` : ""}</div></div>
      </div>
      <div class="grid cols-2">
        <div class="card">
          ${latest ? `<div class="card-head"><h2>${esc(latest.title)}</h2><a href="#/digest/${esc(latest.id)}">Read full →</a></div><div class="prose preview">${md(latestBody)}</div>` : `<h2>Latest digest</h2>${empty("The first digest will appear after the next morning run.")}`}
        </div>
        <div class="grid" style="align-content:start">
          <div class="card"><div class="card-head"><h3>Next 7 days</h3><a href="#/calendar">Calendar →</a></div>
            ${upcoming.length ? upcoming.map((e) => `<div class="cal-day"><div class="cal-date">${fmtDate(e.date, { weekday: "short" })}<b>${fmtDate(e.date, { month: "short", day: "numeric" })}</b></div><div>${e.url ? `<a href="${safeUrl(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)} <span class="muted">${esc(e.type)}${e.confirmed === false ? ", est." : ""}</span></div></div>`).join("") : `<p class="muted">Nothing scheduled yet.</p>`}
          </div>
          <div class="card"><div class="card-head"><h3>Booking windows opening</h3><a href="#/booking">All →</a></div>
            ${opening.length ? opening.map((e) => `<div class="cal-day"><div class="cal-date"><b>${fmtDate(e.next_open)}</b></div><div><a href="${safeUrl(e.url)}" target="_blank" rel="noopener">${esc(e.name)}</a><div class="muted">${esc(e.window)}</div></div></div>`).join("") : `<p class="muted">No dated windows yet.</p>`}
          </div>
        </div>
      </div>
      <h2>Top signals</h2>
      <div class="card">${top.length ? `<ul class="items">${top.map((i) => itemHTML(i)).join("")}</ul>` : `<p class="muted">No high-relevance items in the last day. <a href="#/feed">Browse the feed →</a></p>`}</div>`;
  };

  views.feed = async (params) => {
    const [m, f] = await Promise.all([manifest(), feed()]);
    const st = {
      q: params.get("q") || "", s: params.get("s") || "", rel: +(params.get("rel") || 2),
      src: params.get("src") || "", range: params.get("range") || "7", sort: params.get("sort") || "new",
    };
    const sources = [...new Set(f.map((i) => i.source))].sort();
    $app.innerHTML = `
      <div class="page-head"><div><h1>Feed</h1><p>Every tagged item from the sweeps. Filter by section, source or company.</p></div></div>
      <div class="filters">
        <div class="filter-row">
          <input type="search" id="q" placeholder="Search titles, companies, notes" value="${esc(st.q)}">
          <select id="range"><option value="1">24 hours</option><option value="7">7 days</option><option value="30">30 days</option><option value="all">Everything loaded</option></select>
          <select id="rel"><option value="1">All relevance</option><option value="2">Relevance 2+</option><option value="3">3+</option><option value="4">4+</option><option value="5">5 only</option></select>
          <select id="sort"><option value="new">Newest</option><option value="rel">Most relevant</option></select>
          <select id="src"><option value="">All sources</option>${sources.map((s) => `<option>${esc(s)}</option>`).join("")}</select>
        </div>
        <div class="filter-row" id="secs"><span class="chip ${st.s ? "" : "on"}" data-s="">All</span>${(m.sections || []).map((s) => `<span class="chip ${st.s === s.id ? "on" : ""}" data-s="${esc(s.id)}">${esc(s.label)}</span>`).join("")}</div>
      </div>
      <div class="filter-row" style="justify-content:space-between;margin:6px 0 4px"><span class="count" id="count"></span></div>
      <div class="card"><ul class="items" id="list"></ul></div>
      <p style="text-align:center"><button class="btn ghost" id="more">Load older months</button></p>`;
    const $ = (id) => document.getElementById(id);
    $("range").value = st.range; $("rel").value = String(st.rel); $("sort").value = st.sort; $("src").value = st.src;
    const draw = () => {
      const q = st.q.toLowerCase();
      const cutoff = st.range === "all" ? 0 : Date.now() - +st.range * 864e5;
      let rows = f.filter((i) => (i.relevance || 0) >= st.rel && (!st.s || (i.sections || []).includes(st.s)) && (!st.src || i.source === st.src) && new Date(i.published) >= cutoff);
      if (q) rows = rows.filter((i) => [i.title, i.why, i.source, ...(i.companies || []), ...(i.data_points || [])].join(" ").toLowerCase().includes(q));
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
    $("rel").addEventListener("change", (e) => { st.rel = +e.target.value; draw(); });
    $("secs").addEventListener("click", (e) => {
      const c = e.target.closest("[data-s]"); if (!c) return;
      st.s = c.dataset.s; $("secs").querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === c)); draw();
    });
    $("more").addEventListener("click", async () => {
      const n = await loadOlder(); st.range = "all"; $("range").value = "all";
      $("more").textContent = n ? `Loaded ${n} older items. Load more` : "No older items"; draw();
    });
    draw();
  };

  views.digests = async () => {
    const idx = await get("digests/index.json", { entries: [] });
    const label = { daily: "Daily", monday: "Weekly", friday: "Week in Review", earnings: "Earnings" };
    $app.innerHTML = `<div class="page-head"><div><h1>Digests</h1><p>Daily briefs (Tue to Fri), the Monday weekly edition, Friday week in review, and earnings recaps.</p></div>
      <div class="filter-row" id="dt"><span class="chip on" data-t="">All</span>${Object.entries(label).map(([k, v]) => `<span class="chip" data-t="${k}">${v}</span>`).join("")}</div></div>
      <div class="card"><ul class="digest-list" id="dl"></ul></div>`;
    const draw = (t) => {
      const rows = idx.entries.filter((e) => !t || e.type === t);
      document.getElementById("dl").innerHTML = rows.length ? rows.map((e) => `<li><div><span class="dtype ${esc(e.type)}">${esc(label[e.type] || e.type)}</span> <a href="#/digest/${esc(e.id)}">${esc(e.title)}</a>${e.quiet ? ' <span class="muted">· quiet</span>' : ""}</div><span class="muted mono">${e.item_count} items${e.sources != null ? ` · ${e.sources} sources` : ""}</span></li>`).join("") : `<li>${empty("No digests yet.")}</li>`;
    };
    document.getElementById("dt").addEventListener("click", (e) => {
      const c = e.target.closest("[data-t]"); if (!c) return;
      document.querySelectorAll("#dt .chip").forEach((x) => x.classList.toggle("on", x === c)); draw(c.dataset.t);
    });
    draw("");
  };

  views.digest = async (params, id) => {
    const idx = await get("digests/index.json", { entries: [] });
    const e = idx.entries.find((x) => x.id === id);
    if (!e) { $app.innerHTML = empty("Digest not found."); return; }
    const body = await get(e.file, "", true);
    const i = idx.entries.indexOf(e);
    const prev = idx.entries[i + 1], next = idx.entries[i - 1];
    $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/digests">← Digests</a></div><h1>${esc(e.title)}</h1><p class="muted">Generated ${fmtDate(e.generated, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} from ${e.item_count} items</p></div>
      <div class="filter-row"><button class="btn ghost" id="copy">Copy text</button>${prev ? `<a class="btn ghost" href="#/digest/${esc(prev.id)}">← Older</a>` : ""}${next ? `<a class="btn ghost" href="#/digest/${esc(next.id)}">Newer →</a>` : ""}</div></div>
      <article class="card prose">${md(body)}</article>
      <div class="card" style="margin-top:16px"><details id="behind"><summary>All ${e.item_count} items behind this digest${e.sources != null ? ` · ${e.sources} sources linked` : ""}${e.unverified_links_removed ? ` · ${e.unverified_links_removed} unverified link${e.unverified_links_removed > 1 ? "s" : ""} removed` : ""}</summary><ul class="items" id="behind-list"><li class="muted">Loading…</li></ul></details>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">Every link in a digest is checked against the articles and web search results Claude actually received. Any link that can't be matched is removed and marked "source not verified".</p></div>`;
    document.getElementById("behind").addEventListener("toggle", async (ev) => {
      if (!ev.target.open || ev.target.dataset.loaded) return;
      ev.target.dataset.loaded = "1";
      const f = await feed(); const want = new Set(e.item_ids || []);
      const rows = f.filter((i) => want.has(i.id));
      document.getElementById("behind-list").innerHTML = rows.length ? rows.map((i) => itemHTML(i)).join("") : `<li class="muted">These items are older than the loaded feed window. Use the Feed's "Load older months".</li>`;
    });
    document.getElementById("copy").addEventListener("click", async (ev) => {
      try { await navigator.clipboard.writeText(body); ev.target.textContent = "Copied"; } catch { ev.target.textContent = "Copy failed"; }
    });
  };

  function sortableTable(el) {
    el.querySelectorAll("th[data-k]").forEach((th) => th.addEventListener("click", () => {
      const tbody = el.querySelector("tbody"), k = +th.dataset.k, dir = th.dataset.dir === "asc" ? "desc" : "asc";
      el.querySelectorAll("th").forEach((x) => delete x.dataset.dir); th.dataset.dir = dir;
      [...tbody.rows].sort((a, b) => { const x = a.cells[k].dataset.v ?? a.cells[k].textContent, y = b.cells[k].dataset.v ?? b.cells[k].textContent; return (dir === "asc" ? 1 : -1) * x.localeCompare(y, undefined, { numeric: true }); }).forEach((r) => tbody.appendChild(r));
    }));
  }

  views.watchlist = async () => {
    const wl = await get("living/watchlist.json", { entries: [] });
    const order = { signed: 0, acquired: 1, rumored: 2, in_talks: 2, emerging: 3, dropped: 9 };
    const rows = wl.entries.slice().sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || (b.updated || "").localeCompare(a.updated || ""));
    const counts = rows.reduce((o, e) => ((o[e.status] = (o[e.status] || 0) + 1), o), {});
    $app.innerHTML = `<div class="page-head"><div><h1>Partnership Watchlist</h1><p>Brands, venues and platforms flagged as potential card-benefit partners, tracked over time. Updated every Monday.</p></div><span class="muted">${wl.updated ? "Updated " + ago(wl.updated) : ""}</span></div>
      <div class="stats">${["emerging", "rumored", "signed", "acquired"].map((s) => `<div class="stat"><div class="kicker">${s}</div><div class="v">${counts[s] || 0}</div></div>`).join("")}</div>
      ${rows.length ? `<div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Name</th><th data-k="1">Status</th><th data-k="2">Category</th><th>Why it fits</th><th data-k="4">Updated</th></tr></thead><tbody>
      ${rows.map((e) => `<tr><td><a href="#/company/${esc(e.slug || slug(e.name))}"><b>${esc(e.name)}</b></a><div class="muted">${esc(e.what)}</div></td><td data-v="${order[e.status] ?? 5}">${statusPill(e.status)}</td><td>${esc(e.category)}</td>
        <td>${esc(e.why_fit)}<details><summary>History (${(e.history || []).length})</summary><ul class="history">${(e.history || []).slice().reverse().map((h) => `<li>${fmtDate(h.date)} · ${esc(h.status)}: ${esc(h.note)} ${h.url ? `<a href="${safeUrl(h.url)}" target="_blank" rel="noopener">source</a>` : ""}</li>`).join("")}</ul></details></td>
        <td class="num" data-v="${esc(e.updated)}">${fmtDate(e.updated)}</td></tr>`).join("")}</tbody></table></div>` : empty("The watchlist fills in after the first Monday run.")}`;
    const t = document.getElementById("t"); if (t) sortableTable(t);
  };

  views.benefits = async () => {
    const bt = await get("living/benefits.json", { entries: [] });
    const rows = bt.entries.slice().sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    const issuers = [...new Set(rows.map((r) => r.issuer))].sort();
    $app.innerHTML = `<div class="page-head"><div><h1>Competitor Benefits</h1><p>Notable benefits on competitor premium cards and the partner powering each one.</p></div><span class="muted">${bt.updated ? "Updated " + ago(bt.updated) : ""}</span></div>
      <div class="filter-row" id="iss" style="margin-bottom:12px"><span class="chip on" data-i="">All issuers</span>${issuers.map((i) => `<span class="chip" data-i="${esc(i)}">${esc(i)}</span>`).join("")}</div>
      ${rows.length ? `<div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Issuer</th><th data-k="1">Card</th><th data-k="2">Benefit</th><th data-k="3">Partner</th><th data-k="4">Status</th><th>Note</th><th data-k="6">Announced</th></tr></thead><tbody>
      ${rows.map((e) => `<tr data-issuer="${esc(e.issuer)}"><td><a href="#/company/${slug(e.issuer)}">${esc(e.issuer)}</a></td><td>${esc(e.card)}</td><td><b>${esc(e.benefit)}</b><div class="muted">${esc(e.category)}</div></td>
        <td>${e.partner ? `<a href="#/company/${slug(e.partner)}">${esc(e.partner)}</a>` : '<span class="muted">not stated</span>'}</td><td>${statusPill(e.status)}</td>
        <td>${esc(e.note)} ${e.url ? `<a href="${safeUrl(e.url)}" target="_blank" rel="noopener">source</a>` : ""}</td><td class="num" data-v="${esc(e.announced || "")}">${e.announced ? fmtDate(e.announced) : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("The tracker fills in after the first Monday run.")}`;
    const t = document.getElementById("t"); if (t) sortableTable(t);
    document.getElementById("iss").addEventListener("click", (e) => {
      const c = e.target.closest("[data-i]"); if (!c) return;
      document.querySelectorAll("#iss .chip").forEach((x) => x.classList.toggle("on", x === c));
      document.querySelectorAll("#t tbody tr").forEach((r) => (r.hidden = c.dataset.i && r.dataset.issuer !== c.dataset.i));
    });
  };

  views.booking = async () => {
    const bk = await get("living/booking.json", { entries: [] });
    const key = (e) => e.next_open || e.event_date || "9999";
    const rows = bk.entries.slice().sort((a, b) => key(a).localeCompare(key(b)));
    const icon = { restaurant: "🍽", hotel: "🏨", event: "🎟" };
    $app.innerHTML = `<div class="page-head"><div><h1>Booking Windows</h1><p>What affluent consumers can book now and when the next windows open. Refreshed every Monday with web search.</p></div><span class="muted">${bk.updated ? "Updated " + ago(bk.updated) : ""}</span></div>
      <div class="filter-row" id="bt" style="margin-bottom:12px"><span class="chip on" data-t="">All</span><span class="chip" data-t="restaurant">Restaurants</span><span class="chip" data-t="hotel">Hotels</span><span class="chip" data-t="event">Events</span></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>How it books</th><th>Next window</th><th>Event date</th></tr></thead><tbody>
      ${rows.map((e) => `<tr data-type="${esc(e.type)}"><td><span aria-hidden="true">${icon[e.type] || ""}</span> <a href="${safeUrl(e.url)}" target="_blank" rel="noopener"><b>${esc(e.name)}</b></a><div class="muted">${esc(e.location)}</div></td>
        <td>${esc(e.window)}${e.cadence ? `<div class="muted">Cadence: ${esc(e.cadence)}</div>` : ""}${e.note ? `<div class="muted">Tip: ${esc(e.note)}</div>` : ""}</td>
        <td class="num">${e.next_open ? fmtDate(e.next_open) : "open / rolling"}</td><td class="num">${e.event_date ? fmtDate(e.event_date) : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("Booking windows fill in after the first Monday run.")}`;
    document.getElementById("bt").addEventListener("click", (e) => {
      const c = e.target.closest("[data-t]"); if (!c) return;
      document.querySelectorAll("#bt .chip").forEach((x) => x.classList.toggle("on", x === c));
      document.querySelectorAll("tbody tr").forEach((r) => (r.hidden = c.dataset.t && r.dataset.type !== c.dataset.t));
    });
  };

  views.dashboard = async () => {
    const [dash, fred] = await Promise.all([get("living/dashboard.json", { indicators: [] }), get("fred.json", { series: [] })]);
    const lowerBetter = new Set(["DRCCLACBS", "CORCCACBS", "TERMCBCCALLNS"]);
    const lux = dash.indicators.map((d) => {
      const r = d.readings || [], num = r.filter((x) => typeof x.value === "number");
      const last = r[r.length - 1];
      const pts = num.map((x) => ({ x: new Date((x.date || x.period) + (String(x.date || "").length === 10 ? "T12:00:00" : "")), y: x.value, label: x.period, display: x.display }));
      return `<div class="card chart-card"><h3>${esc(d.label)}</h3>
        ${last ? `<div class="latest"><b>${esc(last.display || fmtNum(last.value))}</b><span class="muted">${esc(last.period)}</span>${direction(num.map((x) => x.value))}</div>` : `<p class="muted">No reading yet.</p>`}
        ${lineChart(pts)}
        ${last ? `<div class="muted" style="font-size:12.5px">${esc(last.note || "")} ${last.url ? `<a href="${safeUrl(last.url)}" target="_blank" rel="noopener">source</a>` : ""}</div>` : ""}
        ${r.length ? `<details><summary>All readings (${r.length})</summary><table><tbody>${r.slice().reverse().map((x) => `<tr><td>${esc(x.period)}</td><td class="num">${esc(x.display || x.value)}</td><td>${x.url ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">src</a>` : ""}</td></tr>`).join("")}</tbody></table></details>` : ""}
      </div>`;
    }).join("");
    const fr = (fred.series || []).map((s) => {
      const pts = (s.points || []).map(([d, v]) => ({ x: new Date(d + "T12:00:00"), y: v, label: fmtDate(d, { month: "short", year: "numeric" }) }));
      const last = pts[pts.length - 1];
      const recent = pts.filter((p) => p.x >= new Date(Date.now() - 6 * 365 * 864e5));
      return `<div class="card chart-card"><h3>${esc(s.label)}</h3>
        ${last ? `<div class="latest"><b>${fmtNum(last.y)}</b><span class="muted">${esc(s.unit)} · ${esc(last.label)}</span>${direction(pts.map((p) => p.y), lowerBetter.has(s.id))}</div>` : `<p class="muted">No data yet.</p>`}
        ${lineChart(recent)}
        <div class="muted" style="font-size:12.5px">FRED <a href="https://fred.stlouisfed.org/series/${esc(s.id)}" target="_blank" rel="noopener">${esc(s.id)}</a>${s.ok === false ? " · last refresh failed" : ""}</div></div>`;
    }).join("");
    $app.innerHTML = `<div class="page-head"><div><h1>Spending &amp; Credit Dashboard</h1><p>Luxury spending indicators carried forward week to week, plus consumer credit health from FRED.</p></div><span class="muted">${dash.updated ? "Luxury updated " + ago(dash.updated) : ""}</span></div>
      <h2>Luxury spending</h2><div class="charts">${lux || empty("Indicators fill in after the first Monday run.")}</div>
      <h2>Consumer credit &amp; spending (FRED)</h2><div class="charts">${fr || empty("FRED data loads on the next sweep.")}</div>`;
  };

  views.calendar = async () => {
    const cal = await get("living/calendar.json", { entries: [] });
    const today = new Date().toISOString().slice(0, 10);
    const rows = (cal.entries || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const up = rows.filter((e) => e.date >= today), past = rows.filter((e) => e.date < today).reverse();
    const row = (e) => `<div class="cal-day"><div class="cal-date">${fmtDate(e.date, { weekday: "short" })}<b>${fmtDate(e.date)}</b></div><div>${e.url ? `<a href="${safeUrl(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}
      <div class="muted">${esc(e.type)}${e.company ? " · " + `<a href="#/company/${slug(e.company)}">${esc(e.company)}</a>` : ""}${e.confirmed === false ? " · estimated" : ""}${e.recapped ? " · recap in Digests" : ""}</div></div></div>`;
    $app.innerHTML = `<div class="page-head"><div><h1>Earnings &amp; Events</h1><p>Issuer, network, BNPL and luxury earnings plus key industry and regulatory dates for the next six weeks. Earnings get an automatic recap in Digests.</p></div><span class="muted">${cal.updated ? "Updated " + ago(cal.updated) : ""}</span></div>
      <div class="grid cols-2"><div class="card"><h3>Upcoming</h3>${up.length ? up.map(row).join("") : `<p class="muted">Fills in after the first Monday run.</p>`}</div>
      <div class="card"><h3>Last two weeks</h3>${past.length ? past.map(row).join("") : `<p class="muted">Nothing yet.</p>`}</div></div>`;
  };

  views.companies = async (params) => {
    const c = await get("companies.json", { companies: [] });
    $app.innerHTML = `<div class="page-head"><div><h1>Companies</h1><p>Every company the sweeps have tagged, with its full coverage timeline. Builds up automatically over time.</p></div></div>
      <div class="filter-row" style="margin-bottom:12px"><input type="search" id="cq" placeholder="Find a company" value="${esc(params.get("q") || "")}"></div>
      <div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Company</th><th data-k="1">Last 30 days</th><th data-k="2">All time</th><th>Sections</th><th data-k="4">Last seen</th></tr></thead><tbody id="cb"></tbody></table></div>`;
    const draw = (q) => {
      const rows = c.companies.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase())).slice(0, 400);
      document.getElementById("cb").innerHTML = rows.length ? rows.map((x) => `<tr><td><a href="#/company/${esc(x.slug)}"><b>${esc(x.name)}</b></a> ${x.watch_status ? statusPill(x.watch_status) : ""} ${x.has_vet ? '<span class="chip">vetted</span>' : ""}</td>
        <td class="num" data-v="${x.count_30d}">${x.count_30d}</td><td class="num" data-v="${x.count}">${x.count}</td><td>${Object.keys(x.sections || {}).map((s) => `<span class="chip">${esc(sectionLabel(s))}</span>`).join(" ")}</td><td class="num" data-v="${esc(x.last_seen)}">${ago(x.last_seen)}</td></tr>`).join("") : `<tr><td colspan="5">${empty("No companies yet.")}</td></tr>`;
    };
    document.getElementById("cq").addEventListener("input", (e) => draw(e.target.value));
    sortableTable(document.getElementById("t"));
    draw(params.get("q") || "");
  };

  views.company = async (params, s) => {
    const c = await get(`companies/${s}.json`, null);
    if (!c) { $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/companies">← Companies</a></div><h1>No coverage yet</h1></div></div>${empty(`Nothing tagged for this company yet. <a href="${vetUrl(s.replace(/-/g, " "))}" target="_blank" rel="noopener">Request a Diligence brief</a>.`)}`; return; }
    const w = c.watch;
    const months = {};
    c.items.forEach((i) => { const k = i.published.slice(0, 7); months[k] = (months[k] || 0) + 1; });
    $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/companies">← Companies</a></div><h1>${esc(c.name)}</h1><p>${c.items.length} items tracked${c.items.length ? ` since ${fmtDate(c.items[c.items.length - 1].published, { month: "short", day: "numeric", year: "numeric" })}` : ""}</p></div>
      <div class="filter-row"><a class="btn" href="${vetUrl(c.name)}" target="_blank" rel="noopener">Request Diligence brief</a></div></div>
      <div class="grid cols-2">
        <div class="card"><h3>Coverage</h3><ul class="items">${c.items.slice(0, 80).map((i) => itemHTML({ ...i, companies: [] })).join("")}</ul></div>
        <div class="grid" style="align-content:start">
          ${w ? `<div class="card"><h3>Watchlist</h3><p>${statusPill(w.status)} <span class="muted">${esc(w.category)}</span></p><p>${esc(w.what)}</p><p class="muted">${esc(w.why_fit)}</p><ul class="history">${(w.history || []).slice().reverse().map((h) => `<li>${fmtDate(h.date)} · ${esc(h.status)}: ${esc(h.note)}</li>`).join("")}</ul></div>` : ""}
          <div class="card"><h3>Diligence briefs</h3>${(c.vets || []).length ? c.vets.map((v) => `<p><a href="#/vet/${esc(v.id)}">${esc(v.company)}, ${fmtDate(v.date)}</a></p>`).join("") : `<p class="muted">None yet.</p>`}</div>
          <div class="card"><h3>Mentions by month</h3>${Object.entries(months).sort().reverse().slice(0, 12).map(([k, v]) => `<div class="filter-row" style="justify-content:space-between"><span class="mono">${k}</span><span class="mono">${v}</span></div>`).join("")}</div>
        </div>
      </div>`;
  };

  function repoInfo() {
    const host = location.hostname;
    if (!host.endsWith("github.io")) return null;
    const owner = host.split(".")[0];
    const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
    return { owner, repo };
  }
  function vetUrl(name) {
    const r = repoInfo();
    const title = encodeURIComponent(`Vet: ${name || ""}`);
    const body = encodeURIComponent("Optional: add context or questions for the brief.\n\n(The brief is written automatically, posted to the Diligence page, and this issue is closed.)");
    return r ? `https://github.com/${r.owner}/${r.repo}/issues/new?title=${title}&body=${body}` : "#/diligence";
  }

  views.diligence = async () => {
    const idx = await get("vet/index.json", { entries: [] });
    $app.innerHTML = `<div class="page-head"><div><h1>Diligence Desk</h1><p>On-demand partner vetting. Each brief has a facts-only Part A for sharing and a clearly labeled internal Part B.</p></div></div>
      <div class="card" style="margin-bottom:16px"><h3>Request a brief</h3>
        <div class="filter-row"><input type="search" id="vn" placeholder="Company name, e.g. Dorsia"><a class="btn" id="vgo" href="${vetUrl("")}" target="_blank" rel="noopener">Open request</a></div>
        <p class="muted" style="margin-bottom:0">This opens a GitHub issue titled "Vet: Company". Only repo collaborators can trigger a brief. It appears here in a few minutes.</p></div>
      <div class="card"><h3>Briefs</h3>${idx.entries.length ? `<ul class="digest-list">${idx.entries.map((v) => `<li><a href="#/vet/${esc(v.id)}"><b>${esc(v.company)}</b></a><span class="muted mono">${fmtDate(v.date)}${v.requested_by ? " · " + esc(v.requested_by) : ""}</span></li>`).join("")}</ul>` : empty("No briefs yet.")}</div>`;
    const vn = document.getElementById("vn"), vgo = document.getElementById("vgo");
    vn.addEventListener("input", () => (vgo.href = vetUrl(vn.value.trim())));
  };

  views.vet = async (params, id) => {
    const idx = await get("vet/index.json", { entries: [] });
    const v = idx.entries.find((x) => x.id === id);
    if (!v) { $app.innerHTML = empty("Brief not found."); return; }
    const body = await get(v.file, "", true);
    const cut = body.search(/^#\s*Part B/m);
    const partA = cut > -1 ? body.slice(0, cut) : body;
    $app.innerHTML = `<div class="page-head"><div><div class="kicker"><a href="#/diligence">← Diligence Desk</a></div><h1>${esc(v.company)}</h1><p class="muted">Brief from ${fmtDate(v.date, { month: "long", day: "numeric", year: "numeric" })} · <a href="#/company/${esc(v.slug)}">coverage timeline</a></p></div>
      <div class="filter-row"><button class="btn ghost" id="copyA">Copy facts-only (Part A)</button></div></div>
      <article class="card prose">${md(body)}</article>`;
    document.getElementById("copyA").addEventListener("click", async (ev) => {
      try { await navigator.clipboard.writeText(partA.trim()); ev.target.textContent = "Copied Part A"; } catch { ev.target.textContent = "Copy failed"; }
    });
  };

  views.sources = async () => {
    const [h, u] = await Promise.all([get("source_health.json", { sources: [] }), get("usage.json", { days: {} })]);
    const rows = h.sources.slice().sort((a, b) => a.ok - b.ok || a.name.localeCompare(b.name));
    const days = Object.entries(u.days || {}).sort().reverse();
    const month = new Date().toISOString().slice(0, 7);
    const mtd = days.filter(([d]) => d.startsWith(month)).reduce((o, [, v]) => ({ i: o.i + v.input_tokens, o: o.o + v.output_tokens, w: o.w + v.web_searches, c: o.c + v.calls }), { i: 0, o: 0, w: 0, c: 0 });
    const m = await manifest();
    const err = m.llm_error ? `<div class="breaking" style="margin-bottom:16px"><div class="kicker">Claude API error · ${ago(m.llm_error.at)}</div><p style="margin:6px 0 0"><b>${esc(m.llm_error.type)}${m.llm_error.status ? " (" + esc(m.llm_error.status) + ")" : ""}</b> during ${esc(m.llm_error.task)}: ${esc(m.llm_error.message)}</p></div>` : "";
    $app.innerHTML = err + `<div class="page-head"><div><h1>Sources &amp; Usage</h1><p>Feed health from the last sweep and Claude API usage. Add or remove sources in <span class="mono">config/sources.yaml</span>.</p></div></div>
      <div class="stats"><div class="stat"><div class="kicker">Sources ok</div><div class="v">${rows.filter((r) => r.ok).length}/${rows.length}</div><div class="s">${h.checked ? "checked " + ago(h.checked) : ""}</div></div>
        <div class="stat"><div class="kicker">API calls this month</div><div class="v">${mtd.c}</div></div>
        <div class="stat"><div class="kicker">Tokens this month</div><div class="v">${fmtNum(mtd.i + mtd.o)}</div><div class="s">${fmtNum(mtd.i)} in · ${fmtNum(mtd.o)} out</div></div>
        <div class="stat"><div class="kicker">Web searches</div><div class="v">${mtd.w}</div><div class="s">about $${(mtd.w * 0.01).toFixed(2)} at $10 per 1,000</div></div></div>
      <div class="table-wrap"><table id="t"><thead><tr><th data-k="0">Source</th><th data-k="1">Status</th><th data-k="2">Items</th><th data-k="3">Last ok</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.name)}<div class="muted mono" style="word-break:break-all">${esc(r.type)}</div></td><td>${r.ok ? '<span class="status signed">ok</span>' : `<span class="status ended">failing${r.fail_streak > 1 ? " ×" + r.fail_streak : ""}</span><div class="muted" style="font-size:12px">${esc(r.error)}</div>`}</td><td class="num">${r.count}</td><td class="num" data-v="${esc(r.last_ok || "")}">${r.last_ok ? ago(r.last_ok) : "never"}</td></tr>`).join("")}</tbody></table></div>`;
    sortableTable(document.getElementById("t"));
  };

  // ---------- router ----------
  async function route() {
    const raw = location.hash.slice(1) || "/";
    const [path, qs] = raw.split("?");
    const params = new URLSearchParams(qs || "");
    const parts = path.split("/").filter(Boolean);
    const name = parts[0] || "today";
    const arg = parts.slice(1).join("/");
    document.querySelectorAll(".nav a").forEach((a) => {
      const target = a.getAttribute("href").slice(2) || "today";
      const map = { digest: "digests", company: "companies", vet: "diligence" };
      a.classList.toggle("active", target === (map[name] || name));
    });
    const view = views[name] || views.today;
    hideTip();
    try { await view(params, decodeURIComponent(arg)); }
    catch (e) { console.error(e); $app.innerHTML = empty("Something went wrong loading this page."); }
    const titles = { today: "Today", feed: "Feed", digests: "Digests", watchlist: "Watchlist", benefits: "Benefits", booking: "Booking", dashboard: "Dashboard", calendar: "Calendar", companies: "Companies", diligence: "Diligence" };
    document.title = `${titles[name] ? titles[name] + " · " : ""}Market Pulse`;
    if (!params.toString()) window.scrollTo(0, 0);
  }

  // ---------- theme ----------
  const themeBtn = document.getElementById("theme");
  const savedTheme = (() => { try { return localStorage.getItem("mp-theme"); } catch { return null; } })();
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("mp-theme", next); } catch {}
  });

  window.addEventListener("hashchange", route);
  window.addEventListener("scroll", hideTip, { passive: true });
  (async () => {
    const m = await manifest();
    if (m.last_sweep) document.getElementById("updated").textContent = `Updated ${ago(m.last_sweep)} · ${m.feed_count || 0} items`;
    route();
    // pick up new sweeps if the tab is left open
    setInterval(async () => {
      const fresh = await fetch(D + "manifest.json?t=" + Date.now()).then((r) => r.json()).catch(() => null);
      if (fresh && fresh.last_sweep !== state.manifest?.last_sweep) { cache.clear(); state.manifest = fresh; state.feed = null; route(); }
    }, 10 * 60 * 1000);
  })();
})();
