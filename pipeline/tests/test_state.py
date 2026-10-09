import sqlite3

import pytest
from conftest import insert_episode, status_of

from wts.db import _migrations, connect, kv_get, kv_set
from wts.state import (
    InvalidTransition,
    Status,
    advance,
    episodes_for_step,
    fail,
    publish_ready,
    reset,
)


def test_platform_migration_applies_on_a_plan1_database(tmp_path):
    path = tmp_path / "state.db"
    old = sqlite3.connect(path)
    for number, sql in _migrations():
        if number <= 3:
            old.executescript(sql)
            old.execute(f"PRAGMA user_version = {number}")
    e = insert_episode(old, status="embedded", title="Dovetails")
    old.execute(
        "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times) "
        "values (?, 0, 0, 1000, 'hi', '0')",
        (e,),
    )
    old.commit()
    old.close()

    conn = connect(path)
    row = conn.execute("select * from episodes where id = ?", (e,)).fetchone()
    assert (row["status"], row["title"]) == ("embedded", "Dovetails")
    assert (row["offset_apple_s"], row["offset_spotify_s"], row["offset_youtube_s"]) == (0, 0, 0)
    for col in ("apple_episode_id", "spotify_episode_id", "youtube_video_id",
                "youtube_duration_s", "platforms_checked_at"):
        assert row[col] is None
    assert conn.execute("select count(*) from chunks").fetchone()[0] == 1
    assert conn.execute("select count(*) from publications").fetchone()[0] == 0
    assert conn.execute("select count(*) from published_vectors").fetchone()[0] == 0


def test_failed_at_migration_applies_on_an_existing_database(tmp_path):
    path = tmp_path / "state.db"
    old = sqlite3.connect(path)
    for number, sql in _migrations():
        if number <= 4:
            old.executescript(sql)
            old.execute(f"PRAGMA user_version = {number}")
    broken = insert_episode(old, status="error", updated_at="2026-01-02T03:04:05+00:00")
    fine = insert_episode(old, status="embedded")
    old.commit()
    old.close()

    conn = connect(path)
    failed = dict(conn.execute("select id, failed_at from episodes").fetchall())
    assert failed == {broken: "2026-01-02T03:04:05+00:00", fine: None}


def test_fail_stamps_failed_at_and_other_changes_do_not(conn, make_episode):
    e = make_episode()

    def failed_at():
        return conn.execute("select failed_at from episodes where id = ?", (e,)).fetchone()[0]

    assert failed_at() is None
    fail(conn, e, "download", "boom")
    stamped = failed_at()
    assert stamped is not None
    conn.execute("update episodes set title = 'edited' where id = ?", (e,))
    reset(conn, e, Status.NEW)
    assert failed_at() == stamped


def test_publications_are_per_environment(conn, make_episode):
    e = make_episode()
    for env in ("staging", "production"):
        conn.execute(
            "insert into publications (episode_id, env, digest, published_at) "
            "values (?, ?, 'd', 'now')",
            (e, env),
        )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "insert into publications (episode_id, env, digest, published_at) "
            "values (?, 'staging', 'd2', 'now')",
            (e,),
        )
    conn.execute(
        "insert into published_vectors (env, chunk_id, episode_id) values ('staging', 7, ?)", (e,)
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "insert into published_vectors (env, chunk_id, episode_id) values ('staging', 7, ?)",
            (e,),
        )


def test_publish_ready_takes_embedded_published_and_retryable_errors(conn, make_episode):
    embedded = make_episode(status="embedded")
    published = make_episode(status="published")
    chunked = make_episode(status="chunked")
    retry = make_episode(status="embedded")
    fail(conn, retry, "publish", "boom")
    parked = make_episode(status="embedded")
    for _ in range(3):
        fail(conn, parked, "publish", "boom")
    other_error = make_episode(status="chunked")
    fail(conn, other_error, "embed", "boom")
    ids = [embedded, published, chunked, retry, parked, other_error]
    assert sorted(r["id"] for r in publish_ready(conn, ids)) == sorted(
        [embedded, published, retry]
    )
    assert publish_ready(conn, []) == []
    assert [r["id"] for r in publish_ready(conn, [published])] == [published]


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
