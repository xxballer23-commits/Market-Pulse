"""Offline end-to-end test: fake feeds + mock LLM. Run: python -m pytest tests -q  (or python tests/test_pipeline.py)

Writes into a temp data dir, never into docs/data.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

os.environ["PULSE_MOCK"] = "1"
os.environ.setdefault("PULSE_DATA_DIR", tempfile.mkdtemp(prefix="pulse-test-"))
os.environ.setdefault("PULSE_NOW", "2026-11-23T11:30:00+00:00")  # a Monday morning ET
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import requests  # noqa: E402

from pulse import __main__ as cli  # noqa: E402
from pulse import config, store, vet  # noqa: E402

RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>SAMPLE American Express launch of new Platinum dining benefit with Resy</title>
<link>https://example.com/a?utm_source=x</link><pubDate>Mon, 23 Nov 2026 09:00:00 GMT</pubDate>
<description>Sample item for tests. Fee $895.</description></item>
<item><title>SAMPLE Wells Fargo adds card partnership</title>
<link>https://example.com/b</link><pubDate>Mon, 23 Nov 2026 08:00:00 GMT</pubDate></item>
<item><title>SAMPLE New York restaurant opening draws hardest reservation</title>
<link>https://example.com/c</link><pubDate>Sun, 22 Nov 2026 20:00:00 GMT</pubDate></item>
<item><title>SAMPLE Old story</title><link>https://example.com/old</link>
<pubDate>Mon, 02 Nov 2026 08:00:00 GMT</pubDate></item>
</channel></rss>"""

GNEWS = """<?xml version="1.0"?><rss version="2.0"><channel><title>g</title>
<item><title>SAMPLE American Express launch new Platinum dining benefit with Resy - Some Outlet</title>
<link>https://news.google.com/x1</link><source url="https://outlet.example">Some Outlet</source>
<pubDate>Mon, 23 Nov 2026 09:30:00 GMT</pubDate></item>
</channel></rss>"""

CSV = "observation_date,X\n2026-07-01,4.1\n2026-08-01,4.2\n2026-09-01,.\n"


class R:
    def __init__(self, body: str, status: int = 200):
        self.content = body.encode()
        self.text = body
        self.status_code = status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(str(self.status_code))


def fake_get(url, **kw):
    if "fred" in url:
        return R(CSV)
    if "reddit" in url:
        return R("blocked", 403)
    if "news.google" in url:
        return R(GNEWS)
    if "eater" in url:
        return R(RSS)
    return R("<rss><channel></channel></rss>")


def test_end_to_end():
    requests.get = fake_get
    assert cli.main(["sweep"]) == 0
    feed = store.read_json("feed.json", [])
    titles = [i["title"] for i in feed]
    assert any("Wells Fargo" in t for t in titles)
    assert not any("Old story" in t for t in titles), "age filter"
    amex = [i for i in feed if "Platinum" in i["title"]]
    assert len(amex) == 1, f"dedupe failed: {titles}"
    assert amex[0]["also"] and amex[0]["also"][0]["source"] == "Some Outlet"
    assert all(i["enriched"] for i in feed)
    assert "utm_source" not in amex[0]["id"]
    health = store.read_json("source_health.json", {})
    assert any(not h["ok"] for h in health["sources"]), "reddit failure recorded"

    # second sweep is idempotent
    cli.main(["sweep"])
    assert len(store.read_json("feed.json", [])) == len(feed)

    assert cli.main(["digest", "auto"]) == 0  # Monday -> weekly edition + living pages
    idx = store.read_json("digests/index.json", {})
    assert idx["entries"][0]["type"] == "monday"
    assert store.read_json("living/watchlist.json", {})["entries"]
    assert store.read_json("living/dashboard.json", {})["indicators"]

    os.environ["PULSE_NOW"] = "2026-11-24T11:30:00+00:00"  # Tuesday
    cli.main(["digest", "auto"])
    assert store.read_json("digests/index.json", {})["entries"][0]["type"] == "daily"
    os.environ["PULSE_NOW"] = "2026-11-27T22:40:00+00:00"  # Friday evening
    cli.main(["digest", "friday"])

    assert vet.parse_title("Vet: Dorsia") == "Dorsia"
    assert vet.parse_title("vet - Blackbird Labs") == "Blackbird Labs"
    assert vet.parse_title("Bug report") is None
    cli.main(["vet", "Resy"])
    comp = store.read_json("companies.json", {})["companies"]
    assert any(c["name"] == "American Express" for c in comp)
    resy = store.read_json("companies/resy.json", {})
    assert resy and resy["vets"], "vet brief linked to company page"
    usage = store.read_json("usage.json", {"days": {}})  # mock mode logs nothing
    assert usage == {"days": {}}
    print("data dir:", config.DATA_DIR)


def test_source_verification():
    from pulse.common import allowed_sources, finalize
    items = [{"url": "https://example.com/real?utm_source=x", "source": "Pub", "title": "Real story", "also": []}]
    web = [{"url": "https://found.example/page", "title": "Found page"}]
    body = ("- [Real](https://example.com/real) item\n- [Found](https://found.example/page)\n"
            "- [Made up](https://hallucinated.example/x)")
    out, stats = finalize(body, allowed_sources(items, web))
    assert "hallucinated" not in out and "Made up (source not verified)" in out
    assert stats == {"sources": 2, "unverified_links_removed": 1}
    assert "1. [Pub: Real story]" in out


if __name__ == "__main__":
    test_source_verification()
    test_end_to_end()
    print("OK")
