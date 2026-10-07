from conftest import ws

from wts.words import Word, join_hyphenated, normalize_text, split_sentences


def texts(words):
    return [w.text for w in words]


def test_join_hyphenated_halves():
    # Whisper's word timings split "split-top" into "split" and "-top".
    words = [Word("a", 0, 90, 0.9), Word("split", 100, 300, 0.9), Word("-top", 300, 500, 0.6),
             Word("bench.", 500, 900, 0.9)]
    joined = join_hyphenated(words)
    assert texts(joined) == ["a", "split-top", "bench."]
    # One word, one time: the first half's start (word_times stays aligned with the text).
    assert joined[1] == Word("split-top", 100, 500, 0.6)


def test_join_hyphenated_chains_and_numbers():
    assert texts(join_hyphenated(ws("my mother -in -law"))) == ["my", "mother-in-law"]
    # Seen on the show: a phone number, CARB-2, catch-22, fractions.
    assert texts(join_hyphenated(ws("call 623 -242 -2450. Now"))) == ["call", "623-242-2450.", "Now"]
    assert texts(join_hyphenated(ws("CARB -2 and catch -22"))) == ["CARB-2", "and", "catch-22"]


def test_join_hyphenated_leaves_real_dashes_alone():
    # A dash on its own is punctuation in speech, not half a word.
    assert texts(join_hyphenated(ws("one of those – I was - And"))) == (
        ["one", "of", "those", "–", "I", "was", "-", "And"])


def test_join_hyphenated_never_crosses_a_sentence_end_or_starts_with_nothing():
    assert texts(join_hyphenated(ws("-top first"))) == ["-top", "first"]
    assert texts(join_hyphenated(ws("It ended. -top again"))) == ["It", "ended.", "-top", "again"]


def test_split_respects_abbreviations():
    s = split_sentences(ws("Mr. Cremona cut 2. pieces. Then what? Glue!"))
    assert [x.text for x in s] == ["Mr. Cremona cut 2. pieces.", "Then what?", "Glue!"]


def test_trailing_words_without_punctuation_form_a_sentence():
    s = split_sentences(ws("First one. and then"))
    assert [x.text for x in s] == ["First one.", "and then"]


def test_sentence_timing_and_norm():
    s = split_sentences(ws("Hello there. Glue it!"))[1]
    assert (s.start_ms, s.end_ms) == (2000, 3999)
    assert s.norm == "glue it"


def test_normalize():
    assert normalize_text("Head over to Patreon.com/WoodTalk — 25% off!") == (
        "head over to patreoncomwoodtalk twenty-five off"
    )


def test_normalize_keeps_inner_apostrophes_only():
    assert normalize_text("I've got 'quotes' and it's fine") == "i've got quotes and it's fine"
