import numpy as np
import pytest
from conftest import FakeEmbedder, force_status, status_of, stem_of

from wts.embed import SentenceTransformerEmbedder, load_embeddings
from wts.steps import run_embed


def add_chunks(conn, episode_id, texts_and_flags):
    conn.execute("delete from chunks where episode_id = ?", (episode_id,))
    for seq, (text, bp) in enumerate(texts_and_flags):
        conn.execute(
            "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times, "
            "is_boilerplate) values (?, ?, ?, ?, ?, ?, ?)",
            (episode_id, seq, seq * 30_000, seq * 30_000 + 29_999, text,
             ",".join("0" for _ in text.split()), int(bp)),
        )
    conn.commit()


CHUNKS = [
    ("we cut dovetails by hand today", False),
    ("this episode is brought to you by rockler", True),
    ("then we talked about finishing walnut", False),
]


@pytest.fixture
def chunked_episode(conn, make_episode):
    e = make_episode(status="chunked")
    add_chunks(conn, e, CHUNKS)
    return e


def non_boilerplate_chunk_ids(conn, e):
    return {
        r[0]
        for r in conn.execute(
            "select id from chunks where episode_id = ? and is_boilerplate = 0", (e,)
        )
    }


def test_embeds_only_non_boilerplate(conn, chunked_episode, paths, cfg):
    counts = run_embed(conn, paths, cfg, [chunked_episode], embedder=FakeEmbedder())
    ids, vecs = load_embeddings(paths.embeddings_dir / f"{stem_of(conn, chunked_episode)}.npz")
    assert set(ids.tolist()) == non_boilerplate_chunk_ids(conn, chunked_episode)
    assert vecs.shape == (len(ids), 768) and vecs.dtype == np.float32
    assert np.allclose(np.linalg.norm(vecs, axis=1), 1.0, atol=1e-5)
    assert status_of(conn, chunked_episode) == "embedded" and counts["ok"] == 1
    assert not list(paths.embeddings_dir.glob("*.tmp"))


def test_reembed_reuses_vectors_for_unchanged_text(conn, chunked_episode, paths, cfg):
    fake = FakeEmbedder()
    run_embed(conn, paths, cfg, [chunked_episode], embedder=fake)
    n_first = fake.calls
    add_chunks(conn, chunked_episode, CHUNKS)  # same text, new chunk ids
    force_status(conn, chunked_episode, "chunked")
    run_embed(conn, paths, cfg, [chunked_episode], embedder=fake)
    assert fake.calls == n_first  # nothing re-embedded
    ids, _ = load_embeddings(paths.embeddings_dir / f"{stem_of(conn, chunked_episode)}.npz")
    assert set(ids.tolist()) == non_boilerplate_chunk_ids(conn, chunked_episode)


def test_changed_text_is_reembedded(conn, chunked_episode, paths, cfg):
    fake = FakeEmbedder()
    run_embed(conn, paths, cfg, [chunked_episode], embedder=fake)
    add_chunks(conn, chunked_episode, [*CHUNKS[:2], ("then we talked about finishing cherry", False)])
    force_status(conn, chunked_episode, "chunked")
    before = fake.calls
    run_embed(conn, paths, cfg, [chunked_episode], embedder=fake)
    assert fake.calls == before + 1


def test_all_boilerplate_episode_writes_empty_file(conn, make_episode, paths, cfg):
    e = make_episode(status="chunked")
    add_chunks(conn, e, [("an ad read only", True)])
    run_embed(conn, paths, cfg, [e], embedder=FakeEmbedder())
    ids, vecs = load_embeddings(paths.embeddings_dir / f"{stem_of(conn, e)}.npz")
    assert ids.shape == (0,) and vecs.shape == (0, 768)
    assert status_of(conn, e) == "embedded"


def test_no_work_does_not_load_model(conn, paths, cfg, monkeypatch):
    import wts.steps

    monkeypatch.setattr(wts.steps, "get_embedder", lambda: pytest.fail("model loaded"))
    assert run_embed(conn, paths, cfg, []) == {}


def test_embedder_failure_fails_episode(conn, chunked_episode, paths, cfg):
    class Broken(FakeEmbedder):
        def embed(self, texts):
            raise RuntimeError("mps out of memory")

    run_embed(conn, paths, cfg, [chunked_episode], embedder=Broken())
    assert status_of(conn, chunked_episode) == "error"


@pytest.mark.mac
def test_bge_dimension_and_norm():
    v = SentenceTransformerEmbedder().embed(["dovetail saw"])
    assert v.shape == (1, 768) and abs(float(np.linalg.norm(v[0])) - 1.0) < 1e-4
