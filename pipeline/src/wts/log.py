"""JSON-lines logging and run records (spec §8.1)."""

import json
import logging
import platform
import sqlite3
import time
import uuid
from collections import Counter
from collections.abc import Iterator, Mapping
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


def clock(seconds: float) -> str:
    """h:mm:ss, or m:ss under an hour."""
    s = round(seconds)
    h, rest = divmod(s, 3600)
    return f"{h}:{rest // 60:02d}:{rest % 60:02d}" if h else f"{rest // 60}:{rest % 60:02d}"


def plural(n: int, word: str) -> str:
    return f"{n} {word}" if n == 1 else f"{n} {word}s"


def describe(counts: Mapping[str, int]) -> str:
    """One step's counts for people: `ok=35 chunks=4120 in 0:48`, or `nothing to do`.

    Zero counts are left out.
    """
    parts = " ".join(f"{k}={v}" for k, v in counts.items() if k != "seconds" and v)
    seconds = counts.get("seconds")
    if not parts:
        return "nothing to do" if seconds is None else f"nothing to do ({clock(seconds)})"
    return parts if seconds is None else f"{parts} in {clock(seconds)}"


def describe_run(results: Mapping[str, Mapping[str, int]]) -> str:
    lines = [f"{step}: {describe(counts)}" for step, counts in results.items()]
    lines.append(f"total {clock(sum(c.get('seconds', 0) for c in results.values()))}")
    return "\n".join(lines)


@contextmanager
def run_record(conn: sqlite3.Connection, command: str) -> Iterator[RunRecord]:
    record = RunRecord(id=uuid.uuid4().hex[:12])
    started = time.monotonic()
    with conn:
        conn.execute(
            "insert into runs (id, command, machine, started_at) values (?, ?, ?, ?)",
            (record.id, command, platform.node(), _now()),
        )
    try:
        yield record
    finally:
        record.counts["seconds"] = round(time.monotonic() - started)
        with conn:
            conn.execute(
                "update runs set finished_at = ?, counts = ?, errors = ? where id = ?",
                (_now(), json.dumps(dict(record.counts)), record.counts["error"], record.id),
            )
