from wts.holes import find_holes, speech_between, uncovered
from wts.words import Word


def w(text, start_s, end_s):
    return Word(text, round(start_s * 1000), round(end_s * 1000), 0.9)


def test_uncovered_caps_a_stretched_word():
    # "away" stretches 8 s over a skipped passage; it covers only 1.0 s + 0.3 s.
    words = [w("throw", 0, 0.3), w("away", 0.4, 8.4), w("that", 8.5, 8.8)]
    assert uncovered(words) == [(1700, 8500)]


def test_hole_needs_speech_and_length():
    words = [w("a", 0, 0.2), w("b", 10, 10.2)]  # uncovered 500..10000
    assert find_holes(words, speech=[(2000, 3000)]) == []  # only 1.0 s of speech
    assert find_holes(words, speech=[(2000, 3600)]) == [(2000, 3600)]


def test_flags_within_5_s_join():
    words = [w("a", 0, 0.2), w("b", 30, 30.2)]
    speech = [(1000, 3000), (6000, 8000), (20000, 22000)]
    assert find_holes(words, speech) == [(1000, 8000), (20000, 22000)]


def test_short_pieces_are_not_joined_into_a_flag():
    # Two 1 s stretches of speech 3 s apart: neither is a hole, so joining makes nothing.
    words = [w("a", 0, 0.2), w("b", 30, 30.2)]
    assert find_holes(words, speech=[(2000, 3000), (6000, 7000)]) == []


def test_nothing_before_first_or_after_last_word():
    words = [w("a", 10, 10.2), w("b", 11, 11.2)]
    assert find_holes(words, speech=[(0, 9000), (12000, 20000)]) == []


def said(sentences, start_s, step_s=1.0):
    """Words one every `step_s` seconds, sentence after sentence."""
    out, t = [], start_s
    for sentence in sentences:
        for token in sentence.split():
            out.append(w(token, t, t + step_s * 0.8))
            t += step_s
    return out


def test_a_loop_of_one_short_sentence_is_a_flag():
    # ep603 1:06-1:28: walnut wrote "I'm good." 18 times over real speech. Words cover the
    # time, so only the loop shows where the transcript is wrong.
    words = said(["So that's it."], 0) + said(["I'm good."] * 6, 3) + said(["Then more talk."], 15)
    speech = [(0, 20_000)]
    assert find_holes(words, speech) == [(3000, 14_800)]


def test_four_repeats_or_long_sentences_are_not_a_loop():
    speech = [(0, 40_000)]
    words = said(["So that's it."], 0) + said(["I'm good."] * 4, 3) + said(["Then more."], 12)
    assert find_holes(words, speech) == []
    long = "we glued it up on a Tuesday."  # seven words
    words = said(["So that's it."], 0) + said([long] * 5, 3, 0.25) + said(["Then more."], 13)
    assert find_holes(words, speech) == []


def test_speech_between():
    assert speech_between([(0, 1000), (2000, 5000)], (500, 3000)) == 1500
