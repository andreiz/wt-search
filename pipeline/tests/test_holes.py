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


def test_speech_between():
    assert speech_between([(0, 1000), (2000, 5000)], (500, 3000)) == 1500
