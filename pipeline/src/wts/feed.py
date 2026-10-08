"""RSS feed ingest (spec §3.2 `wts feed`). Platform ID matching follows it in `wts.platforms`."""

import logging
import sqlite3
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from urllib.parse import urlsplit, urlunsplit

import feedparser

from wts.state import Status, reset
from wts.stems import make_stem, split_title

MAX_RESETS = 5
SEQUENCE_WINDOW_DAYS = 120
SEQUENCE_TOLERANCE = 30
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
    scoped: int = 0  # new releases put in scope (open decision 3, option a)


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


def _itunes_number(entry) -> int | None:
    raw = entry.get("itunes_episode")
    return int(raw) if raw and str(raw).strip().isdigit() else None


def _drop_out_of_sequence(items: list[FeedItem]) -> list[FeedItem]:
    """An episode number must fit the main show's numbering around that date.

    Side series ("Board Meetings #1" in 2011, when the show was in the 80s) restart at 1,
    whether the number comes from the title or itunes:episode; those episodes become
    unnumbered so `ep:N` and the site's "Ep. N" always mean the main show.
    """
    out = []
    for i, item in enumerate(items):
        if item.number is not None:
            neighbors = sorted(
                other.number
                for j, other in enumerate(items)
                if j != i
                and other.number is not None
                and abs((other.published_at - item.published_at).days) <= SEQUENCE_WINDOW_DAYS
            )
            if len(neighbors) >= 2:
                median = neighbors[len(neighbors) // 2]
                if abs(item.number - median) > SEQUENCE_TOLERANCE:
                    item = replace(item, number=None)
        out.append(item)
    return out


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
        title = entry.get("title", "").strip()
        items.append(
            FeedItem(
                guid=entry.get("id") or normalize_audio_url(enclosures[0]["href"]),
                number=split_title(title, _itunes_number(entry))[0],
                title=title,
                published_at=published,
                duration_s=_parse_duration(entry.get("itunes_duration")),
                audio_url=enclosures[0]["href"],
                page_url=entry.get("link"),
            )
        )
    return _drop_out_of_sequence(items)


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
    added = updated = resets = scoped = 0
    # New releases join the scope, so a scheduled `wts run` processes them (open decision 3,
    # option a): an added item at least as new as the newest stored one. Not on the first
    # import (nothing stored), which would put the whole archive in scope, nor for an old item
    # that turns up later.
    newest = conn.execute("select max(published_at) from episodes").fetchone()[0]
    newest_at = datetime.fromisoformat(newest) if newest else None

    def taken(stem: str) -> bool:
        return conn.execute("select 1 from episodes where stem = ?", (stem,)).fetchone() is not None

    for item in items:
        row = conn.execute(
            "select id, audio_url from episodes where guid = ?", (item.guid,)
        ).fetchone()
        if row is None:
            # Unnumbered episodes keep any number in their slug ("board-meetings-1").
            slug_title = split_title(item.title, item.number)[1] if item.number else item.title
            stem = make_stem(item.published_at.date(), item.number, slug_title, taken)
            in_scope = newest_at is not None and item.published_at >= newest_at
            with conn:
                conn.execute(
                    "insert into episodes (guid, number, title, published_at, duration_s, "
                    "audio_url, page_url, stem, updated_at, in_scope) "
                    "values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        item.guid, item.number, item.title, item.published_at.isoformat(),
                        item.duration_s, item.audio_url, item.page_url, stem, _now(),
                        int(in_scope),
                    ),
                )
            added += 1
            if in_scope:
                scoped += 1
                log.info(f"new episode, added to scope: {item.title}",
                         extra={"step": "feed", "episode": stem})
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
    return FeedResult(added=added, updated=updated, reset=resets, scoped=scoped)
