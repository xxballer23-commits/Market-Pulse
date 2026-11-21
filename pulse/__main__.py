"""CLI: python -m pulse <command>

  sweep                 collect all sources, tag new items, refresh FRED, rebuild site data
  digest auto|daily|monday|friday
  living                refresh all living pages now (normally runs inside the Monday edition)
  vet "Company"         write a Diligence Desk brief
  vet-issue             same, reading ISSUE_TITLE / ISSUE_NUMBER / ISSUE_AUTHOR from the environment
  desk-issue            handle a Vet:/Watch:/Approve: issue (ISSUE_TITLE, ISSUE_BODY, ISSUE_AUTHOR, ISSUE_NUMBER)
  rebuild               rebuild feed.json, manifest and company pages from stored items
"""
from __future__ import annotations

import json
import os
import sys

from . import collect, companies, config, digest, enrich, fred, living, store, vet


def rebuild() -> None:
    store.rebuild_feed()
    companies.run()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 1
    cmd, rest = argv[0], argv[1:]
    if cmd == "sweep":
        stats = collect.sweep()
        enrich.run()
        try:
            fred.run()
        except Exception as e:
            print(f"[fred] skipped: {e}")
        rebuild()
        store.update_manifest(last_sweep=config.iso(config.now_utc()), last_sweep_stats=stats)
    elif cmd == "digest":
        kind = rest[0] if rest else "auto"
        {"auto": digest.auto, "daily": digest.weekday, "weekday": digest.weekday, "monday": digest.monday,
         "friday": digest.friday, "radar": digest.radar, "update": digest.update,
         "briefing": lambda: digest.monday(refresh_living=False)}[kind]()
        rebuild()
        store.update_manifest(last_digest=config.iso(config.now_utc()))
    elif cmd == "living":
        living.run_weekly()
        rebuild()
    elif cmd == "vet":
        vet.run(" ".join(rest))
        rebuild()
    elif cmd == "vet-issue":
        name = vet.parse_title(os.environ.get("ISSUE_TITLE", ""))
        out = os.environ.get("GITHUB_OUTPUT")
        if not name:
            print("[vet] issue title is not 'Vet: Company', skipping")
            if out:
                open(out, "a").write("vetted=false\n")
            return 0
        num = os.environ.get("ISSUE_NUMBER")
        entry = vet.run(name, os.environ.get("ISSUE_AUTHOR"), int(num) if num else None)
        rebuild()
        if out:
            with open(out, "a") as f:
                f.write("vetted=true\n")
                f.write(f"vet_id={entry['id']}\n")
                f.write(f"company={json.dumps(entry['company'])[1:-1]}\n")
    elif cmd == "desk-issue":
        from . import desk
        num = os.environ.get("ISSUE_NUMBER")
        res = desk.handle(os.environ.get("ISSUE_TITLE", ""), os.environ.get("ISSUE_BODY", ""),
                          os.environ.get("ISSUE_AUTHOR"), int(num) if num else None)
        print(f"[desk] {res}")
        if res["action"] != "none":
            rebuild()
        out = os.environ.get("GITHUB_OUTPUT")
        if out:
            link = config.settings()["site"].get("url", "").rstrip("/") + "/" + res.get("path", "")
            with open(out, "a") as f:
                f.write(f"action={res['action']}\n")
                f.write(f"message={res['message'].replace(chr(10), ' ')}\n")
                f.write(f"link={link if res.get('path') else ''}\n")
    elif cmd == "rebuild":
        rebuild()
    else:
        print(__doc__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
