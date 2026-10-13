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


def test_conversational_repeats_are_kept():
    text = "Yeah, yeah, yeah, yeah. So anyway we glued it up and clamped it overnight."
    words, flags = clean_transcript(tx(seg(text)), 60)
    assert _text(words) == text and "loop_cut" not in flags


def _signoff(*endings):
    return tx(seg("Thanks for listening, everybody."), *[seg(e) for e in endings])


def test_made_up_ending_is_cut_after_the_first_repeat():
    # Episode 597: the goodbye again and again over the closing music, then stray words.
    words, flags = clean_transcript(
        _signoff("Bye-bye.", "Bye.", "Bye.", "Bye.", "Bye.", "debug.", "besser."), 3
    )
    assert _text(words) == "Thanks for listening, everybody. Bye-bye. Bye."
    assert flags == []  # routine, not a reason to look at the episode


def test_made_up_ending_takes_what_follows_it():
    # Episode 604's phrase, and episode 608's "Thank you." after the run.
    words, _ = clean_transcript(_signoff(*["He just shows up."] * 5, "Thank you."), 60)
    assert _text(words) == "Thanks for listening, everybody. He just shows up."


def test_ending_in_another_script_is_cut():
    # Episode 616.
    words, _ = clean_transcript(_signoff("Bye.", "很多.", "Thank you."), 60)
    assert _text(words) == "Thanks for listening, everybody. Bye."


def test_three_goodbyes_are_kept():
    # Episode 171 ends "Bye. Bye. Bye." after the network's outro, and the hosts said it.
    text = "Thanks for listening, everybody. Bye. Bye. Bye."
    words, _ = clean_transcript(_signoff("Bye.", "Bye.", "Bye."), 60)
    assert _text(words) == text


def test_accented_words_at_the_end_are_kept():
    words, _ = clean_transcript(_signoff("André Roubo.", "Adiós."), 60)
    assert _text(words) == "Thanks for listening, everybody. André Roubo. Adiós."


def test_repeats_before_the_ending_are_kept():
    # Four segments in a row that say the same, but a minute before the end.
    middle = [seg("No.")] * 4
    talk = [seg("So we glued it up and clamped it overnight and it held fine.", word_ms=5000)]
    words, _ = clean_transcript(tx(seg("Really?"), *middle, *talk), 120)
    assert _text(words).startswith("Really? No. No. No. No. So we glued")


def test_ending_with_segments_out_of_order_is_cut_by_position():
    # Episode 616's last segment starts before the one ahead of it.
    last = seg_with_word_starts("Thank you.", starts=[0.9, 1.0], start=0.9, end=1.0)
    segments = [seg("Thanks for listening, everybody."), *[seg("Bye.")] * 4, last]
    words, _ = clean_transcript(tx(*segments), 60)
    assert _text(words) == "Thanks for listening, everybody. Bye."


def test_dropped_loop_is_flagged():
    _, flags = clean_transcript(tx(seg(" ".join(["the glue"] * 4)), seg("Clamp it.")), 60)
    assert "loop_cut" in flags


def test_one_bad_segment_only_retimes_that_segment():
    good = seg_with_word_starts("one two", starts=[0.0, 0.2], start=0.0, end=1.0)
    bad = seg_with_word_starts("a b c d", starts=[1.0, 4.0, 2.0, 4.5], start=1.0, end=5.0)
    words, flags = clean_transcript(tx(good, bad), 60)
    assert "bad_word_times" in flags
    assert [w.start_ms for w in words] == [0, 200, 1000, 2000, 3000, 4000]


def test_whisper_word_with_inner_space_is_split():
    s = seg_with_word_starts("x", starts=[0.0], start=0.0, end=1.0)
    s["words"][0]["word"] = " - the"
    words, _ = clean_transcript(tx(s), 60)
    assert [w.text for w in words] == ["-", "the"]


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
