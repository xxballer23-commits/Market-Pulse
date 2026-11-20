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
