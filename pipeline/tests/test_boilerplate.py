from conftest import ws

from wts.boilerplate import BoilerplateIndex, band_keys, shingles
from wts.words import Sentence, normalize_text

AD = "this episode is brought to you by rockler woodworking and hardware go to rockler dot com"


def sentence_from(text: str) -> Sentence:
    return Sentence(tuple(ws(text)))


def test_band_keys_are_stable_and_16_bands():
    keys = band_keys(AD)
    assert len(keys) == 16 and keys == band_keys(AD)
    assert all(-(2**63) <= k < 2**63 for k in keys)


def test_shingles():
    assert shingles("a b c d e f", k=5) == {"a b c d e", "b c d e f"}


def test_sentence_in_five_episodes_is_boilerplate(conn, make_episodes):
    ids = make_episodes(5)
    idx = BoilerplateIndex(conn)
    for e in ids:
        idx.replace_episode(e, [sentence_from(AD)])
    assert idx.is_boilerplate(ids[0], AD)


def test_four_episodes_is_not_enough(conn, make_episodes):
    ids = make_episodes(4)
    idx = BoilerplateIndex(conn)
    for e in ids:
        idx.replace_episode(e, [sentence_from(AD)])
    assert not idx.is_boilerplate(ids[0], AD)


def test_near_duplicates_with_whisper_noise_match(conn, make_episodes):
    ids = make_episodes(5)
    idx = BoilerplateIndex(conn)
    variants = [
        AD,
        AD.replace("rockler dot com", "rockler.com"),
        AD + " today",
        AD.replace("hardware", "hardwares"),
        AD,
    ]
    for e, v in zip(ids, variants, strict=True):
        idx.replace_episode(e, [sentence_from(v)])
    assert idx.is_boilerplate(ids[0], normalize_text(AD))


def test_different_sentences_do_not_match(conn, make_episodes):
    ids = make_episodes(6)
    idx = BoilerplateIndex(conn)
    for e in ids:
        idx.replace_episode(e, [sentence_from(AD)])
    other = "we glued the walnut panels up with clamps every eight inches last night"
    assert not idx.is_boilerplate(ids[0], other)


def test_repeats_within_one_episode_do_not_count(conn, make_episodes):
    ids = make_episodes(2)
    idx = BoilerplateIndex(conn)
    idx.replace_episode(ids[0], [sentence_from(AD)] * 6)
    assert not idx.is_boilerplate(ids[0], AD)


def test_replace_episode_drops_old_sentences(conn, make_episodes):
    ids = make_episodes(5)
    idx = BoilerplateIndex(conn)
    for e in ids:
        idx.replace_episode(e, [sentence_from(AD)])
    idx.replace_episode(ids[4], [sentence_from("something else entirely said on this one day")])
    assert not idx.is_boilerplate(ids[0], AD)


def test_short_sentences_never_boilerplate(conn, make_episodes):
    ids = make_episodes(6)
    idx = BoilerplateIndex(conn)
    for e in ids:
        idx.replace_episode(e, [sentence_from("yeah totally")])
    assert not idx.is_boilerplate(ids[0], "yeah totally")


def test_mask(conn, make_episodes):
    ids = make_episodes(5)
    idx = BoilerplateIndex(conn)
    for e in ids:
        idx.replace_episode(e, [sentence_from(AD)])
    mine = [sentence_from(AD), sentence_from("we talk about planes for an hour or so")]
    assert idx.mask(ids[0], mine) == [True, False]
