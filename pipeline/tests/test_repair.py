import subprocess

from wts.repair import (
    MIN_NEW_WORDS,
    clip_span,
    clip_words,
    cut_clip,
    propose,
)
from wts.transcribe import RawSegment, RawTranscript, RawWord
from wts.words import Word


def seq(texts: str, start_s: float, step_s: float = 0.4) -> list[Word]:
    """Words spoken one every `step_s` seconds from `start_s`."""
    return [
        Word(t, round((start_s + i * step_s) * 1000), round((start_s + i * step_s + 0.3) * 1000),
             0.9)
        for i, t in enumerate(texts.split())
    ]


LEFT = "one two three four five"
RIGHT = "six seven eight nine ten"
NEW = "any sort of serious risk about it"


def test_fills_a_hole_between_anchors():
    transcript = seq(LEFT, 0) + seq(RIGHT, 13)  # nothing from 2.0 s to 13 s
    fresh = seq(LEFT, 0) + seq(NEW, 5) + seq(RIGHT, 13)
    p = propose(transcript, hole=(5000, 13000), clip=(0, 20000), fresh=fresh)
    assert [x.text for x in p.after] == NEW.split()
    assert p.before == ()
    assert (p.left_anchor, p.right_anchor) == (5, 5)
    assert p.index == 5
    assert p.from_ms == transcript[4].end_ms and p.to_ms == transcript[5].start_ms


def test_replaces_a_short_heading_over_a_skip():
    heading = "Tom's Tips. Tom's Tips."
    tip = " ".join(f"w{i}" for i in range(20))
    transcript = seq(LEFT, 0) + seq(heading, 3) + seq(RIGHT, 20)
    fresh = seq(LEFT, 0) + seq(tip, 3) + seq(RIGHT, 20)
    p = propose(transcript, hole=(5000, 19000), clip=(0, 25000), fresh=fresh)
    assert [x.text for x in p.before] == heading.split()
    assert len(p.after) == 20


def test_no_proposal_when_fresh_adds_little():
    transcript = seq(LEFT, 0) + seq(RIGHT, 13)
    fresh = seq(LEFT, 0) + seq("uh well", 5) + seq(RIGHT, 13)
    assert MIN_NEW_WORDS == 3
    assert propose(transcript, hole=(5000, 13000), clip=(0, 20000), fresh=fresh) is None


def test_ignores_differences_outside_the_hole():
    # Crosstalk at 0.4 s differs between the passes; only the hole's stretch is proposed.
    transcript = seq("one two three four five", 0) + seq(RIGHT, 13)
    fresh = seq("one too three four five", 0) + seq(NEW, 5) + seq(RIGHT, 13)
    p = propose(transcript, hole=(5000, 13000), clip=(0, 20000), fresh=fresh)
    assert [x.text for x in p.after] == NEW.split()
    assert p.left_anchor == 3


def spliced(transcript, p):
    end = p.index + len(p.before)
    return transcript[:p.index] + list(p.after) + transcript[end:]


def test_repeated_words_beside_a_hole_keep_times_in_order():
    # "the glue" occurs before the hole, after it and at the start of the fresh words: matching
    # by text alone pairs a 14 s word with a 2.5 s one and splices words with times going back.
    new = " ".join(f"n{i}" for i in range(30))
    transcript = seq("so the the glue the glue", 0) + seq("the glue dries fast you know", 14)
    fresh = (seq("so the the glue the glue", 0) + seq("the glue is " + new, 2.5, 0.35)
             + seq("the glue dries fast you know", 14))
    p = propose(transcript, hole=(2500, 13900), clip=(0, 26000), fresh=fresh)
    assert p is not None
    starts = [w.start_ms for w in spliced(transcript, p)]
    assert starts == sorted(starts)
    assert "n0" in [w.text for w in p.after]


def test_hole_at_episode_start_has_no_left_anchor():
    transcript = seq(RIGHT, 9)
    fresh = seq(NEW, 1) + seq(RIGHT, 9)
    p = propose(transcript, hole=(0, 8000), clip=(0, 18000), fresh=fresh)
    assert p.left_anchor == 0 and p.from_ms == -1 and p.index == 0
    assert [x.text for x in p.after] == NEW.split()


def test_clip_span_clamps_and_shifts():
    assert clip_span((3000, 5000), duration_ms=60_000) == (0, 15_000)
    assert clip_span((30_000, 32_000), 60_000, shift_ms=5000) == (15_000, 42_000)
    assert clip_span((55_000, 58_000), 60_000) == (45_000, 60_000)


def test_clip_words_shifts_times():
    fresh = RawTranscript(
        segments=[RawSegment(0.0, 1.0, " Glue up.", 0.01, -0.2, [
            RawWord(0.0, 0.4, " Glue", 0.9), RawWord(0.4, 1.0, " up.", 0.8)])],
        model="fake", model_version="0",
    )
    words = clip_words(fresh, 40_000)
    assert [(x.text, x.start_ms, x.end_ms) for x in words] == [
        ("Glue", 40_000, 40_400), ("up.", 40_400, 41_000)]


def test_cut_clip_reframes_samples_before_the_mp3_encoder(monkeypatch, tmp_path):
    # ffmpeg 9.0.2's libmp3lame fails on some cuts ("inadequate AVFrame plane padding",
    # ep614 1136.760-1158.400 s); aresample hands it freshly allocated frames.
    seen = []
    monkeypatch.setattr(subprocess, "run", lambda cmd, **kw: seen.append(cmd))
    cut_clip(tmp_path / "ep.mp3", (1_136_760, 1_158_400), tmp_path / "clip.mp3")
    cmd = seen[0]
    assert cmd[cmd.index("-af") + 1] == "aresample"
    assert cmd.index("-af") < cmd.index("-c:a")
