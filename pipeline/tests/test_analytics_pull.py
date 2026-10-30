"""`wts analytics pull`: copying Analytics Engine points into analytics.db by whole UTC days
(analytics design §2). The SQL API is faked: a function that answers each day's query."""

import logging
import re
from datetime import UTC, datetime

import pytest

from wts.analytics import last_pull, open_db, pull

NOW = datetime(2026, 10, 29, 12, 0, tzinfo=UTC)
_DAY = re.compile(r"timestamp >= toDateTime\('(\S+) (\S+)'\) AND timestamp < toDateTime\('(\S+) (\S+)'\)")


def search_row(ts: str, q: str = "hide glue", traffic: str = "web", sample: str = "1") -> dict:
    return {"timestamp": ts, "index1": "search", "blob1": q, "blob2": "exact", "blob3": "relevance",
            "blob4": "miss", "blob5": traffic, "double1": 4, "double2": 55, "double3": 0,
            "double4": 1, "double5": 200, "_sample_interval": sample}


def report_row(ts: str, traffic: str = "maintainer") -> dict:
    return {"timestamp": ts, "index1": "report", "blob1": traffic, "blob2": "", "blob3": "",
            "blob4": "", "blob5": "", "double1": 400, "double2": 0, "double3": 0, "double4": 0,
            "double5": 0, "_sample_interval": 1}


class FakeEngine:
    """Serves rows by timestamp for the window in each query's WHERE clause."""

    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.queries: list[str] = []

    def __call__(self, query: str) -> list[dict]:
        self.queries.append(query)
        m = _DAY.search(query)
        assert m, query
        start, end = f"{m[1]} {m[2]}", f"{m[3]} {m[4]}"
        return [r for r in self.rows if start <= r["timestamp"] < end]


@pytest.fixture
def conn(tmp_path):
    c = open_db(tmp_path / "analytics.db")
    yield c
    c.close()


def stored(conn) -> list[tuple]:
    return [tuple(r) for r in conn.execute("select ts, q, traffic from points order by ts, q")]


def test_first_pull_asks_for_92_days_one_query_per_day(conn):
    engine = FakeEngine([])
    result = pull(conn, engine, env="staging", dataset="wts_staging", now=NOW)
    assert len(engine.queries) == 93  # 2026-07-29 through 2026-10-29
    assert "toDateTime('2026-07-29 00:00:00')" in engine.queries[0]
    assert "toDateTime('2026-10-30 00:00:00')" in engine.queries[-1]
    assert all("FROM wts_staging" in q for q in engine.queries)
    assert result.rows == 0
    assert str(result.first_day) == "2026-07-29" and str(result.last_day) == "2026-10-29"


def test_rows_are_mapped_for_search_and_report(conn):
    engine = FakeEngine([search_row("2026-10-29 03:00:00", traffic="pipeline", sample="10"),
                         report_row("2026-10-29 04:00:00")])
    assert pull(conn, engine, env="staging", dataset="wts_staging", now=NOW).rows == 2
    s = conn.execute("select * from points where kind = 'search'").fetchone()
    assert (s["env"], s["ts"], s["q"], s["mode"], s["sort"], s["cache"], s["traffic"]) == (
        "staging", "2026-10-29 03:00:00", "hide glue", "exact", "relevance", "miss", "pipeline")
    assert (s["results"], s["ms"], s["degraded"], s["page"], s["status"], s["sample"]) == (
        4, 55, 0, 1, 200, 10)
    r = conn.execute("select * from points where kind = 'report'").fetchone()
    assert (r["traffic"], r["status"], r["q"], r["mode"]) == ("maintainer", 400, None, None)


def test_repull_replaces_only_the_window(conn):
    engine = FakeEngine([search_row("2026-10-27 10:00:00", "a"), search_row("2026-10-28 10:00:00", "b")])
    pull(conn, engine, env="staging", dataset="wts_staging",
         now=datetime(2026, 10, 28, 12, tzinfo=UTC))
    # Cloudflare now has a late point for the 28th and a new one on the 29th; the 27th is gone
    # from its answer (as if expired) but must stay here.
    engine.rows = [search_row("2026-10-28 10:00:00", "b"), search_row("2026-10-28 11:00:00", "late"),
                   search_row("2026-10-29 01:00:00", "c")]
    engine.queries.clear()
    pull(conn, engine, env="staging", dataset="wts_staging", now=NOW)
    assert len(engine.queries) == 2  # the 28th (newest stored day) and the 29th
    assert stored(conn) == [("2026-10-27 10:00:00", "a", "web"), ("2026-10-28 10:00:00", "b", "web"),
                            ("2026-10-28 11:00:00", "late", "web"), ("2026-10-29 01:00:00", "c", "web")]


def test_repull_with_nothing_new_changes_nothing(conn):
    engine = FakeEngine([search_row("2026-10-29 01:00:00")])
    pull(conn, engine, env="staging", dataset="wts_staging", now=NOW)
    before = stored(conn)
    assert pull(conn, engine, env="staging", dataset="wts_staging", now=NOW).rows == 1
    assert stored(conn) == before


def test_envs_are_kept_apart(conn):
    pull(conn, FakeEngine([search_row("2026-10-29 01:00:00", "s")]), env="staging",
         dataset="wts_staging", now=NOW)
    pull(conn, FakeEngine([search_row("2026-10-29 01:00:00", "p")]), env="production",
         dataset="wts_production", now=NOW)
    assert [tuple(r) for r in conn.execute("select env, q from points order by env")] == [
        ("production", "p"), ("staging", "s")]


def test_a_capped_day_is_split_by_hour(conn):
    full_day = [search_row(f"2026-10-29 {h:02d}:{m:02d}:00") for h in range(24) for m in range(60)]
    full_day = (full_day * 8)[:10_000]  # exactly the cap, all on the 29th
    engine = FakeEngine(full_day)
    result = pull(conn, engine, env="staging", dataset="wts_staging",
                  now=datetime(2026, 10, 29, 23, tzinfo=UTC), first_day="2026-10-29")
    hour_queries = [q for q in engine.queries if "2026-10-29 01:00:00" in q]
    assert hour_queries, "the day was not split by hour"
    assert result.rows == 10_000


def test_an_hour_at_the_cap_fails_rather_than_dropping_points(conn):
    rows = [search_row("2026-10-29 05:00:00")] * 10_000
    with pytest.raises(RuntimeError, match="10,000"):
        pull(conn, FakeEngine(rows), env="staging", dataset="wts_staging", now=NOW,
             first_day="2026-10-29")
    assert stored(conn) == []  # nothing half-written


def test_a_stale_last_pull_warns(conn, caplog):
    pull(conn, FakeEngine([]), env="staging", dataset="wts_staging",
         now=datetime(2026, 8, 1, tzinfo=UTC))
    with caplog.at_level(logging.WARNING, logger="wts"):
        pull(conn, FakeEngine([]), env="staging", dataset="wts_staging", now=NOW)
    assert any("3 months" in r.getMessage() for r in caplog.records)


def test_last_pull(conn):
    assert last_pull(conn, "staging") is None
    pull(conn, FakeEngine([]), env="staging", dataset="wts_staging", now=NOW)
    assert last_pull(conn, "staging") == NOW
