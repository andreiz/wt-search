"""Episode status machine (spec §3.1). Every status change goes through here."""

import sqlite3
from collections.abc import Collection
from datetime import UTC, datetime
from enum import StrEnum

MAX_RETRIES = 3


class Status(StrEnum):
    NEW = "new"
    DOWNLOADED = "downloaded"
    TRANSCRIBED = "transcribed"
    CHUNKED = "chunked"
    EMBEDDED = "embedded"
    PUBLISHED = "published"
    ERROR = "error"


STEP_INPUT: dict[str, Status] = {
    "download": Status.NEW,
    "transcribe": Status.DOWNLOADED,
    "chunk": Status.TRANSCRIBED,
    "embed": Status.CHUNKED,
    "publish": Status.EMBEDDED,
}

STEP_OUTPUT: dict[str, Status] = {
    "download": Status.DOWNLOADED,
    "transcribe": Status.TRANSCRIBED,
    "chunk": Status.CHUNKED,
    "embed": Status.EMBEDDED,
    "publish": Status.PUBLISHED,
}

RESET_TARGETS = {Status.NEW, Status.TRANSCRIBED}


class InvalidTransition(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _row(conn: sqlite3.Connection, episode_id: int) -> sqlite3.Row:
    row = conn.execute(
        "select status, error_step from episodes where id = ?", (episode_id,)
    ).fetchone()
    if row is None:
        raise KeyError(episode_id)
    return row


def advance(conn: sqlite3.Connection, episode_id: int, step: str) -> None:
    with conn:
        row = _row(conn, episode_id)
        allowed = row["status"] == STEP_INPUT[step] or (
            row["status"] == Status.ERROR and row["error_step"] == step
        )
        if not allowed:
            raise InvalidTransition(f"episode {episode_id}: {row['status']} cannot run {step}")
        conn.execute(
            "update episodes set status = ?, error_step = null, error_reason = null, "
            "retries = 0, updated_at = ? where id = ?",
            (STEP_OUTPUT[step], _now(), episode_id),
        )


def fail(conn: sqlite3.Connection, episode_id: int, step: str, reason: str) -> None:
    now = _now()
    with conn:
        conn.execute(
            "update episodes set status = ?, error_step = ?, error_reason = ?, "
            "retries = retries + 1, updated_at = ?, failed_at = ? where id = ?",
            (Status.ERROR, step, reason, now, now, episode_id),
        )


def reset(conn: sqlite3.Connection, episode_id: int, to: Status) -> None:
    if to not in RESET_TARGETS:
        raise ValueError(f"can only reset to {sorted(RESET_TARGETS)}, not {to}")
    with conn:
        conn.execute(
            "update episodes set status = ?, error_step = null, error_reason = null, "
            "retries = 0, updated_at = ? where id = ?",
            (to, _now(), episode_id),
        )


def episodes_for_step(
    conn: sqlite3.Connection, step: str, ids: Collection[int], *, newest_first: bool = False
) -> list[sqlite3.Row]:
    if not ids:
        return []
    marks = ", ".join("?" for _ in ids)
    order = "desc" if newest_first else "asc"
    return conn.execute(
        f"select * from episodes where id in ({marks}) and "
        "(status = ? or (status = ? and error_step = ? and retries < ?)) "
        f"order by published_at {order}",
        (*ids, STEP_INPUT[step], Status.ERROR, step, MAX_RETRIES),
    ).fetchall()


def publish_ready(conn: sqlite3.Connection, ids: Collection[int]) -> list[sqlite3.Row]:
    """Episodes that may be published: `embedded`, `published` (to some environment, maybe not
    the one being published to), or a publish error with retries left. Which are due for an
    environment is decided by digest (publish.py)."""
    if not ids:
        return []
    marks = ", ".join("?" for _ in ids)
    return conn.execute(
        f"select * from episodes where id in ({marks}) and "
        "(status in (?, ?) or (status = ? and error_step = 'publish' and retries < ?)) "
        "order by published_at",
        (*ids, Status.EMBEDDED, Status.PUBLISHED, Status.ERROR, MAX_RETRIES),
    ).fetchall()
