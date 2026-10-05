"""RSS feed ingest (spec §3.2 `wts feed`). Platform ID matching comes in plan 2."""

import re
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit, urlunsplit

import feedparser

from wts.state import Status, reset
from wts.stems import make_stem

_TITLE_NUMBER = re.compile(r"^\s*(?:Ep\.?|Episode|#)\s*(\d+)", re.IGNORECASE)


@dataclass(frozen=True)
class FeedItem:
    guid: str
    number: int | None
    title: str
    published_at: datetime
    duration_s: int | None
    audio_url: str
    page_url: str | None


@dataclass(frozen=True)
class FeedResult:
    added: int
    updated: int
    reset: int


def _parse_duration(value: str | None) -> int | None:
    if not value:
        return None
    try:
        parts = [int(float(p)) for p in value.strip().split(":")]
    except ValueError:
        return None
    seconds = 0
    for p in parts:
        seconds = seconds * 60 + p
    return seconds


def _number(entry) -> int | None:
    raw = entry.get("itunes_episode")
    if raw and str(raw).strip().isdigit():
        return int(raw)
    m = _TITLE_NUMBER.match(entry.get("title", ""))
    return int(m.group(1)) if m else None


def parse_feed(xml: bytes) -> list[FeedItem]:
    parsed = feedparser.parse(xml)
    items = []
    for entry in parsed.entries:
        enclosures = entry.get("enclosures") or []
        if not enclosures:
            continue
        published = parsedate_to_datetime(entry["published"]).astimezone(UTC)
        items.append(
            FeedItem(
                guid=entry.get("id") or enclosures[0]["href"],
                number=_number(entry),
                title=entry.get("title", "").strip(),
                published_at=published,
                duration_s=_parse_duration(entry.get("itunes_duration")),
                audio_url=enclosures[0]["href"],
                page_url=entry.get("link"),
            )
        )
    return items


def normalize_audio_url(url: str) -> str:
    s = urlsplit(url)
    return urlunsplit((s.scheme, s.netloc, s.path, "", ""))


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def upsert_episodes(conn: sqlite3.Connection, items: list[FeedItem]) -> FeedResult:
    added = updated = resets = 0

    def taken(stem: str) -> bool:
        return conn.execute("select 1 from episodes where stem = ?", (stem,)).fetchone() is not None

    for item in items:
        row = conn.execute(
            "select id, audio_url from episodes where guid = ?", (item.guid,)
        ).fetchone()
        if row is None:
            stem = make_stem(item.published_at.date(), item.number, item.title, taken)
            with conn:
                conn.execute(
                    "insert into episodes (guid, number, title, published_at, duration_s, "
                    "audio_url, page_url, stem, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        item.guid, item.number, item.title, item.published_at.isoformat(),
                        item.duration_s, item.audio_url, item.page_url, stem, _now(),
                    ),
                )
            added += 1
            continue
        moved = normalize_audio_url(row["audio_url"]) != normalize_audio_url(item.audio_url)
        with conn:
            conn.execute(
                "update episodes set number = ?, title = ?, published_at = ?, duration_s = ?, "
                "audio_url = ?, page_url = ?, updated_at = ? where id = ?",
                (
                    item.number, item.title, item.published_at.isoformat(), item.duration_s,
                    item.audio_url, item.page_url, _now(), row["id"],
                ),
            )
        updated += 1
        if moved:
            reset(conn, row["id"], Status.NEW)
            resets += 1
    return FeedResult(added=added, updated=updated, reset=resets)
