"""Team desk: GitHub issue commands from the curator or collaborators.

  Vet: Company            Diligence brief. Body may include "Requested by: Name" and "Context: ...".
  Watch: Company          Add to the shared Watchlist. Body may include "Requested by:", "Why:", "Category:".
  Approve: <edition id>   Mark an edition reviewed by the curator ("Approve: latest" for the newest draft).
"""
from __future__ import annotations

import re

from . import config, digest, store, vet
from .common import canon_company, slug

CMD = re.compile(r"^\s*(vet|watch|approve)\s*[:\-]\s*(.+?)\s*$", re.I)


def _clean(s: str, n: int = 80) -> str:
    return re.sub(r"[^\w&.,'’ \-()/]", "", s or "").strip()[:n]


def field(body: str, name: str, n: int = 600) -> str | None:
    m = re.search(rf"^\s*{name}\s*:\s*(.+?)\s*$", body or "", re.I | re.M)
    if not m:
        return None
    v = re.sub(r"[`<>]", "", m.group(1)).strip()[:n]
    return v or None


def handle(title: str, body: str, author: str | None, number: int | None) -> dict:
    m = CMD.match(title or "")
    if not m:
        return {"action": "none", "message": "Title must start with Vet:, Watch: or Approve:"}
    cmd, arg = m.group(1).lower(), m.group(2)
    requester = field(body, "requested by", 60)
    base = config.settings()["site"].get("url", "")

    if cmd == "vet":
        name = _clean(arg)
        if not name:
            return {"action": "none", "message": "Add a company name after Vet:"}
        ctx = field(body, "context", 800)
        e = vet.run(name, requester or author, number, context_note=ctx, submitted_by=author)
        return {"action": "vet", "id": e["id"], "path": f"#/vet/{e['id']}",
                "message": f"Diligence brief for {e['company']} is ready (facts-only cut by default)."}

    if cmd == "watch":
        name = canon_company(_clean(arg))
        if not name:
            return {"action": "none", "message": "Add a company name after Watch:"}
        wl = store.read_json("living/watchlist.json", {"entries": []})
        today = config.now_local().strftime("%Y-%m-%d")
        who = requester or author
        e = next((x for x in wl["entries"] if x["name"].lower() == name.lower()), None)
        note = f"Added by {who}" + (f": {field(body, 'why', 300)}" if field(body, "why") else "")
        if e:
            e.setdefault("history", []).append({"date": today, "status": e["status"], "note": note, "url": None})
            e["updated"] = today
            msg = f"{name} is already on the Watchlist; noted your request."
        else:
            wl["entries"].append({"name": name, "slug": slug(name), "category": (field(body, "category", 30) or "other").lower(),
                                  "what": None, "why_fit": field(body, "why", 300), "status": "emerging",
                                  "added": today, "updated": today, "added_by": who, "source": "team",
                                  "history": [{"date": today, "status": "emerging", "note": note, "url": None}]})
            msg = f"{name} added to the shared Watchlist as emerging."
        wl["updated"] = config.iso(config.now_utc())
        store.write_json("living/watchlist.json", wl)
        return {"action": "watch", "path": f"#/watchlist", "message": msg}

    if cmd == "approve":
        if (author or "").lower() != (config.settings()["site"].get("curator_github") or "").lower():
            return {"action": "none", "message": "Only the curator can approve editions."}
        e = digest.approve(_clean(arg, 60), config.settings()["site"].get("curator", author))
        if not e:
            return {"action": "none", "message": f"No edition found for '{arg}'."}
        return {"action": "approve", "path": f"#/digest/{e['id']}", "message": f"{e['title']} marked reviewed."}
    return {"action": "none", "message": "Unknown command"}
