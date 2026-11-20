"""Helpers shared by digests, living pages and vet."""
from __future__ import annotations

import re

from . import config

ALIASES = {
    "amex": "American Express", "american express co": "American Express",
    "jpmorgan": "JPMorgan Chase", "jpmorgan chase & co": "JPMorgan Chase", "jp morgan": "JPMorgan Chase",
    "chase bank": "Chase", "citigroup": "Citi", "citibank": "Citi", "bofa": "Bank of America",
    "wells fargo & co": "Wells Fargo", "wells": "Wells Fargo", "hermès": "Hermes",
    "lvmh moet hennessy louis vuitton": "LVMH", "u.s. bank": "US Bank", "us bancorp": "US Bank",
    "capital one financial": "Capital One", "sotheby’s": "Sotheby's", "christie’s": "Christie's",
}


def canon_company(name: str) -> str:
    n = re.sub(r"\s+", " ", name.strip())
    return ALIASES.get(n.lower(), n)


def slug(s: str) -> str:
    s = s.lower().replace("&", "and").replace("'", "").replace("’", "")
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60]


def item_line(i: dict) -> str:
    parts = [f"[{i['id']}] {i['published'][:10]} | {i['source']} | {i['title']}"]
    if i.get("sections"):
        parts.append("sections: " + ",".join(i["sections"]))
    parts.append(f"rel {i.get('relevance', '?')}" + (" BREAKING" if i.get("breaking") else ""))
    if i.get("why"):
        parts.append("why: " + i["why"])
    if i.get("data_points"):
        parts.append("data: " + "; ".join(i["data_points"]))
    parts.append(i["url"])
    return " | ".join(parts)


def items_block(items: list[dict], limit: int) -> str:
    items = sorted(items, key=lambda x: (x.get("relevance", 0), x["published"]), reverse=True)[:limit]
    return "\n".join(item_line(i) for i in items) or "(no items)"


def system_with_context(task_prompt: str) -> str:
    return config.prompt("_context") + "\n\n---\n\n" + task_prompt


def today_line() -> str:
    n = config.now_local()
    return f"Today is {n.strftime('%A, %B %-d, %Y')} ({n.strftime('%Y-%m-%d')}), {n.strftime('%-I:%M %p')} ET."


# ---------- source verification ----------

LINK_RE = re.compile(r"\[([^\]]+)\]\((https?://[^)\s]+)\)")


def _norm(url: str) -> str:
    from .collect import norm_url
    try:
        return norm_url(url)
    except Exception:
        return url


def allowed_sources(items: list[dict], web: list[dict] | None = None, extra: list[dict] | None = None) -> dict:
    """Map of normalized URL -> {url, label} for every link a write-up is allowed to use."""
    out: dict[str, dict] = {}
    for i in items:
        out[_norm(i["url"])] = {"url": i["url"], "label": f"{i['source']}: {i['title']}"}
        for a in i.get("also") or []:
            out.setdefault(_norm(a["url"]), {"url": a["url"], "label": f"{a['source']}: {i['title']}"})
    for w in (web or []) + (extra or []):
        if w.get("url"):
            out.setdefault(_norm(w["url"]), {"url": w["url"], "label": w.get("title") or w["url"]})
    return out


def finalize(body: str, allowed: dict, heading: str = "Sources") -> tuple[str, dict]:
    """Strip links Claude did not actually get from a source, then append a numbered source list.

    Returns (body, stats). A removed link keeps its text and is marked so readers know
    the claim has no verified source.
    """
    used: dict[str, dict] = {}
    removed = 0

    def sub(m: re.Match) -> str:
        nonlocal removed
        text, url = m.group(1), m.group(2)
        hit = allowed.get(_norm(url))
        if not hit:
            removed += 1
            return f"{text} (source not verified)"
        used.setdefault(_norm(url), hit)
        return m.group(0)

    body = LINK_RE.sub(sub, body).rstrip()
    if used:
        body += f"\n\n---\n\n**{heading}**\n\n" + "\n".join(
            f"{n}. [{v['label']}]({v['url']})" for n, v in enumerate(used.values(), 1))
    return body + "\n", {"sources": len(used), "unverified_links_removed": removed}


def has_source(url: str | None, allowed: dict) -> bool:
    return bool(url) and _norm(url) in allowed
