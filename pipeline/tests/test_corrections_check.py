import json

from conftest import seg, tx

from wts import corrections_check
from wts.corrections import CorrectionRule
from wts.corrections_check import (
    Change,
    WordKeys,
    added_rule_changes,
    changes_digest,
    rule_changes,
)

GLUE = CorrectionRule(("glue",), "Glew", None)


def write(dir_, stem, text):
    (dir_ / f"{stem}.json").write_text(json.dumps(tx(seg(text))))


def test_finds_a_change_in_two_transcripts(tmp_path):
    write(tmp_path, "b", "I love glue.")
    write(tmp_path, "a", "Glue is great.")
    write(tmp_path, "c", "Nothing here.")
    changes = rule_changes(tmp_path, [], [GLUE])
    assert [(c.stem, c.before, c.after) for c in changes] == [
        ("a", "Glue is great.", "Glew is great."),
        ("b", "I love glue.", "I love Glew."),
    ]
    assert all(isinstance(c, Change) and c.start_ms == 0 for c in changes)


def test_no_change_for_a_rule_that_matches_nothing(tmp_path):
    write(tmp_path, "a", "Glue is great.")
    assert rule_changes(tmp_path, [], [CorrectionRule(("nails",), "Nayls", None)]) == []


def test_an_episode_rule_only_changes_its_episode(tmp_path):
    write(tmp_path, "a", "Glue it.")
    write(tmp_path, "b", "Glue it.")
    rule = CorrectionRule(("glue",), "Glew", "b")
    assert [c.stem for c in rule_changes(tmp_path, [], [rule])] == ["b"]


def test_added_rule_changes_are_those_of_the_full_comparison(tmp_path):
    write(tmp_path, "a", "Tight bond, a tight fit. The glue sets.")
    write(tmp_path, "b", "A tight bond is tight. So bond it tight.")
    write(tmp_path, "c", "Nothing here, tightly bonded.")
    before = [
        CorrectionRule(("tight", "bond"), "Titebond", None),  # longer: it wins where both match
        CorrectionRule(("glue",), "Glew", "a"),
    ]
    rules = [
        CorrectionRule(("tight",), "snug", None),
        CorrectionRule(("tight",), "snug", "b"),
        CorrectionRule(("tight", "bond", "is"), "Titebond's", None),
        CorrectionRule(("bond", "it"), "", None),
        CorrectionRule(("the", "glue"), "that glue", None),
        CorrectionRule(("nails",), "Nayls", None),
    ]
    keys = WordKeys()
    for rule in rules:
        want = rule_changes(tmp_path, before, [*before, rule])
        assert added_rule_changes(tmp_path, before, rule, keys) == want, rule
    snug = added_rule_changes(tmp_path, before, rules[0], keys)
    assert [(c.stem, c.after) for c in snug] == [
        ("a", "Titebond, a snug fit."),
        ("b", "A Titebond is snug."),
        ("b", "So bond it snug."),
    ]


def test_added_rule_changes_read_only_the_transcripts_that_can_change(tmp_path, monkeypatch):
    write(tmp_path, "a", "Glue it.")
    write(tmp_path, "b", "Glue it.")
    write(tmp_path, "c", "Nail it.")
    keys = WordKeys()
    keys.warm(tmp_path)
    read = []
    real = corrections_check._clean_words
    monkeypatch.setattr(
        corrections_check, "_clean_words", lambda p: (read.append(p.stem), real(p))[1]
    )
    assert len(added_rule_changes(tmp_path, [], GLUE, keys)) == 2
    assert read == ["a", "b"]
    read.clear()
    one = CorrectionRule(("glue",), "Glew", "b")
    assert [c.stem for c in added_rule_changes(tmp_path, [], one, keys)] == ["b"]
    assert read == ["b"]
    read.clear()
    assert added_rule_changes(tmp_path, [], CorrectionRule(("screw",), "Skrew", None), keys) == []
    assert read == []


def test_word_keys_match_whole_words_in_a_row_and_follow_a_changed_file(tmp_path):
    write(tmp_path, "a", "A Tight-bond, tightly.")
    path = tmp_path / "a.json"
    keys = WordKeys()
    assert keys.has(path, ("a", "tightbond"))
    assert not keys.has(path, ("tight",))  # not a part of a word
    assert not keys.has(path, ("a", "tightly"))  # not in a row
    write(tmp_path, "a", "Now a tight and longer text.")
    assert keys.has(path, ("tight",))


def test_digest_differs_when_a_change_does():
    a = Change("s", 0, "x", "y")
    assert changes_digest([a]) == changes_digest([Change("s", 0, "x", "y")])
    assert changes_digest([a]) != changes_digest([Change("s", 0, "x", "z")])
    assert changes_digest([a]) != changes_digest([Change("s", 1, "x", "y")])
    assert changes_digest([a]) != changes_digest([])
    assert len(changes_digest([])) == 64
