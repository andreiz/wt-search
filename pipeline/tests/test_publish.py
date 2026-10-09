"""`wts publish` (plan 2, Task 7). The fake D1 applies every statement to an in-memory SQLite
loaded with `schema/*.sql`, so the publish SQL itself runs against the real contract."""

import sqlite3

import numpy as np
import pytest
from click.testing import CliRunner
from conftest import FakeEmbedder, force_status, status_of, stem_of
from test_schema_contract import apply_schema

from wts import publish
from wts.cli import main
from wts.config import Config
from wts.db import kv_get
from wts.embed import load_embeddings
from wts.publish import (
    due_episodes,
    episode_digest,
    run_publish,
    youtube_id_for_publish,
)
from wts.steps import run_embed


class Boom(Exception):
    pass


class FakeD1:
    def __init__(self):
        self.db = sqlite3.connect(":memory:")
        self.db.execute("PRAGMA foreign_keys = ON")
        apply_schema(self.db)
        self.calls = 0
        self.fail = False

    def batch(self, statements):
        self.calls += 1
        if self.fail:
            raise Boom("d1 down")
        out = []
        for sql, params in statements:
            cur = self.db.execute(sql, params)
            names = [d[0] for d in cur.description or []]
            out.append([dict(zip(names, r, strict=True)) for r in cur.fetchall()])
        self.db.commit()
        return out

    def query(self, sql, params=()):
        return self.batch([(sql, params)])[0]

    def rows(self, sql, params=()):
        return [tuple(r) for r in self.db.execute(sql, params)]


class FakeVectorize:
    def __init__(self):
        self.vectors: dict[str, tuple[list[float], dict]] = {}
        self.calls = 0
        self.fail_upsert = self.fail_delete = False

    def upsert(self, vectors):
        self.calls += 1
        if self.fail_upsert:
            raise Boom("vectorize down")
        for vid, values, meta in vectors:
            assert isinstance(vid, str)
            self.vectors[vid] = (list(values), dict(meta))
        return ["m"]

    def delete_by_ids(self, ids):
        self.calls += 1
        if self.fail_delete:
            raise Boom("vectorize down")
        for vid in ids:
            self.vectors.pop(vid, None)
        return ["m"]


class Target:
    def __init__(self):
        self.d1, self.vec = FakeD1(), FakeVectorize()

    @property
    def calls(self):
        return self.d1.calls + self.vec.calls


CHUNKS = [
    ("we cut dovetails by hand today", False),
    ("this episode is brought to you by rockler", True),
    ("then we talked about finishing walnut", False),
    ("and sharpening chisels on a strop", False),
]


def set_chunks(conn, episode_id, texts_and_flags):
    """Replace an episode's chunks, keeping ids by (episode, seq) as `wts chunk` does."""
    conn.execute("delete from chunks where episode_id = ? and seq >= ?",
                 (episode_id, len(texts_and_flags)))
    for seq, (text, bp) in enumerate(texts_and_flags):
        conn.execute(
            "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times, "
            "is_boilerplate) values (?, ?, ?, ?, ?, ?, ?) on conflict (episode_id, seq) do "
            "update set text = excluded.text, is_boilerplate = excluded.is_boilerplate",
            (episode_id, seq, seq * 30_000, seq * 30_000 + 29_999, text,
             ",".join("0" for _ in text.split()), int(bp)),
        )
    conn.commit()


@pytest.fixture
def embedded(conn, make_episode, paths, cfg):
    """An embedded episode, ready to publish."""

    def make(chunks=CHUNKS, **overrides):
        e = make_episode(status="chunked", published_at="2017-03-14T12:00:00+00:00",
                         **overrides)
        set_chunks(conn, e, chunks)
        run_embed(conn, paths, cfg, [e], embedder=FakeEmbedder())
        assert status_of(conn, e) == "embedded"
        return e

    return make


def rechunk(conn, paths, cfg, e, chunks):
    """What `wts chunk` + `wts embed` do after a corrections change."""
    set_chunks(conn, e, chunks)
    force_status(conn, e, "chunked")
    run_embed(conn, paths, cfg, [e], embedder=FakeEmbedder())


def pub(conn, paths, target, ids, env="staging", cfg=None, **kwargs):
    return run_publish(conn, paths, cfg or Config(), env, ids, d1=target.d1,
                       vectorize=target.vec, **kwargs)


def local_chunks(conn, e, boilerplate=None):
    sql = ("select id, episode_id, seq, start_ms, end_ms, text, word_times, is_boilerplate "
           "from chunks where episode_id = ?")
    if boilerplate is not None:
        sql += f" and is_boilerplate = {int(boilerplate)}"
    return [tuple(r) for r in conn.execute(sql + " order by id", (e,))]


def assert_published(conn, paths, target, e, env="staging"):
    """The state a clean publish of `e` to `env` leaves: D1, Vectorize and state.db."""
    row = conn.execute("select * from episodes where id = ?", (e,)).fetchone()
    assert target.d1.rows("select id, guid, title, year from episodes where id = ?", (e,)) == [
        (e, row["guid"], row["title"], int(row["published_at"][:4]))
    ]
    assert target.d1.rows(
        "select id, episode_id, seq, start_ms, end_ms, text, word_times, is_boilerplate "
        "from chunks where episode_id = ? order by id", (e,)
    ) == local_chunks(conn, e)
    target.d1.db.execute("insert into chunks_fts(chunks_fts, rank) values ('integrity-check', 1)")
    ids, vectors = load_embeddings(paths.embeddings_dir / f"{row['stem']}.npz")
    mine = {k: v for k, v in target.vec.vectors.items() if v[1]["episode_id"] == e}
    assert sorted(mine) == sorted(str(i) for i in ids)
    for chunk_id, vector in zip(ids, vectors, strict=True):
        values, meta = mine[str(chunk_id)]
        assert np.allclose(values, vector) and meta == {"episode_id": e, "year": 2017}
    assert conn.execute(
        "select digest from publications where episode_id = ? and env = ?", (e, env)
    ).fetchone()[0] == episode_digest(conn, row, paths.embeddings_dir)
    assert {r[0] for r in conn.execute(
        "select chunk_id from published_vectors where env = ? and episode_id = ?", (env, e)
    )} == {int(i) for i in ids}
    assert status_of(conn, e) == "published"


def test_first_publish(conn, paths, embedded):
    e = embedded()
    target = Target()
    counts = pub(conn, paths, target, [e])
    assert counts["ok"] == 1 and counts["vectors"] == 3 and counts["chunks"] == 4
    assert_published(conn, paths, target, e)
    fts = target.d1.rows("select rowid from chunks_fts where chunks_fts match 'dovetail'")
    assert fts == [(local_chunks(conn, e)[0][0],)]


def test_a_real_sized_episode_fits_d1_limits(conn, paths, embedded, monkeypatch):
    # Seed episodes average ~115 chunks: more than D1's 100 bound parameters in any one list.
    e = embedded([(f"chunk number {i} about joinery and glue", i % 20 == 0) for i in range(130)])
    target = Target()
    sizes = []
    real_batch = target.d1.batch

    def checked(statements):
        sizes.extend(len(params) for _, params in statements)
        return real_batch(statements)

    monkeypatch.setattr(target.d1, "batch", checked)
    pub(conn, paths, target, [e])
    assert max(sizes) <= 100
    assert_published(conn, paths, target, e)


def test_boilerplate_goes_to_d1_but_not_vectorize(conn, paths, embedded):
    e = embedded()
    target = Target()
    pub(conn, paths, target, [e])
    [bp] = local_chunks(conn, e, boilerplate=True)
    assert target.d1.rows("select is_boilerplate from chunks where id = ?", (bp[0],)) == [(1,)]
    assert str(bp[0]) not in target.vec.vectors


def test_republishing_unchanged_content_calls_nothing(conn, paths, embedded):
    e = embedded()
    target = Target()
    pub(conn, paths, target, [e])
    version = target.d1.rows("select value from meta where key = 'corpus_version'")
    calls = target.calls
    counts = pub(conn, paths, target, [e])
    assert target.calls == calls and counts["ok"] == 0
    assert target.d1.rows("select value from meta where key = 'corpus_version'") == version


def test_corpus_version_changes_when_something_is_published(conn, paths, embedded):
    e = embedded()
    target = Target()
    assert target.d1.rows("select value from meta where key = 'corpus_version'") == [("0",)]
    pub(conn, paths, target, [e])
    [(version,)] = target.d1.rows("select value from meta where key = 'corpus_version'")
    assert len(version) == 14 and version.isdigit()  # YYYYMMDDHHMMSS
    assert target.d1.rows("select count(*) from meta where key = 'last_published_at'") == [(1,)]


def test_rechunk_that_drops_a_chunk_removes_it_everywhere(conn, paths, cfg, embedded):
    e = embedded()
    target = Target()
    pub(conn, paths, target, [e])
    dropped = local_chunks(conn, e)[-1][0]
    rechunk(conn, paths, cfg, e, CHUNKS[:3])
    assert [r["id"] for r in due_episodes(conn, "staging", [e], paths.embeddings_dir)] == [e]
    pub(conn, paths, target, [e])
    assert target.d1.rows("select count(*) from chunks where id = ?", (dropped,)) == [(0,)]
    assert target.d1.rows("select rowid from chunks_fts where chunks_fts match 'strop'") == []
    assert str(dropped) not in target.vec.vectors
    assert_published(conn, paths, target, e)


def test_a_chunk_that_becomes_boilerplate_leaves_vectorize(conn, paths, cfg, embedded):
    e = embedded()
    target = Target()
    pub(conn, paths, target, [e])
    first = local_chunks(conn, e)[0][0]
    rechunk(conn, paths, cfg, e, [(CHUNKS[0][0], True), *CHUNKS[1:]])
    pub(conn, paths, target, [e])
    assert str(first) not in target.vec.vectors
    assert target.d1.rows("select is_boilerplate from chunks where id = ?", (first,)) == [(1,)]
    assert_published(conn, paths, target, e)


def test_changing_only_an_offset_republishes_the_episode_row(conn, paths, embedded):
    e = embedded()
    target = Target()
    pub(conn, paths, target, [e])
    conn.execute("update episodes set offset_spotify_s = 42 where id = ?", (e,))
    conn.commit()
    assert len(due_episodes(conn, "staging", [e], paths.embeddings_dir)) == 1
    assert pub(conn, paths, target, [e])["ok"] == 1
    assert target.d1.rows("select offset_spotify_s from episodes where id = ?", (e,)) == [(42,)]


def chunk_updates(target):
    """Log chunk ids updated in the fake D1 from now on."""
    target.d1.db.executescript(
        "create temp table updated (id integer);"
        "create temp trigger log_updates after update on chunks "
        "begin insert into updated values (new.id); end;"
    )
    return lambda: [r[0] for r in target.d1.db.execute("select id from updated")]


def test_republishing_writes_only_the_rows_that_changed(conn, paths, cfg, embedded):
    # D1 bills rows written; a one-sentence correction mustn't rewrite the whole episode.
    e = embedded()
    target = Target()
    pub(conn, paths, target, [e])
    updated = chunk_updates(target)
    conn.execute("update episodes set offset_apple_s = 5 where id = ?", (e,))
    conn.commit()
    pub(conn, paths, target, [e])
    assert updated() == []  # only the episode row changed
    second = local_chunks(conn, e)[2][0]
    rechunk(conn, paths, cfg, e, [*CHUNKS[:2], ("then we talked about finishing cherry", False),
                                  CHUNKS[3]])
    pub(conn, paths, target, [e])
    assert updated() == [second]
    assert_published(conn, paths, target, e)


@pytest.mark.parametrize(("video_s", "linked"),[(3605, False), (3602, True), (3597, True),
                                                 (3596, False), (None, False)])
def test_youtube_length_rule(conn, paths, embedded, video_s, linked):
    e = embedded(duration_s=3600, youtube_video_id="vid123", youtube_duration_s=video_s)
    row = conn.execute("select * from episodes where id = ?", (e,)).fetchone()
    assert youtube_id_for_publish(row) == ("vid123" if linked else None)
    target = Target()
    pub(conn, paths, target, [e])
    assert target.d1.rows("select youtube_video_id from episodes where id = ?", (e,)) == [
        ("vid123" if linked else None,)
    ]
    # The match itself stays in state.db for the review tool.
    assert conn.execute("select youtube_video_id from episodes where id = ?",
                        (e,)).fetchone()[0] == "vid123"


def test_platform_ids_and_number_reach_d1(conn, paths, embedded):
    e = embedded(number=613, apple_episode_id="1000700000613", spotify_episode_id="sp613")
    target = Target()
    pub(conn, paths, target, [e])
    assert target.d1.rows(
        "select number, apple_episode_id, spotify_episode_id, page_url from episodes"
    ) == [(613, "1000700000613", "sp613", conn.execute(
        "select page_url from episodes where id = ?", (e,)).fetchone()[0])]


def fail_step(monkeypatch, target, step):
    if step == "upsert":
        target.vec.fail_upsert = True
    elif step == "d1":
        target.d1.fail = True
    elif step == "delete":
        target.vec.fail_delete = True
    else:  # the local transaction
        def boom(*args, **kwargs):
            raise Boom("disk full")

        monkeypatch.setattr(publish, "advance", boom)


def heal(monkeypatch, target):
    target.vec.fail_upsert = target.vec.fail_delete = target.d1.fail = False
    monkeypatch.undo()


@pytest.mark.parametrize("step", ["upsert", "d1", "delete", "local"])
def test_a_failure_at_any_step_is_repaired_by_the_next_run(conn, paths, cfg, embedded,
                                                         monkeypatch, step):
    e = embedded()
    target = Target()
    pub(conn, paths, target, [e])
    rechunk(conn, paths, cfg, e, CHUNKS[:3])  # so the delete step has work to do
    fail_step(monkeypatch, target, step)
    counts = pub(conn, paths, target, [e])
    assert counts["error"] == 1 and counts["ok"] == 0
    row = conn.execute("select status, error_step, retries from episodes where id = ?",
                       (e,)).fetchone()
    assert tuple(row) == ("error", "publish", 1)
    assert conn.execute("select digest from publications where episode_id = ?",
                        (e,)).fetchone()[0] != episode_digest(
        conn, conn.execute("select * from episodes where id = ?", (e,)).fetchone(),
        paths.embeddings_dir)
    heal(monkeypatch, target)
    assert pub(conn, paths, target, [e])["ok"] == 1
    assert_published(conn, paths, target, e)


def lose_response(monkeypatch, target, step):
    """The call at `step` takes effect, then fails as if its response were lost."""
    def applied_then_lost(owner, name):
        real = getattr(owner, name)

        def call(*args, **kwargs):
            real(*args, **kwargs)
            raise Boom("response lost")

        monkeypatch.setattr(owner, name, call)

    if step == "local":
        fail_step(monkeypatch, target, step)
    else:
        applied_then_lost(*{"upsert": (target.vec, "upsert"), "d1": (target.d1, "batch"),
                            "delete": (target.vec, "delete_by_ids")}[step])


@pytest.mark.parametrize("step", ["upsert", "d1", "delete", "local"])
def test_reverting_after_a_lost_response_still_repairs_the_remote(conn, paths, cfg, embedded,
                                                                 monkeypatch, step):
    # Review #2: A published; B's writes land but the call fails; local content goes back to A.
    # The recorded digest is A's again, yet the environment holds B (or part of it).
    a = CHUNKS
    b = [(a[0][0], True), a[1], ("then we talked about finishing cherry", False), a[3]]
    e = embedded(a)
    target = Target()
    pub(conn, paths, target, [e])
    rechunk(conn, paths, cfg, e, b)
    lose_response(monkeypatch, target, step)
    assert pub(conn, paths, target, [e])["error"] == 1
    heal(monkeypatch, target)
    rechunk(conn, paths, cfg, e, a)
    assert [r["id"] for r in due_episodes(conn, "staging", [e], paths.embeddings_dir)] == [e]
    assert pub(conn, paths, target, [e])["ok"] == 1
    assert_published(conn, paths, target, e)
    assert pub(conn, paths, target, [e])["ok"] == 0  # and the mark is cleared


@pytest.mark.parametrize("step", ["upsert", "d1", "local"])  # a first publish deletes nothing
def test_a_failed_first_publish_is_repaired_too(conn, paths, embedded, monkeypatch, step):
    e = embedded()
    target = Target()
    fail_step(monkeypatch, target, step)
    assert pub(conn, paths, target, [e])["error"] == 1
    assert conn.execute("select count(*) from publications").fetchone()[0] == 0
    heal(monkeypatch, target)
    assert pub(conn, paths, target, [e])["ok"] == 1
    assert_published(conn, paths, target, e)


def test_vectors_sent_before_a_failure_are_cleaned_up_after_a_rechunk(conn, paths, cfg,
                                                                      embedded):
    # Upsert succeeds, D1 fails; then a re-chunk drops a chunk before the next publish. The
    # vector sent for that chunk must still be deleted (Review Focus 5).
    e = embedded()
    target = Target()
    target.d1.fail = True
    pub(conn, paths, target, [e])
    dropped = str(local_chunks(conn, e)[-1][0])
    assert dropped in target.vec.vectors
    target.d1.fail = False
    rechunk(conn, paths, cfg, e, CHUNKS[:3])
    assert pub(conn, paths, target, [e])["ok"] == 1
    assert dropped not in target.vec.vectors
    assert_published(conn, paths, target, e)


def test_one_failed_episode_does_not_stop_the_others(conn, paths, embedded):
    good, bad = embedded(), embedded()
    (paths.embeddings_dir / f"{stem_of(conn, bad)}.npz").unlink()
    target = Target()
    counts = pub(conn, paths, target, [good, bad])
    assert counts["ok"] == 1 and counts["error"] == 1
    assert status_of(conn, bad) == "error"
    assert_published(conn, paths, target, good)


def test_embeddings_that_dont_match_the_chunks_fail_the_episode(conn, paths, embedded):
    e = embedded()
    set_chunks(conn, e, CHUNKS[:3])  # re-chunked without re-embedding
    target = Target()
    counts = pub(conn, paths, target, [e])
    assert counts["error"] == 1 and target.calls == 0
    assert "embeddings" in conn.execute("select error_reason from episodes where id = ?",
                                        (e,)).fetchone()[0]


def test_vectors_computed_from_older_text_are_not_published(conn, paths, embedded):
    # Review #1: corrected text under unchanged chunk ids (chunks rewritten, embeddings not).
    e = embedded()
    conn.execute("update chunks set text = ? where episode_id = ? and seq = 2",
                 ("then we talked about finishing cherry", e))
    conn.commit()
    target = Target()
    counts = pub(conn, paths, target, [e])
    assert counts["error"] == 1 and counts["ok"] == 0 and target.calls == 0
    assert "wts embed" in conn.execute("select error_reason from episodes where id = ?",
                                       (e,)).fetchone()[0]
    assert conn.execute("select count(*) from publications").fetchone()[0] == 0


def test_parked_errors_are_not_retried(conn, paths, embedded):
    e = embedded()
    target = Target()
    target.d1.fail = True
    for _ in range(3):
        pub(conn, paths, target, [e])
    calls = target.calls
    target.d1.fail = False
    assert pub(conn, paths, target, [e])["ok"] == 0 and target.calls == calls


def test_staging_and_production_are_independent(conn, paths, embedded):
    e = embedded()
    staging, production = Target(), Target()
    pub(conn, paths, staging, [e], env="staging")
    assert [r["id"] for r in due_episodes(conn, "production", [e], paths.embeddings_dir)] == [e]
    assert due_episodes(conn, "staging", [e], paths.embeddings_dir) == []
    pub(conn, paths, production, [e], env="production")
    assert_published(conn, paths, production, e, env="production")
    assert_published(conn, paths, staging, e, env="staging")


def test_unpublished_statuses_are_not_due(conn, paths, embedded):
    e = embedded()
    force_status(conn, e, "chunked")
    assert due_episodes(conn, "staging", [e], paths.embeddings_dir) == []


def test_dry_run_calls_nothing_and_changes_nothing(conn, paths, embedded, wts_messages):
    e = embedded()
    target = Target()
    counts = pub(conn, paths, target, [e], dry_run=True)
    assert target.calls == 0 and counts["dry_run"] == 1
    assert status_of(conn, e) == "embedded"
    assert conn.execute("select count(*) from publications").fetchone()[0] == 0
    assert conn.execute("select count(*) from published_vectors").fetchone()[0] == 0
    assert any("would publish" in m for m in wts_messages)


def test_a_failed_corpus_version_bump_is_retried_next_run(conn, paths, embedded, monkeypatch):
    e = embedded()
    target = Target()
    real_batch = target.d1.batch

    def no_meta(statements):
        if any("meta" in sql for sql, _ in statements):
            raise Boom("d1 down")
        return real_batch(statements)

    monkeypatch.setattr(target.d1, "batch", no_meta)
    counts = pub(conn, paths, target, [e])
    assert counts["ok"] == 1 and counts["error"] == 1
    assert kv_get(conn, "publish.corpus_version_pending.staging") == "1"
    monkeypatch.undo()
    pub(conn, paths, target, [e])  # nothing due, but the bump is still owed
    assert target.d1.rows("select value from meta where key = 'corpus_version'") != [("0",)]
    assert kv_get(conn, "publish.corpus_version_pending.staging") is None


def test_an_interrupted_run_still_owes_the_corpus_version_bump(conn, paths, embedded,
                                                              monkeypatch):
    # Review #7: killed after the episode's publication was recorded, before the bump was owed.
    e = embedded()
    target = Target()

    def interrupted(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(publish, "plural", interrupted)  # first thing after a recorded success
    with pytest.raises(KeyboardInterrupt):
        pub(conn, paths, target, [e])
    monkeypatch.undo()
    assert target.d1.rows("select value from meta where key = 'corpus_version'") == [("0",)]
    assert due_episodes(conn, "staging", [e], paths.embeddings_dir) == []  # nothing changed
    pub(conn, paths, target, [e])
    assert target.d1.rows("select value from meta where key = 'corpus_version'") != [("0",)]
    assert kv_get(conn, "publish.corpus_version_pending.staging") is None


def test_cli_requires_a_valid_env(wts_home):
    result = CliRunner().invoke(main, ["publish", "--env", "prod"])
    assert result.exit_code == 2


def test_cli_names_missing_config(wts_home):
    result = CliRunner().invoke(main, ["publish", "--env", "staging"])
    assert result.exit_code == 2
    assert "cloudflare_account_id" in result.output and "[env.staging]" in result.output


def test_cli_names_a_missing_token(wts_home, monkeypatch):
    monkeypatch.delenv("WTS_SECRET_CLOUDFLARE_API_TOKEN", raising=False)
    (wts_home / "config.toml").write_text(
        'cloudflare_account_id = "acc"\n[env.staging]\nd1_database_id = "d"\n'
        'vectorize_index = "wts-chunks-staging"\n'
    )
    result = CliRunner().invoke(main, ["publish", "--env", "staging"])
    assert result.exit_code == 1
    assert "wts secrets set cloudflare_api_token" in result.output


def test_cli_dry_run_needs_no_config_or_token(wts_home):
    result = CliRunner().invoke(main, ["publish", "--env", "staging", "--dry-run"])
    assert result.exit_code == 0, result.output
    assert "publish: nothing to do" in result.output


def test_digest_covers_vectors(conn, paths, embedded):
    e = embedded()
    row = conn.execute("select * from episodes where id = ?", (e,)).fetchone()
    before = episode_digest(conn, row, paths.embeddings_dir)
    path = paths.embeddings_dir / f"{row['stem']}.npz"
    with np.load(path) as data:
        parts = {k: data[k] for k in data.files}
    parts["vectors"] = parts["vectors"] * -1
    with path.open("wb") as f:
        np.savez(f, **parts)
    assert episode_digest(conn, row, paths.embeddings_dir) != before
