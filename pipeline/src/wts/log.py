"""JSON-lines logging and run records (spec §8.1)."""

import json
import logging
import platform
import sqlite3
import time
import uuid
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

LOGGER = "wts"
KEEP_DAYS = 30
_FIELDS = ("episode", "step", "duration_ms")


class JsonFormatter(logging.Formatter):
    def __init__(self, run_id: str):
        super().__init__()
        self.run_id = run_id

    def format(self, record: logging.LogRecord) -> str:
        line = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "run_id": self.run_id,
            "level": record.levelname,
            "msg": record.getMessage(),
            "error": self.formatException(record.exc_info) if record.exc_info else None,
        }
        for name in _FIELDS:
            line[name] = getattr(record, name, None)
        return json.dumps(line)


class ConsoleFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        parts = [record.levelname.lower()]
        for name in ("step", "episode"):
            if getattr(record, name, None):
                parts.append(str(getattr(record, name)))
        text = f"[{' '.join(parts)}] {record.getMessage()}"
        if record.exc_info:
            text += f": {record.exc_info[1]!r}"
        return text


def _prune(log_dir: Path) -> None:
    cutoff = time.time() - KEEP_DAYS * 86400
    for f in log_dir.glob("wts-*.log"):
        if f.stat().st_mtime < cutoff:
            f.unlink()


def setup_logging(log_dir: Path, run_id: str, *, console: bool = True) -> logging.Logger:
    log_dir.mkdir(parents=True, exist_ok=True)
    _prune(log_dir)
    log = logging.getLogger(LOGGER)
    for h in list(log.handlers):
        log.removeHandler(h)
        h.close()
    log.setLevel(logging.INFO)
    log.propagate = False
    today = datetime.now().astimezone().date()
    file_handler = logging.FileHandler(log_dir / f"wts-{today:%Y-%m-%d}.log")
    file_handler.setFormatter(JsonFormatter(run_id))
    log.addHandler(file_handler)
    if console:
        stream = logging.StreamHandler()
        stream.setFormatter(ConsoleFormatter())
        log.addHandler(stream)
    return log


@dataclass
class RunRecord:
    id: str
    counts: Counter = field(default_factory=Counter)


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


@contextmanager
def run_record(conn: sqlite3.Connection, command: str) -> Iterator[RunRecord]:
    record = RunRecord(id=uuid.uuid4().hex[:12])
    with conn:
        conn.execute(
            "insert into runs (id, command, machine, started_at) values (?, ?, ?, ?)",
            (record.id, command, platform.node(), _now()),
        )
    try:
        yield record
    finally:
        with conn:
            conn.execute(
                "update runs set finished_at = ?, counts = ?, errors = ? where id = ?",
                (_now(), json.dumps(dict(record.counts)), record.counts["error"], record.id),
            )
