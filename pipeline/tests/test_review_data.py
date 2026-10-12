import json

from conftest import seg, tx

from wts.corrections import CorrectionRule
from wts.review.data import LOW_PROB, chunk_position, episode_payload, worst_stretches


def _row(conn, episode_id):
    return conn.execute("select * from episodes where id = ?", (episode_id,)).fetchone()


def _write(conn, paths, episode_id, data):
    stem = conn.execute("select stem from episodes where id = ?", (episode_id,)).fetchone()[0]
    paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
    out = paths.transcripts_dir / f"{stem}.json"
    out.write_text(json.dumps(data))
    conn.execute("update episodes set transcript_path = ? where id = ?", (str(out), episode_id))
    conn.commit()


def _words_at(start_s: float, n: int, prob: float):
    """`n` payload words, one every 0.5 s from `start_s`."""
    return [
        [f"w{i}", int((start_s + i * 0.5) * 1000), int((start_s + i * 0.5) * 1000) + 400, prob]
        for i in range(n)
    ]


def test_payload_words_sentences_and_episode(conn, paths, make_episode, audio_file):
    e = make_episode(audio_path=str(audio_file), title="Planes")
    _write(conn, paths, e, tx(seg("Cut the tenon."), seg("Then glue it up.")))
    payload = episode_payload(conn, _row(conn, e), [])
    assert [w[0] for w in payload["words"]] == ["Cut", "the", "tenon.", "Then", "glue", "it", "up."]
    assert all(len(w) == 4 for w in payload["words"])
    assert payload["sentences"] == [0, 3]
    ep = payload["episode"]
    assert ep["id"] == e
    assert ep["title"] == "Planes"
    assert ep["flags"] == []
    assert ep["reviewed_at"] is None
    assert ep["has_audio"] is True
    assert {"number", "published_at", "stem", "duration_s"} <= set(ep)


def test_payload_shows_corrected_words(conn, paths, make_episode):
    e = make_episode()
    _write(conn, paths, e, tx(seg("Ask mark about it.")))
    rules = [CorrectionRule(("mark",), "Marc", None)]
    payload = episode_payload(conn, _row(conn, e), rules)
    assert [w[0] for w in payload["words"]] == ["Ask", "Marc", "about", "it."]


def test_payload_has_audio_false_when_missing(conn, paths, make_episode, tmp_path):
    no_path = make_episode()
    gone = make_episode(audio_path=str(tmp_path / "nope.mp3"))
    for e in (no_path, gone):
        _write(conn, paths, e, tx(seg("Hello there.")))
        assert episode_payload(conn, _row(conn, e), [])["episode"]["has_audio"] is False


def test_payload_flags_and_reviewed_at(conn, paths, make_episode):
    e = make_episode(flags=json.dumps(["retimed"]))
    _write(conn, paths, e, tx(seg("Hello there.")))
    payload = episode_payload(conn, _row(conn, e), [])
    assert payload["episode"]["flags"] == ["retimed"]
    assert payload["episode"]["reviewed_at"] is None  # no column before migration 007


def test_payload_chunks_in_seq_order_and_empty_before_chunking(conn, paths, make_episode):
    e = make_episode()
    _write(conn, paths, e, tx(seg("Hello there.")))
    assert episode_payload(conn, _row(conn, e), [])["chunks"] == []
    for seq, start in ((1, 5000), (0, 0)):
        conn.execute(
            "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times, "
            "is_boilerplate) values (?, ?, ?, ?, 'x', '[]', ?)",
            (e, seq, start, start + 4000, seq),
        )
    conn.commit()
    chunks = episode_payload(conn, _row(conn, e), [])["chunks"]
    assert [c["seq"] for c in chunks] == [0, 1]
    assert [c["is_boilerplate"] for c in chunks] == [0, 1]
    assert set(chunks[0]) == {"id", "seq", "start_ms", "end_ms", "is_boilerplate"}


def test_payload_worst_stretches(conn, paths, make_episode):
    e = make_episode()
    data = tx(seg("a b c d e f g h i j k l m n o p q r s t u v w x y z"))
    for w in data["segments"][0]["words"]:
        w["probability"] = 0.2
    _write(conn, paths, e, data)
    worst = episode_payload(conn, _row(conn, e), [])["worst"]
    assert worst == [{"start_ms": 0, "share": 1.0}]


def test_worst_stretches_orders_by_share_and_skips_short_stretches():
    words = (
        _words_at(0, 20, 0.9)  # 0-10 s: no unsure words
        + [[*w[:3], 0.1 if i < 5 else 0.9] for i, w in enumerate(_words_at(60, 20, 0))]
        + [[*w[:3], 0.1 if i < 10 else 0.9] for i, w in enumerate(_words_at(120, 20, 0))]
        + _words_at(180, 19, 0.1)  # all unsure but under 20 words
    )
    assert worst_stretches(words) == [
        {"start_ms": 120_000, "share": 0.5},
        {"start_ms": 60_000, "share": 0.25},
        {"start_ms": 0, "share": 0.0},
    ]


def test_worst_stretches_top_and_threshold():
    words = []
    for k in range(7):
        words += [[*w[:3], 0.1 if i <= k else 0.9] for i, w in enumerate(_words_at(k * 60, 20, 0))]
    top = worst_stretches(words)
    assert [s["start_ms"] for s in top] == [360_000, 300_000, 240_000, 180_000, 120_000]
    assert len(worst_stretches(words, top=2)) == 2
    # A probability of exactly LOW_PROB is not "under".
    edge = _words_at(0, 20, LOW_PROB)
    assert worst_stretches(edge) == [{"start_ms": 0, "share": 0.0}]
    assert worst_stretches([]) == []


def test_chunk_position(conn, make_episode):
    e = make_episode()
    cur = conn.execute(
        "insert into chunks (episode_id, seq, start_ms, end_ms, text, word_times) "
        "values (?, 0, 7000, 9000, 'x', '[]')",
        (e,),
    )
    conn.commit()
    assert chunk_position(conn, cur.lastrowid) == (e, 7000)
    assert chunk_position(conn, 99999) is None
