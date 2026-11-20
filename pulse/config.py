"""Paths and config loading."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from zoneinfo import ZoneInfo

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_DIR = ROOT / "config"
PROMPTS_DIR = ROOT / "prompts"
DATA_DIR = Path(os.environ.get("PULSE_DATA_DIR", ROOT / "docs" / "data"))


@lru_cache
def settings() -> dict:
    return yaml.safe_load((CONFIG_DIR / "settings.yaml").read_text())


@lru_cache
def sources() -> dict:
    return yaml.safe_load((CONFIG_DIR / "sources.yaml").read_text())


@lru_cache
def taxonomy() -> dict:
    return yaml.safe_load((CONFIG_DIR / "taxonomy.yaml").read_text())


def section_ids() -> list[str]:
    return [s["id"] for s in taxonomy()["sections"]]


def prompt(name: str) -> str:
    return (PROMPTS_DIR / f"{name}.md").read_text()


def tz() -> ZoneInfo:
    return ZoneInfo(settings()["site"]["timezone"])


def now_utc() -> datetime:
    override = os.environ.get("PULSE_NOW")  # for tests
    if override:
        return datetime.fromisoformat(override).astimezone(timezone.utc)
    return datetime.now(timezone.utc)


def now_local() -> datetime:
    return now_utc().astimezone(tz())


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
