"""Tag new items: sections, companies, relevance, summary, Take/Read, partner, benefit move,
confidence and key-fact chips. Bump ENRICH_VERSION to re-tag recent items with a new schema."""
from __future__ import annotations

import json
import re

from . import config, llm, store

ENRICH_VERSION = 2
LOW_GRADE_SOURCES = ("reddit", "r/", "forum", "flyertalk", "quora")


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
            "summary": f"Mock summary of {it['title'][:40]}.",
            "take_kind": "take" if rel >= 4 else "read", "take": "Mock take for the BD team.",
            "partner": "Resy" if "Resy" in text else None,
            "benefit_move": "benefit" in text.lower(), "benefit_type": "dining" if "dining" in text.lower() else None,
            "issuer": found[0] if found and "benefit" in text.lower() else None,
            "confidence": "low" if "rumor" in text.lower() else "ok", "confidence_reason": None,
            "nyc": {"venue": "Mock Venue", "neighborhood": "SoHo", "kind": "opening", "booking": "Resy, 30 days out"} if it.get("hint") == "nyc_dining" else None,
            "data_points": re.findall(r"\$[\d,.]+[MBK]?(?: billion| million)?", text)[:4],
        })
    return out


def _txt(v, limit: int = 300) -> str | None:
    if not isinstance(v, str):
        return None
    v = v.replace("\u2014", ", ").replace("\u2013", "-").strip()
    return v[:limit] or None


def _apply(it: dict, tag: dict, valid: set[str]) -> None:
    it["sections"] = [s for s in (tag.get("sections") or []) if s in valid][:3]
    it["subcategory"] = tag.get("subcategory")
    it["companies"] = [c.strip() for c in (tag.get("companies") or []) if isinstance(c, str) and c.strip()][:5]
    try:
        it["relevance"] = max(1, min(5, int(tag.get("relevance", 2))))
    except (TypeError, ValueError):
        it["relevance"] = 2
    it["breaking"] = bool(tag.get("breaking")) and it["relevance"] >= 4
    it["summary_ai"] = _txt(tag.get("summary"))
    kind = tag.get("take_kind")
    it["take_kind"] = kind if kind in ("take", "read") else None
    it["take"] = _txt(tag.get("take")) if it["take_kind"] else None
    it["why"] = it["take"] or it["summary_ai"] or _txt(tag.get("why")) or ""
    it["partner"] = _txt(tag.get("partner"), 80)
    it["benefit_move"] = bool(tag.get("benefit_move"))
    it["benefit_type"] = _txt(tag.get("benefit_type"), 30) if it["benefit_move"] else None
    it["issuer"] = _txt(tag.get("issuer"), 60) if it["benefit_move"] else None
    nyc = tag.get("nyc")
    it["nyc"] = {k: _txt(nyc.get(k), 120) for k in ("venue", "neighborhood", "kind", "booking")} \
        if isinstance(nyc, dict) and "nyc_dining" in it["sections"] else None
    it["data_points"] = [str(d).strip() for d in (tag.get("data_points") or []) if str(d).strip()][:4]
    # Confidence: the model's judgment plus a mechanical check for thin sourcing.
    reasons = []
    if tag.get("confidence") == "low":
        reasons.append(_txt(tag.get("confidence_reason"), 80) or "Unconfirmed")
    src = (it.get("source") or "").lower()
    if not it.get("also") and any(k in src for k in LOW_GRADE_SOURCES):
        reasons.append("Single community source")
    it["low_confidence"] = "; ".join(dict.fromkeys(reasons)) or None
    it["enriched"] = True
    it["enrich_v"] = ENRICH_VERSION
    # Publisher snippets are only used as tagging input; do not republish them on the site.
    it["summary"] = ""


def run(limit: int | None = None) -> int:
    recent = store.load_recent(8)
    fresh = sorted((i for i in recent if not i.get("enriched")), key=lambda x: x["published"], reverse=True)
    stale = sorted((i for i in recent if i.get("enriched") and i.get("enrich_v", 1) < ENRICH_VERSION),
                   key=lambda x: (x.get("relevance", 0), x["published"]), reverse=True)
    pending = fresh + stale
    limit = limit or config.settings()["enrich"].get("max_per_run", 400)
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
    batches = [pending[i : i + size] for i in range(0, len(pending), size)]

    def tag(batch: list[dict]) -> int:
        payload = [{"id": i["id"], "title": i["title"], "source": i["source"],
                    "summary": i.get("summary", "")[:300], "hint": i.get("hint")} for i in batch]
        try:
            tags, _ = llm.complete_json(
                model=s["models"]["enrich"], system=system,
                user="Items:\n" + json.dumps(payload, ensure_ascii=False),
                task="enrich", max_tokens=8000, mock=lambda b=batch: _mock_tags(b))
        except Exception as e:
            print(f"[enrich] batch failed, will retry next sweep: {type(e).__name__}: {e}")
            return 0
        by_id = {t.get("id"): t for t in tags if isinstance(t, dict)}
        n = 0
        for it in batch:
            if it["id"] in by_id:
                _apply(it, by_id[it["id"]], valid)
                n += 1
        return n

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=s["enrich"].get("parallel", 4)) as ex:
        done = sum(ex.map(tag, batches))
    store.save_items([i for b in batches for i in b])
    print(f"[enrich] tagged {done}/{len(pending)}")
    return done
