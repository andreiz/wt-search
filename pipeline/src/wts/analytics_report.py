"""`wts analytics report`: what people searched for, from analytics.db alone (analytics design
§1.3, §3). By default only visitors count: points the Worker marked `pipeline` or
`maintainer` are left out, and so are older, unmarked points that look like ours (an eval
question, a budget or kill-switch test, a cache-busting token).
"""

import json
import re
import sqlite3
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, tzinfo
from pathlib import Path
from zoneinfo import ZoneInfo

from wts.evalset.cases import eval_dir, load_cases

_UTC = ZoneInfo("UTC")
_TS = "%Y-%m-%d %H:%M:%S"
_SPAN = re.compile(r"(\d+)d")
_FILTERS = re.compile(r"\b(?:year|ep|after|before|include|sort):\S+")
_CACHE_BUSTER = re.compile(r"\bz[qz]\d+\b")
_TEST_PREFIXES = ("budget ", "killswitch check")
_MODES = ("exact", "related", "smart")


def normalise(q: str) -> str:
    return " ".join(q.lower().split())


def parse_day_range(since: str | None, until: str | None, *, today: date) -> tuple[date, date]:
    """Local days, inclusive. `since` is `YYYY-MM-DD` or `Nd` (the last N days, today
    included); without it the range is the 7 days ending at `until` (default today)."""
    last = _day(until, "until") if until else today
    if since is None:
        first = last - timedelta(days=6)
    elif m := _SPAN.fullmatch(since.strip()):
        if int(m[1]) == 0:
            raise ValueError(f"{since!r}: use 1d or more")
        first = today - timedelta(days=int(m[1]) - 1)
    else:
        first = _day(since, "since")
    if first > last:
        raise ValueError(f"the range starts ({first}) after it ends ({last})")
    return first, last


def _day(text: str, what: str) -> date:
    try:
        return date.fromisoformat(text.strip())
    except ValueError:
        raise ValueError(f"--{what} {text!r}: use a date like 2026-10-29 or a span like 7d") from None


def utc_bounds(first: date, last: date, tz: tzinfo) -> tuple[str, str]:
    """The start of `first` and of the day after `last`, local, as UTC timestamps like the
    stored `ts`."""
    def utc(d: date) -> str:
        return datetime.combine(d, time(), tz).astimezone(_UTC).strftime(_TS)
    return utc(first), utc(last + timedelta(days=1))


def eval_query_set(directory: Path | None = None) -> frozenset[str]:
    """Every eval question, normalised: today's case files, plus the questions in past reports
    (`eval/reports/*.json`, not in git), which remember cases since dropped from the files."""
    directory = directory or eval_dir()
    queries = {normalise(c.query) for c in load_cases(directory)}
    for path in sorted((directory / "reports").glob("*.json")):
        try:
            cases = json.loads(path.read_text()).get("cases") or []
        except (OSError, ValueError, AttributeError):
            continue  # a half-written or foreign file: skip it, it only narrows the guess
        queries |= {normalise(c["query"]) for c in cases
                    if isinstance(c, dict) and isinstance(c.get("query"), str)}
    return frozenset(queries)


def classify(row_traffic: str, q: str | None, eval_queries: frozenset[str]) -> str:
    """The stored class, or for an unmarked (pre-2026-10-30) point a best guess from its query."""
    if row_traffic:
        return row_traffic
    if not q:
        return "web"
    text = normalise(q)
    bare = normalise(_FILTERS.sub(" ", text))
    if (bare in eval_queries or text in eval_queries or text.startswith(_TEST_PREFIXES)
            or _CACHE_BUSTER.search(text)):
        return "pipeline"
    return "web"


@dataclass(frozen=True)
class _Point:
    q: str | None
    mode: str
    sort: str
    cache: str
    results: float | None
    ms: float | None
    degraded: bool
    status: int
    weight: float


def summarise(conn: sqlite3.Connection, *, env: str, first: date, last: date, tz: tzinfo,
              top: int, include_all: bool, eval_queries: frozenset[str]) -> str:
    start, end = utc_bounds(first, last, tz)
    rows = conn.execute(
        "select kind, q, mode, sort, cache, results, ms, degraded, status, traffic, sample "
        "from points where env = ? and ts >= ? and ts < ? order by ts", (env, start, end))
    searches: list[_Point] = []
    reports = 0.0
    left_out: Counter[str] = Counter()
    for r in rows:
        cls = classify(r["traffic"], r["q"], eval_queries)
        weight = r["sample"] or 1.0
        if not include_all and cls != "web":
            if r["kind"] == "search":
                left_out[cls] += weight
            continue
        if r["kind"] == "report":
            reports += weight if r["status"] == 200 else 0
            continue
        searches.append(_Point(r["q"], r["mode"] or "", r["sort"] or "", r["cache"] or "",
                               r["results"], r["ms"], bool(r["degraded"]), int(r["status"] or 0),
                               weight))

    out = [_header(conn, env, first, last, tz)]
    if left_out:
        out.append("left out: " + ", ".join(f"{_n(n)} {cls}" for cls, n in left_out.most_common()))
    if not searches:
        out += ["", "no searches in this range"]
        return "\n".join(out)

    groups = _groups(searches)
    total = sum(p.weight for p in searches)
    modes = Counter()
    sorts = Counter()
    for p in searches:
        modes[p.mode or "unknown"] += p.weight
        if p.sort and p.sort != "relevance":
            sorts[p.sort] += p.weight
    out += ["", f"Searches: {_n(total)} ({len(groups)} distinct)",
            "Modes: " + ", ".join(f"{m} {_n(modes[m])}" for m in (*_MODES, "unknown") if modes[m])]
    if sorts:
        out.append("Sorts: " + ", ".join(f"{s} {_n(n)}" for s, n in sorts.most_common()))
    out.append(f"Reports sent: {_n(reports)}")

    out += ["", "Top searches"]
    for g in sorted(groups.values(), key=lambda g: -g.count)[:top]:
        avg = f"{g.avg_results:.1f}" if g.avg_results is not None else "-"
        out.append(f"{_n(g.count):>6}  avg {avg:>5}  {g.label}")

    out += ["", "Found nothing"]
    nothing = _groups([p for p in searches if p.status == 200 and p.results == 0])
    out += [f"{_n(g.count):>6}  {g.modes:<8} {g.label}"
            for g in sorted(nothing.values(), key=lambda g: -g.count)[:top]] or ["  none"]

    out += ["", "Errors and degraded"]
    problems = []
    by_status: dict[int, list[_Point]] = defaultdict(list)
    for p in searches:
        if p.status != 200:
            by_status[p.status].append(p)
    for status, points in sorted(by_status.items()):
        problems.append(f"  status {status}: {_n(sum(p.weight for p in points))}"
                        f"  ({_examples(points, top)})")
    degraded = [p for p in searches if p.degraded]
    if degraded:
        problems.append(f"  degraded: {_n(sum(p.weight for p in degraded))}"
                        f"  ({_examples(degraded, top)})")
    out += problems or ["  none"]

    out += ["", "Speed"]
    timed: dict[tuple[str, str], list[_Point]] = defaultdict(list)
    for p in searches:
        if p.ms is not None and p.mode:
            timed[(p.mode, p.cache or "unknown")].append(p)
    order = {m: i for i, m in enumerate(_MODES)}
    for (mode, cache), points in sorted(timed.items(), key=lambda k: (order.get(k[0][0], 9), k[0][1])):
        out.append(f"  {mode:<8} {cache:<5} p50 {_pct(points, 0.5):>6.0f} ms"
                   f"  p95 {_pct(points, 0.95):>6.0f} ms  ({_n(sum(p.weight for p in points))})")
    return "\n".join(out)


@dataclass
class _Group:
    count: float
    label: str
    avg_results: float | None
    modes: str


def _groups(points: Iterable[_Point]) -> dict[str, _Group]:
    spellings: dict[str, Counter[str]] = defaultdict(Counter)
    weights: Counter[str] = Counter()
    results: dict[str, list[tuple[float, float]]] = defaultdict(list)
    modes: dict[str, Counter[str]] = defaultdict(Counter)
    for p in points:
        raw = p.q or ""
        key = normalise(raw)
        spellings[key][raw] += p.weight
        weights[key] += p.weight
        modes[key][p.mode or "unknown"] += p.weight
        if p.results is not None:
            results[key].append((p.results, p.weight))
    groups = {}
    for key, count in weights.items():
        rs = results[key]
        w = sum(weight for _, weight in rs)
        groups[key] = _Group(
            count=count,
            label=spellings[key].most_common(1)[0][0] or "(empty)",
            avg_results=sum(r * weight for r, weight in rs) / w if w else None,
            modes="/".join(m for m, _ in modes[key].most_common()),
        )
    return groups


def _examples(points: list[_Point], top: int) -> str:
    groups = sorted(_groups(points).values(), key=lambda g: -g.count)[:min(top, 3)]
    return ", ".join(g.label for g in groups)


def _pct(points: list[_Point], p: float) -> float:
    ordered = sorted(points, key=lambda x: x.ms or 0.0)
    total = sum(x.weight for x in ordered)
    running = 0.0
    for x in ordered:
        running += x.weight
        if running >= p * total:
            return x.ms or 0.0
    return ordered[-1].ms or 0.0


def _n(value: float) -> str:
    return f"{value:,.0f}"


def _header(conn: sqlite3.Connection, env: str, first: date, last: date, tz: tzinfo) -> str:
    row = conn.execute("select max(at) from pulls where env = ?", (env,)).fetchone()
    pulled = (datetime.fromisoformat(row[0]).astimezone(tz).strftime("%Y-%m-%d %H:%M")
              if row and row[0] else "never")
    return f"Searches on {env}, {first} – {last} (last pulled {pulled})"
