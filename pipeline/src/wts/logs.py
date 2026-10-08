"""`wts logs`: read and filter the pipeline's JSON-lines logs (spec §8.1, §8.4).

The files are `wts-YYYY-MM-DD.log` in the log folder, one JSON object per line, written by
`log.JsonFormatter`. A line that isn't a JSON object with `ts`, `level` and `msg` is skipped.
"""

import json
import logging
import re
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta, tzinfo
from pathlib import Path

_SINCE = re.compile(r"(\d+)([mhd])")
_UNITS = {"m": "minutes", "h": "hours", "d": "days"}
LEVELS = ("debug", "info", "warning", "error", "critical")


def parse_since(text: str) -> timedelta:
    """`30m`, `12h` or `7d` as a timedelta; ValueError otherwise."""
    match = _SINCE.fullmatch(text.strip().lower())
    if not match or int(match[1]) == 0:
        raise ValueError(f"{text!r} is not a time span like 30m, 12h or 7d")
    return timedelta(**{_UNITS[match[2]]: int(match[1])})


def _level_number(name: str) -> int:
    if name.lower() not in LEVELS:
        raise ValueError(f"unknown level {name!r}; use one of {', '.join(LEVELS)}")
    return logging.getLevelNamesMapping()[name.upper()]


def _parse(text: str) -> dict | None:
    try:
        line = json.loads(text)
    except ValueError:
        return None
    if not isinstance(line, dict) or not all(
        isinstance(line.get(k), str) for k in ("ts", "level", "msg")
    ):
        return None
    return line


def _when(line: dict) -> datetime | None:
    try:
        ts = datetime.fromisoformat(line["ts"])
    except ValueError:
        return None
    return ts if ts.tzinfo else ts.replace(tzinfo=UTC)


def read_logs(
    log_dir: Path,
    *,
    run: str | None = None,
    episode: str | None = None,
    level: str | None = None,
    since: str | None = None,
    now: datetime | None = None,
) -> Iterator[dict]:
    """Log lines, oldest file first, that match every filter given.

    `run` is a run id; `episode` a stem or part of one (`ep312`); `level` a minimum
    (`warning` includes `error`); `since` a span back from `now` (`30m`, `12h`, `7d`).
    """
    minimum = _level_number(level) if level else None
    cutoff = (now or datetime.now(UTC)) - parse_since(since) if since else None
    names = logging.getLevelNamesMapping()
    for path in sorted(log_dir.glob("wts-*.log")):
        with path.open(encoding="utf-8", errors="replace") as f:
            for text in f:
                line = _parse(text)
                if line is None:
                    continue
                if run is not None and line.get("run_id") != run:
                    continue
                if episode is not None and episode not in (line.get("episode") or ""):
                    continue
                if minimum is not None and names.get(line["level"].upper(), 0) < minimum:
                    continue
                if cutoff is not None:
                    when = _when(line)
                    if when is None or when < cutoff:
                        continue
                yield line


def format_line(line: dict, *, tz: tzinfo | None = None) -> str:
    """One line for people, like the console's: local time, run id, then `[level step
    episode] msg`, with the last line of any traceback."""
    when = _when(line)
    stamp = when.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S") if when else line["ts"]
    parts = [line["level"].lower()]
    parts += [str(line[k]) for k in ("step", "episode") if line.get(k)]
    text = f"{stamp} {line.get('run_id') or '-'} [{' '.join(parts)}] {line['msg']}"
    error = [x for x in str(line.get("error") or "").splitlines() if x.strip()]
    if error:
        text += f": {error[-1].strip()}"
    return text
