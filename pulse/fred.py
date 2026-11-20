"""Pull FRED series (public CSV endpoint, no API key) for the credit dashboard."""
from __future__ import annotations

import csv
import io
from datetime import timedelta

import requests

from . import config, store

URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}&cosd=2015-01-01"


def run(force: bool = False) -> None:
    cur = store.read_json("fred.json", {})
    if not force and cur.get("updated"):
        if config.now_utc() - store.parse_ts(cur["updated"]) < timedelta(hours=20):
            print("[fred] fresh, skipping")
            return
    old = {s["id"]: s for s in cur.get("series", [])}
    out = []
    for s in config.sources().get("fred", []):
        try:
            r = requests.get(URL.format(id=s["id"]), timeout=30,
                             headers={"User-Agent": config.settings()["collect"]["user_agent"]})
            r.raise_for_status()
            rows = list(csv.reader(io.StringIO(r.text)))[1:]
            pts = [[d, float(v)] for d, v in rows if v not in ("", ".")]
            out.append({**s, "points": pts, "ok": True})
        except Exception as e:
            print(f"[fred] {s['id']} failed: {e}")
            prev = old.get(s["id"], {**s, "points": []})
            out.append({**prev, "ok": False})
    store.write_json("fred.json", {"updated": config.iso(config.now_utc()), "series": out})
    print(f"[fred] {sum(1 for s in out if s['ok'])}/{len(out)} series updated")
