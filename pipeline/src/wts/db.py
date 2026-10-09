"""The local state database (state.db) and its migrations."""

import logging
import sqlite3
from importlib import resources
from pathlib import Path

log = logging.getLogger("wts")


def _migrations() -> list[tuple[int, str]]:
    files = resources.files("wts").joinpath("migrations")
    found = []
    for f in files.iterdir():
        if f.name.endswith(".sql"):
            found.append((int(f.name.split("_", 1)[0]), f.read_text()))
    return sorted(found)


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    applied = []
    for number, sql in _migrations():
        if number > version:
            with conn:
                conn.executescript(sql)
                conn.execute(f"PRAGMA user_version = {number}")
            applied.append(number)
    # Said once, so a schema change on the Mac is visible in the run's output and logs.
    if len(applied) == 1:
        log.info(f"state.db: applied migration {applied[0]:03d}")
    elif applied:
        log.info(f"state.db: applied migrations {applied[0]:03d}–{applied[-1]:03d}")
    return conn


def kv_get(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("select value from kv where key = ?", (key,)).fetchone()
    return row[0] if row else None


def kv_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    with conn:
        conn.execute(
            "insert into kv (key, value) values (?, ?) "
            "on conflict(key) do update set value = excluded.value",
            (key, value),
        )
