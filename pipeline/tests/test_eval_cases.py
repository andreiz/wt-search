"""The test search set's case files (spec §7.2, plan 5 Task 1)."""

import pytest

from wts.evalset.cases import Case, CaseError, Item, eval_dir, load_cases


def write(tmp_path, text: str, name: str = "queries.yaml"):
    (tmp_path / name).write_text(text)
    return tmp_path


def test_a_full_case_loads(tmp_path):
    cases = load_cases(write(tmp_path, """
- id: aspirational-builds
  query: aspirational builds
  tag: paraphrase
  mode: related
  sort: newest
  expect:
    - {episode: 71, at: "40:54"}
  expect_absent:
    - {episode: 127}
  smoke: true
"""))
    assert cases == [Case(
        id="aspirational-builds", query="aspirational builds", tag="paraphrase", mode="related",
        sort="newest", expect=(Item(71, 2454),), expect_absent=(Item(127),), smoke=True,
        source="queries.yaml",
    )]


def test_defaults_are_both_modes_and_relevance(tmp_path):
    [case] = load_cases(write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}"))
    assert (case.mode, case.sort, case.smoke) == ("both", "relevance", False)
    assert case.modes == ("exact", "related")


def test_an_unquoted_time_is_read_as_seconds(tmp_path):
    # PyYAML reads 40:54 as base 60 (2454) and 1:02:03 as 3723: the same seconds.
    [case] = load_cases(write(tmp_path, """
- id: a
  query: glue
  tag: exact
  expect: [{episode: 1, at: 40:54}, {episode: 2, at: 1:02:03}, {episode: 3, at: 95}]
"""))
    assert [i.at_s for i in case.expect] == [2454, 3723, 95]


def test_both_files_load_in_order(tmp_path):
    write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}")
    write(tmp_path, "- {id: syn-1, query: clamps, tag: paraphrase, expect: [{episode: 2}]}",
          "synthetic.yaml")
    assert [(c.id, c.source) for c in load_cases(tmp_path)] == [
        ("a", "queries.yaml"), ("syn-1", "synthetic.yaml")]


def test_a_missing_file_is_no_cases(tmp_path):
    assert load_cases(tmp_path) == []


@pytest.mark.parametrize(("text", "message"), [
    ("{id: a}", "expected a list"),
    ("- just a string", "expected a mapping"),
    ("- {query: glue, tag: exact, expect: [{episode: 1}]}", "needs an id"),
    ("- {id: a, tag: exact, expect: [{episode: 1}]}", "needs a query"),
    ("- {id: a, query: glue, tag: vibes, expect: [{episode: 1}]}", "tag must be one of"),
    ("- {id: a, query: glue, tag: exact, mode: smart, expect: [{episode: 1}]}", "mode must be"),
    ("- {id: a, query: glue, tag: exact, sort: best, expect: [{episode: 1}]}", "sort must be"),
    ("- {id: a, query: glue, tag: exact}", "needs expect or expect_absent"),
    ("- {id: a, query: glue, tag: exact, expect: [{at: 3}]}", "episode must be"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 0}]}", "episode must be"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: true}]}", "episode must be"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 1, at: soon}]}", "not a time"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 1, when: 3}]}", "unknown keys: when"),
    ("- {id: a, query: glue, tag: exact, expect: [{episode: 1}], extra: 1}", "unknown keys: extra"),
    ("- {id: a, query: glue, tag: exact, expect_absent: [{episode: 1}], smoke: true}",
     "a smoke case needs expect"),
    ("- {id: a, query: glue, tag: collapse, expect: [{episode: 1, cards: 2}]}",
     "need mode exact or related"),
    (("- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}\n"
      "- {id: a, query: clamps, tag: exact, expect: [{episode: 2}]}"), "id 'a' is used twice"),
    ("- [unclosed", "not valid YAML"),
])
def test_bad_cases_are_refused_with_a_reason(tmp_path, text, message):
    with pytest.raises(CaseError, match=message):
        load_cases(write(tmp_path, text))


def test_an_id_in_both_files_is_refused(tmp_path):
    write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}")
    write(tmp_path, "- {id: a, query: glue, tag: exact, expect: [{episode: 1}]}", "synthetic.yaml")
    with pytest.raises(CaseError, match="id 'a' is used twice"):
        load_cases(tmp_path)


def test_the_eval_dir_is_the_repos_unless_overridden(tmp_path, monkeypatch):
    monkeypatch.delenv("WTS_EVAL_DIR", raising=False)
    assert eval_dir().name == "eval" and (eval_dir().parent / "pipeline").is_dir()
    monkeypatch.setenv("WTS_EVAL_DIR", str(tmp_path))
    assert eval_dir() == tmp_path


def test_the_committed_cases_load(monkeypatch):
    monkeypatch.delenv("WTS_EVAL_DIR", raising=False)
    cases = load_cases(eval_dir())
    assert sum(c.smoke for c in cases) == 5
