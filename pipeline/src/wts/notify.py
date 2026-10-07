"""Push notifications through ntfy.sh (spec §6, §8.2).

Messages are sent with ntfy's JSON publishing: the topic, title and priority go in the request
body. Episode titles contain non-ASCII characters that HTTP headers can't carry safely, and
the topic is a secret, so keeping it out of the URL keeps it out of httpx's error messages.

A notification that fails is logged (status code or exception class name only) and never
raises: the run it reports on must not fail because the phone could not be reached.
"""

import logging
import sqlite3
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Protocol

import httpx

from wts.log import plural
from wts.net import describe_http_error
from wts.secrets import KeychainError, SecretStore
from wts.state import MAX_RETRIES

log = logging.getLogger("wts")

NTFY_URL = "https://ntfy.sh"
PRIORITIES = {"min": 1, "low": 2, "default": 3, "high": 4, "urgent": 5}
QUIET_FEED_DAYS = 21
MAX_LISTED = 10  # episodes listed per section; ntfy messages are limited to 4096 bytes
MAX_REASON = 120


class Notifier(Protocol):
    def send(
        self, title: str, body: str, *, priority: str = "default", tags: Sequence[str] = ()
    ) -> bool:
        """Deliver a message. True if it was delivered; never raises on delivery problems."""
        ...


class NtfyNotifier:
    def __init__(self, client: httpx.Client, topic: str, base_url: str = NTFY_URL):
        self._client = client
        self._topic = topic
        self._url = base_url.rstrip("/") + "/"

    def send(
        self, title: str, body: str, *, priority: str = "default", tags: Sequence[str] = ()
    ) -> bool:
        if priority not in PRIORITIES:
            raise ValueError(f"unknown priority {priority!r}; use one of {', '.join(PRIORITIES)}")
        payload = {
            "topic": self._topic, "title": title, "message": body,
            "priority": PRIORITIES[priority], "tags": list(tags),
        }
        try:
            self._client.post(self._url, json=payload, timeout=10).raise_for_status()
        except httpx.HTTPError as exc:
            log.warning(f"could not send notification: {describe_http_error(exc)}")
            return False
        except Exception as exc:  # noqa: BLE001 — a notification must never fail the run
            log.warning(f"could not send notification: {type(exc).__name__}")
            return False
        return True


class NullNotifier:
    """Used when there is no `ntfy_topic`: the message goes to the log instead."""

    def send(
        self, title: str, body: str, *, priority: str = "default", tags: Sequence[str] = ()
    ) -> bool:
        log.info(f"notification (not sent): {title}: {body}")
        return False


def get_notifier(client: httpx.Client, store: SecretStore) -> Notifier:
    """NtfyNotifier when `ntfy_topic` is set, else NullNotifier with a warning (once per call)."""
    try:
        topic = store.get("ntfy_topic")
    except KeychainError as exc:  # its message names the secret and the exit code only
        log.warning(f"notifications are off: {exc}")
        return NullNotifier()
    if topic is None:
        log.warning(
            "notifications are off: ntfy_topic is not set (run `wts secrets set ntfy_topic`)"
        )
        return NullNotifier()
    return NtfyNotifier(client, topic)


def _label(row: sqlite3.Row) -> str:
    return f"#{row['number']} {row['title']}" if row["number"] else row["title"]


def _first_line(text: str | None) -> str:
    line = (text or "").strip().split("\n", 1)[0]
    return line if len(line) <= MAX_REASON else line[: MAX_REASON - 1] + "…"


def _listed(lines: list[str]) -> list[str]:
    if len(lines) <= MAX_LISTED:
        return lines
    return [*lines[:MAX_LISTED], f"…and {len(lines) - MAX_LISTED} more"]


def _newly_published(conn: sqlite3.Connection, since: str) -> list[sqlite3.Row]:
    return conn.execute(
        "select e.number, e.title, (select count(*) from chunks c where c.episode_id = e.id) "
        "as chunks from episodes e "
        "where e.id in (select episode_id from publications where published_at >= ?) "
        "order by e.published_at",
        (since,),
    ).fetchall()


def _in_error(conn: sqlite3.Connection, since: str) -> list[sqlite3.Row]:
    """Episodes that failed since `since`. One that is out of retries is reported in the run
    that used its last retry, then not again: later runs don't select it, and a daily run
    mustn't repeat the alert. `wts status` lists every episode in `error`."""
    return conn.execute(
        "select number, title, error_step, error_reason, retries from episodes "
        "where status = 'error' and updated_at >= ? order by published_at",
        (since,),
    ).fetchall()


def _quiet_days(conn: sqlite3.Connection, now: datetime) -> int | None:
    """Days since the newest feed item, when that is more than QUIET_FEED_DAYS."""
    newest: datetime | None = None
    for (text,) in conn.execute("select published_at from episodes where published_at is not null"):
        try:
            when = datetime.fromisoformat(text)
        except ValueError:
            continue
        when = when if when.tzinfo else when.replace(tzinfo=UTC)
        newest = when if newest is None or when > newest else newest
    if newest is None or now - newest <= timedelta(days=QUIET_FEED_DAYS):
        return None
    return (now - newest).days


def notify_run(
    notifier: Notifier,
    conn: sqlite3.Connection,
    results: Mapping[str, Mapping[str, int]],
    run_started_at: str,
    *,
    now: datetime | None = None,
) -> bool:
    """Send ONE summary of the run (spec §8.2), or nothing if there is nothing to say.

    `run_started_at` is an ISO-8601 UTC string like state.db's timestamps, so strings compare.
    Covers episodes published and episodes that failed during the run (marked when that used
    their last retry), and a feed with no item newer than 21 days. That last check is skipped when the
    feed fetch failed (that has its own notification and the data is stale for a known reason).
    Returns whether a message was sent.
    """
    now = now or datetime.now(UTC)
    published = _newly_published(conn, run_started_at)
    errors = _in_error(conn, run_started_at)
    quiet = None if results.get("feed", {}).get("error") else _quiet_days(conn, now)
    if not (published or errors or quiet):
        return False

    sections: list[str] = []
    if errors:
        lines = [
            f"- {_label(r)}: {r['error_step']}: {_first_line(r['error_reason'])}"
            + (" (out of retries; see `wts status`)" if r["retries"] >= MAX_RETRIES else "")
            for r in errors
        ]
        sections.append("\n".join(["Episodes in error:", *_listed(lines)]))
    if published:
        lines = [f"- {_label(r)} ({plural(r['chunks'], 'chunk')})" for r in published]
        sections.append("\n".join(["Published:", *_listed(lines)]))
    if quiet:
        sections.append(
            f"No feed item newer than {QUIET_FEED_DAYS} days: the newest is {quiet} days old. "
            "The feed may have moved."
        )

    if errors:
        title, priority, tags = f"wts: {plural(len(errors), 'episode')} in error", "high", ("warning",)
    elif published:
        title, priority, tags = (
            f"wts: published {plural(len(published), 'episode')}", "default", ("tada",)
        )
    else:
        title, priority, tags = (
            f"wts: no new episode in {QUIET_FEED_DAYS} days", "default", ("hourglass",)
        )
    notifier.send(title, "\n\n".join(sections), priority=priority, tags=tags)
    return True
