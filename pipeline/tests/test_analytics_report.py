"""`wts analytics report`: the summary from analytics.db, leaving out our own traffic
(analytics design §1.3, §3). Rows are written straight into a fresh analytics.db."""

from datetime import date
from zoneinfo import ZoneInfo

import pytest

from wts.analytics import open_db
from wts.analytics_report import (
    classify,
    eval_query_set,
    normalise,
    parse_day_range,
    summarise,
    utc_bounds,
)

LA = ZoneInfo("America/Los_Angeles")
TODAY = date(2026, 10, 29)
EVAL = frozenset({"conoid", "sketchup"})


@pytest.fixture
def conn(tmp_path):
    c = open_db(tmp_path / "analytics.db")
    c.execute("insert into pulls values ('staging', '2026-10-30T04:40:00+00:00', '', '', 0)")
    c.commit()
    yield c
    c.close()


def add(conn, q, *, ts="2026-10-29 18:00:00", mode="exact", sort="relevance", cache="miss",
        results=5, ms=50, degraded=0, status=200, traffic="web", sample=1, kind="search"):
    conn.execute("insert into points values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                 ("staging", kind, ts, q, mode, sort, cache, results, ms, degraded, 1, status,
                  traffic, sample))
    conn.commit()


def report(conn, *, first=date(2026, 10, 23), last=TODAY, include_all=False, top=20) -> str:
    return summarise(conn, env="staging", first=first, last=last, tz=LA, top=top,
                     include_all=include_all, eval_queries=EVAL)


def section(text: str, heading: str) -> str:
    """The lines under `heading`, up to the next blank line."""
    lines = text.splitlines()
    start = lines.index(heading) + 1
    out = []
    for line in lines[start:]:
        if not line.strip():
            break
        out.append(line)
    return "\n".join(out)


# --- dates ---


def test_parse_day_range_defaults_and_nd():
    assert parse_day_range(None, None, today=TODAY) == (date(2026, 10, 23), TODAY)
    assert parse_day_range("7d", None, today=TODAY) == (date(2026, 10, 23), TODAY)
    assert parse_day_range("1d", None, today=TODAY) == (TODAY, TODAY)
    assert parse_day_range("2026-10-01", None, today=TODAY) == (date(2026, 10, 1), TODAY)
    assert parse_day_range("2026-10-01", "2026-10-07", today=TODAY) == (
        date(2026, 10, 1), date(2026, 10, 7))
    assert parse_day_range(None, "2026-10-07", today=TODAY) == (date(2026, 10, 1), date(2026, 10, 7))


def test_parse_day_range_rejects_bad_input():
    with pytest.raises(ValueError):
        parse_day_range("2026-10-08", "2026-10-07", today=TODAY)
    with pytest.raises(ValueError):
        parse_day_range("yesterday", None, today=TODAY)
    with pytest.raises(ValueError):
        parse_day_range("0d", None, today=TODAY)


def test_local_day_bounds(conn):
    assert utc_bounds(TODAY, TODAY, LA) == ("2026-10-29 07:00:00", "2026-10-30 07:00:00")
    # 03:49 UTC on the 30th is 20:49 PDT on the 29th.
    add(conn, "late night search", ts="2026-10-30 03:49:31")
    add(conn, "too early", ts="2026-10-29 06:59:59")
    out = report(conn, first=TODAY, last=TODAY)
    assert "late night search" in out
    assert "too early" not in out


# --- classing ---


def test_classify_old_rows():
    assert classify("", "Conoid", EVAL) == "pipeline"
    assert classify("", "sketchup year:2014", EVAL) == "pipeline"
    assert classify("", "SketchUp  include:ads ep:12", EVAL) == "pipeline"
    assert classify("", "budget test 1 1793329063 walnut drawer slides", EVAL) == "pipeline"
    assert classify("", "killswitch check 1793330640 walnut", EVAL) == "pipeline"
    assert classify("", "chisel zq24446", EVAL) == "pipeline"
    assert classify("", "glue zz6221", EVAL) == "pipeline"
    assert classify("", "hide glue", EVAL) == "web"
    assert classify("", None, EVAL) == "web"
    assert classify("maintainer", "Conoid", EVAL) == "maintainer"  # a stored class stands
    assert classify("web", "Conoid", EVAL) == "web"


def test_eval_query_set_reads_both_files(tmp_path):
    (tmp_path / "queries.yaml").write_text(
        "- {id: a, query: '  Conoid ', tag: jargon, expect: [{episode: 71}]}\n")
    (tmp_path / "synthetic.yaml").write_text(
        "- {id: b, query: How Do I Flatten, tag: paraphrase, expect: [{episode: 1}]}\n")
    assert eval_query_set(tmp_path) == frozenset({"conoid", "how do i flatten"})


def test_normalise():
    assert normalise("  Hide\tGLUE  now ") == "hide glue now"


# --- the summary ---


def test_counts_use_sample(conn):
    add(conn, "hide glue", sample=10)
    assert "Searches: 10" in report(conn)


def test_groups_spellings_under_the_most_common(conn):
    for q in ("hide glue", "hide glue", "Hide Glue", "hide  glue"):
        add(conn, q)
    top = section(report(conn), "Top searches")
    assert len(top.splitlines()) == 1
    assert "4" in top and "hide glue" in top and "Hide Glue" not in top


def test_default_leaves_out_our_traffic(conn):
    add(conn, "hide glue")
    add(conn, "pipeline only", traffic="pipeline", sample=3)
    add(conn, "maintainer only", traffic="maintainer")
    add(conn, "Conoid", traffic="")  # an old, unmarked row matching the eval
    out = report(conn)
    assert "pipeline only" not in out and "maintainer only" not in out and "Conoid" not in out
    assert "left out: 4 pipeline, 1 maintainer" in out
    assert "Searches: 1" in out


def test_include_all(conn):
    add(conn, "hide glue")
    add(conn, "pipeline only", traffic="pipeline")
    out = report(conn, include_all=True)
    assert "pipeline only" in out
    assert "left out" not in out
    assert "Searches: 2" in out


def test_found_nothing_lists_zero_result_200s_only(conn):
    add(conn, "nothing here", results=0)
    add(conn, "a 503", results=0, status=503)
    add(conn, "plenty", results=9)
    nothing = section(report(conn), "Found nothing")
    assert "nothing here" in nothing
    assert "a 503" not in nothing and "plenty" not in nothing


def test_errors_and_degraded(conn):
    add(conn, "a 503", results=0, status=503)
    add(conn, "slow and degraded", mode="related", degraded=1)
    errors = section(report(conn), "Errors and degraded")
    assert "503" in errors and "a 503" in errors
    assert "degraded" in errors and "slow and degraded" in errors
    add_clean = report(conn, first=date(2026, 10, 1), last=date(2026, 10, 2))
    assert "no searches in this range" in add_clean


def test_speed_by_mode_and_cache(conn):
    for ms in (10, 20, 30, 40, 1000):
        add(conn, "x", mode="related", ms=ms)
    add(conn, "y", mode="exact", cache="hit", ms=5)
    speed = section(report(conn), "Speed")
    related = next(line for line in speed.splitlines() if "related" in line and "miss" in line)
    assert "30" in related and "1000" in related  # p50 30, p95 1000
    assert any("exact" in line and "hit" in line for line in speed.splitlines())
    assert not any("smart" in line for line in speed.splitlines())


def test_header_names_env_range_and_last_pull(conn):
    add(conn, "hide glue")
    first_line = report(conn).splitlines()[0]
    assert "staging" in first_line and "2026-10-23" in first_line and "2026-10-29" in first_line
    assert "2026-10-29 21:40" in first_line  # the pull at 04:40 UTC, in PDT


def test_reports_sent_are_counted(conn):
    add(conn, "hide glue")
    add(conn, None, kind="report", mode=None, status=200, traffic="web")
    add(conn, None, kind="report", mode=None, status=200, traffic="maintainer")
    assert "Reports sent: 1" in report(conn)


def test_top_caps_each_list(conn):
    for i in range(5):
        add(conn, f"query {i}")
    assert len(section(report(conn, top=2), "Top searches").splitlines()) == 2


def test_empty_range(conn):
    out = report(conn)
    assert "no searches in this range" in out


def test_rows_with_empty_fields(conn):
    add(conn, None, mode="", sort="", cache="", results=None, ms=None, status=0)
    out = report(conn)
    assert "Searches: 1" in out
    assert "status 0" in section(out, "Errors and degraded")
