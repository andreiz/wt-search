import json
from datetime import date
from pathlib import Path

import pytest

from wts.stems import make_stem, slugify, split_title


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


@pytest.mark.parametrize(
    ("title", "itunes", "number", "clean"),
    [
        ("The Awkward Beginning #1", 1, 1, "The Awkward Beginning"),
        ("Hand Tools vs Power Tools #85", None, 85, "Hand Tools vs Power Tools"),
        ("Hand Tools vs Power Tools 85", None, 85, "Hand Tools vs Power Tools"),
        ("WT127 - Hand Tool Guy Straight", None, 127, "Hand Tool Guy Straight"),
        ("WT336: Us As Kids", 336, 336, "Us As Kids"),
        ("509: We're Retiring", 509, 509, "We're Retiring"),
        ("552 - Embarrassed By All The Shiplap", None, 552, "Embarrassed By All The Shiplap"),
        ("Greasy Ham Finish | Wood Talk 595", 595, 595, "Greasy Ham Finish"),
        ("Oops All Questions | WoodTalk 599", 599, 599, "Oops All Questions"),
        ("Who Doesn't Love A Concealed Weapon? | WT601", 601, 601,
         "Who Doesn't Love A Concealed Weapon?"),
        ("Do Those Nickers Go All The Way Up? | WT 607", 607, 607,
         "Do Those Nickers Go All The Way Up?"),
        ("Snodgrass In The House | 609", 609, 609, "Snodgrass In The House"),
        ("Kids Today | Wood Talk #603", 603, 603, "Kids Today"),
        ("Kids Today - Wood Talk - 603", 603, 603, "Kids Today"),
        ("Kids Today | WT #603", None, 603, "Kids Today"),
        ("Ep. 313 – Walnut Finishing", None, 313, "Walnut Finishing"),
        ("Episode 400: Sawmills with Matt", 400, 400, "Sawmills with Matt"),
        ("Kreg Edge Discussion", 608, 608, "Kreg Edge Discussion"),
        ("Top 10 Tools for Beginners", None, None, "Top 10 Tools for Beginners"),
        ("Bonus: Q&A Live", None, None, "Bonus: Q&A Live"),
        ("Plywood in 2019", None, None, "Plywood in 2019"),
    ],
)
def test_split_title_finds_number_in_every_house_style(title, itunes, number, clean):
    assert split_title(title, itunes) == (number, clean)


def test_split_title_matches_web_fixture():
    # The frontend's displayTitle (web/src/lib/title.ts) is tested against the same cases.
    path = Path(__file__).resolve().parents[2] / "web/test/fixtures/titles.json"
    cases = json.loads(path.read_text())
    assert cases
    for case in cases:
        assert split_title(case["title"], case["number"]) == (case["number"], case["display"]), case


def test_apostrophes_do_not_become_dashes():
    assert slugify("Who Doesn't Love A Concealed Weapon?") == "who-doesnt-love-a-concealed-weapon"
    assert slugify("We’re Retiring") == "were-retiring"


def test_slug_trims_at_word_boundary():
    s = slugify("one two three four five six seven eight nine ten eleven twelve", max_len=20)
    assert s == "one-two-three-four"


def test_slug_of_symbols_only_is_not_empty():
    assert slugify("???") == "untitled"
