"""RSS feed ingest (spec §3.2 `wts feed`). Platform ID matching comes in plan 2."""

import logging
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

import feedparser

from wts.state import Status, reset
from wts.stems import make_stem, split_title

MAX_RESETS = 5
log = logging.getLogger("wts")


class MassReset(Exception):
    """The feed changed audio URLs for many episodes at once (e.g. a new tracking prefix)."""


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
    itunes = int(raw) if raw and str(raw).strip().isdigit() else None
    return split_title(entry.get("title", ""), itunes)[0]


def parse_feed(xml: bytes) -> list[FeedItem]:
    parsed = feedparser.parse(xml)
    items = []
    for entry in parsed.entries:
        enclosures = entry.get("enclosures") or []
        if not enclosures:
            continue
        parsed_date = entry.get("published_parsed")
        if parsed_date is None:
            log.warning(f"skipping feed item without a usable date: {entry.get('title')!r}")
            continue
        published = datetime(*parsed_date[:6], tzinfo=UTC)
        items.append(
            FeedItem(
                guid=entry.get("id") or normalize_audio_url(enclosures[0]["href"]),
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


def _moved_guids(conn: sqlite3.Connection, items: list[FeedItem]) -> list[str]:
    moved = []
    for item in items:
        row = conn.execute("select audio_url from episodes where guid = ?", (item.guid,)).fetchone()
        if row and normalize_audio_url(row[0]) != normalize_audio_url(item.audio_url):
            moved.append(item.guid)
    return moved


def upsert_episodes(
    conn: sqlite3.Connection, items: list[FeedItem], *, force: bool = False
) -> FeedResult:
    moved_guids = _moved_guids(conn, items)
    if len(moved_guids) > MAX_RESETS and not force:
        raise MassReset(
            f"{len(moved_guids)} episodes changed their audio URL, which would re-download and "
            "re-transcribe them all. If the show really moved its audio, re-run with --force."
        )
    added = updated = resets = 0

    def taken(stem: str) -> bool:
        return conn.execute("select 1 from episodes where stem = ?", (stem,)).fetchone() is not None

    for item in items:
        row = conn.execute(
            "select id, audio_url from episodes where guid = ?", (item.guid,)
        ).fetchone()
        if row is None:
            slug_title = split_title(item.title, item.number)[1]
            stem = make_stem(item.published_at.date(), item.number, slug_title, taken)
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
        moved = item.guid in moved_guids
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
            log.warning(
                f"audio URL changed; episode reset to new: {row['audio_url']} -> {item.audio_url}",
                extra={"step": "feed"},
            )
    return FeedResult(added=added, updated=updated, reset=resets)
