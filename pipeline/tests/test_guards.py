from conftest import seg, seg_with_word_starts, tx

from wts.guards import clean_transcript


def _text(words):
    return " ".join(w.text for w in words)


def test_drops_no_speech_hallucination():
    words, _ = clean_transcript(
        tx(
            seg("Thanks for watching!", no_speech=0.9, logprob=-1.5),
            seg("Real talk here.", no_speech=0.1, logprob=-0.2),
        ),
        60,
    )
    assert _text(words) == "Real talk here."


def test_keeps_confident_segment_even_if_no_speech_high():
    words, _ = clean_transcript(tx(seg("Quiet but real.", no_speech=0.9, logprob=-0.3)), 60)
    assert len(words) == 3


def test_drops_repetition_loop():
    loop = " ".join(["the glue"] * 4)
    words, _ = clean_transcript(tx(seg(loop), seg("Clamp it.")), 60)
    assert _text(words) == "Clamp it."


def test_three_repeats_are_kept():
    words, _ = clean_transcript(tx(seg("no no no, not that one.")), 60)
    assert _text(words) == "no no no, not that one."


def test_backwards_timestamps_fall_back_to_even_spacing():
    data = tx(seg_with_word_starts("a b c d", starts=[0.0, 3.0, 1.0, 4.0], start=0.0, end=4.0))
    words, flags = clean_transcript(data, 60)
    assert "bad_word_times" in flags
    assert [w.start_ms for w in words] == [0, 1000, 2000, 3000]


def test_word_past_episode_end_flags_bad_times():
    data = tx(seg_with_word_starts("a b", starts=[0.0, 99.0], start=0.0, end=2.0))
    _, flags = clean_transcript(data, 60)
    assert "bad_word_times" in flags


def test_segment_without_word_timings_is_spread_evenly():
    s = seg("one two")
    s["words"] = []
    words, _ = clean_transcript(tx(s), 60)
    assert [w.text for w in words] == ["one", "two"] and words[0].start_ms < words[1].start_ms


def test_wpm_flags():
    assert "wpm_low" in clean_transcript(tx(seg("one two three.")), 600)[1]
    fast = " ".join(f"w{i}" for i in range(300))
    assert "wpm_high" in clean_transcript(tx(seg(fast, word_ms=100)), 60)[1]


def test_real_transcripts_clean(real_transcripts):
    for data in real_transcripts:
        raw = sum(len(s["words"]) for s in data["segments"])
        words, flags = clean_transcript(data, data["meta"].get("duration_s"))
        assert len(words) >= 0.95 * raw, data["meta"].get("title")
        assert not {"wpm_low", "wpm_high", "bad_word_times"} & set(flags), (
            data["meta"].get("title"), flags
        )
