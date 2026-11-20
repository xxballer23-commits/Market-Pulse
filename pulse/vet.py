"""Diligence Desk: on-demand partner vetting brief, triggered by a GitHub issue titled 'Vet: Company'."""
from __future__ import annotations

import re

from . import config, llm, store
from .common import allowed_sources, canon_company, finalize, item_line, slug, system_with_context, today_line


def parse_title(title: str) -> str | None:
    m = re.match(r"^\s*vet\s*[:\-]\s*(.+?)\s*$", title or "", re.I)
    if not m:
        return None
    name = re.sub(r"[^\w&.,'’ \-()]", "", m.group(1)).strip()[:80]
    return name or None


def run(company: str, requested_by: str | None = None, issue: int | None = None) -> dict:
    s = config.settings()
    company = canon_company(company)
    sl = slug(company)
    archive = [i for m in store.months_on_disk() for i in store.load_month(m)
               if company.lower() in " ".join([i["title"]] + (i.get("companies") or [])).lower()]
    archive.sort(key=lambda x: x["published"], reverse=True)
    context = "\n".join(item_line(i) for i in archive[:30]) or "(no prior coverage in our archive)"

    body, cites = llm.complete(
        model=s["models"]["writer"],
        system=system_with_context(config.prompt("vet").replace("{company}", company)),
        user=f"{today_line()}\n\nCompany to vet: {company}\n\nWhat our own archive has on them:\n{context}",
        task="vet", max_tokens=4000, web_search_uses=s["web_search"]["max_uses"]["vet"],
        mock=lambda: f"# Part A: Facts\n## Business model\nMock facts for {company}.\n\n# Part B: Analyst take (internal only)\nMock take.")
    body, stats = finalize(body, allowed_sources(archive[:30], web=cites))

    date = config.now_local().strftime("%Y-%m-%d")
    vid = f"{sl}-{date}"
    store.write_text(f"vet/{vid}.md", body)
    idx = store.read_json("vet/index.json", {"entries": []})
    idx["entries"] = [e for e in idx["entries"] if e["id"] != vid]
    entry = {"id": vid, "company": company, "slug": sl, "date": date, "file": f"vet/{vid}.md",
             "requested_by": requested_by, "issue": issue, "archive_items": len(archive),
             "generated": config.iso(config.now_utc()), **stats}
    idx["entries"].insert(0, entry)
    store.write_json("vet/index.json", idx)
    print(f"[vet] wrote {vid}")
    return entry
