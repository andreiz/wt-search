import json

from wts.log import run_record
from wts.state import fail
from wts.status import status_report


def test_status_report_lists_errors_and_runs(conn, make_episode):
    e = make_episode(stem="2020-01-01_ep001_a")
    fail(conn, e, "download", "404")
    with run_record(conn, "download") as r:
        r.counts["error"] += 1
    out = status_report(conn)
    assert "error: 1" in out
    assert "2020-01-01_ep001_a | download | 1 | 404" in out
    assert "download" in out.split("Last runs")[1]


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
