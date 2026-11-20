"""Build company pages from every tagged item in the archive."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import timedelta

from . import config, store
from .common import canon_company, slug


def run() -> None:
    items = [i for m in store.months_on_disk() for i in store.load_month(m) if i.get("enriched")]
    by: dict[str, list[dict]] = defaultdict(list)
    for i in items:
        for c in i.get("companies") or []:
            by[canon_company(c)].append(i)

    wl = {e["name"].lower(): e for e in store.read_json("living/watchlist.json", {"entries": []})["entries"]}
    vets = store.read_json("vet/index.json", {"entries": []})["entries"]
    vet_by = defaultdict(list)
    for v in vets:
        vet_by[v["slug"]].append(v)
    cutoff = config.iso(config.now_utc() - timedelta(days=30))

    rows = []
    for name, its in by.items():
        s = slug(name)
        if not s:
            continue
        its.sort(key=lambda x: x["published"], reverse=True)
        secs = Counter(sec for i in its for sec in i.get("sections", []))
        rows.append({
            "name": name, "slug": s, "count": len(its),
            "count_30d": sum(1 for i in its if i["published"] >= cutoff),
            "first_seen": its[-1]["published"], "last_seen": its[0]["published"],
            "sections": dict(secs.most_common(4)),
            "watch_status": wl.get(name.lower(), {}).get("status"),
            "has_vet": bool(vet_by.get(s)),
        })
        store.write_json(f"companies/{s}.json", {
            "name": name, "slug": s, "watch": wl.get(name.lower()), "vets": vet_by.get(s, []),
            "items": [{k: i.get(k) for k in ("id", "title", "url", "source", "published", "relevance",
                                              "why", "sections", "breaking", "data_points")}
                      for i in its[:300]],
        })
    rows.sort(key=lambda r: (r["count_30d"], r["count"]), reverse=True)
    store.write_json("companies.json", {"updated": config.iso(config.now_utc()), "companies": rows})
    print(f"[companies] {len(rows)} company pages")
