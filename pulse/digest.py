"""The three products plus extras.

  Luxury Trends Briefing   Monday full (Parts 1 to 6); Tue to Fri conditional update, nothing if quiet
  Partnership Radar        Monday full (capped); Tue to Fri conditional, only when something major breaks
  Week in Review           Friday evening
  Earnings recap           after scheduled earnings dates

Every edition is saved as a Draft with a curator byline, and flips to Reviewed when the
curator approves it (an "Approve: <id>" issue, see pulse/desk.py).
"""
from __future__ import annotations

import json
import re
from datetime import timedelta

from . import config, living, llm, store
from .common import allowed_sources, finalize, has_source, items_block, slug, system_with_context, today_line

INDEX = "digests/index.json"
RADAR = "radar/index.json"

TITLES = {
    "monday": "Luxury Trends Briefing",
    "update": "Briefing Update",
    "radar": "Partnership Sourcing Radar",
    "radar_update": "Radar Update",
    "friday": "Week in Review",
    "earnings": "Earnings Recap",
    "daily": "Daily Brief",  # legacy
}
PRODUCT = {"monday": "briefing", "update": "briefing", "radar": "radar", "radar_update": "radar",
           "friday": "review", "earnings": "earnings", "daily": "briefing"}


def _index() -> dict:
    return store.read_json(INDEX, {"entries": []})


def curator() -> str:
    return config.settings()["site"].get("curator", "Curator")


def _living_urls() -> list[dict]:
    out = []
    for f in ("watchlist", "benefits", "booking", "calendar"):
        for e in store.read_json(f"living/{f}.json", {"entries": []})["entries"]:
            if e.get("url"):
                out.append({"url": e["url"], "title": e.get("name") or e.get("benefit") or e.get("title")})
            for h in e.get("history") or []:
                if h.get("url"):
                    out.append({"url": h["url"], "title": e.get("name")})
    for d in store.read_json("living/dashboard.json", {"indicators": []})["indicators"]:
        for r in d.get("readings", []):
            if r.get("url"):
                out.append({"url": r["url"], "title": f"{d['label']} ({r['period']})"})
    return out


def _save(kind: str, body: str, items: list[dict], cites: list[dict], title_extra: str = "",
          living: bool = False, extra: dict | None = None) -> dict:
    n = config.now_local()
    date = n.strftime("%Y-%m-%d")
    did = f"{date}-{kind}" + (f"-{slug(title_extra)}" if title_extra else "")
    title = f"{TITLES[kind]}{': ' + title_extra if title_extra else ''}, {n.strftime('%a %b %-d')}"
    body = re.sub(r"\A\s*#\s[^\n]*\n+", "", body)  # the site shows its own title
    allowed = allowed_sources(items, web=cites, extra=_living_urls() if living else None)
    body, stats = finalize(body, allowed)
    store.write_text(f"digests/{did}.md", body)
    idx = _index()
    idx["entries"] = [e for e in idx["entries"] if e["id"] != did]
    entry = {"id": did, "type": kind, "product": PRODUCT[kind], "date": date, "title": title,
             "file": f"digests/{did}.md", "generated": config.iso(config.now_utc()),
             "item_count": len(items), "high_signal": sum(1 for i in items if i.get("relevance", 0) >= 4),
             "item_ids": [i["id"] for i in items][:200], "curator": curator(), "status": "draft",
             "cut": "internal", **stats, **(extra or {})}
    idx["entries"].insert(0, entry)
    idx["entries"].sort(key=lambda e: e["generated"], reverse=True)
    store.write_json(INDEX, idx)
    print(f"[digest] wrote {did} ({len(items)} items, {stats['sources']} sources, "
          f"{stats['unverified_links_removed']} unverified links removed)")
    return entry


def approve(edition_id: str, by: str) -> dict | None:
    idx = _index()
    if edition_id.lower() in ("latest", ""):
        target = next((e for e in idx["entries"] if e.get("status", "draft") == "draft"), None)
    else:
        target = next((e for e in idx["entries"] if e["id"] == edition_id), None)
    if not target:
        return None
    target.update(status="reviewed", reviewed_by=by, reviewed_at=config.iso(config.now_utc()))
    store.write_json(INDEX, idx)
    return target


def _since_last(products: tuple[str, ...]) -> str:
    for e in _index()["entries"]:
        if e.get("product", PRODUCT.get(e["type"])) in products:
            return e["generated"]
    return config.iso(config.now_utc() - timedelta(hours=24))


def _living_snapshot() -> str:
    wl = store.read_json("living/watchlist.json", {"entries": []})["entries"]
    bk = store.read_json("living/booking.json", {"entries": []})["entries"]
    dash = store.read_json("living/dashboard.json", {"indicators": []})["indicators"]
    cal = store.read_json("living/calendar.json", {"entries": []})["entries"]
    today = config.now_local().strftime("%Y-%m-%d")
    week_ago = (config.now_local() - timedelta(days=7)).strftime("%Y-%m-%d")
    month = (config.now_local() + timedelta(days=30)).strftime("%Y-%m-%d")
    snap = {
        "watchlist_changed_this_week": [
            {"name": e["name"], "status": e["status"], "last": e["history"][-1]}
            for e in wl if e.get("updated", "") >= week_ago],
        "watchlist_size": len(wl),
        "booking_windows_next_30_days": [e for e in bk if (e.get("next_open") or e.get("event_date") or "9999") <= month][:15],
        "dashboard": [{"indicator": d["label"], "readings_count": len(d["readings"]), "last_two": d["readings"][-2:]}
                      for d in dash],
        "calendar_next_14_days": [e for e in cal if e["date"] >= today][:20],
    }
    return json.dumps(snap, ensure_ascii=False)


def _week_items(days: int = 7, min_rel: int = 3) -> list[dict]:
    return [i for i in store.load_recent(days) if i.get("enriched") and i.get("relevance", 0) >= min_rel]


# ---------- Luxury Trends Briefing ----------

def monday(refresh_living: bool = True) -> dict | None:
    s = config.settings()
    if refresh_living:
        living.run_weekly()
    items = _week_items()

    def mock():
        return ("Mock intro line.\n\n## Part 1: Premium card competitive intel\n**Mock Issuer**\n- Mock move\n**Partner:** Resy\n**Take:** Mock take\n\n"
                "## Part 2: Luxury trends\n**Dining**\n- Mock\n\n### NYC dining\n- Mock NYC item\n\n## Part 3: One play to steal\n- Mock play\n\n"
                "## Part 4: Booking windows\n- Mock\n\n## Part 5: Luxury spending dashboard\n- Mock\n\n## Part 6: Partnership watchlist\n- Mock")

    # Step 1: a short, bounded web search pass for NYC dining and gaps (kept separate so the
    # long write below never waits on searches).
    notes, cites = "", []
    try:
        notes, cites = llm.complete(
            model=s["models"]["writer"], system=system_with_context(RESEARCH_PROMPT),
            user=f"{today_line()}\n\nWhat our sweeps already have (do not repeat these):\n{items_block([i for i in items if 'nyc_dining' in i.get('sections', [])], 30)}",
            task="digest_monday_research", max_tokens=2500,
            web_search_uses=s["web_search"]["max_uses"]["monday_digest"],
            mock=lambda: "- Mock NYC research note")
    except Exception as e:
        print(f"[digest] research pass failed, writing from items only: {e}")
    # Step 2: write the briefing from items, living pages and research notes. No tools.
    body, _ = llm.complete(
        model=s["models"]["writer"], system=system_with_context(config.prompt("monday")),
        user=(f"{today_line()}\n\nLiving pages snapshot:\n{_living_snapshot()}\n\n"
              f"Research notes from this morning's web search (use their links):\n{notes or '(none)'}\n\n"
              f"This week's items, strongest first ({len(items)} total, top 90 shown):\n{items_block(items, 90)}"),
        task="digest_monday", max_tokens=9000, mock=mock)
    missing = [n for n in range(1, 7) if not re.search(rf"^##\s*Part {n}\b", body, re.M)]
    if missing:
        print(f"[digest] briefing missing parts {missing}")
        llm.record_error("digest_monday", RuntimeError(f"Briefing came back without Part(s) {missing}; published with a note"))
        body += "\n\n" + "\n\n".join(f"## Part {n}\n_This part did not generate in this run. See the matching page for current data._" for n in missing)
    if len(body.strip()) < 200:
        llm.record_error("digest_monday", RuntimeError(f"Briefing came back empty or too short ({len(body.strip())} chars); not published"))
        print("[digest] monday briefing empty, not publishing")
        radar()
        return None
    entry = _save("monday", body, items, cites, living=True)
    radar()
    return entry


def update() -> dict | None:
    s = config.settings()
    since = _since_last(("briefing",))
    items = [i for i in store.load_recent(4) if i.get("enriched") and i["fetched"] > since
             and (i.get("relevance", 0) >= 4 or i.get("breaking"))]
    if not items:
        print("[digest] briefing update: no high-signal items, publishing nothing")
        return None

    def mock():
        return "Mock update.\n\n" + "\n".join(f"- **{i['title']}** ([{i['source']}]({i['url']}))" for i in items[:3])

    body, cites = llm.complete(
        model=s["models"]["writer"], system=system_with_context(config.prompt("update")),
        user=f"{today_line()}\n\nNew high-signal items since the last briefing ({len(items)}):\n{items_block(items, 60)}",
        task="digest_update", max_tokens=4000, mock=mock)
    if body.strip().startswith("NOTHING_NEW") or not body.strip():
        print("[digest] briefing update: nothing genuinely new, publishing nothing")
        return None
    return _save("update", body, items, cites)


# ---------- Partnership Sourcing Radar ----------

def _radar_run(kind: str, items: list[dict], prompt_name: str, cap: int) -> dict | None:
    s = config.settings()
    if not items and kind == "radar_update":
        print(f"[radar] {kind}: no candidate items")
        return None

    def mock():
        return {"intro": "Mock radar intro.", "items": [
            {"company": (i.get("companies") or ["Mock Co"])[0], "what": "Mock what", "signal": i["title"][:60],
             "why_fit": "Mock fit", "angle": "Mock angle", "partner_type": "other", "item_id": i["id"], "url": i["url"]}
            for i in items[:min(cap, 3)]]}

    if not items:  # Monday always delivers, even in a thin week
        out, cites = {"intro": "No qualified sourcing signals in this week's items.", "items": []}, []
    else:
        out, cites = llm.complete_json(
            model=s["models"]["writer"],
            system=system_with_context(config.prompt(prompt_name).replace("{cap}", str(cap))),
            user=f"{today_line()}\n\nCandidate items ({len(items)}):\n{items_block(items, 120)}",
            task=f"radar_{kind}", max_tokens=3000, mock=mock)
    ok = allowed_sources(items, web=cites)
    by_id = {i["id"]: i for i in items}
    picks = []
    for r in (out.get("items") or [])[:cap]:
        it = by_id.get(r.get("item_id"))
        url = r.get("url") or (it or {}).get("url")
        if not r.get("company") or not has_source(url, ok):
            continue
        picks.append({**{k: r.get(k) for k in ("company", "what", "signal", "why_fit", "angle", "partner_type")},
                      "item_id": r.get("item_id") if it else None, "url": url,
                      "source": (it or {}).get("source"), "published": (it or {}).get("published"),
                      "relevance": (it or {}).get("relevance")})
    if not picks and kind == "radar_update":
        print("[radar] update: nothing major, publishing nothing")
        return None
    intro = (out.get("intro") or "").strip()
    lines = [intro or "A thin week for sourcing."]
    for p in picks:
        lines.append(f"- **{p['company']}**: {p['what']} ([{p['source'] or 'source'}]({p['url']}))\n"
                     f"  - Signal: {p['signal']}\n  - Why it fits: {p['why_fit']}\n  - Angle: {p['angle']}")
    if not picks:
        lines.append("Nothing cleared the bar this week. Fewer is better than weak fits.")
    entry = _save(kind, "\n\n".join(x for x in lines if x), items, cites, extra={"radar_count": len(picks)})
    rx = store.read_json(RADAR, {"entries": []})
    rx["entries"] = [e for e in rx["entries"] if e["digest_id"] != entry["id"]]
    rx["entries"].insert(0, {"digest_id": entry["id"], "kind": "weekly" if kind == "radar" else "update",
                             "date": entry["date"], "generated": entry["generated"], "intro": intro, "items": picks})
    store.write_json(RADAR, rx)
    print(f"[radar] {kind}: {len(picks)} opportunities")
    return entry


def _radar_candidates(days: int) -> list[dict]:
    return [i for i in _week_items(days) if {"partnerships", "premium_cards", "luxury", "lending"} & set(i.get("sections", []))]


def radar() -> dict | None:
    return _radar_run("radar", _radar_candidates(7), "radar", config.settings()["digests"]["weekly_radar_cap"])


def radar_update() -> dict | None:
    since = _since_last(("radar",))
    items = [i for i in _radar_candidates(4) if i["fetched"] > since and i.get("relevance", 0) >= 4]
    return _radar_run("radar_update", items, "radar_update", 3)


# ---------- Week in Review ----------

def friday() -> dict:
    s = config.settings()
    n = config.now_local()
    monday_start = (n - timedelta(days=n.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    items = [i for i in _week_items() if store.parse_ts(i["published"]) >= monday_start]

    def mock():
        return "Mock week in review.\n\n## Five things that mattered\n- Mock\n\n## What moved\n- Mock\n\n## Watch next week\n- Mock"

    body, cites = llm.complete(
        model=s["models"]["writer"], system=system_with_context(config.prompt("friday")),
        user=(f"{today_line()}\n\nLiving pages snapshot:\n{_living_snapshot()}\n\n"
              f"This week's items ({len(items)}):\n{items_block(items, 140)}"),
        task="digest_friday", max_tokens=6000, mock=mock)
    return _save("friday", body, items, cites, living=True)


# ---------- Earnings recaps ----------

RESEARCH_PROMPT = """Research pass for the Monday Luxury Trends Briefing. Use web search to find what happened in the last 7 days in NYC fine dining (openings, closings, chef moves, hard-to-book tables, reservation release windows, walk-in intel, dining events), plus any major premium credit card benefit launch from Amex, Chase, Capital One, Citi or Bank of America that is not already listed. Keep searches generic. Reply with up to 12 terse bullet notes, each ending with its source as a Markdown link. No intro, no conclusions."""


RECAP_PROMPT = """Write a short earnings recap for {company} ({title}). Focus only on what matters for a card partnerships team: premium and affluent spend trends, card or loyalty program commentary, partnership news, credit quality, and anything said about benefits, travel, dining or luxury demand. 5 to 8 bullets, each with a source link. Use web search to find the results and call commentary. Keep searches generic. If results are not out yet, reply with exactly: NOT_YET"""


def earnings_recaps(max_per_run: int = 3) -> None:
    s = config.settings()
    cal = store.read_json("living/calendar.json", {"entries": []})
    today = config.now_local().strftime("%Y-%m-%d")
    window = (config.now_local() - timedelta(days=3)).strftime("%Y-%m-%d")
    due = [e for e in cal["entries"] if e.get("type") == "earnings" and window <= e["date"] < today
           and not e.get("recapped")][:max_per_run]
    for e in due:
        company = e.get("company") or e["title"]
        body, cites = llm.complete(
            model=s["models"]["writer"],
            system=system_with_context(RECAP_PROMPT.format(company=company, title=e["title"])),
            user=today_line(), task="earnings_recap", max_tokens=1500, web_search_uses=3,
            mock=lambda c=company: f"- Mock recap for {c}")
        if body.strip() == "NOT_YET":
            continue
        related = [i for i in store.load_recent(4) if company in (i.get("companies") or [])]
        _save("earnings", body, related, cites, title_extra=company)
        e["recapped"] = True
    if due:
        store.write_json("living/calendar.json", cal)


def weekday() -> None:
    """Tue to Fri morning: conditional briefing and radar updates (publish nothing when quiet)."""
    update()
    radar_update()
    earnings_recaps()


def auto() -> None:
    wd = config.now_local().weekday()
    if wd == 0:
        monday()
    elif 1 <= wd <= 4:
        weekday()
    else:
        print("[digest] weekend, nothing to do")


daily = weekday  # back compat for `digest daily`
