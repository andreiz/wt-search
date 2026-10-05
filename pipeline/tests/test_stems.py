from datetime import date

from wts.stems import make_stem, slugify


def test_stem_format():
    never = lambda s: False
    assert make_stem(date(2017, 3, 14), 312, "Dado Stacks & Shop Safety!", never) == (
        "2017-03-14_ep312_dado-stacks-shop-safety"
    )
    assert make_stem(date(2020, 1, 2), 7, "x", never) == "2020-01-02_ep007_x"
    assert make_stem(date(2020, 1, 2), None, "Bonus: Q&A", never) == "2020-01-02_bonus-q-a"


def test_stem_is_ascii_and_unique():
    taken = {"2021-05-05_cafe-talk-dovetails"}
    s = make_stem(date(2021, 5, 5), None, 'Café Talk: "Dovetails?"', taken.__contains__)
    assert s == "2021-05-05_cafe-talk-dovetails-2" and s.isascii()


def test_slug_trims_at_word_boundary():
    s = slugify("one two three four five six seven eight nine ten eleven twelve", max_len=20)
    assert s == "one-two-three-four"


def test_slug_of_symbols_only_is_not_empty():
    assert slugify("???") == "untitled"
