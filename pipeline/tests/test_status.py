import json

from wts.log import run_record
from wts.state import fail
from wts.status import flagged_report, status_report


def test_status_report_lists_errors_and_runs(conn, make_episode):
    e = make_episode(stem="2020-01-01_ep001_a")
    fail(conn, e, "download", "404")
    with run_record(conn, "download") as r:
        r.counts["error"] += 1
    out = status_report(conn)
    assert "error: 1" in out
    assert "2020-01-01_ep001_a | download | 1 | 404" in out
    assert "download" in out.split("Last runs")[1]


def test_flagged_report_lists_flagged_episodes_oldest_first(conn, make_episode):
    make_episode(stem="2020-01-01_ep001_a", number=1, title="Clean")
    new = make_episode(
        stem="2021-01-01_ep003_c", number=3, title="Newer", published_at="2021-01-01T00:00:00+00:00"
    )
    old = make_episode(
        stem="2020-06-01_ep002_b", number=2, title="Older", published_at="2020-06-01T00:00:00+00:00"
    )
    conn.execute("update episodes set flags = ? where id = ?", ('["loop_cut", "wpm_low"]', new))
    conn.execute(
        "update episodes set flags = ?, reviewed_at = ? where id = ?",
        ('["loop_cut"]', "2026-10-13T00:00:00+00:00", old),
    )
    assert flagged_report(conn).splitlines() == [
        "Flagged episodes: 2 (1 to review)",
        "  2 | reviewed | loop_cut | Older",
        "  3 | to review | loop_cut, wpm_low | Newer",
    ]


def test_flagged_report_with_nothing_flagged(conn, make_episode):
    make_episode(stem="2020-01-01_ep001_a")
    assert flagged_report(conn) == "No flagged episodes"


def test_run_record_writes_counts_time_and_finish(conn):
    with run_record(conn, "chunk") as r:
        r.counts["ok"] += 2
    row = conn.execute("select * from runs where id = ?", (r.id,)).fetchone()
    assert json.loads(row["counts"]) == {"ok": 2, "seconds": 0}
    assert r.counts["seconds"] == 0
    assert row["errors"] == 0 and row["finished_at"] and row["machine"]


def test_status_shows_runs_readably(conn):
    with run_record(conn, "embed") as r:
        r.counts["ok"] += 3
    assert "embed  ok=3 in 0:00" in status_report(conn)
