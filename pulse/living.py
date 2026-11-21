"""Living pages: watchlist, competitor benefits, booking windows, spending dashboard, calendar.

These carry forward week to week. Watchlist and benefits are updated from the
week's items (no web search). Booking, dashboard and calendar use a small web
search allowance once a week.
"""
from __future__ import annotations

import json
from datetime import timedelta

from . import config, llm, store
from .common import allowed_sources, canon_company, has_source, items_block, slug, system_with_context, today_line

INDICATORS = [
    {"id": "citi_luxury_spend", "label": "US luxury credit card spend (Citi)", "unit": "% YoY"},
    {"id": "olshan_4m", "label": "Manhattan $4M+ contracts signed (Olshan, weekly)", "unit": "contracts"},
    {"id": "auction_sell_through", "label": "Major auction sell-through rate", "unit": "%"},
    {"id": "earn_lvmh", "label": "LVMH organic revenue growth", "unit": "% YoY"},
    {"id": "earn_hermes", "label": "Hermes organic revenue growth", "unit": "% YoY"},
    {"id": "earn_kering", "label": "Kering comparable revenue growth", "unit": "% YoY"},
    {"id": "earn_richemont", "label": "Richemont constant currency sales growth", "unit": "% YoY"},
]

CAL_COMPANIES = ("American Express, JPMorgan Chase, Capital One, Citi, Bank of America, Wells Fargo, "
                 "Synchrony, Discover, Visa, Mastercard, Affirm, Klarna, SoFi, LVMH, Hermes, Kering, "
                 "Richemont, Tapestry, Capri, Prada, Moncler, Burberry")


def _week_items(sections: set[str] | None = None, days: int = 7, min_rel: int = 3) -> list[dict]:
    items = [i for i in store.load_recent(days) if i.get("enriched") and i.get("relevance", 0) >= min_rel]
    if sections:
        items = [i for i in items if sections & set(i.get("sections", []))]
    return items


def _today() -> str:
    return config.now_local().strftime("%Y-%m-%d")


# ---------- watchlist ----------

def refresh_watchlist() -> None:
    s = config.settings()
    wl = store.read_json("living/watchlist.json", {"entries": []})
    items = _week_items({"partnerships", "premium_cards", "luxury", "nyc_dining", "lending"})
    if not items:
        print("[living] watchlist: no items")
        return
    current = [{"name": e["name"], "status": e["status"], "category": e.get("category")} for e in wl["entries"]]

    def mock():
        cands = [c for i in items for c in i.get("companies", []) if c not in {e["name"] for e in wl["entries"]}]
        return {"add": [{"name": c, "category": "other", "what": "Mock entry", "why_fit": "Mock fit",
                         "status": "emerging", "note": "Seen in this week's items", "url": items[0]["url"]}
                        for c in list(dict.fromkeys(cands))[:3]], "update": []}

    out, cites = llm.complete_json(
        model=s["models"]["writer"], system=system_with_context(config.prompt("living_watchlist")),
        user=f"{today_line()}\n\nCurrent watchlist:\n{json.dumps(current)}\n\nThis week's items:\n{items_block(items, 120)}",
        task="living_watchlist", max_tokens=3000, mock=mock)
    by_name = {e["name"].lower(): e for e in wl["entries"]}
    today = _today()
    ok = allowed_sources(items, web=cites)
    dropped = 0
    for a in out.get("add", []):
        name = canon_company(a.get("name", ""))
        if not name or name.lower() in by_name:
            continue
        if not has_source(a.get("url"), ok):
            dropped += 1
            continue
        e = {"name": name, "slug": slug(name), "category": a.get("category"), "what": a.get("what"),
             "why_fit": a.get("why_fit"), "status": a.get("status", "emerging"), "added": today,
             "updated": today, "history": [{"date": today, "status": a.get("status", "emerging"),
                                             "note": a.get("note"), "url": a.get("url")}]}
        wl["entries"].append(e)
        by_name[name.lower()] = e
    for u in out.get("update", []):
        e = by_name.get(canon_company(u.get("name", "")).lower())
        if not e or not has_source(u.get("url"), ok):
            dropped += 1 if e else 0
            continue
        e["status"] = u.get("status") or e["status"]
        e["updated"] = today
        e["history"].append({"date": today, "status": e["status"], "note": u.get("note"), "url": u.get("url")})
    wl["updated"] = config.iso(config.now_utc())
    store.write_json("living/watchlist.json", wl)
    print(f"[living] watchlist: {len(out.get('add', []))} adds, {len(out.get('update', []))} updates, {dropped} dropped (no verified source)")


# ---------- competitor benefits ----------

def _bkey(e: dict) -> str:
    return "|".join(slug(str(e.get(k) or "")) for k in ("issuer", "card", "benefit"))


def refresh_benefits() -> None:
    s = config.settings()
    bt = store.read_json("living/benefits.json", {"entries": []})
    items = _week_items({"premium_cards", "community", "partnerships"})
    if not items:
        print("[living] benefits: no items")
        return
    current = [{k: e.get(k) for k in ("issuer", "card", "benefit", "partner", "status")} for e in bt["entries"]]

    def mock():
        return {"add": [{"issuer": (i.get("companies") or ["Issuer"])[0], "card": "Mock Card",
                         "benefit": i["title"][:40], "partner": None, "category": "other",
                         "status": "announced", "announced": i["published"][:10], "note": "Mock",
                         "url": i["url"]} for i in items[:2]], "update": []}

    out, cites = llm.complete_json(
        model=s["models"]["writer"], system=system_with_context(config.prompt("living_benefits")),
        user=f"{today_line()}\n\nCurrent tracker:\n{json.dumps(current)}\n\nThis week's items:\n{items_block(items, 120)}",
        task="living_benefits", max_tokens=3000, mock=mock)
    idx = {_bkey(e): e for e in bt["entries"]}
    today = _today()
    ok = allowed_sources(items, web=cites)
    dropped = 0
    for a in out.get("add", []):
        a["issuer"] = canon_company(a.get("issuer") or "")
        k = _bkey(a)
        if not a["issuer"] or k in idx:
            continue
        if not has_source(a.get("url"), ok):
            dropped += 1
            continue
        a["added"] = today
        a["updated"] = today
        bt["entries"].append(a)
        idx[k] = a
    for u in out.get("update", []):
        u["issuer"] = canon_company(u.get("issuer") or "")
        e = idx.get(_bkey(u))
        if e and has_source(u.get("url"), ok):
            e.update({k: v for k, v in u.items() if v})
            e["updated"] = today
    bt["updated"] = config.iso(config.now_utc())
    store.write_json("living/benefits.json", bt)
    print(f"[living] benefits: {len(out.get('add', []))} adds, {len(out.get('update', []))} updates, {dropped} dropped (no verified source)")


# ---------- booking windows ----------

def refresh_booking() -> None:
    s = config.settings()
    cur = store.read_json("living/booking.json", {"entries": []})
    items = _week_items({"nyc_dining", "luxury"}, days=14)

    def mock():
        return cur["entries"] or [{"name": "Mock Restaurant", "type": "restaurant", "location": "New York",
                                   "window": "Mock window", "next_open": None, "event_date": None,
                                   "cadence": None, "url": items[0]["url"] if items else "https://example.com", "note": None}]

    out, cites = llm.complete_json(
        model=s["models"]["writer"], system=system_with_context(config.prompt("living_booking")),
        user=f"{today_line()}\n\nCurrent list:\n{json.dumps(cur['entries'])}\n\nRecent items:\n{items_block(items, 60)}",
        task="living_booking", max_tokens=12000,
        web_search_uses=s["web_search"]["max_uses"]["living_booking"], mock=mock)
    today = _today()
    ok = allowed_sources(items, web=cites, extra=[{"url": e.get("url")} for e in cur["entries"]])
    keep = [e for e in out if isinstance(e, dict) and e.get("name") and has_source(e.get("url"), ok)
            and not (e.get("event_date") and e["event_date"] < today and not e.get("next_open"))]
    store.write_json("living/booking.json", {"updated": config.iso(config.now_utc()), "entries": keep[:30]})
    print(f"[living] booking: {len(keep)} entries")


# ---------- luxury spending dashboard ----------

def refresh_dashboard() -> None:
    s = config.settings()
    dash = store.read_json("living/dashboard.json", {"indicators": []})
    by_id = {d["id"]: d for d in dash["indicators"]}
    for ind in INDICATORS:  # keep config and stored indicators in sync
        by_id.setdefault(ind["id"], {**ind, "readings": []}).update(
            {"label": ind["label"], "unit": ind["unit"]})
    latest = {i: (d["readings"][-1] if d["readings"] else None) for i, d in by_id.items()}
    items = _week_items({"spending_data", "luxury"}, days=14)
    ind_text = "\n".join(f"- {i['id']}: {i['label']} ({i['unit']})" for i in INDICATORS)

    def mock():
        return [{"indicator": "olshan_4m", "period": config.now_local().strftime("%Y-W%V"),
                 "date": _today(), "value": 30 + len(by_id["olshan_4m"]["readings"]),
                 "display": "Mock reading", "note": "Mock", "url": items[0]["url"] if items else "https://example.com"}]

    out, cites = llm.complete_json(
        model=s["models"]["writer"],
        system=system_with_context(config.prompt("living_dashboard").replace("{indicators}", ind_text)),
        user=f"{today_line()}\n\nLatest stored readings:\n{json.dumps(latest)}\n\nRecent items:\n{items_block(items, 60)}",
        task="living_dashboard", max_tokens=3000,
        web_search_uses=s["web_search"]["max_uses"]["living_dashboard"], mock=mock)
    added = 0
    ok = allowed_sources(items, web=cites)
    for r in out if isinstance(out, list) else []:
        d = by_id.get(r.get("indicator"))
        if not d or not r.get("period") or not has_source(r.get("url"), ok):
            continue
        if any(x["period"] == r["period"] for x in d["readings"]):
            continue
        v = r.get("value")
        d["readings"].append({"period": r["period"], "date": r.get("date"),
                              "value": float(v) if isinstance(v, (int, float)) else None,
                              "display": r.get("display"), "note": r.get("note"), "url": r.get("url"),
                              "added": _today()})
        d["readings"].sort(key=lambda x: x.get("date") or x["period"])
        added += 1
    dash = {"updated": config.iso(config.now_utc()),
            "indicators": [by_id[i["id"]] for i in INDICATORS]}
    store.write_json("living/dashboard.json", dash)
    print(f"[living] dashboard: {added} new readings")


# ---------- calendar ----------

def refresh_calendar() -> None:
    s = config.settings()
    cal = store.read_json("living/calendar.json", {"entries": []})
    items = _week_items(None, days=7, min_rel=3)
    items = [i for i in items if any(w in i["title"].lower() for w in ("earnings", "results", "report", "quarter", "deadline", "rule", "launch"))]

    def mock():
        return [{"date": (config.now_local() + timedelta(days=10)).strftime("%Y-%m-%d"),
                 "title": "Mock earnings", "type": "earnings", "company": "American Express",
                 "url": items[0]["url"] if items else "https://example.com", "confirmed": False}]

    out, cites = llm.complete_json(
        model=s["models"]["writer"],
        system=system_with_context(config.prompt("living_calendar").replace("{companies}", CAL_COMPANIES)),
        user=f"{today_line()}\n\nCurrent calendar:\n{json.dumps(cal['entries'])}\n\nRecent items:\n{items_block(items, 40)}",
        task="living_calendar", max_tokens=10000,
        web_search_uses=s["web_search"]["max_uses"]["living_calendar"], mock=mock)
    today = config.now_local().date()
    past = [e for e in cal["entries"] if e.get("date") and e["date"] < str(today)
            and e["date"] >= str(today - timedelta(days=14))]
    ok = allowed_sources(items, web=cites, extra=[{"url": e.get("url")} for e in cal["entries"]])
    upcoming = [e for e in out if isinstance(e, dict) and e.get("date") and e["date"] >= str(today)
                and has_source(e.get("url"), ok)]
    entries = sorted(past + upcoming, key=lambda e: e["date"])
    store.write_json("living/calendar.json", {"updated": config.iso(config.now_utc()), "entries": entries})
    print(f"[living] calendar: {len(upcoming)} upcoming")


def run_weekly() -> None:
    for fn in (refresh_watchlist, refresh_benefits, refresh_booking, refresh_dashboard, refresh_calendar):
        try:
            fn()
        except Exception as e:  # one page failing should not block the rest
            print(f"[living] {fn.__name__} failed: {type(e).__name__}: {e}")
            errs = store.read_json("manifest.json", {}).get("living_errors", {})
            errs[fn.__name__] = {"error": f"{type(e).__name__}: {str(e)[:200]}", "at": config.iso(config.now_utc())}
            store.update_manifest(living_errors=errs)
            continue
        errs = store.read_json("manifest.json", {}).get("living_errors", {})
        if errs.pop(fn.__name__, None) is not None:
            store.update_manifest(living_errors=errs)
