"""Tag new items with sections, companies, relevance and a why-it-matters line."""
from __future__ import annotations

import json
import re

from . import config, llm, store


def _section_block() -> str:
    return "\n".join(f"- {s['id']}: {s['label']}. {' '.join(s['description'].split())}"
                     for s in config.taxonomy()["sections"])


def _company_block() -> str:
    groups = config.taxonomy()["watch_companies"]
    return ", ".join(c for g in groups.values() for c in g)


def known_companies() -> list[str]:
    return [c for g in config.taxonomy()["watch_companies"].values() for c in g]


def _mock_tags(batch: list[dict]) -> list[dict]:
    """Deterministic offline tagging so the pipeline can be tested without the API."""
    comps = known_companies()
    out = []
    for i, it in enumerate(batch):
        text = f"{it['title']} {it.get('summary', '')}"
        found = [c for c in comps if re.search(r"\b" + re.escape(c) + r"\b", text, re.I)][:5]
        secs = [it["hint"]] if it.get("hint") else []
        if any(c in found for c in ("Wells Fargo",)) and "wells" not in secs:
            secs.append("wells")
        rel = 5 if "launch" in text.lower() else (4 if found else 3 if secs else 2)
        out.append({
            "id": it["id"], "sections": secs,
            "subcategory": "dining" if "restaurant" in text.lower() else None,
            "companies": found, "relevance": rel, "breaking": rel == 5 and i % 4 == 0,
            "why": "Mock tag: relevant to premium card partnership strategy.",
            "data_points": re.findall(r"\$[\d,.]+[MBK]?(?: billion| million)?", text)[:3],
        })
    return out


def _apply(it: dict, tag: dict, valid: set[str]) -> None:
    it["sections"] = [s for s in (tag.get("sections") or []) if s in valid][:3]
    it["subcategory"] = tag.get("subcategory")
    it["companies"] = [c.strip() for c in (tag.get("companies") or []) if c and c.strip()][:5]
    try:
        it["relevance"] = max(1, min(5, int(tag.get("relevance", 2))))
    except (TypeError, ValueError):
        it["relevance"] = 2
    it["breaking"] = bool(tag.get("breaking")) and it["relevance"] >= 4
    it["why"] = (tag.get("why") or "").strip()
    it["data_points"] = [str(d) for d in (tag.get("data_points") or [])][:3]
    it["enriched"] = True
    # Publisher snippets are only used as tagging input; do not republish them on the site.
    it["summary"] = ""


def run(limit: int | None = None) -> int:
    pending = [i for i in store.load_recent(8) if not i.get("enriched")]
    pending.sort(key=lambda x: x["published"], reverse=True)
    if limit:
        pending = pending[:limit]
    if not pending:
        print("[enrich] nothing to tag")
        return 0
    s = config.settings()
    system = (config.prompt("enrich")
              .replace("{sections}", _section_block())
              .replace("{companies}", _company_block()))
    valid = set(config.section_ids())
    size = s["enrich"]["batch_size"]
    done = 0
    for start in range(0, len(pending), size):
        batch = pending[start : start + size]
        payload = [{"id": i["id"], "title": i["title"], "source": i["source"],
                    "summary": i.get("summary", "")[:300], "hint": i.get("hint")} for i in batch]
        try:
            tags, _ = llm.complete_json(
                model=s["models"]["enrich"], system=system,
                user="Items:\n" + json.dumps(payload, ensure_ascii=False),
                task="enrich", max_tokens=6000, mock=lambda b=batch: _mock_tags(b))
        except Exception as e:
            print(f"[enrich] batch failed, will retry next sweep: {e}")
            continue
        by_id = {t.get("id"): t for t in tags if isinstance(t, dict)}
        for it in batch:
            if it["id"] in by_id:
                _apply(it, by_id[it["id"]], valid)
                done += 1
        store.save_items(batch)
    print(f"[enrich] tagged {done}/{len(pending)}")
    return done
