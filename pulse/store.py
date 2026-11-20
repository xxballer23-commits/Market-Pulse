"""JSON storage under docs/data. Everything the site reads lives here."""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import config


def path(*parts: str) -> Path:
    p = config.DATA_DIR.joinpath(*parts)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def read_json(rel: str, default: Any) -> Any:
    p = path(rel)
    if not p.exists():
        return default
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return default


def write_json(rel: str, data: Any) -> None:
    p = path(rel)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False, sort_keys=False))
    tmp.replace(p)


def write_text(rel: str, text: str) -> None:
    path(rel).write_text(text)


def read_text(rel: str, default: str = "") -> str:
    p = path(rel)
    return p.read_text() if p.exists() else default


# ---------- items (sharded by month of publish date) ----------

def _month_key(iso_ts: str) -> str:
    return iso_ts[:7]


def months_on_disk() -> list[str]:
    d = config.DATA_DIR / "items"
    if not d.exists():
        return []
    return sorted(p.stem for p in d.glob("*.json"))


def load_month(month: str) -> list[dict]:
    return read_json(f"items/{month}.json", [])


def load_recent(days: int) -> list[dict]:
    cutoff = config.now_utc() - timedelta(days=days)
    months = set()
    d = cutoff
    while d <= config.now_utc() + timedelta(days=1):
        months.add(d.strftime("%Y-%m"))
        d += timedelta(days=27)
    months.add(config.now_utc().strftime("%Y-%m"))
    out = []
    for m in sorted(months):
        for it in load_month(m):
            if parse_ts(it["published"]) >= cutoff:
                out.append(it)
    return out


def save_items(items: list[dict]) -> None:
    """Upsert items into their month shards."""
    by_month: dict[str, dict[str, dict]] = {}
    for it in items:
        m = _month_key(it["published"])
        if m not in by_month:
            by_month[m] = {x["id"]: x for x in load_month(m)}
        by_month[m][it["id"]] = it
    for m, idx in by_month.items():
        rows = sorted(idx.values(), key=lambda x: x["published"], reverse=True)
        write_json(f"items/{m}.json", rows)


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def rebuild_feed() -> None:
    """feed.json: the recent window the site loads first. manifest.json: what exists."""
    days = config.settings()["collect"]["feed_days"]
    items = [i for i in load_recent(days) if i.get("enriched")]
    items.sort(key=lambda x: x["published"], reverse=True)
    write_json("feed.json", items)
    manifest = read_json("manifest.json", {})
    manifest["months"] = months_on_disk()
    manifest["feed_days"] = days
    manifest["feed_count"] = len(items)
    manifest["sections"] = [
        {"id": s["id"], "label": s["label"]} for s in config.taxonomy()["sections"]
    ]
    manifest["site"] = config.settings()["site"]
    write_json("manifest.json", manifest)


def update_manifest(**kv: Any) -> None:
    m = read_json("manifest.json", {})
    m.update(kv)
    write_json("manifest.json", m)
