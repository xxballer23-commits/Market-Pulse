"""Sweep every source, normalize, dedupe and store new items (un-enriched)."""
from __future__ import annotations

import hashlib
import html
import re
from calendar import timegm
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, quote_plus, urlencode, urlsplit, urlunsplit

import feedparser
import requests

from . import config, store

STOP = set("""a an the and or of to in on for with at by from as is are was were be been it its this that
these those new how why what who will can into over after about than more most says said year week
inc corp co ltd""".split())


def norm_url(url: str) -> str:
    parts = urlsplit(url.strip())
    q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
         if not k.lower().startswith(("utm_", "fbclid", "gclid", "mc_", "cmp", "mod"))]
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path, urlencode(q), ""))


def item_id(url: str) -> str:
    return hashlib.sha1(norm_url(url).encode()).hexdigest()[:12]


def tokens(title: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", title.lower()) if len(w) > 2 and w not in STOP}


def similar(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def clean_text(s: str, limit: int = 400) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = html.unescape(re.sub(r"\s+", " ", s)).strip()
    return s[:limit]


def gnews_url(q: str) -> str:
    return ("https://news.google.com/rss/search?q=" + quote_plus(q + " when:2d")
            + "&hl=en-US&gl=US&ceid=US:en")


def _entry_time(e) -> datetime | None:
    t = e.get("published_parsed") or e.get("updated_parsed")
    if not t:
        return None
    return datetime.fromtimestamp(timegm(t), tz=timezone.utc)


def fetch_feed(src: dict) -> tuple[dict, list[dict]]:
    s = config.settings()["collect"]
    health = {"name": src["name"], "url": src["url"], "type": src["type"], "ok": False,
              "count": 0, "error": None}
    try:
        r = requests.get(src["url"], timeout=s["request_timeout_seconds"],
                         headers={"User-Agent": s["user_agent"]})
        r.raise_for_status()
        parsed = feedparser.parse(r.content)
        if parsed.bozo and not parsed.entries:
            raise ValueError(f"unparseable feed: {parsed.bozo_exception}")
    except Exception as e:
        health["error"] = f"{type(e).__name__}: {str(e)[:160]}"
        return health, []

    cutoff = config.now_utc() - timedelta(hours=s["max_age_hours"])
    out = []
    for e in parsed.entries[:60]:
        link = e.get("link")
        title = clean_text(e.get("title", ""), 300)
        if not link or not title:
            continue
        ts = _entry_time(e) or config.now_utc()
        if ts < cutoff:
            continue
        source_name = src["name"]
        if src["type"] == "gnews":
            pub = (e.get("source") or {}).get("title")
            if pub:
                source_name = pub
                title = re.sub(r"\s+-\s+" + re.escape(pub) + r"$", "", title)
        out.append({
            "id": item_id(link),
            "url": link,
            "title": title,
            "source": source_name,
            "via": src["name"] if src["type"] == "gnews" else None,
            "source_type": src["type"],
            "published": config.iso(min(ts, config.now_utc())),
            "fetched": config.iso(config.now_utc()),
            "summary": clean_text(e.get("summary", "")) if src["type"] != "gnews" else "",
            "hint": src.get("hint"),
            "also": [],
            "enriched": False,
        })
    health["ok"] = True
    health["count"] = len(out)
    return health, out


def all_sources() -> list[dict]:
    src = config.sources()
    rows = [{**r, "type": "rss"} for r in src.get("rss", [])]
    for g in src.get("google_news", []):
        rows.append({"name": f"Google News: {g['q'][:60]}", "url": gnews_url(g["q"]),
                     "hint": g.get("hint"), "type": "gnews"})
    return rows


def sweep() -> dict:
    sources = all_sources()
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch_feed, sources))

    existing = store.load_recent(7)
    by_id = {i["id"]: i for i in existing}
    known = [(tokens(i["title"]), i) for i in existing]
    threshold = config.settings()["collect"]["dedupe_threshold"]

    new_items: list[dict] = []
    touched: dict[str, dict] = {}
    health = []
    for h, items in results:
        health.append(h)
        for it in items:
            if it["id"] in by_id:
                continue
            tk = tokens(it["title"])
            dup = next((k for t, k in known if similar(tk, t) >= threshold), None)
            if dup is not None:
                if dup.get("source_type") == "gnews" and it["source_type"] == "rss":
                    # Swap so the headline links to the original publisher, not the aggregator copy.
                    dup["also"].append({"source": dup["source"], "url": dup["url"]})
                    dup.update(url=it["url"], source=it["source"], source_type="rss", via=None)
                    touched[dup["id"]] = dup
                elif dup["source"] != it["source"] and all(a["source"] != it["source"] for a in dup["also"]):
                    dup["also"].append({"source": it["source"], "url": it["url"]})
                    touched[dup["id"]] = dup
                continue
            by_id[it["id"]] = it
            known.append((tk, it))
            new_items.append(it)

    store.save_items(new_items + list(touched.values()))
    prev = {h["name"]: h for h in store.read_json("source_health.json", {"sources": []})["sources"]}
    now = config.iso(config.now_utc())
    for h in health:
        p = prev.get(h["name"], {})
        h["last_ok"] = now if h["ok"] else p.get("last_ok")
        h["fail_streak"] = 0 if h["ok"] else p.get("fail_streak", 0) + 1
    store.write_json("source_health.json", {"checked": now, "sources": health})
    ok = sum(1 for h in health if h["ok"])
    print(f"[collect] {ok}/{len(health)} sources ok, {len(new_items)} new, {len(touched)} merged")
    return {"new": len(new_items), "merged": len(touched), "sources_ok": ok, "sources": len(health)}
