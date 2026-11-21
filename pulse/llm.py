"""Thin wrapper over the Anthropic API with JSON parsing, web search and usage tracking.

Set PULSE_MOCK=1 to run the whole pipeline offline: every call returns the
caller-supplied mock output instead of hitting the API.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Callable

from . import config, store

MOCK = os.environ.get("PULSE_MOCK") == "1"

_client = None

import threading
_lock = threading.Lock()


def _get_client():
    global _client
    if _client is None:
        import anthropic

        if not os.environ.get("ANTHROPIC_API_KEY"):
            e = RuntimeError("ANTHROPIC_API_KEY is not set. Add it under repo Settings, Secrets and variables, Actions.")
            record_error("setup", e)
            raise e
        _client = anthropic.Anthropic(timeout=420, max_retries=1)  # reads ANTHROPIC_API_KEY
    return _client


def _log_usage(model: str, usage: Any, searches: int, task: str) -> None:
    with _lock:
        _log_usage_unlocked(model, usage, searches, task)


def _log_usage_unlocked(model: str, usage: Any, searches: int, task: str) -> None:
    day = config.now_local().strftime("%Y-%m-%d")
    log = store.read_json("usage.json", {"days": {}})
    d = log["days"].setdefault(day, {"input_tokens": 0, "output_tokens": 0,
                                     "web_searches": 0, "calls": 0, "by_task": {}})
    inp = getattr(usage, "input_tokens", 0) or 0
    inp += getattr(usage, "cache_read_input_tokens", 0) or 0
    inp += getattr(usage, "cache_creation_input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    d["input_tokens"] += inp
    d["output_tokens"] += out
    d["web_searches"] += searches
    d["calls"] += 1
    t = d["by_task"].setdefault(task, {"calls": 0, "input_tokens": 0, "output_tokens": 0,
                                       "web_searches": 0, "model": model})
    t["calls"] += 1
    t["input_tokens"] += inp
    t["output_tokens"] += out
    t["web_searches"] += searches
    # keep ~120 days
    for k in sorted(log["days"])[:-120]:
        del log["days"][k]
    store.write_json("usage.json", log)


def complete(
    *,
    model: str,
    system: str,
    user: str,
    task: str,
    max_tokens: int = 4000,
    web_search_uses: int = 0,
    mock: Callable[[], str] | None = None,
) -> tuple[str, list[dict]]:
    """Return (text, sources). sources = every URL web search returned or cited this call."""
    if MOCK:
        return (mock() if mock else "Mock output."), []

    client = _get_client()
    tools = []
    if web_search_uses > 0:
        tools.append({
            "type": config.settings()["web_search"]["tool_type"],
            "name": "web_search",
            "max_uses": web_search_uses,
        })

    messages: list[dict] = [{"role": "user", "content": user}]
    texts: list[str] = []
    cited: dict[str, dict] = {}
    for _turn in range(4):  # web search can pause long turns; resume a few times
        for attempt in range(3):
            try:
                kwargs = dict(model=model, max_tokens=max_tokens, system=system, messages=messages)
                # No extended thinking: output budget goes to the written text, and runs stay fast.
                if config.settings().get("models", {}).get("disable_thinking", True):
                    kwargs["thinking"] = {"type": "disabled"}
                if tools:
                    kwargs["tools"] = tools
                # Stream so long, web-search-heavy writes never hit the non-streaming timeout.
                with client.messages.stream(**kwargs) as stream:
                    resp = stream.get_final_message()
                break
            except Exception as e:  # rate limits / overloads: back off and retry
                status = getattr(e, "status_code", None)
                fatal = status is not None and 400 <= status < 500 and status not in (408, 409, 429)
                if fatal or attempt == 2 or type(e).__name__ in ("AuthenticationError", "PermissionDeniedError"):
                    record_error(task, e)
                    raise
                print(f"[llm] {task}: {type(e).__name__}: {e}; retrying")
                time.sleep(5 * (attempt + 1) ** 2)
        searches = 0
        stu = getattr(resp.usage, "server_tool_use", None)
        if stu is not None:
            searches = getattr(stu, "web_search_requests", 0) or 0
        _log_usage(model, resp.usage, searches, task)
        if not MOCK:
            clear_error()

        for block in resp.content:
            if block.type == "web_search_tool_result":
                content = getattr(block, "content", None)
                for r in content if isinstance(content, list) else []:
                    url = getattr(r, "url", None)
                    if url and url not in cited:
                        cited[url] = {"url": url, "title": getattr(r, "title", "") or url, "kind": "result"}
            if block.type == "text":
                texts.append(block.text)
                for c in getattr(block, "citations", None) or []:
                    url = getattr(c, "url", None)
                    if url:
                        cited[url] = {"url": url, "title": getattr(c, "title", "") or url, "kind": "cited"}
        kinds = [b.type for b in resp.content]
        print(f"[llm] {task}: stop={resp.stop_reason} blocks={kinds.count('text')} text, {kinds.count('server_tool_use')} searches, {kinds.count('thinking')} thinking")
        if resp.stop_reason == "max_tokens":
            print(f"[llm] {task}: hit max_tokens ({max_tokens}); output may be cut off")
            record_error(task, RuntimeError(f"Output hit the {max_tokens} token limit and may be incomplete"))
        if resp.stop_reason == "pause_turn":
            messages = [messages[0], {"role": "assistant", "content": resp.content}]
            continue
        break
    return "".join(texts).strip(), list(cited.values())


def record_error(task: str, e: Exception) -> None:
    """Save the latest API error so it shows on the site's Sources page (no log digging needed)."""
    msg = str(e)
    key = os.environ.get("ANTHROPIC_API_KEY") or ""
    if key:
        msg = msg.replace(key, "***")
    with _lock:
        store.update_manifest(llm_error={"task": task, "type": type(e).__name__,
                                         "status": getattr(e, "status_code", None),
                                         "message": msg[:400], "at": config.iso(config.now_utc())})


def clear_error() -> None:
    with _lock:
        m = store.read_json("manifest.json", {})
        if m.pop("llm_error", None) is not None:
            store.write_json("manifest.json", m)


def _extract_json(text: str) -> Any:
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1)
    starts = [i for i in (text.find("{"), text.find("[")) if i != -1]
    if not starts:
        raise ValueError("no JSON found")
    start = min(starts)
    closer = "}" if text[start] == "{" else "]"
    end = text.rfind(closer)
    return json.loads(text[start : end + 1])


def complete_json(*, mock: Callable[[], Any] | None = None, **kw) -> tuple[Any, list[dict]]:
    mock_text = (lambda: json.dumps(mock())) if mock else None
    text, cites = complete(mock=mock_text, **kw)
    try:
        return _extract_json(text), cites
    except (ValueError, json.JSONDecodeError):
        if MOCK:
            raise
        kw = dict(kw)
        kw["user"] = kw["user"] + "\n\nYour last reply was not valid JSON. Reply with ONLY the JSON."
        text, cites2 = complete(**kw)
        return _extract_json(text), cites + cites2
