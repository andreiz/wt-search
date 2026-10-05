from conftest import ws

from wts.words import normalize_text, split_sentences


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
