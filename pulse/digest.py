"""Written digests: daily brief (Tue to Fri), Monday weekly edition, Friday week in review,
and short earnings recaps after scheduled earnings dates."""
from __future__ import annotations

import json
from datetime import timedelta

from . import config, living, llm, store
from .common import allowed_sources, finalize, items_block, slug, system_with_context, today_line

INDEX = "digests/index.json"

TITLES = {
    "daily": "Daily Brief",
    "monday": "Monday Weekly Edition",
    "friday": "Week in Review",
    "earnings": "Earnings Recap",
}


def _index() -> dict:
    return store.read_json(INDEX, {"entries": []})


def _living_urls() -> list[dict]:
    out = []
    for f, key in (("watchlist", "entries"), ("benefits", "entries"), ("booking", "entries"), ("calendar", "entries")):
        for e in store.read_json(f"living/{f}.json", {key: []})[key]:
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
          quiet: bool = False, living: bool = False) -> dict:
    n = config.now_local()
    date = n.strftime("%Y-%m-%d")
    did = f"{date}-{kind}" + (f"-{slug(title_extra)}" if title_extra else "")
    title = f"{TITLES[kind]}{': ' + title_extra if title_extra else ''}, {n.strftime('%a %b %-d')}"
    allowed = allowed_sources(items, web=cites, extra=_living_urls() if living else None)
    body, stats = finalize(body, allowed)
    store.write_text(f"digests/{did}.md", body)
    idx = _index()
    idx["entries"] = [e for e in idx["entries"] if e["id"] != did]
    entry = {"id": did, "type": kind, "date": date, "title": title, "file": f"digests/{did}.md",
             "generated": config.iso(config.now_utc()), "item_count": len(items), "quiet": quiet,
             "item_ids": [i["id"] for i in items][:200], **stats}
    idx["entries"].insert(0, entry)
    idx["entries"].sort(key=lambda e: e["generated"], reverse=True)
    store.write_json(INDEX, idx)
    print(f"[digest] wrote {did} ({len(items)} items, {stats['sources']} sources, "
          f"{stats['unverified_links_removed']} unverified links removed)")
    return entry


def _since_last() -> str:
    idx = _index()
    regular = [e for e in idx["entries"] if e["type"] in ("daily", "monday")]
    if regular:
        return regular[0]["generated"]
    return config.iso(config.now_utc() - timedelta(hours=24))


def _living_snapshot() -> str:
    wl = store.read_json("living/watchlist.json", {"entries": []})["entries"]
    bt = store.read_json("living/benefits.json", {"entries": []})["entries"]
    bk = store.read_json("living/booking.json", {"entries": []})["entries"]
    dash = store.read_json("living/dashboard.json", {"indicators": []})["indicators"]
    cal = store.read_json("living/calendar.json", {"entries": []})["entries"]
    week_ago = (config.now_local() - timedelta(days=7)).strftime("%Y-%m-%d")
    snap = {
        "watchlist_changed_this_week": [
            {"name": e["name"], "status": e["status"], "last": e["history"][-1]}
            for e in wl if e.get("updated", "") >= week_ago],
        "watchlist_size": len(wl),
        "benefits_new_or_updated_this_week": [e for e in bt if e.get("updated", "") >= week_ago],
        "booking_windows": bk[:12],
        "dashboard": [{"indicator": d["label"], "last_two": d["readings"][-2:]} for d in dash],
        "calendar_next_14_days": [e for e in cal if e["date"] >= config.now_local().strftime("%Y-%m-%d")][:20],
    }
    return json.dumps(snap, ensure_ascii=False)


def daily() -> dict:
    s = config.settings()
    since = _since_last()
    items = [i for i in store.load_recent(4) if i.get("enriched") and i["fetched"] > since
             and (i.get("relevance", 0) >= 3 or i.get("breaking"))]
    quiet = not any(i.get("relevance", 0) >= 4 or i.get("breaking") for i in items)

    def mock():
        lines = "\n".join(f"- **{i['title']}** ([{i['source']}]({i['url']}))\n  {i.get('why', '')}"
                          for i in sorted(items, key=lambda x: -x.get("relevance", 0))[:8])
        return f"Mock daily brief.\n\n## Top items\n{lines or '- Quiet cycle.'}"

    body, cites = llm.complete(
        model=s["models"]["writer"],
        system=system_with_context(config.prompt("daily").replace("{top_n}", str(s["digests"]["daily_top_n"]))),
        user=f"{today_line()}\n\nItems since the last brief ({len(items)}):\n{items_block(items, 80)}",
        task="digest_daily", max_tokens=1500, mock=mock)
    entry = _save("daily", body, items, cites, quiet=quiet)
    earnings_recaps()
    return entry


def monday() -> dict:
    s = config.settings()
    living.run_weekly()
    items = [i for i in store.load_recent(7) if i.get("enriched") and i.get("relevance", 0) >= 3]

    def mock():
        return "Mock Monday edition.\n\n## Part 1: Premium card competitive intel\n- Mock bullet\n\n## Part 2: Luxury trends\n### NYC\n- Mock\n\n## Part 3: One play to steal\n- Mock\n\n## Part 4: Partnership radar\n- Mock\n\n## Part 5: This week on the living pages\n- Mock"

    body, cites = llm.complete(
        model=s["models"]["writer"],
        system=system_with_context(config.prompt("monday").replace("{radar_cap}", str(s["digests"]["weekly_radar_cap"]))),
        user=(f"{today_line()}\n\nLiving pages snapshot:\n{_living_snapshot()}\n\n"
              f"This week's items ({len(items)}):\n{items_block(items, 160)}"),
        task="digest_monday", max_tokens=5000,
        web_search_uses=s["web_search"]["max_uses"]["monday_digest"], mock=mock)
    return _save("monday", body, items, cites, living=True)


def friday() -> dict:
    s = config.settings()
    # Monday 00:00 local of this week
    n = config.now_local()
    monday_start = (n - timedelta(days=n.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    items = [i for i in store.load_recent(7) if i.get("enriched") and i.get("relevance", 0) >= 3
             and store.parse_ts(i["published"]) >= monday_start]

    def mock():
        return "Mock week in review.\n\n## Five things that mattered\n- Mock\n\n## What moved\n- Mock\n\n## Watch next week\n- Mock"

    body, cites = llm.complete(
        model=s["models"]["writer"], system=system_with_context(config.prompt("friday")),
        user=(f"{today_line()}\n\nLiving pages snapshot:\n{_living_snapshot()}\n\n"
              f"This week's items ({len(items)}):\n{items_block(items, 140)}"),
        task="digest_friday", max_tokens=2500, mock=mock)
    return _save("friday", body, items, cites, living=True)


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


def auto() -> dict | None:
    """Pick the right morning digest for today (local time)."""
    wd = config.now_local().weekday()
    if wd == 0:
        return monday()
    if 1 <= wd <= 4:
        return daily()
    print("[digest] weekend, nothing to do")
    return None
