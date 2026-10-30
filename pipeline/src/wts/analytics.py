"""`wts analytics pull`: copy the Worker's Analytics Engine points into analytics.db
(analytics design §2; spec §8.3, §8.4).

Analytics Engine rows have no id, and a point can arrive a little after its timestamp, so a
pull replaces whole UTC days: from the start of the newest day already stored (or 92 days
back, everything Cloudflare keeps) through today.
"""

import logging
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from wts.db import connect

log = logging.getLogger("wts")

RETENTION_DAYS = 92  # Analytics Engine keeps about 3 months
STALE_DAYS = 80  # a gap longer than this may already have lost points
ROW_CAP = 10_000  # LIMIT per query; a window that hits it is split
_TS = "%Y-%m-%d %H:%M:%S"
_COLUMNS = ("timestamp, index1, blob1, blob2, blob3, blob4, blob5, "
            "double1, double2, double3, double4, double5, _sample_interval")

Sql = Callable[[str], list[dict]]


@dataclass(frozen=True)
class PullResult:
    rows: int
    first_day: date  # UTC days pulled, inclusive
    last_day: date


def open_db(path: Path) -> sqlite3.Connection:
    return connect(path, "analytics_migrations")


def last_pull(conn: sqlite3.Connection, env: str) -> datetime | None:
    row = conn.execute("select max(at) from pulls where env = ?", (env,)).fetchone()
    return datetime.fromisoformat(row[0]) if row and row[0] else None


def pull(conn: sqlite3.Connection, sql: Sql, *, env: str, dataset: str, now: datetime,
         first_day: str | None = None) -> PullResult:
    """Fetch and store this env's points from the window start through `now`'s UTC day.

    `first_day` (`YYYY-MM-DD`) overrides the window start (tests, and a deliberate re-pull).
    Raises RuntimeError, storing nothing, if one hour holds ROW_CAP points or more.
    """
    now = now.astimezone(UTC)
    previous = last_pull(conn, env)
    if previous is not None and now - previous > timedelta(days=STALE_DAYS):
        log.warning(f"analytics: the last pull for {env} was {(now - previous).days} days ago; "
                    "Analytics Engine keeps about 3 months, so older points may be gone")
    start = _window_start(conn, env, now, first_day)
    end = datetime.combine(now.date() + timedelta(days=1), datetime.min.time(), UTC)
    rows: list[tuple] = []
    day = start
    while day < end:
        rows += [_row(env, r) for r in _fetch_day(sql, dataset, day)]
        day += timedelta(days=1)
    with conn:
        conn.execute("delete from points where env = ? and ts >= ?", (env, start.strftime(_TS)))
        conn.executemany(f"insert into points values ({', '.join('?' * 14)})", rows)
        conn.execute("insert into pulls values (?, ?, ?, ?, ?)",
                     (env, now.isoformat(), start.strftime(_TS), end.strftime(_TS), len(rows)))
    return PullResult(len(rows), start.date(), (end - timedelta(days=1)).date())


def _window_start(conn: sqlite3.Connection, env: str, now: datetime,
                  first_day: str | None) -> datetime:
    if first_day is not None:
        day = date.fromisoformat(first_day)
    else:
        newest = conn.execute("select max(ts) from points where env = ?", (env,)).fetchone()[0]
        day = (date.fromisoformat(newest[:10]) if newest
               else (now - timedelta(days=RETENTION_DAYS)).date())
    return datetime.combine(day, datetime.min.time(), UTC)


def _fetch_day(sql: Sql, dataset: str, day: datetime) -> list[dict]:
    rows = _query(sql, dataset, day, day + timedelta(days=1))
    if len(rows) < ROW_CAP:
        return rows
    hourly: list[dict] = []
    for hour in range(24):
        start = day + timedelta(hours=hour)
        part = _query(sql, dataset, start, start + timedelta(hours=1))
        if len(part) >= ROW_CAP:
            raise RuntimeError(f"analytics: {start:%Y-%m-%d %H}:00 UTC has {ROW_CAP:,} points or "
                               "more; pull can't fetch an hour that full")
        hourly += part
    return hourly


def _query(sql: Sql, dataset: str, start: datetime, end: datetime) -> list[dict]:
    return sql(f"SELECT {_COLUMNS} FROM {dataset} "
               f"WHERE timestamp >= toDateTime('{start:{_TS}}') "
               f"AND timestamp < toDateTime('{end:{_TS}}') "
               f"ORDER BY timestamp LIMIT {ROW_CAP} FORMAT JSON")


def _num(value: object) -> float | None:
    """Analytics Engine sends UInt64 as a string and doubles as numbers."""
    if value is None or value == "":
        return None
    return float(value)


def _row(env: str, r: dict) -> tuple:
    sample = _num(r.get("_sample_interval")) or 1.0
    if r.get("index1") == "report":
        return (env, "report", r["timestamp"], None, None, None, None,
                None, None, None, None, _num(r.get("double1")), r.get("blob1") or "", sample)
    return (env, "search", r["timestamp"], r.get("blob1"), r.get("blob2"), r.get("blob3"),
            r.get("blob4"), _num(r.get("double1")), _num(r.get("double2")),
            _num(r.get("double3")), _num(r.get("double4")), _num(r.get("double5")),
            r.get("blob5") or "", sample)
