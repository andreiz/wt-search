import json

from conftest import seg, tx

from wts.corrections import CorrectionRule
from wts.review.data import (
    LOW_PROB,
    chunk_position,
    episode_list,
    episode_payload,
    is_unsure,
    key_text,
    next_flagged,
    next_repair,
    worst_stretches,
)


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


def test_payload_words_include_accepted_repair(conn, paths, make_episode):
    from pathlib import Path

    from wts.repairs import Repair, RepairsFile, save_repairs, transcript_sha
    from wts.words import Word

    e = make_episode()
    _write(conn, paths, e, tx(seg("Cut the tenon."), seg("Then glue it up.")))
    row = _row(conn, e)
    t = Path(row["transcript_path"])
    after = [Word(x, 900 + i, 950 + i, 0.9) for i, x in enumerate(["and", "let", "it", "dry"])]
    save_repairs(t, RepairsFile(transcript_sha(t), [], [Repair(
        id="1-2", hole=(1, 2), clip=(0, 3), index=3, from_ms=0, to_ms=0, before=[],
        after=after, second_after=None, fails=[], status="accepted")]))
    payload = episode_payload(conn, row, [])  # raises if it disagrees with wts chunk's words
    assert [w[0] for w in payload["words"]][3:7] == ["and", "let", "it", "dry"]


def _repair(rid, hole, status, index=3):
    from wts.repairs import Repair
    from wts.words import Word

    after = [Word("and", hole[0] * 1000, hole[0] * 1000 + 300, 0.9)]
    return Repair(
        id=rid, hole=hole, clip=(hole[0] - 1, hole[1] + 1), index=index, from_ms=0, to_ms=0,
        before=[], after=after, second_after=None, fails=[2], status=status,
    )


def test_payload_repairs_in_time_order_whatever_their_status(conn, paths, make_episode):
    # A decided repair keeps its place in the Repairs line (the maintainer, 2026-10-27: it
    # jumped to the end when accepted).
    from pathlib import Path

    from wts.repairs import RepairsFile, save_repairs, transcript_sha

    e = make_episode()
    _write(conn, paths, e, tx(seg("Cut the tenon."), seg("Then glue it up.")))
    row = _row(conn, e)
    t = Path(row["transcript_path"])
    repairs = [
        _repair("30-32", (30, 32), "rejected"),
        _repair("20-22", (20, 22), "proposed"),
        _repair("10-12", (10, 12), "accepted"),
        _repair("5-7", (5, 7), "proposed"),
    ]
    repairs[3].machine = "walnut"
    save_repairs(t, RepairsFile(transcript_sha(t), [], repairs))
    got = episode_payload(conn, row, [])["repairs"]
    assert [r["id"] for r in got] == ["5-7", "10-12", "20-22", "30-32"]
    first = got[0]
    assert first["status"] == "proposed"
    assert first["fails"] == [2]
    assert first["hole"] == [5, 7]
    assert first["index"] == 3
    assert (first["from_ms"], first["to_ms"]) == (0, 0)
    assert first["before"] == []
    assert first["after"] == [["and", 5000, 5300, 0.9]]
    assert first["machine"] == "walnut"
    assert got[1]["machine"] is None  # a file from before the machine was recorded


def test_payload_repairs_say_where_they_are_in_the_shown_words(conn, paths, make_episode):
    # `index` counts the cleaned words before any repair or join; the page needs the position
    # in payload.words, after an earlier accepted repair (+2) and a joined "split -top" (-1).
    from pathlib import Path

    from wts.repairs import Repair, RepairsFile, save_repairs, transcript_sha
    from wts.words import Word

    e = make_episode()
    _write(conn, paths, e, tx(seg("Cut the split -top tenon."), seg("Then glue it up."),
                              seg("Clamp it tight.")))
    row = _row(conn, e)
    t = Path(row["transcript_path"])
    added = [Word("and", 1300, 1350, 0.9), Word("dry", 1400, 1450, 0.9)]
    save_repairs(t, RepairsFile(transcript_sha(t), [], [
        Repair(id="a", hole=(1250, 1490), clip=(0, 3000), index=5, from_ms=1200, to_ms=1500,
               before=[], after=added, second_after=None, fails=[], status="accepted"),
        Repair(id="b", hole=(2650, 2690), clip=(0, 4000), index=9, from_ms=2600, to_ms=2700,
               before=[], after=[Word("x", 2660, 2680, 0.9)] * 3, second_after=None, fails=[2],
               status="proposed"),
    ]))
    payload = episode_payload(conn, row, [])
    words = [w[0] for w in payload["words"]]
    at = {r["id"]: r["at"] for r in payload["repairs"]}
    assert words[at["a"]:at["a"] + 2] == ["and", "dry"]
    assert words[at["b"]] == "Clamp"


def test_payload_repairs_empty_when_missing_or_stale(conn, paths, make_episode):
    from pathlib import Path

    from wts.repairs import RepairsFile, save_repairs

    e = make_episode()
    _write(conn, paths, e, tx(seg("Cut the tenon.")))
    row = _row(conn, e)
    assert episode_payload(conn, row, [])["repairs"] == []
    save_repairs(Path(row["transcript_path"]), RepairsFile("0" * 64, [], [_repair("1-2", (1, 2), "proposed")]))
    assert episode_payload(conn, row, [])["repairs"] == []


def test_payload_shows_corrected_words(conn, paths, make_episode):
    e = make_episode()
    _write(conn, paths, e, tx(seg("Ask mark about it.")))
    rules = [CorrectionRule(("mark",), "Marc", None)]
    payload = episode_payload(conn, _row(conn, e), rules)
    assert [w[0] for w in payload["words"]] == ["Ask", "Marc", "about", "it."]


def test_payload_fixes_say_what_whisper_wrote(conn, paths, make_episode):
    e = make_episode()
    _write(conn, paths, e, tx(seg("Ask mark about the tight bond um. Cut a mortis now.")))
    rules = [
        CorrectionRule(("mark",), "Marc", None),
        CorrectionRule(("tight", "bond"), "Titebond", None),
        CorrectionRule(("um",), "", None),
        CorrectionRule(("mortis",), "mortise and tenon", None),
        CorrectionRule(("nails",), "Nayls", None),
    ]
    payload = episode_payload(conn, _row(conn, e), rules)
    texts = [w[0] for w in payload["words"]]
    assert " ".join(texts) == "Ask Marc about the Titebond. Cut a mortise and tenon now."
    shown = [(was, key, texts[i : i + n]) for i, n, was, key in payload["fixes"]]
    assert shown == [
        ("mark", "mark", ["Marc"]),
        # The deleted word's full stop moves onto the word before it.
        ("tight bond um.", "tight bond um", ["Titebond."]),
        ("mortis", "mortis", ["mortise", "and", "tenon"]),
    ]
    assert episode_payload(conn, _row(conn, e), [])["fixes"] == []


def test_payload_fixes_skip_a_rule_that_changed_nothing(conn, paths, make_episode):
    # `wood talk: Wood Talk` matches a "Wood Talk" Whisper already wrote right (keys ignore
    # case). The words come back with new timings but the same text: nothing to show.
    e = make_episode()
    data = tx(seg("Wood Talk is sponsored by WoodCraft."))
    wood, talk = data["segments"][0]["words"][:2]
    wood["end"] = talk["start"] = wood["start"] + 0.16  # uneven, as Whisper times them
    _write(conn, paths, e, data)
    rules = [
        CorrectionRule(("wood", "talk"), "Wood Talk", None),
        CorrectionRule(("woodcraft",), "Woodcraft", None),
    ]
    payload = episode_payload(conn, _row(conn, e), rules)
    assert [w[0] for w in payload["words"]] == ["Wood", "Talk", "is", "sponsored", "by", "Woodcraft."]
    assert payload["fixes"] == [[5, 1, "WoodCraft.", "WoodCraft"]]


def test_payload_fixes_give_deleted_words_a_place(conn, paths, make_episode):
    e = make_episode()
    _write(conn, paths, e, tx(seg("Well uh glue it up yeah")))
    rules = [CorrectionRule(("uh",), "", None), CorrectionRule(("yeah",), "", None)]
    payload = episode_payload(conn, _row(conn, e), rules)
    assert [w[0] for w in payload["words"]] == ["Well", "glue", "it", "up"]
    # Before "glue", and after the end.
    assert payload["fixes"] == [[1, 0, "uh", "uh"], [4, 0, "yeah", "yeah"]]


def test_payload_does_not_mark_a_corrected_word_unsure(conn, paths, make_episode):
    e = make_episode()
    data = tx(seg("The borefoot price of walnut."))
    for w in data["segments"][0]["words"]:
        w["probability"] = 0.2 if w["word"].strip() in ("borefoot", "walnut.") else 0.9
    _write(conn, paths, e, data)
    rules = [CorrectionRule(("borefoot",), "board foot", None)]
    payload = episode_payload(conn, _row(conn, e), rules)
    assert [payload["words"][i][0] for i in payload["unsure"]] == ["walnut."]
    assert payload["fixes"] == [[1, 2, "borefoot", "borefoot"]]


def test_payload_gives_a_joined_word_the_key_a_rule_needs(conn, paths, make_episode):
    # Whisper's word timings split "three-eighths" and "four-quarter" in two; the page shows
    # them joined, but a rule is matched before the join, against "three" and "-eighths".
    e = make_episode()
    data = tx(seg("Use three -eighths ply, not four -quarter. It is 22 .5 wide."))
    _write(conn, paths, e, data)
    rules = [CorrectionRule(("four", "quarter"), "4/4", None)]
    payload = episode_payload(conn, _row(conn, e), rules)
    texts = [w[0] for w in payload["words"]]
    assert texts == ["Use", "three-eighths", "ply,", "not", "4/4.", "It", "is", "22.5", "wide."]
    assert payload["joined"] == [[1, "three eighths"], [7, "22 5"]]
    # A corrected word is not in `joined`: its fix carries the key.
    assert payload["fixes"] == [[4, 1, "four-quarter.", "four quarter"]]
    assert key_text([]) == ""


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
    assert payload["episode"]["reviewed_at"] is None
    conn.execute("update episodes set reviewed_at = '2026-01-01T00:00:00+00:00' where id = ?", (e,))
    assert (
        episode_payload(conn, _row(conn, e), [])["episode"]["reviewed_at"]
        == "2026-01-01T00:00:00+00:00"
    )


def test_episode_list_is_the_transcribed_episodes_newest_first(conn, paths, make_episode):
    assert episode_list(conn) == []
    old = make_episode(number=71, title="Welcome to the Three-Way",
                       published_at="2010-06-10T00:00:00+00:00", flags=json.dumps(["retimed"]))
    _write(conn, paths, old, tx(seg("Hello there.")))
    make_episode(number=650, published_at="2026-10-01T00:00:00+00:00")  # no transcript
    new = make_episode(number=None, title="A bonus", published_at="2026-09-01T00:00:00+00:00")
    _write(conn, paths, new, tx(seg("Hello there.")))
    conn.execute("update episodes set reviewed_at = 'x' where id = ?", (new,))
    conn.commit()
    assert episode_list(conn) == [
        {"id": new, "number": None, "title": "A bonus", "date": "2026-09-01",
         "flagged": False, "reviewed": True},
        {"id": old, "number": 71, "title": "Welcome to the Three-Way", "date": "2010-06-10",
         "flagged": True, "reviewed": False},
    ]


def test_next_flagged_is_the_oldest_unreviewed_flagged_transcribed_episode(
    conn, paths, make_episode
):
    flagged = json.dumps(["retimed"])

    def make(day, **kw):
        e = make_episode(published_at=f"2020-01-0{day}T00:00:00+00:00", **kw)
        _write(conn, paths, e, tx(seg("Hello there.")))
        return e

    assert next_flagged(conn) is None
    make(1)  # not flagged
    make_episode(published_at="2020-01-02T00:00:00+00:00", flags=flagged)  # no transcript
    reviewed = make(3, flags=flagged)
    conn.execute("update episodes set reviewed_at = 'x' where id = ?", (reviewed,))
    want = make(5, flags=flagged)
    later = make(6, flags=flagged)
    conn.commit()
    assert next_flagged(conn)["id"] == want
    conn.execute("update episodes set reviewed_at = 'x' where id = ?", (want,))
    conn.commit()
    assert next_flagged(conn)["id"] == later


def test_next_repair_is_the_newest_episode_with_an_undecided_repair(conn, paths, make_episode):
    from pathlib import Path

    from wts.repairs import RepairsFile, save_repairs, transcript_sha

    def make(day, repairs, sha=None):
        e = make_episode(published_at=f"2020-01-0{day}T00:00:00+00:00")
        _write(conn, paths, e, tx(seg(f"Hello there {day}.")))
        t = Path(_row(conn, e)["transcript_path"])
        if repairs is not None:
            save_repairs(t, RepairsFile(sha or transcript_sha(t), [], repairs))
        return e

    assert next_repair(conn) is None
    make(1, [_repair("40-42", (40_000, 42_000), "proposed")])
    want = make(2, [_repair("30-32", (30_000, 32_000), "proposed"),
                    _repair("9-12", (9_000, 12_000), "accepted"),
                    _repair("20-22", (20_000, 22_000), "proposed")])
    make(3, [_repair("5-7", (5_000, 7_000), "rejected")])  # all decided
    make(4, None)  # no repairs file
    make(5, [_repair("5-7", (5_000, 7_000), "proposed")], sha="stale")  # another transcript
    row, at_ms = next_repair(conn)
    assert row["id"] == want
    assert at_ms == 20_000  # its first undecided repair's hole

    # After an episode: the next one in the same order (older), coming round to the newest;
    # never the episode itself.
    oldest = conn.execute("select id from episodes order by published_at limit 1").fetchone()[0]
    assert next_repair(conn, after=want)[0]["id"] == oldest
    assert next_repair(conn, after=oldest)[0]["id"] == want
    newest = conn.execute(
        "select id from episodes order by published_at desc limit 1").fetchone()[0]
    assert next_repair(conn, after=newest)[0]["id"] == want
    conn.execute("delete from episodes where id = ?", (oldest,))
    conn.commit()
    assert next_repair(conn, after=want) is None  # the only one left with undecided repairs


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
    data = tx(seg("b c d e f g h j k l m n o p q r s t u v w x y z"))
    for w in data["segments"][0]["words"]:
        w["probability"] = 0.2
    _write(conn, paths, e, data)
    worst = episode_payload(conn, _row(conn, e), [])["worst"]
    assert worst == [{"start_ms": 0, "share": 1.0}]


def test_is_unsure_leaves_out_small_words_and_bare_punctuation():
    assert is_unsure("Titebond", 0.2)
    assert is_unsure(" board", 0.49)
    assert is_unsure("saw.", 0.2)  # short, but it means something in a shop
    assert not is_unsure("Titebond", LOW_PROB)
    assert not is_unsure("Titebond", 0.9)
    # Small words and fillers, whatever their case and punctuation.
    for small in ("And", " But", "Like,", "Right.", "that.", "a", "I'm", "I’m", "Yeah!"):
        assert not is_unsure(small, 0.1), small
    for bare in ("–", "...", "", " "):
        assert not is_unsure(bare, 0.1), repr(bare)


def test_payload_unsure_lists_the_marked_words_by_index(conn, paths, make_episode):
    e = make_episode()
    data = tx(seg("And the borefoot plane works."))
    for w in data["segments"][0]["words"]:
        w["probability"] = 0.2 if w["word"].strip() in ("And", "borefoot", "works.") else 0.9
    _write(conn, paths, e, data)
    payload = episode_payload(conn, _row(conn, e), [])
    assert [payload["words"][i][0] for i in payload["unsure"]] == ["borefoot", "works."]


def test_worst_stretches_do_not_count_small_words():
    small = [["and", i * 500, i * 500 + 400, 0.1] for i in range(20)]
    # 2 s apart, so the episode's last stretch is more than half a minute long and counts.
    real = [["dovetail", 60_000 + i * 2000, 60_400 + i * 2000, 0.1 if i < 2 else 0.9] for i in range(20)]
    assert worst_stretches(small + real) == [
        {"start_ms": 60_000, "share": 0.1},
        {"start_ms": 0, "share": 0.0},
    ]


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
    # The last stretch (360 s) is 10 s of sign-off, so it is left out, though it is the worst.
    assert [s["start_ms"] for s in top] == [300_000, 240_000, 180_000, 120_000, 60_000]
    # With a word 40 s into it, it is a stretch like any other.
    closed = [*words, ["done.", 400_000, 400_400, 0.9]]
    assert worst_stretches(closed)[0]["start_ms"] == 360_000
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
