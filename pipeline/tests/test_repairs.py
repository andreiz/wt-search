import json
import logging

from conftest import seg, tx

from wts.guards import clean_transcript
from wts.repairs import (
    Repair,
    RepairsFile,
    apply_repairs,
    carry_decisions,
    cleaned_words,
    load_repairs,
    repairs_path,
    save_repairs,
    transcript_sha,
)
from wts.words import Word


def words(texts: str, start_s: float = 0.0) -> list[Word]:
    return [
        Word(t, round((start_s + i * 0.5) * 1000), round((start_s + i * 0.5 + 0.4) * 1000), 0.9)
        for i, t in enumerate(texts.split())
    ]


def repair(index: int, before: str, after: str, status: str = "accepted",
           hole=(10_000, 18_000)) -> Repair:
    b = words(before, 10) if before else []
    a = words(after, 10)
    return Repair(
        id=f"{hole[0]}-{hole[1]}", hole=hole, clip=(0, 28_000), index=index, from_ms=9_000,
        to_ms=19_000, before=b, after=a, second_after=a, fails=[], status=status,
    )


def test_repairs_live_in_their_own_folder(tmp_path):
    # Not in transcripts/: everything that reads "every .json there" would take a repairs
    # file for a transcript (the corrections preview did, and failed on its missing "meta").
    t = tmp_path / "data" / "transcripts" / "2010_ep071_x.json"
    assert repairs_path(t) == tmp_path / "data" / "repairs" / "2010_ep071_x.json"


def test_saved_repairs_are_not_among_the_transcripts(tmp_path):
    from wts.corrections_check import _transcripts

    t = tmp_path / "data" / "transcripts" / "2010_ep071_x.json"
    t.parent.mkdir(parents=True)
    t.write_text("{}")
    save_repairs(t, RepairsFile(transcript_sha(t), [], []))
    assert _transcripts(t.parent) == [t]
    assert load_repairs(t) == RepairsFile(transcript_sha(t), [], [])


def test_round_trip(tmp_path):
    t = tmp_path / "transcripts" / "ep.json"
    t.parent.mkdir()
    t.write_text("{}")
    rf = RepairsFile(transcript_sha=transcript_sha(t), flags=[(10_000, 18_000)],
                     repairs=[repair(2, "", "any sort of risk")])
    save_repairs(t, rf)
    assert load_repairs(t) == rf


def test_load_missing_is_none(tmp_path):
    assert load_repairs(tmp_path / "transcripts" / "ep.json") is None


def test_apply_accepted_only():
    base = words("one two three four")
    for status in ("proposed", "rejected"):
        assert apply_repairs(base, [repair(2, "", "any sort of risk", status)]) == base
    out = apply_repairs(base, [repair(2, "", "any sort of risk")])
    assert [w.text for w in out] == ["one", "two", "any", "sort", "of", "risk", "three", "four"]
    out = apply_repairs(base, [repair(2, "", "any sort of risk", "auto")])
    assert [w.text for w in out] == ["one", "two", "any", "sort", "of", "risk", "three", "four"]


def test_apply_replaces_before_words():
    base = words("one two Tom's Tips. three")
    out = apply_repairs(base, [repair(2, "Tom's Tips.", "it's been said you can")])
    assert [w.text for w in out] == ["one", "two", "it's", "been", "said", "you", "can", "three"]


def test_apply_skips_when_before_no_longer_matches(caplog):
    base = words("one two other words three")
    with caplog.at_level(logging.WARNING, logger="wts"):
        out = apply_repairs(base, [repair(2, "Tom's Tips.", "it's been said you can")])
    assert out == base
    assert "skipped" in caplog.text


def test_apply_with_no_left_anchor():
    base = words("six seven")
    out = apply_repairs(base, [repair(0, "", "any sort of risk")])
    assert [w.text for w in out] == ["any", "sort", "of", "risk", "six", "seven"]


def test_apply_several_keeps_positions():
    base = words("a b c d e f")
    out = apply_repairs(base, [
        repair(1, "", "x y z", hole=(1000, 2000)),
        repair(4, "", "p q r", hole=(5000, 6000)),
    ])
    assert [w.text for w in out] == ["a", "x", "y", "z", "b", "c", "d", "p", "q", "r", "e", "f"]


def test_carry_decisions():
    old = [repair(2, "", "Any sort of risk.", "accepted"),
           repair(9, "", "some other words here", "rejected", hole=(40_000, 45_000))]
    new = [repair(3, "", "any sort of risk", "proposed", hole=(11_000, 17_000)),
           repair(9, "", "different words entirely now", "proposed", hole=(40_000, 45_000))]
    carry_decisions(old, new)
    assert [r.status for r in new] == ["accepted", "proposed"]


def _row(conn, paths, make_episode, data):
    e = make_episode()
    stem = conn.execute("select stem from episodes where id = ?", (e,)).fetchone()[0]
    paths.transcripts_dir.mkdir(parents=True, exist_ok=True)
    out = paths.transcripts_dir / f"{stem}.json"
    out.write_text(json.dumps(data))
    conn.execute("update episodes set transcript_path = ? where id = ?", (str(out), e))
    conn.commit()
    return conn.execute("select * from episodes where id = ?", (e,)).fetchone(), out


def test_cleaned_words_applies_a_current_file(conn, paths, make_episode):
    row, t = _row(conn, paths, make_episode, tx(seg("Cut the tenon."), seg("Then glue it up.")))
    save_repairs(t, RepairsFile(transcript_sha(t), [], [repair(3, "", "and let it dry")]))
    got, _ = cleaned_words(row)
    assert [w.text for w in got] == ["Cut", "the", "tenon.", "and", "let", "it", "dry", "Then", "glue", "it", "up."]


def test_stale_file_applies_nothing(conn, paths, make_episode):
    data = tx(seg("Cut the tenon."), seg("Then glue it up."))
    row, t = _row(conn, paths, make_episode, data)
    save_repairs(t, RepairsFile("not-this-transcript", [], [repair(3, "", "and let it dry")]))
    got, _ = cleaned_words(row)
    assert got == clean_transcript(data, row["audio_duration_s"] or row["duration_s"])[0]
