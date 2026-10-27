from dataclasses import replace

from wts.repair import Proposal
from wts.repair_rule import clear_cut, judge
from wts.words import Word

GOOD_TEXT = (
    "so the thing about a hand plane is that you really have to sharpen "
    "the iron before every single session or it will tear the grain out"
)  # 26 words
NEIGHBOUR = "we were talking last week about bench chisels and how often to hone them"


def words(text, prob=0.9, start=0):
    return tuple(
        Word(t, start + i * 300, start + i * 300 + 250, prob) for i, t in enumerate(text.split())
    )


CTX = list(words(NEIGHBOUR))


def proposal(text=GOOD_TEXT, prob=0.9, **kw):
    p = Proposal(
        index=100, from_ms=0, to_ms=10_000, before=(), after=words(text, prob),
        left_anchor=6, right_anchor=6,
    )
    return replace(p, **kw)


GOOD = proposal()
OTHER = proposal("an entirely different set of words that shares nothing at all with it")


def test_clear_cut():
    assert judge(GOOD, GOOD, 8000, CTX) == []


def test_only_checks_2_3_and_4_decide():
    # The rollout's review (2026-10-27, 46 decisions): every repair failing only 1 or 5 that the
    # maintainer rejected was noise, never wrong words. 1 and 5 are still recorded.
    assert clear_cut([]) and clear_cut([1]) and clear_cut([5]) and clear_cut([1, 5])
    for failed in ([2], [3], [4], [1, 3], [3, 5], [1, 2, 5]):
        assert not clear_cut(failed)


def test_fails_1_without_anchors():
    assert judge(replace(GOOD, left_anchor=2), GOOD, 8000, CTX) == [1]
    assert judge(replace(GOOD, right_anchor=4), GOOD, 8000, CTX) == [1]


def test_fails_2_too_few_words_for_the_speech():
    assert judge(GOOD, GOOD, 30_000, CTX) == [2]


def test_fails_2_too_many_words_for_the_speech():
    assert judge(GOOD, GOOD, 3000, CTX) == [2]


def test_fails_2_without_speech():
    assert 2 in judge(GOOD, GOOD, 0, CTX)


def test_fails_2_counts_only_new_words():
    p = replace(GOOD, before=words(" ".join(GOOD_TEXT.split()[:10])))  # 16 new words over 8 s = 2/s: fine
    assert judge(p, p, 8000, CTX) == []
    assert judge(p, p, 2000, CTX) == [2]  # 8/s


def test_fails_3_unsure_words():
    unsure = tuple(
        replace(w, prob=0.2) if i % 2 == 0 else w for i, w in enumerate(words(GOOD_TEXT))
    )
    p = replace(GOOD, after=unsure)
    assert judge(p, p, 8000, CTX) == [3]


def test_fails_4_loop():
    p = proposal("and then we went home " * 6)
    assert 4 in judge(p, p, 10_000, CTX)


def test_fails_4_repeats_neighbour():
    p = proposal("we were talking last week about bench chisels")
    assert judge(p, p, 3000, CTX) == [4]


def test_fails_4_stock_phrase():
    p = proposal(GOOD_TEXT + " thanks for watching")
    assert judge(p, p, 9000, CTX) == [4]


def test_fails_5_second_pass_differs():
    assert judge(GOOD, OTHER, 8000, CTX) == [5]


def test_fails_5_without_second_pass():
    assert judge(GOOD, None, 8000, CTX) == [5]
