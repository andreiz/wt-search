"""Adding a case to eval/queries.yaml from the review page, and where a passage lands in an
answer (spec §7.2)."""

import pytest

from wts.evalset.add import CaseExists, all_said, append_case, case_id, locate, stems
from wts.evalset.cases import Case, CaseError, Item, load_cases

EXISTING = """# The test search set, written by hand.

# --- smoke ---
- id: conoid
  query: Conoid
  tag: jargon
  mode: exact
  expect: [{episode: 71, at: "41:01"}]
  smoke: true
"""


def test_case_id_is_a_slug_of_the_query():
    assert case_id("Aspirational builds!", set()) == "aspirational-builds"
    assert case_id("hvlp sprayer year:2020", set()) == "hvlp-sprayer-year-2020"


def test_case_id_avoids_ids_in_use():
    assert case_id("glue", {"glue"}) == "glue-2"
    assert case_id("glue", {"glue", "glue-2"}) == "glue-3"


def test_case_id_is_cut_at_a_word_and_never_empty():
    long = "how do I keep my glue from freezing in a cold garage shop in the winter months"
    got = case_id(long, set())
    assert len(got) <= 48 and not got.endswith("-") and long.lower().startswith(got.replace("-", " "))
    assert case_id("???", set()) == "case"


def test_append_keeps_the_file_and_adds_one_case(tmp_path):
    text, new_id = append_case(EXISTING, query="aspirational builds", tag="paraphrase",
                               mode="both", episode=71, at_s=2454, absent=False)
    assert new_id == "aspirational-builds"
    assert text.startswith(EXISTING)
    assert text[len(EXISTING):] == (
        "\n- id: aspirational-builds\n"
        "  query: aspirational builds\n"
        "  tag: paraphrase\n"
        '  expect: [{episode: 71, at: "40:54"}]\n'
    )
    (tmp_path / "queries.yaml").write_text(text)
    assert load_cases(tmp_path)[-1] == Case(
        "aspirational-builds", "aspirational builds", "paraphrase", expect=(Item(71, 2454),),
        source="queries.yaml")


def test_append_a_negative_with_a_mode_and_no_time():
    text, _ = append_case(EXISTING, query="flattening a bench top", tag="negative",
                          mode="related", episode=127, at_s=None, absent=True)
    assert text.endswith(
        "  tag: negative\n  mode: related\n  expect_absent: [{episode: 127}]\n")


def test_append_an_hour_long_time():
    text, _ = append_case("", query="glue", tag="exact", mode="both", episode=5, at_s=3723,
                          absent=False)
    assert text == '- id: glue\n  query: glue\n  tag: exact\n  expect: [{episode: 5, at: "1:02:03"}]\n'


@pytest.mark.parametrize("query", [
    "hvlp sprayer year:2020", 'the "best" glue', "glue: which one", "#1 tip", "- dash first",
    "yes", "null", "  padded  ", "what's a 3/8\" dado?",
])
def test_queries_that_yaml_would_misread_come_back_exactly(tmp_path, query):
    text, _ = append_case(EXISTING, query=query, tag="exact", mode="both", episode=1,
                          at_s=None, absent=False)
    (tmp_path / "queries.yaml").write_text(text)
    assert load_cases(tmp_path)[-1].query == query.strip()


def test_append_to_a_file_without_a_final_newline():
    text, _ = append_case(EXISTING.rstrip("\n"), query="glue", tag="exact", mode="both",
                          episode=1, at_s=None, absent=False)
    assert "smoke: true\n\n- id: glue\n" in text


def test_the_same_query_and_passage_is_refused():
    text, _ = append_case(EXISTING, query="aspirational builds", tag="paraphrase", mode="both",
                          episode=71, at_s=2454, absent=False)
    with pytest.raises(CaseExists):
        append_case(text, query="Aspirational Builds", tag="paraphrase", mode="both",
                    episode=71, at_s=2470, absent=False)  # within the 45 s a match allows
    # Another passage for the same words is a new case.
    _, new_id = append_case(text, query="aspirational builds", tag="paraphrase",
                                mode="both", episode=71, at_s=2745, absent=False)
    assert new_id == "aspirational-builds-2"


@pytest.mark.parametrize("bad", [
    {"query": "  "}, {"tag": "fuzzy"}, {"mode": "smart"}, {"episode": 0}, {"at_s": -1},
])
def test_bad_input_is_a_value_error(bad):
    args = {"query": "glue", "tag": "exact", "mode": "both", "episode": 1, "at_s": None,
            "absent": False}
    with pytest.raises(ValueError):
        append_case(EXISTING, **(args | bad))


def test_a_broken_file_is_not_appended_to():
    with pytest.raises(CaseError):
        append_case("- id: [unclosed\n", query="glue", tag="exact", mode="both", episode=1,
                    at_s=None, absent=False)


def test_stems_are_searchs_porter_tokens():
    assert stems("The board foot Calculator, three-eighths!") == {
        "the", "board", "foot", "calcul", "three", "eighth"}
    assert stems("") == set()
    assert stems("¿?") == set()


def test_all_said_compares_stems_as_exact_search_does():
    passage = "definitely the board foot calculator is awesome when the glue sets"
    assert all_said("board foot calculation", passage)
    assert all_said("Glue setting", passage)
    assert not all_said("board foot math", passage)
    assert not all_said("  ", passage)


def _r(number, hit_s):
    return {"episode": {"number": number}, "hit_ms": hit_s * 1000}


def test_locate_the_passage_and_the_episode():
    results = [_r(5, 10), _r(71, 100), _r(71, 2460), _r(9, 1)]
    assert locate(results, 71, 2454) == {"rank": 3, "episode_rank": 2}
    assert locate(results, 71, None) == {"rank": 2, "episode_rank": 2}
    assert locate(results, 71, 1000) == {"rank": None, "episode_rank": 2}
    assert locate(results, 42, None) == {"rank": None, "episode_rank": None}


def test_locate_tolerates_odd_results():
    assert locate([{}, {"episode": None}, _r(1, 0)], 1, 0) == {"rank": 3, "episode_rank": 3}
