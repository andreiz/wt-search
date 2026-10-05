import pytest
from conftest import status_of

from wts.db import kv_get, kv_set
from wts.state import InvalidTransition, Status, advance, episodes_for_step, fail, reset


def test_happy_path_advances(conn, make_episode):
    e = make_episode()
    for step, expected in [
        ("download", "downloaded"),
        ("transcribe", "transcribed"),
        ("chunk", "chunked"),
        ("embed", "embedded"),
        ("publish", "published"),
    ]:
        advance(conn, e, step)
        assert status_of(conn, e) == expected


def test_cannot_skip_a_step(conn, make_episode):
    e = make_episode()
    with pytest.raises(InvalidTransition):
        advance(conn, e, "chunk")


def test_failure_is_retried_three_times_then_parked(conn, make_episode):
    e = make_episode()
    for _ in range(3):
        assert [r["id"] for r in episodes_for_step(conn, "download", [e])] == [e]
        fail(conn, e, "download", "boom")
    assert episodes_for_step(conn, "download", [e]) == []
    row = conn.execute("select * from episodes where id=?", (e,)).fetchone()
    assert (row["status"], row["retries"], row["error_reason"]) == ("error", 3, "boom")


def test_error_retry_advances_and_clears(conn, make_episode):
    e = make_episode()
    fail(conn, e, "download", "boom")
    advance(conn, e, "download")
    row = conn.execute("select * from episodes where id=?", (e,)).fetchone()
    assert (row["status"], row["retries"], row["error_step"]) == ("downloaded", 0, None)


def test_error_from_other_step_not_selected(conn, make_episode):
    e = make_episode()
    fail(conn, e, "transcribe", "x")
    assert episodes_for_step(conn, "download", [e]) == []


def test_reset_only_to_new_or_transcribed(conn, make_episode):
    e = make_episode()
    with pytest.raises(ValueError):
        reset(conn, e, Status.CHUNKED)
    advance(conn, e, "download")
    reset(conn, e, Status.NEW)
    assert status_of(conn, e) == "new"


def test_episodes_for_step_orders_by_published_at(conn, make_episode):
    late = make_episode(published_at="2021-01-01T00:00:00+00:00")
    early = make_episode(published_at="2010-01-01T00:00:00+00:00")
    assert [r["id"] for r in episodes_for_step(conn, "download", [late, early])] == [early, late]


def test_kv_roundtrip(conn):
    assert kv_get(conn, "corrections_sha") is None
    kv_set(conn, "corrections_sha", "abc")
    kv_set(conn, "corrections_sha", "def")
    assert kv_get(conn, "corrections_sha") == "def"
