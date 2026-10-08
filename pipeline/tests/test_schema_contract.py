"""The D1 schema in `schema/` is the contract between the pipeline and the Worker (spec §2, §4.1).

These tests apply the same migration files wrangler applies to D1 to an in-memory SQLite, so
the publish SQL (plan 2, Task 7) can be tested against the real tables.
"""

import sqlite3
from pathlib import Path

import pytest

SCHEMA_DIR = Path(__file__).resolve().parents[2] / "schema"


def apply_schema(conn: sqlite3.Connection) -> None:
    for f in sorted(SCHEMA_DIR.glob("*.sql")):
        conn.executescript(f.read_text())


@pytest.fixture
def d1():
    conn = sqlite3.connect(":memory:")
    conn.execute("PRAGMA foreign_keys = ON")  # D1 enforces foreign keys
    apply_schema(conn)
    yield conn
    conn.close()


def fts(conn, query: str) -> list[int]:
    return [
        r[0]
        for r in conn.execute(
            "select rowid from chunks_fts where chunks_fts match ? order by rowid", (query,)
        )
    ]


def add_episode(d1, episode_id=1):
    d1.execute(
        "insert into episodes(id, guid, title, published_at, year) values (?, ?, 'T', "
        "'2017-03-14', 2017)",
        (episode_id, f"g{episode_id}"),
    )


def add_chunk(d1, chunk_id, text, episode_id=1, seq=0):
    d1.execute(
        "insert into chunks(id, episode_id, seq, start_ms, end_ms, text, word_times) "
        "values (?, ?, ?, 0, 30000, ?, '0,400')",
        (chunk_id, episode_id, seq, text),
    )


def test_schema_files_exist():
    assert min(p.name for p in SCHEMA_DIR.glob("*.sql")) == "0001_init.sql"


def test_fts_follows_inserts_updates_and_deletes(d1):
    add_episode(d1)
    add_chunk(d1, 10, "gluing dovetails")
    assert fts(d1, "dovetail") == [10]  # porter: dovetails → dovetail
    d1.execute("update chunks set text = 'planing tenons' where id = 10")
    assert fts(d1, "dovetail") == [] and fts(d1, "tenon") == [10]
    d1.execute("delete from chunks where id = 10")
    assert fts(d1, "tenon") == []


def test_fts_follows_upsert_on_conflict(d1):
    # Publishing upserts chunks by id; the update path must refresh the index too.
    add_episode(d1)
    add_chunk(d1, 10, "gluing dovetails")
    d1.execute(
        "insert into chunks(id, episode_id, seq, start_ms, end_ms, text, word_times) "
        "values (10, 1, 0, 0, 30000, 'planing tenons', '0') on conflict(id) do update set "
        "text = excluded.text, word_times = excluded.word_times"
    )
    assert fts(d1, "dovetail") == [] and fts(d1, "tenon") == [10]


def test_fts_index_passes_integrity_check(d1):
    add_episode(d1)
    add_chunk(d1, 10, "gluing dovetails", seq=0)
    add_chunk(d1, 11, "sharpening chisels", seq=1)
    d1.execute("update chunks set text = 'planing tenons' where id = 10")
    d1.execute("delete from chunks where id = 11")
    # Raises "database disk image is malformed" if the index and the content table disagree.
    d1.execute("insert into chunks_fts(chunks_fts, rank) values ('integrity-check', 1)")


def test_unicode_and_highlight(d1):
    add_episode(d1)
    add_chunk(d1, 10, "Café-style SawStop, naturally")
    assert fts(d1, "cafe") == [10]  # unicode61 removes diacritics
    marked = d1.execute(
        "select highlight(chunks_fts, 0, char(1), char(2)) from chunks_fts "
        "where chunks_fts match 'sawstop'"
    ).fetchone()[0]
    assert marked == "Café-style \x01SawStop\x02, naturally"


def test_chunks_need_an_episode(d1):
    with pytest.raises(sqlite3.IntegrityError):
        add_chunk(d1, 10, "orphan", episode_id=99)


def test_meta_starts_at_corpus_version_zero(d1):
    assert d1.execute("select value from meta where key = 'corpus_version'").fetchone() == ("0",)


def test_offsets_default_to_zero(d1):
    add_episode(d1)
    row = d1.execute(
        "select offset_apple_s, offset_spotify_s, offset_youtube_s, apple_episode_id, "
        "spotify_episode_id, youtube_video_id from episodes where id = 1"
    ).fetchone()
    assert row == (0, 0, 0, None, None, None)


def test_boilerplate_defaults_off_and_reports_default_open(d1):
    add_episode(d1)
    add_chunk(d1, 10, "text")
    assert d1.execute("select is_boilerplate from chunks").fetchone() == (0,)
    d1.execute("insert into reports(chunk_id, created_at, quoted_text) values (10, 'now', 'x')")
    assert d1.execute("select status from reports").fetchone() == ("open",)


def test_usage_counts_smart_searches_per_day(d1):
    # The Worker's daily smart-search budget (spec §4.8 item 2, schema/0002_usage.sql): the
    # very statement worker/src/budget.ts runs, one per uncached smart search.
    upsert = ("insert into usage (day, smart) values (?, 1) on conflict (day) do update "
              "set smart = smart + 1 returning smart, alerted_half, alerted_full")
    assert d1.execute(upsert, ("2026-10-08",)).fetchone() == (1, 0, 0)
    assert d1.execute(upsert, ("2026-10-08",)).fetchone() == (2, 0, 0)
    assert d1.execute(upsert, ("2026-10-09",)).fetchone() == (1, 0, 0)
    claim = "update usage set alerted_half = 1 where day = ? and alerted_half = 0"
    assert d1.execute(claim, ("2026-10-08",)).rowcount == 1
    assert d1.execute(claim, ("2026-10-08",)).rowcount == 0  # an alert is sent once a day


def test_chunks_indexed_by_episode_and_seq(d1):
    plan = d1.execute(
        "explain query plan select id from chunks where episode_id = 1 order by seq"
    ).fetchall()
    assert any("chunks_episode_seq" in row[-1] for row in plan)
